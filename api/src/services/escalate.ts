// ESCALATION DRAFTING — repurposed from the original "route to a stronger model" stub.
// When a flagged rule carries an escalation.team, draft a text-only notification email to
// that department for human review. There is NO email connection: the frontend renders the
// draft with display-only Send / Deny buttons (human-in-the-loop), and nothing is ever sent.
//
// escalate() returns EscalationEmail | null:
//   - null  when the rule has no escalation.team, or the verdict is compliant (nothing to raise).
//   - email when the verdict is a deviation or the required clause is not-addressed.
//
// Caller contract: analyze() must not pass a flag whose firewall status is `fabricated` — an
// escalation must never cite ungrounded text. The email quotes flag.citedSpan verbatim (already
// firewall-grounded for deviations; empty for not-addressed, where the email notes the gap).
import type { Flag, Rule } from "./flag";
import { anthropic, JUDGE_MODEL } from "./claude";

export type EscalationEmail = {
  id: string; // stable per rule+contract, so the frontend can key the list + its Send/Deny buttons
  ruleId: string;
  team: string; // escalation.team — the "To" department
  subject: string;
  body: string; // text-only draft (greeting + body + sign-off)
  triggeredBy: {
    verdict: Flag["verdict"];
    clause: string;
    citedSpan: string; // grounded contract text; "" for not-addressed
  };
};

export async function escalate(
  flag: Flag,
  rule: Rule,
  filename: string,
): Promise<EscalationEmail | null> {
  // Nothing to escalate: no destination team, or the clause is fine.
  if (!rule.escalation?.team || flag.verdict === "compliant") {
    return null;
  }

  const team = rule.escalation.team;
  const subject = `[Playbook Guard] ${team} review needed — ${rule.clause} in ${filename}`;
  const body = await draftBody(flag, rule, filename, team);

  console.log(`[escalate] ${flag.ruleId} -> ${team} (${flag.verdict})`);

  return {
    id: `esc-${flag.ruleId}`,
    ruleId: flag.ruleId,
    team,
    subject,
    body,
    triggeredBy: { verdict: flag.verdict, clause: rule.clause, citedSpan: flag.citedSpan },
  };
}

// --- LLM draft -------------------------------------------------------------

async function draftBody(
  flag: Flag,
  rule: Rule,
  filename: string,
  team: string,
): Promise<string> {
  const concern =
    flag.verdict === "not-addressed"
      ? `The contract does not appear to address this clause at all, which the playbook flags as a gap requiring ${team}'s attention.`
      : `The contract addresses this clause but deviates from the playbook's required position.`;

  const userText = [
    `Draft a short internal escalation email notifying the ${team} team to review a clause in a contract under legal review. Text only — no markdown, no subject line, no placeholders like [Name] or [Your Name]. Sign off as "Playbook Guard — automated contract review".`,
    ``,
    `Contract file: ${filename}`,
    `Playbook clause: ${rule.clause}`,
    `Review verdict: ${flag.verdict}`,
    `Why ${team}: ${rule.escalation?.trigger ?? "clause falls under this team's remit."}`,
    `Situation: ${concern}`,
    `Reviewer's reasoning: ${flag.reasoning}`,
    flag.citedSpan ? `Relevant contract text: "${flag.citedSpan}"` : `(No corresponding clause text — the provision is absent.)`,
    ``,
    `Keep it under 150 words, professional and specific. State what was found and ask the team to review.`,
  ].join("\n");

  const msg = await anthropic.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 500,
    system:
      "You draft concise, professional internal escalation emails for a contract-review tool. Text only, no markdown, no fabricated details beyond what you are given.",
    messages: [{ role: "user", content: userText }],
  });

  let text = "";
  for (const b of msg.content) {
    if (b.type === "text") text += b.text;
  }
  text = text.trim();

  // Deterministic fallback so an escalation always has a body even if the draft comes back empty.
  if (!text) {
    return (
      `Hello ${team},\n\n` +
      `Our playbook review of ${filename} flagged the "${rule.clause}" clause as ${flag.verdict}. ` +
      `${concern} ${flag.reasoning}\n\n` +
      `Please review at your convenience.\n\n` +
      `Playbook Guard — automated contract review`
    );
  }
  return text;
}
