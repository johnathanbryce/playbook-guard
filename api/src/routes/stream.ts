import type { Request, Response } from "express";

// SSE handler: stream per-rule verdicts to the web client as the check runs.
export function streamHandler(req: Request, res: Response): void {
  throw new Error("TODO(John)");
}
