import { useState } from "react";

// Read-only: lazy-fetch the file-served playbook the first time the panel opens.
// Upload input + "Check contract" button remain dead (wired live by John).
const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

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

export default function App() {
  const [playbook, setPlaybook] = useState<Playbook | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

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

      {/* Controls — dead markup, wired live by John */}
      <section className="controls">
        <input className="controls__file" type="file" />
        <button className="controls__check" type="button">
          Check contract
        </button>
      </section>

      {/* Results — empty for now. One .result per rule. */}
      <section className="results">
        <ul className="results__list"></ul>
        <p className="results__empty">No results yet.</p>
      </section>
    </div>
  );
}
