import {
  constrainedPaneSize,
  createPaneResizeSession,
  keyboardPaneSize,
  pointerPaneSize,
  storedPaneSize,
  type PaneBounds,
} from "../../src/layout/pane-resize.js";

const NODE_TEST = "node:test";
const NODE_ASSERT = "node:assert/strict";
const { test } = (await import(NODE_TEST)) as {
  test: (name: string, fn: () => unknown) => void;
};
const assert = ((await import(NODE_ASSERT)) as { default: any }).default;

const roomy: PaneBounds = {
  container: 1200,
  reserved: 560,
  min: 180,
  max: 420,
  defaultSize: 228,
};

test("pane size keeps both its own bounds and the reserved workspace visible", () => {
  assert.equal(constrainedPaneSize(80, roomy), 180);
  assert.equal(constrainedPaneSize(500, roomy), 420);
  assert.equal(constrainedPaneSize(500, { ...roomy, container: 900 }), 340);
});

test("pointer geometry is symmetric for panes before and after a separator", () => {
  assert.equal(pointerPaneSize(360, 100, 1000, "before"), 260);
  assert.equal(pointerPaneSize(760, 100, 1000, "after"), 240);
});

test("arrow keys resize in the visual direction and Home restores the default", () => {
  assert.equal(keyboardPaneSize(240, "ArrowRight", false, "before", roomy), 256);
  assert.equal(keyboardPaneSize(240, "ArrowLeft", false, "before", roomy), 224);
  assert.equal(keyboardPaneSize(240, "ArrowLeft", true, "after", roomy), 288);
  assert.equal(keyboardPaneSize(240, "ArrowRight", true, "after", roomy), 192);
  assert.equal(keyboardPaneSize(350, "Home", false, "before", roomy), 228);
  assert.equal(keyboardPaneSize(240, "Enter", false, "before", roomy), null);
});

test("persisted sizes accept finite positive pixels and reject corrupt settings", () => {
  assert.equal(storedPaneSize("274.6", roomy), 275);
  assert.equal(storedPaneSize("900", roomy), 420);
  assert.equal(storedPaneSize("not-a-number", roomy), 228);
  assert.equal(storedPaneSize("-12", roomy), 228);
  assert.equal(storedPaneSize(undefined, roomy), 228);
});

test("a resize session previews pointer moves and persists only committed sizes", () => {
  const applied: number[] = [];
  const committed: number[] = [];
  const session = createPaneResizeSession({
    edge: "before",
    initial: 228,
    bounds: () => roomy,
    apply: (size) => applied.push(size),
    commit: (size) => committed.push(size),
  });

  session.movePointer(360, 100, 1000);
  session.movePointer(900, 100, 1000);
  assert.deepEqual(applied, [260, 420]);
  assert.deepEqual(committed, []);

  session.commitPointer();
  assert.deepEqual(committed, [420]);

  assert.equal(session.key("ArrowLeft", false), true);
  assert.equal(session.key("Escape", false), false);
  assert.deepEqual(applied, [260, 420, 404]);
  assert.deepEqual(committed, [420, 404]);

  session.reset();
  assert.equal(session.size(), 228);
  assert.deepEqual(committed, [420, 404, 228]);
});
