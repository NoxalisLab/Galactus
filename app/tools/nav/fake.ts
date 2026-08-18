// Fixtures for the navigation tests.
//
// The fake workspace itself lives in `src/code/workspace-api.ts`, next to the
// interface it implements, so the contract and its reference implementation
// can never drift apart. This file only builds the material the tests run on.

export { FakeWorkspaceApi } from "../../src/code/workspace-api.js";
export type { SearchHit, SearchOpts, SymbolHit } from "../../src/code/workspace-api.js";

import { FakeWorkspaceApi } from "../../src/code/workspace-api.js";
import type { SearchHit, SearchOpts, SymbolHit } from "../../src/code/workspace-api.js";

export const OPTS: SearchOpts = { caseSensitive: false, wholeWord: false, regex: false, include: [], exclude: [] };

export function opts(over: Partial<SearchOpts> = {}): SearchOpts {
  return { ...OPTS, ...over };
}

/**
 * A small workspace with the awkward cases on purpose: a multi-byte line, a
 * match at offset 0, a match at the very end of a file with no final newline,
 * two matches on one line, and a CRLF file.
 */
export const WORKSPACE: Record<string, string> = {
  "src/main.ts": [
    "target = 1;",
    "const other = target + target;",
    "// nothing here",
    "console.log(target);",
  ].join("\n"),
  "src/accents.ts": 'const café = "fête target fête";\nconst emoji = "🎉 target 🎉";\n',
  "src/eof.ts": "const a = 1;\nconst last = target",
  "src/crlf.ts": "line one\r\nconst x = target;\r\nline three\r\n",
  "docs/readme.md": "The target of this document.\n",
  "vendor/skip.js": "target\n",
};

export function makeFake(files: Record<string, string> = WORKSPACE, symbols: SymbolHit[] = SYMBOLS): FakeWorkspaceApi {
  return new FakeWorkspaceApi(files, symbols);
}

export const SYMBOLS: SymbolHit[] = [
  { name: "planReplace", kind: "function", path: "src/code/replace.ts", line: 78, container: "" },
  { name: "paletteRowsHtml", kind: "function", path: "src/code/palette.ts", line: 84, container: "" },
  { name: "SearchPanelState", kind: "interface", path: "src/code/searchpanel.ts", line: 36, container: "" },
  { name: "rank", kind: "function", path: "src/code/fuzzy.ts", line: 173, container: "" },
  { name: "readCounts", kind: "property", path: "src/code/workspace-api.ts", line: 178, container: "FakeWorkspaceApi" },
];

/** Run a full search on the fake and return every hit, in stream order. */
export async function searchAll(
  fake: FakeWorkspaceApi,
  query: string,
  o: SearchOpts = OPTS
): Promise<SearchHit[]> {
  const out: SearchHit[] = [];
  const off = fake.onSearch((p) => {
    if (p.gen === gen) out.push(...p.hits);
  });
  const gen = await fake.searchStart("/root", query, o);
  await fake.idle();
  off();
  return out;
}

/**
 * 100,000 synthetic paths for the ranking benchmark. Deterministic, and shaped
 * like a real tree: nested directories, dashed and camelCase file names,
 * several extensions.
 */
export function synthPaths(n: number): string[] {
  const dirs = ["src", "app/src", "app/src-tauri/src", "docs/plans", "tests/unit", "vendor/lib", "scripts"];
  const words = ["render", "parse", "index", "model", "search", "panel", "codec", "buffer", "vector", "stream"];
  const exts = ["ts", "rs", "py", "md", "json", "css"];
  const out: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const d = dirs[i % dirs.length];
    const a = words[(i * 7) % words.length];
    const b = words[(i * 13 + 3) % words.length];
    const camel = b[0].toUpperCase() + b.slice(1);
    const style = i % 3;
    const name = style === 0 ? `${a}-${b}` : style === 1 ? `${a}${camel}` : `${a}_${b}`;
    out[i] = `${d}/${(i % 97).toString(36)}/${name}${i}.${exts[i % exts.length]}`;
  }
  return out;
}
