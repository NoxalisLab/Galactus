// Syntax diagnostics, proved against the installed grammars.
//
// The FALSE POSITIVE test matters more than the true positive one. A linter
// that squiggles working code is worse than no linter: the user learns to
// ignore the gutter, and the one real error later is lost in the noise. So
// every valid fixture must yield exactly zero, and that assertion is the one
// to keep green at all costs.

// @ts-ignore  node:test has no types here, and @types/node is not a dependency
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import {
  MAX_TREE_DIAGS,
  setDiagTranslator,
  treeDiagnostics,
  TREE_DIAG_SOURCE,
} from "../../src/code/treediag.js";
import type { Diagnostic } from "../../src/code/treediag.js";
import type { EditorState } from "@codemirror/state";
import { read, stateFor } from "./outline.test.js";
import {
  forgetPython,
  isPython,
  pyAnalyze,
  pyDiagnostics,
  pyOutline,
  PY_LANG_SOURCE,
  setPyInvoker,
} from "../../src/code/pylang.js";
import type { PyAnalysis } from "../../src/code/pylang.js";

const VALID = [
  "sample.rs",
  "sample.py",
  "sample.ts",
  "sample.json",
  "sample.md",
  "sample.css",
  "sample.html",
];

function linesOf(state: EditorState, diags: Diagnostic[]): number[] {
  return diags.map((d) => state.doc.lineAt(d.from).number);
}

// ---------------------------------------------------------------- no noise

for (const name of VALID) {
  test(`${name} is clean: not one false positive`, () => {
    const diags = treeDiagnostics(stateFor(name), name, 5000);
    assert.deepEqual(
      diags,
      [],
      `${name} produced ${diags.length} diagnostic(s): ${JSON.stringify(diags)}`
    );
  });
}

test("a file with no bundled grammar is never diagnosed", () => {
  // No grammar means we did not look, so we claim nothing rather than
  // guessing. Silence here is the honest answer.
  const state = stateFor("thing.zig", "this is (((( not any language\n");
  assert.deepEqual(treeDiagnostics(state, "thing.zig"), []);
});

test("an empty buffer is not an error", () => {
  assert.deepEqual(treeDiagnostics(stateFor("empty.rs", ""), "empty.rs"), []);
});

// ---------------------------------------------------------------- real errors

test("broken.rs reports the unclosed parameter list on line 5", () => {
  const state = stateFor("broken.rs");
  const diags = treeDiagnostics(state, "broken.rs", 5000);
  assert.ok(diags.length >= 1, "at least one diagnostic");
  assert.ok(linesOf(state, diags).includes(5), `lines: ${linesOf(state, diags)}`);
  assert.equal(diags[0].severity, "error");
  assert.equal(diags[0].source, TREE_DIAG_SOURCE);
  assert.ok(diags[0].message.startsWith("Rust syntax"), diags[0].message);
  // A Lezer error node is often zero width; a diagnostic must still cover a
  // character or the editor has nothing to underline.
  assert.ok(diags[0].to > diags[0].from, "the range covers at least one character");
});

test("broken.py reports the malformed def on line 5", () => {
  const state = stateFor("broken.py");
  const diags = treeDiagnostics(state, "broken.py", 5000);
  assert.ok(diags.length >= 1);
  assert.ok(linesOf(state, diags).includes(5), `lines: ${linesOf(state, diags)}`);
  assert.ok(diags[0].message.startsWith("Python syntax"), diags[0].message);
});

test("broken.json reports line 3 with the engine's own wording", () => {
  const state = stateFor("broken.json");
  const diags = treeDiagnostics(state, "broken.json", 5000);
  assert.equal(diags.length, 1, "JSON stops at the first error, so exactly one");
  assert.deepEqual(linesOf(state, diags), [3]);
  // The range comes from the tree, the message from JSON.parse: neither
  // engine (V8 or the app's JavaScriptCore) still puts a position in the
  // message, so the tree supplies it.
  assert.match(diags[0].message, /JSON/i, diags[0].message);
  assert.ok(diags[0].to > diags[0].from);
});

test("a trailing comma is caught even though it is only JSON.parse that minds", () => {
  const doc = '{\n  "a": 1,\n}\n';
  const diags = treeDiagnostics(stateFor("trailing.json", doc), "trailing.json", 5000);
  assert.equal(diags.length, 1, `expected one diagnostic, got ${JSON.stringify(diags)}`);
  assert.ok(diags[0].from >= 0 && diags[0].to <= doc.length, "the range is inside the document");
});

test("valid JSON the grammar might quibble with is left alone", () => {
  for (const doc of ['{"a":1}', "[]", '"just a string"', "42", "null", '{"a":{"b":[1,2]}}']) {
    assert.deepEqual(
      treeDiagnostics(stateFor("ok.json", doc), "ok.json", 5000),
      [],
      `JSON.parse accepts ${doc}, so we must too`
    );
  }
});

// ---------------------------------------------------------------- volume

test("a badly broken file yields one diagnostic per line, capped", () => {
  // A file mid-typing can plant a cluster of error nodes on one statement.
  const doc = Array.from({ length: 400 }, (_, i) => `fn f${i}(a: i32 {`).join("\n") + "\n";
  const state = stateFor("mess.rs", doc);
  const diags = treeDiagnostics(state, "mess.rs", 5000);
  assert.ok(diags.length <= MAX_TREE_DIAGS, `${diags.length} diagnostics, cap is ${MAX_TREE_DIAGS}`);
  assert.ok(diags.length > 1, "a file broken 400 times reports more than once");
  const lines = linesOf(state, diags);
  assert.equal(new Set(lines).size, lines.length, "at most one diagnostic per line");
});

test("the parse budget applies to diagnostics too", () => {
  const doc = Array.from({ length: 20000 }, (_, i) => `const v${i} = ${i};`).join("\n") + "\n";
  const t0 = Date.now();
  const diags = treeDiagnostics(stateFor("big.ts", doc), "big.ts", 1);
  const ms = Date.now() - t0;
  assert.ok(Array.isArray(diags));
  assert.ok(ms < 1500, `a 1 ms budget took ${ms} ms of wall clock`);
});

// ---------------------------------------------------------------- i18n

test("the translator is used when the app injects one, with a safe fallback", () => {
  setDiagTranslator((key) => (key === "diag.syntax.rust" ? "Erreur de syntaxe Rust%s." : key));
  try {
    const diags = treeDiagnostics(stateFor("broken.rs"), "broken.rs", 5000);
    assert.ok(diags[0].message.startsWith("Erreur de syntaxe Rust"), diags[0].message);
    // A key with no entry falls back to English rather than showing the key.
    const py = treeDiagnostics(stateFor("broken.py"), "broken.py", 5000);
    assert.ok(py[0].message.startsWith("Python syntax"), py[0].message);
  } finally {
    setDiagTranslator((key) => key);
  }
});

test("the message quotes the offending text so the gutter is readable alone", () => {
  const diags = treeDiagnostics(stateFor("broken.rs"), "broken.rs", 5000);
  assert.match(diags[0].message, /near "/, diags[0].message);
});

// ---------------------------------------------------------------- the limit

test("syntax only: a file that parses but cannot compile is reported clean", () => {
  // The stated limit, asserted. This Rust does not build (no such type, no
  // such function, wrong return type) and this tier says nothing about it.
  const doc = "fn main() -> i32 {\n    let x: Nope = undefined_fn();\n    \"not an i32\"\n}\n";
  assert.deepEqual(
    treeDiagnostics(stateFor("nocompile.rs", doc), "nocompile.rs", 5000),
    [],
    "no types, no name resolution, no compile: only syntax"
  );
  assert.ok(read("sample.rs").length > 0, "fixtures are readable from this test too");
});

// ---------------------------------------------------------------- python tier
//
// The exact Python analysis is proved end to end on the Rust side
// (`cargo test --bin gx-pylang`, which really runs the bundled CPython).
// What is left to prove here is the browser half: the debounce, the cache and
// the mapping from CPython's 1-based line/column onto editor offsets.

function fakeAnalysis(over: Partial<PyAnalysis> = {}): PyAnalysis {
  return {
    schema: 1,
    ok: true,
    path: "x.py",
    python: "3.12.11",
    error: null,
    symbols: [],
    scopes: [],
    truncated: false,
    limits: { types: false, hover_types: false, member_completion: false },
    elapsed_ms: 1,
    ...over,
  };
}

test("a burst of keystrokes costs one analysis, not one per keystroke", async () => {
  forgetPython("burst.py");
  let calls = 0;
  let lastSource = "";
  setPyInvoker(async (source) => {
    calls += 1;
    lastSource = source;
    return fakeAnalysis();
  });
  const a = pyAnalyze("burst.py", "x = 1", 5);
  const b = pyAnalyze("burst.py", "x = 12", 5);
  const c = pyAnalyze("burst.py", "x = 123", 5);
  const results = await Promise.all([a, b, c]);
  assert.equal(calls, 1, "three keystrokes, one process");
  assert.equal(lastSource, "x = 123", "the analysis runs on the LAST buffer seen");
  assert.ok(results.every((r) => r !== null));
  // The same buffer again is served from the cache: no second process.
  await pyAnalyze("burst.py", "x = 123", 5);
  assert.equal(calls, 1, "an unchanged buffer must not spawn anything");
  forgetPython("burst.py");
});

test("a superseded call keeps the last good answer instead of blanking", async () => {
  forgetPython("sup.py");
  setPyInvoker(async () => fakeAnalysis({ symbols: [{ name: "first", kind: "function", line: 1, col: 0, end_line: 1, depth: 0, detail: "()" }] }));
  const first = await pyAnalyze("sup.py", "def first(): pass", 5);
  assert.equal(first?.symbols[0].name, "first");

  setPyInvoker(async () => {
    throw new Error("galactus:pylang:superseded");
  });
  const second = await pyAnalyze("sup.py", "def first(): pas", 5);
  assert.equal(second?.symbols[0].name, "first", "the panel keeps the last true outline");
  forgetPython("sup.py");
});

test("a failed analysis resolves with null rather than taking the editor down", async () => {
  forgetPython("boom.py");
  setPyInvoker(async () => {
    throw new Error("python is on fire");
  });
  assert.equal(await pyAnalyze("boom.py", "x = 1", 5), null);
  forgetPython("boom.py");
});

test("CPython line and column map onto editor offsets exactly", async () => {
  forgetPython("broken.py");
  const doc = read("broken.py");
  const state = stateFor("broken.py", doc);
  setPyInvoker(async () =>
    fakeAnalysis({
      ok: false,
      error: {
        kind: "syntax",
        message: "invalid syntax",
        line: 5,
        offset: 12,
        col: 11,
        end_line: 5,
        end_col: 12,
        text: "def broken(:",
      },
    })
  );
  const diags = await pyDiagnostics(state, "broken.py");
  assert.equal(diags.length, 1);
  assert.equal(diags[0].message, "invalid syntax", "CPython's own wording, not ours");
  assert.equal(diags[0].source, PY_LANG_SOURCE);
  const line5 = state.doc.line(5);
  assert.equal(diags[0].from, line5.from + 11, "0-based column, straight from the payload");
  assert.equal(diags[0].to, line5.from + 12);
  assert.equal(doc.slice(diags[0].from, diags[0].to), ":", "the squiggle lands on the colon");
  forgetPython("broken.py");
});

test("the python outline overrides the grammar one, and steps aside when it cannot", async () => {
  forgetPython("sample.py");
  const state = stateFor("sample.py");
  setPyInvoker(async () =>
    fakeAnalysis({
      symbols: [
        { name: "os", kind: "import", line: 3, col: 0, end_line: 3, depth: 0, detail: "os" },
        { name: "Widget", kind: "class", line: 7, col: 0, end_line: 12, depth: 0, detail: "" },
        { name: "render", kind: "method", line: 11, col: 4, end_line: 12, depth: 1, detail: "(self)" },
      ],
    })
  );
  const items = await pyOutline(state, "sample.py");
  assert.ok(items);
  assert.deepEqual(
    items!.map((i) => ({ name: i.name, kind: i.kind, line: i.line, depth: i.depth })),
    [
      { name: "os", kind: "import", line: 3, depth: 0 },
      { name: "Widget", kind: "class", line: 7, depth: 0 },
      // The signature rides along: an outline row that says (self) beats one
      // that only says render.
      { name: "render(self)", kind: "method", line: 11, depth: 1 },
    ]
  );
  assert.equal(items![2].from, state.doc.line(11).from + 4, "indentation is a real column");

  forgetPython("sample.py");
  setPyInvoker(async () => fakeAnalysis({ ok: false }));
  assert.equal(
    await pyOutline(state, "sample.py"),
    null,
    "a file that stopped parsing keeps its grammar outline instead of going blank"
  );
  forgetPython("sample.py");
});

test("the python tier only claims .py", async () => {
  assert.equal(isPython("a/b/c.py"), true);
  assert.equal(isPython("a/b/c.pyi"), false);
  assert.equal(isPython("a/b/c.rs"), false);
  assert.deepEqual(await pyDiagnostics(stateFor("sample.rs"), "sample.rs"), []);
  assert.equal(await pyOutline(stateFor("sample.rs"), "sample.rs"), null);
});
