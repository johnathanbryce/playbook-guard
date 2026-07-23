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
- api/src/db/schema.ts — contracts, chunks (+HNSW cosine index), playbook_rules, playbooks (NEW: envelope meta + version; unique(name,version))
- api/src/db/client.ts — Drizzle over pg Pool (DATABASE_URL)
- api/src/cache/redis.ts — ioredis (REDIS_URL)
- api/src/index.ts — Express + CORS + JSON; GET /health inline; mounts playbook + contracts + stream routers
- api/src/routes/playbook.ts — GET /playbook NOW DB-BACKED: latest playbooks.meta + playbook_rules (insertion order) -> reconstructed envelope; 404 w/ hint if unseeded
- api/src/services/seed.ts — DONE: upserts playbooks (envelope, keyed name+version) + playbook_rules (one row/rule, keyed rule_id); idempotent; returns {version, ruleCount}
- api/src/scripts/seed.ts + `npm run db:seed` — CLI runner (seeds then closes pool); tables created via `npm run db:push`
- DB seeded: playbook v1.1.0, 6 rules (verified via GET /playbook)
- api/src/services/chunk.ts — DONE: regex on ALL-CAPS section headers (`N. TITLE`); ONE chunk per top-level section (sub-clauses stay together, never split); preamble captured; slices verbatim from raw_text (byte-faithful for firewall). Returns {chunkText, sectionLabel}[]. Verified: 11–15 chunks/contract across all 4, all byte-faithful, largest ~350 tokens
- api/src/services/embed.ts — DONE: OpenAI text-embedding-3-small (1536-dim) via ai/embedMany; Redis cache `emb:<model>:<sha256(text)>`, 30d TTL, mget-then-batch-misses, order preserved. Live-verified: real call -> dim 1536, 2nd call 1ms cache hit w/ identical vectors
- Pre-flight PASSED: OPENAI_API_KEY durable in root .env, compose-interpolated, present in running container (len 164); ai + @ai-sdk/openai present in container (NOT host node_modules -> run/typecheck embed in container)
- api/src/services/ingest.ts — DONE: sha256(rawText) dedup (hit -> reuse contract+chunks, skip chunk/embed) -> store contract -> chunk() -> embed() -> batch-insert chunk rows w/ 1536-dim embeddings. Returns {contractId, chunkCount, deduped}
- api/src/routes/contracts.ts — DONE: POST /contracts, multer memoryStorage (5MB), field "file"; .txt-only (mimetype OR ext), 400 empty/no-file, 415 non-txt; 201 fresh / 200 dedup. Verified: upload high-fidelity -> 15 chunks stored (dim 1536); re-upload -> deduped:true, chunk+embed skipped
- Vitest testing: host-only devDep; tsconfig excludes **/*.test.ts so container `tsc --noEmit` stays clean (tests run on host via `npm test`)
- curl verify: `curl -s -X POST http://localhost:3001/contracts -F "file=@data/contracts/contract-high-fidelity.txt"`
- web — static shell: upload input, Check button, empty results list w/ verdict-pill + grounding-badge markup + CSS (upload/Check still NO wiring)
- web — playbook render (display plumbing): App.tsx fetches GET /playbook on mount, renders envelope meta + rules (clause/id/priority/preferred) read-only, w/ loading + error states
- package.json + tsconfig for api & web; drizzle.config.ts; Dockerfiles; .env.example
- npm install run in both api/ and web/

## STUBBED (throw TODO(John) — John implements live)
- api/src/services/retrieve.ts — cosine top-k over chunks; SIG CHANGE -> add contractId filter (scope search to one contract)  <-- NEXT
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
~~seed~~ -> chunk -> embed -> ingest -> wire upload -> retrieve -> flag -> firewall (+test) -> escalate -> analyze(+result cache) -> /analysis -> SSE -> frontend toggle

## NEXT
- `retrieve`: embed a per-rule query (clause+preferred+hardStop), pgvector cosine top-k over chunks WHERE contract_id = ? (scope to one contract); order by embedding <=> query
