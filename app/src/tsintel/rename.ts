// Galactus, rename: planned and never applied.
//
// A rename is the one language service feature that would break this product if
// it were built the obvious way. Every other editor writes the files and calls
// it done. Here, the rule the whole Code view is built around is that a change
// the model or a tool makes is a PROPOSAL: it arrives as a pending diff and the
// disk only ever receives what the user accepted, hunk by hunk.
//
// So this module returns file CONTENTS. It has no writer, no `invoke`, no
// filesystem of any kind, and `no_writer_in_the_compiled_output` in the tests
// greps the emitted JavaScript to keep it that way. The caller feeds what comes
// out to `fileProposal(...)`, and a rename across nine files lands as nine
// pending diffs that look exactly like a model edit, because that is what they
// are.

import type * as TS from "typescript";
import type { RenameHit } from "./protocol.js";

/**
 * The inverse of `host.ts`'s `toPath`, restated here rather than imported.
 *
 * That is not duplication for its own sake. `client.ts` runs on the MAIN thread
 * and calls `applyRenameHits`; importing anything from host.ts would drag the
 * 9 MB `typescript` module out of the worker chunk and into the main bundle,
 * which is measurable (9.9 MB instead of 30 kB) and defeats the entire lazy
 * loading design. Every import in this file is type-only for the same reason.
 */
function toRel(p: string): string {
  return p.startsWith("/") ? p.slice(1) : p;
}

export interface RenameEdit {
  /** Path relative to the workspace root, ready for `fileProposal`. */
  rel: string;
  /** The FULL new content of the file. Not a patch: the merge view needs both
   *  sides whole, and a patch that fails to apply is a silent corruption. */
  content: string;
}

/** Everything the planner needs to read, and nothing it could write with. */
export type ReadFile = (rel: string) => Promise<string | undefined>;

/**
 * Apply rename hits to file contents.
 *
 * Edits are applied back to front within each file, so an earlier span's change
 * in length cannot move a later span. `prefixText` and `suffixText` are honoured
 * because TypeScript uses them for shorthand properties: renaming `b` in
 * `const { a } = x` to `b` must produce `{ a: b }`, and dropping the prefix
 * would produce `{ b }`, which compiles and means something else.
 */
export function applyRenameHits(
  hits: readonly RenameHit[],
  newName: string,
  contents: ReadonlyMap<string, string>
): RenameEdit[] {
  const byFile = new Map<string, RenameHit[]>();
  for (const h of hits) {
    const rel = toRel(h.rel);
    const list = byFile.get(rel);
    if (list) list.push(h);
    else byFile.set(rel, [h]);
  }
  const out: RenameEdit[] = [];
  for (const rel of [...byFile.keys()].sort()) {
    const before = contents.get(rel);
    if (before === undefined) {
      throw new Error(`rename touches ${rel}, which is not in the snapshot`);
    }
    const spans = byFile
      .get(rel)!
      .slice()
      .sort((a, b) => b.start - a.start);
    let text = before;
    let last = Number.POSITIVE_INFINITY;
    for (const s of spans) {
      const end = s.start + s.length;
      if (end > last) {
        // Overlapping spans mean the plan is not a plan. Refusing beats writing
        // a file that is subtly wrong in a place nobody will look.
        throw new Error(`rename produced overlapping edits in ${rel}`);
      }
      last = s.start;
      text = text.slice(0, s.start) + (s.prefixText ?? "") + newName + (s.suffixText ?? "") + text.slice(end);
    }
    if (text !== before) out.push({ rel, content: text });
  }
  return out;
}

/**
 * Ask the language service where a symbol lives, and return what every touched
 * file would look like afterwards.
 *
 * `file` is the path as the service knows it, `pos` a character offset.
 * Nothing is written. The caller decides what to do with the result, and in
 * this app the answer is always the permission gate.
 */
export async function planRename(
  svc: TS.LanguageService,
  file: string,
  pos: number,
  newName: string,
  readFile: ReadFile
): Promise<RenameEdit[]> {
  if (!newName.trim()) throw new Error("a rename needs a new name");
  const info = svc.getRenameInfo(file, pos, { allowRenameOfImportPath: false });
  if (!info.canRename) {
    throw new Error(info.localizedErrorMessage || "this cannot be renamed");
  }
  if (info.displayName === newName) {
    throw new Error(`${newName} is already the name`);
  }
  const locs =
    svc.findRenameLocations(file, pos, false, false, {
      providePrefixAndSuffixTextForRename: true,
    }) ?? [];
  if (!locs.length) return [];

  const hits: RenameHit[] = locs.map((l) => ({
    rel: toRel(l.fileName),
    start: l.textSpan.start,
    length: l.textSpan.length,
    prefixText: l.prefixText,
    suffixText: l.suffixText,
  }));

  // Contents are gathered first, so the edit pass itself stays synchronous and
  // cannot interleave with anything that might change a file underneath it.
  const contents = new Map<string, string>();
  for (const rel of new Set(hits.map((h) => h.rel))) {
    const text = await readFile(rel);
    if (text === undefined) throw new Error(`rename touches ${rel}, which cannot be read`);
    contents.set(rel, text);
  }
  return applyRenameHits(hits, newName, contents);
}
