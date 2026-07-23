import { createHash } from "node:crypto";
import { openai } from "@ai-sdk/openai";
import { embedMany } from "ai";
import { redis } from "../cache/redis";

const MODEL = "text-embedding-3-small"; // 1536-dim
const CACHE_PREFIX = `emb:${MODEL}:`;
// Embeddings are deterministic per (model, text) and never change, so a long TTL is
// safe; it exists only to bound Redis growth, not for correctness.
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

const keyFor = (text: string) =>
  CACHE_PREFIX + createHash("sha256").update(text).digest("hex");

// Turn chunk text into 1536-dim embedding vectors (OpenAI text-embedding-3-small).
//
// THE REDIS EMBEDDING CACHE LIVES HERE, keyed on sha256(text). Why here and why:
// embedding is a deterministic *paid* API call — identical text always yields the
// identical vector. So we never pay/wait twice for: a re-uploaded (hash-dup) contract,
// or boilerplate that repeats near-verbatim across contracts (the license/definitions
// clauses are nearly identical across the four test contracts). Cache hits skip OpenAI
// entirely; only misses are sent, in one batched call. Returned order == input order.
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const keys = texts.map(keyFor);
  const cached = await redis.mget(keys);

  const out: (number[] | null)[] = cached.map((v) =>
    v ? (JSON.parse(v) as number[]) : null,
  );
  const missIdx = out.flatMap((v, i) => (v === null ? [i] : []));

  if (missIdx.length > 0) {
    const { embeddings } = await embedMany({
      model: openai.embedding(MODEL),
      values: missIdx.map((i) => texts[i]),
    });

    const writes = redis.pipeline();
    missIdx.forEach((i, j) => {
      out[i] = embeddings[j];
      writes.set(keys[i], JSON.stringify(embeddings[j]), "EX", CACHE_TTL_SECONDS);
    });
    await writes.exec();
  }

  return out as number[][];
}
