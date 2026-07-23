import { eq, sql, cosineDistance } from "drizzle-orm";
import { db } from "../db/client";
import { chunks } from "../db/schema";
import { embed } from "./embed";

const DEFAULT_K = 3;

export type Retrieved = {
  chunkId: number;
  chunkText: string;
  sectionLabel: string | null;
  distance: number; // cosine distance, 0 = identical
  similarity: number; // 1 - distance
};

// Generic semantic search: embed a query and return the nearest contract sections
// for ONE contract. Rule -> query construction lives in rule-query.ts; this stays a
// reusable primitive. Cosine distance (`<=>`) matches the chunks HNSW vector_cosine_ops
// index, so ordering ascending by it uses the index.
export async function retrieve(
  query: string,
  opts: { contractId: number; k?: number },
): Promise<Retrieved[]> {
  const k = opts.k ?? DEFAULT_K;

  const [vec] = await embed([query]);
  const distance = cosineDistance(chunks.embedding, vec);

  // Every ingested chunk has an embedding (ingest inserts them), so no null filter.
  const rows = await db
    .select({
      chunkId: chunks.id,
      chunkText: chunks.chunkText,
      sectionLabel: chunks.sectionLabel,
      distance: sql<number>`${distance}`,
    })
    .from(chunks)
    .where(eq(chunks.contractId, opts.contractId))
    .orderBy(distance)
    .limit(k);

  const results = rows.map((r) => {
    const d = Number(r.distance);
    return {
      chunkId: r.chunkId,
      chunkText: r.chunkText,
      sectionLabel: r.sectionLabel,
      distance: d,
      similarity: 1 - d,
    };
  });

  const top = results[0];
  console.log(
    `[retrieve] contract #${opts.contractId} "${query.slice(0, 40).replace(/\n/g, " ")}…" -> ${results.length} hits` +
      (top ? ` (top: ${top.sectionLabel} sim=${top.similarity.toFixed(3)})` : ""),
  );

  return results;
}
