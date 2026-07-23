import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { contracts, chunks } from "../db/schema";
import { chunk } from "./chunk";
import { embed } from "./embed";

export type IngestResult = {
  contractId: number;
  chunkCount: number;
  deduped: boolean;
};

// Full ingest pipeline: hash-dedup -> store contract -> chunk -> embed -> store chunks.
export async function ingest(
  filename: string,
  rawText: string,
): Promise<IngestResult> {
  const contentHash = createHash("sha256").update(rawText, "utf8").digest("hex");
  console.log(
    `[ingest] "${filename}" (${rawText.length} chars) sha256=${contentHash.slice(0, 12)}…`,
  );

  // Dedup on exact content: same bytes -> reuse the existing contract + chunks,
  // skip re-chunking and (paid) re-embedding entirely.
  const [existing] = await db
    .select({ id: contracts.id })
    .from(contracts)
    .where(eq(contracts.contentHash, contentHash))
    .limit(1);

  if (existing) {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(chunks)
      .where(eq(chunks.contractId, existing.id));
    console.log(
      `[ingest] DEDUP hit -> contract #${existing.id} already has ${n} chunks; skipping chunk+embed`,
    );
    return { contractId: existing.id, chunkCount: n, deduped: true };
  }

  // 1) Store the untouched source (raw_text is the firewall's ground truth).
  const [inserted] = await db
    .insert(contracts)
    .values({ filename, rawText, contentHash })
    .returning({ id: contracts.id });
  const contractId = inserted.id;
  console.log(`[ingest] stored contract #${contractId}`);

  // 2) Chunk on section boundaries (one chunk per top-level section).
  const pieces = chunk(rawText);
  console.log(
    `[ingest] chunked into ${pieces.length} sections: ${pieces
      .map((p) => p.sectionLabel ?? "(null)")
      .join(" | ")}`,
  );
  if (pieces.length === 0) {
    console.log(`[ingest] no chunks produced; done`);
    return { contractId, chunkCount: 0, deduped: false };
  }

  // 3) Embed (Redis-cached inside embed()).
  const vectors = await embed(pieces.map((p) => p.chunkText));
  console.log(
    `[ingest] embedded ${vectors.length} chunks (dim ${vectors[0]?.length ?? 0})`,
  );

  // 4) Store chunks + their embeddings for pgvector retrieval.
  await db.insert(chunks).values(
    pieces.map((p, i) => ({
      contractId,
      chunkText: p.chunkText,
      sectionLabel: p.sectionLabel,
      embedding: vectors[i],
    })),
  );
  console.log(
    `[ingest] stored ${pieces.length} chunk rows for contract #${contractId}`,
  );

  return { contractId, chunkCount: pieces.length, deduped: false };
}
