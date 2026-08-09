// What a human may hand a parked run, and how that survives a restart.
//
// Blocking exists so a human CAN answer. The answer has to reach the next turn
// somehow, and the way it does is the only place in this feature where
// something is allowed that the run's own gate had refused. Three properties
// keep that from becoming a hole, and each one is a test here:
//
//   an elevated request never enters the grant set, whatever is asked;
//   a grant is scoped to one kind AND one exact detail;
//   a grant is only real when the run's own transcript holds both halves, the
//   gate entry that blocked and the answer that granted it.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { Run, type RunLimits, type RunPermissionRequest } from "../../src/runs.js";
import { blockQuestion, type DrivePermissionRequest } from "../../src/rundrive.js";
import {
  RunGrants,
  grantAnswer,
  grantKey,
  refuseAnswer,
  requestBehind,
} from "../../src/runrecord.js";

const LIMITS: RunLimits = { maxTurns: 6, maxWallClockMs: 600_000, policy: "read_only" };

const WRITE: DrivePermissionRequest = { kind: "fs_write", detail: "/w/a.ts", elevated: false };
const OTHER: DrivePermissionRequest = { kind: "fs_write", detail: "/w/b.ts", elevated: false };
const SUDO: DrivePermissionRequest = { kind: "shell", detail: "sudo rm -rf /", elevated: true };
const PUSH: DrivePermissionRequest = {
  kind: "git",
  detail: "push origin main (3)",
  elevated: false,
  noAlways: true,
};

function parked(req: DrivePermissionRequest, reason: "policy" | "every_time" = "policy"): Run {
  const run = Run.create({ id: "run-x", name: "n", limits: LIMITS, now: () => 0 });
  run.beginTurn();
  const outcome = run.gate(req as RunPermissionRequest);
  assert.equal(outcome.decision, "block", "the fixture must actually park the run");
  run.endTurn({ kind: "blocked", question: blockQuestion(req, reason) });
  return run;
}

test("an elevated request can never be granted, even asked directly", () => {
  const grants = new RunGrants();
  assert.equal(grants.grant(SUDO), false);
  assert.equal(grants.size(), 0);
  assert.equal(grants.has(SUDO), false);
  // And it stays refused even if the same kind and detail are granted while
  // pretending they are ordinary: `has` re-checks the flag on every call.
  grants.grant({ ...SUDO, elevated: false });
  assert.equal(grants.has(SUDO), false);
});

test("a grant covers one kind and one exact detail, and nothing beside it", () => {
  const grants = new RunGrants();
  assert.equal(grants.grant(WRITE), true);
  assert.equal(grants.has(WRITE), true);
  assert.equal(grants.has(OTHER), false);
  assert.equal(grants.has({ kind: "fs_read", detail: WRITE.detail, elevated: false }), false);
  assert.notEqual(grantKey(WRITE), grantKey(OTHER));
});

test("no pair of distinct requests collides into one grant key", () => {
  // The separator has to be a character neither half can contain, or
  // ("fs_write", "a b") and ("fs_write a", "b") would be the same grant.
  const a = grantKey({ kind: "fs_write", detail: "a b" });
  const b = grantKey({ kind: "fs_write a", detail: "b" });
  assert.notEqual(a, b);
});

test("the request behind a parked question is recovered from the transcript", () => {
  const run = parked(WRITE);
  const question = run.pendingQuestion();
  assert.ok(question);
  const found = requestBehind(question!, run.transcript());
  assert.ok(found);
  assert.equal(found!.kind, "fs_write");
  assert.equal(found!.detail, "/w/a.ts");
  assert.equal(found!.elevated, false);
});

test("a question shown every time is recovered with its noAlways flag intact", () => {
  const run = Run.create({
    id: "run-g",
    name: "n",
    limits: { ...LIMITS, policy: "autonomous" },
    now: () => 0,
  });
  run.beginTurn();
  const outcome = run.gate(PUSH as RunPermissionRequest);
  assert.deepEqual(outcome, { decision: "block", reason: "every_time" });
  run.endTurn({ kind: "blocked", question: blockQuestion(PUSH, "every_time") });
  const found = requestBehind(run.pendingQuestion()!, run.transcript());
  assert.ok(found);
  assert.equal(found!.noAlways, true);
  assert.equal(found!.kind, "git");
});

test("a question that matches nothing in the record yields nothing", () => {
  const run = parked(WRITE);
  assert.equal(requestBehind("something nobody recorded", run.transcript()), null);
  assert.equal(requestBehind("x", []), null);
});

test("a run parked twice comes back with the step it is actually waiting on", () => {
  const run = Run.create({ id: "run-y", name: "n", limits: LIMITS, now: () => 0 });
  run.beginTurn();
  run.gate(WRITE as RunPermissionRequest);
  run.endTurn({ kind: "blocked", question: blockQuestion(WRITE, "policy") });
  run.resume(grantAnswer(WRITE));
  run.beginTurn();
  run.gate(OTHER as RunPermissionRequest);
  run.endTurn({ kind: "blocked", question: blockQuestion(OTHER, "policy") });
  const found = requestBehind(run.pendingQuestion()!, run.transcript());
  assert.ok(found);
  assert.equal(found!.detail, "/w/b.ts");
});

test("a grant is rebuilt from the transcript after the process that gave it is gone", () => {
  const run = parked(WRITE);
  const req = requestBehind(run.pendingQuestion()!, run.transcript())!;
  run.resume(grantAnswer(req));
  const grants = RunGrants.fromTranscript(run.transcript());
  assert.equal(grants.has(WRITE), true);
  assert.equal(grants.has(OTHER), false);
});

test("a refusal grants nothing", () => {
  const run = parked(WRITE);
  const req = requestBehind(run.pendingQuestion()!, run.transcript())!;
  run.resume(refuseAnswer(req));
  assert.equal(RunGrants.fromTranscript(run.transcript()).size(), 0);
});

test("a note attached to the answer is recorded and changes nothing about the grant", () => {
  const run = parked(WRITE);
  const req = requestBehind(run.pendingQuestion()!, run.transcript())!;
  // The view puts whatever the human typed on the line below, so the grant is
  // read from the sentence and the note is kept in the record beside it.
  run.resume(`${grantAnswer(req)}\njust this once, it is the staging tree`);
  const grants = RunGrants.fromTranscript(run.transcript());
  assert.equal(grants.has(WRITE), true);
  assert.equal(grants.has(OTHER), false);
  const answer = run.transcript().find((e) => e.type === "answer");
  assert.ok(answer && answer.type === "answer");
  assert.match((answer as { text: string }).text, /staging tree/);
});

test("a grant nobody was ever blocked on is ignored", () => {
  // The file was edited: an answer entry grants fs_write on a run whose
  // transcript holds no block for it. The transcript is the authority, and
  // half a record is not a grant.
  const run = Run.create({ id: "run-z", name: "n", limits: LIMITS, now: () => 0 });
  run.beginTurn();
  run.endTurn({ kind: "blocked", question: "invented" });
  run.resume(grantAnswer(WRITE));
  assert.equal(RunGrants.fromTranscript(run.transcript()).size(), 0);
});

test("an answer that grants an ELEVATED request is ignored, even fully forged", () => {
  // Both halves are present and consistent: a gate entry, then a grant. It is
  // still refused, because the gate entry says elevated and nothing may hand
  // an unattended run an elevated capability. runs.ts refuses it at
  // decideGate, rundrive refuses it instead of parking, and this is the third
  // door on the same room.
  const run = Run.create({ id: "run-e", name: "n", limits: LIMITS, now: () => 0 });
  run.beginTurn();
  run.gate(SUDO as RunPermissionRequest);
  run.endTurn({ kind: "blocked", question: blockQuestion(SUDO, "policy") });
  run.resume(grantAnswer(SUDO));
  const grants = RunGrants.fromTranscript(run.transcript());
  assert.equal(grants.size(), 0);
  assert.equal(grants.has(SUDO), false);
});

test("an answer naming a kind that does not exist is ignored", () => {
  const run = parked(WRITE);
  run.resume("granted for this run: root: everything");
  assert.equal(RunGrants.fromTranscript(run.transcript()).size(), 0);
});
