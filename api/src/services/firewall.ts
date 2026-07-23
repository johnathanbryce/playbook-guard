// CITATION FIREWALL — the hard gate between flag() and the user. The core of the product.
//
// flag() produced a verdict + a citedSpan quote. Before that quote is ever shown as
// trustworthy, the firewall answers two INDEPENDENT questions:
//   (a) Is the quote real?  — deterministic. Does citedSpan appear VERBATIM in the
//       contract's untouched raw_text? We check the source ourselves, not the model's word.
//   (b) Does the quote support the verdict?  — a second, cheaper, INDEPENDENT LLM (Haiku)
//       confirms the cited language genuinely backs the flag.
//
// Labels (the firewall grades CITATIONS):
//   verified       — had a citation; (a) real and (b) confirmed supportive. Safe to surface.
//   needs-review   — a claim that a human should check: either (a) passed but (b) not confident,
//                    OR a compliant/deviation verdict that asserts a claim yet cites nothing.
//   fabricated     — (a) FAILED: the quote is not in the source. Quarantined; (b) never runs.
//   not-applicable — no citation to grade because the verdict makes no claim (not-addressed).
//
// Why deterministic-first: an ungrounded legal citation is worse than no tool. The quote
// must be proven present mechanically; only then do we spend an LLM call asking if it fits.
import type { Flag } from "./flag";
import { anthropic, JUDGE_MODEL } from "./claude";

export type FirewallStatus = "verified" | "needs-review" | "fabricated" | "not-applicable";

export type FirewallResult = {
  status: FirewallStatus;
  grounded: boolean; // stage (a): citedSpan found verbatim (normalized) in raw_text
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
  const citedSpan = flag.citedSpan?.trim() ?? "";

  // No citation to grade. The firewall grades citations, so the meaning depends on the verdict:
  if (!citedSpan) {
    // not-addressed makes no textual claim -> there is nothing to verify.
    if (flag.verdict === "not-addressed") {
      return {
        status: "not-applicable",
        grounded: false,
        supportsVerdict: null,
        reasoning: "No citation to verify — a not-addressed verdict makes no textual claim.",
      };
    }
    // Dangerous: a compliant/deviation verdict asserts a claim but cites nothing to ground it.
    console.log(`[firewall] ${flag.ruleId} -> NEEDS-REVIEW (claim with no citation)`);
    return {
      status: "needs-review",
      grounded: false,
      supportsVerdict: null,
      reasoning:
        "The verdict asserts a claim but provides no citation to verify. Flagged for human review.",
    };
  }

  // Stage (a) — deterministic grounding. This is the firewall's teeth.
  const grounded = normalizeForMatch(rawText).includes(normalizeForMatch(citedSpan));
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
  const check = await judgeSupport(flag, citedSpan);
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
    "Record whether the cited contract text is genuine, on-point evidence consistent with the stated verdict for this rule.",
  input_schema: {
    type: "object" as const,
    properties: {
      supports: {
        type: "boolean",
        description:
          "true if the quote is on-topic for this rule AND consistent with the verdict — i.e. it is relevant evidence and does not contradict or misrepresent the verdict. false ONLY if the quote is off-topic (wrong subject), contradicts the verdict, or misstates what the contract says. Do NOT answer false merely because the quote is one piece of a multi-part rule or does not by itself prove every element — completeness is the flagging model's job, not yours.",
      },
      reasoning: {
        type: "string",
        description:
          "1-2 sentences: is the quote on-topic and consistent with the verdict, or is it off-topic / contradictory / misrepresented?",
      },
    },
    required: ["supports", "reasoning"],
  },
};

type Support = { supports: boolean; reasoning: string };

async function judgeSupport(flag: Flag, citedSpan: string): Promise<Support> {
  const userText = [
    `A contract-review model reached a verdict about one playbook rule and cited a specific quote from the contract as its evidence. Your job is to catch FABRICATED or MISLEADING citations — not to re-judge the whole clause. Confirm the quote is genuine, on-point evidence consistent with the verdict.`,
    ``,
    `Playbook rule: ${flag.clause}`,
    `Verdict claimed: ${flag.verdict}`,
    `Model's reasoning: ${flag.reasoning}`,
    ``,
    `Cited contract text:`,
    `"""`,
    citedSpan,
    `"""`,
    ``,
    `Is this quote on-topic for this rule and consistent with the "${flag.verdict}" verdict? Answer supports=false ONLY if it is off-topic, contradicts the verdict, or misrepresents the contract. Do NOT answer false just because one quote doesn't cover every element of a multi-part rule — completeness is not your concern. Record your answer with the record_check tool.`,
  ].join("\n");

  const msg = await anthropic.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 512,
    system:
      "You are an independent citation checker for a contract-review tool. Another model reached a verdict and cited a quote as evidence; you catch fabricated or misleading citations. You confirm the quote is genuine, on-point evidence CONSISTENT with the verdict. You do NOT re-judge the whole clause or demand that one quote prove every element — you answer supports=false only when the quote is off-topic, contradicts the verdict, or misrepresents the contract.",
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
