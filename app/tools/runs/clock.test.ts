// What the run's clock counts, and what it must never count.
//
// Three defects, all in the same arithmetic: elapsed time was a subtraction
// between two absolute timestamps, so it charged the run for every hour the app
// spent closed; the wall-clock limit was read only when a turn started, so one
// turn could run forever; and restore spread its transcript into a function
// call, so the run that had worked longest was the one that could not come
// back.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { Run, parseTranscript, type RunLimits } from "../../src/runs.js";

function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const LIMITS: RunLimits = { maxTurns: 20, maxWallClockMs: 60_000, policy: "autonomous" };

function newRun(clock: { now: () => number }, limits: Partial<RunLimits> = {}) {
  return Run.create({ id: "r", name: "n", limits: { ...LIMITS, ...limits }, now: clock.now });
}

test("a run restored mid work is not charged for the days the app was closed", () => {
  // The hole the blocked-time credit left open. A run interrupted while BLOCKED
  // was refunded on resume and looked correct, so the bug hid; a run
  // interrupted while RUNNING had no such credit, and came back having
  // apparently worked all week.
  const clock = fakeClock(0);
  const run = newRun(clock);
  run.beginTurn();
  clock.advance(100);
  run.endTurn({ kind: "continue" }); // still running, no turn in flight
  const jsonl = run.toJsonl();
  const snap = JSON.parse(JSON.stringify(run.snapshot()));

  clock.advance(7 * 86_400_000); // the machine was off for a week

  const back = Run.restore(snap, parseTranscript(jsonl), clock.now);
  assert.equal(back.getState(), "running");
  assert.equal(back.elapsedMs(), 100, "a week spent closed is not a week spent working");
  assert.equal(back.budget().ok, true, "and it must not have exhausted the run either");

  clock.advance(50);
  assert.equal(back.elapsedMs(), 150, "the clock picks up again from where it stopped");
});

test("a snapshot taken mid turn keeps the time already worked", () => {
  // The mirror of the test above: downtime must not be charged, but work
  // already done must not be refunded by crashing either.
  const clock = fakeClock(0);
  const run = newRun(clock);
  run.beginTurn();
  clock.advance(400);
  const snap = JSON.parse(JSON.stringify(run.snapshot()));
  assert.equal(snap.workedMs, 400, "the open span is closed into the snapshot");
});

test("one turn cannot outlive the wall clock it was given", () => {
  // The limit bounded how many turns could START and not how long one could
  // RUN, so a single turn that looped never met it again. A turn cannot be
  // interrupted from the gate, but it stops being granted anything.
  const clock = fakeClock(0);
  const run = newRun(clock, { maxWallClockMs: 1000 });
  run.beginTurn();
  assert.equal(run.gate({ kind: "shell", detail: "ls", elevated: false }).decision, "allow");

  clock.advance(1000); // the turn is still open and the budget is gone

  assert.deepEqual(
    run.gate({ kind: "shell", detail: "rm -rf build", elevated: false }),
    { decision: "refuse", reason: "expired" },
    "an overrunning turn must not keep spending capabilities",
  );
  assert.equal(
    run.gate({ kind: "fs_read", detail: "/tmp/x", elevated: false }).decision,
    "refuse",
    "not even the harmless kinds: the run is over time, whatever it asks for",
  );

  // And the run ends at the next door, reporting the limit it actually hit.
  run.endTurn({ kind: "continue" });
  assert.deepEqual(run.beginTurn(), { ok: false, state: "exhausted", reason: "budget_clock" });
});

test("the refusal is over time, not over policy", () => {
  // "expired" must be distinguishable from "policy": one means come back with a
  // bigger budget, the other means never.
  const clock = fakeClock(0);
  const run = newRun(clock, { maxWallClockMs: 10, policy: "read_only" });
  run.beginTurn();
  clock.advance(10);
  const out = run.gate({ kind: "fs_read", detail: "/tmp/x", elevated: false });
  assert.deepEqual(out, { decision: "refuse", reason: "expired" });
});

test("a long lived run can still be restored", () => {
  // `run.entries.push(...entries)` and `Math.max(...entries.map(...))` pass one
  // argument per entry. At this size both threw RangeError, which meant the
  // busiest run was the one that could not come back.
  const clock = fakeClock(0);
  const run = newRun(clock, { maxTurns: 1_000_000, maxWallClockMs: 1e9 });
  run.beginTurn();
  for (let i = 0; i < 200_000; i++) {
    run.gate({ kind: "fs_read", detail: `/tmp/f${i}`, elevated: false });
  }
  const entries = run.transcript();
  assert.ok(entries.length > 150_000, `expected a long transcript, got ${entries.length}`);
  const snap = JSON.parse(JSON.stringify(run.snapshot()));

  const back = Run.restore(snap, entries, clock.now);
  // Restore closes the interrupted turn itself, so it appends before anyone
  // else does. What must hold is the invariant, not a count: sequence numbers
  // continue past every inherited one and none is ever reused.
  back.cancel("done");
  const seqs = back.transcript().map((e) => e.seq);
  assert.ok(seqs.length > entries.length, "restore and cancel both appended");
  assert.deepEqual(
    seqs,
    seqs.slice().sort((a, b) => a - b),
    "sequence numbers must stay monotonic across a restore",
  );
  assert.equal(new Set(seqs).size, seqs.length, "no sequence number may be reused");
});
