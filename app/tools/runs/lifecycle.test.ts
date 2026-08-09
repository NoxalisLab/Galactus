// The state machine: every transition legal or refused, nothing implicit.
// @ts-ignore Node's built-in runner is used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { RUN_STATES, Run, isTerminal, type RunLimits, type RunState } from "../../src/runs.js";

function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

const LIMITS: RunLimits = { maxTurns: 5, maxWallClockMs: 10_000, policy: "autonomous" };

function newRun(limits: Partial<RunLimits> = {}, now: () => number = () => 0) {
  return Run.create({ id: "r", name: "nightly", limits: { ...LIMITS, ...limits }, now });
}

/** Bring a run into a named state through legal transitions only. */
function runIn(state: RunState): Run {
  const clock = fakeClock();
  const run = Run.create({ id: "r", name: "n", limits: { ...LIMITS, maxTurns: 1 }, now: clock.now });
  switch (state) {
    case "queued":
      return run;
    case "running":
      run.beginTurn();
      run.endTurn({ kind: "continue" });
      return run;
    case "blocked":
      run.beginTurn();
      run.endTurn({ kind: "blocked", question: "?" });
      return run;
    case "finished":
      run.beginTurn();
      run.endTurn({ kind: "final", text: "done" });
      return run;
    case "failed":
      run.beginTurn();
      run.endTurn({ kind: "failed", error: "boom" });
      return run;
    case "cancelled":
      run.cancel();
      return run;
    case "exhausted":
      run.beginTurn();
      run.endTurn({ kind: "continue" });
      run.beginTurn();
      return run;
  }
}

test("every declared state is reachable through legal transitions", () => {
  for (const state of RUN_STATES) {
    assert.equal(runIn(state).getState(), state, `${state} is not reachable`);
  }
});

// Written out rather than derived from isTerminal, which is the function under
// test: `RUN_STATES.filter(isTerminal)` meant that deleting a state from
// TERMINAL_STATES simply removed it from the loop, and all four deletions
// passed. A test whose input comes from its subject cannot fail.
const TERMINAL: readonly RunState[] = ["finished", "failed", "cancelled", "exhausted"];

test("the module and this file agree on which states are terminal", () => {
  assert.deepEqual(
    RUN_STATES.filter(isTerminal).slice().sort(),
    TERMINAL.slice().sort(),
    "a state changed sides: decide it here, deliberately, then in the module",
  );
});

test("no terminal state accepts any further transition", () => {
  for (const state of TERMINAL) {
    const run = runIn(state);
    assert.deepEqual(run.beginTurn(), { ok: false, state, reason: "terminal" });
    assert.deepEqual(run.endTurn({ kind: "continue" }), { ok: false, state, reason: "terminal" });
    assert.deepEqual(run.resume("x"), { ok: false, state, reason: "terminal" });
    assert.deepEqual(run.cancel(), { ok: false, state, reason: "terminal" });
    assert.equal(run.getState(), state, `${state} moved after a refused transition`);
  }
});

test("two turns cannot be in flight at once", () => {
  const run = newRun();
  assert.equal(run.beginTurn().ok, true);
  assert.deepEqual(run.beginTurn(), { ok: false, state: "running", reason: "turn_in_flight" });
  assert.equal(run.budget().turnsUsed, 1, "a refused begin must not spend a turn");
});

test("endTurn without a turn in flight is refused, it does not invent one", () => {
  const run = newRun();
  assert.deepEqual(run.endTurn({ kind: "continue" }), {
    ok: false,
    state: "queued",
    reason: "no_turn_in_flight",
  });
  run.beginTurn();
  run.endTurn({ kind: "continue" });
  assert.deepEqual(run.endTurn({ kind: "final", text: "x" }), {
    ok: false,
    state: "running",
    reason: "no_turn_in_flight",
  });
  assert.equal(run.getState(), "running");
});

test("resume only answers a block", () => {
  const run = newRun();
  assert.deepEqual(run.resume("yes"), { ok: false, state: "queued", reason: "not_blocked" });
  run.beginTurn();
  assert.deepEqual(run.resume("yes"), { ok: false, state: "running", reason: "not_blocked" });
  run.endTurn({ kind: "blocked", question: "which branch?" });
  assert.equal(run.pendingQuestion(), "which branch?");
  assert.deepEqual(run.resume("main"), { ok: true, state: "running" });
  assert.equal(run.pendingQuestion(), null);
});

test("a blocked run says what it waits for and picks up where it stopped", () => {
  const run = newRun({ maxTurns: 4 });
  run.beginTurn();
  run.endTurn({ kind: "blocked", question: "push to main?" });
  assert.equal(run.getState(), "blocked");
  assert.equal(run.pendingQuestion(), "push to main?");
  assert.deepEqual(run.beginTurn(), { ok: false, state: "blocked", reason: "blocked" });
  run.resume("no, open a branch");
  const second = run.beginTurn();
  assert.deepEqual(second, { ok: true, turn: 2, state: "running" });
  const answers = run.transcript().filter((e) => e.type === "answer");
  assert.equal(answers.length, 1);
  assert.equal(answers[0].type === "answer" ? answers[0].text : "", "no, open a branch");
});

test("blocking is an outcome, never a failure", () => {
  const run = newRun();
  run.beginTurn();
  run.endTurn({ kind: "blocked", question: "?" });
  assert.notEqual(run.getState(), "failed");
  assert.equal(run.failure(), null);
  assert.equal(isTerminal(run.getState()), false, "a blocked run must still be resumable");
});

test("a cancel arriving mid turn waits for the turn to close, then wins", () => {
  const run = newRun();
  run.beginTurn();
  assert.deepEqual(run.cancel("user"), { ok: true, state: "running" });
  assert.equal(run.getState(), "running", "reporting cancelled while the turn still runs is a lie");
  // Even a final answer does not override the cancel: the user asked to stop.
  assert.deepEqual(run.endTurn({ kind: "final", text: "all done" }), { ok: true, state: "cancelled" });
  assert.equal(run.getState(), "cancelled");
  assert.equal(run.finalResult(), null);
  // The truth of the turn is still on the record.
  const ends = run.transcript().filter((e) => e.type === "turn_end");
  assert.equal(ends[0].type === "turn_end" ? ends[0].detail : "", "all done");
});

test("once a cancel is requested the gate refuses everything, even under autonomous", () => {
  const run = newRun({ policy: "autonomous" });
  run.beginTurn();
  assert.deepEqual(run.gate({ kind: "fs_read", detail: "/a", elevated: false }), { decision: "allow" });
  run.cancel();
  assert.deepEqual(run.gate({ kind: "fs_read", detail: "/a", elevated: false }), {
    decision: "refuse",
    reason: "cancelled",
  });
});

test("a cancel while blocked lands immediately and stops charging the wait", () => {
  const clock = fakeClock();
  const run = newRun({}, clock.now);
  run.beginTurn();
  run.endTurn({ kind: "blocked", question: "?" });
  clock.advance(5_000);
  assert.deepEqual(run.cancel("host shutdown"), { ok: true, state: "cancelled" });
  assert.equal(run.elapsedMs(), 0, "the wait for a human is not working time");
});

test("a turn that throws fails the run and still closes the turn", async () => {
  const run = newRun();
  const result = await run.execute(async () => {
    throw new Error("engine died mid stream");
  });
  assert.deepEqual(result, { ok: true, turn: 1, state: "failed" });
  assert.equal(run.failure(), "engine died mid stream");
  const kinds = run.transcript().map((e) => e.type);
  assert.equal(kinds.filter((k) => k === "turn_begin").length, 1);
  assert.equal(
    kinds.filter((k) => k === "turn_end").length,
    1,
    "a thrown turn must not leave a turn_begin without its turn_end",
  );
});

test("execute refuses to run past the budget and never calls the work", async () => {
  const run = newRun({ maxTurns: 1 });
  let calls = 0;
  await run.execute(async () => {
    calls++;
    return { kind: "continue" };
  });
  const refused = await run.execute(async () => {
    calls++;
    return { kind: "continue" };
  });
  assert.deepEqual(refused, { ok: false, state: "exhausted", reason: "budget_turns" });
  assert.equal(calls, 1, "the work ran on a turn the budget had not granted");
});

test("a turn can see a cancel land while it is still running", async () => {
  const run = newRun();
  const observed: boolean[] = [];
  await run.execute(async (ctx) => {
    observed.push(ctx.cancelled());
    run.cancel();
    observed.push(ctx.cancelled());
    return { kind: "continue" };
  });
  assert.deepEqual(observed, [false, true]);
  assert.equal(run.getState(), "cancelled");
});
