// The bridge between a run's gate and the agent's permission dialog.
//
// Everything here is about one translation: the gate answers allow/refuse/block
// and the agent expects once/always/deny. The two vocabularies overlap enough
// to look interchangeable and are not, and the gap is where an unattended run
// would pick up something nobody granted it.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { Run, type RunLimits, type RunPolicy } from "../../src/runs.js";
import {
  driveRun,
  driveTurn,
  type DrivableAgent,
  type DrivePermissionRequest,
  type RunDecision,
  type RunTurnHooks,
} from "../../src/rundrive.js";

const LIMITS: RunLimits = { maxTurns: 5, maxWallClockMs: 60_000, policy: "autonomous" };

function newRun(policy: RunPolicy = "autonomous", over: Partial<RunLimits> = {}): Run {
  return Run.create({ id: "r", name: "n", limits: { ...LIMITS, policy, ...over }, now: () => 0 });
}

/**
 * An agent that plays a fixed script. Each step is something the real agent
 * would do inside send(): ask for a permission, stream text, fail. Nothing here
 * touches the network, and stop() cuts the script short exactly as an abort
 * cuts a stream.
 */
type Step =
  | { ask: DrivePermissionRequest }
  | { say: string }
  | { fail: string }
  | { tool: [string, string, string] };

function scripted(steps: Step[]) {
  let hooks: RunTurnHooks | null = null;
  const asked: RunDecision[] = [];
  let stopped = false;
  const agent: DrivableAgent = {
    async send() {
      for (const step of steps) {
        if (stopped) break;
        if ("ask" in step) asked.push(await hooks!.askPermission(step.ask));
        else if ("say" in step) hooks!.onDelta(step.say);
        else if ("fail" in step) hooks!.onError(step.fail);
        else hooks!.onToolResult(step.tool[0], step.tool[2]);
      }
    },
    stop() {
      stopped = true;
    },
  };
  return {
    agent,
    asked,
    bind: (h: RunTurnHooks) => {
      hooks = h;
    },
    get stopped() {
      return stopped;
    },
  };
}

const READ: DrivePermissionRequest = { kind: "fs_read", detail: "/w/a.ts", elevated: false };
const WRITE: DrivePermissionRequest = { kind: "fs_write", detail: "/w/a.ts", elevated: false };
const SUDO: DrivePermissionRequest = { kind: "shell", detail: "sudo rm -rf /", elevated: true };
const PUSH: DrivePermissionRequest = {
  kind: "git",
  detail: "push origin main (3)",
  elevated: false,
  noAlways: true,
};

test("a granted step is granted once, never always", () => {
  // "always" writes a standing rule. A rule written by a run nobody watched
  // would outlive it and pre-approve the same action in a later attended
  // session, in another project. The run's grant must die with the run, so the
  // string is checked, not merely "not deny".
  const run = newRun("autonomous");
  const s = scripted([{ ask: READ }, { ask: WRITE }, { say: "done" }]);
  return driveTurn(run, s.agent, "go", s.bind).then(() => {
    assert.deepEqual(s.asked, ["once", "once"]);
    assert.ok(!s.asked.includes("always" as RunDecision), "no run may write a standing rule");
  });
});

test("a refused step is denied and the turn carries on", async () => {
  // Refuse means asking would not help. The model is told no and keeps going,
  // exactly as when a human presses Deny: stopping the run would turn every
  // elevated attempt into a dead task.
  const run = newRun("autonomous");
  const s = scripted([{ ask: SUDO }, { say: "understood, skipping that" }]);
  const outcome = await driveTurn(run, s.agent, "go", s.bind);
  assert.deepEqual(s.asked, ["deny"]);
  assert.ok(!s.stopped, "a refusal must not abort the turn");
  assert.deepEqual(outcome, { kind: "final", text: "understood, skipping that" });
});

test("a blockable step parks the run instead of guessing", async () => {
  // The difference that matters: a human COULD grant this one. Denying and
  // moving on would quietly downgrade the task; granting it would be the
  // escalation. So the run stops, with a question someone can act on.
  const run = newRun("read_only");
  const s = scripted([{ ask: WRITE }, { say: "wrote it anyway" }]);
  const outcome = await driveTurn(run, s.agent, "go", s.bind);
  assert.equal(s.asked[0], "deny", "the step itself is still denied");
  assert.ok(s.stopped, "the turn is aborted, not left running past the block");
  assert.equal(outcome?.kind, "blocked");
  assert.equal(run.getState(), "blocked");
  const q = run.pendingQuestion() ?? "";
  assert.match(q, /fs_write/, "the question must name the kind");
  assert.match(q, /\/w\/a\.ts/, "and the thing it applies to");
});

test("blocked beats the text the model was still streaming", async () => {
  // The stream does not stop the instant stop() is called, so a blocked turn
  // often has text. Reporting it as the final answer would let a run that was
  // stopped mid task look like a run that finished one.
  const run = newRun("read_only");
  const s = scripted([{ say: "here is my answer" }, { ask: WRITE }]);
  const outcome = await driveTurn(run, s.agent, "go", s.bind);
  assert.equal(outcome?.kind, "blocked");
  assert.equal(run.finalResult(), null, "a blocked run has no final result");
});

test("the model is cut off at the block, not left working past it", async () => {
  // What the stop() call on the block branch is actually for. Denying the step
  // and recording the question belong to other tests; this one owns the third
  // thing that has to happen, and owns it by its consequence rather than by a
  // flag: a parked run is a run that has stopped spending, so nothing the model
  // does after the park may be delivered, recorded, or counted as its answer.
  //
  // The test named "only the first blockable step is recorded" cannot be this
  // test. It drives an agent built to IGNORE stop, on purpose, so that the
  // recording rule is exercised rather than hidden by an obedient fake. The
  // fake here obeys, which is what makes the work after the block absent.
  const run = newRun("read_only");
  const s = scripted([
    { ask: WRITE },
    { tool: ["fs_read", "/w/b.ts", "contents of b"] },
    { say: "and here is what I found" },
  ]);
  const delivered: string[] = [];
  await driveTurn(run, s.agent, "go", s.bind, {
    delta: (text) => delivered.push(`delta ${text}`),
    toolResult: (name) => delivered.push(`tool ${name}`),
  });
  assert.deepEqual(delivered, [], "no work after the park reaches the sink");
  assert.deepEqual(
    run.transcript().filter((e) => e.type === "tool"),
    [],
    "and none of it reaches the transcript either",
  );
  assert.ok(s.stopped, "which is true only because the agent was told to stop");
  assert.equal(run.finalResult(), null, "a parked run has no answer to report");
  assert.equal(run.getState(), "blocked");
});

test("a shown-every-time step blocks and says why", async () => {
  // git push carries noAlways because the user must see the branch and the
  // count. An unattended run cannot show it to anyone, so it stops.
  const run = newRun("autonomous");
  const s = scripted([{ ask: PUSH }]);
  await driveTurn(run, s.agent, "go", s.bind);
  assert.equal(run.getState(), "blocked");
  assert.match(run.pendingQuestion() ?? "", /every time/i);
});

test("only the first blockable step is recorded, even if the agent ignores the stop", async () => {
  // Queueing every subsequent question would ask a human about steps the model
  // only planned because the first one had not failed yet.
  //
  // The agent here keeps asking AFTER stop(), which is not a contrived case: a
  // real abort cancels the stream, it does not unwind a tool call already in
  // flight. An agent that stops obediently would make this test pass whatever
  // the code did with the second question.
  const run = newRun("read_only");
  let hooks: RunTurnHooks | null = null;
  const stubborn: DrivableAgent = {
    async send() {
      await hooks!.askPermission(WRITE);
      await hooks!.askPermission({ ...WRITE, detail: "/w/b.ts" });
    },
    stop() {},
  };
  await driveTurn(run, stubborn, "go", (h) => {
    hooks = h;
  });
  const q = run.pendingQuestion() ?? "";
  assert.match(q, /a\.ts/, "the question a human answers is the one that stopped the run");
  assert.doesNotMatch(q, /b\.ts/, "a later block must not overwrite the one already recorded");
});

test("a throwing agent fails the turn, it does not leave it open", async () => {
  const run = newRun();
  const agent: DrivableAgent = {
    async send() {
      throw new Error("connection reset");
    },
    stop() {},
  };
  const outcome = await driveTurn(run, agent, "go", () => {});
  assert.deepEqual(outcome, { kind: "failed", error: "connection reset" });
  assert.equal(run.getState(), "failed");
  const kinds = run.transcript().map((e) => e.type);
  assert.ok(kinds.includes("turn_end"), "the transcript must not end on an unbalanced turn_begin");
});

test("the first error is the one reported", async () => {
  // A failing turn produces a cascade, and the last error is usually a
  // consequence of the first.
  const run = newRun();
  const s = scripted([{ fail: "port closed" }, { fail: "stream ended" }]);
  const outcome = await driveTurn(run, s.agent, "go", s.bind);
  assert.deepEqual(outcome, { kind: "failed", error: "port closed" });
});

test("a turn that produces nothing is not an answer and not a failure", async () => {
  const run = newRun();
  const s = scripted([{ ask: READ }]);
  const outcome = await driveTurn(run, s.agent, "go", s.bind);
  assert.deepEqual(outcome, { kind: "continue" });
  assert.equal(run.getState(), "running");
});

test("everything the turn did is in the transcript, granted or not", async () => {
  const run = newRun("read_only");
  const s = scripted([{ ask: READ }, { ask: SUDO }, { tool: ["fs_read", "/w/a.ts", "ok"] }]);
  await driveTurn(run, s.agent, "go", s.bind);
  const gates = run.transcript().filter((e) => e.type === "gate");
  assert.equal(gates.length, 2, "an audit that kept only the denials proves nothing");
  assert.equal(run.transcript().filter((e) => e.type === "tool").length, 1);
});

test("the loop stops the moment the run does", async () => {
  // Five stopping conditions belong to the run, not to the caller: an answer, a
  // block, a failure, a cancel, and the budget. A driver that re-derived them
  // would miss the sixth the day one is added.
  const run = newRun("autonomous", { maxTurns: 3 });
  const s = scripted([{ ask: READ }]); // never produces text: always "continue"
  let asked = 0;
  await driveRun(run, s.agent, "go", s.bind, () => {
    asked += 1;
    return "keep going";
  });
  assert.equal(run.getState(), "exhausted");
  assert.equal(run.budget().turnsUsed, 3, "it must stop at the budget, not past it");
  // Three turns ran and the prompt was built four times: the fourth turn was
  // offered and the run refused it. The loop could avoid that last call by
  // reading the budget first, and deliberately does not. Whether another turn
  // is possible is the run's answer, and a driver that predicted it would be
  // holding a second copy of the stopping rules, which is how the two drift.
  // The cost of being wrong that way is one unused string.
  assert.equal(asked, 3);
});

test("an answered run is not asked for another prompt", async () => {
  // The run reaching `finished` would refuse a further turn anyway, so getting
  // this wrong costs no capability. It costs the driver: nextPrompt is where a
  // caller summarises, counts, or bills, and calling it for a turn that will
  // never run is a side effect nobody asked for.
  const run = newRun();
  const s = scripted([{ say: "here is the answer" }]);
  let asked = 0;
  await driveRun(run, s.agent, "go", s.bind, () => {
    asked += 1;
    return "again";
  });
  assert.equal(run.getState(), "finished");
  assert.equal(asked, 0, "a final answer ends the loop where it stands");
});

test("a blocked run is not asked for another prompt either", async () => {
  const run = newRun("read_only");
  const s = scripted([{ ask: WRITE }]);
  let asked = 0;
  await driveRun(run, s.agent, "go", s.bind, () => {
    asked += 1;
    return "again";
  });
  assert.equal(run.getState(), "blocked");
  assert.equal(asked, 0, "the loop waits for a human, it does not push past them");
});

test("what the run produced is in its own transcript, not only in the UI", async () => {
  // The sink is for display and a display is not a record. A run whose answer
  // existed only in a pane that has since been closed cannot be audited, and
  // the transcript is the thing that survives the window.
  const run = newRun();
  const s = scripted([{ say: "the answer" }]);
  await driveTurn(run, s.agent, "go", s.bind);
  const outputs = run
    .transcript()
    .filter((e) => e.type === "output")
    .map((e) => (e.type === "output" ? e.text : ""));
  assert.deepEqual(outputs, ["the answer"]);
});

test("the loop ends when the driver says so, without touching the run", async () => {
  const run = newRun();
  const s = scripted([{ ask: READ }]);
  await driveRun(run, s.agent, "go", s.bind, () => null);
  assert.equal(run.getState(), "running", "ending the loop is not ending the run");
  assert.equal(run.budget().turnsUsed, 1);
});

test("a cancelled run stops the loop even mid stream", async () => {
  const run = newRun();
  let hooks: RunTurnHooks | null = null;
  const agent: DrivableAgent = {
    async send() {
      // The cancel lands while the turn is in flight, which is the hard case:
      // the run cannot change state yet, but nothing more may be granted.
      run.cancel("user");
      hooks!.onDelta("half an answer");
      const d = await hooks!.askPermission(READ);
      assert.equal(d, "deny", "a cancelled turn must not be granted anything further");
    },
    stop() {},
  };
  await driveRun(
    run,
    agent,
    "go",
    (h) => {
      hooks = h;
    },
    () => "again",
  );
  assert.equal(run.getState(), "cancelled");
  assert.equal(run.finalResult(), null, "a cancelled run reports no answer");
});

// ---------------------------------------------------------------- grants
//
// A grant is what a human answered when the run parked. It exists because a
// block nobody can act on twice is not a decision: without it, granting a
// permission would park the run again on the very next identical request.
//
// The first version of this consulted grants BEFORE the gate, in the view.
// That reads as a small shortcut and it is three holes: the gate is not only
// the policy, it is also the state check and the record.

const GRANT_ALL = { granted: () => true };

test("a grant turns a block into an allow, and only a block", async () => {
  const run = newRun("read_only");
  const s = scripted([{ ask: WRITE }, { say: "wrote it" }]);
  const outcome = await driveTurn(run, s.agent, "go", s.bind, {}, GRANT_ALL);
  assert.deepEqual(s.asked, ["once"]);
  assert.equal(run.getState(), "finished", "a granted run does not park again");
  assert.deepEqual(outcome, { kind: "final", text: "wrote it" });
});

// NEVER ASSERT INSIDE send(). Both tests below used to, and neither could fail.
//
// driveTurn wraps `await agent.send(prompt)` in a try/catch that turns anything
// thrown into the turn's error string, and node:test only sees a rejected
// promise. So a failed assertion inside send() was swallowed and recorded as a
// failing TURN, which is a perfectly normal outcome that changes nothing the
// test goes on to check. Reintroducing the exact defect these two are named
// after, consulting the grant on any non-allow answer instead of on `block`
// alone, left the whole suite green.
//
// The decision is therefore captured in a variable and asserted AFTER driveTurn
// has returned, where a failure is the test's and cannot be mistaken for the
// run's.

test("a grant cannot serve a cancelled run", async () => {
  // The cancel lands mid turn, so the state has not changed yet and only the
  // gate knows. A grant consulted before it would hand the run a capability
  // after a human told it to stop.
  const run = newRun("read_only");
  let hooks: RunTurnHooks | null = null;
  let decision: RunDecision | null = null;
  const agent: DrivableAgent = {
    async send() {
      run.cancel("user");
      decision = await hooks!.askPermission(WRITE);
    },
    stop() {},
  };
  await driveTurn(run, agent, "go", (h) => { hooks = h; }, {}, GRANT_ALL);
  assert.equal(decision, "deny", "cancelled outranks any grant");
  assert.equal(run.getState(), "cancelled");
  // The gate's own record must show the refusal and its reason, since the gate
  // is what a grant consulted too early would have bypassed entirely.
  const gate = run.transcript().find((e) => e.type === "gate");
  assert.equal(gate?.type === "gate" ? gate.decision : "", "refuse");
  assert.equal(gate?.type === "gate" ? gate.reason : "", "cancelled");
});

test("a grant cannot serve a run past its wall clock", async () => {
  let t = 0;
  const run = Run.create({
    id: "r", name: "n",
    limits: { maxTurns: 5, maxWallClockMs: 1000, policy: "read_only" },
    now: () => t,
  });
  let hooks: RunTurnHooks | null = null;
  let decision: RunDecision | null = null;
  const agent: DrivableAgent = {
    async send() {
      t = 1000;
      decision = await hooks!.askPermission(WRITE);
    },
    stop() {},
  };
  await driveTurn(run, agent, "go", (h) => { hooks = h; }, {}, GRANT_ALL);
  assert.equal(decision, "deny", "a grant is a permission, not an extension of the budget");
  const gate = run.transcript().find((e) => e.type === "gate");
  assert.equal(gate?.type === "gate" ? gate.decision : "", "refuse");
  assert.equal(gate?.type === "gate" ? gate.reason : "", "expired");
});

test("a grant can never cover an elevated request", async () => {
  // Elevated is refused, not blocked, so no human was ever asked about it and
  // there is nothing to have granted. The grant hook is not even consulted.
  //
  // Honest about what this pins and what it does not: the `!req.elevated`
  // guard in driveTurn is unreachable today, because decideGate answers
  // `refuse` before any block branch runs, and deleting it breaks no test. It
  // stays because it costs nothing and the day someone reorders decideGate it
  // is the difference between a bug and a non-event. What IS pinned here is
  // the property that matters: elevated is denied and no grant is looked up.
  const run = newRun("autonomous");
  let consulted = 0;
  const s = scripted([{ ask: SUDO }]);
  await driveTurn(run, s.agent, "go", s.bind, {}, {
    granted: () => { consulted += 1; return true; },
  });
  assert.deepEqual(s.asked, ["deny"]);
  assert.equal(consulted, 0, "an elevated request must not even ask whether it was granted");
});

test("a granted step is still in the transcript, block first, reason after", async () => {
  // Recording it as an allow would hide the only interesting part, which is
  // that the policy said no and a person overruled it.
  const run = newRun("read_only");
  const s = scripted([{ ask: WRITE }]);
  await driveTurn(run, s.agent, "go", s.bind, {}, GRANT_ALL);
  const gate = run.transcript().find((e) => e.type === "gate");
  assert.equal(gate?.type === "gate" ? gate.decision : "", "block");
  const notes = run.transcript().filter((e) => e.type === "note").map((e) => (e.type === "note" ? e.text : ""));
  assert.ok(notes.some((n) => /granted earlier by a human/.test(n) && /\/w\/a\.ts/.test(n)));
});

test("without grants nothing changes", async () => {
  const run = newRun("read_only");
  const s = scripted([{ ask: WRITE }]);
  await driveTurn(run, s.agent, "go", s.bind);
  assert.equal(run.getState(), "blocked");
});
