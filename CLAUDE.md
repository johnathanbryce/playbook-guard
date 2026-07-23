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
- api/src/services/seed.ts — load playbook.saas.json into playbook_rules (one row/rule)
- api/src/services/chunk.ts — split raw_text into labeled chunks (~paragraph granularity; byte-faithful for firewall)
- api/src/services/embed.ts — chunk text -> 1536-dim vectors (OpenAI text-embedding-3-small; Redis cache by sha256(chunkText))
- api/src/services/ingest.ts — hash-dedup -> store -> chunk -> embed -> store chunks
- api/src/services/retrieve.ts — cosine top-k over chunks; SIG CHANGE -> add contractId filter (scope search to one contract)
- api/src/services/flag.ts — flagger Claude judges top-k passages vs one rule -> {verdict: compliant|deviation|not-addressed, citedText, reasoning}
- api/src/services/firewall.ts — HARD GATE, core of product. SIG CHANGE -> firewall(flag, rawText). (a) deterministic normalized-substring check of citedText in raw_text; (b) cheaper Claude judge confirms quote supports verdict -> verified|needs-review|fabricated
- api/src/services/escalate.ts — REPURPOSED -> draft text-only dept email for a rule's escalation.team (was: route to stronger model). SIG: escalate(flag, rule, filename)
- api/src/routes/contracts.ts — POST /contracts: upload .txt -> ingest() -> chunk/embed/store (router mounted; body stubbed)
- api/src/routes/stream.ts — GET /stream?contractId= SSE: one `rule` event per rule (verdict+firewall status), final `done` summary (router mounted; body stubbed)
- NEW api/src/services/analyze.ts — shared pipeline entry analyze(contractId); cache-checks (contract_hash+playbook_version), else runs retrieve->flag->firewall->escalate per rule; feeds BOTH /analysis and /stream
- NEW api/src/routes/analysis.ts — GET /analysis?contractId= -> { contractId, playbookVersion, flags[], summary } structured JSON (first-class integration surface; cached/idempotent)

## NOT OURS (already exist — do not touch)
- data/playbook.saas.json
- data/contracts/*.txt

## Key decisions (see DECISIONS.md)
- HNSW cosine (empty-table-safe) over ivfflat
- raw_text untouched = firewall ground truth
- pgvector extension via initdb SQL; schema.ts owns tables + index
- TS moduleResolution: Bundler (no .js import friction live)
- ORM: Drizzle (already scaffolded) — single source of truth for schema/migrations, no hand-written SQL
- Testing: Vitest — native Vite/TS/ESM, one runner for api + web; firewall gets the highest-value unit coverage (grounded/paraphrase/fabricated fixtures)
- Embeddings: OpenAI text-embedding-3-small (1536-dim) — Anthropic has no embeddings API
- Chunking: split on section-header boundaries (regex), NOT fixed word-count+overlap — keeps a clause's meaning intact per chunk
- Per-rule retrieval: pgvector top-k is the LLM input; whole contract never sent per rule
- Firewall: deterministic substring (normalized) + cheap Claude judge -> verified|needs-review|fabricated; fabricated quarantined
- Middleware: CORS + JSON/body-parse + global error handler ONLY (no auth/rate-limit/logging in MVP)
- Two Claude tiers: stronger flagger, cheaper firewall judge
- Two result surfaces, one pipeline: SSE (live UI) + GET /analysis (structured JSON integration API); frontend has live-SSE / raw-payload toggle
- Analysis-result cache keyed on (contract_hash + playbook_version), 24h TTL -> short-circuits whole pipeline, makes /analysis idempotent (separate from embeddings cache)
- Full spec: SPEC.md

## BUILD ORDER (live)
seed -> chunk -> embed -> ingest -> wire upload -> retrieve -> flag -> firewall (+test) -> escalate -> analyze(+result cache) -> /analysis -> SSE -> frontend toggle

## NEXT
- Start at `seed`: read playbook.saas.json, insert into playbook_rules
