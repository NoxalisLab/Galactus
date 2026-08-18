/**
 * Which lines of the open file differ from the version git has, expressed as
 * marks for the gutter: added, modified, deleted-just-above.
 *
 * WHY IT IS HERE AND NOT IN A LIBRARY. The editor already knows the file's
 * committed content (git_show_file) and its buffer. What was missing was the
 * comparison, and the comparison is the only part with any judgement in it.
 *
 * THE ALGORITHM, and its deliberate ceiling. Common prefix and suffix are
 * stripped first, which on a real edit leaves a handful of lines: someone
 * changed a function, not the file. What remains goes through a plain LCS,
 * which is O(n*m) and therefore has to be bounded. Past the bound the whole
 * remaining span is reported as one modified block rather than computed
 * exactly: a precise map of a five thousand line rewrite tells the reader
 * nothing they cannot already see, and freezing the editor to draw it would be
 * a poor trade. The bound is generous enough that no ordinary edit reaches it.
 *
 * A DELETION HAS NO LINE. It is drawn as a wedge on the boundary between the
 * two lines that survived it, so `line` for a deletion means "something used to
 * be here, just above this line".
 */

export type ChangeKind = "add" | "mod" | "del";

export interface LineChange {
  /** 1-based line in the CURRENT document. */
  line: number;
  kind: ChangeKind;
}

/**
 * Past this many lines in the differing span, the span is reported as one
 * modified block instead of being diffed exactly. 1200 x 1200 is about 1.4
 * million cells, tens of milliseconds, and no real edit gets near it.
 */
const LCS_CEILING = 1200;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // A trailing newline is a terminator, not an empty last line: without this
  // every file that ends properly reports one phantom change at the end.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * The gutter marks for `current` against `base`.
 *
 * `base` is the committed text. An empty base with a non-empty current file
 * means a new file, and every line is an addition, which is exactly what a
 * reader wants to see on a file git has never held.
 */
export function lineChanges(base: string, current: string): LineChange[] {
  const a = splitLines(base);
  const b = splitLines(current);
  if (a.length === 0 && b.length === 0) return [];

  // Common prefix.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  // Common suffix, never overlapping the prefix.
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const oldSpan = a.slice(start, endA);
  const newSpan = b.slice(start, endB);
  if (oldSpan.length === 0 && newSpan.length === 0) return [];

  // Pure insertion or pure deletion: no comparison needed, and this is the
  // common case (a pasted block, a removed function).
  if (oldSpan.length === 0) {
    return newSpan.map((_, i) => ({ line: start + i + 1, kind: "add" as const }));
  }
  if (newSpan.length === 0) {
    // Everything vanished between two surviving lines: one wedge.
    return [{ line: Math.min(start + 1, b.length || 1), kind: "del" }];
  }

  if (oldSpan.length > LCS_CEILING || newSpan.length > LCS_CEILING) {
    return newSpan.map((_, i) => ({ line: start + i + 1, kind: "mod" as const }));
  }

  return alignSpans(oldSpan, newSpan, start, b.length);
}

/**
 * LCS over the two differing spans, walked back into marks.
 *
 * A removal immediately followed by an insertion is a modification, which is
 * what a reader means by "I changed this line", so the walk pairs them instead
 * of reporting a deletion wedge and an addition on the same boundary.
 */
function alignSpans(
  oldSpan: string[],
  newSpan: string[],
  offset: number,
  currentLength: number,
): LineChange[] {
  const n = oldSpan.length;
  const m = newSpan.length;
  // table[i][j] = LCS length of oldSpan[i..] and newSpan[j..]
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] =
        oldSpan[i] === newSpan[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out: LineChange[] = [];
  let i = 0;
  let j = 0;
  let pendingDeletion = false;
  while (i < n && j < m) {
    if (oldSpan[i] === newSpan[j]) {
      if (pendingDeletion) {
        out.push({ line: offset + j + 1, kind: "del" });
        pendingDeletion = false;
      }
      i++;
      j++;
      continue;
    }
    if (table[i + 1][j] >= table[i][j + 1]) {
      // A line of the old version is gone.
      pendingDeletion = true;
      i++;
    } else {
      // A line of the new version is here. Paired with a pending deletion it is
      // a modification, which is the shape almost every real edit has.
      out.push({ line: offset + j + 1, kind: pendingDeletion ? "mod" : "add" });
      pendingDeletion = false;
      j++;
    }
  }
  while (j < m) {
    out.push({ line: offset + j + 1, kind: pendingDeletion ? "mod" : "add" });
    pendingDeletion = false;
    j++;
  }
  if (i < n || pendingDeletion) {
    // Trailing removals: the wedge sits on the line that follows them, or on
    // the last line of the file when they ran off the end.
    out.push({ line: Math.min(offset + m + 1, Math.max(currentLength, 1)), kind: "del" });
  }
  return out;
}
