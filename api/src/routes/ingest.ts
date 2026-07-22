import type { Request, Response } from "express";

// Upload handler: accept a contract file, run the ingest pipeline, return the contract id.
export function ingestHandler(req: Request, res: Response): void {
  throw new Error("TODO(John)");
}
