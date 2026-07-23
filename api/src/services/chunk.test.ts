import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chunk } from "./chunk";

// Real contract fixtures checked into the repo (low..high fidelity + partial).
const contractsDir = fileURLToPath(
  new URL("../../../data/contracts", import.meta.url),
);
const read = (name: string) =>
  readFileSync(`${contractsDir}/${name}`, "utf8");

const FIXTURES = [
  "contract-high-fidelity.txt",
  "contract-medium-fidelity.txt",
  "contract-low-fidelity.txt",
  "contract-partial.txt",
] as const;

describe("chunk() against real contract fixtures", () => {
  // The load-bearing invariant: chunks are verbatim slices of raw_text, so a quote
  // lifted from a chunk is still found byte-for-byte by the citation firewall.
  it.each(FIXTURES)(
    "every chunk of %s is a verbatim substring of raw_text",
    (name) => {
      const raw = read(name);
      const chunks = chunk(raw);
      expect(chunks.length).toBeGreaterThan(0);
      for (const c of chunks) {
        expect(raw).toContain(c.chunkText);
      }
    },
  );

  // Sub-clauses (6.1, 6.2, ...) must never become their own chunk — a section is one unit.
  it.each(FIXTURES)(
    "no chunk of %s is labeled as a sub-clause (N.M)",
    (name) => {
      const labels = chunk(read(name)).map((c) => c.sectionLabel);
      for (const label of labels) {
        expect(label).not.toMatch(/^\d+\.\d+/);
      }
    },
  );

  it("splits the high-fidelity contract into a preamble + 14 sections (15 chunks)", () => {
    const chunks = chunk(read("contract-high-fidelity.txt"));
    expect(chunks).toHaveLength(15);
  });

  it("splits the partial contract into a preamble + 10 sections (11 chunks)", () => {
    const chunks = chunk(read("contract-partial.txt"));
    expect(chunks).toHaveLength(11);
  });

  it("captures the leading title/recitals as a Preamble chunk", () => {
    const chunks = chunk(read("contract-high-fidelity.txt"));
    expect(chunks[0].sectionLabel).toBe("Preamble");
    expect(chunks[0].chunkText).toContain("MASTER SUBSCRIPTION AGREEMENT");
  });

  it("keeps a whole section together — the DPA chunk holds all its sub-clauses", () => {
    const chunks = chunk(read("contract-high-fidelity.txt"));
    const dpa = chunks.find((c) =>
      c.sectionLabel === "6. DATA PROCESSING AND PRIVACY",
    );
    expect(dpa).toBeDefined();
    // 6.1 through 6.4 all live inside the single section chunk.
    expect(dpa!.chunkText).toContain("6.1");
    expect(dpa!.chunkText).toContain("6.4");
  });

  it("recognizes headers whose title contains punctuation", () => {
    const labels = chunk(read("contract-high-fidelity.txt")).map(
      (c) => c.sectionLabel,
    );
    expect(labels).toContain("7. AI FEATURES; TRAINING AND OUTPUT RIGHTS");
  });

  it("emits section chunks in ascending document order", () => {
    const nums = chunk(read("contract-high-fidelity.txt"))
      .map((c) => c.sectionLabel)
      .filter((l): l is string => !!l && l !== "Preamble")
      .map((l) => parseInt(l, 10));
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
  });
});

describe("chunk() edge cases", () => {
  it("returns [] for an empty string", () => {
    expect(chunk("")).toEqual([]);
  });

  it("returns [] for whitespace-only input", () => {
    expect(chunk("   \n\t  \n")).toEqual([]);
  });

  it("returns one null-labeled chunk when there are no recognizable sections", () => {
    const prose = "This is just some prose with no numbered ALL-CAPS headings.";
    const chunks = chunk(prose);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].sectionLabel).toBeNull();
    expect(chunks[0].chunkText).toBe(prose);
  });

  it("does not treat sub-clause lines as section boundaries", () => {
    const raw = "1. INTRO\n1.1 first point\n1.2 second point";
    const chunks = chunk(raw);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].sectionLabel).toBe("1. INTRO");
    expect(chunks[0].chunkText).toContain("1.1 first point");
    expect(chunks[0].chunkText).toContain("1.2 second point");
  });

  it("does not treat a mixed-case numbered heading as a section header", () => {
    // Strictness: only ALL-CAPS titles are section headers, so this stays whole.
    const raw = "1. Some introductory heading\nbody text here";
    const chunks = chunk(raw);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].sectionLabel).toBeNull();
  });

  it("trims outer whitespace from every chunk", () => {
    const chunks = chunk(read("contract-medium-fidelity.txt"));
    for (const c of chunks) {
      expect(c.chunkText).toBe(c.chunkText.trim());
    }
  });
});
