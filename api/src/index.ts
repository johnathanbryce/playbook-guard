import express from "express";
import cors from "cors";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ingestHandler } from "./routes/ingest";

const app = express();
app.use(cors());
app.use(express.json());

// Serve the existing playbook off disk. DB-backed later.
const PLAYBOOK_PATH =
  process.env.PLAYBOOK_PATH ??
  path.resolve(process.cwd(), "../data/playbook.saas.json");

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/playbook", async (_req, res) => {
  try {
    const raw = await readFile(PLAYBOOK_PATH, "utf8");
    res.type("application/json").send(raw);
  } catch (err) {
    res
      .status(500)
      .json({ error: "failed to read playbook", detail: String(err) });
  }
});

app.post("/ingest", ingestHandler);

const PORT = Number(process.env.PORT ?? 3001);
app.listen(PORT, () => {
  console.log(`api listening on :${PORT}`);
});
