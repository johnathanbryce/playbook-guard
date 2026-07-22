# Playbook Guard — master tracker

Succinct bullet tracker of status + high-level notes. Keep updated as we progress.

## Stack
- Frontend: React + Vite (TS)
- Backend: Express 5 (TS, run via tsx)
- DB: Postgres 16 + pgvector, Drizzle ORM (node-postgres driver)
- Cache: Redis via ioredis
- Orchestration: Docker Compose (postgres, redis, api, web)
- Installed-but-unwired: `ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`

## BUILT (real plumbing)
- docker-compose.yml — pgvector/pg16, redis:7, api, web; named pg volume; anon node_modules volumes; api bind-mount + tsx watch
- api/db/init/01-pgvector.sql — CREATE EXTENSION vector (initdb only)
- api/src/db/schema.ts — contracts, chunks (+HNSW cosine index), playbook_rules
- api/src/db/client.ts — Drizzle over pg Pool (DATABASE_URL)
- api/src/cache/redis.ts — ioredis (REDIS_URL)
- api/src/index.ts — Express + CORS + JSON; GET /health inline; mounts playbook + contracts + stream routers
- api/src/routes/playbook.ts — GET /playbook (reads data/playbook.saas.json off disk)
- web — static shell: upload input, Check button, empty results list w/ verdict-pill + grounding-badge markup + CSS (upload/Check still NO wiring)
- web — playbook render (display plumbing): App.tsx fetches GET /playbook on mount, renders envelope meta + rules (clause/id/priority/preferred) read-only, w/ loading + error states
- package.json + tsconfig for api & web; drizzle.config.ts; Dockerfiles; .env.example
- npm install run in both api/ and web/

## STUBBED (throw TODO(John) — John implements live)
- api/src/services/seed.ts — load playbook.saas.json into playbook_rules
- api/src/services/chunk.ts — split raw_text into labeled chunks
- api/src/services/embed.ts — chunk text -> 1536-dim vectors
- api/src/services/ingest.ts — hash-dedup -> store -> chunk -> embed -> store chunks
- api/src/services/retrieve.ts — vector search over chunks
- api/src/services/flag.ts — judge passages vs a playbook rule -> verdict
- api/src/services/firewall.ts — verify claims grounded in untouched raw_text
- api/src/services/escalate.ts — route low-confidence/ungrounded to stronger model/human
- api/src/routes/contracts.ts — POST /contracts: upload .txt -> ingest() -> chunk/embed/store (router mounted; body stubbed)
- api/src/routes/stream.ts — GET /stream SSE handler streaming per-rule verdicts (mounted; body stubbed)

## NOT OURS (already exist — do not touch)
- data/playbook.saas.json
- data/contracts/*.txt

## Key decisions (see DECISIONS.md)
- HNSW cosine (empty-table-safe) over ivfflat
- raw_text untouched = firewall ground truth
- pgvector extension via initdb SQL; schema.ts owns tables + index
- TS moduleResolution: Bundler (no .js import friction live)

## BUILD ORDER (live)
seed -> chunk -> embed -> ingest -> wire upload -> retrieve -> flag -> firewall (+test) -> escalate -> SSE

## NEXT
- Start at `seed`: read playbook.saas.json, insert into playbook_rules
