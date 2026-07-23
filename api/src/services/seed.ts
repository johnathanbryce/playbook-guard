import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { db } from "../db/client";
import { playbooks, playbookRules } from "../db/schema";

// Shape we care about from the playbook JSON. `rules` is split out; everything
// else is the envelope metadata the frontend renders.
type PlaybookRule = { id: string; [k: string]: unknown };
type PlaybookDoc = {
  name: string;
  version: string;
  rules: PlaybookRule[];
  [k: string]: unknown;
};

// Prefer the configured path (matches docker-compose), else resolve the
// repo's data file relative to this module so seeding works from any cwd.
function playbookPath(): string {
  return (
    process.env.PLAYBOOK_PATH ??
    fileURLToPath(new URL("../../../data/playbook.saas.json", import.meta.url))
  );
}

// Load data/playbook.saas.json into the DB: one `playbooks` row for the
// envelope + one `playbook_rules` row per rule. Idempotent — re-running upserts.
export async function seed(): Promise<{ version: string; ruleCount: number }> {
  const raw = await readFile(playbookPath(), "utf8");
  const doc = JSON.parse(raw) as PlaybookDoc;

  if (!doc?.name || !doc?.version || !Array.isArray(doc.rules)) {
    throw new Error("playbook JSON missing name/version/rules");
  }

  const { rules, ...meta } = doc;

  // Envelope: keyed on (name, version) so re-seeding the same version updates
  // in place and a version bump inserts a new row.
  await db
    .insert(playbooks)
    .values({ name: meta.name, version: meta.version, meta })
    .onConflictDoUpdate({
      target: [playbooks.name, playbooks.version],
      set: { meta },
    });

  // Rules: one row each, keyed on the unique rule_id.
  for (const rule of rules) {
    if (!rule?.id) throw new Error("playbook rule missing id");
    await db
      .insert(playbookRules)
      .values({ ruleId: rule.id, ruleJson: rule })
      .onConflictDoUpdate({
        target: playbookRules.ruleId,
        set: { ruleJson: rule },
      });
  }

  return { version: meta.version, ruleCount: rules.length };
}
