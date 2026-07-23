// Judge retrieved passages against ONE playbook rule and produce a structured verdict.
//
// Pipeline: load rule -> retrieve(top-k for this contract) -> similarity floor
// short-circuit -> else ask the flagger Claude to judge ONLY the retrieved passages.
//
// Similarity is a SIGNAL, not a hard gate (see DECISIONS, retrieval [AMENDED]):
//   1. FLOOR (0.35) — a degenerate-retrieval backstop. If even the best passage is below
//      it, nothing on-topic was retrieved; mark not-addressed WITHOUT an LLM call. On real
//      legal prose this ~never fires (measured off-topic band 0.35–0.48), which is correct
//      for a backstop — the LLM owns the not-addressed call for everything above it.
//   2. top-1 similarity is passed INTO the judge prompt as a confidence hint, so a weak
//      match informs (but does not override) its not-addressed reasoning.
// The coverage bar (0.70) is NOT applied here — it lives in analyze(), which aggregates
// topSimilarity across rules into a per-contract coverage metric.
//
// The output is designed for the firewall: `citedText` MUST be a verbatim substring of a
// retrieved passage (and therefore of raw_text), so the firewall can ground it deterministically.
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { playbookRules } from "../db/schema";
import { retrieve, type Retrieved } from "./retrieve";
import { ruleToQuery } from "./rule-query";
import { anthropic, FLAGGER_MODEL } from "./claude";

const FLOOR = 0.35; // tuned against 4 real fixtures + an off-topic NDA (see DECISIONS)

export type Verdict = "compliant" | "deviation" | "not-addressed";

export type Rule = {
  id: string;
  clause: string;
  preferred?: string;
  hardStop?: string;
  fallbacks?: string[];
  priority?: string;
};

export type Flag = {
  ruleId: string;
  clause: string;
  verdict: Verdict;
  citedText: string; // verbatim quote from a retrieved passage; "" when not-addressed
  reasoning: string;
  topSimilarity: number; // top-1 retrieval similarity (analyze applies the 0.70 coverage bar)
  shortCircuited: boolean; // true if the floor skipped the LLM
  passages: { sectionLabel: string | null; similarity: number }[]; // candidates judged, for audit
};

export async function flag(ruleId: string, contractId: number): Promise<Flag> {
  const [row] = await db
    .select()
    .from(playbookRules)
    .where(eq(playbookRules.ruleId, ruleId));
  if (!row) throw new Error(`flag: unknown rule "${ruleId}"`);
  const rule = row.ruleJson as Rule;

  const hits = await retrieve(ruleToQuery(rule), { contractId, k: 3 });
  const top = hits[0];
  const topSimilarity = top?.similarity ?? 0;
  const passages = hits.map((h) => ({ sectionLabel: h.sectionLabel, similarity: h.similarity }));

  // 1. Floor short-circuit — nothing on-topic retrieved, don't spend an LLM call.
  if (!top || topSimilarity < FLOOR) {
    console.log(
      `[flag] ${ruleId} contract #${contractId} -> not-addressed (floor: top sim ${topSimilarity.toFixed(3)} < ${FLOOR}, no LLM)`,
    );
    return {
      ruleId,
      clause: rule.clause,
      verdict: "not-addressed",
      citedText: "",
      reasoning: `No contract section is semantically close to this rule (top similarity ${topSimilarity.toFixed(3)} is below the ${FLOOR} floor), so the contract is treated as not addressing it.`,
      topSimilarity,
      shortCircuited: true,
      passages,
    };
  }

  // 2. Ask the flagger to judge ONLY these passages.
  const judged = await judge(rule, hits, topSimilarity);

  // not-addressed carries no citation; enforce it so the firewall never grounds a stray quote.
  const citedText = judged.verdict === "not-addressed" ? "" : judged.citedText.trim();

  console.log(
    `[flag] ${ruleId} contract #${contractId} -> ${judged.verdict} (top sim ${topSimilarity.toFixed(3)})` +
      (citedText ? ` cite="${citedText.slice(0, 60).replace(/\n/g, " ")}…"` : ""),
  );

  return {
    ruleId,
    clause: rule.clause,
    verdict: judged.verdict,
    citedText,
    reasoning: judged.reasoning,
    topSimilarity,
    shortCircuited: false,
    passages,
  };
}

// --- LLM judge -------------------------------------------------------------

const RECORD_VERDICT_TOOL = {
  name: "record_verdict",
  description:
    "Record the compliance verdict for one playbook rule against the provided contract passages.",
  input_schema: {
    type: "object" as const,
    properties: {
      verdict: {
        type: "string",
        enum: ["compliant", "deviation", "not-addressed"],
        description:
          "compliant = the passages satisfy the rule's preferred position; deviation = they address the topic but weaken, violate, or fall short of it (especially any hardStop); not-addressed = the passages do not cover this rule's topic at all.",
      },
      citedText: {
        type: "string",
        description:
          "A VERBATIM quote copied character-for-character from ONE of the provided passages that most directly supports the verdict. Do not paraphrase, reformat, or add ellipses inside the quote. Use an empty string ONLY when verdict is not-addressed.",
      },
      reasoning: {
        type: "string",
        description:
          "1-3 sentences explaining the verdict with reference to the specific contract language and the rule's preferred position / hardStop.",
      },
    },
    required: ["verdict", "citedText", "reasoning"],
  },
};

type Judged = { verdict: Verdict; citedText: string; reasoning: string };

async function judge(rule: Rule, hits: Retrieved[], topSimilarity: number): Promise<Judged> {
  const passages = hits
    .map(
      (h, i) =>
        `[Passage ${i + 1} — ${h.sectionLabel ?? "(preamble)"} — match ${h.similarity.toFixed(2)}]\n${h.chunkText}`,
    )
    .join("\n\n");

  const confidenceHint =
    topSimilarity < 0.5
      ? `The best passage's semantic match to this rule is only ${topSimilarity.toFixed(2)} (low). The contract may not genuinely address this topic — weigh carefully whether these passages are actually on-topic before choosing compliant/deviation over not-addressed.`
      : `The best passage's semantic match to this rule is ${topSimilarity.toFixed(2)}.`;

  const userText = [
    `PLAYBOOK RULE: ${rule.clause}`,
    ``,
    `Preferred position:\n${rule.preferred ?? "(none provided)"}`,
    rule.hardStop ? `\nHard stops (unacceptable — treat as deviation):\n${rule.hardStop}` : "",
    rule.fallbacks?.length
      ? `\nAcceptable fallbacks (still compliant if met):\n- ${rule.fallbacks.join("\n- ")}`
      : "",
    ``,
    `CONTRACT PASSAGES (judge ONLY these — do not assume anything outside them):`,
    ``,
    passages,
    ``,
    confidenceHint,
    ``,
    `Judge these passages against the rule and record your verdict via the record_verdict tool. The citedText must be copied verbatim from a passage above.`,
  ]
    .filter(Boolean)
    .join("\n");

  const msg = await anthropic.messages.create({
    model: FLAGGER_MODEL,
    max_tokens: 1024,
    system:
      "You are a senior contracts reviewer applying a legal playbook to a SaaS agreement from the customer's side. You judge only the contract passages you are given, never inventing terms. Your citations must be exact quotes so a downstream verifier can find them verbatim in the source.",
    tools: [RECORD_VERDICT_TOOL],
    tool_choice: { type: "tool", name: "record_verdict" },
    messages: [{ role: "user", content: userText }],
  });

  const block = msg.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error(`flag: judge did not return a tool_use block for rule "${rule.id}"`);
  }
  const input = block.input as Partial<Judged>;
  if (!input.verdict || typeof input.citedText !== "string" || !input.reasoning) {
    throw new Error(`flag: judge returned malformed verdict for rule "${rule.id}"`);
  }
  return { verdict: input.verdict, citedText: input.citedText, reasoning: input.reasoning };
}
