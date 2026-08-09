// What a run leaves on disk, and what comes back.
//
// The runs view itself cannot be loaded here: it builds an Agent, so it
// imports api.ts and the DOM. Everything worth pinning about persistence lives
// in runrecord.ts for that reason, and this file drives it against real Run
// objects rather than fixtures, so a change to the snapshot shape fails here
// instead of on someone's disk.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { Run, type RunLimits } from "../../src/runs.js";
import {
  RUN_ID_PREFIX,
  decodeRun,
  encodeRun,
  formatDuration,
  isRunId,
  makeRunId,
  recordEntries,
  type RunRecord,
} from "../../src/runrecord.js";

const LIMITS: RunLimits = { maxTurns: 4, maxWallClockMs: 60_000, policy: "propose" };

function clock(): { now: () => number; set: (t: number) => void } {
  let t = 1_000;
  return { now: () => t, set: (v) => { t = v; } };
}

function record(run: Run, prompt = "audit the tree"): RunRecord {
  return {
    id: run.id,
    name: run.name,
    prompt,
    created: 1_000,
    updated: 2_000,
    snapshot: run.snapshot(),
    transcript: run.toJsonl(),
  };
}

test("a run id is namespaced, so a run file is never taken for a conversation", () => {
  const id = makeRunId(1_700_000_000_000, () => 0.5);
  assert.ok(id.startsWith(RUN_ID_PREFIX));
  assert.equal(isRunId(id), true);
  // store.ts's ids start with "c"; the two namespaces must not overlap.
  assert.equal(isRunId("c1a2b3c4"), false);
  assert.equal(isRunId(""), false);
  // The Rust side keeps ASCII alphanumerics, dashes and underscores only
  // (sanitize_id): an id it would rewrite is an id that reads back as another
  // file, or as none.
  assert.match(id, /^[A-Za-z0-9_-]+$/);
});

test("two ids minted in the same millisecond differ", () => {
  let n = 0;
  const rand = () => [0.111111, 0.222222][n++ % 2];
  assert.notEqual(makeRunId(42, rand), makeRunId(42, rand));
});

test("a run survives encode, decode and restore with its state and its budget", () => {
  const c = clock();
  const run = Run.create({ id: makeRunId(1, () => 0.4), name: "audit", limits: LIMITS, now: c.now });
  run.beginTurn();
  run.gate({ kind: "fs_read", detail: "/w/a.ts", elevated: false });
  c.set(5_000);
  run.endTurn({ kind: "continue" });

  const decoded = decodeRun(JSON.parse(encodeRun(record(run))));
  assert.ok(decoded, "a record this module wrote must decode");
  const back = Run.restore(decoded!.snapshot, recordEntries(decoded!), c.now);
  assert.equal(back.getState(), run.getState());
  assert.equal(back.budget().turnsUsed, 1);
  assert.equal(back.budget().turnsLeft, 3);
  assert.equal(back.limits.policy, "propose");
  // The transcript is the whole record, not a tail of it.
  assert.equal(back.transcript().length, run.transcript().length);
});

test("the working clock does not run while the app is closed", () => {
  const c = clock();
  const run = Run.create({ id: makeRunId(2, () => 0.4), name: "audit", limits: LIMITS, now: c.now });
  run.beginTurn();
  c.set(4_000);
  run.endTurn({ kind: "blocked", question: "may I?" });
  const worked = run.elapsedMs();
  const decoded = decodeRun(JSON.parse(encodeRun(record(run))));
  assert.ok(decoded);
  // Three hours pass with the app shut.
  c.set(4_000 + 3 * 3_600_000);
  const back = Run.restore(decoded!.snapshot, recordEntries(decoded!), c.now);
  assert.equal(back.elapsedMs(), worked);
});

test("a half written record is refused rather than repaired", () => {
  const c = clock();
  const run = Run.create({ id: makeRunId(3, () => 0.4), name: "audit", limits: LIMITS, now: c.now });
  const full = record(run);
  const truncated = encodeRun(full).slice(0, 60);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(truncated);
  } catch {
    parsed = null;
  }
  assert.equal(decodeRun(parsed), null);
  // Every single missing or malformed field is a refusal, not a default.
  for (const drop of ["id", "name", "prompt", "snapshot", "transcript"]) {
    const copy = JSON.parse(encodeRun(full)) as Record<string, unknown>;
    delete copy[drop];
    assert.equal(decodeRun(copy), null, `a record without ${drop} must not decode`);
  }
  assert.equal(decodeRun(null), null);
  assert.equal(decodeRun("run-1"), null);
});

test("a record whose id lost its namespace is not a run", () => {
  const c = clock();
  const run = Run.create({ id: makeRunId(4, () => 0.4), name: "audit", limits: LIMITS, now: c.now });
  const copy = JSON.parse(encodeRun(record(run))) as Record<string, unknown>;
  copy.id = "c1a2b3";
  assert.equal(decodeRun(copy), null);
});

test("a record carrying impossible limits is refused before a Run is built from it", () => {
  const c = clock();
  const run = Run.create({ id: makeRunId(5, () => 0.4), name: "audit", limits: LIMITS, now: c.now });
  const copy = JSON.parse(encodeRun(record(run))) as any;
  copy.snapshot.limits.maxTurns = 0;
  assert.equal(decodeRun(copy), null);
  const other = JSON.parse(encodeRun(record(run))) as any;
  other.snapshot.limits.policy = "god_mode";
  assert.equal(decodeRun(other), null);
  const state = JSON.parse(encodeRun(record(run))) as any;
  state.snapshot.state = "half_running";
  assert.equal(decodeRun(state), null);
});

test("an edited snapshot that disagrees with the transcript never restores", () => {
  const c = clock();
  const run = Run.create({ id: makeRunId(6, () => 0.4), name: "audit", limits: LIMITS, now: c.now });
  const copy = JSON.parse(encodeRun(record(run))) as any;
  // The escalation Run.restore exists to refuse: one field of a JSON file
  // turning a propose run into an autonomous one. decodeRun accepts it, since
  // the limits are valid in isolation, and the restore is where it dies.
  copy.snapshot.limits.policy = "autonomous";
  const decoded = decodeRun(copy);
  assert.ok(decoded);
  assert.throws(() => Run.restore(decoded!.snapshot, recordEntries(decoded!), c.now));
});

test("a duration is read without converting anything", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(999), "1s");
  assert.equal(formatDuration(59_000), "59s");
  assert.equal(formatDuration(61_000), "1m 01s");
  assert.equal(formatDuration(3_600_000), "1h 00m");
  // Seconds are dropped past the hour, never rounded up into a minute that
  // has not happened: a budget shown as spent when it is not is a lie.
  assert.equal(formatDuration(3_700_000), "1h 01m");
  assert.equal(formatDuration(3_720_000), "1h 02m");
  assert.equal(formatDuration(-5), "0s");
});
