// The runs view, rendered.
//
// Everything here is asserted against a real DOM tree built by the real
// runsview.ts, reached through the real api.ts, over a Tauri bridge whose only
// stub is the one function a webview would provide. Nothing about the view is
// reimplemented, so a change to what it paints fails here.
//
// The four assertions are the four things a monitoring screen exists to do,
// and each of them was, until this file, verified by nobody:
//
//   a run that was declared shows up on screen and is written to disk
//   a run that stopped on a question shows the question AND both answers
//   the scheduled section shows when the next fire is
//   a scheduler that refused a corrupt jobs.json says so instead of showing
//     an empty, reassuring list
//
// The second one carries the most weight. A blocked run with no visible
// question, or with only one of the two buttons, is a run that can never be
// resumed by the person it is waiting for, and it would look exactly like a
// working screen in a screenshot.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { installDom, ipcCallsFor, mount, routeIpc, settle, waitFor } from "./env";

installDom();

const runsview = await import("../../src/runsview");
const { Run } = await import("../../src/runs");
const { decodeRun, encodeRun, makeRunId, recordEntries } = await import("../../src/runrecord");
const { clockLabel } = await import("../../src/schedule");

type Html = {
  querySelector: (sel: string) => Html | null;
  querySelectorAll: (sel: string) => Html[];
  textContent: string;
  className: string;
  value: string;
  dispatchEvent: (e: unknown) => boolean;
  click: () => void;
  hidden: boolean;
};

function find(sel: string): Html | null {
  const document = (globalThis as unknown as { document: Html }).document;
  return document.querySelector(sel);
}

function findAll(sel: string): Html[] {
  const document = (globalThis as unknown as { document: Html }).document;
  return document.querySelectorAll(sel);
}

function fire(node: Html, type: string): void {
  const Ctor = (globalThis as unknown as { Event: new (t: string, i?: unknown) => unknown }).Event;
  node.dispatchEvent(new Ctor(type, { bubbles: true }));
}

// ---------------------------------------------------------------- fixtures

const FIXED_NOW = 1_760_000_000_000;
const QUESTION = "May I push the branch audit/2026-08 to origin?";
const TASK = "audit the workspace and report what is stale";

/** A run that ran one turn and then stopped on a question, as one on disk would be. */
function blockedRecord(): Record<string, unknown> {
  const id = makeRunId(FIXED_NOW, () => 0.42);
  const run = Run.create({
    id,
    name: "nightly audit",
    limits: { maxTurns: 4, maxWallClockMs: 600_000, policy: "propose" },
    now: () => FIXED_NOW,
  });
  run.beginTurn();
  run.gate({ kind: "git", detail: "push origin audit/2026-08", elevated: false });
  run.endTurn({ kind: "blocked", question: QUESTION });
  assert.equal(run.getState(), "blocked", "the fixture must really be blocked");
  return {
    id,
    name: "nightly audit",
    prompt: TASK,
    created: FIXED_NOW,
    updated: FIXED_NOW,
    snapshot: run.snapshot(),
    transcript: run.toJsonl(),
  };
}

const BLOCKED = blockedRecord();
const BLOCKED_ID = BLOCKED.id as string;

const NEXT_FIRE_SECS = Math.floor(FIXED_NOW / 1000) + 3600;

const JOBS_VIEW = {
  jobs: [
    {
      id: "morning-digest",
      name: "morning digest",
      task: "summarise what changed overnight",
      schedule: "0 7 * * *",
      enabled: true,
      policy: "read_only",
      max_turns: 6,
      max_minutes: 15,
      preauthorize_every_time: false,
      delivery: { mode: "none" },
      created_at: 0,
      updated_at: 0,
      enabled_at: 0,
      state: {
        last_fired_at: null,
        last_finished_at: null,
        last_outcome: "",
        last_detail: "",
        last_run_id: "",
        consecutive_failures: 0,
        missed: 0,
        last_missed_at: null,
        last_delivery: "",
      },
      next_fire_at: NEXT_FIRE_SECS,
      schedule_error: "",
      schedule_note: "",
      in_flight: false,
    },
  ],
  error: "",
  catchup_grace_minutes: 360,
};

let jobsAnswer: unknown = JOBS_VIEW;
const saved = new Map<string, string>();
const toasts: string[] = [];

routeIpc((cmd, args) => {
  switch (cmd) {
    case "conv_list":
      return [{ id: BLOCKED_ID }];
    case "conv_load":
      if (args.id === BLOCKED_ID) return JSON.parse(encodeRun(BLOCKED as never));
      throw new Error("no such conversation");
    case "conv_save":
      saved.set(String(args.id), String(args.data));
      return null;
    case "jobs_list":
      return jobsAnswer;
    case "jobs_preview":
      return [NEXT_FIRE_SECS];
    case "notify":
      return null;
    default:
      throw new Error(`unexpected command ${cmd}`);
  }
});

runsview.configureRuns({
  port: () => 8737,
  // False on purpose: a declared run must appear on screen whether or not a
  // model is loaded, and this keeps the test from starting an agent.
  ready: () => false,
  toast: (message) => void toasts.push(message),
});

// ---------------------------------------------------------------- the tests

test("a run that stopped on a question shows the question and both answers", async () => {
  mount(runsview.runsView());
  await waitFor(() => findAll(".runcard").length > 0, "the stored run to be painted");

  const card = find(`.runcard[data-run="${BLOCKED_ID}"]`);
  assert.ok(card, "the blocked run must have a card");
  assert.match(card!.className, /needs-answer/, "a blocked card is marked as needing an answer");

  const question = card!.querySelector(".runs-question");
  assert.ok(question, "the question must be on screen, not only in the transcript");
  assert.equal(question!.textContent, QUESTION);

  // Both, and this is the point: a screen with only Grant is a screen that
  // cannot say no, and a screen with only Refuse cannot unblock anything.
  assert.ok(card!.querySelector('[data-act="grant"]'), "Grant must be offered");
  assert.ok(card!.querySelector('[data-act="refuse"]'), "Refuse must be offered");

  // The task is shown too, because a question about a step is unanswerable
  // without the task it belongs to.
  assert.equal(card!.querySelector(".runs-task")!.textContent, TASK);
});

test("the scheduled section shows the next fire time", async () => {
  mount(runsview.runsView());
  await waitFor(() => findAll(".jobcard").length > 0, "the scheduled job to be painted");

  const card = find('.jobcard[data-job="morning-digest"]');
  assert.ok(card, "the job must have a card");
  const read = card!.querySelector(".runs-budget-read");
  assert.ok(read, "the row must carry the next fire reading");
  // The exact string the app renders, produced by the same helper the app
  // uses, so this cannot pass on a row that prints something else.
  assert.match(read!.textContent, new RegExp(clockLabel(NEXT_FIRE_SECS).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(read!.textContent, /nextNone|jamais/i);
  // The schedule as the human typed it stays visible next to it.
  assert.match(card!.textContent, /0 7 \* \* \*/);
});

test("a declared run appears on screen and is written to disk", async () => {
  mount(runsview.runsView());
  // Wait for the STORED runs to finish painting before counting. Without this
  // the count is taken while loadStored is still in flight, and its repaint
  // arrives later and covers for a declaration that never repainted anything:
  // the assertion below would then hold no matter what declareRun did.
  await waitFor(() => findAll(".runcard").length === 1, "the stored run to be painted first");
  await waitFor(() => find("#rf-task") !== null, "the declaration form");

  const name = find("#rf-name")!;
  const task = find("#rf-task")!;
  name.value = "check the lockfile";
  fire(name, "input");
  task.value = "compare package-lock.json against package.json";
  fire(task, "input");

  const before = findAll(".runcard").length;
  find("#rf-start")!.click();
  await waitFor(() => findAll(".runcard").length > before, "the new run card");

  const cards = findAll(".runcard");
  const fresh = cards.find((c) => c.textContent.includes("check the lockfile"));
  assert.ok(fresh, "the declared run must be on screen under the name it was given");
  assert.match(fresh!.textContent, /compare package-lock\.json/, "its task must be shown");

  // It was persisted, and what was persisted is a record that reads back.
  await settle();
  const writes = ipcCallsFor("conv_save").map((c) => String(c.args.id));
  const newId = writes.find((id) => id !== BLOCKED_ID);
  assert.ok(newId, "the declared run must have been handed to conv_save");
  const decoded = decodeRun(JSON.parse(saved.get(newId!)!));
  assert.ok(decoded, "what was written must decode as a run record");
  assert.equal(decoded!.name, "check the lockfile");
  // Restorable, which is the only property that makes the write worth anything.
  const back = Run.restore(decoded!.snapshot, recordEntries(decoded!), () => FIXED_NOW);
  assert.equal(back.limits.policy, "read_only");
});

test("a scheduler that refused a corrupt jobs.json says so on screen", async () => {
  jobsAnswer = {
    jobs: [],
    error: "schedule/jobs.json is not valid JSON, nothing will fire until it is fixed",
    catchup_grace_minutes: 360,
  };
  mount(runsview.runsView());
  await waitFor(
    () => (find(".schedwrap")?.textContent ?? "").includes("jobs.json"),
    "the refusal to be shown",
  );

  const wrap = find(".schedwrap")!;
  assert.match(wrap.textContent, /nothing will fire/);
  // An error and a list are mutually exclusive: showing an empty list beside a
  // refusal would read as "you have no jobs", which is the opposite of true.
  assert.equal(wrap.querySelectorAll(".jobcard").length, 0);
  jobsAnswer = JOBS_VIEW;
});
