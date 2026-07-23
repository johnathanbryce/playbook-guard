import type { Request, Response } from "express";
import { analyze } from "../services/analyze";

// GET /stream?contractId= — Server-Sent Events. Runs the SAME analyze() as /analysis, but
// passes an onRule that writes one `rule` event per RuleResult as it resolves, then a final
// `done` event carrying the aggregate meta (summary, escalations, cached, …). On a warm cache
// hit analyze() replays the cached rules through onRule, so the stream looks identical.
export async function streamHandler(req: Request, res: Response): Promise<void> {
  const raw = req.query.contractId;
  const contractId = Number(raw);
  if (!raw || !Number.isInteger(contractId) || contractId <= 0) {
    res.status(400).json({ error: "contractId query param must be a positive integer" });
    return;
  }

  // SSE handshake.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const result = await analyze(contractId, (rule) => {
      send("rule", rule); // one event per rule as it lands
    });
    const { flags, ...meta } = result; // flags already streamed; send the rest as `done`
    send("done", meta);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[/stream] error:", message);
    send("error", { error: message });
  } finally {
    res.end();
  }
}
