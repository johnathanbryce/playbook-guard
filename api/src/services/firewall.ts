// CITATION FIREWALL — the hard gate between flag() and the user. The core of the product.
//
// flag() produced a verdict + a citedText quote. Before that quote is ever shown as
// trustworthy, the firewall answers two INDEPENDENT questions:
//   (a) Is the quote real?  — deterministic. Does citedText appear VERBATIM in the
//       contract's untouched raw_text? We check the source ourselves, not the model's word.
//   (b) Does the quote support the verdict?  — a second, cheaper, INDEPENDENT LLM (Haiku)
//       confirms the cited language genuinely backs the flag.
//
// Labels:
//   verified     — (a) passed and (b) confirmed. Safe to surface.
//   needs-review — (a) passed but (b) was not confident. A human should look.
//   fabricated   — (a) FAILED: the quote is not in the source. Quarantined; (b) never runs.
//
// Why deterministic-first: an ungrounded legal citation is worse than no tool. The quote
// must be proven present mechanically; only then do we spend an LLM call asking if it fits.
import type { Flag } from "./flag";
import { anthropic, JUDGE_MODEL } from "./claude";

export type FirewallStatus = "verified" | "needs-review" | "fabricated";

export type FirewallResult = {
  status: FirewallStatus;
  grounded: boolean; // stage (a): citedText found verbatim (normalized) in raw_text
  supportsVerdict: boolean | null; // stage (b): judge's call; null when (b) did not run
  reasoning: string; // human-readable explanation of the status
};

// Normalize BOTH sides before the substring test: collapse all whitespace runs to a single
// space and unify smart quotes / en-em dashes to ASCII. This absorbs cosmetic differences
// (line wrapping, curly vs straight quotes) WITHOUT allowing a paraphrase to pass — anything
// beyond these character-class swaps changes the string and fails the exact substring check.
// Exported for unit tests (the highest-value target: grounded / paraphrase / fabricated).
export function normalizeForMatch(s: string): string {
  return s
    .replace(/[‘’‛]/g, "'") // ' ' ‛  -> '
    .replace(/[“”]/g, '"') // " "        -> "
    .replace(/[–—]/g, "-") // – —        -> -
    .replace(/\s+/g, " ")
    .trim();
}

export async function firewall(flag: Flag, rawText: string): Promise<FirewallResult> {
  const citedText = flag.citedText?.trim() ?? "";

  // No citation to verify (e.g. not-addressed makes no textual claim). Nothing can be
  // fabricated, so the surfaced result is trustworthy — but grounded=false records that
  // there is no verified quote to display.
  if (!citedText) {
    return {
      status: "verified",
      grounded: false,
      supportsVerdict: null,
      reasoning: "No citation to verify — the verdict makes no textual claim.",
    };
  }

  // Stage (a) — deterministic grounding. This is the firewall's teeth.
  const grounded = normalizeForMatch(rawText).includes(normalizeForMatch(citedText));
  if (!grounded) {
    console.log(`[firewall] ${flag.ruleId} -> FABRICATED (cited text not found in raw_text)`);
    return {
      status: "fabricated",
      grounded: false,
      supportsVerdict: null,
      reasoning:
        "Cited text was not found verbatim in the contract source (normalized substring match failed). Quarantined as fabricated.",
    };
  }

  // Stage (b) — independent, cheaper LLM confirms the grounded quote supports the verdict.
  const check = await judgeSupport(flag, citedText);
  const status: FirewallStatus = check.supports ? "verified" : "needs-review";
  console.log(
    `[firewall] ${flag.ruleId} -> ${status.toUpperCase()} (grounded, judge supports=${check.supports})`,
  );
  return {
    status,
    grounded: true,
    supportsVerdict: check.supports,
    reasoning: check.reasoning,
  };
}

// --- Stage (b) judge -------------------------------------------------------

const RECORD_CHECK_TOOL = {
  name: "record_check",
  description:
    "Record whether the cited contract text genuinely supports the stated verdict for this rule.",
  input_schema: {
    type: "object" as const,
    properties: {
      supports: {
        type: "boolean",
        description:
          "true only if the quoted contract text, on its own, genuinely justifies the stated verdict for this rule. false if the quote is off-topic, insufficient, or does not actually establish the verdict.",
      },
      reasoning: {
        type: "string",
        description: "1-2 sentences explaining whether and how the quote supports the verdict.",
      },
    },
    required: ["supports", "reasoning"],
  },
};

type Support = { supports: boolean; reasoning: string };

async function judgeSupport(flag: Flag, citedText: string): Promise<Support> {
  const userText = [
    `A contract-review model reached a verdict about one playbook rule and cited a specific quote from the contract as support. Your ONLY job is to confirm whether that quote genuinely supports that verdict. Do not re-analyze the whole contract; judge only the quote against the verdict.`,
    ``,
    `Playbook rule: ${flag.clause}`,
    `Verdict claimed: ${flag.verdict}`,
    `Model's reasoning: ${flag.reasoning}`,
    ``,
    `Cited contract text:`,
    `"""`,
    citedText,
    `"""`,
    ``,
    `Does this quote, on its own, genuinely support the "${flag.verdict}" verdict for this rule? Record your answer with the record_check tool.`,
  ].join("\n");

  const msg = await anthropic.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 512,
    system:
      "You are an independent citation checker. You confirm that a quoted piece of contract text actually supports a stated compliance verdict. You are skeptical: if the quote does not clearly establish the verdict, you answer supports=false.",
    tools: [RECORD_CHECK_TOOL],
    tool_choice: { type: "tool", name: "record_check" },
    messages: [{ role: "user", content: userText }],
  });

  const block = msg.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error(`firewall: judge did not return a tool_use block for rule "${flag.ruleId}"`);
  }
  const input = block.input as Partial<Support>;
  if (typeof input.supports !== "boolean" || !input.reasoning) {
    throw new Error(`firewall: judge returned malformed check for rule "${flag.ruleId}"`);
  }
  return { supports: input.supports, reasoning: input.reasoning };
}
