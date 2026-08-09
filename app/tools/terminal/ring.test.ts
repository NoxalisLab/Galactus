// The scrollback ring and the geometry clamp: the two places where an
// unbounded number meets a bounded resource.

// @ts-ignore Node's own test runner, no dependency added.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MAX_COLS,
  MAX_ROWS,
  MIN_COLS,
  MIN_ROWS,
  RingBuffer,
  clampTerminalSize,
  gridSizeFor,
} from "../../src/code/terminal.js";

// ---------------------------------------------------------------- ring

test("a ring never grows past its capacity", () => {
  const r = new RingBuffer<number>(3);
  for (let i = 0; i < 100; i++) r.push(i);
  assert.equal(r.capacity, 3);
  assert.equal(r.length, 3);
  assert.deepEqual(r.toArray(), [97, 98, 99]);
});

test("push returns the evicted item, and only once the ring is full", () => {
  const r = new RingBuffer<string>(2);
  assert.equal(r.push("a"), undefined);
  assert.equal(r.push("b"), undefined);
  assert.equal(r.push("c"), "a");
  assert.equal(r.push("d"), "b");
  assert.deepEqual(r.toArray(), ["c", "d"]);
});

test("index 0 is the oldest retained item and out of range is undefined", () => {
  const r = new RingBuffer<number>(3);
  for (const v of [1, 2, 3, 4, 5]) r.push(v);
  assert.equal(r.at(0), 3);
  assert.equal(r.at(1), 4);
  assert.equal(r.at(2), 5);
  assert.equal(r.at(3), undefined);
  assert.equal(r.at(-1), undefined);
  // A fractional index is not an index. Rounding it would quietly return a
  // neighbour, which is worse than saying nothing.
  assert.equal(r.at(1.5), undefined);
  assert.equal(r.at(NaN), undefined);
});

test("the counters describe the stream, not the buffer", () => {
  const r = new RingBuffer<number>(2);
  assert.equal(r.pushed, 0);
  assert.equal(r.dropped, 0);
  for (let i = 0; i < 10; i++) r.push(i);
  assert.equal(r.pushed, 10);
  assert.equal(r.dropped, 8);
  assert.equal(r.length, 2);
});

test("an impossible capacity becomes the smallest possible one", () => {
  assert.equal(new RingBuffer<number>(0).capacity, 1);
  assert.equal(new RingBuffer<number>(-5).capacity, 1);
  assert.equal(new RingBuffer<number>(NaN).capacity, 1);
  assert.equal(new RingBuffer<number>(Infinity).capacity, 1);
  // A fractional capacity truncates rather than rounding up: the ceiling is a
  // promise not to exceed it.
  assert.equal(new RingBuffer<number>(3.9).capacity, 3);
});

test("a ring of one holds only the newest item", () => {
  const r = new RingBuffer<string>(1);
  r.push("a");
  r.push("b");
  assert.deepEqual(r.toArray(), ["b"]);
  assert.equal(r.dropped, 1);
});

test("shrinking a ring drops the oldest and says so", () => {
  const r = new RingBuffer<number>(5);
  for (const v of [1, 2, 3, 4, 5]) r.push(v);
  assert.equal(r.dropped, 0);
  r.resize(2);
  assert.equal(r.capacity, 2);
  assert.deepEqual(r.toArray(), [4, 5]);
  assert.equal(r.dropped, 3);
  // The wrap-around bookkeeping must survive the resize.
  r.push(6);
  assert.deepEqual(r.toArray(), [5, 6]);
});

test("growing a ring keeps everything and drops nothing", () => {
  const r = new RingBuffer<number>(2);
  for (const v of [1, 2, 3]) r.push(v);
  assert.deepEqual(r.toArray(), [2, 3]);
  r.resize(6);
  assert.deepEqual(r.toArray(), [2, 3]);
  assert.equal(r.dropped, 1, "the item lost before the resize is still lost");
  for (const v of [4, 5, 6, 7]) r.push(v);
  assert.deepEqual(r.toArray(), [2, 3, 4, 5, 6, 7]);
  assert.equal(r.dropped, 1);
});

test("resizing to the same capacity is a no-op, not a rebuild", () => {
  const r = new RingBuffer<number>(3);
  for (const v of [1, 2, 3, 4]) r.push(v);
  r.resize(3);
  assert.deepEqual(r.toArray(), [2, 3, 4]);
  assert.equal(r.dropped, 1);
});

test("clear empties the buffer but keeps the lifetime counters", () => {
  const r = new RingBuffer<number>(2);
  for (const v of [1, 2, 3]) r.push(v);
  r.clear();
  assert.equal(r.length, 0);
  assert.deepEqual(r.toArray(), []);
  assert.equal(r.at(0), undefined);
  assert.equal(r.dropped, 1);
  assert.equal(r.pushed, 3);
  // A cleared ring must still work, which a botched head reset would break.
  r.push(9);
  assert.deepEqual(r.toArray(), [9]);
});

// ------------------------------------------------------------- geometry

test("a sane geometry passes through untouched", () => {
  assert.deepEqual(clampTerminalSize(80, 24), { cols: 80, rows: 24 });
  assert.deepEqual(clampTerminalSize(MIN_COLS, MIN_ROWS), { cols: MIN_COLS, rows: MIN_ROWS });
  assert.deepEqual(clampTerminalSize(MAX_COLS, MAX_ROWS), { cols: MAX_COLS, rows: MAX_ROWS });
});

test("a geometry is clamped at both ends rather than refused", () => {
  assert.deepEqual(clampTerminalSize(0, 0), { cols: MIN_COLS, rows: MIN_ROWS });
  assert.deepEqual(clampTerminalSize(-40, -3), { cols: MIN_COLS, rows: MIN_ROWS });
  assert.deepEqual(clampTerminalSize(99999, 99999), { cols: MAX_COLS, rows: MAX_ROWS });
});

test("a fractional geometry floors, so the grid never exceeds the box", () => {
  assert.deepEqual(clampTerminalSize(80.9, 24.9), { cols: 80, rows: 24 });
});

test("a nonsense geometry becomes the default, never NaN", () => {
  // This is the real failure: a hidden pane measures zero, a font that has not
  // loaded measures zero, and 0/0 is NaN. A child told it has NaN columns is a
  // crash, not a cosmetic problem.
  assert.deepEqual(clampTerminalSize(NaN, NaN), { cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
  assert.deepEqual(clampTerminalSize(Infinity, 24), { cols: DEFAULT_COLS, rows: 24 });
  assert.deepEqual(clampTerminalSize(80, -Infinity), { cols: 80, rows: DEFAULT_ROWS });
});

test("a grid size divides the box by the cell", () => {
  assert.deepEqual(gridSizeFor(800, 480, 8, 16), { cols: 100, rows: 30 });
  // A partial cell at the edge is not a column.
  assert.deepEqual(gridSizeFor(807, 489, 8, 16), { cols: 100, rows: 30 });
});

test("an unmeasurable cell yields the default grid, never a division by zero", () => {
  assert.deepEqual(gridSizeFor(800, 480, 0, 16), { cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
  assert.deepEqual(gridSizeFor(800, 480, 8, 0), { cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
  assert.deepEqual(gridSizeFor(800, 480, NaN, 16), { cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
  assert.deepEqual(gridSizeFor(800, 480, -8, 16), { cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
});

test("a collapsed pane yields the minimum grid, not an empty one", () => {
  // A zero sized box is a real state: the splitter can be dragged shut.
  assert.deepEqual(gridSizeFor(0, 0, 8, 16), { cols: MIN_COLS, rows: MIN_ROWS });
});
