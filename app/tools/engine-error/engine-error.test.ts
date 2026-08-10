// @ts-ignore Node's built-in runner is used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

// @ts-ignore Node types are deliberately not added to the app dependency graph.
import fs from "node:fs";

import {
  engineAdvice,
  isEngineDecodeFailure,
  modeLabelKey,
} from "../../src/engine-error.js";

test("the engine's own decode messages are the ones worth diagnosing", () => {
  // The three llama-server sends from update_slots when a decode gives up.
  assert.equal(isEngineDecodeFailure("Compute error."), true);
  assert.equal(isEngineDecodeFailure("Invalid input batch."), true);
  assert.equal(isEngineDecodeFailure("Context size has been exceeded."), true);
});

test("a failure that already explains itself is left alone", () => {
  // These carry their own cause. Rewriting them as a memory story would be the
  // same defect pointed the other way.
  assert.equal(isEngineDecodeFailure("server 400: template error"), false);
  assert.equal(isEngineDecodeFailure("Failed to fetch"), false);
  assert.equal(isEngineDecodeFailure("tool loop limit reached"), false);
  assert.equal(isEngineDecodeFailure(""), false);
});

test("an out of memory decode names memory, the mode, and the way out", () => {
  const advice = engineAdvice({ kind: "memory", mode: "balanced", can_step_down: true });
  assert.deepEqual(advice, { key: "engfail.memoryStepDown", modeKey: "settings.ramBalanced" });
});

test("in eco there is no mode left, so the advice changes", () => {
  // Telling a user already in Eco to switch to Eco is how a message loses the
  // reader's trust for every message after it.
  const advice = engineAdvice({ kind: "memory", mode: "eco", can_step_down: false });
  assert.deepEqual(advice, { key: "engfail.memoryAtFloor", modeKey: "" });
});

test("an exceeded context is never dressed up as a memory problem", () => {
  const advice = engineAdvice({ kind: "context", mode: "perf", can_step_down: true });
  assert.deepEqual(advice, { key: "engfail.context", modeKey: "" });
});

test("a failure the log does not explain keeps the engine's own words", () => {
  assert.equal(engineAdvice({ kind: "unknown", mode: "perf", can_step_down: true }), null);
});

test("mode names come from the same keys the settings control uses", () => {
  assert.equal(modeLabelKey("eco"), "settings.ramEco");
  assert.equal(modeLabelKey("balanced"), "settings.ramBalanced");
  assert.equal(modeLabelKey("perf"), "settings.ramPerf");
  // An engine started before this field existed reads as the default, never
  // as an empty label in the middle of a sentence.
  assert.equal(modeLabelKey(""), "settings.ramBalanced");
});

test("every key this module can return exists in both languages", () => {
  // A missing key would ship a raw identifier into the one message a user
  // reads at their worst moment.
  // TypeScript preserves the app-relative source tree under out/, hence the
  // five-level walk from the compiled test back to app/src.
  const src = fs.readFileSync(new URL("../../../../../src/i18n.ts", import.meta.url), "utf8");
  for (const key of [
    "engfail.memoryStepDown",
    "engfail.memoryAtFloor",
    "engfail.context",
    "settings.ramEco",
    "settings.ramBalanced",
    "settings.ramPerf",
  ]) {
    assert.ok(src.includes(`"${key}"`), `missing i18n key: ${key}`);
  }
});
