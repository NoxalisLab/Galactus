// Which lines the gutter marks, against the version git holds.
//
// The interesting cases are the boundaries: a file with no trailing newline, a
// file git has never seen, a deletion that has no line of its own, and an edit
// large enough to hit the ceiling that stops the editor freezing.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { lineChanges } from "../../src/code/changebar.js";

test("an untouched file has no marks", () => {
  const text = "a\nb\nc\n";
  assert.deepEqual(lineChanges(text, text), []);
  // A trailing newline is a terminator, not an empty last line.
  assert.deepEqual(lineChanges("a\nb\nc", "a\nb\nc\n"), []);
});

test("an edited line is a modification, not a deletion plus an addition", () => {
  // What the reader means by "I changed this line".
  assert.deepEqual(lineChanges("a\nb\nc\n", "a\nB\nc\n"), [{ line: 2, kind: "mod" }]);
});

test("inserted lines are additions, at their place in the new file", () => {
  assert.deepEqual(lineChanges("a\nc\n", "a\nb1\nb2\nc\n"), [
    { line: 2, kind: "add" },
    { line: 3, kind: "add" },
  ]);
});

test("a deletion has no line, so it marks the boundary that survived it", () => {
  // b is gone: the wedge belongs on c, which is line 2 of the new file.
  assert.deepEqual(lineChanges("a\nb\nc\n", "a\nc\n"), [{ line: 2, kind: "del" }]);
});

test("a file git has never held is entirely new", () => {
  assert.deepEqual(lineChanges("", "x\ny\n"), [
    { line: 1, kind: "add" },
    { line: 2, kind: "add" },
  ]);
  assert.deepEqual(lineChanges("", ""), []);
});

test("emptying a file leaves one wedge, not a mark per lost line", () => {
  const marks = lineChanges("a\nb\nc\n", "");
  assert.equal(marks.length, 1);
  assert.equal(marks[0].kind, "del");
});

test("a rewrite past the ceiling is reported without freezing the editor", () => {
  // 2000 differing lines on both sides: an exact diff here is millions of
  // cells and tells the reader nothing they cannot see. It must still return,
  // fast, with every line marked.
  const base = Array.from({ length: 2000 }, (_, i) => `old ${i}`).join("\n");
  const now = Array.from({ length: 2000 }, (_, i) => `new ${i}`).join("\n");
  const started = Date.now();
  const marks = lineChanges(base, now);
  assert.equal(marks.length, 2000);
  assert.ok(marks.every((m) => m.kind === "mod"));
  assert.ok(Date.now() - started < 1000, "it must not take a second");
});

test("changes far apart do not drag the untouched middle in with them", () => {
  const base = ["a", "b", "c", "d", "e"].join("\n");
  const now = ["A", "b", "c", "d", "E"].join("\n");
  assert.deepEqual(lineChanges(base, now), [
    { line: 1, kind: "mod" },
    { line: 5, kind: "mod" },
  ]);
});
