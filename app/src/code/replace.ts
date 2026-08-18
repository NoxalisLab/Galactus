// Galactus, project-wide replace.
//
// This module is nearly free, and it is free BECAUSE of the architecture it
// refuses to touch. It computes the full rewritten content of every affected
// file and RETURNS it. That is all it does. It has no write capability: it
// imports no api, it has no Tauri command, it cannot reach the disk even by
// accident, and the test greps its compiled output to prove it.
//
// The caller feeds each result to the existing `fileProposal(path, rel,
// content)`, so a project-wide replace becomes exactly what a single-file edit
// by the model already is: a pending diff per file, the `◆` marker in the
// tree, a row in the pending sidebar, `unifiedMergeView` on open, hunk by hunk
// accept or reject, and `writeAccepted()` still the only function in the app
// that touches the disk. Zero new safety machinery. That is the design.
//
// Two guards live here:
//
//   * The base content of each file is read ONCE. The naive version reads a
//     file per hit, then again per rewrite; on a 2000-hit search that is
//     thousands of IPC round trips for a few dozen files.
//   * `REPLACE_FILE_CAP`. The pending sidebar is a flat list and the Code nav
//     badge is a raw count: 300 proposals is not a review, it is a wall. Above
//     the cap `planReplace` refuses, and the caller narrows the search.

// The ".js" suffix on a TypeScript source is deliberate: it is what lets the
// exact same files be type-checked by the app (bundler resolution), bundled by
// Vite, and run directly by `node --test` after a plain tsc emit.
import { hitCharSpan, wordBounded } from "./workspace-api.js";
import type { SearchHit, SearchOpts } from "./workspace-api.js";

/**
 * The largest number of files one replace may propose. Not a performance
 * limit: a limit on what a human can actually review in the pending queue.
 */
export const REPLACE_FILE_CAP = 40;

/** One rewritten file, ready to be handed to `fileProposal`. */
export interface ReplaceFile {
  rel: string;
  content: string;
}

/** Raised when the plan would exceed `REPLACE_FILE_CAP`. */
export class ReplaceCapError extends Error {
  constructor(readonly files: number) {
    super(`replace: ${files} files exceeds the review cap of ${REPLACE_FILE_CAP}`);
    this.name = "ReplaceCapError";
  }
}

/** Split keeping each terminator, so CRLF and a missing final newline survive. */
function splitKeepingEol(s: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) {
      out.push(s.slice(start, i + 1));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

function eolOf(line: string): string {
  if (line.endsWith("\r\n")) return "\r\n";
  if (line.endsWith("\n")) return "\n";
  return "";
}

/**
 * Plan a replacement. Returns the full new content of every file that actually
 * changes, in the order the files first appear in `hits`. Nothing is written.
 *
 * A hit whose text no longer matches `find` at its recorded position is
 * SKIPPED, not guessed at: the file may have moved under the search, and a
 * stale offset must never rewrite a line the user did not see. Two hits that
 * overlap on one line resolve left to right, the second one dropped.
 *
 * `replacement` is inserted literally. A case-insensitive search does not try
 * to preserve the case of what it replaced, because there is no honest way to
 * do that which the user can predict from the diff they are shown.
 */
export async function planReplace(
  hits: SearchHit[],
  find: string,
  replacement: string,
  opts: SearchOpts,
  readFile: (rel: string) => Promise<string>
): Promise<ReplaceFile[]> {
  if (!find) throw new Error("replace: the search text is empty");

  // Group by file, first-seen order preserved by Map insertion order.
  const byFile = new Map<string, SearchHit[]>();
  for (const h of hits) {
    const list = byFile.get(h.path);
    if (list) list.push(h);
    else byFile.set(h.path, [h]);
  }
  if (byFile.size > REPLACE_FILE_CAP) throw new ReplaceCapError(byFile.size);
  if (byFile.size === 0) return [];

  // Guard one: one read per FILE, issued together, never one per hit.
  const rels = [...byFile.keys()];
  const bases = await Promise.all(rels.map((rel) => readFile(rel)));

  const out: ReplaceFile[] = [];
  for (let f = 0; f < rels.length; f++) {
    const rel = rels[f];
    const base = bases[f];
    const next = rewrite(base, byFile.get(rel)!, find, replacement, opts);
    if (next !== base) out.push({ rel, content: next });
  }
  return out;
}

function rewrite(
  base: string,
  hits: SearchHit[],
  find: string,
  replacement: string,
  opts: SearchOpts
): string {
  const lines = splitKeepingEol(base);

  // Bucket by line, then apply each line left to right in one pass.
  const perLine = new Map<number, SearchHit[]>();
  for (const h of hits) {
    const list = perLine.get(h.line);
    if (list) list.push(h);
    else perLine.set(h.line, [h]);
  }

  for (const [line, list] of perLine) {
    const idx = line - 1;
    if (idx < 0 || idx >= lines.length) continue; // stale line number
    const eol = eolOf(lines[idx]);
    const text = lines[idx].slice(0, lines[idx].length - eol.length);

    // `col` is a character column, `len` a byte length: the span helper is the
    // only place allowed to mix the two. A hit without `len` falls back to the
    // needle's own character length.
    const spans = list
      .map((h) => (h.len ? hitCharSpan(text, h.col, h.len) : { start: h.col - 1, end: h.col - 1 + find.length }))
      .sort((a, b) => a.start - b.start);

    let built = "";
    let cursor = 0;
    let changed = false;
    for (const { start, end } of spans) {
      if (start < 0 || start < cursor) continue; // overlaps what was just done
      if (end > text.length) continue;
      const slice = text.slice(start, end);
      // In pattern mode there is nothing to compare the slice AGAINST: `find`
      // is the pattern, not the text it matched, so this test failed on every
      // hit and the whole replacement silently did nothing. The user saw two
      // thousand matches and then "no occurrences". The freshness check that
      // this comparison exists for is done by length instead, which is what
      // the backend reports per hit.
      if (opts.regex) {
        if (end - start <= 0) continue;
      } else {
        const same = opts.caseSensitive ? slice === find : slice.toLowerCase() === find.toLowerCase();
        if (!same) continue; // stale hit: the line moved under the search
      }
      if (opts.wholeWord && !wordBounded(text, start, end)) continue;
      built += text.slice(cursor, start) + replacement;
      cursor = end;
      changed = true;
    }
    if (!changed) continue;
    lines[idx] = built + text.slice(cursor) + eol;
  }

  return lines.join("");
}
