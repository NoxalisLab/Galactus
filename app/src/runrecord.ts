// Galactus, a run once the app is closed, and the two decisions the runs view
// has to make around a parked one.
//
// runs.ts owns what a run IS. This module owns what is left of it on disk, how
// that comes back, and the rule that decides whether a human standing in front
// of a blocked run may hand it the thing it stopped on.
//
// It exists apart from runsview.ts for one reason: the view builds an Agent,
// so it imports api.ts and the DOM, and nothing that reaches the Tauri bridge
// can be loaded by the test runner. Everything here is import-free except for
// the two pure run modules, so the storage format and the grant rule are
// pinned by tests rather than by hand.
//
// Two properties are load bearing, and each one is a test:
//
//  1. A record that was half written is REFUSED, not repaired. A run whose
//     snapshot no longer parses is a run nobody can vouch for, and restoring a
//     guess of it would put a budget and a policy on screen that were never
//     agreed to.
//  2. A grant is rebuilt from the TRANSCRIPT, never from a field of the saved
//     record. The transcript is append-only and already carries both halves:
//     the gate entry that blocked, and the answer entry a human wrote. A grant
//     that cannot be found there is not a grant, which is what stops an edited
//     file from handing a read_only run a capability it never asked a human
//     for.

import type { RunEntry, RunPermissionKind, RunSnapshot } from "./runs.js";
import { RUN_PERMISSION_KINDS, RUN_STATES, parseTranscript, validateLimits } from "./runs.js";
import type { DrivePermissionRequest } from "./rundrive.js";
import { blockQuestion } from "./rundrive.js";

// ---------------------------------------------------------------- identity

/**
 * Runs are stored through the same per-file JSON path as conversations
 * (conv_save/conv_load in lib.rs): one file, written atomically, read back by
 * id. The prefix is what keeps the two apart in a directory they share, and
 * store.ts drops it from the conversation list rather than showing a run as an
 * empty thread.
 */
export const RUN_ID_PREFIX = "run-";

export function isRunId(id: string): boolean {
  return id.startsWith(RUN_ID_PREFIX);
}

/**
 * A fresh id. Same construction as store.ts's newId: a timestamp for order and
 * a few random characters against a collision inside the same millisecond. The
 * clock and the randomness are arguments so a test can produce a known id.
 */
export function makeRunId(now: number, rand: () => number = Math.random): string {
  return RUN_ID_PREFIX + now.toString(36) + rand().toString(36).slice(2, 7);
}

// ---------------------------------------------------------------- the record

/**
 * What one run leaves on disk. The snapshot is the state, the transcript is
 * the proof, and Run.restore refuses the pair when they disagree.
 */
export interface RunRecord {
  id: string;
  name: string;
  /** The task as the human wrote it. Turn 1 is driven from this. */
  prompt: string;
  created: number;
  updated: number;
  snapshot: RunSnapshot;
  /** JSON Lines, exactly what Run.toJsonl produced. */
  transcript: string;
  /**
   * The scheduled job that declared this run, when one did.
   *
   * Stored rather than held in memory because the report back to the scheduler
   * happens when the run ENDS, and a run can outlive the process that started
   * it: without this, a run restarted after a crash would finish and the job
   * would never learn what became of it. Absent for a run a human declared,
   * which is the common case and must stay indistinguishable from an older
   * record that predates the field.
   */
  job?: string;
}

export function encodeRun(record: RunRecord): string {
  return JSON.stringify(record);
}

/**
 * Read a record back, or nothing.
 *
 * Every field is checked, because the failure this guards against is not an
 * attack but a process killed mid write: a truncated file parses into an
 * object with three of its six keys, and a Run built from that would come back
 * with a budget nobody set. Null is the honest answer, and the view says the
 * run could not be read instead of showing a fiction.
 */
export function decodeRun(raw: unknown): RunRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const id = typeof v.id === "string" ? v.id : "";
  if (!id || !isRunId(id)) return null;
  if (typeof v.name !== "string" || typeof v.prompt !== "string") return null;
  if (typeof v.transcript !== "string") return null;
  const snap = v.snapshot;
  if (!snap || typeof snap !== "object") return null;
  const s = snap as Record<string, unknown>;
  if (typeof s.id !== "string" || typeof s.state !== "string") return null;
  if (!(RUN_STATES as readonly string[]).includes(s.state)) return null;
  if (!s.limits || typeof s.limits !== "object") return null;
  if (validateLimits(s.limits as RunSnapshot["limits"]) !== null) return null;
  if (!Number.isFinite(Number(s.turnsUsed)) || Number(s.turnsUsed) < 0) return null;
  return {
    id,
    name: v.name,
    prompt: v.prompt,
    created: Number.isFinite(Number(v.created)) ? Number(v.created) : 0,
    updated: Number.isFinite(Number(v.updated)) ? Number(v.updated) : 0,
    snapshot: snap as RunSnapshot,
    transcript: v.transcript,
    // A job id that is not a string is not a job id. Dropping it costs one
    // report to the scheduler; trusting it would put a run's output on a
    // delivery target belonging to a different job.
    ...(typeof v.job === "string" && v.job ? { job: v.job } : {}),
  };
}

/** The transcript of a record, parsed. Half lines are dropped by parseTranscript. */
export function recordEntries(record: RunRecord): RunEntry[] {
  return parseTranscript(record.transcript);
}

// ---------------------------------------------------------------- grants

/**
 * The key a grant is held under: the kind AND the exact detail. Granting
 * "fs_write" on one path must not grant it on another, so the detail is part
 * of the identity rather than a label beside it. NUL cannot appear in either
 * half, so no pair of requests can collide into one key.
 */
export function grantKey(req: { kind: string; detail: string }): string {
  return `${req.kind}\u0000${req.detail}`;
}

/**
 * The sentence a grant is recorded with, in the run's own transcript, through
 * Run.resume. It is a fixed shape rather than prose because it is read back:
 * this is the only place a grant is stored, and grantsFromTranscript parses
 * exactly what this writes.
 */
export function grantAnswer(req: { kind: string; detail: string }): string {
  return `granted for this run: ${req.kind}: ${req.detail}`;
}

/** The mirror sentence for a refusal. Recorded for the same reason. */
export function refuseAnswer(req: { kind: string; detail: string }): string {
  return `refused by a human: ${req.kind}: ${req.detail}`;
}

const GRANT_PREFIX = "granted for this run: ";

/**
 * What a human granted this run, and nothing else.
 *
 * Elevated never enters. Not because the caller is careful, but because
 * `grant` refuses it outright: rundrive refuses an elevated request rather
 * than parking on it, so a human is never asked about one, and a grant set
 * that could hold one would be a second door into the thing runs.ts closes
 * first in decideGate.
 */
export class RunGrants {
  private readonly keys = new Set<string>();

  /** Records the grant. False, and nothing recorded, for an elevated request. */
  grant(req: { kind: string; detail: string; elevated: boolean }): boolean {
    if (req.elevated) return false;
    this.keys.add(grantKey(req));
    return true;
  }

  has(req: { kind: string; detail: string; elevated: boolean }): boolean {
    if (req.elevated) return false;
    return this.keys.has(grantKey(req));
  }

  size(): number {
    return this.keys.size;
  }

  /**
   * Rebuild the set from the append-only record.
   *
   * A grant counts only when the transcript holds BOTH halves: a gate entry
   * that actually blocked on that exact kind and detail, and an answer entry
   * granting it afterwards. One half alone is a file somebody edited, and the
   * answer to an edited audit record is to ignore it, not to honour it.
   */
  static fromTranscript(entries: readonly RunEntry[]): RunGrants {
    const grants = new RunGrants();
    const blocked = new Set<string>();
    for (const entry of entries) {
      if (entry.type === "gate") {
        if (entry.decision === "block" && !entry.elevated) {
          blocked.add(grantKey({ kind: entry.kind, detail: entry.detail }));
        }
        continue;
      }
      if (entry.type !== "answer") continue;
      // The FIRST line only. A human may attach a word to their answer, and it
      // is recorded on the lines below: reading the whole entry would make the
      // grant depend on the prose, and a granted request would stop being
      // recognised the moment somebody typed a comment next to it.
      const first = entry.text.split("\n")[0];
      if (!first.startsWith(GRANT_PREFIX)) continue;
      const body = first.slice(GRANT_PREFIX.length);
      const cut = body.indexOf(": ");
      if (cut <= 0) continue;
      const kind = body.slice(0, cut);
      const detail = body.slice(cut + 2);
      if (!(RUN_PERMISSION_KINDS as readonly string[]).includes(kind)) continue;
      const key = grantKey({ kind, detail });
      if (!blocked.has(key)) continue;
      grants.grant({ kind, detail, elevated: false });
    }
    return grants;
  }
}

// ---------------------------------------------------------------- the block

/**
 * The request a parked run is waiting on, recovered from its own transcript.
 *
 * Recovered rather than remembered on purpose: a run restored after a restart
 * has no memory of the turn that asked, and a grant that only worked while the
 * process that asked was still alive would leave the restored run parked
 * forever on a question the human already answered.
 *
 * The match is on the question text, which rundrive built from the request, so
 * a run parked on one of several blocked steps comes back with the right one.
 */
export function requestBehind(
  question: string,
  entries: readonly RunEntry[],
): DrivePermissionRequest | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "gate" || entry.decision !== "block") continue;
    const everyTime = entry.reason === "every_time";
    const req: DrivePermissionRequest = {
      kind: entry.kind as RunPermissionKind,
      detail: entry.detail,
      elevated: entry.elevated,
      noAlways: everyTime,
    };
    if (blockQuestion(req, everyTime ? "every_time" : "policy") === question) return req;
  }
  return null;
}

// ---------------------------------------------------------------- display

/**
 * One transcript entry, ready to paint.
 *
 * `tone` is what makes the record readable at a glance without reducing it to
 * its denials: an allowed gate call is shown, in its own tone, beside the ones
 * that were refused. A log that only carried the refusals would answer "what
 * was this run stopped from doing" and never "what did it do".
 *
 * The labels are the entry types verbatim and are NOT translated: they name
 * what is on disk, and a French transcript line describing an English JSONL
 * entry would be one more thing to map when reading the file itself.
 */
export interface TranscriptLine {
  seq: number;
  at: number;
  label: string;
  text: string;
  tone: "plain" | "allow" | "refuse" | "block" | "bad" | "good" | "ask";
}

function clip(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "..." : flat;
}

export function transcriptLines(entries: readonly RunEntry[]): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const e of entries) {
    const base = { seq: e.seq, at: e.at };
    switch (e.type) {
      case "created":
        out.push({
          ...base,
          label: "created",
          tone: "plain",
          text: `${e.name} · ${e.limits.policy} · ${e.limits.maxTurns} turns · ${Math.round(e.limits.maxWallClockMs / 1000)}s`,
        });
        break;
      case "state":
        out.push({
          ...base,
          label: "state",
          tone: e.to === "finished" ? "good" : e.to === "failed" ? "bad" : e.to === "blocked" ? "block" : "plain",
          text: `${e.from} to ${e.to} (${e.reason})`,
        });
        break;
      case "turn_begin":
        out.push({ ...base, label: "turn", tone: "plain", text: `turn ${e.turn} begins` });
        break;
      case "turn_end":
        out.push({
          ...base,
          label: "turn",
          tone: e.outcome === "failed" ? "bad" : e.outcome === "final" ? "good" : "plain",
          text: `turn ${e.turn} ends: ${e.outcome}${e.detail ? ` · ${clip(e.detail, 200)}` : ""}`,
        });
        break;
      case "gate":
        out.push({
          ...base,
          label: "gate",
          tone: e.decision === "allow" ? "allow" : e.decision === "block" ? "block" : "refuse",
          text: `${e.kind}: ${clip(e.detail, 160)} · ${e.decision} (${e.reason})${e.elevated ? " · elevated" : ""}`,
        });
        break;
      case "tool":
        out.push({ ...base, label: "tool", tone: "plain", text: `${e.name} · ${clip(e.result, 240)}` });
        break;
      case "output":
        out.push({ ...base, label: "output", tone: "plain", text: clip(e.text, 800) });
        break;
      case "question":
        out.push({ ...base, label: "question", tone: "ask", text: clip(e.text, 400) });
        break;
      case "answer":
        out.push({ ...base, label: "answer", tone: "ask", text: clip(e.text, 400) });
        break;
      case "refused":
        out.push({ ...base, label: "refused", tone: "refuse", text: `${e.action} in ${e.state}: ${e.reason}` });
        break;
      case "note":
        out.push({ ...base, label: "note", tone: "plain", text: clip(e.text, 400) });
        break;
    }
  }
  return out;
}

/**
 * A duration a human reads without converting it. Milliseconds are never
 * shown: the smallest budget the view can set is a minute, and "743 ms" in a
 * column of minutes is noise.
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}
