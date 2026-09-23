// learning.ts and detectTaskLearned: what may be stored, what counts as an
// outcome, and when the student is allowed to decide.

// @ts-ignore Node's built-in runner is used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { detectTask, detectTaskLearned, type LearnedDeps, type TaskId } from "../../src/autotask.js";
import {
  chooseDecision,
  gateChecks,
  labelOrigin,
  learningSettings,
  makeTraceRow,
  OutcomeTracker,
  panelState,
  parseLearningEvent,
  parseStatus,
  parseStudent,
  parseThreshold,
  redactState,
  STATE_MAX_CHARS,
  withBudget,
  type TraceRow,
  type TrainResult,
} from "../../src/learning.js";
import { REDACTED } from "../../src/redact.js";

// ---------------------------------------------------------------- redaction

test("redactState removes named secrets before anything is stored", () => {
  const r = redactState("my config:\nOPENAI_API_KEY=sk-abcdef1234567890abcdef\nfix the bug");
  assert.ok(!r.text.includes("sk-abcdef1234567890abcdef"));
  assert.ok(r.text.includes(REDACTED));
  assert.ok(r.removed >= 1);
  assert.ok(r.text.includes("fix the bug"));
});

test("redactState masks credential paths and the account name, keeps ordinary paths", () => {
  const r = redactState("read /Users/damien/.ssh/id_ed25519 then edit /Users/damien/work/app.py and ~/.aws/credentials");
  assert.ok(!r.text.includes("id_ed25519"));
  assert.ok(!r.text.includes(".aws"));
  assert.ok(!r.text.includes("damien"), r.text);
  assert.ok(r.text.includes("~/work/app.py"), r.text);
  assert.equal(r.removed, 2);
});

test("redactState keeps system paths that only matter to the permission gate", () => {
  // /usr/bin is an elevated WRITE, not a secret: the word is a task signal.
  const r = redactState("pourquoi /usr/bin/python3 ne trouve pas pip ?");
  assert.ok(r.text.includes("/usr/bin/python3"));
  assert.equal(r.removed, 0);
});

test("redactState caps the stored message", () => {
  assert.equal(redactState("x".repeat(STATE_MAX_CHARS * 3)).text.length, STATE_MAX_CHARS);
});

// ---------------------------------------------------------------- rows

function row(text: string, previous: TaskId, applied: TaskId, swap: TraceRow["swap"] = "none", id?: string): TraceRow {
  const h = detectTask(text, previous);
  return makeTraceRow({
    id: id ?? text,
    text,
    previous,
    heuristic: h,
    student: null,
    decision: { ...h, task: applied, source: "heuristic" },
    applied,
    swap,
  });
}

test("a trace row carries the fields the backend and learn.py require, redacted", () => {
  const r = makeTraceRow({
    text: "export GITHUB_TOKEN=ghp_0123456789abcdefghijABCDEFGHIJ012345 then write a python function",
    previous: "general",
    heuristic: { task: "code", confidence: 0.812345, reason: "x" },
    student: { task: "code", confidence: 0.912345 },
    decision: { task: "code", confidence: 0.912345, reason: "y", source: "student" },
    applied: "code",
    swap: "offered",
  });
  assert.equal(typeof r.id, "string");
  assert.equal(typeof r.state.message, "string");
  assert.equal(r.state.previous_task, "general");
  assert.equal("ts" in r, false, "the backend stamps ts in seconds");
  assert.ok(r.id.length > 8);
  assert.equal(r.heuristic.task, "code");
  assert.equal(r.heuristic.confidence, 0.8123);
  assert.equal(r.student?.confidence, 0.9123);
  assert.equal(r.decision.source, "student");
  assert.deepEqual(r.options, ["general", "code", "scripting", "writing", "reasoning"]);
  assert.equal(r.outcome, null);
  assert.ok(!JSON.stringify(r).includes("ghp_0123456789"));
  // One JSON line: no raw newline survives serialisation.
  assert.ok(!JSON.stringify(r).includes("\n"));
});

test("two rows get different ids", () => {
  const a = makeTraceRow({ text: "hello world", previous: "general", heuristic: detectTask("hello world"), student: null, decision: { ...detectTask("hello world"), source: "heuristic" }, applied: "general", swap: "none" });
  const b = makeTraceRow({ text: "hello world", previous: "general", heuristic: detectTask("hello world"), student: null, decision: { ...detectTask("hello world"), source: "heuristic" }, applied: "general", swap: "none" });
  assert.notEqual(a.id, b.id);
});

// ---------------------------------------------------------------- outcomes

test("a row is written once two newer decisions exist, and flush writes the rest", () => {
  const out: string[] = [];
  const tr = new OutcomeTracker((r) => out.push(r.id));
  tr.record(row("a", "general", "general", "none", "1"));
  tr.record(row("b", "general", "general", "none", "2"));
  tr.record(row("c", "general", "general", "none", "3"));
  assert.deepEqual(out, []);
  tr.record(row("d", "general", "general", "none", "4"));
  assert.deepEqual(out, ["1"]);
  tr.flush();
  assert.deepEqual(out, ["1", "2", "3", "4"]);
  assert.equal(tr.open().length, 0);
});

test("going back to the previous task by hand within the window undoes the switch", () => {
  const out: TraceRow[] = [];
  const tr = new OutcomeTracker((r) => out.push(r));
  tr.record(row("switch", "general", "code", "none", "s"));
  tr.record(row("next", "code", "code", "none", "n"));
  tr.manualPick("general");
  tr.flush();
  const s = out.find((r) => r.id === "s")!;
  assert.deepEqual(s.outcome, { kind: "undone", task: "general" });
  assert.equal(out.find((r) => r.id === "n")!.outcome, null);
});

test("picking a third task by hand relabels the decision", () => {
  const out: TraceRow[] = [];
  const tr = new OutcomeTracker((r) => out.push(r));
  tr.record(row("m", "general", "general", "none", "m"));
  tr.manualPick("writing");
  tr.flush();
  assert.deepEqual(out[0].outcome, { kind: "repicked", task: "writing" });
});

test("re-clicking the task already in effect says nothing", () => {
  const out: TraceRow[] = [];
  const tr = new OutcomeTracker((r) => out.push(r));
  tr.record(row("m", "general", "code", "none", "m"));
  tr.manualPick("code");
  tr.flush();
  assert.equal(out[0].outcome, null);
});

test("a pick after the window closed does not reach the written row", () => {
  const out: TraceRow[] = [];
  const tr = new OutcomeTracker((r) => out.push(r));
  tr.record(row("old", "general", "code", "none", "old"));
  tr.record(row("x", "code", "code", "none", "x"));
  tr.record(row("y", "code", "code", "none", "y"));
  tr.record(row("z", "code", "code", "none", "z"));
  tr.manualPick("writing");
  tr.flush();
  assert.equal(out.find((r) => r.id === "old")!.outcome, null);
  assert.deepEqual(out.find((r) => r.id === "z")!.outcome, { kind: "repicked", task: "writing" });
});

test("an accepted swap confirms the decision, a refused one labels nothing", () => {
  const out: TraceRow[] = [];
  const tr = new OutcomeTracker((r) => out.push(r));
  tr.record(row("a", "general", "code", "offered", "a"));
  tr.swapAccepted();
  tr.record(row("b", "code", "writing", "offered", "b"));
  tr.swapRefused();
  tr.flush();
  assert.deepEqual(out[0].outcome, { kind: "accepted", task: "code" });
  assert.deepEqual(out[1].outcome, { kind: "refused", task: null });
});

test("a refusal never erases a correction the user made by hand", () => {
  const out: TraceRow[] = [];
  const tr = new OutcomeTracker((r) => out.push(r));
  tr.record(row("a", "general", "code", "offered", "a"));
  tr.manualPick("general");
  tr.swapRefused();
  tr.swapAccepted();
  tr.flush();
  assert.deepEqual(out[0].outcome, { kind: "undone", task: "general" });
});

test("swap reactions without an offered row are ignored, drop forgets open rows", () => {
  const out: TraceRow[] = [];
  const tr = new OutcomeTracker((r) => out.push(r));
  tr.record(row("a", "general", "code", "auto", "a"));
  tr.swapAccepted();
  tr.swapRefused();
  assert.equal(tr.open()[0].outcome, null);
  tr.drop();
  tr.flush();
  assert.equal(out.length, 0);
});

// ---------------------------------------------------------------- choice

test("parseStudent accepts only a known task and a probability", () => {
  assert.deepEqual(parseStudent({ task: "code", confidence: 0.9 }), { task: "code", confidence: 0.9 });
  assert.deepEqual(parseStudent({ choice: "writing", confidence: 0.7 }), { task: "writing", confidence: 0.7 });
  assert.equal(parseStudent({ task: "cooking", confidence: 0.9 }), null);
  assert.equal(parseStudent({ task: "code", confidence: 1.2 }), null);
  assert.equal(parseStudent({ task: "code", confidence: Number.NaN }), null);
  assert.equal(parseStudent({ task: "code" }), null);
  assert.equal(parseStudent(null), null);
  assert.equal(parseStudent("code"), null);
});

test("chooseDecision trusts the student only at or above the threshold", () => {
  const h = { task: "general" as TaskId, confidence: 0.2, reason: "signal faible" };
  assert.equal(chooseDecision(h, { task: "code", confidence: 0.6 }, 0.6).source, "student");
  assert.equal(chooseDecision(h, { task: "code", confidence: 0.59 }, 0.6).task, "general");
  assert.equal(chooseDecision(h, null, 0.6).source, "heuristic");
});

test("parseThreshold clamps and defaults", () => {
  assert.equal(parseThreshold(undefined), 0.6);
  assert.equal(parseThreshold("abc"), 0.6);
  assert.equal(parseThreshold("0.1"), 0.5);
  assert.equal(parseThreshold("0.75"), 0.75);
  assert.equal(parseThreshold("3"), 0.99);
});

test("learningSettings: everything is off unless explicitly on", () => {
  assert.deepEqual(learningSettings({}), { collect: false, active: false, threshold: 0.6 });
  assert.deepEqual(learningSettings({ learning_collect: "1", learning_active: "true" }), { collect: true, active: false, threshold: 0.6 });
});

test("withBudget returns null for a slow or failing promise", async () => {
  assert.equal(await withBudget(Promise.resolve(3), 50), 3);
  assert.equal(await withBudget(new Promise((r) => setTimeout(() => r(3), 80)), 10), null);
  assert.equal(await withBudget(Promise.reject(new Error("x")), 50), null);
});

function deps(over: Partial<LearnedDeps> & { answer?: unknown; delay?: number }): LearnedDeps & { calls: number } {
  const d = {
    calls: 0,
    active: () => true,
    threshold: () => 0.6,
    budgetMs: 30,
    decide: async () => {
      d.calls += 1;
      if (over.delay) await new Promise((r) => setTimeout(r, over.delay));
      return over.answer ?? { task: "writing", confidence: 0.9 };
    },
    ...over,
  };
  return d;
}

test("detectTaskLearned uses a confident student", async () => {
  const r = await detectTaskLearned("please write a python function that sorts", "general", deps({}));
  assert.equal(r.source, "student");
  assert.equal(r.task, "writing");
  assert.equal(r.heuristic.task, "code");
  assert.deepEqual(r.student, { task: "writing", confidence: 0.9 });
});

test("detectTaskLearned falls back: off, absent, slow, broken, unsure, too short", async () => {
  const text = "please write a python function that sorts";
  const h = detectTask(text, "general");
  for (const d of [
    deps({ active: () => false }),
    null,
    deps({ delay: 80 }),
    deps({ decide: () => Promise.reject(new Error("down")) }),
    deps({ decide: () => { throw new Error("sync"); } }),
    deps({ answer: { task: "writing", confidence: 0.3 } }),
    deps({ answer: { nonsense: true } }),
  ]) {
    const r = await detectTaskLearned(text, "general", d);
    assert.equal(r.source, "heuristic");
    assert.equal(r.task, h.task);
    assert.equal(r.confidence, h.confidence);
  }
  const short = deps({});
  const r = await detectTaskLearned("ok", "code", short);
  assert.equal(r.task, "code");
  assert.equal(short.calls, 0);
});

test("detectTaskLearned keeps the student's unsure answer for the trace", async () => {
  const r = await detectTaskLearned("please write a python function", "general", deps({ answer: { task: "writing", confidence: 0.4 } }));
  assert.equal(r.source, "heuristic");
  assert.deepEqual(r.student, { task: "writing", confidence: 0.4 });
});

// ---------------------------------------------------------------- backend shapes

const RESULT = {
  accepted: true,
  student: { acc: 0.9, ece: 0.05, n: 80 },
  heuristic: { acc: 0.85, n: 80 },
  labels: { teacher: 120, outcome: 14, hand: 340 },
};

test("parseLearningEvent reads progress and results", () => {
  assert.deepEqual(parseLearningEvent({ phase: "train", pct: 140, message: "epoch 1" }), { kind: "progress", phase: "train", pct: 100, message: "epoch 1" });
  assert.deepEqual(parseLearningEvent({ phase: "label" }), { kind: "progress", phase: "label", pct: null, message: "" });
  const e = parseLearningEvent({ result: RESULT });
  assert.equal(e?.kind, "result");
  assert.equal(parseLearningEvent({ result: { accepted: "yes" } }), null);
  assert.equal(parseLearningEvent(42), null);
});

test("parseStatus tolerates an empty or partial answer", () => {
  const s = parseStatus(undefined);
  assert.equal(s.installed, false);
  assert.equal(s.traces, 0);
  assert.equal(s.last, null);
  const t = parseStatus({ installed: true, traces: 12, download_bytes: 2.5e9, active: "ckpt-2", previous: "ckpt-1", last: { ...RESULT, date: 0 } });
  assert.equal(t.downloadBytes, 2.5e9);
  assert.equal(t.previous, "ckpt-1");
  assert.equal(t.last?.date, "1970-01-01T00:00:00.000Z");
});

test("labelOrigin and gateChecks describe the last training honestly", () => {
  const r = parseLearningEvent({ result: RESULT });
  assert.ok(r && r.kind === "result");
  const res = (r as { result: TrainResult }).result;
  assert.equal(labelOrigin(res), "both");
  assert.equal(labelOrigin({ ...res, labels: { teacher: 0, outcome: 3, hand: 340 } }), "outcome");
  assert.equal(labelOrigin({ ...res, labels: { teacher: 0, outcome: 0, hand: 340 } }), "hand");
  assert.deepEqual(gateChecks(res), { n: true, gain: true, ece: true });
  assert.deepEqual(
    gateChecks({ ...res, student: { acc: 0.87, ece: 0.2, n: 59 } }),
    { n: false, gain: false, ece: false },
  );
});

// ---------------------------------------------------------------- panel

test("panelState: training needs the toolkit, no running job and a teacher", () => {
  const base = { status: parseStatus({}), settings: learningSettings({}), primaryReady: true, busy: null };
  assert.equal(panelState(base).trainBlocked, "learn.block.noToolkit");
  assert.equal(panelState(base).canInstall, true);
  const inst = { ...base, status: parseStatus({ installed: true }) };
  assert.equal(panelState(inst).canTrain, true);
  assert.equal(panelState({ ...inst, primaryReady: false }).trainBlocked, "learn.block.noTeacher");
  assert.equal(panelState({ ...inst, busy: "train" }).trainBlocked, "learn.block.training");
  assert.equal(panelState({ ...base, busy: "install" }).canInstall, false);
  assert.equal(panelState({ ...base, busy: "install" }).canCancelInstall, true);
});

test("panelState: the student can be switched on only once a checkpoint was accepted", () => {
  const base = { status: parseStatus({ installed: true }), settings: learningSettings({}), primaryReady: true, busy: null };
  assert.equal(panelState(base).canActivate, false);
  assert.equal(panelState({ ...base, status: parseStatus({ installed: true, active: "c1" }) }).canActivate, true);
  // Already on (a checkpoint vanished): it can always be switched off.
  assert.equal(panelState({ ...base, settings: learningSettings({ learning_active: "1" }) }).canActivate, true);
  assert.equal(panelState(base).canRollback, false);
  assert.equal(panelState({ ...base, status: parseStatus({ installed: true, previous: "c0" }) }).canRollback, true);
  assert.equal(panelState(base).canExport, false);
  assert.equal(panelState({ ...base, status: parseStatus({ traces: 3 }) }).canClear, true);
});
