// Galactus, the file and symbol palettes.
//
// Cmd-P opens the file palette, Cmd-T the symbol palette. Both are the SAME
// modal: the `.modal-bd` / `.modal wide` shell the Code view's `confirmModal`
// already uses, so they inherit the app's dialog frame, its backdrop, its
// entrance animation and its z-order instead of inventing a fourth kind of
// overlay. Only the row list is new.
//
// The renderer `paletteRowsHtml()` is exported separately and is pure: it
// takes rows and an active index and returns a string. That is what the tests
// exercise, with no DOM in sight.

import { rank, positions as fuzzyPositions, score as fuzzyScore } from "./fuzzy.js";
import type { SymbolHit, WorkspaceApi } from "./workspace-api.js";
import { t } from "../i18n.js";

/** Rows shown at once. Beyond this the list stops being scannable anyway. */
export const PALETTE_ROWS = 60;
/** Symbols asked of the backend per keystroke. */
export const SYMBOL_LIMIT = 120;

export interface PaletteRow {
  /** Primary text, highlighted at `positions`. */
  main: string;
  /** Offsets into `main` (UTF-16 code units) that the query matched. */
  positions: number[];
  /** Dim secondary text: the directory, or a symbol's container. */
  sub?: string;
  /** Offsets into `sub` that matched, when the query reached it. */
  subPositions?: number[];
  /** Small tag at the right edge: a symbol kind. */
  badge?: string;
}

export interface PaletteDeps {
  root: string;
  api: WorkspaceApi;
  /** Open a file, relative to the root. */
  /**
   * Open a file. Awaited before revealing a position: opening reads the file,
   * so a synchronous call returned while the previous document was still on
   * screen and the reveal landed in THAT one, scrolling the wrong file to an
   * arbitrary line while the intended one opened at the top.
   */
  openFile(rel: string): Promise<void> | void;
  /** Paths the user opened recently, most recent first. */
  recent(): string[];
  /** Scroll the editor to a symbol. Optional: only the symbol palette uses it. */
  revealLine?(line: number, col: number): void;
}

// ---------------------------------------------------------------- rendering

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/**
 * Wrap the matched characters of `text` in `<b>`. Positions come from the
 * matcher as UTF-16 code unit offsets; a range boundary that would land inside
 * a surrogate pair is widened to the whole pair, so an emoji in a path is
 * never cut in half by a highlight.
 */
export function markHtml(text: string, positions: number[] | undefined): string {
  if (!positions || !positions.length) return esc(text);
  const sorted = [...positions].sort((a, b) => a - b);
  let out = "";
  let cursor = 0;
  let i = 0;
  while (i < sorted.length) {
    let start = sorted[i];
    let end = start + 1;
    while (i + 1 < sorted.length && sorted[i + 1] === end) {
      end++;
      i++;
    }
    i++;
    if (start < cursor) continue;
    // Snap both edges to character boundaries.
    if (start > 0 && (text.charCodeAt(start) & 0xfc00) === 0xdc00) start--;
    if (end < text.length && (text.charCodeAt(end - 1) & 0xfc00) === 0xd800) end++;
    out += esc(text.slice(cursor, start)) + "<b>" + esc(text.slice(start, end)) + "</b>";
    cursor = end;
  }
  return out + esc(text.slice(cursor));
}

/** The pure palette list renderer. No DOM, no state, no side effect. */
export function paletteRowsHtml(rows: PaletteRow[], activeIndex: number): string {
  if (!rows.length) return `<div class="pal-empty">${esc(t("code.pal.none"))}</div>`;
  let out = "";
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const on = i === activeIndex;
    out +=
      `<div class="pal-row${on ? " on" : ""}" data-i="${i}" role="option" aria-selected="${on}">` +
      `<span class="nm mono">${markHtml(r.main, r.positions)}</span>` +
      (r.sub ? `<span class="sub mono">${markHtml(r.sub, r.subPositions)}</span>` : "") +
      (r.badge ? `<span class="kind">${esc(r.badge)}</span>` : "") +
      "</div>";
  }
  return out;
}

// ------------------------------------------------------------------- shell

interface PaletteSource {
  placeholder: string;
  footer: string;
  /** Rows for `q`, plus the value each row stands for. May be async. */
  fetch(q: string): Fetched | Promise<Fetched>;
  /** Act on the row the user validated. */
  pick(value: unknown): void;
}

interface Fetched {
  rows: PaletteRow[];
  values: unknown[];
  /** Shown instead of the list, when loading failed. */
  error?: string;
}

function el(h: string): HTMLElement {
  const d = document.createElement("div");
  d.innerHTML = h.trim();
  return d.firstElementChild as HTMLElement;
}

/** At most one palette exists at a time; reopening replaces it. */
let current: { close(): void } | null = null;

/** True while a palette owns the keyboard. Callers use it to stay out of the way. */
export function paletteOpen(): boolean {
  return current !== null;
}

export function closePalette(): void {
  current?.close();
}

function openPalette(src: PaletteSource): void {
  current?.close();

  const host = el(`<div class="modal-bd pal">
    <div class="modal wide pal-modal">
      <input class="pal-input" id="palq" autocomplete="off" spellcheck="false" placeholder="${esc(src.placeholder)}"/>
      <div class="pal-list" id="pallist" role="listbox"></div>
      <div class="pal-foot">${esc(src.footer)}</div>
    </div>
  </div>`);
  const input = host.querySelector<HTMLInputElement>("#palq")!;
  const list = host.querySelector<HTMLElement>("#pallist")!;

  let rows: PaletteRow[] = [];
  let values: unknown[] = [];
  let active = 0;
  let gen = 0;

  const paint = (): void => {
    list.innerHTML = paletteRowsHtml(rows, active);
    const on = list.querySelector<HTMLElement>(".pal-row.on");
    on?.scrollIntoView({ block: "nearest" });
  };

  const refresh = (q: string): void => {
    const mine = ++gen;
    const got = src.fetch(q);
    const apply = (f: Fetched): void => {
      if (mine !== gen || current !== handle) return;
      rows = f.error ? [] : f.rows;
      values = f.error ? [] : f.values;
      active = 0;
      if (f.error) list.innerHTML = `<div class="pal-empty err">${esc(f.error)}</div>`;
      else paint();
    };
    if (got instanceof Promise) {
      list.innerHTML = `<div class="pal-empty">${esc(t("code.pal.loading"))}</div>`;
      void got.then(apply, (e: unknown) => apply({ rows: [], values: [], error: String((e as Error)?.message ?? e) }));
    } else apply(got);
  };

  const choose = (i: number): void => {
    if (i < 0 || i >= values.length) return;
    const v = values[i];
    handle.close();
    src.pick(v);
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      handle.close();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      choose(active);
      return;
    }
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      if (rows.length) active = (active + 1) % rows.length;
      paint();
      return;
    }
    if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      if (rows.length) active = (active - 1 + rows.length) % rows.length;
      paint();
      return;
    }
    if (e.key === "Home" && rows.length) {
      e.preventDefault();
      active = 0;
      paint();
      return;
    }
    if (e.key === "End" && rows.length) {
      e.preventDefault();
      active = rows.length - 1;
      paint();
    }
  };

  const handle = {
    close(): void {
      if (current !== handle) return;
      current = null;
      host.remove();
    },
  };

  // Debounced, like the search panel has been all along. Every keystroke was
  // an IPC round trip for the symbol palette, and on the Rust side a query more
  // than two seconds after the last one re-walks the whole tree to check its
  // signature; for the file palette it scored the entire list on the main
  // thread, per character.
  let typing: ReturnType<typeof setTimeout> | null = null;
  input.addEventListener("input", () => {
    if (typing) clearTimeout(typing);
    typing = setTimeout(() => {
      typing = null;
      refresh(input.value);
    }, 120);
  });
  input.addEventListener("keydown", onKey);
  host.addEventListener("click", (e) => {
    if (e.target === host) {
      handle.close();
      return;
    }
    const row = (e.target as HTMLElement).closest("[data-i]") as HTMLElement | null;
    if (row) choose(Number(row.dataset.i));
  });

  current = handle;
  document.body.appendChild(host);
  input.focus();
  refresh("");
}

// ------------------------------------------------------------ file palette

function splitPath(p: string): { dir: string; base: string } {
  const i = p.lastIndexOf("/");
  return i < 0 ? { dir: "", base: p } : { dir: p.slice(0, i), base: p.slice(i + 1) };
}

/**
 * The file name carries the highlight, the directory sits behind it dimmed.
 * The matcher works on the whole relative path, so its offsets are split
 * between the two halves rather than recomputed, and the row shows exactly
 * where the query landed.
 */
export function fileRow(path: string, positions: number[]): PaletteRow {
  const { dir, base } = splitPath(path);
  const cut = dir ? dir.length + 1 : 0;
  const main: number[] = [];
  const sub: number[] = [];
  for (const p of positions) {
    if (p >= cut) main.push(p - cut);
    else sub.push(p);
  }
  return { main: base, positions: main, sub: dir, subPositions: sub };
}

export function openFilePalette(deps: PaletteDeps): void {
  let all: string[] | null = null;
  let error: string | null = null;
  const loading = deps.api.files(deps.root).then(
    (f) => {
      all = f;
    },
    (e: unknown) => {
      error = String((e as Error)?.message ?? e);
    }
  );

  const build = (q: string): Fetched => {
    if (error) return { rows: [], values: [], error };
    const ranked = rank(q, all ?? [], deps.recent(), PALETTE_ROWS);
    return {
      rows: ranked.map((r) => fileRow(r.path, r.positions)),
      values: ranked.map((r) => r.path),
    };
  };

  openPalette({
    placeholder: t("code.pal.filesPlaceholder"),
    footer: t("code.pal.footer"),
    fetch: (q) => (all === null && !error ? loading.then(() => build(q)) : build(q)),
    pick: (v) => deps.openFile(v as string),
  });
}

// ---------------------------------------------------------- symbol palette

/** `container · path:line`, the line a symbol row shows under its name. */
export function symbolSub(s: SymbolHit): string {
  return (s.container ? s.container + " · " : "") + s.path + ":" + s.line;
}

export function openSymbolPalette(deps: PaletteDeps): void {
  const build = async (q: string): Promise<Fetched> => {
    const hits = await deps.api.symbolsQuery(deps.root, q, SYMBOL_LIMIT);
    // The backend decides what matches; the order is decided here, with the
    // same matcher as the file palette, so both palettes feel identical.
    const scored = hits
      .map((s, i) => ({ s, i, k: q ? fuzzyScore(q, s.name) : 0 }))
      .filter((x) => x.k !== null)
      .sort((a, b) => (b.k! - a.k!) || a.s.name.length - b.s.name.length || a.i - b.i)
      .slice(0, PALETTE_ROWS);
    return {
      rows: scored.map((x) => ({
        main: x.s.name,
        positions: q ? fuzzyPositions(q, x.s.name) : [],
        sub: symbolSub(x.s),
        badge: x.s.kind,
      })),
      values: scored.map((x) => x.s),
    };
  };

  openPalette({
    placeholder: t("code.pal.symbolsPlaceholder"),
    // The index is a line scanner, not a compiler: a symbol behind a macro is
    // invisible to it. Saying so in the footer costs one line and stops the
    // gap from reading as a bug.
    footer: t("code.pal.footer") + " · " + t("code.symbols.heuristic"),
    fetch: (q) => build(q),
    pick: (v) => {
      const s = v as SymbolHit;
      // Awaited, for the same reason as the search panel: the reveal must not
      // fire while the previous document is still the one on screen.
      void Promise.resolve(deps.openFile(s.path)).then(() => deps.revealLine?.(s.line, 1));
    },
  });
}
