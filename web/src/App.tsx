import { useState, useRef, useEffect } from "react";

// Read-only: lazy-fetch the DB-served playbook the first time the panel opens.
// Upload input + button wired to POST /contracts (ingest: chunk + embed + store).
const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

type IngestResult = {
  contractId: number;
  chunkCount: number;
  deduped: boolean;
};

type Escalation = { team?: string; trigger?: string };

type Rule = {
  id?: string;
  clause?: string;
  priority?: string;
  preferred?: string;
  escalation?: Escalation | null;
};

type Playbook = {
  name?: string;
  version?: string;
  agreementType?: string;
  perspective?: string;
  description?: string;
  rules?: Rule[];
};

// --- analysis pipeline (SSE /stream) ---
type FirewallStatus = "verified" | "needs-review" | "fabricated" | "not-applicable";

type EscalationEmail = {
  id: string;
  ruleId: string;
  team: string;
  subject: string;
  body: string;
};

type RuleResult = {
  ruleId: string;
  clause: string;
  priority: string | null;
  verdict: "compliant" | "deviation" | "not-addressed";
  reasoning: string;
  citedSpan: string;
  topSimilarity: number;
  coverageHit: boolean;
  firewall: {
    status: FirewallStatus;
    grounded: boolean;
    supportsVerdict: boolean | null;
    reasoning: string;
  };
  escalation: EscalationEmail | null;
};

type AnalysisMeta = {
  contractId: number;
  filename: string;
  playbookVersion: string;
  escalations: EscalationEmail[];
  summary: {
    ruleCount: number;
    coverage: { covered: number; total: number };
    verdicts: { compliant: number; deviation: number; notAddressed: number };
    firewall: { verified: number; needsReview: number; fabricated: number; notApplicable: number };
    escalationCount: number;
  };
  cached: boolean;
  generatedAt: string;
};

const pillBase = {
  padding: "0.1rem 0.5rem",
  borderRadius: "999px",
  fontSize: "0.72rem",
  fontWeight: 600,
} as const;

const verdictStyle = (v: string) =>
  v === "compliant"
    ? { background: "#e6f4ea", color: "#1e7e34" }
    : v === "deviation"
      ? { background: "#fdecea", color: "#c0392b" }
      : { background: "#eef0f2", color: "#5f6b7a" };

const fwStyle = (s: FirewallStatus) =>
  s === "verified"
    ? { background: "#e6f4ea", color: "#1e7e34" }
    : s === "needs-review"
      ? { background: "#fff4e5", color: "#b26a00" }
      : s === "fabricated"
        ? { background: "#fdecea", color: "#c0392b" }
        : { background: "#eef0f2", color: "#5f6b7a" };

const escBtnBase = {
  padding: "0.4rem 0.95rem",
  borderRadius: 6,
  fontSize: "0.8rem",
  fontWeight: 600,
  cursor: "pointer",
} as const;
const sendBtnStyle = { ...escBtnBase, background: "#2f6feb", color: "#fff", border: "none" };
const denyBtnStyle = {
  ...escBtnBase,
  background: "#fff",
  color: "#c0392b",
  border: "1px solid #e4b6b1",
};

export default function App() {
  const [playbook, setPlaybook] = useState<Playbook | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Upload / ingest state.
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [ingest, setIngest] = useState<IngestResult | null>(null);
  const [ingestError, setIngestError] = useState<string | null>(null);

  // Analysis (SSE) state.
  const [analyzing, setAnalyzing] = useState(false);
  const [flags, setFlags] = useState<RuleResult[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisMeta | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  // Close any open stream on unmount.
  useEffect(() => () => esRef.current?.close(), []);

  function startAnalysis(contractId: number) {
    esRef.current?.close();
    setFlags([]);
    setAnalysis(null);
    setAnalysisError(null);
    setAnalyzing(true);

    // Same analyze() pipeline as GET /analysis, but streamed: one `rule` event per rule as it
    // lands, then a final `done` event with the aggregate meta. Close on done/error so the
    // browser's EventSource does not auto-reconnect and re-run the analysis.
    const es = new EventSource(`${API_URL}/stream?contractId=${contractId}`);
    esRef.current = es;

    es.addEventListener("rule", (e) => {
      const rule = JSON.parse((e as MessageEvent).data) as RuleResult;
      setFlags((prev) => [...prev, rule]);
    });
    es.addEventListener("done", (e) => {
      setAnalysis(JSON.parse((e as MessageEvent).data) as AnalysisMeta);
      setAnalyzing(false);
      es.close();
    });
    es.addEventListener("error", (e) => {
      const data = (e as MessageEvent).data;
      let msg = "stream connection error";
      if (data) {
        try {
          msg = JSON.parse(data).error;
        } catch {
          msg = "stream error";
        }
      }
      setAnalysisError(msg);
      setAnalyzing(false);
      es.close();
    });
  }

  // Raw-JSON view: fetch the SAME data from the real GET /analysis endpoint (a separate API
  // call, NOT the accumulated SSE) — proves the endpoint is a real API, not UI-coupled.
  const [viewMode, setViewMode] = useState<"live" | "json">("live");
  const [rawJson, setRawJson] = useState<unknown>(null);
  const [rawLoading, setRawLoading] = useState(false);
  const [rawError, setRawError] = useState<string | null>(null);
  // Per-email demo action (Send/Deny are inert — no email is ever delivered).
  const [emailActions, setEmailActions] = useState<Record<string, "sent" | "denied">>({});

  async function fetchRawAnalysis(contractId: number) {
    setRawLoading(true);
    setRawError(null);
    try {
      const res = await fetch(`${API_URL}/analysis?contractId=${contractId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setRawJson(data);
    } catch (err) {
      setRawError(err instanceof Error ? err.message : String(err));
    } finally {
      setRawLoading(false);
    }
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setFile(e.target.files?.[0] ?? null);
    setIngest(null);
    setIngestError(null);
  }

  async function uploadContract() {
    if (!file) return;
    setUploading(true);
    setIngest(null);
    setIngestError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`${API_URL}/contracts`, { method: "POST", body });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setIngest(data as IngestResult);
    } catch (err) {
      setIngestError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  function loadPlaybook() {
    setLoading(true);
    setError(null);
    fetch(`${API_URL}/playbook`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: Playbook) => setPlaybook(data))
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }

  function togglePlaybook() {
    const opening = !open;
    setOpen(opening);
    // Fetch once, on first open. If a prior attempt errored, reopening retries.
    if (opening && playbook === null && !loading) {
      loadPlaybook();
    }
  }

  const rules = playbook?.rules ?? [];

  return (
    <div className="app">
      <header className="app__header">
        <h1>Playbook Guard</h1>
        <p className="app__subtitle">Check a contract against the playbook.</p>
      </header>

      {/* Playbook — read-only, fetched on mount; collapsed by default */}
      <section className="playbook">
        <button
          type="button"
          className="playbook__toggle"
          aria-expanded={open}
          onClick={togglePlaybook}
        >
          <span className="playbook__caret" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          Playbook
        </button>

        {open && (
          <div className="playbook__body">
            {loading && <p className="playbook__status">Loading playbook…</p>}
            {error && (
              <p className="playbook__status playbook__status--error">
                Failed to load playbook: {error}
              </p>
            )}

            {!loading && !error && playbook && (
              <>
                <div className="playbook__meta">
              {playbook.name && (
                <h3 className="playbook__name">{playbook.name}</h3>
              )}
              <dl className="playbook__envelope">
                {playbook.version && (
                  <div className="playbook__field">
                    <dt>Version</dt>
                    <dd>{playbook.version}</dd>
                  </div>
                )}
                {playbook.agreementType && (
                  <div className="playbook__field">
                    <dt>Agreement type</dt>
                    <dd>{playbook.agreementType}</dd>
                  </div>
                )}
                {playbook.perspective && (
                  <div className="playbook__field">
                    <dt>Perspective</dt>
                    <dd>{playbook.perspective}</dd>
                  </div>
                )}
              </dl>
            </div>

            <ul className="rules">
              {rules.map((rule, i) => (
                <li className="rule" key={rule.id ?? i}>
                  <div className="rule__head">
                    <span className="rule__clause">
                      {rule.clause ?? "Untitled clause"}
                    </span>
                    {rule.id && <span className="rule__id">{rule.id}</span>}
                    {rule.priority && (
                      <span className="rule__priority">{rule.priority}</span>
                    )}
                  </div>
                  {rule.preferred && (
                    <p className="rule__preferred">
                      <span className="rule__label">Preferred position</span>
                      {rule.preferred}
                    </p>
                  )}
                </li>
              ))}
            </ul>
              </>
            )}
          </div>
        )}
      </section>

      {/* Controls — upload a .txt contract -> POST /contracts (ingest) */}
      <section className="controls">
        <input
          className="controls__file"
          type="file"
          accept=".txt,text/plain"
          onChange={onFileChange}
          disabled={uploading}
        />
        <button
          className="controls__check"
          type="button"
          onClick={uploadContract}
          disabled={!file || uploading}
        >
          {uploading ? "Ingesting…" : "Upload & ingest"}
        </button>
      </section>

      {/* Results — ingest outcome (analysis pipeline wired later) */}
      <section className="results">
        {ingestError && (
          <p className="results__empty results__empty--error">
            Ingest failed: {ingestError}
          </p>
        )}

        {!ingestError && ingest && (
          <div className="ingest">
            <div className="ingest__head">
              <span
                className={`verdict-pill ${
                  ingest.deduped ? "verdict-pill--warn" : "verdict-pill--pass"
                }`}
              >
                {ingest.deduped ? "Dedup" : "Ingested"}
              </span>
              <span className="ingest__file">{file?.name}</span>
            </div>
            <dl className="ingest__stats">
              <div className="ingest__stat">
                <dt>Contract ID</dt>
                <dd>{ingest.contractId}</dd>
              </div>
              <div className="ingest__stat">
                <dt>Chunks</dt>
                <dd>{ingest.chunkCount}</dd>
              </div>
              <div className="ingest__stat">
                <dt>Status</dt>
                <dd>
                  {ingest.deduped
                    ? "already ingested — reused existing chunks"
                    : "new — chunked & embedded into pgvector"}
                </dd>
              </div>
            </dl>
          </div>
        )}

        {!ingestError && !ingest && (
          <p className="results__empty">
            No contract ingested yet. Choose a .txt and upload.
          </p>
        )}

        {/* Analysis — stream per-rule verdicts via SSE /stream */}
        {ingest && (
          <div className="analysis" style={{ marginTop: "1rem" }}>
            {/* Two display modes off the SAME analyze() data: the live SSE stream, or the raw
                GET /analysis JSON fetched as a real, separate API call (not UI-coupled). */}
            <div
              className="analysis__toggle"
              style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}
            >
              <button
                type="button"
                onClick={() => setViewMode("live")}
                aria-pressed={viewMode === "live"}
                style={{ fontWeight: viewMode === "live" ? 700 : 400 }}
              >
                Live (SSE)
              </button>
              <button
                type="button"
                onClick={() => {
                  setViewMode("json");
                  if (!rawJson && !rawLoading) fetchRawAnalysis(ingest.contractId);
                }}
                aria-pressed={viewMode === "json"}
                style={{ fontWeight: viewMode === "json" ? 700 : 400 }}
              >
                Raw JSON (GET /analysis)
              </button>
            </div>

            {viewMode === "live" && (
              <>
                <button
                  className="controls__check"
                  type="button"
                  onClick={() => startAnalysis(ingest.contractId)}
                  disabled={analyzing}
                >
                  {analyzing ? "Analyzing…" : "Analyze against playbook"}
                </button>

            {analysisError && (
              <p className="results__empty results__empty--error">
                Analysis failed: {analysisError}
              </p>
            )}

            {analysis && (
              <p className="analysis__summary" style={{ marginTop: "1rem" }}>
                Coverage {analysis.summary.coverage.covered}/{analysis.summary.coverage.total} · verified{" "}
                {analysis.summary.firewall.verified} · needs-review {analysis.summary.firewall.needsReview} ·
                fabricated {analysis.summary.firewall.fabricated} · n/a{" "}
                {analysis.summary.firewall.notApplicable}
                {analysis.cached ? " · (cached)" : ""}
              </p>
            )}

            {/* Analysis (left, flexible) and escalation emails (right, narrower) side by side */}
            <div
              style={{
                display: "flex",
                gap: "0.6rem",
                alignItems: "flex-start",
                flexWrap: "wrap",
                marginTop: "1rem",
              }}
            >
              {flags.length > 0 && (
                <ul className="rules" style={{ flex: "1 1 380px", minWidth: 0, margin: 0 }}>
                  {flags.map((f) => (
                    <li className="rule" key={f.ruleId}>
                      <div
                        className="rule__head"
                        style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}
                      >
                        <span className="rule__clause">{f.clause}</span>
                        <span style={{ ...pillBase, ...verdictStyle(f.verdict) }}>{f.verdict}</span>
                        <span
                          style={{ ...pillBase, ...fwStyle(f.firewall.status) }}
                          title={f.firewall.reasoning}
                        >
                          grounding: {f.firewall.status}
                        </span>
                        {f.escalation && (
                          <span style={{ ...pillBase, background: "#eae6f7", color: "#5b3fa8" }}>
                            escalate → {f.escalation.team}
                          </span>
                        )}
                      </div>
                      {f.firewall.grounded && f.citedSpan && (
                        <p className="rule__preferred">
                          <span className="rule__label">Cited span</span>“{f.citedSpan}”
                        </p>
                      )}
                      <p className="rule__preferred">
                        <span className="rule__label">Reasoning</span>
                        {f.reasoning}
                      </p>
                    </li>
                  ))}
                </ul>
              )}

              {analysis && analysis.escalations.length > 0 && (
                <div className="escalations" style={{ flex: "0 1 420px", minWidth: 0 }}>
                  <h4 style={{ margin: "0 0 0.6rem", fontSize: "0.9rem", color: "#38414d" }}>
                    Escalation drafts ({analysis.escalations.length})
                  </h4>
                  {analysis.escalations.map((em) => {
                    const action = emailActions[em.id];
                    return (
                      <div
                        key={em.id}
                        style={{
                          border: "1px solid #e3e6ea",
                          borderRadius: 10,
                          marginBottom: "0.75rem",
                          background: "#fbfcfd",
                          overflow: "hidden",
                        }}
                      >
                        {/* header */}
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "0.5rem",
                            padding: "0.6rem 0.75rem",
                            borderBottom: "1px solid #edeff2",
                            background: "#f4f2fb",
                          }}
                        >
                          <span aria-hidden="true">✉️</span>
                          <span style={{ ...pillBase, background: "#eae6f7", color: "#5b3fa8" }}>
                            {em.team}
                          </span>
                        </div>

                        <div style={{ padding: "0.7rem 0.75rem" }}>
                          {/* meta */}
                          <div style={{ fontSize: "0.8rem", lineHeight: 1.5 }}>
                            <div>
                              <span style={{ color: "#8a94a2" }}>To:</span> {em.team}
                            </div>
                            <div style={{ fontWeight: 600, color: "#38414d" }}>{em.subject}</div>
                          </div>

                          {/* body */}
                          <div
                            style={{
                              whiteSpace: "pre-wrap",
                              fontSize: "0.8rem",
                              lineHeight: 1.55,
                              color: "#4a545f",
                              background: "#fff",
                              border: "1px solid #eceef1",
                              borderRadius: 8,
                              padding: "0.6rem 0.7rem",
                              margin: "0.6rem 0",
                              maxHeight: 200,
                              overflowY: "auto",
                            }}
                          >
                            {em.body}
                          </div>

                          {/* actions — active buttons, but inert (nothing is sent) */}
                          {action ? (
                            <p style={{ fontSize: "0.78rem", color: "#8a94a2", margin: 0 }}>
                              {action === "sent" ? "✓ Marked sent" : "✕ Denied"} — demo only, no
                              email was delivered.
                            </p>
                          ) : (
                            <div style={{ display: "flex", gap: "0.5rem" }}>
                              <button
                                type="button"
                                style={sendBtnStyle}
                                title="Demo — no email is actually sent"
                                onClick={() =>
                                  setEmailActions((prev) => ({ ...prev, [em.id]: "sent" }))
                                }
                              >
                                Send
                              </button>
                              <button
                                type="button"
                                style={denyBtnStyle}
                                title="Demo — nothing is sent"
                                onClick={() =>
                                  setEmailActions((prev) => ({ ...prev, [em.id]: "denied" }))
                                }
                              >
                                Deny
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
              </>
            )}

            {viewMode === "json" && (
              <div className="analysis__json">
                <p style={{ fontSize: "0.8rem", color: "#5f6b7a", margin: "0 0 0.5rem" }}>
                  <code>
                    GET {API_URL}/analysis?contractId={ingest.contractId}
                  </code>
                </p>
                <button
                  type="button"
                  onClick={() => fetchRawAnalysis(ingest.contractId)}
                  disabled={rawLoading}
                >
                  {rawLoading ? "Fetching…" : rawJson ? "Re-fetch /analysis" : "GET /analysis"}
                </button>
                {rawError && (
                  <p className="results__empty results__empty--error">Fetch failed: {rawError}</p>
                )}
                {rawJson != null && (
                  <pre
                    style={{
                      marginTop: "0.75rem",
                      padding: "0.75rem",
                      background: "#1e1e1e",
                      color: "#e6e6e6",
                      borderRadius: 8,
                      overflowX: "auto",
                      fontSize: "0.75rem",
                      maxHeight: "480px",
                    }}
                  >
                    {JSON.stringify(rawJson, null, 2)}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
