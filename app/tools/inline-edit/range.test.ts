// expandEditRange: what Cmd+K actually decides to rewrite.
//
// These are the cases that decide whether the user gets a diff they recognise
// or a diff that starts mid token, so every one of them asserts on the exact
// text the range covers rather than on the offsets.

import {
  MAX_BLOCK_LINES,
  expandEditRange,
  leadingWhitespace,
} from "../../src/code/inline-edit.js";

const NODE_TEST = "node:test";
const NODE_ASSERT = "node:assert/strict";
const { test } = (await import(NODE_TEST)) as {
  test: (name: string, fn: () => unknown) => void;
};
const assert = ((await import(NODE_ASSERT)) as { default: any }).default;

const PY = [
  "def outer():",
  "    first()",
  "",
  "    second()",
  "",
  "def other():",
  "    pass",
  "",
].join("\n");

/** The region as text, which is what the model and the merge view both see. */
function slice(doc: string, from: number, to: number): string {
  const range = expandEditRange(doc, from, to);
  return doc.slice(range.from, range.to);
}

function offsetOf(doc: string, needle: string): number {
  const at = doc.indexOf(needle);
  if (at < 0) throw new Error("fixture does not contain " + JSON.stringify(needle));
  return at;
}

test("a caret on a line with content takes that whole line", () => {
  const at = offsetOf(PY, "first()");
  assert.equal(slice(PY, at + 2, at + 2), "    first()");
  const range = expandEditRange(PY, at, at);
  assert.equal(range.startLine, 2);
  assert.equal(range.endLine, 2);
});

test("a partial selection is snapped out to whole lines", () => {
  const from = offsetOf(PY, "irst()");
  const to = offsetOf(PY, "econd()") + 3;
  assert.equal(slice(PY, from, to), "    first()\n\n    second()");
});

test("a line selection does not swallow the line the caret landed on", () => {
  // Selecting line 2 by dragging leaves the head at the FIRST character of
  // line 3. Including line 3 would make every line selection one line greedy.
  const start = offsetOf(PY, "    first()");
  const nextLine = start + "    first()\n".length;
  const range = expandEditRange(PY, start, nextLine);
  assert.equal(range.startLine, 2);
  assert.equal(range.endLine, 2);
  assert.equal(PY.slice(range.from, range.to), "    first()");
});

test("a reversed selection is normalized instead of producing an empty range", () => {
  const a = offsetOf(PY, "    first()");
  const b = offsetOf(PY, "    second()") + 5;
  assert.deepEqual(expandEditRange(PY, b, a), expandEditRange(PY, a, b));
});

test("a caret on a blank line inside a body takes the enclosing block", () => {
  const blank = offsetOf(PY, "\n\n    second()") + 1;
  assert.equal(slice(PY, blank, blank), "    first()\n\n    second()");
});

test("the block never keeps the blank lines at its edges", () => {
  // The blank line trailing a body: the sweep stops on the next top level
  // line, so the raw block would end on a blank line the model would have to
  // reproduce byte for byte.
  const blank = offsetOf(PY, "\n\ndef other():") + 1;
  const region = slice(PY, blank, blank);
  assert.equal(region.startsWith(" "), true);
  assert.equal(region.endsWith(")"), true);
});

test("a blank line between two top level items stays an insertion point", () => {
  // Reference indent zero: expanding by indentation here would swallow the
  // whole file, so the region is the gap itself and stays empty.
  const doc = "x = 1\n\ny = 2\n";
  const blank = doc.indexOf("\n\n") + 1;
  const range = expandEditRange(doc, blank, blank);
  assert.equal(range.from, range.to);
  assert.equal(range.startLine, 2);
  assert.equal(range.endLine, 2);
});

test("consecutive blank lines at column zero collapse into one insertion point", () => {
  const doc = "x = 1\n\n\n\ny = 2\n";
  const caret = doc.indexOf("\n\n") + 2;
  const range = expandEditRange(doc, caret, caret);
  assert.equal(range.startLine, 2);
  assert.equal(range.endLine, 4);
  assert.equal(doc.slice(range.from, range.to), "\n\n");
});

test("a huge indented block is capped instead of sending the whole function", () => {
  const body = Array.from({ length: 50 }, () => "    step()");
  const lines = ["def big():", ...body, "", ...body];
  const doc = lines.join("\n");
  const caret = doc.indexOf("\n\n") + 1;
  const range = expandEditRange(doc, caret, caret);
  assert.equal(range.endLine - range.startLine + 1, MAX_BLOCK_LINES);
});

test("a CRLF file never leaves a carriage return inside the region", () => {
  // The model answers with plain newlines. A region whose end included the \r
  // would swap the line ending of exactly that line and nothing else.
  const doc = "a = 1\r\nb = 2\r\n";
  const range = expandEditRange(doc, 0, 0);
  assert.equal(doc.slice(range.from, range.to), "a = 1");
});

test("an empty document yields an empty range and does not throw", () => {
  const range = expandEditRange("", 0, 0);
  assert.deepEqual(range, { from: 0, to: 0, startLine: 1, endLine: 1 });
});

test("out of bounds offsets are clamped, not trusted", () => {
  const range = expandEditRange(PY, -50, 9_000_000);
  assert.equal(range.from, 0);
  assert.equal(range.to <= PY.length, true);
});

test("leadingWhitespace keeps tabs and spaces exactly as written", () => {
  assert.equal(leadingWhitespace("\t  code"), "\t  ");
  assert.equal(leadingWhitespace("code"), "");
  assert.equal(leadingWhitespace("   "), "   ");
});
