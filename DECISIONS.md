# Decisions

Running log of every place we deviate from the recommended plan, with the reason.
Append newest at the bottom.

## Pre-stage (scaffold)

- **Plumbing-only scaffold; analysis spine stubbed.** Every service that carries
  control flow, a query, or a transform is left as `throw new Error("TODO(John)")` so
  John writes all business logic live. Only transport/config/schema is real code.
- **Schema uses HNSW cosine, not ivfflat.** HNSW builds incrementally, so the index is
  correct on a table that starts empty. ivfflat k-means-trains on the rows present at
  build time and degenerates when built against an empty table.
- **`raw_text` kept untouched as the firewall's ground truth.** The source bytes are
  load-bearing; the firewall verifies claims against them, so nothing normalizes or
  rewrites `raw_text` on the way in.
- **pgvector extension via initdb SQL; tables + HNSW index owned by `schema.ts`.**
  `api/db/init/01-pgvector.sql` only runs `CREATE EXTENSION vector`. The index is NOT
  duplicated in raw SQL — `schema.ts` is the single canonical source.
- **api runs bind-mount + `tsx watch` in compose (chosen over a self-contained image).**
  Host edits reload live during the timed build; anonymous `/app/node_modules` volume
  preserves the Linux-built binaries.
- **TS `moduleResolution: Bundler` (both api and web).** Avoids `.js`-extension import
  friction in the editor during a live build; tsx/vite resolve extensionless imports.
- **`.env` left in place with live keys; added `DATABASE_URL` + `REDIS_URL`.** `.env` is
  gitignored. `.env.example` committed with placeholders.
