import {
  pgTable,
  serial,
  integer,
  text,
  jsonb,
  timestamp,
  vector,
  index,
  unique,
} from "drizzle-orm/pg-core";

// Untouched source contracts. raw_text is load-bearing ground truth for the firewall.
export const contracts = pgTable("contracts", {
  id: serial("id").primaryKey(),
  filename: text("filename").notNull(),
  rawText: text("raw_text").notNull(),
  contentHash: text("content_hash").notNull(), // sha256 of file bytes, for exact-dup skip
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Retrievable chunks with embeddings.
export const chunks = pgTable(
  "chunks",
  {
    id: serial("id").primaryKey(),
    contractId: integer("contract_id")
      .notNull()
      .references(() => contracts.id),
    chunkText: text("chunk_text").notNull(),
    sectionLabel: text("section_label"),
    embedding: vector("embedding", { dimensions: 1536 }),
  },
  (t) => [
    // HNSW builds incrementally -> correct on a table that starts empty (ivfflat would degenerate).
    index("chunks_embedding_hnsw_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
  ],
);

// Playbook envelope (metadata minus rules). One row per playbook version.
// `version` is load-bearing downstream: the analysis-result cache keys on it.
export const playbooks = pgTable(
  "playbooks",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    version: text("version").notNull(),
    // Full envelope with `rules` stripped out — lossless reconstruction of GET /playbook.
    meta: jsonb("meta").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [unique("playbooks_name_version_key").on(t.name, t.version)],
);

// Playbook rules, one row per rule.
export const playbookRules = pgTable("playbook_rules", {
  id: serial("id").primaryKey(),
  ruleId: text("rule_id").notNull().unique(),
  ruleJson: jsonb("rule_json").notNull(),
});
