// Budget: spent only after it was checked, and exact at the boundary.
// @ts-ignore Node's built-in runner is used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { Run, validateLimits, type RunLimits } from "../../src/runs.js";

/** A clock the test moves by hand. Nothing in runs.ts reads Date.now. */
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

const LIMITS: RunLimits = { maxTurns: 3, maxWallClockMs: 1000, policy: "read_only" };

function newRun(limits: Partial<RunLimits> = {}, clock = fakeClock()) {
  return {
    clock,
    run: Run.create({ id: "r", name: "n", limits: { ...LIMITS, ...limits }, now: clock.now }),
  };
}

test("limits are validated at declaration, never silently defaulted", () => {
  assert.equal(validateLimits(LIMITS), null);
  assert.equal(validateLimits({ ...LIMITS, maxTurns: 0 }), "max_turns");
  assert.equal(validateLimits({ ...LIMITS, maxTurns: 1.5 }), "max_turns");
  assert.equal(validateLimits({ ...LIMITS, maxWallClockMs: 0 }), "max_wall_clock");
  assert.equal(validateLimits({ ...LIMITS, maxWallClockMs: Number.POSITIVE_INFINITY }), "max_wall_clock");
  assert.equal(validateLimits({ ...LIMITS, policy: "everything" as never }), "policy");
  assert.throws(
    () => Run.create({ id: "r", name: "n", limits: { ...LIMITS, maxTurns: 0 }, now: () => 0 }),
    /invalid run limits: max_turns/,
  );
});

test("the last affordable turn runs and the next one is refused before it starts", () => {
  const { run } = newRun({ maxTurns: 3 });
  for (let i = 1; i <= 3; i++) {
    const begun = run.beginTurn();
    assert.deepEqual(begun, { ok: true, turn: i, state: "running" });
    assert.equal(run.endTurn({ kind: "continue" }).ok, true);
  }
  const over = run.beginTurn();
  assert.deepEqual(over, { ok: false, state: "exhausted", reason: "budget_turns" });
  assert.equal(run.getState(), "exhausted");
  // The refusal must come with NO turn number: a caller cannot run a turn it
  // was not granted, and turnsUsed must not have moved.
  assert.equal(run.budget().turnsUsed, 3);
  assert.equal(run.transcript().filter((e) => e.type === "turn_begin").length, 3);
});

test("wall clock is checked before the turn, and exactly at the limit the budget is spent", () => {
  const { run, clock } = newRun({ maxTurns: 50, maxWallClockMs: 1000 });
  run.beginTurn();
  run.endTurn({ kind: "continue" });
  clock.set(999);
  assert.equal(run.budget().ok, true, "one millisecond left is still a budget");
  assert.equal(run.beginTurn().ok, true);
  run.endTurn({ kind: "continue" });
  clock.set(1000);
  const status = run.budget();
  assert.deepEqual(
    { ok: status.ok, reason: status.reason, msLeft: status.msLeft },
    { ok: false, reason: "clock", msLeft: 0 },
    "at exactly maxWallClockMs there is nothing left to spend",
  );
  assert.deepEqual(run.beginTurn(), { ok: false, state: "exhausted", reason: "budget_clock" });
});

test("the clock starts at the first turn, not at declaration", () => {
  const { run, clock } = newRun({ maxWallClockMs: 1000 });
  // A run can sit in a server queue for a long time. That wait is not work.
  clock.advance(10_000);
  assert.equal(run.elapsedMs(), 0);
  assert.equal(run.beginTurn().ok, true, "a queued run must not exhaust before it starts");
  clock.advance(500);
  assert.equal(run.elapsedMs(), 500);
});

test("time spent blocked on a human is not charged to the run", () => {
  const { run, clock } = newRun({ maxTurns: 10, maxWallClockMs: 1000 });
  run.beginTurn();
  clock.advance(200);
  run.endTurn({ kind: "blocked", question: "which branch?" });
  clock.advance(3_600_000); // the human went to lunch
  assert.equal(run.elapsedMs(), 200, "a blocked run is waiting, not working");
  run.resume("main");
  clock.advance(300);
  assert.equal(run.elapsedMs(), 500);
  assert.equal(run.budget().ok, true);
});

test("budget() never spends anything", () => {
  const { run } = newRun({ maxTurns: 1 });
  for (let i = 0; i < 5; i++) assert.equal(run.budget().ok, true);
  assert.equal(run.budget().turnsUsed, 0);
  assert.equal(run.getState(), "queued", "reading the budget must not move the state machine");
  assert.equal(run.beginTurn().ok, true);
});

test("exhaustion is reached through beginTurn, never through endTurn", () => {
  const { run } = newRun({ maxTurns: 1 });
  run.beginTurn();
  run.endTurn({ kind: "continue" });
  assert.equal(run.getState(), "running", "spending the last turn does not end the run by itself");
  assert.deepEqual(run.beginTurn(), { ok: false, state: "exhausted", reason: "budget_turns" });
  assert.equal(run.getState(), "exhausted");
});

test("a run out of both turns and clock reports the turn limit it was designed around", () => {
  const { run, clock } = newRun({ maxTurns: 1, maxWallClockMs: 100 });
  run.beginTurn();
  clock.advance(500);
  run.endTurn({ kind: "continue" });
  assert.equal(run.budget().reason, "turns");
  assert.deepEqual(run.beginTurn(), { ok: false, state: "exhausted", reason: "budget_turns" });
});
