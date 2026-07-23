// Split a contract's raw_text into labeled, retrievable chunks — ONE chunk per
// top-level contract section (never split a section), so each section is embedded
// and retrieved as a single unit that lines up with a playbook clause.
export type ContractChunk = { chunkText: string; sectionLabel: string | null };

// Top-level section headers look like `6. DATA PROCESSING AND PRIVACY`: a number,
// a dot, whitespace, then an ALL-CAPS title alone on the line. Sub-clauses (`6.1 ...`)
// have a digit immediately after the dot, so `\.[ \t]+` never matches them. Kept
// deliberately strict (uppercase title) so a wrapped clause line can't be mistaken
// for a section boundary. This is section-boundary splitting, NOT word-count/overlap.
const SECTION_HEADER = /^(\d{1,2})\.[ \t]+([A-Z][A-Z0-9 ,;:&()/'\-]{2,})[ \t]*$/gm;

export function chunk(rawText: string): ContractChunk[] {
  const headers: { index: number; label: string }[] = [];
  for (const m of rawText.matchAll(SECTION_HEADER)) {
    headers.push({ index: m.index, label: `${m[1]}. ${m[2].trim()}` });
  }

  // No recognizable sections -> whole document is one chunk. Never silently drop text.
  if (headers.length === 0) {
    const text = rawText.trim();
    return text ? [{ chunkText: text, sectionLabel: null }] : [];
  }

  const chunks: ContractChunk[] = [];

  // Preamble: title line / recitals before the first numbered section. Captured so
  // no source text is unretrievable, even though it rarely maps to a playbook rule.
  const preamble = rawText.slice(0, headers[0].index).trim();
  if (preamble) chunks.push({ chunkText: preamble, sectionLabel: "Preamble" });

  // One chunk per section: from its header through the byte before the next header.
  // Slices are verbatim substrings of raw_text (only outer whitespace trimmed), so a
  // quote taken from a chunk is still found byte-for-byte by the citation firewall.
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].index;
    const end = i + 1 < headers.length ? headers[i + 1].index : rawText.length;
    const chunkText = rawText.slice(start, end).trim();
    if (chunkText) chunks.push({ chunkText, sectionLabel: headers[i].label });
  }

  return chunks;
}
