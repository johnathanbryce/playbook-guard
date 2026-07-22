import express from "express";
import cors from "cors";
import playbookRouter from "./routes/playbook";
import contractsRouter from "./routes/contracts";
import { streamHandler } from "./routes/stream";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use(playbookRouter);
app.use(contractsRouter);
app.get("/stream", streamHandler);

const PORT = Number(process.env.PORT ?? 3001);
app.listen(PORT, () => {
  console.log(`api listening on :${PORT}`);
});
