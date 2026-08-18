// The Images view's arithmetic. These are the parts that go wrong quietly.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { defaultsFor, fmtSeconds, sizeLabel, sizePresets } from "../../src/image-plan.js";

test("a model with no defaults still opens with something that works", () => {
  assert.deepEqual(defaultsFor(undefined), { steps: 20, cfg: 7, width: 512, height: 512 });
  assert.deepEqual(defaultsFor({ defaults: {} }), { steps: 20, cfg: 7, width: 512, height: 512 });
});

test("a model's own defaults are used, and impossible ones are corrected", () => {
  assert.deepEqual(defaultsFor({ defaults: { steps: 4, cfg: 1, width: 1024, height: 1024 } }), {
    steps: 4,
    cfg: 1,
    width: 1024,
    height: 1024,
  });
  const bad = defaultsFor({ defaults: { steps: 9999, cfg: -5, width: 40, height: NaN } });
  assert.equal(bad.steps, 100);
  assert.equal(bad.cfg, 0);
  assert.equal(bad.width, 64);
  assert.equal(bad.height, 64);
});

test("the size list always contains the size the model was measured at", () => {
  // Otherwise the first generation silently differs from the time on the card.
  const odd = sizePresets(896, 1152);
  assert.deepEqual(odd[0], { w: 896, h: 1152 });
  // And a size already in the list is not added twice.
  const normal = sizePresets(1024, 1024);
  assert.equal(normal.filter((p) => p.w === 1024 && p.h === 1024).length, 1);
});

test("a duration reads at a glance", () => {
  assert.equal(fmtSeconds(18.6), "18.6s");
  assert.equal(fmtSeconds(33.2), "33.2s");
  assert.equal(fmtSeconds(45), "45s");
  assert.equal(fmtSeconds(95), "1m 35s");
  assert.equal(fmtSeconds(120), "2m");
  assert.equal(fmtSeconds(0), "");
});

test("a size with a missing dimension has no label rather than a broken one", () => {
  assert.equal(sizeLabel(1024, 1024), "1024 x 1024");
  assert.equal(sizeLabel(0, 512), "");
});
