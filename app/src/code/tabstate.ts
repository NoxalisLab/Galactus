/**
 * What "which files were open" is worth on disk, and how it is read back.
 *
 * Pure, and tested, because the failure it guards is quiet: a session that
 * reopens as a single column after the user set up a split has lost work they
 * did with the mouse, and nothing on screen says why. The shape also has to
 * survive being read by an older build, which is why every field is optional
 * on the way in and nothing throws on a value of the wrong type.
 */

export interface TabState {
  /** Left pane, in tab order. */
  rels: string[];
  /** The file focused in the left pane. */
  active: string | null;
  /** Right pane. Empty means there is no split. */
  right: string[];
  rightActive: string | null;
  /** Which side had the focus. */
  pane: 0 | 1;
}

/** Never reopen more than this per pane: a relaunch must not read 50 files. */
export const TAB_RESTORE_CAP = 12;

export function encodeTabs(s: TabState): string {
  return JSON.stringify(s);
}

/** Read a stored value of any age, or null when there is nothing usable. */
export function parseTabs(saved: string | undefined): TabState | null {
  if (!saved?.trim()) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(saved);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const one = (v: unknown, within: string[]): string | null =>
    typeof v === "string" && within.includes(v) ? v : null;
  const rels = list(o.rels);
  const right = list(o.right);
  return {
    rels,
    active: one(o.active, rels),
    right,
    rightActive: one(o.rightActive, right),
    // A stored focus on a pane that no longer has anything in it would leave
    // the user typing into a column that is not on screen.
    pane: o.pane === 1 && right.length > 0 ? 1 : 0,
  };
}
