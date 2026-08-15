// The three numbers that decide how a model speaks, and the ways they arrive wrong.
//
// WHAT THIS COVERS THAT NOTHING ELSE DID. The app sent temperature 0.6 to every
// model and never sent top_p or top_k at all. Qwen3.8 publishes 1.0 / 0.95 / 20,
// and a model run outside the sampling it was tuned for is not broken, only
// quietly worse, with nothing on screen to say so. Making them settings means
// they now arrive from a file a person can hand-edit, which is where the
// interesting cases live.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import {
  clampSampling,
  readSampling,
  SAMPLING_DEFAULT,
  samplingFor,
} from "../../src/sampling.js";

test("nothing stored gives llama.cpp's own defaults", () => {
  assert.deepEqual(readSampling({}), SAMPLING_DEFAULT);
});

test("a hand-edited file cannot put NaN on the wire", () => {
  // The case that matters: NaN passes every comparison, so it would reach
  // JSON.stringify as null and llama-server would answer 400 for a conversation
  // whose cause is invisible from the chat window.
  const s = readSampling({ sampling_temperature: "abc", sampling_top_p: "", sampling_top_k: "  " });
  assert.deepEqual(s, SAMPLING_DEFAULT);
  for (const v of Object.values(s)) assert.ok(Number.isFinite(v));
});

test("values are held inside what the sampler accepts", () => {
  const s = readSampling({
    sampling_temperature: "9",
    sampling_top_p: "3",
    sampling_top_k: "-5",
  });
  assert.equal(s.temperature, 2);
  assert.equal(s.top_p, 1);
  assert.equal(s.top_k, 0);
});

test("temperature zero survives, because certification and benchmarks need it", () => {
  // Zero is a real setting, not an empty field: clamping it up to some minimum
  // would silently make every measured number in this project unreproducible.
  assert.equal(readSampling({ sampling_temperature: "0" }).temperature, 0);
  assert.equal(clampSampling("temperature", 0), 0);
});

test("a task temperature overrides the temperature alone", () => {
  // A skill asking for 0 is asking for a repeatable answer. It knows nothing
  // about top_p and top_k, so it must not silently reset them to anything.
  const configured = { temperature: 1, top_p: 0.95, top_k: 20 };
  assert.deepEqual(samplingFor(configured, 0), { temperature: 0, top_p: 0.95, top_k: 20 });
  assert.deepEqual(samplingFor(configured, undefined), configured);
  assert.deepEqual(samplingFor(configured, NaN), configured);
});
