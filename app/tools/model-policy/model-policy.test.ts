// @ts-ignore Node's built-in runner is used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

// @ts-ignore Node types are deliberately not added to the app dependency graph.
import fs from "node:fs";

import { hasVerifiedDownload, modelAvailability, modelCertification,
  recommendedModel,
} from "../../src/model-policy.js";

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

test("every model in the shipped catalogue can be installed from the app", () => {
  // GLM-5.2 shipped with no download block at all, so its card drew no button
  // and the only way to obtain it was by hand. A catalogue entry the app cannot
  // act on is an advertisement, and a user who deletes such a model has no way
  // back. Certification says the model may run; a download says it can be had.
  const registryUrl = new URL("../../../../../../scripts/models-registry.json", import.meta.url);
  const registry = JSON.parse(fs.readFileSync(registryUrl, "utf8")) as {
    models: Array<Record<string, any>>;
  };
  for (const model of registry.models) {
    assert.ok(
      hasVerifiedDownload(model.download),
      `${model.id}: offered in the catalogue with no way to download it`,
    );
    // The downloader writes models/<id>/<file> and creates no subdirectory, so a
    // slash inside a file name fails at curl's open. Put the folder in the base.
    for (const file of model.download.files as string[]) {
      assert.ok(!file.includes("/"), `${model.id}: ${file} needs its folder in the base, not the name`);
    }
  }
});

test("no catalogue entry pins a model to one machine", () => {
  // internal_pack and external_pack held absolute paths from the machine the
  // model was first packed on, and they were consulted BEFORE the standard
  // store, so every other install fell through to a path that does not exist
  // there. Those two fields shipped, verbatim, to every user.
  const registryUrl = new URL("../../../../../../scripts/models-registry.json", import.meta.url);
  const registry = JSON.parse(fs.readFileSync(registryUrl, "utf8")) as {
    models: Array<Record<string, any>>;
  };
  for (const model of registry.models) {
    for (const field of ["internal_pack", "external_pack"]) {
      const value = model[field];
      if (value === undefined) continue;
      assert.ok(
        !String(value).startsWith("/") && !String(value).includes("$HOME"),
        `${model.id}: ${field} is a path from one machine and cannot ship`,
      );
    }
  }
});

test("a dense model may run, and says it is not the accelerated path", () => {
  // It has no experts to substitute, so there is nothing for the differential
  // probe to compare: the bit-exactness claim every other card makes cannot be
  // made here, and borrowing its badge would be the one dishonest square inch
  // on a page whose whole argument is that its claims are checkable.
  const stock = modelCertification("stock_unmodified");
  assert.equal(stock.canExecute, true, "it must be startable");
  assert.notEqual(stock.badge, "certified", "it must not wear the certified badge");
  assert.equal(stock.badge, "stock");
});

test("a dense entry declares itself and asks for enough memory to hold itself", () => {
  const registryUrl = new URL("../../../../../../scripts/models-registry.json", import.meta.url);
  const registry = JSON.parse(fs.readFileSync(registryUrl, "utf8")) as {
    models: Array<Record<string, any>>;
  };
  for (const model of registry.models) {
    if (!model.dense) {
      // The streaming engine is what lets a model exceed memory. Anything that
      // is NOT dense has to carry the expert geometry that makes it possible.
      assert.ok(model.experts, `${model.id}: an MoE entry with no expert count`);
      continue;
    }
    assert.equal(model.status, "stock_unmodified", `${model.id}: dense but claims certification`);
    assert.ok(model.experts === undefined, `${model.id}: dense entries carry no expert geometry`);
    // Nothing streams, so the weights are resident from the first token. The
    // floor has to cover them; the MoE entries are the only ones allowed to ask
    // for less RAM than they weigh.
    const weightsGb = Number(model.gguf_bytes) / 1e9;
    assert.ok(
      Number(model.min_ram_gb) >= weightsGb,
      `${model.id}: ${model.min_ram_gb} GB floor cannot hold ${weightsGb.toFixed(1)} GB of weights`,
    );
  }
});

test("the recommendation is the most capable model that stays comfortable", () => {
  // Size stands for capability, but only among the ones that answer at reading
  // speed: the biggest model here crawls, and recommending it would be advice
  // the user regrets after one prompt.
  const models = [
    { id: "small", gguf_bytes: 4e9, tps: 90, ok: true },
    { id: "mid", gguf_bytes: 20e9, tps: 40, ok: true },
    { id: "big", gguf_bytes: 70e9, tps: 3, ok: true },
  ];
  assert.equal(recommendedModel(models), "mid");
});

test("a machine where nothing is comfortable still gets told where to start", () => {
  // Silence is not useful advice. The fastest runnable one wins.
  const models = [
    { id: "a", gguf_bytes: 70e9, tps: 2, ok: true },
    { id: "b", gguf_bytes: 30e9, tps: 9, ok: true },
  ];
  assert.equal(recommendedModel(models), "b");
});

test("nothing is recommended when nothing can run or nothing is measured", () => {
  assert.equal(recommendedModel([]), null);
  assert.equal(recommendedModel([{ id: "x", gguf_bytes: 4e9, tps: 90, ok: false }]), null);
  // No measurement is not a reason to guess.
  assert.equal(recommendedModel([{ id: "x", gguf_bytes: 4e9, tps: null, ok: true }]), null);
});

test("a model this Mac cannot run is never the recommendation", () => {
  const models = [
    { id: "toobig", gguf_bytes: 200e9, tps: 30, ok: false },
    { id: "fits", gguf_bytes: 20e9, tps: 30, ok: true },
  ];
  assert.equal(recommendedModel(models), "fits");
});
