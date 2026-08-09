// Fixtures for the mention tests.
//
// The reader is injected into resolveMentions precisely so this file can exist:
// the module never imports api.ts, never touches Tauri and never reads a real
// disk, so every budget and confinement case below is exercised on material
// the test wrote itself.
//
// The fake lives here rather than beside the interface in src/ on purpose.
// `MentionReader` has exactly one method and no invariants to keep in sync, so
// there is nothing for a co-located reference implementation to protect, and
// keeping it out of src/ keeps it out of the shipped bundle.

import type { MentionCandidate, MentionReader } from "../../src/mentions.js";

/** Counts reads so a test can prove the same file is not read twice. */
export class FakeReader implements MentionReader {
  readonly reads: string[] = [];

  constructor(private readonly files: Record<string, string>) {}

  async read(rel: string): Promise<string | null> {
    this.reads.push(rel);
    return Object.prototype.hasOwnProperty.call(this.files, rel) ? this.files[rel] : null;
  }
}

/** A reader whose every call rejects, like a Tauri command that failed. */
export class ThrowingReader implements MentionReader {
  async read(rel: string): Promise<string | null> {
    throw new Error(`boom on ${rel}`);
  }
}

/** `n` numbered lines, so a test can name the exact line it expects to see. */
export function numberedLines(n: number, tag = "line"): string {
  const out: string[] = [];
  for (let i = 1; i <= n; i++) out.push(`${tag} ${i} filler filler filler`);
  return out.join("\n");
}

export const SMALL = "const a = 1;\nconst b = 2;\nexport function tiny() {\n  return a + b;\n}\n";

export const CANDIDATES: MentionCandidate[] = [
  { kind: "file", path: "src/code/fuzzy.ts" },
  { kind: "file", path: "src/code/palette.ts" },
  { kind: "file", path: "src/main.ts" },
  { kind: "file", path: "src/mentions.ts" },
  { kind: "file", path: "docs/readme.md" },
  { kind: "symbol", path: "src/code/fuzzy.ts", symbol: "rank", detail: "function", line: 173 },
  { kind: "symbol", path: "src/mentions.ts", symbol: "rankCandidates", detail: "function", line: 300 },
  { kind: "symbol", path: "src/code/palette.ts", symbol: "paletteRowsHtml", detail: "function", line: 84 },
];
