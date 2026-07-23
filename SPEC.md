# Playbook Guard — Scored Validation & Firewall Pipeline

Spec for the scored pipeline built on top of the existing plumbing skeleton (Docker Compose,
Drizzle schema, DB/Redis clients, `GET /playbook`, frontend shell, stubbed services). The
plumbing is assumed; this specs the pipeline on top of it.

## 1. Problem
Legal reviewers hand-check inbound SaaS contracts against Northwind's negotiating playbook —
slow, inconsistent, easy to miss a buried deviation. An LLM can flag deviations, but an LLM that
hallucinates a quote from a contract is worse than no tool: confident, ungrounded legal advice.
We need a per-rule analyzer whose every citation is mechanically proven to exist in the source
before a human — or an integrating system like GC's — ever sees it.

## 2. Goals
- Upload a `.txt` contract → chunk → embed → store in pgvector (one-time per contract, hash-deduped).
- For each of the 6 playbook rules: retrieve the most relevant contract section(s) via cosine
  search, judge **only** that section (`compliant` / `deviation` / `not-addressed`) with a cited quote.
- **Citation firewall** on every flag before display: (a) deterministic substring check that the
  quote exists verbatim in `raw_text`; (b) cheaper independent Claude pass confirming the quote
  supports the verdict. Label `verified` / `needs-review` / `fabricated`.
- Quarantine `fabricated` flags — never rendered as trustworthy.
- Draft a text-only notification email when a surfaced deviation hits a rule with an `escalation` team.
- Serve results on **two surfaces off one pipeline**: live SSE for the UI, and a structured JSON
  endpoint (`GET /analysis`) as a first-class integration API for outside consumers.
- Cache the full analysis result so identical inputs short-circuit the pipeline and return
  idempotently.
- Minimal frontend: upload, loading, per-rule verdict + firewall status, escalation email area with
  dummy send, readable playbook render, and a **live-SSE / raw-payload display toggle**.

## 3. Non-goals
- No PDF/DOCX (`.txt` only). No real email send. No auth / multi-user / rate limiting / request logging.
- No inter-clause reasoning (each rule judged against its own retrieved passages, not the whole contract).
- No auto-escalation to a stronger flagger model (`needs-review` surfaces to the human instead).
- No fallback-tier scoring beyond the three verdicts. One verdict per rule in MVP.
- No editing / negotiation-language suggestions.

## 4. Requirements
1. `POST /contracts` accepts one `.txt`, computes sha256; if `content_hash` exists, skip re-ingest
   and return the existing `contractId`.
2. Chunking: split `raw_text` on **section-header boundaries via regex** (e.g. `12.4`, `Section 12`,
   `ARTICLE X`), not fixed word-count + overlap, so a clause's meaning stays intact and the chunk is
   a byte-faithful source substring the firewall can match.
3. Embedding: OpenAI `text-embedding-3-small` (1536-dim); Redis-cached by `sha256(chunkText)`;
   batched per contract. (Anthropic has no embeddings API — embeddings are OpenAI, LLM is Claude.)
4. Seed: load `playbook.saas.json` into `playbook_rules` (one row per rule, `rule_id` unique).
5. Retrieval: embed a per-rule query built from `clause` + `preferred` + `hardStop`; cosine top-`k`
   (default `k=3`) over **that contract's** chunks only.
6. Flag: stronger Claude model judges the retrieved passages vs one rule →
   `{ ruleId, verdict, citedText, reasoning }`. `citedText` is an exact substring copied from a
   retrieved passage.
7. Firewall gate (runs on every non-`not-addressed` flag before display):
   - **7a deterministic:** normalized substring match (collapse whitespace, unify quote/dash chars on
     both sides) of `citedText` in `contract.raw_text`. Miss → `fabricated`.
   - **7b judge:** cheaper Claude model confirms the found quote supports the verdict →
     pass = `verified`, fail/uncertain = `needs-review`.
8. `fabricated` flags are stored but excluded from the trustworthy result set and rendered separately.
9. Escalation: for a rule with a non-null `escalation` and a surfaced deviation, `escalate()` drafts
   `"Flagging {filename} — {clause} to {team}: {one-line reason}. Please review."` — text only.
10. **`GET /analysis?contractId=`** returns the complete structured result as machine-consumable JSON
    (see §5) — the first-class integration surface for outside consumers, not just the UI.
11. **`GET /stream?contractId=`** (SSE) emits one event per rule as its verdict + firewall status
    resolves, plus a final `done` summary, so the UI fills in progressively. Same pipeline feeds both
    surfaces.
12. **Analysis-result cache:** the full result is cached keyed on `(contract_hash + playbook_version)`
    with a 24h TTL. A re-request against the same playbook version short-circuits the whole pipeline
    and returns the cached payload — making `GET /analysis` idempotent (same inputs → same output).
13. Frontend: upload → loading → per-rule rows (clause, verdict pill, firewall badge, cited quote),
    fabricated quarantined separately; escalation drafts in a textarea with a dummy "Send" (logs, no
    network); playbook rendered readably; a **display-mode toggle** between the live SSE view and the
    raw `GET /analysis` payload view — both off the same data — to make it obvious the endpoint is a
    real API and the UI is just one consumer.

## 5. Interface sketch
```
POST /contracts              body: multipart .txt
  → { contractId, filename, chunkCount, deduped }

GET  /analysis?contractId=1  (structured integration surface; cached, idempotent)
  → {
      contractId,
      playbookVersion,
      flags: [
        { ruleId, clause, verdict, citedText, firewallStatus, escalationDraft? }
      ],
      summary: { verified, needsReview, fabricated, escalations }
    }

GET  /stream?contractId=1    (SSE; live UI fill-in)
  event: rule   data: { ruleId, clause, verdict, firewallStatus, citedText, escalationDraft? }
  event: done   data: { verified, needsReview, fabricated, escalations }

GET  /playbook               → playbook JSON (exists)

chunk(rawText)                     → { chunkText, sectionLabel }[]   (section-boundary split)
embed(texts)                       → number[][]                      (Redis-cached)
ingest(filename, rawText)          → { contractId, chunkCount, deduped }
retrieve(query, k, contractId)     → { chunkId, chunkText, sectionLabel, distance }[]
flag(ruleId, contractId)           → { ruleId, verdict, citedText, reasoning, passageIds }
firewall(flag, rawText)            → { ...flag, firewallStatus, foundInSource }
escalate(flag, rule, filename)     → { team, draft } | null
analyze(contractId)                → full /analysis payload (cache-checked; feeds SSE + JSON)
```
> Signature changes from the stubs: `retrieve` gains `contractId`; `firewall` takes the structured
> flag (not an opaque verdict); `escalate` takes `(flag, rule, filename)` and drafts a dept email.
> `analyze(contractId)` is the shared pipeline entry that both `/analysis` and `/stream` call.

## 6. Edge cases
- **Quote whitespace / quote-char drift** → firewall normalizes both sides then requires exact
  substring; no fuzzy match. Near-miss = `fabricated`, not `verified`.
- **`not-addressed` verdict** → no citation expected; skip firewall, cannot escalate. Distinct from
  `fabricated`.
- **Weak / irrelevant retrieved chunks** → flagger may return `not-addressed`; low top-1 similarity is
  surfaced but does not by itself downgrade a firewall-`verified` flag.
- **Model cites a real quote but wrong verdict** → 7b judge catches the support mismatch → `needs-review`.
- **Duplicate upload** → dedup by hash, reuse chunks/embeddings; analysis still re-runs unless the
  analysis-result cache hits on `(contract_hash + playbook_version)`.
- **Playbook version bumped** → analysis-cache key changes → pipeline re-runs, old cache entry ages out.
- **Empty / garbage `.txt`** → reject at ingest with 400 if no extractable text.
- **`GET /analysis` before analysis has run** → run the pipeline on demand (cache-miss path), then cache
  and return; never return a partial payload.
- **LLM / API failure mid-run** → that rule carries `verdict: 'error'` on its SSE event and in the JSON
  flags; the run continues for other rules; a run with any `error` flag is not cached.

## 7. Open questions (with recommendations)
1. **`escalate()` repurposed.** Stub says "route low-confidence to a stronger model/human."
   **Rec:** repurpose to draft playbook-department emails (the actual feature); confidence routing is
   handled by the `needs-review` label surfaced to the human — no stronger-model auto-escalation in MVP.
2. **`firewall` / `retrieve` signatures.** **Rec:** widen `firewall(verdict, rawText)` →
   `firewall(flag, rawText)` and add `contractId` to `retrieve` so search is scoped per contract.
3. **Flag-level caching.** **Rec:** the analysis-result cache (`contract_hash + playbook_version`, 24h)
   is the primary short-circuit; embeddings cache by `sha256(chunkText)`. Firewall always re-runs on a
   cache-miss path (cheap, deterministic).
4. **`k` and chunk size.** **Rec:** start `k=3`, section-boundary chunks; tune against the 4 fidelity
   fixtures rather than guessing now. Revisit if a section exceeds the embedding token limit.
5. **Multiple deviating chunks per rule.** **Rec:** MVP judges the top-`k` as one passage set → one
   verdict per rule; multi-flag-per-rule deferred.

## 8. Stack & conventions
- **ORM:** Drizzle (scaffolded) — schema.ts is the single source of truth for tables + the HNSW cosine
  index; migrations generated from it, no hand-written SQL drift.
- **Testing:** Vitest — native to the Vite/TS/ESM stack, one runner for `api` + `web`. Highest-value
  target is the firewall: unit tests for grounded (verified) / paraphrased (needs-review) / absent
  (fabricated) quotes against `raw_text` fixtures, plus the 4 fidelity contracts as integration fixtures.
- **Embeddings:** OpenAI `text-embedding-3-small` (1536-dim). **LLM:** Claude, two tiers — stronger
  flagger, cheaper firewall judge.
- **Middleware:** CORS + JSON/body-parse + one global error handler only. No auth, rate limiting, or
  request logging in MVP.
- **Streaming:** live SSE, one `rule` event per rule + final `done`.

## 9. Build order (live)
`seed → chunk → embed → ingest → wire upload → retrieve → flag → firewall (+test) → escalate →
analyze (+ result cache) → /analysis → SSE → frontend toggle`
