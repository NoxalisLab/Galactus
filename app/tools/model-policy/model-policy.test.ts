// @ts-ignore Node's built-in runner is used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

// @ts-ignore Node types are deliberately not added to the app dependency graph.
import fs from "node:fs";

import { hasVerifiedDownload, modelAvailability, modelCertification } from "../../src/model-policy.js";

test("only certified Galactus regimes may execute", () => {
  assert.deepEqual(modelCertification("certified"), { canExecute: true, badge: "certified" });
  assert.deepEqual(modelCertification("certified_bit_transparent"), {
    canExecute: true,
    badge: "certified",
  });
  assert.deepEqual(modelCertification("certified_by_composition"), {
    canExecute: true,
    badge: "composition",
  });
});

test("pending, unknown and empty registry states stay blocked", () => {
  assert.deepEqual(modelCertification("pending_certification"), {
    canExecute: false,
    badge: "pending",
  });
  assert.deepEqual(modelCertification("draft"), { canExecute: false, badge: "blocked" });
  assert.deepEqual(modelCertification(""), { canExecute: false, badge: "blocked" });
});

test("hardware eligibility blocks a 744B model on a 16 GB Mac", () => {
  assert.deepEqual(modelAvailability("certified", 128, 16), {
    canExecute: false,
    badge: "certified",
    reason: "hardware",
  });
  assert.deepEqual(modelAvailability("certified", 128, 128), {
    canExecute: true,
    badge: "certified",
    reason: null,
  });
  assert.equal(modelAvailability("certified", 128, undefined).canExecute, false);
});

test("a certified model without a declared minimum fails closed", () => {
  assert.deepEqual(modelAvailability("certified", undefined, 128), {
    canExecute: false,
    badge: "blocked",
    reason: "hardware",
  });
});

test("only HTTPS Hugging Face sources with safe relative files are offered", () => {
  assert.equal(hasVerifiedDownload(undefined), false);
  assert.equal(hasVerifiedDownload({ base: "file:///tmp/model", files: ["model.gguf"] }), false);
  assert.equal(hasVerifiedDownload({ base: "https://huggingface.co/org/repo", files: ["../model.gguf"] }), false);
  assert.equal(hasVerifiedDownload({ base: "https://huggingface.co/org/repo", files: ["model.gguf"] }), true);
});

test("the shipped registry defines an enforceable hardware policy for every model", () => {
  // TypeScript preserves the app-relative source tree under out/, hence the
  // six-level walk from the compiled test back to the repository root.
  const registryUrl = new URL("../../../../../../scripts/models-registry.json", import.meta.url);
  const registry = JSON.parse(fs.readFileSync(registryUrl, "utf8")) as { models: Array<Record<string, unknown>> };
  const ids = new Set<string>();
  for (const model of registry.models) {
    const id = String(model.id ?? "");
    assert.ok(id && !ids.has(id), `model id must be present and unique: ${id}`);
    ids.add(id);
    assert.ok(Number.isInteger(model.min_ram_gb) && Number(model.min_ram_gb) >= 16, `${id}: invalid min_ram_gb`);
    assert.ok(typeof model.status === "string" && model.status, `${id}: missing status`);
  }
  const glm = registry.models.find((model) => model.id === "glm-5.2-744b");
  assert.equal(glm?.min_ram_gb, 128, "GLM-5.2 744B must never be offered below the measured 128 GB tier");
});
