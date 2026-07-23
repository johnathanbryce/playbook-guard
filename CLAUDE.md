# Playbook Guard — master tracker

Succinct bullet tracker of status + high-level notes. Keep updated as we progress.

## Stack
- Frontend: React + Vite (TS)
- Backend: Express 5 (TS, run via tsx)
- DB: Postgres 16 + pgvector, Drizzle ORM (node-postgres driver)
- Cache: Redis via ioredis
- Orchestration: Docker Compose (postgres, redis, api, web)
- LLM SDKs: OpenAI embeddings via `ai` + `@ai-sdk/openai` (v4 line); Claude (flag+firewall) via OFFICIAL `@anthropic-ai/sdk` (0.113.0) — NOT `@ai-sdk/anthropic` (v4 provider sends deprecated `temperature` that claude-sonnet-5 rejects; the fix needs AI SDK v5). `@ai-sdk/anthropic` pinned ^1.2.12, effectively unused.

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
- api/src/services/retrieve.ts — DONE: generic `retrieve(query, {contractId, k=3})`; embed(query) -> cosineDistance(`<=>`, HNSW-matched) top-k WHERE contract_id; returns {chunkId, chunkText, sectionLabel, distance, similarity}. No threshold (flag decides not-addressed)
- api/src/services/rule-query.ts — DONE: `ruleToQuery(rule)` = clause + preferred (generic retriever stays playbook-agnostic)
- Retrieval eval (contract #1): all 6 rules retrieve expected section at rank #1 (sim 0.72–0.85); service-levels-termination + auto-renewal-pricing correctly surface their 2nd relevant section at #2
- data/fixtures/offtopic-nda.txt (OURS — original data/contracts/ left pristine): deliberately off-topic mutual NDA for floor/coverage tuning. Full-corpus eval (4 real + NDA) measured; floor LOCKED at 0.35 (degenerate-retrieval backstop only — off-topic band is 0.35–0.48 so it ~never fires; LLM owns not-addressed), coverage bar LOCKED at 0.70 (the real off-topic detector: off-topic 0/6 vs real 3–6/6). Numbers + matrix in DECISIONS
- api/src/services/claude.ts — DONE: shared Anthropic client (official @anthropic-ai/sdk, reads ANTHROPIC_API_KEY) + FLAGGER_MODEL=claude-sonnet-5. Reused by flag/firewall/escalate
- api/src/services/flag.ts — DONE: flag(ruleId, contractId) loads rule -> retrieve(ruleToQuery, top-3) -> FLOOR 0.35 short-circuit to not-addressed w/o LLM (else) forced-tool-use judge (claude-sonnet-5, record_verdict tool, tool_choice forced, NO thinking/temperature) w/ top-1 sim as confidence hint -> {ruleId, clause, verdict, citedText (verbatim, ""→not-addressed), reasoning, topSimilarity, shortCircuited, passages[]}. Output shape designed for firewall (verbatim citation). Live-verified 6 cases across fidelity ladder + NDA: compliant/deviation/not-addressed all correct, citations GROUNDED (normalized substring in raw_text), off-topic NDA -> not-addressed via LLM (all sims >0.35 so floor never fired — validates the tuning). Typecheck clean in container
- web — upload WIRED: file input (.txt) + "Upload & ingest" button -> POST /contracts (FormData field "file"); busy state ("Ingesting…"), ingest result card (contractId / chunkCount / new-vs-Dedup pill), error line. Analysis results list still pending (needs analyze+SSE)
- web — playbook render (display plumbing): App.tsx fetches GET /playbook on mount, renders envelope meta + rules (clause/id/priority/preferred) read-only, w/ loading + error states
- package.json + tsconfig for api & web; drizzle.config.ts; Dockerfiles; .env.example
- npm install run in both api/ and web/

## STUBBED (throw TODO(John) — John implements live)
- api/src/services/firewall.ts — HARD GATE, core of product. SIG CHANGE -> firewall(flag, rawText). (a) deterministic normalized-substring check of citedText in raw_text; (b) cheaper Claude judge confirms quote supports verdict -> verified|needs-review|fabricated. Note: flag already emits verbatim citedText and the normalized-substring preview passed GROUNDED on all cited smoke cases.  <-- NEXT
- api/src/services/escalate.ts — REPURPOSED -> draft text-only dept email for a rule's escalation.team (was: route to stronger model). SIG: escalate(flag, rule, filename)
- api/src/routes/contracts.ts — POST /contracts: upload .txt -> ingest() -> chunk/embed/store (router mounted; body stubbed)
- api/src/routes/stream.ts — GET /stream?contractId= SSE: one `rule` event per rule (verdict+firewall status), final `done` summary (router mounted; body stubbed)
- NEW api/src/services/analyze.ts — shared pipeline entry analyze(contractId); cache-checks (contract_hash+playbook_version), else runs retrieve->flag->firewall->escalate per rule; feeds BOTH /analysis and /stream. ADD coverage metric: count rules w/ confident on-topic match (top-1 sim >= ~0.7) -> summary.coverage e.g. "0/6" flags a wholly non-matching upload
- NEW api/src/routes/analysis.ts — GET /analysis?contractId= -> { contractId, playbookVersion, flags[], summary } structured JSON (first-class integration surface; cached/idempotent)
- ~~TUNE floor + coverage against all 4 fixtures + off-topic fixture~~ DONE: floor LOCKED 0.35, coverage bar LOCKED 0.70 (see DECISIONS retrieval [AMENDED] for the top-1 matrix)

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
~~seed -> chunk -> embed -> ingest -> wire upload -> retrieve -> flag~~ -> firewall (+test) -> escalate -> analyze(+result cache) -> /analysis -> SSE -> frontend toggle

## NEXT
- `firewall(flag, rawText)`: (a) deterministic normalized-substring check of flag.citedText in raw_text (collapse whitespace, unify quote/dash chars, exact substring — near-miss = fabricated); (b) cheaper independent Claude judge confirms the quote supports the verdict -> verified | needs-review | fabricated. Only runs for flags with a citation (compliant/deviation); not-addressed has none. Highest-value Vitest target (grounded/paraphrase/fabricated fixtures). Decide the cheaper judge model (claude-haiku-4-5 candidate) w/ John first — the "two tiers" decision
