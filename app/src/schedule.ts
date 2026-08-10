// Galactus, a scheduled job as the frontend sees it.
//
// scheduler.rs owns the clock, the definitions and the catch-up decision.
// runs.ts owns what a run may do. This module is the seam between them, and it
// is a separate file for the same reason runrecord.ts is: the view builds an
// Agent, which drags in api.ts and the DOM, and nothing that reaches the Tauri
// bridge can be loaded by the test runner.
//
// Everything here is pure. Two properties are load bearing, and each one is a
// test:
//
//  1. A job can never produce limits a Run would refuse. A job is a run
//     template, and a template that fails validateLimits is a schedule that
//     fires every night into an exception nobody reads.
//  2. `preauthorizeEveryTime` cannot escape `autonomous`. Rust already refuses
//     it at save time; it is refused AGAIN here, on the way out of the stored
//     definition, because a hand-edited jobs.json is exactly the case the Rust
//     check cannot see.
//
// The unit of time on the wire is SECONDS, because that is what the Rust side
// counts in. Everything a Date touches is milliseconds. Every field named
// `_at` below is seconds; every argument named `nowMs` is milliseconds.

import type { RunLimits, RunPolicy, RunState } from "./runs.js";
import { RUN_POLICIES, validateLimits } from "./runs.js";

// ---------------------------------------------------------------- shapes

export type DeliveryMode = "none" | "webhook" | "file";

/**
 * Where a job's output goes. Tagged the same way the Rust enum is serialised,
 * so the two ends agree without a translation layer that could drift.
 */
export type Delivery =
  | { mode: "none" }
  | { mode: "webhook"; url: string }
  | { mode: "file"; path: string };

export interface Job {
  id: string;
  name: string;
  task: string;
  /** As typed by a human: "0 3 * * *", "30m", "@daily". */
  schedule: string;
  enabled: boolean;
  policy: RunPolicy;
  max_turns: number;
  max_minutes: number;
  preauthorize_every_time: boolean;
  delivery: Delivery;
  created_at: number;
  updated_at: number;
  enabled_at: number;
}

export interface JobState {
  last_fired_at: number | null;
  last_finished_at: number | null;
  last_outcome: string;
  last_detail: string;
  last_run_id: string;
  consecutive_failures: number;
  missed: number;
  last_missed_at: number | null;
  last_delivery: string;
}

export interface JobRow extends Job {
  state: JobState;
  next_fire_at: number | null;
  schedule_error: string;
  schedule_note: string;
  in_flight: boolean;
}

export interface JobsView {
  jobs: JobRow[];
  /** Non-empty when a file on disk was refused. Nothing fires while it is set. */
  error: string;
  catchup_grace_minutes: number;
}

/** The payload of the `galactus://job-due` event. */
export interface JobDue {
  job: Job;
  scheduled_at: number;
  fired_at: number;
  dropped: number;
  saturated: boolean;
  catchup: boolean;
}

// ---------------------------------------------------------------- decoding

const EMPTY_STATE: JobState = {
  last_fired_at: null,
  last_finished_at: null,
  last_outcome: "",
  last_detail: "",
  last_run_id: "",
  consecutive_failures: 0,
  missed: 0,
  last_missed_at: null,
  last_delivery: "",
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function maybeNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function isJobPolicy(value: unknown): value is RunPolicy {
  return typeof value === "string" && (RUN_POLICIES as readonly string[]).includes(value);
}

/**
 * Read a delivery target back.
 *
 * Anything that is not recognisable becomes `none`. That direction is not
 * arbitrary: the failure mode of guessing wrong here is sending a job's output
 * to a place nobody chose, and `none` is the only value that cannot do that.
 */
export function decodeDelivery(raw: unknown): Delivery {
  if (!raw || typeof raw !== "object") return { mode: "none" };
  const v = raw as Record<string, unknown>;
  if (v.mode === "webhook" && typeof v.url === "string" && v.url.trim()) {
    return { mode: "webhook", url: v.url };
  }
  if (v.mode === "file" && typeof v.path === "string" && v.path.trim()) {
    return { mode: "file", path: v.path };
  }
  return { mode: "none" };
}

export function decodeJobState(raw: unknown): JobState {
  if (!raw || typeof raw !== "object") return { ...EMPTY_STATE };
  const v = raw as Record<string, unknown>;
  return {
    last_fired_at: maybeNum(v.last_fired_at),
    last_finished_at: maybeNum(v.last_finished_at),
    last_outcome: str(v.last_outcome),
    last_detail: str(v.last_detail),
    last_run_id: str(v.last_run_id),
    consecutive_failures: num(v.consecutive_failures),
    missed: num(v.missed),
    last_missed_at: maybeNum(v.last_missed_at),
    last_delivery: str(v.last_delivery),
  };
}

/**
 * A job as it came off the bridge, or null.
 *
 * Null rather than a repaired object: a row without an id or a policy is a row
 * this build cannot act on, and inventing the missing half would put a run on
 * screen under a policy nobody chose. The caller drops it and says how many.
 */
export function decodeJob(raw: unknown): Job | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const id = str(v.id);
  const task = str(v.task);
  if (!id || !task) return null;
  if (!isJobPolicy(v.policy)) return null;
  const policy = v.policy;
  return {
    id,
    name: str(v.name) || task.slice(0, 48),
    task,
    schedule: str(v.schedule),
    enabled: v.enabled === true,
    policy,
    max_turns: num(v.max_turns, 1),
    max_minutes: num(v.max_minutes, 1),
    // The second refusal. Rust drops this for any policy but autonomous when a
    // job is saved; a jobs.json edited by hand never went through that path.
    preauthorize_every_time: policy === "autonomous" && v.preauthorize_every_time === true,
    delivery: decodeDelivery(v.delivery),
    created_at: num(v.created_at),
    updated_at: num(v.updated_at),
    enabled_at: num(v.enabled_at),
  };
}

export function decodeJobsView(raw: unknown): JobsView {
  if (!raw || typeof raw !== "object") {
    return { jobs: [], error: "", catchup_grace_minutes: 0 };
  }
  const v = raw as Record<string, unknown>;
  const rows: JobRow[] = [];
  for (const entry of Array.isArray(v.jobs) ? v.jobs : []) {
    const job = decodeJob(entry);
    if (!job) continue;
    const e = entry as Record<string, unknown>;
    rows.push({
      ...job,
      state: decodeJobState(e.state),
      next_fire_at: maybeNum(e.next_fire_at),
      schedule_error: str(e.schedule_error),
      schedule_note: str(e.schedule_note),
      in_flight: e.in_flight === true,
    });
  }
  return {
    jobs: rows,
    error: str(v.error),
    catchup_grace_minutes: num(v.catchup_grace_minutes),
  };
}

export function decodeJobDue(raw: unknown): JobDue | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const job = decodeJob(v.job);
  if (!job) return null;
  return {
    job,
    scheduled_at: num(v.scheduled_at),
    fired_at: num(v.fired_at),
    dropped: num(v.dropped),
    saturated: v.saturated === true,
    catchup: v.catchup === true,
  };
}

// ---------------------------------------------------------------- the run

/**
 * The limits a job's run is declared under.
 *
 * Clamped here as well as in Rust. Not belt and braces: the Rust clamp applies
 * when a job is SAVED, and a definition can reach this function without ever
 * having been saved by this build. A run whose budget came out of a file is a
 * run nobody budgeted, and Run.create would throw on it at 03:00 with nobody
 * watching, which is the worst possible time to discover a bad number.
 */
export function jobLimits(job: Job): RunLimits {
  const limits: RunLimits = {
    maxTurns: clampInt(job.max_turns, 1, 200),
    maxWallClockMs: clampInt(job.max_minutes, 1, 24 * 60) * 60_000,
    policy: job.policy,
    preauthorizeEveryTime: job.policy === "autonomous" && job.preauthorize_every_time === true,
  };
  // If this ever fails the job cannot run at all, and saying so is better than
  // handing Run.create something it will throw on.
  if (validateLimits(limits) !== null) {
    return { maxTurns: 1, maxWallClockMs: 60_000, policy: "read_only" };
  }
  return limits;
}

function clampInt(value: number, min: number, max: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/**
 * The name the run carries. It has the job's name AND the minute it was due
 * for, because a nightly job produces one run per night and a list of eleven
 * rows all called "Nightly digest" is a list nobody can read.
 */
export function jobRunName(job: Job, scheduledAtSecs: number): string {
  return `${job.name} · ${clockLabel(scheduledAtSecs)}`;
}

/**
 * The task handed to the run.
 *
 * A late fire says so, in the task itself. The model is about to be told it is
 * unattended and asked to produce a result; if it is producing "today's"
 * anything, it needs to know that "now" and "the time this was meant to run"
 * are not the same instant.
 */
export function jobTask(due: JobDue): string {
  const task = due.job.task.trim();
  if (!due.catchup) return task;
  const late = `This run is late: it was scheduled for ${clockLabel(due.scheduled_at)} and is starting now.`;
  const dropped =
    due.dropped > 0
      ? ` ${due.dropped}${due.saturated ? "+" : ""} other scheduled runs were skipped rather than queued.`
      : "";
  return `${task}\n\n${late}${dropped}`;
}

/** What a finished run reports back to the scheduler. */
export interface RunReport {
  outcome: string;
  detail: string;
}

/**
 * Turn a run's end state into the two strings scheduler.rs stores and
 * delivers.
 *
 * A blocked run is reported as blocked, with its question as the detail: it is
 * neither a success nor a failure, it is a run waiting for a person, and
 * flattening it into "failed" would both lie to the webhook and reset the
 * consecutive-failure count for the wrong reason.
 */
export function jobReport(state: RunState, result: string | null, failure: string | null, question: string | null): RunReport {
  if (state === "finished") return { outcome: "finished", detail: (result ?? "").trim() };
  if (state === "blocked") return { outcome: "blocked", detail: (question ?? "").trim() };
  if (state === "failed") return { outcome: "failed", detail: (failure ?? "").trim() };
  return { outcome: state, detail: "" };
}

// ---------------------------------------------------------------- display

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * A local date and time, as short as it can be without becoming ambiguous.
 * Built from Date getters rather than toLocaleString so the shape is the same
 * on every machine and a test can assert on it.
 */
export function clockLabel(atSecs: number): string {
  if (!Number.isFinite(atSecs) || atSecs <= 0) return "-";
  const d = new Date(atSecs * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * How far away something is, in words a person reads without arithmetic.
 * Negative is the past. Deliberately coarse: a next fire that says "in 4h 12m"
 * and a next fire that says "in 4h" are the same information.
 */
export function relativeLabel(atSecs: number | null, nowMs: number): string {
  if (atSecs === null || !Number.isFinite(atSecs)) return "";
  const deltaSecs = Math.round(atSecs - nowMs / 1000);
  const ahead = deltaSecs >= 0;
  const abs = Math.abs(deltaSecs);
  let body: string;
  if (abs < 60) body = `${abs}s`;
  else if (abs < 3600) body = `${Math.floor(abs / 60)}m`;
  else if (abs < 86_400) {
    const h = Math.floor(abs / 3600);
    const m = Math.floor((abs % 3600) / 60);
    body = m > 0 ? `${h}h ${m}m` : `${h}h`;
  } else {
    const d = Math.floor(abs / 86_400);
    const h = Math.floor((abs % 86_400) / 3600);
    body = h > 0 ? `${d}d ${h}h` : `${d}d`;
  }
  return ahead ? `in ${body}` : `${body} ago`;
}

/** The tone a last outcome is painted in. Mirrors runrecord's transcript tones. */
export function outcomeTone(outcome: string): "good" | "bad" | "block" | "plain" {
  if (outcome === "finished") return "good";
  if (outcome === "failed" || outcome === "exhausted") return "bad";
  if (outcome === "blocked") return "block";
  return "plain";
}

// ---------------------------------------------------------------- the form

/** The declaration form's state, kept out of the DOM like the runs draft is. */
export interface JobDraft {
  id: string;
  name: string;
  task: string;
  schedule: string;
  policy: RunPolicy;
  turns: number;
  minutes: number;
  preauth: boolean;
  enabled: boolean;
  deliveryMode: DeliveryMode;
  webhook: string;
  file: string;
}

export function emptyDraft(): JobDraft {
  return {
    id: "",
    name: "",
    task: "",
    schedule: "0 9 * * 1-5",
    policy: "read_only",
    turns: 8,
    minutes: 20,
    preauth: false,
    enabled: true,
    // Nowhere, always, until a human says otherwise.
    deliveryMode: "none",
    webhook: "",
    file: "",
  };
}

export function draftOf(job: Job): JobDraft {
  return {
    id: job.id,
    name: job.name,
    task: job.task,
    schedule: job.schedule,
    policy: job.policy,
    turns: job.max_turns,
    minutes: job.max_minutes,
    preauth: job.preauthorize_every_time,
    enabled: job.enabled,
    deliveryMode: job.delivery.mode,
    webhook: job.delivery.mode === "webhook" ? job.delivery.url : "",
    file: job.delivery.mode === "file" ? job.delivery.path : "",
  };
}

export function draftDelivery(draft: JobDraft): Delivery {
  if (draft.deliveryMode === "webhook") return { mode: "webhook", url: draft.webhook.trim() };
  if (draft.deliveryMode === "file") return { mode: "file", path: draft.file.trim() };
  return { mode: "none" };
}

/**
 * What the frontend can check without Rust. The schedule itself is NOT checked
 * here: there is exactly one cron parser in this app and it is in cron.rs, and
 * a second one in TypeScript would disagree with it the week after it was
 * written. The form asks Rust through jobs_preview instead.
 */
export function draftError(draft: JobDraft): string | null {
  if (!draft.task.trim()) return "task";
  if (!draft.schedule.trim()) return "schedule";
  if (draft.deliveryMode === "webhook" && !draft.webhook.trim()) return "webhook";
  if (draft.deliveryMode === "file" && !draft.file.trim()) return "file";
  return null;
}

/** The payload jobs_save expects. Mirrors JobInput in scheduler.rs. */
export function draftToInput(draft: JobDraft): Record<string, unknown> {
  return {
    id: draft.id,
    name: draft.name.trim(),
    task: draft.task.trim(),
    schedule: draft.schedule.trim(),
    enabled: draft.enabled,
    policy: draft.policy,
    max_turns: clampInt(draft.turns, 1, 200),
    max_minutes: clampInt(draft.minutes, 1, 24 * 60),
    preauthorize_every_time: draft.policy === "autonomous" && draft.preauth,
    delivery: draftDelivery(draft),
  };
}
