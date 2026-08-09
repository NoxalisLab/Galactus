// buildInlineEditRequest: what leaves the machine, and what is refused.
//
// The property that matters most is the hard budget. A request that busts it
// does not degrade, it comes back as a 400 from the server and the user sees
// nothing but a failure, so the assertions below measure the payload rather
// than trusting the trimming loop.

import {
  BYTES_PER_TOKEN,
  CONTEXT_LINES,
  INLINE_EDIT_CHAR_BUDGET,
  MAX_INSTRUCTION_CHARS,
  SELECTION_CHAR_LIMIT,
  buildInlineEditRequest,
  expandEditRange,
  isProseLanguage,
  languageIdFor,
} from "../../src/code/inline-edit.js";

const NODE_TEST = "node:test";
const NODE_ASSERT = "node:assert/strict";
const { test } = (await import(NODE_TEST)) as {
  test: (name: string, fn: () => unknown) => void;
};
const assert = ((await import(NODE_ASSERT)) as { default: any }).default;

function numbered(count: number, width = 20): string {
  return Array.from({ length: count }, (_, i) => `line ${i}`.padEnd(width, "x")).join("\n");
}

/** Everything the request will put on the wire, minus the fixed preamble. */
function payload(req: { selection: string; before: string; after: string; instruction: string }): number {
  return req.selection.length + req.before.length + req.after.length + req.instruction.length;
}

test("the character budget really is the token budget times 3.0", () => {
  // Mirrors agent.ts. If someone "fixes" this to the usual 4.0, the payload
  // grows by a third and the server starts refusing inline edits.
  assert.equal(BYTES_PER_TOKEN, 3.0);
  assert.equal(INLINE_EDIT_CHAR_BUDGET, Math.floor(2400 * 3.0));
});

test("an empty instruction is refused", () => {
  const req = buildInlineEditRequest({
    doc: "const a = 1;\n",
    range: { from: 0, to: 12 },
    rel: "src/a.ts",
    instruction: "   \n  ",
  });
  assert.equal(req, null);
});

test("a region larger than its share of the budget is refused, never truncated", () => {
  // Truncating the REGION would mean splicing the answer over code the model
  // was never shown.
  const doc = "x".repeat(SELECTION_CHAR_LIMIT + 1);
  const req = buildInlineEditRequest({
    doc,
    range: { from: 0, to: doc.length },
    rel: "src/a.ts",
    instruction: "shorten this",
  });
  assert.equal(req, null);
});

test("a region exactly at the limit is still accepted", () => {
  const doc = "x".repeat(SELECTION_CHAR_LIMIT);
  const req = buildInlineEditRequest({
    doc,
    range: { from: 0, to: doc.length },
    rel: "src/a.ts",
    instruction: "shorten this",
  });
  assert.notEqual(req, null);
  assert.equal(req!.selection.length, SELECTION_CHAR_LIMIT);
});

test("context is bounded to CONTEXT_LINES on each side", () => {
  const doc = numbered(200);
  const range = expandEditRange(doc, doc.indexOf("line 100"), doc.indexOf("line 100"));
  const req = buildInlineEditRequest({ doc, range, rel: "src/a.ts", instruction: "rename it" })!;
  assert.equal(req.before.split("\n").length, CONTEXT_LINES);
  assert.equal(req.after.split("\n").length, CONTEXT_LINES);
  assert.equal(req.trimmed, false);
  assert.equal(req.before.split("\n")[0], "line 76".padEnd(20, "x"));
});

test("context near the top of a file is short, not padded", () => {
  const doc = numbered(200);
  const req = buildInlineEditRequest({
    doc,
    range: expandEditRange(doc, 0, 0),
    rel: "src/a.ts",
    instruction: "rename it",
  })!;
  assert.equal(req.before, "");
  assert.equal(req.after.split("\n").length, CONTEXT_LINES);
});

test("long context lines are dropped until the payload fits the budget", () => {
  // 48 context lines of 400 characters is 19k, far past the budget: the loop
  // has to cut, and it has to cut enough.
  const doc = numbered(200, 400);
  const target = doc.indexOf("line 100");
  const req = buildInlineEditRequest({
    doc,
    range: expandEditRange(doc, target, target),
    rel: "src/a.ts",
    instruction: "rename it",
  })!;
  assert.equal(req.trimmed, true);
  assert.equal(payload(req) <= INLINE_EDIT_CHAR_BUDGET, true);
  assert.equal(req.prompt.includes(req.selection), true);
});

test("a region that fills its whole share still leaves the payload inside the budget", () => {
  const region = "y".repeat(SELECTION_CHAR_LIMIT);
  const doc = numbered(60, 400) + "\n" + region + "\n" + numbered(60, 400);
  const from = doc.indexOf(region);
  const req = buildInlineEditRequest({
    doc,
    range: { from, to: from + region.length },
    rel: "src/a.ts",
    instruction: "z".repeat(MAX_INSTRUCTION_CHARS * 2),
  })!;
  assert.equal(req.instruction.length, MAX_INSTRUCTION_CHARS);
  assert.equal(payload(req) <= INLINE_EDIT_CHAR_BUDGET, true);
});

test("the prompt carries the region verbatim, plus the path and the language", () => {
  const doc = "package main\n\nfunc add(a int, b int) int {\n\treturn a - b\n}\n";
  const from = doc.indexOf("\treturn");
  const req = buildInlineEditRequest({
    doc,
    range: { from, to: from + "\treturn a - b".length },
    rel: "cmd/tool/main.go",
    instruction: "fix the sign",
  })!;
  assert.equal(req.language, "go");
  assert.equal(req.selection, "\treturn a - b");
  assert.equal(req.prompt.includes("\treturn a - b"), true);
  assert.equal(req.prompt.includes("cmd/tool/main.go"), true);
  assert.equal(req.prompt.includes("fix the sign"), true);
  assert.equal(req.startLine, 4);
  assert.equal(req.endLine, 4);
});

test("a multi line region reports the line span it really covers", () => {
  const doc = "a\nb\nc\nd\n";
  const req = buildInlineEditRequest({
    doc,
    range: { from: 2, to: 5 },
    rel: "x.txt",
    instruction: "swap",
  })!;
  assert.equal(req.startLine, 2);
  assert.equal(req.endLine, 3);
});

test("an empty region at an insertion point is a valid request", () => {
  const doc = "x = 1\n\ny = 2\n";
  const caret = doc.indexOf("\n\n") + 1;
  const range = expandEditRange(doc, caret, caret);
  const req = buildInlineEditRequest({ doc, range, rel: "s.py", instruction: "add a helper" })!;
  assert.equal(req.selection, "");
  assert.equal(req.before.includes("x = 1"), true);
  assert.equal(req.after.includes("y = 2"), true);
});

test("the language id names files the editor has no grammar for", () => {
  // langIdFor() in outline.ts returns null for these. The model does not care
  // that CodeMirror cannot highlight Go.
  assert.equal(languageIdFor("a/b/main.go"), "go");
  assert.equal(languageIdFor("Dockerfile.sh"), "shell");
  assert.equal(languageIdFor("src/App.tsx"), "tsx");
  assert.equal(languageIdFor("src/mod.rs"), "rust");
  assert.equal(languageIdFor("deploy/values.yaml"), "yaml");
  // No extension at all, and a dot that belongs to a directory, not a file.
  assert.equal(languageIdFor("Makefile"), "text");
  assert.equal(languageIdFor("my.dir/README"), "text");
  assert.equal(languageIdFor("weird.zzz"), "zzz");
});

test("only prose languages get the prose exemption", () => {
  assert.equal(isProseLanguage(languageIdFor("README.md")), true);
  assert.equal(isProseLanguage(languageIdFor("notes.txt")), true);
  assert.equal(isProseLanguage(languageIdFor("src/a.ts")), false);
});
