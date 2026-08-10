// What a person reads on the Scheduled row, and what the model is told when a
// job fires late.
//
// The late case is the interesting one. A run that is producing "today's"
// anything has to know that "now" and "the minute this was meant to run" are
// two different instants, or a digest fired at 09:00 for a 03:00 slot will
// quietly summarise the wrong window.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import {
  clockLabel,
  draftError,
  draftOf,
  draftToInput,
  emptyDraft,
  jobReport,
  jobRunName,
  jobTask,
  outcomeTone,
  relativeLabel,
  type Job,
  type JobDue,
} from "../../src/schedule.js";

const JOB: Job = {
  id: "job-1",
  name: "Nightly digest",
  task: "  Summarise what changed today.  ",
  schedule: "0 3 * * *",
  enabled: true,
  policy: "read_only",
  max_turns: 8,
  max_minutes: 20,
  preauthorize_every_time: false,
  delivery: { mode: "none" },
  created_at: 0,
  updated_at: 0,
  enabled_at: 0,
};

function due(over: Partial<JobDue> = {}): JobDue {
  return {
    job: JOB,
    scheduled_at: 1_715_742_000,
    fired_at: 1_715_742_060,
    dropped: 0,
    saturated: false,
    catchup: false,
    ...over,
  };
}

test("an on-time run is handed the task and nothing else", () => {
  assert.equal(jobTask(due()), "Summarise what changed today.");
});

test("a late run is told it is late, and how much was skipped", () => {
  const text = jobTask(due({ catchup: true, dropped: 419, saturated: true }));
  assert.ok(text.startsWith("Summarise what changed today."));
  assert.ok(text.includes("late"), text);
  assert.ok(text.includes("419+"), "the count is shown as approximate when it is");
  assert.ok(text.includes("skipped rather than queued"), text);
});

test("a late run with nothing skipped says so without inventing a number", () => {
  const text = jobTask(due({ catchup: true, dropped: 0 }));
  assert.ok(text.includes("late"));
  assert.ok(!text.includes("other scheduled runs"), text);
});

test("a run's name carries the minute it was due for", () => {
  const name = jobRunName(JOB, 1_715_742_000);
  assert.ok(name.startsWith("Nightly digest · "));
  assert.match(name, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test("a clock label is fixed width, and an absent instant is not 1970", () => {
  assert.match(clockLabel(1_715_742_000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(clockLabel(0), "-");
  assert.equal(clockLabel(Number.NaN), "-");
});

test("a relative label reads in both directions and coarsens as it grows", () => {
  const now = 1_000_000_000_000;
  const at = (deltaSecs: number) => relativeLabel(now / 1000 + deltaSecs, now);
  assert.equal(at(30), "in 30s");
  assert.equal(at(600), "in 10m");
  assert.equal(at(3600), "in 1h");
  assert.equal(at(3600 + 720), "in 1h 12m");
  assert.equal(at(2 * 86_400 + 3 * 3600), "in 2d 3h");
  assert.equal(at(-600), "10m ago");
  assert.equal(at(-2 * 86_400), "2d ago");
  assert.equal(relativeLabel(null, now), "");
});

test("what a run reports back separates blocked from failed", () => {
  assert.deepEqual(jobReport("finished", "  42 files  ", null, null), {
    outcome: "finished",
    detail: "42 files",
  });
  assert.deepEqual(jobReport("failed", null, "no engine", null), {
    outcome: "failed",
    detail: "no engine",
  });
  // A run waiting for a person is neither a success nor a failure, and calling
  // it either would both lie to the webhook and move the failure count.
  assert.deepEqual(jobReport("blocked", null, null, "grant git push?"), {
    outcome: "blocked",
    detail: "grant git push?",
  });
  assert.deepEqual(jobReport("exhausted", null, null, null), {
    outcome: "exhausted",
    detail: "",
  });
  assert.equal(outcomeTone("finished"), "good");
  assert.equal(outcomeTone("failed"), "bad");
  assert.equal(outcomeTone("exhausted"), "bad");
  assert.equal(outcomeTone("blocked"), "block");
  assert.equal(outcomeTone(""), "plain");
});

test("a fresh draft delivers nowhere", () => {
  const draft = emptyDraft();
  assert.equal(draft.deliveryMode, "none");
  assert.deepEqual(draftToInput(draft).delivery, { mode: "none" });
});

test("the form refuses what it can check without asking Rust", () => {
  const draft = emptyDraft();
  assert.equal(draftError(draft), "task");
  draft.task = "do the thing";
  assert.equal(draftError(draft), null);
  draft.schedule = "   ";
  assert.equal(draftError(draft), "schedule");
  draft.schedule = "@daily";
  draft.deliveryMode = "webhook";
  assert.equal(draftError(draft), "webhook");
  draft.webhook = "https://example.com/hook";
  assert.equal(draftError(draft), null);
  draft.deliveryMode = "file";
  assert.equal(draftError(draft), "file");
});

test("a draft made from a job and sent back is the same job", () => {
  const source: Job = {
    ...JOB,
    task: "Summarise what changed today.",
    policy: "autonomous",
    preauthorize_every_time: true,
    delivery: { mode: "file", path: "/tmp/out.txt" },
  };
  const input = draftToInput(draftOf(source));
  assert.equal(input.id, "job-1");
  assert.equal(input.task, "Summarise what changed today.");
  assert.equal(input.policy, "autonomous");
  assert.equal(input.preauthorize_every_time, true);
  assert.deepEqual(input.delivery, { mode: "file", path: "/tmp/out.txt" });
});

test("a draft cannot send preauthorize under a policy that cannot use it", () => {
  const draft = draftOf({ ...JOB, policy: "autonomous", preauthorize_every_time: true });
  draft.policy = "read_only";
  assert.equal(draftToInput(draft).preauthorize_every_time, false);
});
