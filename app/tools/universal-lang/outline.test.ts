// Freezes the Lezer node-name table against the INSTALLED @lezer dists.
//
// Every expectation below was read off a real parse, not off memory. That is
// the whole point of this file: @lezer/rust calls a function's name node
// `BoundIdentifier` and @lezer/javascript calls a class's name node
// `VariableDefinition`, and no amount of confidence replaces running the
// parser. If a grammar upgrade renames a node, this file fails loudly and the
// outline does not silently go blank in production.

// @ts-ignore  node:test has no types here, and @types/node is not a dependency
import { test as nodeTest } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";
// @ts-ignore
import { readFileSync, existsSync } from "node:fs";

import { EditorState, Extension } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";

import {
  activeOutlineIndex,
  breadcrumb,
  langIdFor,
  outline,
  outlineHtml,
  outlineIsComplete,
  OUTLINE_BUDGET_MS,
} from "../../src/code/outline.js";
import { tierBadgeHtml, tierFor } from "../../src/code/tiers.js";
import type { OutlineItem } from "../../src/code/outline.js";

// ---------------------------------------------------------------- harness

// treediag.test.ts imports the grammar wiring below, because the ONE thing
// that must never drift is which grammar each extension gets. Node runs every
// test file in its own process, so that import would otherwise register these
// tests a second time inside the neighbour's run. They register only when this
// file is the one node was asked to run.
// @ts-ignore  process is not typed here
const ENTRY: string = (globalThis as any).process?.argv?.[1] ?? "";
const test: typeof nodeTest = ENTRY.endsWith("outline.test.js")
  ? nodeTest
  : (((..._args: unknown[]) => {}) as unknown as typeof nodeTest);

/** The emitted layout depends on rootDir, so the fixtures are found, not assumed. */
function fixtureDir(): URL {
  for (const up of ["../fixtures/", "../../../fixtures/", "../../fixtures/", "../../../../fixtures/"]) {
    const u = new URL(up, import.meta.url);
    if (existsSync(u)) return u;
  }
  throw new Error("fixtures directory not found next to the compiled tests");
}

const FIXTURES = fixtureDir();

export function read(name: string): string {
  return readFileSync(new URL(name, FIXTURES), "utf8") as string;
}

/**
 * The SAME grammar wiring as langFor() in app/src/code.ts. If the two drift,
 * the editor would parse with one grammar while the outline expects another.
 */
export function langExtension(rel: string): Extension {
  const ext = rel.slice(rel.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "ts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "py":
      return python();
    case "rs":
      return rust();
    case "json":
      return json();
    case "md":
    case "markdown":
      return markdown();
    case "html":
    case "htm":
    case "svg":
      return html();
    case "css":
      return css();
    default:
      return [];
  }
}

export function stateFor(rel: string, doc?: string): EditorState {
  return EditorState.create({
    doc: doc ?? read(rel),
    extensions: [langExtension(rel)],
  });
}

function shape(items: OutlineItem[]): Array<{ name: string; kind: string; line: number }> {
  return items.map((i) => ({ name: i.name, kind: i.kind, line: i.line }));
}

function depths(items: OutlineItem[]): number[] {
  return items.map((i) => i.depth);
}

// ---------------------------------------------------------------- the table

test("rust: the name node is BoundIdentifier for a fn and TypeIdentifier for a type", () => {
  const items = outline(stateFor("sample.rs"), "sample.rs", 5000);
  assert.deepEqual(shape(items), [
    { name: "util", kind: "module", line: 3 },
    { name: "Point", kind: "struct", line: 7 },
    { name: "Shape", kind: "enum", line: 12 },
    { name: "Draw", kind: "trait", line: 17 },
    { name: "draw", kind: "function", line: 18 },
    { name: "Draw for Point", kind: "impl", line: 21 },
    { name: "draw", kind: "function", line: 22 },
    { name: "main", kind: "function", line: 25 },
  ]);
  // Nesting comes from ranges, not from tree depth.
  assert.deepEqual(depths(items), [0, 0, 0, 0, 1, 0, 1, 0]);
});

test("python: FunctionDefinition and ClassDefinition, both named by VariableName", () => {
  const items = outline(stateFor("sample.py"), "sample.py", 5000);
  assert.deepEqual(shape(items), [
    { name: "Widget", kind: "class", line: 7 },
    { name: "__init__", kind: "method", line: 8 },
    { name: "render", kind: "method", line: 11 },
    { name: "main", kind: "function", line: 15 },
  ]);
  assert.deepEqual(depths(items), [0, 1, 1, 0]);
});

test("typescript: class and function are VariableDefinition, method is PropertyDefinition", () => {
  const items = outline(stateFor("sample.ts"), "sample.ts", 5000);
  assert.deepEqual(shape(items), [
    { name: "Options", kind: "interface", line: 2 },
    { name: "Engine", kind: "class", line: 6 },
    { name: "start", kind: "method", line: 9 },
    { name: "boot", kind: "function", line: 14 },
    { name: "VERSION", kind: "variable", line: 20 },
  ]);
  // `const e = new Engine()` inside boot() is a VariableDeclaration too, and
  // it must NOT be listed: an outline is not a second copy of the source.
  assert.equal(items.filter((i) => i.name === "e").length, 0);
});

test("json: top-level properties only", () => {
  const items = outline(stateFor("sample.json"), "sample.json", 5000);
  assert.deepEqual(shape(items), [
    { name: "name", kind: "property", line: 2 },
    { name: "version", kind: "property", line: 3 },
    { name: "nested", kind: "property", line: 4 },
    { name: "list", kind: "property", line: 7 },
  ]);
  // "inner" sits one level down and stays out.
  assert.equal(items.filter((i) => i.name === "inner").length, 0);
});

test("markdown: ATXHeading levels drive the depth, prose is ignored", () => {
  const items = outline(stateFor("sample.md"), "sample.md", 5000);
  assert.deepEqual(shape(items), [
    { name: "Galactus", kind: "heading", line: 1 },
    { name: "Install", kind: "heading", line: 5 },
    { name: "Requirements", kind: "heading", line: 9 },
    { name: "Usage", kind: "heading", line: 13 },
  ]);
  assert.deepEqual(depths(items), [0, 1, 2, 1]);
});

test("css: rule set selectors and at-rules", () => {
  const items = outline(stateFor("sample.css"), "sample.css", 5000);
  assert.deepEqual(shape(items), [
    { name: ":root", kind: "rule", line: 1 },
    { name: ".trow", kind: "rule", line: 5 },
    { name: ".trow:hover, .ctree .tn", kind: "rule", line: 9 },
    { name: "@media (max-width: 600px)", kind: "media", line: 14 },
    { name: ".codeside", kind: "rule", line: 15 },
  ]);
  // The rule inside @media nests under it.
  assert.deepEqual(depths(items), [0, 0, 0, 0, 1]);
});

test("html: only elements that carry an id, named tag#id", () => {
  const items = outline(stateFor("sample.html"), "sample.html", 5000);
  assert.deepEqual(shape(items), [
    { name: "div#app", kind: "element", line: 4 },
    { name: "section#main", kind: "element", line: 5 },
    { name: "footer#foot", kind: "element", line: 9 },
  ]);
});

test("a file with no bundled grammar yields no outline, and says nothing", () => {
  const state = stateFor("thing.zig", "fn main() void {}\n");
  assert.deepEqual(outline(state, "thing.zig"), []);
  assert.equal(langIdFor("thing.zig"), null);
});

test("an outline is produced for code that does not compile", () => {
  // The stated limit, asserted: a Lezer tree is not a build.
  const items = outline(stateFor("broken.rs"), "broken.rs", 5000);
  assert.ok(
    items.some((i) => i.name === "ok"),
    "the valid function before the break is still listed"
  );
});

// ---------------------------------------------------------------- budget

/** 20 000 lines of real TypeScript, 4 000 functions. */
function bigDoc(): string {
  const parts: string[] = [];
  for (let i = 0; i < 4000; i++) {
    parts.push(`export function fn${i}(a: number): number {`, `  const b = a + ${i};`, "  return b;", "}", "");
  }
  return parts.join("\n");
}

test("the parse budget is honoured on a 20k line file and yields partial results", () => {
  const doc = bigDoc();
  assert.ok(doc.split("\n").length >= 20000, "fixture is 20k lines");

  // A cold state with a 1 ms budget: the point is that it ANSWERS, not that
  // it answers completely.
  const cold = stateFor("big.ts", doc);
  const t0 = Date.now();
  const partial = outline(cold, "big.ts", 1);
  const coldMs = Date.now() - t0;
  assert.ok(coldMs < 1500, `a 1 ms budget took ${coldMs} ms of wall clock`);
  assert.ok(Array.isArray(partial), "returns a list rather than hanging");

  // The documented budget, on its own cold state.
  const warm = stateFor("big.ts", doc);
  const t1 = Date.now();
  const items = outline(warm, "big.ts", OUTLINE_BUDGET_MS);
  const ms = Date.now() - t1;
  assert.ok(ms < 2000, `the ${OUTLINE_BUDGET_MS} ms budget took ${ms} ms of wall clock`);

  // Re-running converges: whatever was missing gets parsed, never lost.
  const full = outline(warm, "big.ts", 20000);
  assert.ok(full.length >= items.length, `${full.length} < ${items.length} after a bigger budget`);
  assert.equal(full.length, 4000, "every function is found once the parse completes");
  assert.equal(outlineIsComplete(warm), true, "the tree is complete after a full parse");
});

// ---------------------------------------------------------------- pure parts

test("breadcrumb walks the containment chain", () => {
  const state = stateFor("sample.py");
  const items = outline(state, "sample.py", 5000);
  const render = items.find((i) => i.name === "render")!;
  const chain = breadcrumb(items, render.from + 3);
  assert.deepEqual(chain.map((i) => i.name), ["Widget", "render"]);
  assert.deepEqual(breadcrumb(items, 0), []);
});

test("a markdown breadcrumb still works inside the prose of a section", () => {
  const state = stateFor("sample.md");
  const items = outline(state, "sample.md", 5000);
  const doc = read("sample.md");
  const pos = doc.indexOf("None.");
  assert.ok(pos > 0);
  assert.deepEqual(
    breadcrumb(items, pos).map((i) => i.name),
    ["Galactus", "Install", "Requirements"]
  );
});

test("activeOutlineIndex points at the innermost item", () => {
  const state = stateFor("sample.rs");
  const items = outline(state, "sample.rs", 5000);
  const inner = items.findIndex((i) => i.line === 22);
  const item = items[inner];
  assert.equal(activeOutlineIndex(items, item.from + 1), inner);
  assert.equal(activeOutlineIndex(items, 0), -1);
});

test("outlineHtml reuses the existing tree classes and escapes its input", () => {
  const items: OutlineItem[] = [
    { name: '<script>&"', kind: "function", from: 4, to: 10, line: 2, depth: 1 },
  ];
  const h = outlineHtml(items, 0);
  assert.ok(h.includes('class="ctree"'), "reuses .ctree");
  assert.ok(h.includes('class="trow file on"'), "reuses .trow and marks the active row");
  assert.ok(h.includes('data-outline="4"'), "carries the jump offset");
  assert.ok(h.includes("padding-left:21px"), "indents by depth like the file tree");
  assert.ok(!h.includes("<script>"), "escapes markup in a symbol name");
  assert.ok(h.includes("&lt;script&gt;&amp;&quot;"), "escapes every dangerous char");
  assert.equal(outlineHtml([], -1), "", "no rows, no markup");
});

// ---------------------------------------------------------------- tiers

test("tierFor states the asymmetry instead of hiding it", () => {
  assert.equal(tierFor("src/main.ts", true), "A");
  assert.equal(tierFor("src/main.tsx", true), "A");
  assert.equal(tierFor("src/main.js", true), "A");
  // The service is not up yet: honest fallback, not a promise.
  assert.equal(tierFor("src/main.ts", false), "B");
  assert.equal(tierFor("src/lib.rs", true), "B");
  assert.equal(tierFor("main.py", true), "B", "exact syntax, still no types");
  assert.equal(tierFor("README.md", true), "B");
  assert.equal(tierFor("Makefile", true), "none");
  assert.equal(tierFor("a.zig", false), "none");
});

test("tierBadgeHtml is pure and carries the limit in its tooltip", () => {
  const b = tierBadgeHtml("B");
  assert.ok(b.includes('data-tier="B"'));
  assert.ok(b.includes('class="fbadge tier-b"'), "reuses .fbadge");
  assert.ok(b.includes("No types"), `the tooltip states the limit: ${b}`);
  assert.ok(tierBadgeHtml("none").includes("Nothing is analysed"));
  assert.ok(tierBadgeHtml("A").includes("go to definition"));
});
