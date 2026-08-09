// normalizeInlineEdit and applyInlineEdit: the two places where a bad model
// answer becomes a corrupted file.
//
// Everything downstream files a diff the user can accept with one keystroke,
// so these tests are written from the failure side: each one describes an
// answer a local model really produces, and asserts that it is refused.

import {
  MAX_ANSWER_CHARS,
  applyInlineEdit,
  normalizeInlineEdit,
  realignIndent,
} from "../../src/code/inline-edit.js";

const NODE_TEST = "node:test";
const NODE_ASSERT = "node:assert/strict";
const { test } = (await import(NODE_TEST)) as {
  test: (name: string, fn: () => unknown) => void;
};
const assert = ((await import(NODE_ASSERT)) as { default: any }).default;

const ORIGINAL = "  return a - b;";

test("a plain code answer comes back untouched", () => {
  assert.equal(normalizeInlineEdit("  return a + b;", ORIGINAL), "  return a + b;");
});

test("a fenced answer loses its fence and its language tag", () => {
  const raw = "```typescript\n  return a + b;\n```";
  assert.equal(normalizeInlineEdit(raw, ORIGINAL), "  return a + b;");
});

test("tilde fences are stripped too", () => {
  assert.equal(normalizeInlineEdit("~~~\n  return a + b;\n~~~", ORIGINAL), "  return a + b;");
});

test("when a model shows the old snippet then the new one, the longest wins", () => {
  // The short block is the "before" the model quoted back; the long one is the
  // answer. Taking the first block would replace the region with itself.
  const raw = [
    "Before:",
    "```ts",
    "  return a - b;",
    "```",
    "After:",
    "```ts",
    "  const sum = a + b;",
    "  return sum;",
    "```",
  ].join("\n");
  assert.equal(normalizeInlineEdit(raw, ORIGINAL), "  const sum = a + b;\n  return sum;");
});

test("reasoning is dropped and the code after it is kept", () => {
  const raw = "<think>the sign is wrong, flip it</think>\n  return a + b;";
  assert.equal(normalizeInlineEdit(raw, ORIGINAL), "  return a + b;");
});

test("a truncated reasoning stream, with no opening tag, still resolves", () => {
  // Some servers replay the reasoning channel without the opening tag. Slicing
  // on the LAST closing tag handles that; matching a pair would not.
  const raw = "flip the sign, then check the callers</think>  return a + b;";
  assert.equal(normalizeInlineEdit(raw, ORIGINAL), "  return a + b;");
});

test("a prose only answer is refused in a code file", () => {
  const answers = [
    "Here is the corrected function:",
    "Sure! I have updated the sign.",
    "I will change the minus into a plus.",
    "The code below adds the two values.",
    "Sorry, I cannot help with that.",
  ];
  for (const raw of answers) {
    assert.equal(normalizeInlineEdit(raw, ORIGINAL), null, raw);
  }
});

test("the same prose is accepted in markdown, where a paragraph is the content", () => {
  const raw = "The code below adds the two values.";
  assert.equal(normalizeInlineEdit(raw, "Old text.", { allowProse: true }), raw);
});

test("a truncated fenced answer is refused rather than half spliced", () => {
  // No closing fence: the body is half a function, and half a function landing
  // in a diff the user accepts is worse than no answer.
  assert.equal(normalizeInlineEdit("```ts\n  const sum = a +", ORIGINAL), null);
});

test("a stray closing fence is refused", () => {
  assert.equal(normalizeInlineEdit("  return a + b;\n```", ORIGINAL), null);
});

test("an empty or whitespace answer is refused", () => {
  assert.equal(normalizeInlineEdit("", ORIGINAL), null);
  assert.equal(normalizeInlineEdit("   \n\n  \t ", ORIGINAL), null);
  assert.equal(normalizeInlineEdit("```ts\n\n```", ORIGINAL), null);
});

test("an answer wildly longer than the region is refused", () => {
  const flood = Array.from({ length: 200 }, (_, i) => `  const v${i} = ${i};`).join("\n");
  assert.equal(flood.length > 800, true);
  assert.equal(normalizeInlineEdit(flood, ORIGINAL), null);
});

test("a big region may legitimately grow, up to the ceiling", () => {
  const base = "  const v = 1;\n".repeat(60); // 900 characters
  const grown = "  const v = 1;\n".repeat(400);
  assert.notEqual(normalizeInlineEdit(grown, base), null);
  assert.equal(normalizeInlineEdit("x".repeat(MAX_ANSWER_CHARS + 1), base), null);
});

test("an answer ten times shorter than a large region is refused as a summary", () => {
  const region = "  const v = 1;\n".repeat(60); // 900 characters
  assert.equal(normalizeInlineEdit("  const v = 1;", region), null);
  // Just over a tenth is a plausible rewrite and must survive.
  assert.notEqual(normalizeInlineEdit("y".repeat(120), region), null);
});

test("a small region is allowed to grow freely", () => {
  // Replacing three characters with forty lines of code is an ordinary edit;
  // the ratio rule must not fire on tiny regions.
  const answer = Array.from({ length: 20 }, (_, i) => `  step(${i});`).join("\n");
  assert.equal(normalizeInlineEdit(answer, "  x();"), answer);
});

test("blank edges are trimmed but inner blank lines and indentation survive", () => {
  const raw = "```ts\n\n  const a = 1;\n\n  const b = 2;\n\n```";
  assert.equal(normalizeInlineEdit(raw, ORIGINAL), "  const a = 1;\n\n  const b = 2;");
});

test("trailing whitespace on every line is removed", () => {
  assert.equal(normalizeInlineEdit("  return a + b;   \t", ORIGINAL), "  return a + b;");
});

// ---------------------------------------------------------------- indent

test("a dedented answer is pushed back under the region indentation", () => {
  const out = realignIndent("    return a - b", "return a + b");
  assert.equal(out, "    return a + b");
});

test("relative indentation inside the answer is preserved by the shift", () => {
  const out = realignIndent("    old()", "if x:\n    y()\n\nz()");
  assert.equal(out, "    if x:\n        y()\n\n    z()");
});

test("an answer that already carries the right indentation is not doubled", () => {
  const out = realignIndent("    return a - b", "    return a + b");
  assert.equal(out, "    return a + b");
});

test("a region at column zero is never shifted", () => {
  assert.equal(realignIndent("return a - b", "return a + b"), "return a + b");
});

test("incompatible indentation characters are left alone", () => {
  // The region is tab indented, the answer starts with a space. Padding it
  // would produce a line indented with a space then tabs, which Python rejects
  // and every other language misformats.
  assert.equal(realignIndent("\t\treturn a", " return b"), " return b");
});

// ---------------------------------------------------------------- apply

test("applying produces the whole new document, region replaced in place", () => {
  const doc = "function f() {\n  return a - b;\n}\n";
  const from = doc.indexOf("  return");
  const applied = applyInlineEdit(doc, { from, to: from + ORIGINAL.length }, "return a + b;")!;
  assert.equal(applied.text, "  return a + b;");
  assert.equal(applied.doc, "function f() {\n  return a + b;\n}\n");
});

test("a no-op answer is refused instead of filing an empty diff", () => {
  // A proposal identical to the file puts the editor in review mode over a
  // diff with zero hunks, and there is no hunk to accept to get back out.
  const doc = "function f() {\n  return a - b;\n}\n";
  const from = doc.indexOf("  return");
  // The dedented answer becomes identical once realigned: still a no-op.
  assert.equal(applyInlineEdit(doc, { from, to: from + ORIGINAL.length }, "return a - b;"), null);
});

test("applying at an empty range inserts without eating anything", () => {
  const doc = "x = 1\n\ny = 2\n";
  const at = doc.indexOf("\n\n") + 1;
  const applied = applyInlineEdit(doc, { from: at, to: at }, "helper()")!;
  assert.equal(applied.doc, "x = 1\nhelper()\ny = 2\n");
});

test("applying clamps a range that no longer fits the document", () => {
  const doc = "abc";
  const applied = applyInlineEdit(doc, { from: 99, to: 120 }, "z")!;
  assert.equal(applied.doc, "abcz");
});
