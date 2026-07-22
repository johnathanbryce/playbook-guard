import { Router } from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";

const router = Router();

// Serve the existing playbook off disk. DB-backed later.
const PLAYBOOK_PATH =
  process.env.PLAYBOOK_PATH ??
  path.resolve(process.cwd(), "../data/playbook.saas.json");

router.get("/playbook", async (_req, res) => {
  try {
    const raw = await readFile(PLAYBOOK_PATH, "utf8");
    res.type("application/json").send(raw);
  } catch (err) {
    res
      .status(500)
      .json({ error: "failed to read playbook", detail: String(err) });
  }
});

export default router;
