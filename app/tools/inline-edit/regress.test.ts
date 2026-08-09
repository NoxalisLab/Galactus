// Regressions for the defects found in review, one test per defect.
//
// Every one of these passed the original 65 test suite while the module was
// wrong, which is the whole reason they exist: the first suite was written
// against the implementation's own idea of the edge cases, and these are the
// edge cases the implementation did not have an idea about.

import {
  INLINE_EDIT_CHAR_BUDGET,
  applyInlineEdit,
  buildInlineEditRequest,
  closeInlineEdit,
  closeInlineEditEffect,
  expandEditRange,
  inlineEditExtension,
  inlineEditOpen,
  openInlineEdit,
  normalizeInlineEdit,
  usesCrlf,
  type InlineEditDeps,
} from "../../src/code/inline-edit.js";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

const NODE_TEST = "node:test";
const NODE_ASSERT = "node:assert/strict";
const { test } = (await import(NODE_TEST)) as {
  test: (name: string, fn: () => unknown) => void;
};
const assert = ((await import(NODE_ASSERT)) as { default: any }).default;

const PROSE = { allowProse: true } as const;

// ------------------------------------------------- fence handling in prose

test("a markdown answer that CONTAINS a fence keeps its prose", () => {
  // The original bug: longestFencedBlock ran in prose mode too, so this whole
  // answer collapsed to "npm install foo" and the two paragraphs were filed as
  // deleted in a diff the user is invited to accept with one keystroke.
  const raw =
    "Install the dependency first:\n\n```bash\nnpm install foo\n```\n\nThen import it in your entry point.";
  const out = normalizeInlineEdit(raw, "Old paragraph about install.", PROSE);
  assert.equal(out, raw);
});

test("a prose answer that IS one fence is still unwrapped", () => {
  // The habit case: the model wrapped the whole reply, and the fence is not
  // content the README wants.
  const out = normalizeInlineEdit("```md\n# Title\n\nBody.\n```", "old", PROSE);
  assert.equal(out, "# Title\n\nBody.");
});

test("in a code file the longest fenced block still wins", () => {
  const raw = "before:\n```ts\nold();\n```\nafter:\n```ts\nnew();\nmore();\n```";
  assert.equal(normalizeInlineEdit(raw, "old();"), "new();\nmore();");
});

// ------------------------------------------------- prose openers vs code

test("Go's idiomatic ok identifier is not mistaken for a chat opener", () => {
  assert.equal(normalizeInlineEdit("ok := strings.HasPrefix(s, p)", "ok := false"), "ok := strings.HasPrefix(s, p)");
  assert.equal(normalizeInlineEdit("okay = 1", "okay = 0"), "okay = 1");
  assert.equal(normalizeInlineEdit("note = build_note(user)", "note = None"), "note = build_note(user)");
});

test("a real prose opener is still refused in a code file", () => {
  assert.equal(normalizeInlineEdit("Here is the updated function:\nfoo()", "foo()"), null);
  assert.equal(normalizeInlineEdit("Note: this only works on macOS.", "foo()"), null);
  assert.equal(normalizeInlineEdit("Sure, here you go.", "foo()"), null);
});

// ------------------------------------------------- fences inside comments

test("a fenced example inside a doc comment does not get the answer refused", () => {
  const raw = [
    "/**",
    " * Usage:",
    " * ```ts",
    " * add(1, 2)",
    " * ```",
    " */",
    "export function add(a: number, b: number): number {",
    "  return a + b;",
    "}",
  ].join("\n");
  assert.equal(normalizeInlineEdit(raw, "export function add(a: number, b: number) {}"), raw);
});

test("a fence opened at column zero and never closed is still refused", () => {
  assert.equal(normalizeInlineEdit("```ts\nreturn a + b;", "return a - b;"), null);
});

// ------------------------------------------------- CRLF

test("usesCrlf follows the majority, not the first line", () => {
  assert.equal(usesCrlf("a\r\nb\r\nc\n"), true);
  assert.equal(usesCrlf("a\r\nb\nc\nd\n"), false);
  assert.equal(usesCrlf("no newline at all"), false);
});

test("a multi line edit in a CRLF file stays CRLF", () => {
  const doc = "def f():\r\n    a = 1\r\n    b = 2\r\n    return a\r\n";
  const range = expandEditRange(doc, doc.indexOf("    a = 1"), doc.indexOf("    return a") + 5);
  const applied = applyInlineEdit(doc, range, "    a = 2\n    b = 3\n    return a + b");
  assert.ok(applied);
  assert.equal(applied!.doc, "def f():\r\n    a = 2\r\n    b = 3\r\n    return a + b\r\n");
  assert.ok(!/[^\r]\n/.test(applied!.doc), "no bare LF may survive in a CRLF document");
});

test("an answer that comes back with CRLF is flattened in an LF file", () => {
  const doc = "a = 1\nb = 2\n";
  const applied = applyInlineEdit(doc, { from: 0, to: 5 }, "a = 9\r\nz = 0");
  assert.ok(applied);
  assert.equal(applied!.doc, "a = 9\nz = 0\nb = 2\n");
});

test("a no-op is still detected across the line ending normalisation", () => {
  const doc = "x = 1\r\ny = 2\r\n";
  // The model answered with the region exactly as it was shown it (LF), which
  // after normalisation is byte for byte the region: nothing to propose.
  assert.equal(applyInlineEdit(doc, { from: 0, to: 12 }, "x = 1\ny = 2"), null);
});

// ------------------------------------------------- markdown hard breaks

test("two trailing spaces survive in prose but not in code", () => {
  assert.equal(normalizeInlineEdit("line one  \nline two  \nthree", "old", PROSE), "line one  \nline two  \nthree");
  assert.equal(normalizeInlineEdit("const a = 1;  \nconst b = 2;  ", "old"), "const a = 1;\nconst b = 2;");
});

// ------------------------------------------------- budget

test("the RENDERED prompt fits the budget, preamble included", () => {
  const line = "const filler = 0; // " + "x".repeat(48);
  const doc = Array.from({ length: 400 }, () => line).join("\n") + "\n";
  const starts: number[] = [0];
  for (let i = 0; i < doc.length; i++) if (doc.charCodeAt(i) === 10) starts.push(i + 1);
  const req = buildInlineEditRequest({
    doc,
    range: { from: starts[100], to: starts[160] - 1 },
    rel: "src/big.ts",
    instruction: "r".repeat(600),
  });
  assert.ok(req);
  assert.ok(
    req!.prompt.length <= INLINE_EDIT_CHAR_BUDGET,
    `prompt is ${req!.prompt.length} chars against a ${INLINE_EDIT_CHAR_BUDGET} budget`
  );
  assert.equal(req!.trimmed, true);
  // The region is never what gets cut: it must still be in the prompt whole.
  assert.ok(req!.prompt.includes(req!.selection));
  assert.equal(req!.selection.split("\n").length, 60);
});

test("the line span the user sees and the span the model is told are the same", () => {
  const doc = "x = 1\n\n\n\ny = 2\n";
  const range = expandEditRange(doc, 7, 7);
  assert.deepEqual([range.startLine, range.endLine], [2, 4]);
  const req = buildInlineEditRequest({ doc, range, rel: "a.py", instruction: "add a loop" });
  assert.ok(req);
  assert.equal(req!.startLine, 2);
  assert.equal(req!.endLine, 4);
  assert.ok(req!.prompt.includes("lines 2 to 4"));
});

// ------------------------------------------------- the two commands

/**
 * A view stand-in. The commands only ever touch `state`, `dispatch` and
 * `focus`, so this is enough to exercise the guards that make the module safe
 * to install at Prec.highest, which nothing else in the suite does. Building a
 * real EditorView needs a DOM and would test CodeMirror rather than this.
 */
function fakeView(deps: InlineEditDeps, doc = "function f() {\n  return 1;\n}\n") {
  const view = {
    state: EditorState.create({ doc, extensions: inlineEditExtension(deps, { keys: false }) }),
    focused: 0,
    dispatch(spec: any) {
      view.state = view.state.update(spec).state;
    },
    focus() {
      view.focused++;
    },
  };
  return view;
}

function deps(over: Partial<InlineEditDeps> = {}): InlineEditDeps {
  return {
    file: () => "src/f.ts",
    enabled: () => true,
    reviewing: () => false,
    ask: async () => null,
    propose: () => {},
    t: (k) => k,
    ...over,
  };
}

test("Cmd+K refuses to open while the file is already in review", () => {
  const view = fakeView(deps({ reviewing: () => true }));
  assert.equal(openInlineEdit(view as unknown as EditorView), false);
  assert.equal(inlineEditOpen(view.state), false);
});

test("Cmd+K refuses to open with no model loaded", () => {
  const view = fakeView(deps({ enabled: () => false }));
  assert.equal(openInlineEdit(view as unknown as EditorView), false);
  assert.equal(inlineEditOpen(view.state), false);
});

test("Cmd+K refuses to open on a document with no path", () => {
  const view = fakeView(deps({ file: () => null }));
  assert.equal(openInlineEdit(view as unknown as EditorView), false);
});

test("Cmd+K opens once and the second press does not stack", () => {
  const view = fakeView(deps());
  assert.equal(openInlineEdit(view as unknown as EditorView), true);
  assert.equal(inlineEditOpen(view.state), true);
  assert.equal(openInlineEdit(view as unknown as EditorView), true);
  assert.equal(inlineEditOpen(view.state), true);
});

test("Escape falls through when no box is open, so nothing else is stolen", () => {
  // This is the single load-bearing justification for Prec.highest: at that
  // precedence a command that returned true unconditionally would swallow
  // EVERY Escape in the editor (search panel, multi cursor, completion).
  const view = fakeView(deps());
  assert.equal(closeInlineEdit(view as unknown as EditorView), false);
  assert.equal(view.focused, 0);
});

test("Escape closes an open box and gives the editor its focus back", () => {
  const view = fakeView(deps());
  openInlineEdit(view as unknown as EditorView);
  assert.equal(closeInlineEdit(view as unknown as EditorView), true);
  assert.equal(inlineEditOpen(view.state), false);
  assert.equal(view.focused, 1);
  assert.equal(closeInlineEdit(view as unknown as EditorView), false);
});

test("the close effect on a state that has no box is harmless", () => {
  const view = fakeView(deps());
  view.dispatch({ effects: closeInlineEditEffect.of(null) });
  assert.equal(inlineEditOpen(view.state), false);
});
