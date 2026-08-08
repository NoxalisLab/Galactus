// Galactus, Code view: the Python front end of the exact analysis.
//
// For .py files the bundled CPython 3.12 replaces the Lezer tier: it gives the
// real SyntaxError, with CPython's own wording and its own line and column,
// and an outline built from `ast` + `symtable` rather than from node names.
// The interpreter is already in the bundle, so this costs zero added bytes.
//
// WHAT IT STILL CANNOT DO, and the UI copy must say it: no type inference.
// No hover types, no member completion, no go to definition across files.
// Python's types are not in its syntax, and the only way to find them out
// would be to import the user's code, which an offline, permission-gated app
// must never do. Python therefore stays tier B in tiers.ts.
//
// Every call is debounced: a keystroke must not start a process. The Rust side
// kills the in-flight child when a newer request lands on the same path, so a
// fast typist leaves at most one python3 running.

import { invoke } from "@tauri-apps/api/core";
import type { EditorState } from "@codemirror/state";
import type { OutlineItem, OutlineKind } from "./outline.js";
import type { Diagnostic, DiagnosticSource } from "./treediag.js";

// ---------------------------------------------------------------- payload

/** Mirrors PyError in src-tauri/src/pylang.rs. */
export interface PyError {
  kind: "syntax" | "value" | "encoding" | "limit" | "internal" | string;
  message: string;
  /** 1-based. */
  line: number;
  /** CPython's 1-based character offset, when it gave one. */
  offset: number | null;
  /** 0-based character column, ready for the editor. */
  col: number;
  end_line: number;
  end_col: number | null;
  text: string;
}

/** Mirrors PySymbol in src-tauri/src/pylang.rs. */
export interface PySymbol {
  name: string;
  kind: string;
  line: number;
  col: number;
  end_line: number;
  depth: number;
  detail: string;
}

export interface PyScope {
  name: string;
  type: string;
  line: number;
  depth: number;
  nested: boolean;
  params: string[];
  globals: string[];
}

export interface PyAnalysis {
  schema: number;
  ok: boolean;
  path: string;
  python: string;
  error: PyError | null;
  symbols: PySymbol[];
  scopes: PyScope[];
  truncated: boolean;
  limits: { types: boolean; hover_types: boolean; member_completion: boolean };
  elapsed_ms: number;
}

/** Identifier the Python diagnostics are filed under. */
export const PY_LANG_SOURCE = "python";

/** A newer request took over; not an error the user should ever see. */
const SUPERSEDED = "galactus:pylang:superseded";

/**
 * A keystroke must not start a process. 400 ms is long enough that a burst of
 * typing costs one analysis, short enough that a pause feels answered.
 */
export const PY_DEBOUNCE_MS = 400;

export function isPython(rel: string): boolean {
  return rel.toLowerCase().endsWith(".py");
}

// ---------------------------------------------------------------- debounce

interface Waiting {
  source: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: Array<(v: PyAnalysis | null) => void>;
}

/** Last good answer per path, so a superseded call still has something true. */
const cache = new Map<string, { source: string; analysis: PyAnalysis | null }>();
const waiting = new Map<string, Waiting>();

/** Injected so the tests and any headless caller can drive this without Tauri. */
let call: (source: string, path: string) => Promise<PyAnalysis> = (source, path) =>
  invoke<PyAnalysis>("py_analyze", { source, path });

export function setPyInvoker(fn: (source: string, path: string) => Promise<PyAnalysis>): void {
  call = fn;
}

/** Drop everything remembered about a path. Call it when the file closes. */
export function forgetPython(rel: string): void {
  const pending = waiting.get(rel);
  if (pending) {
    clearTimeout(pending.timer);
    for (const resolve of pending.resolve) resolve(null);
    waiting.delete(rel);
  }
  cache.delete(rel);
}

/**
 * Debounced analysis of one buffer. Repeated calls inside the window collapse
 * into one, and all of them resolve with the result for the LAST source seen.
 * Resolves with null rather than throwing: a failed analysis must never take
 * the editor down with it.
 */
export function pyAnalyze(
  rel: string,
  source: string,
  debounceMs: number = PY_DEBOUNCE_MS
): Promise<PyAnalysis | null> {
  const hit = cache.get(rel);
  if (hit && hit.source === source) return Promise.resolve(hit.analysis);

  const pending = waiting.get(rel);
  if (pending) {
    clearTimeout(pending.timer);
    pending.source = source;
  }
  return new Promise<PyAnalysis | null>((resolve) => {
    const entry: Waiting = pending ?? { source, timer: 0 as never, resolve: [] };
    entry.source = source;
    entry.resolve.push(resolve);
    entry.timer = setTimeout(() => {
      waiting.delete(rel);
      const wanted = entry.source;
      const finish = (analysis: PyAnalysis | null) => {
        cache.set(rel, { source: wanted, analysis });
        for (const r of entry.resolve) r(analysis);
      };
      call(wanted, rel).then(finish, (e: unknown) => {
        const msg = String((e as { message?: string })?.message ?? e);
        if (msg.includes(SUPERSEDED)) {
          // A newer buffer is already being analysed. Keep the last good
          // answer instead of blanking the panel under the user.
          for (const r of entry.resolve) r(cache.get(rel)?.analysis ?? null);
          return;
        }
        // eslint-disable-next-line no-console
        console.warn("python analysis failed:", msg);
        finish(null);
      });
    }, debounceMs);
    waiting.set(rel, entry);
  });
}

// ---------------------------------------------------------------- mapping

function offsetAt(state: EditorState, line: number, col: number): number {
  const n = Math.min(Math.max(Math.trunc(line) || 1, 1), state.doc.lines);
  const l = state.doc.line(n);
  return Math.min(l.from + Math.max(Math.trunc(col) || 0, 0), l.to);
}

const KIND: Record<string, OutlineKind> = {
  function: "function",
  "async function": "function",
  method: "method",
  "async method": "method",
  class: "class",
  import: "import",
  variable: "variable",
};

/** CPython's own message, with the offending line dropped: the editor already
 * shows it, underlined, right there. */
function errorMessage(err: PyError): string {
  return err.message.trim() || "syntax error";
}

/**
 * Diagnostics for a .py buffer. Exactly zero or one: CPython stops at the
 * first syntax error, and pretending to know about a second would be a guess.
 */
export async function pyDiagnostics(state: EditorState, rel: string): Promise<Diagnostic[]> {
  if (!isPython(rel)) return [];
  const a = await pyAnalyze(rel, state.doc.toString());
  if (!a || !a.error) return [];
  const from = offsetAt(state, a.error.line, a.error.col);
  const endCol = a.error.end_col;
  let to = endCol !== null ? offsetAt(state, a.error.end_line, endCol) : from;
  if (to <= from) to = Math.min(from + 1, state.doc.length);
  return [
    {
      from,
      to,
      severity: "error",
      message: errorMessage(a.error),
      source: PY_LANG_SOURCE,
    },
  ];
}

/**
 * Outline override for .py. Returns null when there is nothing better to say,
 * which tells the caller to keep the Lezer outline rather than blank the
 * panel: a file that stopped parsing mid-edit must not lose its outline.
 */
export async function pyOutline(state: EditorState, rel: string): Promise<OutlineItem[] | null> {
  if (!isPython(rel)) return null;
  const a = await pyAnalyze(rel, state.doc.toString());
  if (!a || !a.ok) return null;
  return a.symbols.map((s) => {
    const from = offsetAt(state, s.line, s.col);
    const endLine = Math.min(Math.max(s.end_line, s.line), state.doc.lines);
    return {
      name: s.detail && (s.kind.endsWith("function") || s.kind.endsWith("method"))
        ? `${s.name}${s.detail}`
        : s.name,
      kind: KIND[s.kind] ?? "variable",
      from,
      to: state.doc.line(endLine).to,
      line: s.line,
      depth: s.depth,
    };
  });
}

// ---------------------------------------------------------------- registry

/**
 * Wire the Python tier into the app. The registries are owned by another
 * module, so their shape arrives as callbacks: one call in the integrator's
 * setup, no import cycle.
 *
 * The outline override must be consulted BEFORE the Lezer outline for .py and
 * fall back to it when this returns null.
 */
export function registerPyLang(reg: {
  registerDiagnostics(id: string, source: DiagnosticSource): void;
  registerOutline(
    id: string,
    source: (state: EditorState, rel: string) => Promise<OutlineItem[] | null>
  ): void;
}): void {
  reg.registerDiagnostics(PY_LANG_SOURCE, pyDiagnostics);
  reg.registerOutline(PY_LANG_SOURCE, pyOutline);
}
