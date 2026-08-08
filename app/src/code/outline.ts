// Galactus, Code view: the document outline, for free.
//
// Every grammar the editor already loads (@codemirror/lang-*) keeps a Lezer
// parse tree up to date on every keystroke, and until now nothing read it.
// This module turns that parse into an outline, a breadcrumb and a set of
// rows, at zero added bytes: no new dependency, no index, no daemon.
//
// WHAT THIS TIER CANNOT DO, and the UI must say so:
//   - no types, no inference, no signatures beyond the raw source text;
//   - no cross-file resolution and no import following;
//   - no way to tell two same-named identifiers apart;
//   - a tree is produced for code that does not compile, so an outline here
//     is never proof that the file builds.
//
// The node names below are NOT from memory. They were read off the installed
// @lezer dists by parsing tools/universal-lang/fixtures/* and printing the
// tree, and they are frozen by tools/universal-lang/outline.test.ts. A Rust
// function's name node is `BoundIdentifier`, not `Identifier`; a TypeScript
// class's name node is `VariableDefinition`, not `TypeDefinition`. Change the
// table only with a fixture and a test in the same commit.

import type { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import type { SyntaxNode, SyntaxNodeRef, Tree } from "@lezer/common";

// ---------------------------------------------------------------- types

export type OutlineKind =
  | "function"
  | "method"
  | "class"
  | "struct"
  | "enum"
  | "trait"
  | "impl"
  | "module"
  | "interface"
  | "variable"
  // Produced by the exact Python analysis (pylang.ts), not by the Lezer
  // tables below: an outline that hides the imports hides half the file.
  | "import"
  | "heading"
  | "rule"
  | "media"
  | "property"
  | "element";

export interface OutlineItem {
  /** Display name, already trimmed. Never empty. */
  name: string;
  kind: OutlineKind;
  /** Document offset the row jumps to. */
  from: number;
  /** End of the construct, used by `breadcrumb`. */
  to: number;
  /** 1-based line of `from`. */
  line: number;
  /** Nesting level, 0 at the top of the file. */
  depth: number;
}

/**
 * The grammars the editor actually loads. This table MIRRORS `langFor()` in
 * app/src/code.ts: if that one changes, this one must change with it, because
 * claiming a grammar the editor never installed yields an empty tree and a
 * silently empty outline.
 */
export type LangId = "rust" | "python" | "javascript" | "typescript" | "json" | "markdown" | "html" | "css";

export function langIdFor(rel: string): LangId | null {
  const ext = rel.slice(rel.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return "javascript";
    case "ts":
    case "tsx":
      return "typescript";
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "json":
      return "json";
    case "md":
    case "markdown":
      return "markdown";
    case "html":
    case "htm":
    case "svg":
      return "html";
    case "css":
      return "css";
    default:
      return null;
  }
}

// ---------------------------------------------------------------- parse budget

/**
 * How long `outline()` may spend forcing the parse forward. The tree is lazy
 * and only guaranteed up to the viewport: on a 20k-line file a full parse can
 * cost hundreds of milliseconds, which would stutter every keystroke. We ask
 * for the whole document with a 50 ms cap, take whatever came back, and let
 * the caller re-run when `outlineIsComplete()` flips.
 */
export const OUTLINE_BUDGET_MS = 50;

/** True when the parse covers the whole document, so the outline is final. */
export function outlineIsComplete(state: EditorState): boolean {
  return syntaxTreeAvailable(state, state.doc.length);
}

function treeWithin(state: EditorState, budgetMs: number): Tree {
  // ensureSyntaxTree returns null when the budget ran out; syntaxTree then
  // gives the partial tree parsed so far, which is a partial outline rather
  // than none at all.
  return ensureSyntaxTree(state, state.doc.length, budgetMs) ?? syntaxTree(state);
}

// ---------------------------------------------------------------- helpers

function textOf(doc: string, n: { from: number; to: number }): string {
  return doc.slice(n.from, n.to);
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function unquote(s: string): string {
  return s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]
    ? s.slice(1, -1)
    : s;
}

/** Text of the first direct child of one of `types`, or null. */
function childText(doc: string, node: SyntaxNode, ...types: string[]): string | null {
  for (const ty of types) {
    const c = node.getChild(ty);
    if (c) {
      const s = textOf(doc, c).trim();
      if (s) return s;
    }
  }
  return null;
}

/** Header text: everything from the node start up to its `stop` child. */
function headerText(doc: string, node: SyntaxNode, stop: string): string {
  const body = node.getChild(stop);
  return collapse(doc.slice(node.from, body ? body.from : node.to));
}

interface Hit {
  name: string;
  kind: OutlineKind;
  /** Markdown only: forces the depth instead of deriving it from nesting. */
  fixedDepth?: number;
}

// ---------------------------------------------------------------- tables

function rustHit(doc: string, node: SyntaxNodeRef): Hit | null {
  const n = node.node;
  switch (node.name) {
    case "FunctionItem": {
      const name = childText(doc, n, "BoundIdentifier");
      return name ? { name, kind: "function" } : null;
    }
    case "StructItem": {
      const name = childText(doc, n, "TypeIdentifier");
      return name ? { name, kind: "struct" } : null;
    }
    case "EnumItem": {
      const name = childText(doc, n, "TypeIdentifier");
      return name ? { name, kind: "enum" } : null;
    }
    case "TraitItem": {
      const name = childText(doc, n, "TypeIdentifier");
      return name ? { name, kind: "trait" } : null;
    }
    case "ModItem": {
      const name = childText(doc, n, "BoundIdentifier");
      return name ? { name, kind: "module" } : null;
    }
    case "ImplItem": {
      // Read the header rather than the TypeIdentifier children: with
      // generics (`impl<T> Draw for Point<T>`) the names sit inside
      // GenericType and are no longer direct children.
      const head = headerText(doc, n, "DeclarationList").replace(/^impl\b\s*/, "");
      return head ? { name: head, kind: "impl" } : null;
    }
    default:
      return null;
  }
}

function pythonHit(doc: string, node: SyntaxNodeRef): Hit | null {
  const n = node.node;
  if (node.name === "FunctionDefinition") {
    const name = childText(doc, n, "VariableName");
    return name ? { name, kind: "function" } : null;
  }
  if (node.name === "ClassDefinition") {
    const name = childText(doc, n, "VariableName");
    return name ? { name, kind: "class" } : null;
  }
  return null;
}

function scriptHit(doc: string, node: SyntaxNodeRef): Hit | null {
  const n = node.node;
  switch (node.name) {
    case "FunctionDeclaration": {
      const name = childText(doc, n, "VariableDefinition");
      return name ? { name, kind: "function" } : null;
    }
    case "ClassDeclaration": {
      const name = childText(doc, n, "VariableDefinition");
      return name ? { name, kind: "class" } : null;
    }
    case "MethodDeclaration": {
      const name = childText(doc, n, "PropertyDefinition");
      return name ? { name, kind: "method" } : null;
    }
    case "InterfaceDeclaration": {
      const name = childText(doc, n, "TypeDefinition");
      return name ? { name, kind: "interface" } : null;
    }
    case "VariableDeclaration": {
      // Only the ones at the top of the file. Every `const` inside a function
      // body is a VariableDeclaration too, and listing them turns the outline
      // into a second copy of the source.
      const parent = n.parent?.name;
      if (parent !== "Script" && parent !== "ExportDeclaration") return null;
      const name = childText(doc, n, "VariableDefinition");
      return name ? { name, kind: "variable" } : null;
    }
    default:
      return null;
  }
}

function markdownHit(doc: string, node: SyntaxNodeRef): Hit | null {
  const m = /^ATXHeading([1-6])$/.exec(node.name);
  if (!m) return null;
  const name = collapse(textOf(doc, node).replace(/^\s*#+\s*/, "").replace(/\s+#+\s*$/, ""));
  return name ? { name, kind: "heading", fixedDepth: Number(m[1]) - 1 } : null;
}

function cssHit(doc: string, node: SyntaxNodeRef): Hit | null {
  const n = node.node;
  if (node.name === "RuleSet") {
    const name = headerText(doc, n, "Block");
    return name ? { name, kind: "rule" } : null;
  }
  if (node.name === "MediaStatement") {
    const name = headerText(doc, n, "Block");
    return name ? { name, kind: "media" } : null;
  }
  return null;
}

function jsonHit(doc: string, node: SyntaxNodeRef): Hit | null {
  if (node.name !== "Property") return null;
  const n = node.node;
  // Top level only: the whole point of a JSON outline is the shape of the
  // root object, not every leaf of a 4000-line config.
  if (n.parent?.name !== "Object" || n.parent.parent?.name !== "JsonText") return null;
  const raw = childText(doc, n, "PropertyName");
  const name = raw ? unquote(raw) : null;
  return name ? { name, kind: "property" } : null;
}

function htmlHit(doc: string, node: SyntaxNodeRef): Hit | null {
  if (node.name !== "Element") return null;
  const open = node.node.getChild("OpenTag") ?? node.node.getChild("SelfClosingTag");
  if (!open) return null;
  const tag = childText(doc, open, "TagName");
  if (!tag) return null;
  for (const attr of open.getChildren("Attribute")) {
    const key = childText(doc, attr, "AttributeName");
    if (key !== "id") continue;
    const val = childText(doc, attr, "AttributeValue");
    if (!val) continue;
    return { name: `${tag}#${unquote(val)}`, kind: "element" };
  }
  return null;
}

const TABLES: Record<LangId, (doc: string, node: SyntaxNodeRef) => Hit | null> = {
  rust: rustHit,
  python: pythonHit,
  javascript: scriptHit,
  typescript: scriptHit,
  json: jsonHit,
  markdown: markdownHit,
  html: htmlHit,
  css: cssHit,
};

// ---------------------------------------------------------------- outline

/**
 * The outline of the open document. Pure with respect to the editor: it reads
 * the state and returns rows, it never touches the DOM.
 *
 * Returns an empty list for a file whose extension has no bundled grammar,
 * which is the honest answer: no grammar, no outline, and `tierFor()` says so
 * in the header.
 */
export function outline(
  state: EditorState,
  rel: string,
  budgetMs: number = OUTLINE_BUDGET_MS
): OutlineItem[] {
  const lang = langIdFor(rel);
  if (!lang) return [];
  const hitOf = TABLES[lang];
  const doc = state.doc.toString();
  if (!doc) return [];

  const tree = treeWithin(state, budgetMs);
  const items: OutlineItem[] = [];
  // Nesting is derived from ranges, not from the tree depth: only matched
  // nodes count, so a method inside a class inside a module reads 0/1/2 even
  // though a dozen unmatched nodes sit between them.
  const stack: OutlineItem[] = [];

  tree.iterate({
    enter: (node) => {
      const hit = hitOf(doc, node);
      if (!hit) return;
      while (stack.length && stack[stack.length - 1].to <= node.from) stack.pop();
      // A def inside a class is a method, whatever the grammar calls the node.
      // The Python grammar has one FunctionDefinition for both cases, and an
      // outline that cannot tell them apart is harder to read than one that
      // can.
      const enclosing = stack[stack.length - 1];
      const kind: OutlineKind =
        hit.kind === "function" && enclosing?.kind === "class" ? "method" : hit.kind;
      const item: OutlineItem = {
        name: hit.name,
        kind,
        from: node.from,
        to: node.to,
        line: state.doc.lineAt(node.from).number,
        depth: hit.fixedDepth ?? stack.length,
      };
      items.push(item);
      stack.push(item);
    },
  });

  if (lang === "markdown") extendHeadings(items, doc.length);
  return items;
}

/**
 * A Markdown heading node covers its own line and nothing else, so a cursor in
 * the prose below would have an empty breadcrumb. Stretch every heading to the
 * next heading of the same or a shallower level, which is what a reader means
 * by "the section I am in".
 */
function extendHeadings(items: OutlineItem[], docLength: number): void {
  for (let i = 0; i < items.length; i++) {
    let end = docLength;
    for (let j = i + 1; j < items.length; j++) {
      if (items[j].depth <= items[i].depth) {
        end = items[j].from;
        break;
      }
    }
    items[i].to = Math.max(items[i].to, end);
  }
}

/** The chain of items containing `pos`, outermost first. */
export function breadcrumb(items: OutlineItem[], pos: number): OutlineItem[] {
  const chain: OutlineItem[] = [];
  for (const it of items) {
    if (it.from > pos) break;
    if (pos >= it.to) continue;
    while (chain.length && chain[chain.length - 1].depth >= it.depth) chain.pop();
    chain.push(it);
  }
  return chain;
}

/** The index in `items` of the innermost item containing `pos`, or -1. */
export function activeOutlineIndex(items: OutlineItem[], pos: number): number {
  let best = -1;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.from > pos) break;
    if (pos < it.to) best = i;
  }
  return best;
}

// ---------------------------------------------------------------- rendering

const GLYPH: Record<OutlineKind, string> = {
  function: "ƒ",
  method: "ƒ",
  class: "◈",
  struct: "▢",
  enum: "⊞",
  trait: "◇",
  impl: "⊕",
  module: "▤",
  interface: "◇",
  variable: "•",
  import: "↧",
  heading: "#",
  rule: "{",
  media: "@",
  property: "·",
  element: "<",
};

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/**
 * Rows for the outline panel. Pure string in, string out, so it is testable
 * without a DOM. Reuses `.ctree` / `.trow` / `.tw` / `.tn` from styles.css:
 * this module adds no CSS of its own.
 *
 * `activeIndex` is the row to highlight (-1 for none). Each row carries
 * `data-outline` with the document offset to jump to.
 */
export function outlineHtml(items: OutlineItem[], activeIndex: number): string {
  if (!items.length) return "";
  let out = '<div class="ctree">';
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const pad = 8 + it.depth * 13;
    out +=
      `<div class="trow file ${i === activeIndex ? "on" : ""}" data-outline="${it.from}" ` +
      `data-outline-line="${it.line}" style="padding-left:${pad}px" ` +
      `title="${esc(it.name)} · ${it.kind} · ${it.line}">` +
      `<span class="tw">${esc(GLYPH[it.kind])}</span>` +
      `<span class="tn">${esc(it.name)}</span></div>`;
  }
  return out + "</div>";
}
