import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Flag } from "./flag";

// Mock at the SDK seam: firewall pulls the Anthropic client from ./claude. Mocking the
// whole module means the real `new Anthropic()` (which needs an API key + the SDK in
// node_modules) never runs, and we control the stage-(b) judge's answer. `vi.hoisted`
// makes the spy available inside the hoisted vi.mock factory.
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("./claude", () => ({
  anthropic: { messages: { create } },
  JUDGE_MODEL: "claude-haiku-4-5",
}));

import { firewall, normalizeForMatch } from "./firewall";

function makeFlag(over: Partial<Flag> = {}): Flag {
  return {
    ruleId: "limitation-of-liability",
    clause: "Limitation of Liability",
    verdict: "deviation",
    citedSpan: "",
    reasoning: "test reasoning",
    topSimilarity: 0.8,
    shortCircuited: false,
    passages: [],
    ...over,
  };
}

// Shape the mocked judge returns: firewall reads the tool_use block's `input`.
function judgeReturns(supports: boolean, reasoning = "judge reasoning") {
  create.mockResolvedValueOnce({
    content: [{ type: "tool_use", name: "record_check", input: { supports, reasoning } }],
  });
}

beforeEach(() => {
  create.mockReset();
});

describe("normalizeForMatch", () => {
  it("collapses every whitespace run (newlines, tabs, repeats) to a single space", () => {
    expect(normalizeForMatch("aggregate\n\tliability   clause")).toBe(
      "aggregate liability clause",
    );
  });

  it("unifies smart quotes and en/em dashes to ASCII", () => {
    expect(normalizeForMatch("“Service”—the ‘hosted’ platform–v2")).toBe(
      '"Service"-the \'hosted\' platform-v2',
    );
  });

  it("trims outer whitespace", () => {
    expect(normalizeForMatch("  padded  ")).toBe("padded");
  });
});

describe("firewall — deterministic grounding gate (no LLM call)", () => {
  const raw =
    "11. LIMITATION OF LIABILITY\n11.1 Provider's total aggregate liability shall not exceed the fees paid in the prior twelve (12) months.";

  // THE MONEY CASE: a quote that is NOT in the source is quarantined as fabricated, and
  // the firewall must NOT spend an LLM call on it — the deterministic check has final say.
  it("returns fabricated for a citation that is not in the source, without calling the judge", async () => {
    const flag = makeFlag({
      citedSpan: "Provider shall pay Customer one billion dollars for any breach whatsoever.",
    });

    const result = await firewall(flag, raw);

    expect(result.status).toBe("fabricated");
    expect(result.grounded).toBe(false);
    expect(result.supportsVerdict).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  // A near-miss paraphrase (one word changed) is not a verbatim substring -> fabricated.
  // This is the subtle half of the money case: normalization must NOT let paraphrase pass.
  it("returns fabricated for a paraphrase that only near-matches the source", async () => {
    const flag = makeFlag({
      citedSpan: "Provider's total aggregate liability shall not exceed the fees paid in the prior six (6) months.",
    });

    const result = await firewall(flag, raw);

    expect(result.status).toBe("fabricated");
    expect(create).not.toHaveBeenCalled();
  });

  // not-addressed makes no textual claim: nothing to grade -> not-applicable (NOT verified).
  it("returns not-applicable for a not-addressed flag with no citation, and skips the judge", async () => {
    const flag = makeFlag({ verdict: "not-addressed", citedSpan: "" });

    const result = await firewall(flag, raw);

    expect(result.status).toBe("not-applicable");
    expect(result.grounded).toBe(false);
    expect(result.supportsVerdict).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  // The dangerous case: a verdict that ASSERTS a claim but cites nothing -> needs-review.
  it("returns needs-review when a compliant/deviation verdict has an empty citation", async () => {
    const flag = makeFlag({ verdict: "deviation", citedSpan: "" });

    const result = await firewall(flag, raw);

    expect(result.status).toBe("needs-review");
    expect(result.grounded).toBe(false);
    expect(result.supportsVerdict).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("firewall — grounded citation is handed to the judge", () => {
  // Source differs only cosmetically (line wrap + curly quotes) from the citation;
  // normalization makes it a grounded match, so stage (b) runs.
  const raw =
    'The provider\'s “Service”\nmeans the hosted platform provided under this Agreement.';
  const groundedCite = '"Service" means the hosted platform';

  it("returns verified when the quote is grounded and the judge confirms support", async () => {
    judgeReturns(true, "The quote establishes the definition.");
    const flag = makeFlag({ verdict: "compliant", citedSpan: groundedCite });

    const result = await firewall(flag, raw);

    expect(result.status).toBe("verified");
    expect(result.grounded).toBe(true);
    expect(result.supportsVerdict).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("returns needs-review when the quote is grounded but the judge is not convinced", async () => {
    judgeReturns(false, "The quote is off-topic for this verdict.");
    const flag = makeFlag({ verdict: "deviation", citedSpan: groundedCite });

    const result = await firewall(flag, raw);

    expect(result.status).toBe("needs-review");
    expect(result.grounded).toBe(true);
    expect(result.supportsVerdict).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("throws when the grounded-path judge returns a malformed response", async () => {
    create.mockResolvedValueOnce({ content: [{ type: "text", text: "no tool call here" }] });
    const flag = makeFlag({ verdict: "deviation", citedSpan: groundedCite });

    await expect(firewall(flag, raw)).rejects.toThrow(/tool_use/);
  });
});
