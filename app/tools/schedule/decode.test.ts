// What comes off the Tauri bridge, and what is refused on the way in.
//
// The scheduler's files are on disk in Application Support, in plain JSON,
// with no signature and nothing stopping a person from opening them in an
// editor. Rust validates what it SAVES; it cannot validate what it merely
// read. So the second gate is here, and the two rules it enforces are the two
// that would otherwise turn a text editor into a privilege escalation:
//
//   a row without an id, a task or a known policy is dropped, not repaired;
//   preauthorizeEveryTime cannot escape `autonomous`, whatever the file says.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { decodeDelivery, decodeJob, decodeJobDue, decodeJobState, decodeJobsView } from "../../src/schedule.js";

const GOOD = {
  id: "job-1",
  name: "Nightly digest",
  task: "Summarise what changed today.",
  schedule: "0 3 * * *",
  enabled: true,
  policy: "read_only",
  max_turns: 8,
  max_minutes: 20,
  preauthorize_every_time: false,
  delivery: { mode: "none" },
  created_at: 1000,
  updated_at: 1000,
  enabled_at: 1000,
};

test("a well formed job survives the trip unchanged", () => {
  const job = decodeJob(GOOD);
  if (!job) throw new Error("a well formed job must decode");
  assert.equal(job.id, "job-1");
  assert.equal(job.policy, "read_only");
  assert.equal(job.max_turns, 8);
  assert.deepEqual(job.delivery, { mode: "none" });
});

test("a row missing what makes it a job is dropped rather than filled in", () => {
  assert.equal(decodeJob(null), null);
  assert.equal(decodeJob("job"), null);
  assert.equal(decodeJob({ ...GOOD, id: "" }), null);
  assert.equal(decodeJob({ ...GOOD, task: "" }), null);
  // The important one: an unknown policy must not become a known one.
  assert.equal(decodeJob({ ...GOOD, policy: "root" }), null);
  assert.equal(decodeJob({ ...GOOD, policy: undefined }), null);
});

test("preauthorize cannot escape autonomous, whatever the file on disk says", () => {
  // The escalation this closes: one edited field in a plain JSON file turning
  // a read_only nightly job into one that answers the two requests the
  // attended gate insists on showing every time.
  for (const policy of ["read_only", "propose"]) {
    const job = decodeJob({ ...GOOD, policy, preauthorize_every_time: true });
    if (!job) throw new Error(policy);
    assert.equal(job.preauthorize_every_time, false, policy);
  }
  const auto = decodeJob({ ...GOOD, policy: "autonomous", preauthorize_every_time: true });
  if (!auto) throw new Error("autonomous must decode");
  assert.equal(auto.preauthorize_every_time, true);
});

test("a delivery target nobody can read becomes nowhere, never somewhere else", () => {
  assert.deepEqual(decodeDelivery(undefined), { mode: "none" });
  assert.deepEqual(decodeDelivery({ mode: "webhook" }), { mode: "none" });
  assert.deepEqual(decodeDelivery({ mode: "webhook", url: "   " }), { mode: "none" });
  assert.deepEqual(decodeDelivery({ mode: "file", path: 7 }), { mode: "none" });
  assert.deepEqual(decodeDelivery({ mode: "smtp", to: "a@b" }), { mode: "none" });
  assert.deepEqual(decodeDelivery({ mode: "webhook", url: "https://x/y" }), {
    mode: "webhook",
    url: "https://x/y",
  });
  assert.deepEqual(decodeDelivery({ mode: "file", path: "/tmp/a.txt" }), {
    mode: "file",
    path: "/tmp/a.txt",
  });
});

test("a missing state reads as a job that has never run", () => {
  const s = decodeJobState(undefined);
  assert.equal(s.last_fired_at, null);
  assert.equal(s.last_outcome, "");
  assert.equal(s.consecutive_failures, 0);
  assert.equal(s.missed, 0);
});

test("the view keeps the good rows and the error, and drops the rest", () => {
  const view = decodeJobsView({
    jobs: [
      { ...GOOD, state: { last_outcome: "finished" }, next_fire_at: 42, in_flight: true },
      { ...GOOD, id: "", state: {} },
      "nonsense",
    ],
    error: "jobs.json is not a readable job file",
    catchup_grace_minutes: 360,
  });
  assert.equal(view.jobs.length, 1);
  assert.equal(view.jobs[0].next_fire_at, 42);
  assert.equal(view.jobs[0].in_flight, true);
  assert.equal(view.jobs[0].state.last_outcome, "finished");
  assert.equal(view.catchup_grace_minutes, 360);
  assert.ok(view.error.includes("not a readable"));
});

test("an unreadable view is empty rather than thrown on", () => {
  const view = decodeJobsView(null);
  assert.deepEqual(view.jobs, []);
  assert.equal(view.error, "");
});

test("a due event without a usable job is refused, so nothing is declared", () => {
  assert.equal(decodeJobDue(null), null);
  assert.equal(decodeJobDue({ job: { ...GOOD, policy: "root" } }), null);
  const due = decodeJobDue({
    job: GOOD,
    scheduled_at: 100,
    fired_at: 160,
    dropped: 3,
    saturated: false,
    catchup: true,
  });
  if (!due) throw new Error("a well formed due event must decode");
  assert.equal(due.dropped, 3);
  assert.equal(due.catchup, true);
  assert.equal(due.scheduled_at, 100);
});
