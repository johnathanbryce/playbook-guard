import { Router } from "express";
import { desc, asc } from "drizzle-orm";
import { db } from "../db/client";
import { playbooks, playbookRules } from "../db/schema";

const router = Router();

// Serve the playbook from the DB (seeded via `npm run db:seed`).
// Reconstructs the original envelope: latest playbook row's meta + its rules,
// rules returned in insertion order (matches the source JSON order).
router.get("/playbook", async (_req, res) => {
  try {
    const [pb] = await db
      .select()
      .from(playbooks)
      .orderBy(desc(playbooks.createdAt))
      .limit(1);

    if (!pb) {
      return res
        .status(404)
        .json({ error: "no playbook seeded", hint: "run: npm run db:seed" });
    }

    const rows = await db
      .select({ ruleJson: playbookRules.ruleJson })
      .from(playbookRules)
      .orderBy(asc(playbookRules.id));

    res.json({ ...(pb.meta as object), rules: rows.map((r) => r.ruleJson) });
  } catch (err) {
    res
      .status(500)
      .json({ error: "failed to read playbook", detail: String(err) });
  }
});

export default router;
