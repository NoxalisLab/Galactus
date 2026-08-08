// Galactus, Code view: one open document, many times over.
//
// The Code view used to keep the open file in module-level singletons
// (`openPath`, `buffer`, `savedContent`, `openError`, `mergeBase`,
// `writeChain`) and to rebuild the EditorView from a fresh EditorState on
// every repaint. Two consequences, both of them bugs:
//
//   1. Every repaint threw away the cursor, the scroll position, the
//      selection, the undo history and the fold state.
//   2. With more than one file open, `savedContent` and `writeChain` were
//      SHARED. Accepting a hunk in file A rewrote the "content on disk" of
//      file B, so B's dirty flag and its Save button lied.
//
// This module fixes both by making every one of those singletons a field of a
// Doc, and by keeping an EditorState per document. Switching tabs is then:
//
//     docs.capture(view);              // persist what the user was doing
//     const d = docs.activate(rel);
//     view.setState(d.state);          // history, folds, cursor, scroll intact
//
// Nothing here touches the DOM. `createState` is injected, so a test can hand
// in a stub and still exercise the whole state machine, and `EditorView` is
// imported as a type only, so this file loads under plain Node.

import { EditorState, Extension, Facet } from "@codemirror/state";
import type { StateEffect } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/**
 * The workspace-relative path of the document a state belongs to, carried
 * inside the state itself. That is what makes `byView` exact: the view's
 * current state always knows which document it is showing, even after the
 * user has typed into it and the state no longer matches the stored one.
 */
export const docRel = Facet.define<string, string | null>({
  combine: (v) => (v.length ? v[0] : null),
});

export interface Doc {
  /** Path relative to the workspace root. Stable identity of the document. */
  rel: string;
  /** The editor state. Updated by `capture`, never rebuilt on repaint. */
  state: EditorState;
  /** The content as it stands on disk. Per document, which is the fix. */
  saved: string;
  /**
   * The merge view's base: the disk content the pending proposal is measured
   * against, moving forward with every accepted hunk. null when this document
   * has no pending proposal.
   */
  mergeBase: string | null;
  /** Backend error for this file (binary, too large...), null when readable. */
  error: string | null;
  /** Serializes the writes triggered by this document's accepted hunks. */
  writeChain: Promise<void>;
  /**
   * Where the editor was scrolled, as `EditorView.scrollSnapshot()` returns
   * it. The scroll position lives in the view, not in the state, so it has to
   * be carried separately and re-dispatched after `setState`.
   */
  scroll: StateEffect<unknown> | null;
}

/**
 * Builds the state for a document. Injected so the Code view keeps ownership
 * of the extension set (theme, languages, diagnostics) and so tests can pass a
 * stub that never imports @codemirror/view.
 */
export type CreateState = (rel: string, doc: string, extra: Extension[]) => EditorState;

/**
 * Builds the unified merge view for a document that has a pending proposal.
 * Injected for the same reason: @codemirror/merge stays in the Code view.
 */
export type MergeExtension = (base: string) => Extension[];

/** Anything that carries an EditorState. Lets tests avoid a real EditorView. */
type ViewLike = { state: EditorState };

export class Docs {
  private readonly map = new Map<string, Doc>();
  /** Tab order, left to right. The Code view renders this list as is. */
  readonly tabs: string[] = [];
  private current: string | null = null;

  constructor(
    private readonly createState: CreateState,
    private readonly mergeExtension: MergeExtension = () => []
  ) {}

  /**
   * Open a file, or focus it if it is already open.
   *
   * `disk` is the content on disk. `proposedAfter`, when given and different
   * from disk, puts the document straight into review mode: the buffer holds
   * the proposal and the merge base holds the disk content.
   *
   * Reopening an already-open file without a proposal keeps its state: the
   * user's unsaved edits, undo history and cursor are not thrown away just
   * because the tree was clicked again.
   */
  open(rel: string, disk: string, proposedAfter?: string): Doc {
    const existing = this.map.get(rel);
    if (existing && proposedAfter === undefined) {
      this.current = rel;
      return existing;
    }
    const inReview = proposedAfter !== undefined && proposedAfter !== disk;
    const text = inReview ? proposedAfter! : disk;
    const mergeBase = inReview ? disk : null;
    const doc: Doc = {
      rel,
      state: this.build(rel, text, mergeBase),
      saved: disk,
      mergeBase,
      error: null,
      // A reopen must not drop writes that are still in flight for this file.
      writeChain: existing ? existing.writeChain : Promise.resolve(),
      scroll: null,
    };
    this.map.set(rel, doc);
    if (!this.tabs.includes(rel)) this.tabs.push(rel);
    this.current = rel;
    return doc;
  }

  /** Open a file that the backend refused to read. It still gets a tab. */
  openError(rel: string, error: string): Doc {
    const doc: Doc = {
      rel,
      state: this.build(rel, "", null),
      saved: "",
      mergeBase: null,
      error,
      writeChain: this.map.get(rel)?.writeChain ?? Promise.resolve(),
      scroll: null,
    };
    this.map.set(rel, doc);
    if (!this.tabs.includes(rel)) this.tabs.push(rel);
    this.current = rel;
    return doc;
  }

  /**
   * Rebuild a document's state from scratch. Needed only when the extension
   * set itself has to change in a way a compartment cannot express, typically
   * leaving or entering review mode, or reloading a file changed on disk.
   * Everything else goes through a transaction and keeps the history.
   */
  rebuild(rel: string, text?: string): Doc | null {
    const doc = this.map.get(rel);
    if (!doc) return null;
    const body = text ?? doc.state.doc.toString();
    doc.state = this.build(rel, body, doc.mergeBase);
    return doc;
  }

  /** Close a tab. The neighbour on the left takes focus, else the right one. */
  close(rel: string): Doc | null {
    const i = this.tabs.indexOf(rel);
    this.map.delete(rel);
    if (i >= 0) this.tabs.splice(i, 1);
    if (this.current !== rel) return this.active();
    if (!this.tabs.length) {
      this.current = null;
      return null;
    }
    this.current = this.tabs[Math.min(Math.max(i - 1, 0), this.tabs.length - 1)];
    return this.active();
  }

  /** Drop everything. Used when the workspace itself changes. */
  closeAll(): void {
    this.map.clear();
    this.tabs.length = 0;
    this.current = null;
  }

  /** Focus an already-open document. Returns null when it is not open. */
  activate(rel: string): Doc | null {
    const doc = this.map.get(rel);
    if (!doc) return null;
    this.current = rel;
    return doc;
  }

  active(): Doc | null {
    return this.current ? (this.map.get(this.current) ?? null) : null;
  }

  activeRel(): string | null {
    return this.current;
  }

  get(rel: string): Doc | null {
    return this.map.get(rel) ?? null;
  }

  has(rel: string): boolean {
    return this.map.has(rel);
  }

  get size(): number {
    return this.map.size;
  }

  /** Open documents, in tab order. */
  list(): Doc[] {
    const out: Doc[] = [];
    for (const rel of this.tabs) {
      const d = this.map.get(rel);
      if (d) out.push(d);
    }
    return out;
  }

  /** Which document a view is showing, read from the state itself. */
  byView(view: EditorView | ViewLike): Doc | null {
    const rel = (view as ViewLike).state.facet(docRel);
    return rel ? (this.map.get(rel) ?? null) : null;
  }

  /**
   * Persist the live view state back into its document. Call this BEFORE
   * switching tabs, closing a tab or repainting; it is what preserves undo
   * history, folds and selection. Pass `view.scrollSnapshot()` as the second
   * argument to carry the scroll position too, and re-dispatch `doc.scroll`
   * after `view.setState(doc.state)`.
   */
  capture(view: EditorView | ViewLike, scroll?: StateEffect<unknown> | null): Doc | null {
    const doc = this.byView(view);
    if (!doc) return null;
    doc.state = (view as ViewLike).state;
    if (scroll !== undefined) doc.scroll = scroll;
    return doc;
  }

  /** Text differs from disk. Purely textual: review mode is a separate flag. */
  isDirty(rel: string): boolean {
    const doc = this.map.get(rel);
    return !!doc && doc.error === null && doc.state.doc.toString() !== doc.saved;
  }

  /**
   * Record what is now on disk for ONE document. This is the call that used to
   * be an assignment to a shared module-level `savedContent`.
   */
  setSaved(rel: string, content: string): void {
    const doc = this.map.get(rel);
    if (doc) doc.saved = content;
  }

  setMergeBase(rel: string, base: string | null): void {
    const doc = this.map.get(rel);
    if (doc) doc.mergeBase = base;
  }

  setError(rel: string, error: string | null): void {
    const doc = this.map.get(rel);
    if (doc) doc.error = error;
  }

  /**
   * Queue a write on THIS document's chain. Two documents write in parallel;
   * two writes to the same document never race.
   */
  queueWrite(rel: string, task: () => Promise<void>): Promise<void> {
    const doc = this.map.get(rel);
    if (!doc) return Promise.resolve();
    doc.writeChain = doc.writeChain.then(task, task);
    return doc.writeChain;
  }

  /** Wait for this document's pending writes, swallowing their failures. */
  async settle(rel: string): Promise<void> {
    const doc = this.map.get(rel);
    if (doc) await doc.writeChain.catch(() => {});
  }

  private build(rel: string, text: string, mergeBase: string | null): EditorState {
    const extra: Extension[] = [docRel.of(rel)];
    if (mergeBase !== null) extra.push(...this.mergeExtension(mergeBase));
    return this.createState(rel, text, extra);
  }
}
