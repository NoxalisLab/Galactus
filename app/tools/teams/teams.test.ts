// @ts-ignore Node's built-in runner is used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

// @ts-ignore Node types are deliberately not added to the app dependency graph.
import fs from "node:fs";

import {
  activePreset,
  copyId,
  engineFor,
  mergePresets,
  normalizeEngine,
  parsePresets,
  portFor,
  presetFootprint,
  presetsFromRegistry,
  resolveRole,
  serializeUserPresets,
  teamBudget,
  teamToolText,
  ENGINE_OVERHEAD_BYTES,
  cloudModelId,
  cloudSlug,
  isCloud,
  redactMessages,
  type CloudState,
  type EngineInfo,
  type StoredPreset,
  type TeamPreset,
} from "../../src/teams.js";

const shipped: StoredPreset[] = [
  { id: "a", name: "A", roles: { planner: "p1", coder: "c1" }, note: "shipped a" },
  { id: "b", name: "B", roles: { planner: "p2", coder: "c1" } },
];

// ---------- parsing and merge ----------

test("invalid entries are dropped, not repaired", () => {
  const got = parsePresets([
    { id: "ok", roles: { Coder: " m1 " } },
    { id: "", roles: { coder: "m" } },
    { id: "noroles", roles: {} },
    { id: "badroles", roles: { coder: 3 } },
    "nope",
    { roles: { coder: "m" } },
  ]);
  assert.deepEqual(got, [{ id: "ok", name: "ok", roles: { coder: "m1" } }]);
  assert.deepEqual(parsePresets("not json"), []);
  assert.deepEqual(parsePresets({ id: "x" }), []);
});

test("no user presets: the shipped list, in order, marked shipped", () => {
  const got = mergePresets(shipped, "");
  assert.deepEqual(got.map((p) => [p.id, p.source]), [["a", "shipped"], ["b", "shipped"]]);
});

test("a user preset with a shipped id overrides it in place; new ids follow", () => {
  const user = JSON.stringify([
    { id: "new", name: "Mine", roles: { reviewer: "r1" } },
    { id: "b", name: "B edited", roles: { planner: "p9" } },
  ]);
  const got = mergePresets(shipped, user);
  assert.deepEqual(got.map((p) => [p.id, p.source]), [["a", "shipped"], ["b", "override"], ["new", "user"]]);
  assert.deepEqual(got[1].roles, { planner: "p9" });
  assert.equal(got[1].name, "B edited");
});

test("within the user's list the last entry of an id wins", () => {
  const user = [
    { id: "x", roles: { coder: "old" } },
    { id: "x", roles: { coder: "new" } },
  ];
  const got = mergePresets([], user);
  assert.equal(got.length, 1);
  assert.equal(got[0].roles.coder, "new");
});

test("serializing keeps only the user's entries and round-trips through merge", () => {
  const merged = mergePresets(shipped, [{ id: "b", roles: { planner: "p9" } }, { id: "z", roles: { coder: "c" } }]);
  const stored = serializeUserPresets(merged);
  const back = JSON.parse(stored);
  assert.deepEqual(back.map((p: { id: string }) => p.id), ["b", "z"]);
  assert.ok(!stored.includes("source"));
  assert.deepEqual(mergePresets(shipped, stored), merged);
});

test("reset: dropping the override brings the shipped preset back", () => {
  const merged = mergePresets(shipped, [{ id: "a", roles: { coder: "zz" } }]);
  const reset = merged.map((p) => (p.id === "a" ? { ...shipped[0], source: "shipped" as const } : p));
  assert.equal(serializeUserPresets(reset), "[]");
  assert.deepEqual(mergePresets(shipped, serializeUserPresets(reset))[0].roles, shipped[0].roles);
});

test("active preset: empty id is off, an unknown id is off", () => {
  const list = mergePresets(shipped, "");
  assert.equal(activePreset(list, ""), null);
  assert.equal(activePreset(list, "  "), null);
  assert.equal(activePreset(list, "gone"), null);
  assert.equal(activePreset(list, "b")?.id, "b");
});

test("a copy gets a fresh id", () => {
  const list = mergePresets(shipped, [{ id: "a-copie", roles: { coder: "c" } }]);
  assert.equal(copyId(list, "b"), "b-copie");
  assert.equal(copyId(list, "a"), "a-copie-2");
  assert.equal(copyId(list, "a-copie"), "a-copie-2");
});

// ---------- role -> model ----------

const models = [
  { id: "p1", name: "Planner One", runnable: true },
  { id: "c1", name: "Coder One", runnable: true },
  { id: "p2", name: "Planner Two", runnable: false },
];
const presets = mergePresets(shipped, "");

test("a known role on a runnable model resolves to that model", () => {
  assert.deepEqual(resolveRole(presets[0], "coder", models, "p1"), { kind: "model", modelId: "c1", primary: false, engine: "local" });
});

test("the role whose model is the primary resolves to the primary, even if not listed", () => {
  assert.deepEqual(resolveRole(presets[0], " Planner ", [], "p1"), { kind: "model", modelId: "p1", primary: true, engine: "local" });
});

test("every failure falls back to the primary with one sentence", () => {
  const noRole = resolveRole(presets[0], "", models, "p1");
  assert.equal(noRole.kind, "primary");
  const off = resolveRole(null, "coder", models, "p1");
  assert.ok(off.kind === "primary" && off.reason === "disabled" && off.sentence.length > 0);
  const unknown = resolveRole(presets[0], "reviewer", models, "p1");
  assert.ok(unknown.kind === "primary" && unknown.reason === "unknown-role");
  assert.match(unknown.kind === "primary" ? unknown.sentence : "", /planner, coder/);
  const blocked = resolveRole(presets[1], "planner", models, "c1");
  assert.ok(blocked.kind === "primary" && blocked.reason === "not-runnable");
  const missing = resolveRole({ ...presets[0], roles: { coder: "ghost" } }, "coder", models, "p1");
  assert.ok(missing.kind === "primary" && missing.reason === "unknown-model");
});

// ---------- routing ----------

const engines: EngineInfo[] = [
  normalizeEngine({ model_id: "p1", role: "", port: 8737, phase: "ready", primary: true, slots: 2 })!,
  normalizeEngine({ modelId: "c1", role: "coder", port: 8811, phase: "ready", primary: false, slots: 1, ctxPerSlot: 32768 })!,
];

test("engines normalise from either casing", () => {
  assert.equal(engines[0].modelId, "p1");
  assert.equal(engines[1].ctxPerSlot, 32768);
  assert.equal(engines[1].toolsOk, null);
  assert.equal(normalizeEngine({ port: 1 }), null);
  assert.equal(normalizeEngine({ model_id: "x", port: 0 }), null);
});

test("portFor sends a model's request to its own engine", () => {
  assert.equal(portFor("c1", engines, 8737), 8811);
  assert.equal(portFor("p1", engines, 8737), 8737);
});

test("portFor falls back to the primary port when nothing serves the model", () => {
  assert.equal(portFor("nobody", engines, 8737), 8737);
  assert.equal(portFor(null, engines, 9000), 9000);
  assert.equal(portFor("c1", [], 9000), 9000);
});

test("portFor prefers the ready engine of a model", () => {
  const two = [
    normalizeEngine({ model_id: "c1", port: 1111, phase: "starting" })!,
    normalizeEngine({ model_id: "c1", port: 2222, phase: "ready" })!,
  ];
  assert.equal(portFor("c1", two, 8737), 2222);
  assert.equal(engineFor("c1", [two[0]])?.port, 1111);
});

// ---------- footprint ----------

test("footprint: dense resident, experts resident while they fit, streamed after", () => {
  const sized = [
    { id: "d", gguf_bytes: 17e9, non_expert_bytes: 17e9, dense: true },
    { id: "small", gguf_bytes: 22e9, non_expert_bytes: 2.5e9, expert_bytes_total: 19.5e9 },
    { id: "huge", gguf_bytes: 155e9, non_expert_bytes: 8e9, expert_bytes_total: 147e9 },
  ];
  const p = { id: "t", name: "t", roles: { planner: "huge", coder: "small", critic: "d" }, source: "user" as const };
  const fp = presetFootprint(p, sized, 100e9);
  const o = ENGINE_OVERHEAD_BYTES;
  assert.equal(fp.bytes, 17e9 + o + 22e9 + o + 8e9 + o);
  assert.equal(fp.fits, true);
  assert.deepEqual(fp.roles.filter((r) => r.streamed).map((r) => r.modelId), ["huge"]);
  assert.equal(presetFootprint(p, sized, 30e9).fits, false);
});

test("footprint: a model shared by two roles is counted once; unknown models make it unknown", () => {
  const sized = [{ id: "d", gguf_bytes: 10e9, dense: true }];
  const shared = presetFootprint({ id: "s", name: "s", roles: { a: "d", b: "d" }, source: "user" }, sized, 50e9);
  assert.equal(shared.bytes, 10e9 + ENGINE_OVERHEAD_BYTES);
  const ghost = presetFootprint({ id: "g", name: "g", roles: { a: "d", b: "ghost" }, source: "user" }, sized, 50e9);
  assert.deepEqual(ghost.missing, ["ghost"]);
  assert.equal(ghost.fits, null);
});

test("the team budget is the smaller of the engine budget and Metal's working set", () => {
  assert.equal(teamBudget({ engine_budget_bytes: 100e9, gpu_working_set_bytes: 90e9 }), 90e9);
  assert.equal(teamBudget({ engine_budget_bytes: 100e9, gpu_working_set_bytes: null }), 100e9);
  assert.equal(teamBudget(null), null);
});

test("the tool text lists the roles and says which one the orchestrator runs as", () => {
  assert.equal(teamToolText(null, (id) => id, "p1"), "");
  const txt = teamToolText(presets[0], (id) => id.toUpperCase(), "p1");
  assert.match(txt, /planner = P1 \(the model you run on\)/);
  assert.match(txt, /coder = C1/);
});

// ---------- the shipped data ----------

test("the registry's team presets parse and name only catalogued models", () => {
  const raw = fs.readFileSync(new URL("../../../../../../scripts/models-registry.json", import.meta.url), "utf8");
  const reg = JSON.parse(raw);
  const ids = new Set((reg.models as { id: string }[]).map((m) => m.id));
  const list = presetsFromRegistry(raw);
  assert.equal(list.length, (reg.team_presets as unknown[]).length);
  for (const p of list)
    for (const target of Object.values(p.roles)) {
      // A cloud role names a provider's model, not a catalogue entry.
      if (isCloud(target)) continue;
      assert.ok(ids.has(target), `${p.id}: ${target} is not in models`);
    }
});

// ---------- cloud roles ----------

const hybrid: TeamPreset = mergePresets(
  [
    {
      id: "h",
      name: "H",
      roles: { planner: "p1", expert: { kind: "cloud", provider: "openrouter", model: "vendor/big" } },
    },
  ],
  ""
)[0];
const on: CloudState = { enabled: { openrouter: true }, keyed: { openrouter: true } };

test("a cloud role value parses, including an empty model waiting to be chosen", () => {
  const got = parsePresets([
    { id: "c", roles: { expert: { kind: "cloud", provider: "OpenRouter", model: "" }, bad: { kind: "cloud" } } },
  ]);
  assert.deepEqual(got[0].roles, { expert: { kind: "cloud", provider: "openrouter", model: "" } });
  assert.ok(isCloud(got[0].roles.expert));
});

test("a configured cloud role resolves to its proxy id", () => {
  const r = resolveRole(hybrid, "expert", models, "p1", on);
  assert.deepEqual(r, { kind: "model", modelId: "cloud:openrouter/vendor/big", primary: false, engine: "cloud" });
  assert.equal(cloudSlug("cloud:openrouter/vendor/big"), "vendor/big");
  assert.equal(cloudModelId({ kind: "cloud", provider: "openrouter", model: "a/b" }), "cloud:openrouter/a/b");
});

test("a cloud role falls back to the primary when not configured, disabled or keyless", () => {
  const empty = { ...hybrid, roles: { ...hybrid.roles, expert: { kind: "cloud" as const, provider: "openrouter", model: "" } } };
  const a = resolveRole(empty, "expert", models, "p1", on);
  assert.ok(a.kind === "primary" && a.reason === "cloud-unconfigured" && a.sentence.length > 0);
  const b = resolveRole(hybrid, "expert", models, "p1");
  assert.ok(b.kind === "primary" && b.reason === "cloud-disabled");
  const c = resolveRole(hybrid, "expert", models, "p1", { enabled: { openrouter: true }, keyed: {} });
  assert.ok(c.kind === "primary" && c.reason === "cloud-no-key");
});

test("a cloud role costs nothing here and is offered to the orchestrator only when usable", () => {
  const fp = presetFootprint(hybrid, [{ id: "p1", gguf_bytes: 10e9, dense: true }], 50e9);
  assert.equal(fp.bytes, 10e9 + ENGINE_OVERHEAD_BYTES);
  assert.deepEqual(fp.roles.filter((r) => r.cloud).map((r) => r.role), ["expert"]);
  assert.doesNotMatch(teamToolText(hybrid, (id) => id, "p1"), /expert/);
  const txt = teamToolText(hybrid, (id) => id, "p1", on);
  assert.match(txt, /expert = vendor\/big \(CLOUD/);
  assert.match(txt, /costs money/);
});

test("cloud engines are recognised from kind or from their id", () => {
  assert.equal(normalizeEngine({ model_id: "cloud:openrouter/x/y", port: 9100, phase: "ready", kind: "cloud" })!.kind, "cloud");
  assert.equal(normalizeEngine({ model_id: "cloud:openrouter/x/y", port: 9100 })!.kind, "cloud");
  assert.equal(normalizeEngine({ model_id: "p1", port: 9100 })!.kind, "local");
});

test("redaction masks secrets on a copy and counts them", () => {
  const msgs = [
    { role: "system", content: "You are helpful." },
    { role: "tool", content: "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789" },
    { role: "assistant", content: null },
  ];
  const r = redactMessages(msgs);
  assert.ok(r.removed >= 1);
  assert.doesNotMatch(String(r.messages[1].content), /sk-proj-abcdef/);
  assert.equal(r.messages[0], msgs[0]);
  assert.match(String(msgs[1].content), /sk-proj-abcdef/, "the original history is untouched");
});
