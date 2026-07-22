-- Runs once, on first postgres boot (empty data dir), via /docker-entrypoint-initdb.d.
-- Only the extension lives here; tables + the HNSW index are owned by src/db/schema.ts.
CREATE EXTENSION IF NOT EXISTS vector;
