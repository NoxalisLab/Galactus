// The transcript as the view paints it.
//
// One property here is worth a file of its own: an ALLOWED gate decision is
// shown. A screen that only rendered the denials would answer "what was this
// run stopped from doing" and never "what did it do", and the second question
// is the one an unattended run exists to be able to answer.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { Run, type RunLimits, type RunPermissionRequest } from "../../src/runs.js";
import { transcriptLines } from "../../src/runrecord.js";

const LIMITS: RunLimits = { maxTurns: 3, maxWallClockMs: 60_000, policy: "autonomous" };

const READ: RunPermissionRequest = { kind: "fs_read", detail: "/w/a.ts", elevated: false };
const SUDO: RunPermissionRequest = { kind: "shell", detail: "sudo rm -rf /", elevated: true };

function worked(): Run {
  const run = Run.create({ id: "run-d", name: "audit", limits: LIMITS, now: () => 0 });
  run.beginTurn();
  run.gate(READ);
  run.gate(SUDO);
  run.endTurn({ kind: "final", text: "42 files, 3 of them stale" });
  return run;
}

test("every entry of the record produces exactly one line", () => {
  const run = worked();
  assert.equal(transcriptLines(run.transcript()).length, run.transcript().length);
});

test("an allowed gate call is shown, in its own tone, beside the refused one", () => {
  const lines = transcriptLines(worked().transcript()).filter((l) => l.label === "gate");
  assert.equal(lines.length, 2);
  const allowed = lines.find((l) => l.tone === "allow");
  const refused = lines.find((l) => l.tone === "refuse");
  assert.ok(allowed, "the allowed call must be on screen, not only in the file");
  assert.ok(refused);
  assert.match(allowed!.text, /fs_read/);
  assert.match(allowed!.text, /allow/);
  assert.match(refused!.text, /elevated/);
});

test("a blocked call reads as blocked and not as a refusal", () => {
  const run = Run.create({
    id: "run-b",
    name: "n",
    limits: { ...LIMITS, policy: "read_only" },
    now: () => 0,
  });
  run.beginTurn();
  run.gate({ kind: "fs_write", detail: "/w/a.ts", elevated: false });
  const gate = transcriptLines(run.transcript()).filter((l) => l.label === "gate");
  assert.equal(gate.length, 1);
  assert.equal(gate[0].tone, "block");
});

test("the outcome of a run is legible in the state lines", () => {
  const lines = transcriptLines(worked().transcript());
  const states = lines.filter((l) => l.label === "state");
  assert.ok(states.some((l) => l.tone === "good" && /finished/.test(l.text)));
});

test("a long entry is clipped rather than allowed to push the record off screen", async () => {
  const run = Run.create({ id: "run-c", name: "n", limits: LIMITS, now: () => 0 });
  await run.execute(async (ctx) => {
    ctx.tool("read_file", "", "x".repeat(5_000));
    return { kind: "continue" };
  });
  const tool = transcriptLines(run.transcript()).find((l) => l.label === "tool");
  assert.ok(tool);
  assert.ok(tool!.text.length < 400, `a tool line is clipped, got ${tool!.text.length}`);
  assert.match(tool!.text, /\.\.\.$/);
});

test("the sequence number is carried through, so a reordered file is visible", () => {
  const lines = transcriptLines(worked().transcript());
  assert.deepEqual(
    lines.map((l) => l.seq),
    lines.map((_, i) => i),
  );
});
