// The three ways an unattended run reached a capability it was never granted.
//
// All three were in shipped code, found by an adversarial review, and none of
// them was caught by the forty tests that already existed. They are pinned
// here as regressions, one test per path, each stating the attack rather than
// the implementation: a reader should be able to see what was possible before,
// not merely that a boolean is now false.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { Run, type RunLimits, type RunPolicy } from "../../src/runs.js";

function clock(t: number) {
  return () => t;
}

function newRun(policy: RunPolicy, limits: Partial<RunLimits> = {}): Run {
  return Run.create({
    id: "r1",
    name: "audit",
    limits: { maxTurns: 10, maxWallClockMs: 60_000, policy, ...limits },
    now: clock(0),
  });
}

test("a run that is not in a turn cannot be granted anything", () => {
  // Path one. gate() consulted only cancelRequested, so a run that had
  // finished, been cancelled, run out of budget or blocked still answered
  // allow. A permission belongs to a turn that is running, and to nothing
  // else.
  const queued = newRun("autonomous");
  assert.deepEqual(
    queued.gate({ kind: "fs_write", detail: "/tmp/x", elevated: false }),
    { decision: "refuse", reason: "out_of_turn" },
    "a queued run has not started and may not be granted anything",
  );

  const cancelled = newRun("autonomous");
  cancelled.beginTurn();
  cancelled.cancel("user");
  assert.equal(
    cancelled.gate({ kind: "shell", detail: "curl x", elevated: false }).decision,
    "refuse",
    "a cancelled run must not still be able to run a command",
  );

  const inTurn = newRun("autonomous");
  inTurn.beginTurn();
  assert.equal(
    inTurn.gate({ kind: "fs_write", detail: "/tmp/x", elevated: false }).decision,
    "allow",
    "the guard must not break the legitimate case it exists to bound",
  );
});

test("the limits a run was started under cannot be rewritten while it lives", () => {
  // Path two. `readonly limits` froze the binding, not the object, so
  // `run.limits.policy = "autonomous"` type-checked and took effect on the very
  // next gate call: a read_only run promoting itself in one assignment.
  const run = newRun("read_only");
  run.beginTurn();
  const before = run.gate({ kind: "fs_write", detail: "/tmp/x", elevated: false });
  assert.notEqual(before.decision, "allow");

  assert.throws(
    () => {
      (run.limits as { policy: RunPolicy }).policy = "autonomous";
    },
    /read only|readonly|not extensible|Cannot assign/i,
    "the limits object must be frozen, not merely typed readonly",
  );
  assert.equal(run.limits.policy, "read_only");
  assert.notEqual(
    run.gate({ kind: "fs_write", detail: "/tmp/x", elevated: false }).decision,
    "allow",
    "the policy must still be the one the run was created under",
  );
});

test("a snapshot cannot grant what the transcript says was never granted", () => {
  // Path three, the quietest: editing one field of a JSON file on disk turned
  // a read_only run into an autonomous one, while its own audit record went on
  // saying read_only. The transcript is append-only and its first entry
  // records the contract, so the transcript is the authority.
  const run = newRun("read_only");
  run.beginTurn();
  const entries = run.transcript();
  const snapshot = JSON.parse(JSON.stringify(run.snapshot())) as {
    limits: RunLimits;
  };
  snapshot.limits.policy = "autonomous";

  assert.throws(
    () => Run.restore(snapshot as never, entries, clock(0)),
    /disagree with the transcript/i,
    "a snapshot that contradicts its own transcript must be refused, not repaired",
  );
});

test("an honest snapshot still restores, whatever the order of its keys", () => {
  // The refusal above must not become a restore that never works: two objects
  // carrying the same limits in a different key order are the same contract.
  const run = newRun("propose");
  run.beginTurn();
  const entries = run.transcript();
  const snap = run.snapshot() as unknown as { limits: Record<string, unknown> };
  const reordered = JSON.parse(JSON.stringify(snap)) as typeof snap;
  const l = reordered.limits;
  reordered.limits = { policy: l.policy, maxWallClockMs: l.maxWallClockMs, maxTurns: l.maxTurns };

  const restored = Run.restore(reordered as never, entries, clock(0));
  assert.equal(restored.limits.policy, "propose");
});

test("elevated stays refused under every policy, in a turn or out of one", () => {
  // The property the whole module exists for, restated after the state guard
  // was added: the guard must not have introduced a path that reaches the
  // policy table before the elevated check.
  for (const policy of ["read_only", "propose", "autonomous"] as RunPolicy[]) {
    const run = newRun(policy);
    run.beginTurn();
    const out = run.gate({ kind: "fs_write", detail: "/Users/me/.zlogin", elevated: true });
    assert.deepEqual(out, { decision: "refuse", reason: "elevated" }, `policy ${policy}`);
  }
});
