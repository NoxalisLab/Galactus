// Galactus, learned decisions: the part that runs in the page.
//
// Galactus can learn its own task detection (Laya, phase 2). Three things live
// here, all pure so the Node runner can pin them:
//
//  1. The TRACE ROW: what one decision looked like, written to
//     <app data>/learning/traces.jsonl by the backend. The message is redacted
//     BEFORE it leaves this module: redact.ts for the named secrets, the
//     read-sensitive paths of sensitive.ts for the files that are credentials,
//     and the user's home folder name. Nothing unredacted is ever handed to
//     decisions_trace_append.
//  2. The OUTCOME: what the user did about the decision in the next two turns.
//     An accepted swap confirms it, a task picked by hand corrects it, a
//     refused model reload is recorded but labels nothing (refusing a
//     thirty-second reload says the reload was not worth it, not that the task
//     was wrong). Rows stay in memory while their window is open and are
//     written once it closes, so the file is append-only.
//  3. The CHOICE: when the student's answer is used instead of the heuristic.
//     detectTask() stays the fallback for every doubt: student off, absent,
//     slow, malformed, or below the confidence threshold.
//
// The settings panel's state (what may be clicked, and why not) is also
// derived here, so its rules are tested without a DOM.

import type { Detection, TaskId } from "./autotask.js";
import { redact, REDACTED } from "./redact.js";
import { isElevatedRead } from "./sensitive.js";

/** Every task the classifier chooses among, in the order the student was trained on. */
export const TASK_IDS: readonly TaskId[] = ["general", "code", "scripting", "writing", "reasoning"];

/** Trace format version, bumped when a field changes meaning. */
export const TRACE_VERSION = 1;

/** The longest message kept in a trace. The student reads far less than this. */
export const STATE_MAX_CHARS = 2000;

/** Turns after a decision during which the user's reaction still counts as its outcome. */
export const OUTCOME_WINDOW = 2;

/** Time the student has to answer before the heuristic is used, milliseconds. */
export const STUDENT_BUDGET_MS = 50;

/** Default confidence the student must reach before it is trusted. */
export const DEFAULT_THRESHOLD = 0.6;

/**
 * Traces needed before a training is worth running: the held-out split is
 * about a quarter of them, and the gate wants at least 60 test rows. The
 * backend's own floor wins when decisions_status reports one.
 */
export const MIN_TRACES_TO_TRAIN = 240;

/** The gate, as the spec fixes it. Shown next to the numbers, checked in Rust. */
export const GATE = { minTest: 60, minGainPoints: 3, maxEce: 0.1 } as const;

export function isTaskId(v: unknown): v is TaskId {
  return typeof v === "string" && (TASK_IDS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------- redaction

/**
 * A path-like token: absolute, or under the home folder. Stops at whitespace,
 * quotes and the punctuation that ends a path in prose.
 */
const PATH_TOKEN = /(?:~|\/)[^\s"'`<>|;,()[\]{}]+/g;

/** A home folder, whose second segment is the user's account name. */
const HOME_DIR = /\/(?:Users|home)\/[^/\s"'`]+/g;

/**
 * The message as it may be stored.
 *
 * Order matters: the credential paths are checked on the real path (a
 * pattern like `/Library/Keychains/` needs the full string), and only then is
 * the account name dropped from what remains.
 */
export function redactState(text: string): { text: string; removed: number } {
  const first = redact(text);
  let removed = first.removed;
  let out = first.text.replace(PATH_TOKEN, (p) => {
    if (isElevatedRead(p) || isElevatedRead(p.replace(/^~/, "/Users/_"))) {
      removed += 1;
      return REDACTED;
    }
    return p;
  });
  out = out.replace(HOME_DIR, "~");
  return { text: capChars(out, STATE_MAX_CHARS), removed };
}

/**
 * The first `max` UTF-16 units of `s`, never ending on half a surrogate pair.
 * A lone high surrogate serialises to a JSON string serde refuses, and the
 * whole trace row would be rejected for one emoji at the cut.
 */
export function capChars(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

// ---------------------------------------------------------------- trace rows

export interface StudentAnswer {
  task: TaskId;
  confidence: number;
}

export type DecisionSource = "student" | "heuristic";

/** What the user did about a decision. `task` is null when it teaches nothing. */
export type OutcomeKind = "accepted" | "refused" | "undone" | "repicked";

export interface Outcome {
  kind: OutcomeKind;
  /** The task the user showed was right; learn.py labels with it, over the teacher. */
  task: TaskId | null;
}

/** What the app offered to do about the model after the decision. */
export type SwapAction = "none" | "offered" | "auto";

/**
 * One decision, as written to traces.jsonl.
 *
 * The backend requires `id` and `heuristic.task`, and stamps `ts` itself (in
 * seconds, which its 90-day cap counts in). learn.py reads `state.message`,
 * `state.previous_task`, `heuristic.task` and `outcome.task`; the same state
 * shape is what decisions_decide hands the student, so training and serving
 * see one format. Each row is written once, when its outcome window closes.
 */
export interface TraceRow {
  v: number;
  id: string;
  family: "task";
  state: {
    /** The message, redacted and capped. */
    message: string;
    previous_task: TaskId;
  };
  /** How many secrets redaction removed from the message. */
  redacted: number;
  options: TaskId[];
  heuristic: { task: TaskId; confidence: number };
  student: StudentAnswer | null;
  decision: { task: TaskId; confidence: number; source: DecisionSource };
  /** The task in effect after the turn started: the decision only moves it when confident. */
  applied: TaskId;
  swap: SwapAction;
  outcome: Outcome | null;
}

export interface TraceInput {
  text: string;
  previous: TaskId;
  heuristic: Detection;
  student: StudentAnswer | null;
  decision: Detection & { source: DecisionSource };
  applied: TaskId;
  swap: SwapAction;
  id?: string;
}

function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function round(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

export function makeTraceRow(i: TraceInput): TraceRow {
  const r = redactState(i.text);
  return {
    v: TRACE_VERSION,
    id: i.id ?? newId(),
    family: "task",
    state: { message: r.text, previous_task: i.previous },
    redacted: r.removed,
    options: [...TASK_IDS],
    heuristic: { task: i.heuristic.task, confidence: round(i.heuristic.confidence) },
    student: i.student ? { task: i.student.task, confidence: round(i.student.confidence) } : null,
    decision: { task: i.decision.task, confidence: round(i.decision.confidence), source: i.decision.source },
    applied: i.applied,
    swap: i.swap,
    outcome: null,
  };
}

// ---------------------------------------------------------------- outcomes

/**
 * Holds the rows whose outcome window is still open.
 *
 * A row is CLOSED when OUTCOME_WINDOW newer decisions exist after it: a
 * correction made while the user writes the next two messages still counts,
 * one made after the second of them does not.
 *
 * Writes are append-only and learn.py keeps the LAST line of a repeated id, so
 * a row may be written more than once and the latest version wins. That is
 * what makes the tracker robust to the page going away: a row is written the
 * moment it gets an outcome, persist() writes every open row that changed
 * since it was last written (the page calls it when it is hidden and before
 * unload), and closing a row writes it only if it changed since. The calls go
 * through an asynchronous IPC, so a page killed mid-write can still lose what
 * it wrote last: at worst the rows of the last OUTCOME_WINDOW decisions.
 *
 * The user's reactions are attributed to the most recent decision that CHANGED
 * the task when there is one in the window, because that is the decision a
 * hand-picked task corrects; otherwise to the most recent one.
 */
export class OutcomeTracker {
  private pending: TraceRow[] = [];
  /** id -> the JSON last handed to `write`, so an unchanged row is not written twice. */
  private written = new Map<string, string>();

  constructor(
    private readonly write: (row: TraceRow) => void,
    private readonly window = OUTCOME_WINDOW,
  ) {}

  /** Rows still waiting for their outcome, oldest first. For tests and the panel. */
  open(): readonly TraceRow[] {
    return this.pending;
  }

  private emit(row: TraceRow): void {
    const json = JSON.stringify(row);
    if (this.written.get(row.id) === json) return;
    this.written.set(row.id, json);
    this.write(row);
  }

  private close(row: TraceRow): void {
    this.emit(row);
    this.written.delete(row.id);
  }

  record(row: TraceRow): void {
    this.pending.push(row);
    while (this.pending.length > this.window) this.close(this.pending.shift()!);
  }

  private target(): TraceRow | null {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].applied !== this.pending[i].state.previous_task) return this.pending[i];
    }
    return this.pending[this.pending.length - 1] ?? null;
  }

  /** The user chose a task by hand. */
  manualPick(task: TaskId): void {
    const row = this.target();
    if (!row || task === row.applied) return; // a re-click on what is already in effect says nothing
    const previous = row.state.previous_task;
    const switched = row.applied !== previous;
    row.outcome = { kind: switched && task === previous ? "undone" : "repicked", task };
    this.emit(row);
  }

  /** The offered model swap was accepted: the decision was right. */
  swapAccepted(): void {
    const row = this.lastOffered();
    if (row && !row.outcome?.task) {
      row.outcome = { kind: "accepted", task: row.decision.task };
      this.emit(row);
    }
  }

  /** The offered model swap was dismissed. Recorded, labels nothing. */
  swapRefused(): void {
    const row = this.lastOffered();
    if (row && !row.outcome) {
      row.outcome = { kind: "refused", task: null };
      this.emit(row);
    }
  }

  private lastOffered(): TraceRow | null {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].swap === "offered") return this.pending[i];
    }
    return null;
  }

  /** Write every open row that changed since it was last written, keeping the windows open. */
  persist(): void {
    for (const r of this.pending) this.emit(r);
  }

  /** Close every open row now: collection is ending. */
  flush(): void {
    const rows = this.pending;
    this.pending = [];
    for (const r of rows) this.close(r);
  }

  /** Forget the open rows without writing them: the user deleted the traces or stopped collecting. */
  drop(): void {
    this.pending = [];
    this.written.clear();
  }
}

// ---------------------------------------------------------------- the choice

/** The service's answer, checked. Anything else is treated as no answer. */
export function parseStudent(raw: unknown): StudentAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const task = o.task ?? o.choice;
  const confidence = o.confidence;
  if (!isTaskId(task)) return null;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  if (confidence < 0 || confidence > 1) return null;
  return { task, confidence };
}

/** The student's answer when it is trusted, else the heuristic's. */
export function chooseDecision(
  heuristic: Detection,
  student: StudentAnswer | null,
  threshold: number,
): Detection & { source: DecisionSource } {
  if (student && student.confidence >= threshold) {
    return {
      task: student.task,
      confidence: student.confidence,
      reason: "décision apprise",
      source: "student",
    };
  }
  return { ...heuristic, source: "heuristic" };
}

/** The threshold setting, clamped to something that can mean "confident". */
export function parseThreshold(v: string | undefined): number {
  const x = Number(v);
  if (!v || !Number.isFinite(x)) return DEFAULT_THRESHOLD;
  return Math.min(0.99, Math.max(0.5, x));
}

/**
 * Resolves to the promise's value, or to null once `ms` have passed or when
 * it rejects. The student is an optimisation; a slow or broken one must cost
 * the turn nothing.
 */
export function withBudget<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(null);
      }
    }, ms);
    p.then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

// ---------------------------------------------------------------- settings

export interface LearningSettings {
  collect: boolean;
  active: boolean;
  threshold: number;
}

/** Both switches are off unless the user wrote exactly "1". */
export function learningSettings(map: Record<string, string>): LearningSettings {
  return {
    collect: map["learning_collect"] === "1",
    active: map["learning_active"] === "1",
    threshold: parseThreshold(map["learning_threshold"]),
  };
}

// ---------------------------------------------------------------- backend shapes

export interface TrainResult {
  accepted: boolean;
  student: { acc: number; ece: number; n: number };
  heuristic: { acc: number; n: number };
  labels: { teacher: number; outcome: number; hand: number };
  /** ISO date or epoch ms, when the backend gives one. */
  date: string | null;
  /** Why the gate refused it, when the backend says. */
  reason: string | null;
}

export interface LearningStatus {
  installed: boolean;
  installing: boolean;
  training: boolean;
  /** Bytes the toolkit download will take, when known. */
  downloadBytes: number | null;
  traces: number;
  active: string | null;
  previous: string | null;
  last: TrainResult | null;
  /** Rejected checkpoints still on disk. */
  rejected: number;
  /** learn.py ships with this build. False on a build made without it. */
  shipped: boolean;
  /** Traces needed before a training can be measured (60 test rows, about 240 traces). */
  minTraces: number;
}

function num(v: unknown, dflt = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function parseResult(raw: unknown): TrainResult | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, any>;
  if (typeof o.accepted !== "boolean" || !o.student || !o.heuristic) return null;
  const date = typeof o.date === "number" ? new Date(o.date).toISOString() : str(o.date);
  return {
    accepted: o.accepted,
    student: { acc: num(o.student.acc), ece: num(o.student.ece), n: num(o.student.n) },
    heuristic: { acc: num(o.heuristic.acc), n: num(o.heuristic.n) },
    labels: {
      teacher: num(o.labels?.teacher),
      outcome: num(o.labels?.outcome),
      hand: num(o.labels?.hand),
    },
    date,
    reason: Array.isArray(o.reasons)
      ? o.reasons.filter((x: unknown) => typeof x === "string" && x).join("; ") || null
      : str(o.reasons) ?? str(o.reason),
  };
}

/** decisions_status, read defensively: a missing field is "no", never a crash. */
export function parseStatus(raw: unknown): LearningStatus {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const bytes = o.download_bytes ?? o.downloadBytes ?? o.toolkit_bytes;
  return {
    installed: o.installed === true,
    installing: o.installing === true,
    training: o.training === true,
    downloadBytes: typeof bytes === "number" && bytes > 0 ? bytes : null,
    traces: num(o.traces),
    active: str(o.active),
    previous: str(o.previous),
    last: parseResult(o.last),
    rejected: num(o.rejected),
    shipped: o.toolkit_shipped !== false,
    minTraces: num(o.min_traces ?? o.min_traces_to_train, MIN_TRACES_TO_TRAIN) || MIN_TRACES_TO_TRAIN,
  };
}

export type LearningEvent =
  | { kind: "progress"; phase: string; step: string | null; pct: number | null; message: string }
  | {
      kind: "end";
      phase: string;
      outcome: "done" | "error" | "cancelled";
      message: string;
      /** Which job ended, when the backend says: "install" or "training". */
      job: string | null;
      /** The last useful log line (install.log), when the backend sends one. */
      detail: string;
    }
  | { kind: "result"; result: TrainResult };

/** One galactus://learning payload. */
export function parseLearningEvent(raw: unknown): LearningEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if ("result" in o) {
    const result = parseResult(o.result);
    return result ? { kind: "result", result } : null;
  }
  if (typeof o.phase !== "string") return null;
  const message = typeof o.message === "string" ? o.message : "";
  const job = str(o.job);
  const detailRaw = o.detail ?? o.log ?? o.log_line;
  const detail = typeof detailRaw === "string" && detailRaw !== message ? detailRaw : "";
  const end = (outcome: "done" | "error" | "cancelled") =>
    ({ kind: "end", phase: o.phase as string, outcome, message, job, detail }) as const;
  if (o.phase === "error") return end("error");
  if (o.phase === "cancelled") return end("cancelled");
  if (o.phase === "done" || o.done === true) return end("done");
  const pct = typeof o.pct === "number" && Number.isFinite(o.pct) ? Math.max(0, Math.min(100, o.pct)) : null;
  return { kind: "progress", phase: o.phase, step: str(o.step), pct, message };
}

/** Where the labels of the last training came from, as the panel states it. */
export type LabelOrigin = "teacher" | "outcome" | "both" | "hand";

export function labelOrigin(r: TrainResult): LabelOrigin {
  const t = r.labels.teacher > 0;
  const u = r.labels.outcome > 0;
  if (t && u) return "both";
  if (u) return "outcome";
  if (t) return "teacher";
  return "hand";
}

/** Each gate condition, met or not, for the result table. */
export function gateChecks(r: TrainResult): { n: boolean; gain: boolean; ece: boolean } {
  return {
    n: r.student.n >= GATE.minTest,
    gain: (r.student.acc - r.heuristic.acc) * 100 >= GATE.minGainPoints - 1e-9,
    ece: r.student.ece <= GATE.maxEce + 1e-12,
  };
}

// ---------------------------------------------------------------- panel state

export interface PanelInput {
  status: LearningStatus;
  settings: LearningSettings;
  /** A primary model is loaded and ready: it is the labelling teacher. */
  primaryReady: boolean;
  /** An install or training is running as seen from the events. */
  busy: "install" | "train" | null;
}

export interface PanelState {
  canInstall: boolean;
  canCancelInstall: boolean;
  canTrain: boolean;
  /** i18n key saying why training is not possible, null when it is. */
  trainBlocked: string | null;
  /** Every condition training is waiting for, i18n keys, in the order to fix them. */
  trainMissing: string[];
  canActivate: boolean;
  activateBlocked: string | null;
  canRollback: boolean;
  canExport: boolean;
  canClear: boolean;
  /** Traces AND every checkpoint trained on them. */
  canForget: boolean;
  canCancelTrain: boolean;
}

export function panelState(i: PanelInput): PanelState {
  const s = i.status;
  const installing = s.installing || i.busy === "install";
  const training = s.training || i.busy === "train";
  // All of them, not the first: a user told only "install the toolkit" installs
  // it and then discovers the trace floor, then the teacher, one at a time.
  const trainMissing: string[] = [];
  if (training) trainMissing.push("learn.block.training");
  else if (installing) trainMissing.push("learn.block.installing");
  else if (!s.shipped) trainMissing.push("learn.block.notShipped");
  else if (!s.installed) trainMissing.push("learn.block.noToolkit");
  if (s.traces < s.minTraces) trainMissing.push("learn.block.fewTraces");
  if (!i.primaryReady) trainMissing.push("learn.block.noTeacher");
  const trainBlocked = trainMissing[0] ?? null;
  const activateBlocked = s.active || i.settings.active ? null : "learn.block.noCheckpoint";
  return {
    canInstall: s.shipped && !s.installed && !installing,
    canCancelInstall: installing,
    canTrain: trainBlocked === null,
    trainBlocked,
    trainMissing,
    canActivate: activateBlocked === null,
    activateBlocked,
    canRollback: !!s.previous && !training,
    canExport: s.traces > 0,
    canClear: s.traces > 0 && !training,
    canForget: !training && (s.traces > 0 || !!s.active || !!s.previous || !!s.last || s.rejected > 0),
    canCancelTrain: training,
  };
}

/** 0.9333 -> "93.3". */
export function pct1(x: number): string {
  return (Math.round(x * 1000) / 10).toFixed(1);
}

/** Bytes as the panel shows them. */
export function sizeLabel(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}
