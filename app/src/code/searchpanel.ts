// Galactus, the project search panel: the fifth tab of the Code view's left
// column, next to Files, Changes, History and Branches.
//
// Everything the panel shows is a function of `SearchPanelState`, and
// `searchPanelHtml()` is that function: pure, string in, string out, no DOM.
// The tests render the empty, streaming, capped and no-match states from it
// directly. `onSearchPanelEvent()` is the other half: it mutates the state and
// asks the host to repaint. The two never overlap.
//
// Two honesty rules the panel is built around:
//
//   * A truncated result set is ALWAYS said out loud. A search that silently
//     stops at 5000 hits teaches the user that the workspace does not contain
//     what it contains. Both ceilings (the backend's and this panel's) have a
//     visible banner.
//   * The matched span is highlighted from the backend's CHARACTER column and
//     its BYTE length, the two converted against each other rather than mixed.
//     A line holding an accented character or an emoji would otherwise be
//     highlighted one or two characters short, and that is exactly what the
//     tests pin down.

import { hitCharSpan, utf8Len } from "./workspace-api.js";
import type { SearchHit, SearchOpts, SearchProgress, WorkspaceApi } from "./workspace-api.js";
import { t } from "../i18n.js";

/** Hits this panel keeps. Past it the list stops being a list. */
export const HIT_CAP = 5000;
/** Hit rows rendered at once, whatever is held in the state. */
export const ROW_CAP = 600;
/** A line longer than this is windowed around its match. */
const LINE_WINDOW = 220;
/** Milliseconds of quiet before a keystroke starts a search. */
export const SEARCH_DEBOUNCE_MS = 180;

export interface SearchPanelState {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  /** Raw text of the include / exclude boxes, comma or space separated. */
  include: string;
  exclude: string;
  showGlobs: boolean;
  showReplace: boolean;
  replacement: string;
  /** Generation of the search currently owning the panel. 0 when idle. */
  gen: number;
  running: boolean;
  done: boolean;
  /** The backend hit its match ceiling. */
  capped: boolean;
  /** The backend hit its time budget. A different fact, said differently. */
  timedOut: boolean;
  /** This panel stopped storing hits at HIT_CAP. */
  clientCapped: boolean;
  hits: SearchHit[];
  collapsed: string[];
  error: string | null;
  /** Events that arrived before their generation was known. */
  early: SearchProgress[];
}

export interface SearchPanelDeps {
  root: string;
  api: WorkspaceApi;
  openFile(rel: string): void;
  revealLine(line: number, col: number): void;
  /**
   * Repaint the panel. "results" must replace only the `#srchres` region, so
   * that streaming hits never steal the focus out of the query box; "all"
   * re-renders the whole panel from `searchPanelHtml`.
   */
  repaint(scope: "all" | "results"): void;
  toast?(msg: string): void;
  /** Hand the current result set to the replace flow. Optional. */
  requestReplace?(state: SearchPanelState): void;
}

export function newSearchState(): SearchPanelState {
  return {
    query: "",
    caseSensitive: false,
    wholeWord: false,
    include: "",
    exclude: "",
    showGlobs: false,
    showReplace: false,
    replacement: "",
    gen: 0,
    running: false,
    done: false,
    capped: false,
    timedOut: false,
    clientCapped: false,
    hits: [],
    collapsed: [],
    error: null,
    early: [],
  };
}

/** Split a glob box into patterns. Commas and whitespace both separate. */
export function splitGlobs(s: string): string[] {
  return s
    .split(/[,\s]+/)
    .map((g) => g.trim())
    .filter(Boolean);
}

export function searchOpts(state: SearchPanelState): SearchOpts {
  return {
    caseSensitive: state.caseSensitive,
    wholeWord: state.wholeWord,
    include: splitGlobs(state.include),
    exclude: splitGlobs(state.exclude),
  };
}

// ---------------------------------------------------------------- grouping

export interface HitGroup {
  path: string;
  hits: SearchHit[];
}

/** Group hits by file, in the order the files first appeared in the stream. */
export function groupHits(hits: SearchHit[]): HitGroup[] {
  const by = new Map<string, HitGroup>();
  for (const h of hits) {
    const g = by.get(h.path);
    if (g) g.hits.push(h);
    else by.set(h.path, { path: h.path, hits: [h] });
  }
  return [...by.values()];
}

// --------------------------------------------------------------- rendering

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

function dirName(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
}

/**
 * The character span of a hit inside its line. `col` is a 1-based CHARACTER
 * column and `byteLen` a BYTE length: the conversion between the two lives in
 * the contract module, next to the offsets it is about.
 */
export function hitSpan(text: string, col: number, byteLen: number): { start: number; end: number } {
  return hitCharSpan(text, col, byteLen);
}

/**
 * The byte length of a hit's match: the backend's own `len` when it sent one,
 * the byte length of the query otherwise. They differ only when a
 * case-insensitive search folds a non-ASCII character into a shorter or longer
 * one, which is rare and wrong in exactly the way a user notices.
 */
export function hitByteLen(hit: SearchHit, query: string): number {
  return hit.len ?? utf8Len(query);
}

/**
 * One hit line, highlighted. Leading indentation is dropped and a very long
 * line is windowed around its match, both with an ellipsis so the user knows
 * the text was cut.
 */
export function hitTextHtml(text: string, col: number, byteLen: number): string {
  const { start, end } = hitSpan(text, col, byteLen);
  // Indentation is dropped silently: it is layout, not content, and marking
  // it with an ellipsis would put one in front of most rows for nothing.
  let from = 0;
  while (from < text.length && (text[from] === " " || text[from] === "\t")) from++;
  from = Math.min(from, start);
  let to = text.length;
  let cutHead = false;
  let cutTail = false;
  if (to - from > LINE_WINDOW) {
    if (start - from > 60) {
      from = start - 60;
      cutHead = true;
    }
    if (to - from > LINE_WINDOW) {
      to = Math.max(end, from + LINE_WINDOW);
      cutTail = to < text.length;
    }
  }
  return (
    (cutHead ? "…" : "") +
    esc(text.slice(from, start)) +
    "<b>" +
    esc(text.slice(start, end)) +
    "</b>" +
    esc(text.slice(end, to)) +
    (cutTail ? "…" : "")
  );
}

function statusHtml(state: SearchPanelState): string {
  if (state.error) return `<div class="srch-warn err">${esc(state.error)}</div>`;
  if (!state.query) return `<div class="srch-status">${esc(t("code.search.hint"))}</div>`;
  const files = new Set(state.hits.map((h) => h.path)).size;
  if (state.running) {
    return (
      `<div class="srch-status run">${esc(
        t("code.search.running").replace("%n", String(state.hits.length))
      )}<button class="slink" id="srchcancel">${esc(t("code.search.cancel"))}</button></div>`
    );
  }
  if (!state.hits.length) {
    return state.done
      ? `<div class="srch-status">${esc(t("code.search.none"))}</div>`
      : `<div class="srch-status">${esc(t("code.search.hint"))}</div>`;
  }
  return `<div class="srch-status">${esc(
    t("code.search.results").replace("%n", String(state.hits.length)).replace("%f", String(files))
  )}</div>`;
}

function bannersHtml(state: SearchPanelState): string {
  let out = "";
  if (state.capped) out += `<div class="srch-warn">${esc(t("code.search.capped"))}</div>`;
  if (state.timedOut) out += `<div class="srch-warn">${esc(t("code.search.timedOut"))}</div>`;
  if (state.clientCapped)
    out += `<div class="srch-warn">${esc(t("code.search.clientCapped").replace("%n", String(HIT_CAP)))}</div>`;
  return out;
}

function groupsHtml(state: SearchPanelState): string {
  const groups = groupHits(state.hits);
  const collapsed = new Set(state.collapsed);
  let rendered = 0;
  let out = "";
  for (const g of groups) {
    const shut = collapsed.has(g.path);
    out +=
      `<div class="sgh${shut ? " shut" : ""}" data-group="${esc(g.path)}">` +
      `<span class="tw">${shut ? "▸" : "▾"}</span>` +
      `<span class="nm mono" title="${esc(g.path)}">${esc(baseName(g.path))}</span>` +
      `<span class="dir mono">${esc(dirName(g.path))}</span>` +
      `<span class="n">${g.hits.length}</span></div>`;
    if (shut) continue;
    for (const h of g.hits) {
      if (rendered >= ROW_CAP) break;
      rendered++;
      const bytes = hitByteLen(h, state.query);
      out +=
        `<div class="srow" data-path="${esc(h.path)}" data-line="${h.line}" data-col="${h.col}">` +
        `<span class="ln">${h.line}</span>` +
        `<span class="tx mono">${hitTextHtml(h.text, h.col, bytes)}</span></div>`;
    }
    if (rendered >= ROW_CAP) break;
  }
  if (state.hits.length > rendered) {
    out += `<div class="srch-more">${esc(
      t("code.search.rowsShown").replace("%n", String(rendered)).replace("%m", String(state.hits.length))
    )}</div>`;
  }
  return out;
}

/** The results half of the panel: status, banners, grouped hits. */
export function searchResultsHtml(state: SearchPanelState): string {
  return statusHtml(state) + bannersHtml(state) + groupsHtml(state);
}

/** The whole panel. Pure. */
export function searchPanelHtml(state: SearchPanelState): string {
  const files = new Set(state.hits.map((h) => h.path)).size;
  const tog = (key: string, label: string, on: boolean, title: string) =>
    `<button class="stog${on ? " on" : ""}" data-toggle="${key}" title="${esc(title)}">${esc(label)}</button>`;
  return (
    `<div class="srch">` +
    `<div class="srch-top">` +
    `<input id="srchq" class="srch-q mono" autocomplete="off" spellcheck="false" placeholder="${esc(
      t("code.search.placeholder")
    )}" value="${esc(state.query)}"/>` +
    tog("case", "Aa", state.caseSensitive, t("code.search.case")) +
    tog("word", "ab", state.wholeWord, t("code.search.word")) +
    tog("globs", "⋯", state.showGlobs, t("code.search.globs")) +
    tog("replace", "⇄", state.showReplace, t("code.search.replaceToggle")) +
    `</div>` +
    (state.showGlobs
      ? `<div class="srch-globs">` +
        `<input id="srchinc" class="mono" autocomplete="off" spellcheck="false" placeholder="${esc(
          t("code.search.include")
        )}" value="${esc(state.include)}"/>` +
        `<input id="srchexc" class="mono" autocomplete="off" spellcheck="false" placeholder="${esc(
          t("code.search.exclude")
        )}" value="${esc(state.exclude)}"/></div>`
      : "") +
    (state.showReplace
      ? `<div class="srch-repl">` +
        `<input id="srchrepl" class="mono" autocomplete="off" spellcheck="false" placeholder="${esc(
          t("code.search.replacePlaceholder")
        )}" value="${esc(state.replacement)}"/>` +
        `<button class="bs" id="srchdorepl"${state.hits.length && !state.running ? "" : " disabled"}>${esc(
          t("code.search.replaceDo").replace("%f", String(files))
        )}</button></div>`
      : "") +
    `<div class="srch-res" id="srchres">${searchResultsHtml(state)}</div>` +
    `</div>`
  );
}

// ------------------------------------------------------------------ stream

/**
 * Fold one streamed batch into the state. Events from another generation are
 * dropped, except when they run AHEAD of the panel: `searchStart` resolves
 * with its generation number in a microtask, and a fast backend can emit
 * before that lands, so those events are parked and drained by `startSearch`.
 */
export function applySearchEvent(state: SearchPanelState, p: SearchProgress): void {
  if (p.gen !== state.gen) {
    if (p.gen > state.gen && state.early.length < 256) state.early.push(p);
    return;
  }
  for (const h of p.hits) {
    if (state.hits.length >= HIT_CAP) {
      state.clientCapped = true;
      break;
    }
    state.hits.push(h);
  }
  if (p.capped) state.capped = true;
  if (p.timedOut) state.timedOut = true;
  if (p.error) state.error = p.error;
  if (p.done) {
    state.running = false;
    state.done = true;
  }
}

/** The callback to hand to `api.onSearch`. Repaints only the results region. */
export function makeSearchSink(
  state: SearchPanelState,
  deps: SearchPanelDeps
): (p: SearchProgress) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (p: SearchProgress) => {
    const before = state.hits.length;
    applySearchEvent(state, p);
    if (state.hits.length === before && !p.done && !p.capped && !p.timedOut) return;
    // Streaming repaints are coalesced: a backend emitting every few
    // milliseconds must not rebuild the list every few milliseconds.
    if (p.done) {
      if (timer) clearTimeout(timer);
      timer = null;
      deps.repaint("results");
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      deps.repaint("results");
    }, 80);
  };
}

export async function startSearch(state: SearchPanelState, deps: SearchPanelDeps): Promise<void> {
  const previous = state.gen;
  state.gen = 0;
  state.hits = [];
  state.collapsed = [];
  state.done = false;
  state.capped = false;
  state.timedOut = false;
  state.clientCapped = false;
  state.error = null;
  if (previous) await deps.api.searchCancel(previous).catch(() => {});
  if (!state.query) {
    state.running = false;
    state.early = [];
    deps.repaint("all");
    return;
  }
  state.running = true;
  deps.repaint("results");
  try {
    const gen = await deps.api.searchStart(deps.root, state.query, searchOpts(state));
    state.gen = gen;
    const parked = state.early;
    state.early = [];
    for (const p of parked) applySearchEvent(state, p);
    deps.repaint("results");
  } catch (e: unknown) {
    state.running = false;
    state.done = true;
    state.error = String((e as Error)?.message ?? e);
    deps.repaint("results");
  }
}

export async function cancelSearch(state: SearchPanelState, deps: SearchPanelDeps): Promise<void> {
  if (!state.gen) return;
  const gen = state.gen;
  state.running = false;
  state.done = true;
  deps.repaint("results");
  await deps.api.searchCancel(gen).catch(() => {});
}

// ------------------------------------------------------------------ events

let debounce: ReturnType<typeof setTimeout> | null = null;

function schedule(state: SearchPanelState, deps: SearchPanelDeps): void {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = null;
    void startSearch(state, deps);
  }, SEARCH_DEBOUNCE_MS);
}

/** Cancel a keystroke that has not started its search yet. Used by tests. */
export function flushSearchDebounce(state: SearchPanelState, deps: SearchPanelDeps): Promise<void> {
  if (debounce) {
    clearTimeout(debounce);
    debounce = null;
  }
  return startSearch(state, deps);
}

/**
 * One handler for the whole panel: `input`, `keydown` and `click` are all
 * routed here by the host, the way the Code view already routes its left
 * column.
 */
export function onSearchPanelEvent(e: Event, state: SearchPanelState, deps: SearchPanelDeps): void {
  const target = e.target as HTMLElement | null;
  if (!target) return;

  if (e.type === "input") {
    const id = target.id;
    const value = (target as HTMLInputElement).value;
    if (id === "srchq") {
      state.query = value;
      schedule(state, deps);
    } else if (id === "srchinc") {
      state.include = value;
      if (state.query) schedule(state, deps);
    } else if (id === "srchexc") {
      state.exclude = value;
      if (state.query) schedule(state, deps);
    } else if (id === "srchrepl") {
      // No repaint: rewriting the panel here would take the caret with it.
      state.replacement = value;
    }
    return;
  }

  if (e.type === "keydown") {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter" && (target.id === "srchq" || target.id === "srchinc" || target.id === "srchexc")) {
      ke.preventDefault();
      void flushSearchDebounce(state, deps);
    } else if (ke.key === "Escape" && target.id === "srchq") {
      ke.preventDefault();
      void cancelSearch(state, deps);
    }
    return;
  }

  if (e.type !== "click") return;

  const tog = target.closest("[data-toggle]") as HTMLElement | null;
  if (tog) {
    const k = tog.dataset.toggle;
    if (k === "case") state.caseSensitive = !state.caseSensitive;
    else if (k === "word") state.wholeWord = !state.wholeWord;
    else if (k === "globs") state.showGlobs = !state.showGlobs;
    else if (k === "replace") state.showReplace = !state.showReplace;
    deps.repaint("all");
    if ((k === "case" || k === "word") && state.query) void flushSearchDebounce(state, deps);
    return;
  }

  if (target.id === "srchcancel") {
    void cancelSearch(state, deps);
    return;
  }

  if (target.id === "srchdorepl") {
    deps.requestReplace?.(state);
    return;
  }

  const group = target.closest("[data-group]") as HTMLElement | null;
  if (group) {
    const p = group.dataset.group!;
    const at = state.collapsed.indexOf(p);
    if (at >= 0) state.collapsed.splice(at, 1);
    else state.collapsed.push(p);
    deps.repaint("results");
    return;
  }

  const row = target.closest("[data-path]") as HTMLElement | null;
  if (row) {
    const path = row.dataset.path!;
    const line = Number(row.dataset.line);
    // A 1-based CHARACTER column, which is what a CodeMirror position wants.
    const col = Number(row.dataset.col || 1);
    deps.openFile(path);
    deps.revealLine(line, col);
  }
}
