// A job is a run template. This is the file that says so with a test.
//
// The property that matters: whatever a job definition contains, the limits it
// produces are limits Run.create accepts. A job that fails validateLimits does
// not fail on a screen with a person in front of it, it fails at 03:00 inside
// a thrown exception, and the only trace is a schedule that quietly stopped
// producing runs.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { Run, policyGrants, validateLimits } from "../../src/runs.js";
import { jobLimits, type Job } from "../../src/schedule.js";

function job(over: Partial<Job> = {}): Job {
  return {
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
    created_at: 0,
    updated_at: 0,
    enabled_at: 0,
    ...over,
  };
}

test("the ordinary case maps straight across", () => {
  const limits = jobLimits(job());
  assert.equal(limits.maxTurns, 8);
  assert.equal(limits.maxWallClockMs, 20 * 60_000);
  assert.equal(limits.policy, "read_only");
  assert.equal(validateLimits(limits), null);
});

test("no job definition, however broken, produces limits a run would refuse", () => {
  const nonsense: Partial<Job>[] = [
    { max_turns: 0 },
    { max_turns: -5 },
    { max_turns: Number.NaN },
    { max_turns: Number.POSITIVE_INFINITY },
    { max_turns: 1e9 },
    { max_minutes: 0 },
    { max_minutes: -1 },
    { max_minutes: Number.NaN },
    { max_minutes: 99_999 },
    { max_turns: 3.7, max_minutes: 4.2 },
  ];
  for (const over of nonsense) {
    const limits = jobLimits(job(over));
    assert.equal(validateLimits(limits), null, JSON.stringify(over));
    // And the real proof: the Run itself accepts them.
    const run = Run.create({ id: "run-x", name: "n", limits, now: () => 0 });
    assert.equal(run.getState(), "queued");
  }
});

test("budgets are clamped into the range the runs view offers", () => {
  assert.equal(jobLimits(job({ max_turns: 1e9 })).maxTurns, 200);
  assert.equal(jobLimits(job({ max_minutes: 99_999 })).maxWallClockMs, 24 * 60 * 60_000);
  assert.equal(jobLimits(job({ max_turns: 0 })).maxTurns, 1);
  assert.equal(jobLimits(job({ max_minutes: 0 })).maxWallClockMs, 60_000);
});

test("preauthorize survives only under the policy that can use it", () => {
  assert.equal(
    jobLimits(job({ policy: "autonomous", preauthorize_every_time: true })).preauthorizeEveryTime,
    true,
  );
  for (const policy of ["read_only", "propose"] as const) {
    assert.equal(
      jobLimits(job({ policy, preauthorize_every_time: true })).preauthorizeEveryTime,
      false,
      policy,
    );
  }
});

test("a scheduled run is granted exactly what its policy grants and nothing more", () => {
  // A job carries no permission of its own: the policy name in the file is the
  // whole story, and it is the same table an attended declaration reads.
  for (const policy of ["read_only", "propose", "autonomous"] as const) {
    const limits = jobLimits(job({ policy }));
    assert.equal(limits.policy, policy);
    assert.ok(policyGrants(policy).length > 0);
  }
  assert.ok(!policyGrants("read_only").includes("fs_write"));
  assert.ok(!policyGrants("propose").includes("shell"));
});
