// Proof for app/src/code/extensions.ts.
//
// The point of the module is that there is exactly ONE autocompletion and
// exactly ONE keymap in the editor, and that everything a later module needs
// to change is reachable through a compartment. Both are asserted here against
// a real EditorState, built with no DOM.

import { EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { language } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import {
  COMPARTMENT_NAMES,
  autocompleteComp,
  editorExtensions,
  extensionNames,
  intelComp,
  languageComp,
  lintComp,
} from "../../src/code/extensions.js";
import { cmPhrases } from "../../src/code/phrases.js";
import {
  LINT_DELAY_MS,
  clearDiagnosticSources,
  collectDiagnostics,
  diagnosticSourceIds,
  diagnosticsExtension,
  registerDiagnosticSource,
  unregisterDiagnosticSource,
} from "../../src/code/diagnostics.js";

const NODE_TEST = "node:test";
const NODE_ASSERT = "node:assert/strict";
const { test } = (await import(NODE_TEST)) as {
  test: (name: string, fn: () => unknown) => void;
};
const assert = ((await import(NODE_ASSERT)) as { default: any }).default;

let saved = 0;
function opts(lang: "en" | "fr" = "fr") {
  return {
    onSave: () => {
      saved++;
    },
    phrases: cmPhrases(lang),
    language: [javascript({ typescript: true })],
    diagnostics: [diagnosticsExtension(() => "src/a.ts")],
  };
}

test("the extension set builds a real EditorState", () => {
  const state = EditorState.create({ doc: "const a = 1\n", extensions: editorExtensions(opts()) });
  assert.equal(state.doc.toString(), "const a = 1\n");
  // basicSetup's own contribution, kept: multiple selections are allowed.
  assert.equal(state.facet(EditorState.allowMultipleSelections), true);
});

test("basicSetup is fully expanded, once, with the three deliberate additions", () => {
  const names = extensionNames(opts());
  assert.deepEqual(names, [
    "lineNumbers",
    "highlightActiveLineGutter",
    "highlightSpecialChars",
    "history",
    "foldGutter",
    "drawSelection",
    "dropCursor",
    "allowMultipleSelections",
    "indentOnInput",
    "syntaxHighlighting",
    "bracketMatching",
    "closeBrackets",
    "autocompletion",
    "rectangularSelection",
    "crosshairCursor",
    "highlightActiveLine",
    "highlightSelectionMatches",
    "lintGutter",
    "changeGutter",
    "phrases",
    "languageComp",
    "autocompleteComp",
    "lintComp",
    "intelComp",
    "keymap",
  ]);
  // The names are derived from the same array as the extensions, so a drift
  // between the two is impossible; this pins the count.
  assert.equal(editorExtensions(opts()).length, names.length);
  assert.equal(names.filter((n) => n === "autocompletion").length, 1);
  assert.equal(names.filter((n) => n === "keymap").length, 1);
});

test("there is exactly one keymap in the state, and Mod-s comes first in it", () => {
  const state = EditorState.create({ extensions: editorExtensions(opts()) });
  const maps = state.facet(keymap);
  assert.equal(maps.length, 1);

  const bindings = maps[0] as ReadonlyArray<{ key?: string; run?: (v: any) => boolean }>;
  assert.equal(bindings[0].key, "Mod-s");
  assert.equal(bindings.filter((b) => b.key === "Mod-s").length, 1);
  // completionKeymap is in there once, not twice: no second autocompletion
  // dragged its own bindings in.
  assert.equal(bindings.filter((b) => b.key === "Ctrl-Space").length, 1);
  // Tab first accepts a local ghost suggestion, then falls through to normal
  // indentation when no suggestion is visible. Shift-Tab always outdents.
  assert.equal(bindings.filter((b) => b.key === "Tab").length, 2);
  assert.equal(bindings.filter((b) => b.key === "Shift-Tab").length, 1);
  // searchKeymap and lintKeymap made it too.
  assert.ok(bindings.some((b) => b.key === "Mod-f"));
  assert.ok(bindings.some((b) => b.key === "Mod-Shift-m"));

  const before = saved;
  assert.equal(bindings[0].run!({} as any), true);
  assert.equal(saved, before + 1);
});

test("the phrase table reaches the state", () => {
  const fr = EditorState.create({ extensions: editorExtensions(opts("fr")) });
  assert.equal(fr.phrase("Find"), "Rechercher");
  assert.equal(fr.phrase("No diagnostics"), "Aucun diagnostic");
  const en = EditorState.create({ extensions: editorExtensions(opts("en")) });
  assert.equal(en.phrase("Find"), "Find");
});

test("reconfiguring languageComp swaps the active language, in a transaction", () => {
  let state = EditorState.create({ doc: "x = 1\n", extensions: editorExtensions(opts()) });
  // javascript({typescript: true}) reports itself as "typescript".
  assert.equal(state.facet(language)?.name, "typescript");

  state = state.update({ effects: languageComp.reconfigure([python()]) }).state;
  assert.equal(state.facet(language)?.name, "python");

  // Dropping the language leaves a working plain editor, not a broken one.
  state = state.update({ effects: languageComp.reconfigure([]) }).state;
  assert.equal(state.facet(language), null);
  assert.equal(state.facet(keymap).length, 1);
  assert.equal(state.doc.toString(), "x = 1\n");
});

test("the other compartments accept a reconfiguration without a rebuild", () => {
  let state = EditorState.create({ extensions: editorExtensions(opts()) });
  const doc = state.doc;
  state = state.update({
    effects: [
      autocompleteComp.reconfigure([
        EditorState.languageData.of(() => [{ autocomplete: () => null }]),
      ]),
      lintComp.reconfigure([]),
      intelComp.reconfigure([EditorState.tabSize.of(3)]),
    ],
  }).state;
  assert.equal(state.facet(EditorState.tabSize), 3);
  assert.equal(state.facet(keymap).length, 1);
  assert.equal(state.doc, doc);
  assert.deepEqual([...COMPARTMENT_NAMES], [
    "languageComp",
    "autocompleteComp",
    "lintComp",
    "intelComp",
  ]);
});

// ------------------------------------------------------- diagnostics registry
//
// diagnostics.ts has no test file of its own (the module owns five source
// files and four test files), so its registry is proved here, next to the
// extension set it plugs into.

test("the diagnostics registry merges, de-duplicates and orders", async () => {
  clearDiagnosticSources();
  const state = EditorState.create({ doc: "one\ntwo\nthree\n" });

  assert.deepEqual(await collectDiagnostics(state, "src/a.ts"), []);

  registerDiagnosticSource("syntax", async () => [
    { from: 8, to: 12, severity: "error", message: "late" },
    { from: 0, to: 3, severity: "warning", message: "shared" },
  ]);
  registerDiagnosticSource("project", async () => [
    { from: 0, to: 3, severity: "error", message: "shared" }, // same span, same text
    { from: 4, to: 7, severity: "info", message: "middle" },
  ]);
  assert.deepEqual(diagnosticSourceIds(), ["syntax", "project"]);

  const merged = await collectDiagnostics(state, "src/a.ts");
  assert.deepEqual(
    merged.map((d) => [d.from, d.to, d.message]),
    [
      [0, 3, "shared"],
      [4, 7, "middle"],
      [8, 12, "late"],
    ]
  );
  // First writer wins on a duplicate, so registration order is the priority.
  assert.equal(merged[0].severity, "warning");

  unregisterDiagnosticSource("syntax");
  assert.deepEqual(diagnosticSourceIds(), ["project"]);
  assert.equal((await collectDiagnostics(state, "src/a.ts")).length, 2);
  clearDiagnosticSources();
});

test("a source that throws or rejects cannot take the others down", async () => {
  clearDiagnosticSources();
  const state = EditorState.create({ doc: "x" });
  registerDiagnosticSource("boom", () => {
    throw new Error("synchronous failure");
  });
  registerDiagnosticSource("reject", async () => {
    throw new Error("asynchronous failure");
  });
  registerDiagnosticSource("good", async () => [
    { from: 0, to: 1, severity: "error", message: "still here" },
  ]);
  const out = await collectDiagnostics(state, "src/a.ts");
  assert.deepEqual(
    out.map((d) => d.message),
    ["still here"]
  );
  clearDiagnosticSources();
});

test("the linter host is one extension and keeps the 300 ms debounce", () => {
  clearDiagnosticSources();
  assert.equal(LINT_DELAY_MS, 300);
  const state = EditorState.create({
    extensions: editorExtensions({
      onSave: () => {},
      phrases: cmPhrases("en"),
      language: [],
      diagnostics: [diagnosticsExtension(() => null)],
    }),
  });
  // The lint host lives in a compartment, so a document can swap it without a
  // rebuild, and it did not smuggle a second keymap in.
  assert.equal(state.facet(keymap).length, 1);
  const swapped = state.update({ effects: lintComp.reconfigure([]) }).state;
  assert.equal(swapped.facet(keymap).length, 1);
});
