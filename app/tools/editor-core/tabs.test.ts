// Proof for app/src/code/tabs.ts: the rendered strip, character for
// character, including the escaping of a path that carries markup.

import { EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Docs } from "../../src/code/docs.js";
import { DEFAULT_TAB_LABELS, tabsHtml } from "../../src/code/tabs.js";

const NODE_TEST = "node:test";
const NODE_ASSERT = "node:assert/strict";
const { test } = (await import(NODE_TEST)) as {
  test: (name: string, fn: () => unknown) => void;
};
const assert = ((await import(NODE_ASSERT)) as { default: any }).default;

function createState(_rel: string, doc: string, extra: Extension[]): EditorState {
  return EditorState.create({ doc, extensions: extra });
}

function edit(docs: Docs, rel: string, insert: string): void {
  const d = docs.get(rel)!;
  d.state = d.state.update({ changes: { from: 0, insert } }).state;
}

const L = DEFAULT_TAB_LABELS;

test("an empty registry renders nothing at all", () => {
  assert.equal(tabsHtml([], null, new Set()), "");
});

test("a clean, inactive tab is just a name and a cross", () => {
  const docs = new Docs(createState);
  docs.open("src/main.ts", "hello");
  assert.equal(
    tabsHtml(docs.list(), null, new Set()),
    `<div class="ctabs2">` +
      `<div class="ctab2" data-tab2="src/main.ts" title="src/main.ts">` +
      `<span class="nm">main.ts</span>` +
      `<span class="x" data-tabx="src/main.ts" title="${L.close}">×</span>` +
      `</div></div>`
  );
});

test("active, dirty and pending each add their own marker", () => {
  const docs = new Docs(createState);
  docs.open("a/one.ts", "one");
  docs.open("b/two.ts", "two");
  docs.open("c/three.ts", "three");
  edit(docs, "b/two.ts", "!"); // dirty

  const html = tabsHtml(docs.list(), "a/one.ts", new Set(["c/three.ts"]));

  assert.equal(
    html,
    `<div class="ctabs2">` +
      `<div class="ctab2 on" data-tab2="a/one.ts" title="a/one.ts">` +
      `<span class="nm">one.ts</span>` +
      `<span class="x" data-tabx="a/one.ts" title="${L.close}">×</span>` +
      `</div>` +
      `<div class="ctab2 dirty" data-tab2="b/two.ts" title="b/two.ts">` +
      `<span class="nm">two.ts</span>` +
      `<span class="dot" title="${L.unsaved}"></span>` +
      `<span class="x" data-tabx="b/two.ts" title="${L.close}">×</span>` +
      `</div>` +
      `<div class="ctab2 prop" data-tab2="c/three.ts" title="c/three.ts">` +
      `<span class="nm">three.ts</span>` +
      `<span class="prop" title="${L.proposed}">◆</span>` +
      `<span class="x" data-tabx="c/three.ts" title="${L.close}">×</span>` +
      `</div></div>`
  );
});

test("active, dirty and pending combine on the same tab", () => {
  const docs = new Docs(createState);
  docs.open("x.ts", "base", "proposed");
  edit(docs, "x.ts", "typed ");
  const html = tabsHtml(docs.list(), "x.ts", new Set(["x.ts"]));
  assert.ok(html.includes(`<div class="ctab2 on dirty prop" data-tab2="x.ts"`), html);
  assert.equal((html.match(/class="dot"/g) ?? []).length, 1);
  assert.equal((html.match(/◆/g) ?? []).length, 1);
});

test("a document in review is marked pending even without the pending set", () => {
  const docs = new Docs(createState);
  docs.open("x.ts", "base", "proposed");
  const html = tabsHtml(docs.list(), null, new Set());
  assert.ok(html.includes("prop"), html);
});

test("a file the backend refused is never shown as dirty", () => {
  const docs = new Docs(createState);
  docs.openError("bin/blob", "binary file");
  const html = tabsHtml(docs.list(), "bin/blob", new Set());
  assert.ok(!html.includes("dirty"), html);
  assert.ok(!html.includes("class=\"dot\""), html);
});

test("a hostile path cannot break out of the markup", () => {
  const docs = new Docs(createState);
  const rel = 'src/we"ird<script>&.ts';
  docs.open(rel, "x");
  const html = tabsHtml(docs.list(), rel, new Set([rel]));

  assert.ok(!html.includes("<script>"), html);
  assert.ok(html.includes('data-tab2="src/we&quot;ird&lt;script&gt;&amp;.ts"'), html);
  assert.ok(html.includes('title="src/we&quot;ird&lt;script&gt;&amp;.ts"'), html);
  assert.ok(html.includes(">we&quot;ird&lt;script&gt;&amp;.ts<"), html);
  assert.ok(html.includes('data-tabx="src/we&quot;ird&lt;script&gt;&amp;.ts"'), html);
});

test("labels are injected, so the strip is translatable", () => {
  const docs = new Docs(createState);
  docs.open("a.ts", "x", "y");
  edit(docs, "a.ts", "z");
  const html = tabsHtml(docs.list(), "a.ts", new Set(), {
    close: "Fermer",
    unsaved: "non enregistré",
    proposed: "modification proposée",
  });
  assert.ok(html.includes('title="Fermer"'), html);
  assert.ok(html.includes('title="non enregistré"'), html);
  assert.ok(html.includes('title="modification proposée"'), html);
});
