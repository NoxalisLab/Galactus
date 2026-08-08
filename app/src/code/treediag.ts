// Galactus, Code view: syntax diagnostics from the Lezer tree.
//
// The grammars are already parsing on every keystroke. When the parser cannot
// continue it plants an error node in the tree; this module walks the tree,
// collects those nodes and turns them into diagnostics. Cost: one tree walk,
// zero added bytes, works offline by construction.
//
// SCOPE, and the UI copy must say exactly this: SYNTAX ONLY. Not types, not
// undefined variables, not unused imports, not a compile. A file with zero
// diagnostics here is a file the grammar could parse, nothing more.
//
// JSON is handled differently. The tree gives an exact RANGE; the JavaScript
// engine's own JSON.parse gives an exact HUMAN MESSAGE. We use both, because
// neither is complete on its own: on this app's WKWebView (JavaScriptCore)
// the thrown message reads "JSON Parse error: Unexpected token ','" with no
// position at all, and on V8 the modern message quotes the text but no longer
// carries "at position N" either. Measured, not assumed.

import type { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { Tree } from "@lezer/common";
import { langIdFor, OUTLINE_BUDGET_MS } from "./outline.js";
import type { LangId } from "./outline.js";

// ---------------------------------------------------------------- contract

export type Severity = "error" | "warning" | "info";

/**
 * The shape a diagnostic source returns. Deliberately independent of
 * @codemirror/lint so this module can be tested headless, and independent of
 * the app's diagnostic registry so the two can be wired without a shared
 * import cycle.
 */
export interface Diagnostic {
  from: number;
  to: number;
  severity: Severity;
  message: string;
  /** Stable id of the producer, shown in the UI so blame is unambiguous. */
  source: string;
}

export type DiagnosticSource = (
  state: EditorState,
  rel: string
) => Diagnostic[] | Promise<Diagnostic[]>;

/** Identifier this module files its diagnostics under. */
export const TREE_DIAG_SOURCE = "syntax";

/** Never flood the gutter: a file that is mid-typing can produce hundreds. */
export const MAX_TREE_DIAGS = 50;

// ---------------------------------------------------------------- messages

// i18n keys, declared in the integration note. `t()` falls back to the key
// itself, so a missing translation is visible rather than silently blank.
const MESSAGE_KEY: Record<LangId, string> = {
  rust: "diag.syntax.rust",
  python: "diag.syntax.python",
  javascript: "diag.syntax.javascript",
  typescript: "diag.syntax.typescript",
  json: "diag.syntax.json",
  markdown: "diag.syntax.markdown",
  html: "diag.syntax.html",
  css: "diag.syntax.css",
};

const FALLBACK: Record<string, string> = {
  "diag.syntax.rust": "Rust syntax: the parser cannot continue here%s.",
  "diag.syntax.python": "Python syntax: the parser cannot continue here%s.",
  "diag.syntax.javascript": "JavaScript syntax: the parser cannot continue here%s.",
  "diag.syntax.typescript": "TypeScript syntax: the parser cannot continue here%s.",
  "diag.syntax.json": "JSON syntax: the parser cannot continue here%s.",
  "diag.syntax.markdown": "Markdown syntax: the parser cannot continue here%s.",
  "diag.syntax.html": "HTML syntax: unclosed or misplaced markup here%s.",
  "diag.syntax.css": "CSS syntax: the parser cannot continue here%s.",
};

/**
 * Translator hook. The app injects `t` from i18n.ts at startup; the tests and
 * any headless caller get the English fallbacks above. Injected rather than
 * imported so this module stays free of DOM and localStorage.
 */
let translate: (key: string) => string = (key) => FALLBACK[key] ?? key;

export function setDiagTranslator(fn: (key: string) => string): void {
  translate = (key) => {
    const s = fn(key);
    // i18n.t() returns the key when the entry is missing.
    return s && s !== key ? s : (FALLBACK[key] ?? key);
  };
}

// ---------------------------------------------------------------- helpers

/** A short quote of the offending text, for "near '…'". */
function nearText(doc: string, from: number, to: number): string {
  let slice = doc.slice(from, Math.min(to > from ? to : from + 24, doc.length));
  slice = slice.split("\n")[0].trim();
  if (!slice) {
    // Zero-width error: quote what follows, which is what the parser choked on.
    slice = doc.slice(from, Math.min(from + 24, doc.length)).split("\n")[0].trim();
  }
  if (!slice) return "";
  if (slice.length > 20) slice = slice.slice(0, 20) + "…";
  return ` near "${slice}"`;
}

/** Lezer error nodes are often zero-width; a diagnostic must cover a char. */
function widen(from: number, to: number, docLength: number): [number, number] {
  if (to > from) return [from, Math.min(to, docLength)];
  if (from < docLength) return [from, from + 1];
  return [Math.max(0, docLength - 1), docLength];
}

function treeWithin(state: EditorState, budgetMs: number): Tree {
  return ensureSyntaxTree(state, state.doc.length, budgetMs) ?? syntaxTree(state);
}

// ---------------------------------------------------------------- JSON

/**
 * Position carried by a JSON.parse message, when the engine bothers to give
 * one. Old V8 said "at position 37"; current V8 and JavaScriptCore do not.
 * Treated as a bonus, never as the only source of truth.
 */
function positionFromMessage(msg: string): number | null {
  const m = /position\s+(\d+)/i.exec(msg);
  return m ? Number(m[1]) : null;
}

function jsonDiagnostics(state: EditorState, doc: string, budgetMs: number): Diagnostic[] {
  if (!doc.trim()) return [];
  try {
    JSON.parse(doc);
    // The engine accepted it: it IS valid JSON, whatever the tree thinks.
    return [];
  } catch (e: any) {
    const message = String(e?.message ?? e);
    // Range: prefer the tree's error node, it is exact and stable.
    const errs = errorNodes(treeWithin(state, budgetMs), doc.length);
    let from: number;
    let to: number;
    if (errs.length) {
      [from, to] = errs[0];
    } else {
      const pos = positionFromMessage(message);
      [from, to] = widen(pos ?? 0, pos ?? 0, doc.length);
    }
    return [{ from, to, severity: "error", message, source: TREE_DIAG_SOURCE }];
  }
}

// ---------------------------------------------------------------- walk

function errorNodes(tree: Tree, docLength: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  tree.iterate({
    enter: (node) => {
      if (!node.type.isError) return;
      out.push(widen(node.from, node.to, docLength));
    },
  });
  return out;
}

// ---------------------------------------------------------------- entry point

/**
 * Syntax diagnostics for the open document. Synchronous and pure: it reads the
 * state, it does not touch the DOM and it does not spawn anything.
 *
 * Files with no bundled grammar return an empty list, which is honest: we did
 * not check, so we claim nothing.
 */
export function treeDiagnostics(
  state: EditorState,
  rel: string,
  budgetMs: number = OUTLINE_BUDGET_MS
): Diagnostic[] {
  const lang = langIdFor(rel);
  if (!lang) return [];
  const doc = state.doc.toString();
  if (!doc) return [];

  if (lang === "json") return jsonDiagnostics(state, doc, budgetMs);

  const key = MESSAGE_KEY[lang];
  const template = translate(key);
  const out: Diagnostic[] = [];
  const seenLines = new Set<number>();

  for (const [from, to] of errorNodes(treeWithin(state, budgetMs), doc.length)) {
    // One diagnostic per line: a broken block plants a cluster of error nodes
    // and fifty squiggles on one statement help nobody.
    const line = state.doc.lineAt(from).number;
    if (seenLines.has(line)) continue;
    seenLines.add(line);
    out.push({
      from,
      to,
      severity: "error",
      message: template.replace("%s", nearText(doc, from, to)),
      source: TREE_DIAG_SOURCE,
    });
    if (out.length >= MAX_TREE_DIAGS) break;
  }
  return out;
}

// ---------------------------------------------------------------- registry

/**
 * Register into the app's diagnostic registry (module M1). The registry is
 * owned elsewhere, so the shape is taken as a callback rather than imported:
 * one line in the integrator's setup, no import cycle, no shared type file.
 *
 *   registerTreeDiagnostics((id, src) => diagRegistry.register(id, src));
 */
export function registerTreeDiagnostics(register: (id: string, source: DiagnosticSource) => void): void {
  register(TREE_DIAG_SOURCE, (state, rel) => treeDiagnostics(state, rel));
}
