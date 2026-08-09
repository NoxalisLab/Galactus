// The transcript: append-only, ordered, and readable without the app.
// @ts-ignore Node's built-in runner is used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { Run, parseTranscript, transcriptToJsonl, type RunLimits } from "../../src/runs.js";

function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

const LIMITS: RunLimits = { maxTurns: 5, maxWallClockMs: 10_000, policy: "propose" };

test("sequence numbers are dense, monotone and start at zero", () => {
  const clock = fakeClock(1000);
  const run = Run.create({ id: "r", name: "n", limits: LIMITS, now: clock.now });
  run.beginTurn();
  clock.advance(5);
  run.gate({ kind: "fs_read", detail: "/a", elevated: false });
  run.endTurn({ kind: "final", text: "ok" });
  const seqs = run.transcript().map((e) => e.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i), "a gap or a repeat makes the record unverifiable");
  const times = run.transcript().map((e) => e.at);
  assert.deepEqual([...times].sort((a, b) => a - b), times, "timestamps must never go backwards");
  assert.equal(times[0], 1000);
});

test("the transcript cannot be edited from outside", () => {
  const run = Run.create({ id: "r", name: "n", limits: LIMITS, now: () => 0 });
  const before = run.transcript();
  (before as unknown as unknown[]).push({ seq: 99, at: 0, type: "note", text: "forged" });
  assert.equal(run.transcript().length, before.length - 1, "transcript() must hand back a copy");
});

test("a completed run reads as a whole story in order", () => {
  const run = Run.create({ id: "run-7", name: "tidy the docs", limits: LIMITS, now: () => 42 });
  run.beginTurn();
  run.gate({ kind: "fs_list", detail: "/docs", elevated: false });
  run.gate({ kind: "shell", detail: "make docs", elevated: false });
  run.endTurn({ kind: "final", text: "two files renamed" });
  assert.deepEqual(
    run.transcript().map((e) => e.type),
    ["created", "state", "turn_begin", "gate", "gate", "turn_end", "state"],
  );
  // The state changes are the spine of the record: queued to running when the
  // first turn is granted, running to finished when the answer lands.
  assert.deepEqual(
    run.transcript().filter((e) => e.type === "state").map((e) => (e.type === "state" ? [e.from, e.to] : [])),
    [
      ["queued", "running"],
      ["running", "finished"],
    ],
  );
  const created = run.transcript()[0];
  assert.equal(created.type === "created" ? created.name : "", "tidy the docs");
  assert.equal(created.type === "created" ? created.limits.policy : "", "propose");
});

test("a thrown turn leaves a balanced record, not a dangling turn", async () => {
  const run = Run.create({ id: "r", name: "n", limits: LIMITS, now: () => 0 });
  await run.execute(async (ctx) => {
    ctx.tool("read_file", "/a", "12 lines");
    ctx.output("half an answer");
    throw new Error("stream closed");
  });
  const types = run.transcript().map((e) => e.type);
  assert.deepEqual(types, ["created", "state", "turn_begin", "tool", "output", "turn_end", "state"]);
  // What the turn managed to do before it threw is still on the record: an
  // audit that lost the partial work would hide what the machine touched.
  const tool = run.transcript().find((e) => e.type === "tool");
  assert.equal(tool?.type === "tool" ? tool.result : "", "12 lines");
  const end = run.transcript().find((e) => e.type === "turn_end");
  assert.equal(end?.type === "turn_end" ? end.detail : "", "stream closed");
});

test("JSON Lines round trips, one entry per line", () => {
  const run = Run.create({ id: "r", name: "n", limits: LIMITS, now: () => 7 });
  run.beginTurn();
  run.gate({ kind: "fs_write", detail: "/etc/hosts", elevated: true });
  run.endTurn({ kind: "blocked", question: "may I write outside the workspace?" });
  const jsonl = run.toJsonl();
  assert.equal(jsonl.split("\n").filter((l) => l).length, run.transcript().length);
  assert.ok(jsonl.endsWith("\n"));
  assert.deepEqual(parseTranscript(jsonl), run.transcript());
});

test("a half written last line does not make the rest unreadable", () => {
  const run = Run.create({ id: "r", name: "n", limits: LIMITS, now: () => 0 });
  run.beginTurn();
  run.endTurn({ kind: "continue" });
  const truncated = run.toJsonl() + '{"seq":99,"at":0,"type":"no';
  const parsed = parseTranscript(truncated);
  assert.deepEqual(parsed, run.transcript());
});

test("an empty transcript serializes to an empty string, not a blank line", () => {
  assert.equal(transcriptToJsonl([]), "");
  assert.deepEqual(parseTranscript(""), []);
});

test("a blocked run survives the window and resumes with its budget intact", () => {
  const clock = fakeClock(0);
  const run = Run.create({ id: "r", name: "n", limits: { ...LIMITS, maxTurns: 3 }, now: clock.now });
  run.beginTurn();
  clock.advance(100);
  run.endTurn({ kind: "blocked", question: "which remote?" });

  // The window closes. Only the snapshot and the file survive.
  const jsonl = run.toJsonl();
  const snapshot = JSON.parse(JSON.stringify(run.snapshot()));
  clock.advance(86_400_000);

  const back = Run.restore(snapshot, parseTranscript(jsonl), clock.now);
  assert.equal(back.getState(), "blocked");
  assert.equal(back.pendingQuestion(), "which remote?");
  assert.equal(back.budget().turnsUsed, 1);
  back.resume("origin");
  assert.equal(back.elapsedMs(), 100, "a day spent closed is not a day spent working");
  const begun = back.beginTurn();
  assert.deepEqual(begun, { ok: true, turn: 2, state: "running" });
  // The restored run keeps appending after the entries it inherited, with no
  // sequence number reused.
  const seqs = back.transcript().map((e) => e.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i));
});

test("a run whose process died mid turn comes back failed, not running", () => {
  const clock = fakeClock(0);
  const run = Run.create({ id: "r", name: "n", limits: LIMITS, now: clock.now });
  run.beginTurn();
  const snapshot = JSON.parse(JSON.stringify(run.snapshot()));
  assert.equal(snapshot.turnInFlight, true);

  const back = Run.restore(snapshot, parseTranscript(run.toJsonl()), clock.now);
  assert.equal(back.getState(), "failed", "nobody knows how far an interrupted turn got");
  assert.equal(back.failure(), "interrupted");
  const end = back.transcript().find((e) => e.type === "turn_end");
  assert.equal(end?.type === "turn_end" ? end.outcome : "", "failed");
});

test("restore refuses a snapshot that is not a run", () => {
  assert.throws(
    () => Run.restore({ ...badSnapshot(), state: "sleeping" as never }, [], () => 0),
    /invalid run state/,
  );
  assert.throws(
    () => Run.restore({ ...badSnapshot(), limits: { ...LIMITS, maxTurns: -1 } }, [], () => 0),
    /invalid run limits/,
  );
});

function badSnapshot() {
  return {
    id: "r",
    name: "n",
    limits: LIMITS,
    state: "queued" as const,
    turnsUsed: 0,
    startedAt: null,
    workedMs: 0,
    turnInFlight: false,
    question: null,
    result: null,
    error: null,
    cancelRequested: false,
    seq: 0,
  };
}
