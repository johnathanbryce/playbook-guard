// ANALYZE — the ONE core pipeline function. Two routes consume it (GET /analysis for the
// structured JSON integration surface; GET /stream for the live SSE demo), but the pipeline
// lives here exactly once so both surfaces return identical verdicts.
//
//   analyze(contractId, onRule?) -> AnalysisResult
//
// Per rule it runs retrieve -> flag -> firewall -> escalate, calls onRule as each rule
// resolves, then returns the full aggregate. onRule fires in EVERY path:
//   - cold: compute rule -> onRule(result) -> ... -> cache the aggregate -> return it
//   - warm: load cached aggregate -> onRule(result) per cached rule -> return it
// so the streaming UX (per-rule events, then done) is identical whether or not the cache is
// warm. /stream passes an onRule that writes an SSE event; /analysis passes none and awaits
// the aggregate (warm = instant). The cache wraps cleanly around the return value: it is both
// the thing /analysis wants and the thing we persist.
import { eq, asc, desc } from "drizzle-orm";
import { db } from "../db/client";
import { contracts, playbooks, playbookRules } from "../db/schema";
import { redis } from "../cache/redis";
import { flag, type Rule, type Verdict } from "./flag";
import { firewall, type FirewallResult } from "./firewall";
import { escalate, type EscalationEmail } from "./escalate";

const COVERAGE_BAR = 0.7; // top-1 sim at/above this = a confident on-topic match (see DECISIONS)
const CACHE_PREFIX = "analysis:";
const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24h

// One rule's full result: flag verdict + firewall grounding + any escalation. This is both
// the shape emitted through onRule (one SSE `rule` event) and an element of flags[].
export type RuleResult = {
  ruleId: string;
  clause: string;
  priority: string | null;
  verdict: Verdict;
  reasoning: string;
  citedSpan: string; // verbatim, firewall-grounded for deviations; "" for not-addressed
  topSimilarity: number;
  coverageHit: boolean; // topSimilarity >= COVERAGE_BAR
  firewall: FirewallResult; // { status, grounded, supportsVerdict, reasoning }
  escalation: EscalationEmail | null; // suppressed (null) when firewall says fabricated
};

export type AnalysisSummary = {
  ruleCount: number;
  coverage: { covered: number; total: number }; // e.g. 0/6 flags a wholly non-matching upload
  verdicts: { compliant: number; deviation: number; notAddressed: number };
  firewall: { verified: number; needsReview: number; fabricated: number; notApplicable: number };
  escalationCount: number;
};

export type AnalysisResult = {
  contractId: number;
  filename: string;
  contractHash: string;
  playbookVersion: string;
  flags: RuleResult[];
  escalations: EscalationEmail[]; // the non-null escalations, collected for the UI's email panel
  summary: AnalysisSummary;
  cached: boolean; // true when served from the result cache
  generatedAt: string; // ISO time of the ORIGINAL computation (stable across warm hits)
};

export type OnRule = (rule: RuleResult) => void | Promise<void>;

export async function analyze(contractId: number, onRule?: OnRule): Promise<AnalysisResult> {
  const [contract] = await db.select().from(contracts).where(eq(contracts.id, contractId));
  if (!contract) throw new Error(`analyze: unknown contract #${contractId}`);

  // Cache key = contract content + playbook version. A playbook bump invalidates cleanly.
  const [pb] = await db.select().from(playbooks).orderBy(desc(playbooks.createdAt)).limit(1);
  if (!pb) throw new Error("analyze: no playbook seeded");
  const playbookVersion = pb.version;
  const cacheKey = `${CACHE_PREFIX}${contract.contentHash}:${playbookVersion}`;

  // Warm hit: replay each cached rule through onRule (keeps the stream UX consistent), return.
  const cachedRaw = await redis.get(cacheKey);
  if (cachedRaw) {
    const cached = JSON.parse(cachedRaw) as AnalysisResult;
    console.log(
      `[analyze] contract #${contractId} CACHE HIT — replaying ${cached.flags.length} rules (${cacheKey})`,
    );
    for (const r of cached.flags) await onRule?.(r);
    return { ...cached, cached: true };
  }

  // Cold: run the pipeline per rule, in playbook order (sequential so the stream fills in order).
  const rules = await db.select().from(playbookRules).orderBy(asc(playbookRules.id));
  const flags: RuleResult[] = [];
  const escalations: EscalationEmail[] = [];

  for (const row of rules) {
    const rule = row.ruleJson as Rule;

    const f = await flag(rule.id, contractId); // retrieve + judge live inside flag()
    const fw = await firewall(f, contract.rawText); // hard gate: ground the citation
    // Firewall gate: never draft a department email off an ungrounded (fabricated) citation.
    const escalation =
      fw.status === "fabricated" ? null : await escalate(f, rule, contract.filename);

    const result: RuleResult = {
      ruleId: f.ruleId,
      clause: f.clause,
      priority: rule.priority ?? null,
      verdict: f.verdict,
      reasoning: f.reasoning,
      citedSpan: f.citedSpan,
      topSimilarity: f.topSimilarity,
      coverageHit: f.topSimilarity >= COVERAGE_BAR,
      firewall: fw,
      escalation,
    };

    flags.push(result);
    if (escalation) escalations.push(escalation);
    await onRule?.(result);
  }

  const aggregate: AnalysisResult = {
    contractId,
    filename: contract.filename,
    contractHash: contract.contentHash,
    playbookVersion,
    flags,
    escalations,
    summary: summarize(flags),
    cached: false,
    generatedAt: new Date().toISOString(),
  };

  // Only complete runs reach here (a rule failure throws and aborts before this) — so we
  // never cache a partial/errored analysis. Idempotent for 24h.
  await redis.set(cacheKey, JSON.stringify(aggregate), "EX", CACHE_TTL_SECONDS);
  console.log(
    `[analyze] contract #${contractId} computed ${flags.length} rules, coverage ${aggregate.summary.coverage.covered}/${aggregate.summary.coverage.total}, cached ${cacheKey}`,
  );

  return aggregate;
}

function summarize(flags: RuleResult[]): AnalysisSummary {
  const verdicts = { compliant: 0, deviation: 0, notAddressed: 0 };
  const fw = { verified: 0, needsReview: 0, fabricated: 0, notApplicable: 0 };
  let covered = 0;
  let escalationCount = 0;

  for (const f of flags) {
    if (f.verdict === "compliant") verdicts.compliant++;
    else if (f.verdict === "deviation") verdicts.deviation++;
    else verdicts.notAddressed++;

    if (f.firewall.status === "verified") fw.verified++;
    else if (f.firewall.status === "needs-review") fw.needsReview++;
    else if (f.firewall.status === "fabricated") fw.fabricated++;
    else fw.notApplicable++;

    if (f.coverageHit) covered++;
    if (f.escalation) escalationCount++;
  }

  return {
    ruleCount: flags.length,
    coverage: { covered, total: flags.length },
    verdicts,
    firewall: fw,
    escalationCount,
  };
}
