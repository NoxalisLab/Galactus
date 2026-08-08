// Galactus, CodeMirror wiring for the TypeScript language service.
//
// All of this is already paid for. `hoverTooltip`, the completion machinery and
// the lint gutter come in with `basicSetup`, which the Code view already loads,
// so the whole feature costs a handful of adapters and no new bytes.
//
// One choice worth naming: completions are registered through
// `Language.data.of({autocomplete})` rather than `autocompletion({override})`.
// `override` REPLACES every source, which would silently kill the snippet and
// word completions the JavaScript grammar already provides; `data.of` adds to
// them, so a Tier B workspace and a Tier A workspace differ by what is gained,
// never by what disappeared.
//
// Nothing here writes a file, and nothing here calls the model. Go to
// definition moves the cursor, references paint a list, rename produces
// proposals somebody else has to approve.

import type { Extension } from "@codemirror/state";
import { EditorView, hoverTooltip, keymap, type Tooltip } from "@codemirror/view";
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import type { Language, LanguageSupport } from "@codemirror/language";
import type { Diagnostic } from "@codemirror/lint";

import type { Diag, RefHit } from "./protocol.js";
import * as svc from "./client.js";

export interface TsBindingDeps {
  /** The open file, relative to the workspace root, or null when the editor
   *  holds something the language service does not know about. */
  file(): string | null;
  /** Open a file and put the cursor there. The Code view already has this. */
  openFile(rel: string, line: number, col: number): void;
  /** Show the references list. `html` comes from `referencesHtml`. */
  showReferences?(html: string, hits: RefHit[]): void;
  /** Translate a UI string. Falls back to the English literal when absent, so
   *  this module never blocks on the i18n table landing. */
  t?(key: string, fallback: string): string;
}

function tr(deps: TsBindingDeps, key: string, fallback: string): string {
  return deps.t ? deps.t(key, fallback) : fallback;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

// ---------------------------------------------------------------- hover

/** `getQuickInfoAtPosition`, as a CodeMirror tooltip. */
export function tsHover(deps: TsBindingDeps): Extension {
  return hoverTooltip(async (view, pos): Promise<Tooltip | null> => {
    const rel = deps.file();
    if (!rel || svc.tier() !== "A") return null;
    const info = await svc.hover(rel, pos);
    if (!info || !info.signature) return null;
    return {
      pos: info.start,
      end: info.start + info.length,
      above: true,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "ts-hover";
        dom.innerHTML =
          `<div class="sig mono">${esc(info.signature)}</div>` +
          (info.docs ? `<div class="doc">${esc(info.docs)}</div>` : "") +
          (info.tags.length ? `<div class="tags">${info.tags.map((t) => esc(t)).join("<br>")}</div>` : "");
        return { dom };
      },
    };
  });
}

// ---------------------------------------------------------------- completion

/** TypeScript's completion kinds, mapped onto the icons CodeMirror draws. */
function completionType(kind: string): string {
  switch (kind) {
    case "method":
    case "function":
    case "local function":
    case "constructor":
      return "function";
    case "property":
    case "getter":
    case "setter":
      return "property";
    case "var":
    case "let":
    case "const":
    case "local var":
    case "parameter":
    case "alias":
      return "variable";
    case "class":
      return "class";
    case "interface":
    case "type":
    case "type parameter":
      return "type";
    case "enum":
    case "enum member":
      return "enum";
    case "keyword":
      return "keyword";
    case "module":
    case "external module name":
      return "namespace";
    default:
      return "text";
  }
}

export function tsCompletionSource(deps: TsBindingDeps): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const rel = deps.file();
    if (!rel || svc.tier() !== "A") return null;
    const word = context.matchBefore(/[\w$]*/);
    // After a dot there is no word to match, and refusing there would kill the
    // one completion people actually wait for.
    const dot = context.matchBefore(/\.\s*$/);
    if (!dot && (!word || (word.from === word.to && !context.explicit))) return null;
    const items = await svc.completions(rel, context.pos);
    if (!items.length) return null;
    const options: Completion[] = items.map((e) => ({
      label: e.name,
      apply: e.insertText,
      type: completionType(e.kind),
      // TypeScript has already sorted these by relevance; keeping its order
      // beats re-sorting them alphabetically, which is what happens by default.
      boost: e.sortText.startsWith("0") ? 1 : 0,
      detail: e.hasAction ? tr(deps, "tsintel.needsImport", "needs an import") : undefined,
    }));
    return { from: word ? word.from : context.pos, options, validFor: /^[\w$]*$/ };
  };
}

/**
 * Add the source to a language WITHOUT replacing what it already offers.
 * `support.language.data.of(...)` is the documented way to extend a language's
 * facets; `autocompletion({override})` is not, and it is the mistake that turns
 * "TypeScript completions" into "TypeScript completions and nothing else".
 */
export function tsCompletion(language: Language, deps: TsBindingDeps): Extension {
  return language.data.of({ autocomplete: tsCompletionSource(deps) });
}

// ---------------------------------------------------------------- diagnostics

function severityOf(d: Diag): Diagnostic["severity"] {
  if (d.category === "error") return "error";
  if (d.category === "warning") return "warning";
  return "info";
}

/**
 * A diagnostic provider in the shape the Code view's own registry expects:
 * given a file and its text, return CodeMirror diagnostics. Registered by the
 * integrator with `registerDiagnosticSource('ts', tsDiagnosticSource(deps))` so
 * that TypeScript errors sit alongside whatever else the view already reports
 * rather than replacing it.
 */
export function tsDiagnosticSource(
  _deps: TsBindingDeps
): (rel: string, text: string) => Promise<Diagnostic[]> {
  return async (rel: string, text: string): Promise<Diagnostic[]> => {
    if (svc.tier() !== "A") return [];
    // The service answers about the buffer it was last told about, so tell it
    // first. Cheap when the text has not changed: the host compares before it
    // bumps a version.
    svc.updateBuffer(rel, text);
    const diags = await svc.diagnostics(rel);
    return diags.map((d) => ({
      from: Math.min(d.start, text.length),
      to: Math.min(d.start + d.length, text.length),
      severity: severityOf(d),
      source: `ts(${d.code})`,
      message: d.message,
    }));
  };
}

// ---------------------------------------------------------------- navigation

/** Go to definition at an offset. Returns false when there is nowhere to go,
 *  so a keymap entry can fall through to whatever else is bound. */
export async function gotoDefinition(deps: TsBindingDeps, pos: number): Promise<boolean> {
  const rel = deps.file();
  if (!rel || svc.tier() !== "A") return false;
  const defs = await svc.definition(rel, pos);
  if (!defs.length) return false;
  const d = defs[0];
  deps.openFile(d.rel, d.line, d.col);
  return true;
}

/** Find references at an offset and hand the rendered list to the view. */
export async function findReferences(deps: TsBindingDeps, pos: number): Promise<RefHit[]> {
  const rel = deps.file();
  if (!rel || svc.tier() !== "A") return [];
  const hits = await svc.references(rel, pos);
  deps.showReferences?.(referencesHtml(hits, deps), hits);
  return hits;
}

/**
 * The references list, as pure HTML. Pure so it can be asserted in a test
 * without a document: the grouping and the escaping are the parts that break.
 */
export function referencesHtml(hits: readonly RefHit[], deps?: TsBindingDeps): string {
  const label = (k: string, f: string) => (deps ? tr(deps, k, f) : f);
  if (!hits.length) return `<div class="ts-refs empty">${esc(label("tsintel.noRefs", "no references"))}</div>`;
  const byFile = new Map<string, RefHit[]>();
  for (const h of hits) {
    const list = byFile.get(h.rel);
    if (list) list.push(h);
    else byFile.set(h.rel, [h]);
  }
  let out = `<div class="ts-refs"><div class="rh">${esc(
    label("tsintel.refCount", "%n references in %f files")
      .replace("%n", String(hits.length))
      .replace("%f", String(byFile.size))
  )}</div>`;
  for (const rel of [...byFile.keys()].sort()) {
    const rows = byFile.get(rel)!.slice().sort((a, b) => a.start - b.start);
    out += `<div class="rf"><div class="fn mono">${esc(rel)}</div>`;
    for (const h of rows) {
      out +=
        `<div class="rr${h.isDefinition ? " def" : ""}${h.isWrite ? " write" : ""}" ` +
        `data-ref-file="${esc(h.rel)}" data-ref-line="${h.line}" data-ref-col="${h.col}">` +
        `<span class="ln">${h.line}</span><span class="tx mono">${esc(h.text.trim())}</span></div>`;
    }
    out += `</div>`;
  }
  return out + `</div>`;
}

/** F12 for definition, Shift-F12 for references, and Cmd-click for definition,
 *  which is the gesture everybody tries first. */
export function tsNavigation(deps: TsBindingDeps): Extension {
  return [
    keymap.of([
      {
        key: "F12",
        run: (view) => {
          void gotoDefinition(deps, view.state.selection.main.head);
          return true;
        },
      },
      {
        key: "Shift-F12",
        run: (view) => {
          void findReferences(deps, view.state.selection.main.head);
          return true;
        },
      },
    ]),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (!event.metaKey || event.button !== 0) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        event.preventDefault();
        void gotoDefinition(deps, pos);
        return true;
      },
    }),
  ];
}

// ---------------------------------------------------------------- assembly

/**
 * Everything at once, for a language the Code view already built. Spread the
 * result into the editor's extension list next to `langFor(path)`:
 *
 *   const support = javascript({ typescript: true });
 *   ...support ? [support, ...tsIntelExtensions(support, deps)] : []
 *
 * Safe to include when the tier is B: every binding checks and returns nothing.
 */
export function tsIntelExtensions(support: LanguageSupport, deps: TsBindingDeps): Extension[] {
  return [tsCompletion(support.language, deps), tsHover(deps), tsNavigation(deps)];
}
