import { Router, type Request, type Response } from "express";
import multer from "multer";
import { ingest } from "../services/ingest";

// In-memory upload; contracts are small .txt files. 5 MB ceiling as a guard.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const router = Router();

// POST /contracts: upload one .txt (multipart field "file") -> ingest().
router.post(
  "/contracts",
  upload.single("file"),
  async (req: Request, res: Response) => {
    try {
      const file = req.file;
      if (!file) {
        return res
          .status(400)
          .json({ error: "no file uploaded (multipart field 'file')" });
      }

      const isTxt =
        file.mimetype === "text/plain" ||
        file.originalname.toLowerCase().endsWith(".txt");
      if (!isTxt) {
        return res
          .status(415)
          .json({ error: "only .txt files are supported (MVP)" });
      }

      const rawText = file.buffer.toString("utf8");
      if (!rawText.trim()) {
        return res.status(400).json({ error: "file is empty" });
      }

      console.log(
        `[POST /contracts] received "${file.originalname}" (${file.size} bytes)`,
      );
      const result = await ingest(file.originalname, rawText);
      console.log(`[POST /contracts] done:`, result);

      // 201 for a freshly ingested contract, 200 when we returned a dedup hit.
      res.status(result.deduped ? 200 : 201).json(result);
    } catch (err) {
      console.error(`[POST /contracts] error:`, err);
      res.status(500).json({ error: "ingest failed", detail: String(err) });
    }
  },
);

export default router;
