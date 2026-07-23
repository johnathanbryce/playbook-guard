// Turn a playbook rule into the text we embed as the retrieval query. We use
// clause + preferred: the positive, topical description of the rule. It maps well
// onto the contract section that addresses the topic (compliant OR not), and is
// robust to renamed section headers without being diluted by violation phrasing.
// Kept separate from retrieve() so the retriever stays a generic search primitive
// with no coupling to the playbook shape.
type RuleLike = { clause?: string; preferred?: string };

export function ruleToQuery(rule: RuleLike): string {
  return [rule.clause, rule.preferred].filter(Boolean).join("\n\n").trim();
}
