import { Router, type Request, type Response } from "express";

const router = Router();

router.post("/contracts", (_req: Request, res: Response) => {
  // upload .txt -> ingest() -> chunk/embed/store
  throw new Error("TODO(John)");
});

export default router;
