// The rule that keeps an unattended Galactus from killing its own work.
//
// Server mode exists so a Mac can host a model and run scheduled jobs with
// nobody in front of it. An updater that restarts on its own would end a run
// that has already written files and already spent an hour, with no resume and
// no record beyond a job that stopped. So the restart needs a human AND an
// idle scheduler, and this file is where that is a fact rather than an
// intention.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import {
  applyChunk,
  autoCheckAllowed,
  downloadLabel,
  emptyProgress,
  formatBytes,
  progressPercent,
  restartVerdict,
} from "../../src/update.js";

test("nothing restarts this process without a human", () => {
  assert.equal(restartVerdict({ userInitiated: false, jobsInFlight: 0 }), "not-user-initiated");
  assert.equal(restartVerdict({ userInitiated: false, jobsInFlight: 3 }), "not-user-initiated");
});

test("a human cannot restart over a running job either", () => {
  assert.equal(restartVerdict({ userInitiated: true, jobsInFlight: 1 }), "jobs-in-flight");
  assert.equal(restartVerdict({ userInitiated: true, jobsInFlight: 9 }), "jobs-in-flight");
});

test("a human and an idle scheduler is the only way through", () => {
  assert.equal(restartVerdict({ userInitiated: true, jobsInFlight: 0 }), "ok");
});

test("server mode never checks by itself", () => {
  // The check is only a network call and a banner, but a banner on a machine
  // with no one in front of it is an offer that can only be answered by
  // accident.
  assert.equal(autoCheckAllowed({ mode: "server", enabled: true }), false);
  assert.equal(autoCheckAllowed({ mode: "server", enabled: false }), false);
});

test("app mode checks unless it was told not to", () => {
  assert.equal(autoCheckAllowed({ mode: "app", enabled: true }), true);
  assert.equal(autoCheckAllowed({ mode: "app", enabled: false }), false);
});

test("progress accumulates chunks and does not treat one as the total", () => {
  let p = emptyProgress();
  assert.equal(progressPercent(p), null);
  p = applyChunk(p, 0, 1000);
  assert.equal(progressPercent(p), 0);
  p = applyChunk(p, 250);
  p = applyChunk(p, 250);
  assert.equal(p.downloaded, 500);
  assert.equal(progressPercent(p), 50);
  p = applyChunk(p, 500);
  assert.equal(progressPercent(p), 100);
});

test("a server that sent more bytes than it promised does not overflow the bar", () => {
  let p = applyChunk(emptyProgress(), 0, 100);
  p = applyChunk(p, 400);
  assert.equal(p.downloaded, 100);
  assert.equal(progressPercent(p), 100);
});

test("an unknown total shows bytes instead of an invented percentage", () => {
  let p = emptyProgress();
  p = applyChunk(p, 1_500_000);
  assert.equal(progressPercent(p), null);
  assert.equal(downloadLabel(p), "1.5 MB");
});

test("the label reads as a sentence once the total is known", () => {
  let p = applyChunk(emptyProgress(), 0, 53_590_847);
  p = applyChunk(p, 26_795_424);
  assert.equal(downloadLabel(p), "26.8 MB of 53.6 MB (50%)");
});

test("byte sizes stay legible across the range", () => {
  assert.equal(formatBytes(0), "0 MB");
  assert.equal(formatBytes(-1), "0 MB");
  assert.equal(formatBytes(999), "1 kB");
  assert.equal(formatBytes(53_590_847), "53.6 MB");
  assert.equal(formatBytes(2_400_000_000), "2.40 GB");
});
