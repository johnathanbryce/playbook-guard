// Static shell only: markup + CSS so the layout exists.
// NO state, NO fetch, NO event wiring — John adds that live.
export default function App() {
  return (
    <div className="app">
      <header className="app__header">
        <h1>Playbook Guard</h1>
        <p className="app__subtitle">Check a contract against the playbook.</p>
      </header>

      <section className="controls">
        <input className="controls__file" type="file" />
        <button className="controls__check" type="button">
          Check contract
        </button>
      </section>

      <section className="results">
        {/* Results render here. Empty for now. One .result per rule. */}
        <ul className="results__list">
          {/* Example row markup (kept for styling reference):
          <li className="result">
            <span className="result__rule">rule-id</span>
            <span className="verdict-pill verdict-pill--pass">Pass</span>
            <span className="grounding-badge grounding-badge--grounded">Grounded</span>
            <p className="result__detail">Detail text.</p>
          </li>
          */}
        </ul>
        <p className="results__empty">No results yet.</p>
      </section>
    </div>
  );
}
