// @ts-ignore
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";
// @ts-ignore
import fs from "node:fs";

import {
  layoutBriefKey,
  machineBrief,
  machineSummary,
  modeLabelKey,
  type RecommendationBrief,
} from "../../src/machine-brief.js";

function rec(over: Partial<RecommendationBrief> = {}): RecommendationBrief {
  return {
    mode: "balanced",
    requested_mode: "balanced",
    slots: 2,
    resident_bytes: 30_000_000_000,
    budget_bytes: 89_600_000_000,
    blocked: null,
    ...over,
  };
}

test("a start that goes as asked reads as what will run, not as a warning", () => {
  const b = machineBrief(rec());
  assert.equal(b.tone, "ok");
  assert.equal(b.key, "brief.ok");
  assert.equal(b.modeKey, "settings.ramBalanced");
  assert.equal(b.slots, 2);
  assert.equal(b.residentGb, 30);
  assert.equal(b.budgetGb, 89.6);
});

test("a mode the machine could not afford is said out loud, with both modes named", () => {
  // A user who picked Performance and silently got Eco would rightly call
  // that a bug. The sentence has to carry the mode asked for as well as the
  // mode used, or it explains nothing.
  const b = machineBrief(rec({ mode: "eco", requested_mode: "perf", resident_bytes: 8e9 }));
  assert.equal(b.tone, "adjusted");
  assert.equal(b.key, "brief.adjusted");
  assert.equal(b.modeKey, "settings.ramEco");
  assert.equal(b.requestedModeKey, "settings.ramPerf");
});

test("a refusal is a refusal even when the mode matches what was asked", () => {
  // The planner reports impossible with mode eco and requested eco: the two
  // are equal, so a brief that only compared them would call this fine.
  const b = machineBrief(
    rec({ mode: "eco", requested_mode: "eco", blocked: "not enough free memory" }),
  );
  assert.equal(b.tone, "blocked");
  assert.equal(b.key, "brief.blocked");
});

test("the gigabyte figures are rounded to something a person reads, not to bytes", () => {
  const b = machineBrief(rec({ resident_bytes: 16_849_321_984, budget_bytes: 7_200_000_000 }));
  assert.equal(b.residentGb, 16.8);
  assert.equal(b.budgetGb, 7.2);
});

test("an unknown mode name reads as balanced, exactly as the settings reader defaults", () => {
  assert.equal(modeLabelKey("turbo"), "settings.ramBalanced");
  assert.equal(modeLabelKey(""), "settings.ramBalanced");
  assert.equal(modeLabelKey("eco"), "settings.ramEco");
  assert.equal(modeLabelKey("perf"), "settings.ramPerf");
});

test("no measured drives means say nothing about drives, never say one volume", () => {
  // The install dialog asks for a layout only once it has probed. Before
  // that, inventing "your internal disk" would be a claim nobody measured.
  assert.equal(layoutBriefKey(null), null);
  assert.equal(layoutBriefKey({ kind: "single", mount: "/" }), "brief.layoutSingle");
  assert.equal(
    layoutBriefKey({ kind: "dual", internal: "/", external: "/Volumes/T7" }),
    "brief.layoutDual",
  );
  assert.equal(layoutBriefKey({ kind: "no-room" }), "brief.layoutNoRoom");
});

test("the machine summary carries what separates two Macs of the same memory size", () => {
  // A 16 GB M1 and a 16 GB M4 Max are not the same machine, and the chip
  // string plus the GPU core count is what the app can say about it.
  const s = machineSummary({
    chip: "Apple M5 Max",
    ram_gb: 128,
    gpu_cores: 40,
    bandwidth_gbs: 614,
    engine_budget_bytes: 89_600_000_000,
    power_source: "battery",
  });
  assert.equal(s.chip, "Apple M5 Max");
  assert.equal(s.gpuCores, 40);
  assert.equal(s.budgetGb, 89.6);
  assert.equal(s.bandwidthGbs, 614);
  assert.equal(s.onBattery, true);
});

test("a machine with nothing to report reports nothing rather than a zero", () => {
  // An Intel Mac or a virtual machine: no GPU to count, no published
  // bandwidth. Zero would read as a real measurement of zero.
  const s = machineSummary({
    chip: "Intel(R) Core(TM) i9-9880H CPU @ 2.30GHz",
    ram_gb: 32,
    gpu_cores: null,
    bandwidth_gbs: null,
    engine_budget_bytes: 22_400_000_000,
    power_source: "ac",
  });
  assert.equal(s.gpuCores, null);
  assert.equal(s.bandwidthGbs, null);
  assert.equal(s.onBattery, false);
});

test("every key this module can emit exists in both languages", () => {
  // t() renders the raw identifier for a missing key, so a typo here ships as
  // "brief.ok" in the interface rather than as a failure anybody notices.
  // TypeScript preserves the app-relative source tree under out/, hence the
  // five-level walk from the compiled test back to app/src.
  const i18n = fs.readFileSync(new URL("../../../../../src/i18n.ts", import.meta.url), "utf8");
  const keys = [
    "brief.ok",
    "brief.adjusted",
    "brief.blocked",
    "brief.layoutSingle",
    "brief.layoutDual",
    "brief.layoutNoRoom",
    "settings.ramEco",
    "settings.ramBalanced",
    "settings.ramPerf",
  ];
  for (const key of keys) {
    assert.ok(i18n.includes(`"${key}"`), `missing i18n key: ${key}`);
  }
});

test("a refusal is shown in the planner's own words, not a template", () => {
  // A user testing the build read: "it needs about 0.0 GB and your Mac can
  // spare 57.8 GB". The refusal path never fills resident_bytes, so the fixed
  // memory template rendered a zero and argued against itself. The planner is
  // the only thing that knows why it said no, and it already writes a sentence.
  const why =
    "not enough free memory to start this model right now: its smallest " +
    "footprint (eco) needs 96.4 GB and this Mac can spare 57.8 GB";
  const b = machineBrief(rec({ blocked: why, resident_bytes: 0 }));
  assert.equal(b.tone, "blocked");
  assert.equal(b.reason, why, "the planner's sentence must survive to the card");
});

test("a brief that is not a refusal carries no reason to render", () => {
  // The renderer prefers reason over the template, so a stray reason on a
  // healthy brief would replace a correct sentence with a stale one.
  assert.equal(machineBrief(rec()).reason, undefined);
  assert.equal(machineBrief(rec({ mode: "eco", requested_mode: "perf" })).reason, undefined);
});
