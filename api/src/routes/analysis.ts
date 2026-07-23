import type { Request, Response } from "express";
import { analyze } from "../services/analyze";

// GET /analysis?contractId= -> the full AnalysisResult as JSON.
//
// The integration surface: a REAL server-side analyze() call (no onRule), returning the
// complete structured result in one response. This is NOT accumulated SSE — a consumer
// (curl, another service) hits this and gets the whole payload back, which is what makes
// the "it's a callable API" story true. Idempotent via analyze()'s result cache.
export async function analysisHandler(req: Request, res: Response): Promise<void> {
  const raw = req.query.contractId;
  const contractId = Number(raw);
  if (!raw || !Number.isInteger(contractId) || contractId <= 0) {
    res.status(400).json({ error: "contractId query param must be a positive integer" });
    return;
  }

  try {
    const result = await analyze(contractId); // no onRule -> just await the aggregate
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("unknown contract")) {
      res.status(404).json({ error: `contract #${contractId} not found` });
      return;
    }
    console.error("[/analysis] error:", message);
    res.status(500).json({ error: "analysis failed", detail: message });
  }
}
