// Galactus, unattended runs: a named task, a budget, and a policy decided
// before the first token.
//
// Every agent turn today needs someone watching. The permission gate asks, the
// thread is the only place progress appears, and closing the view ends the
// story. Server mode makes the gap plain: a machine serving the model has
// nobody sitting in front of it.
//
// A RUN closes that gap without widening what an agent may do. Three
// properties are load bearing here, and each one is pinned by a test:
//
//  1. Elevated requests are refused, always, whatever the policy says. An
//     unattended run must never be able to grant itself something an attended
//     one would have put in front of a human. There is deliberately no policy
//     value that unlocks them, and no argument that overrides the rule.
//  2. Budget is checked BEFORE a turn is spent, never after. A run that
//     discovers it is over budget having already run the turn was not
//     budgeted, it was merely measured.
//  3. Blocking is an outcome, not an error. A run that meets a decision only a
//     human can make stops cleanly, records what it is waiting for, and comes
//     back where it left off.
//
// PURE module by construction: no import of api.ts, no DOM, no Date.now. The
// clock is injected, for the same reason model-policy.ts keeps the rules that
// mirror Rust testable outside the app: what is not injectable is not testable,
// and what is not tested here has already been wrong once in a shipped build.

// ---------------------------------------------------------------- states

/**
 * The seven states a run can be in. They are exhaustive on purpose: there is
 * no "unknown", no null, and no state that means two things at once.
 *
 *  queued     declared, budget untouched, clock not started
 *  running    the run owns the model; a turn may or may not be in flight
 *  blocked    stopped on a decision only a human can make, resumable
 *  finished   the work produced a final answer
 *  failed     a turn threw, or the process died mid turn
 *  cancelled  a human or the host asked it to stop
 *  exhausted  the budget ran out before a turn could start
 */
export type RunState =
  | "queued"
  | "running"
  | "blocked"
  | "finished"
  | "failed"
  | "cancelled"
  | "exhausted";

export const RUN_STATES: readonly RunState[] = [
  "queued",
  "running",
  "blocked",
  "finished",
  "failed",
  "cancelled",
  "exhausted",
];

const TERMINAL_STATES: readonly RunState[] = ["finished", "failed", "cancelled", "exhausted"];

/**
 * The limits with their keys in a fixed order, so two of them can be compared
 * as strings. JSON.stringify preserves insertion order, and a snapshot written
 * by a different code path would otherwise differ from the transcript purely
 * by key order, which would refuse a perfectly honest restore.
 */
function sortedLimits(l: RunLimits): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(l).sort()) out[k] = (l as unknown as Record<string, unknown>)[k];
  return out;
}

/** True when nothing can move the run any further. */
export function isTerminal(state: RunState): boolean {
  return TERMINAL_STATES.includes(state);
}

// ---------------------------------------------------------------- policy

/**
 * The permission kinds of agent.ts, restated.
 *
 * This module cannot import them: agent.ts pulls in api.ts and the DOM, so a
 * type-only import would still drag the Tauri bridge into every consumer of
 * this file and into the test runner. sensitive.ts is import-free for exactly
 * that reason. The copy is kept honest by tools/runs, which reads the union out
 * of agent.ts at test time and fails when the two sets diverge: a kind added
 * there and forgotten here would otherwise default to whatever this file's
 * tables happen to do with an unknown string, which is precisely how a new
 * capability escapes a policy nobody rewrote.
 */
export type RunPermissionKind =
  | "fs_read"
  | "fs_write"
  | "fs_list"
  | "shell"
  | "obsidian"
  | "memory"
  | "web"
  | "mcp"
  | "agent"
  | "conversations"
  | "code"
  | "git";

export const RUN_PERMISSION_KINDS: readonly RunPermissionKind[] = [
  "fs_read",
  "fs_write",
  "fs_list",
  "shell",
  "obsidian",
  "memory",
  "web",
  "mcp",
  "agent",
  "conversations",
  "code",
  "git",
];

/**
 * The closed set of policies a run may be started under. Closed because the
 * alternative, a free list of kinds chosen per run, is an interface where the
 * dangerous configuration and the safe one look alike, and where nobody can
 * answer "what can this run do" without reading twelve checkboxes.
 *
 *  read_only   look, never touch. Nothing changes, nothing leaves the machine.
 *  propose     read_only plus web retrieval and code proposals. A proposal is
 *              not a write: it lands in the editor as a pending diff and only a
 *              human accepting a hunk reaches the disk, which is what makes it
 *              grantable to an unattended run at all.
 *  autonomous  every ORDINARY kind, the mirror of Agent.setAutoApprove(true).
 *              Elevated stays refused, and anything the attended gate insists
 *              on showing every time still blocks: see decideGate.
 */
export type RunPolicy = "read_only" | "propose" | "autonomous";

export const RUN_POLICIES: readonly RunPolicy[] = ["read_only", "propose", "autonomous"];

const POLICY_GRANTS: Record<RunPolicy, readonly RunPermissionKind[]> = {
  read_only: ["fs_read", "fs_list", "conversations"],
  propose: ["fs_read", "fs_list", "conversations", "web", "code"],
  autonomous: RUN_PERMISSION_KINDS,
};

/** What a policy grants, for display and for tests. Never mutated. */
export function policyGrants(policy: RunPolicy): readonly RunPermissionKind[] {
  return POLICY_GRANTS[policy];
}

export function isRunPolicy(value: unknown): value is RunPolicy {
  return typeof value === "string" && (RUN_POLICIES as readonly string[]).includes(value);
}

/**
 * A gate request as the run sees it. Same shape as agent.ts's
 * PermissionRequest minus the diff preview, which only exists to render a
 * dialog and there is no dialog here.
 */
export interface RunPermissionRequest {
  kind: RunPermissionKind;
  detail: string;
  /** Set by isElevatedCommand / isElevatedWrite / isElevatedRead upstream. */
  elevated: boolean;
  /**
   * The attended gate hides "Always" for these, because the point is that the
   * user sees the branch and the count EVERY time (push, pull). A request whose
   * whole reason to exist is being seen cannot be auto-granted by a policy.
   */
  noAlways?: boolean;
}

/**
 * Three outcomes, and the difference between the last two is the whole point.
 *
 *  allow   the policy covers it, the run proceeds
 *  refuse  the run may not have it and asking would not help: hand the model a
 *          denial and let it continue, exactly like a user pressing Deny
 *  block   a human could grant this, so the run stops and waits instead of
 *          guessing. Resumable.
 */
export type RunGateOutcome =
  | { decision: "allow" }
  | { decision: "refuse"; reason: "elevated" | "cancelled" | "out_of_turn" | "expired" }
  | { decision: "block"; reason: "policy" | "every_time" };

/**
 * The policy decision, with no state involved so it can be reasoned about on
 * its own. Order matters: elevated is tested first and short circuits, so no
 * policy table, present or future, can reach a decision on an elevated request.
 */
export function decideGate(
  policy: RunPolicy,
  req: RunPermissionRequest,
  preauthorizeEveryTime = false,
): RunGateOutcome {
  if (req.elevated) return { decision: "refuse", reason: "elevated" };
  if (!POLICY_GRANTS[policy].includes(req.kind)) return { decision: "block", reason: "policy" };
  // Third, and only third. The two checks above have already run, so this can
  // turn nothing into an allow that the policy or the elevated rule refused.
  if (req.noAlways && !preauthorizeEveryTime) {
    return { decision: "block", reason: "every_time" };
  }
  return { decision: "allow" };
}

// ---------------------------------------------------------------- limits

export interface RunLimits {
  /** Hard cap on turns. At least 1: a run that may not take a turn is not a run. */
  maxTurns: number;
  /**
   * Hard cap on wall clock, counted from the first turn and NOT while blocked.
   * A run waiting on a human for three days has not spent three days working,
   * and charging it for the wait would turn every block into an exhaustion.
   */
  maxWallClockMs: number;
  policy: RunPolicy;
  /**
   * Answer, in advance, the requests the attended gate insists on showing every
   * time: today that is `git push` and `git pull`, the only two things an
   * `autonomous` run can still stop on.
   *
   * Without it a run is not unattended, it is merely unwatched until the first
   * push, and then it is a task waiting for someone to click. That is not a
   * subtlety about one permission kind, it is the difference between automation
   * and a queue of interruptions. So the decision moves to where it belongs in
   * an automated system: the declaration. A human still makes it, once, knowing
   * what the run is for, instead of being paged mid-turn to approve a branch
   * name they now have to reconstruct the context for.
   *
   * It cannot reach anything else. decideGate refuses elevated before it looks
   * at this, and blocks on a kind outside the policy before it too, so this only
   * ever turns the `every_time` block into an allow, and only for a policy that
   * already grants the kind. Under read_only it changes nothing at all.
   *
   * Absent means false. It is part of the frozen limits and part of the
   * transcript's created entry, so a run cannot acquire it after the fact and a
   * snapshot claiming it against a transcript that does not is refused.
   */
  preauthorizeEveryTime?: boolean;
}

export type LimitsError = "max_turns" | "max_wall_clock" | "policy" | "preauthorize";

/** Null when the limits are usable, otherwise which field is wrong. */
export function validateLimits(limits: RunLimits): LimitsError | null {
  if (!Number.isInteger(limits.maxTurns) || limits.maxTurns < 1) return "max_turns";
  if (!Number.isFinite(limits.maxWallClockMs) || limits.maxWallClockMs < 1) return "max_wall_clock";
  if (!isRunPolicy(limits.policy)) return "policy";
  const pre = limits.preauthorizeEveryTime;
  if (pre !== undefined && typeof pre !== "boolean") return "preauthorize";
  return null;
}

export interface BudgetStatus {
  /** True when a turn may START. Never says anything about a turn already running. */
  ok: boolean;
  turnsUsed: number;
  turnsLeft: number;
  /** Working time only: blocked spans are excluded. */
  elapsedMs: number;
  msLeft: number;
  reason: "turns" | "clock" | null;
}

// ---------------------------------------------------------------- transcript

/**
 * The append-only record. Plain JSON, one entry per line once serialized, so a
 * run can be read with `cat` and audited on a machine that has never seen this
 * app. That is what makes an unattended run trustworthy rather than merely
 * unattended: what it tried, what the gate answered, what it produced.
 *
 * `seq` is monotone from 0 and never reused, so a truncated or reordered file
 * is detectable; `at` comes from the injected clock.
 */
export interface RunEntryBase {
  seq: number;
  at: number;
}

export type RunEntry =
  | (RunEntryBase & { type: "created"; run: string; name: string; limits: RunLimits })
  | (RunEntryBase & { type: "state"; from: RunState; to: RunState; reason: string })
  | (RunEntryBase & { type: "turn_begin"; turn: number })
  | (RunEntryBase & { type: "turn_end"; turn: number; outcome: TurnOutcomeKind; detail: string })
  | (RunEntryBase & {
      type: "gate";
      kind: RunPermissionKind;
      detail: string;
      elevated: boolean;
      decision: RunGateOutcome["decision"];
      reason: string;
    })
  | (RunEntryBase & { type: "tool"; name: string; detail: string; result: string })
  | (RunEntryBase & { type: "output"; text: string })
  | (RunEntryBase & { type: "question"; text: string })
  | (RunEntryBase & { type: "answer"; text: string })
  | (RunEntryBase & { type: "refused"; action: string; state: RunState; reason: RunRefusal })
  | (RunEntryBase & { type: "note"; text: string });

/**
 * An entry as the writer supplies it, before the sequence number and the
 * timestamp are stamped on. The conditional is there to DISTRIBUTE over the
 * union: a plain Omit<RunEntry, ...> collapses to the keys the variants share,
 * which is `type` alone, and would let any entry through untyped.
 */
type RunEntryBody = RunEntry extends infer T ? (T extends RunEntry ? Omit<T, "seq" | "at"> : never) : never;

/** JSON Lines, terminated, ready to append to a file or stream to a client. */
export function transcriptToJsonl(entries: readonly RunEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
}

/**
 * Read a transcript back. Malformed lines are DROPPED rather than thrown on: a
 * transcript is written incrementally, and a process killed mid write leaves a
 * half line whose only sane reading is "this entry never completed". Throwing
 * would make the other thousand entries unreadable because of the last one.
 */
export function parseTranscript(text: string): RunEntry[] {
  const out: RunEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as RunEntry;
      if (parsed && typeof parsed === "object" && typeof parsed.type === "string") out.push(parsed);
    } catch {
      /* an entry that never finished being written is not an entry */
    }
  }
  return out;
}

// ---------------------------------------------------------------- turns

export type TurnOutcomeKind = "continue" | "final" | "blocked" | "failed";

export type TurnOutcome =
  | { kind: "continue" }
  | { kind: "final"; text: string }
  | { kind: "blocked"; question: string }
  | { kind: "failed"; error: string };

/**
 * Why a call was refused. These are identifiers, not messages: this module has
 * no i18n because it has no user, the caller maps them to strings.
 */
export type RunRefusal =
  /** The run is over: finished, failed, cancelled or exhausted. */
  | "terminal"
  /** A turn is already open. */
  | "turn_in_flight"
  /** endTurn with nothing to end. */
  | "no_turn_in_flight"
  /** A turn was asked for while the run waits on a human: resume first. */
  | "blocked"
  /** resume on a run that is not waiting for an answer. */
  | "not_blocked"
  | "budget_turns"
  | "budget_clock";

export type BeginTurnResult =
  | { ok: true; turn: number; state: RunState }
  | { ok: false; state: RunState; reason: RunRefusal };

export type RunAck = { ok: true; state: RunState } | { ok: false; state: RunState; reason: RunRefusal };

/**
 * What a turn is handed. Everything a turn needs to record itself, and nothing
 * that would let it reach outside the run.
 */
export interface RunTurnContext {
  /** 1 for the first turn. */
  readonly turn: number;
  /** The gate, policy applied and outcome recorded. */
  gate(req: RunPermissionRequest): RunGateOutcome;
  /** A tool call and its result, for the record. */
  tool(name: string, detail: string, result: string): void;
  /** Something the run produced. */
  output(text: string): void;
  /** A free note, for progress the host wants kept. */
  note(text: string): void;
  /** True once a cancel has landed. A long turn should check it and stop. */
  cancelled(): boolean;
}

// ---------------------------------------------------------------- snapshot

/** Everything needed to bring a run back after the window, or the app, closed. */
export interface RunSnapshot {
  id: string;
  name: string;
  limits: RunLimits;
  state: RunState;
  turnsUsed: number;
  /**
   * When the first turn began. Display only, and deliberately so: it used to be
   * the base of the elapsed-time arithmetic, which charged the run for every
   * hour the app spent closed. Duration is carried by `workedMs`, which can
   * only grow while the run is actually running in a live process.
   */
  startedAt: number | null;
  /** Working time accumulated across every session this run has lived through. */
  workedMs: number;
  turnInFlight: boolean;
  question: string | null;
  result: string | null;
  error: string | null;
  cancelRequested: boolean;
  seq: number;
}

export interface RunOptions {
  id: string;
  name: string;
  limits: RunLimits;
  /** Injected clock in milliseconds. Nothing here reads Date.now. */
  now: () => number;
}

// ---------------------------------------------------------------- the run

export class Run {
  private readonly entries: RunEntry[] = [];
  private seq = 0;
  private state: RunState = "queued";
  private turnsUsed = 0;
  private startedAt: number | null = null;
  /**
   * The clock, as an accumulator rather than a subtraction between two absolute
   * timestamps. `workedMs` is closed time; `runningSince` is the open span, and
   * it exists only in a live process. Nothing that survives a restart carries a
   * timestamp the arithmetic depends on, which is what makes app downtime
   * uncountable instead of merely subtracted-out-in-the-cases-we-remembered.
   */
  private workedMs = 0;
  private runningSince: number | null = null;
  private turnInFlight = false;
  private cancelRequested = false;
  private question: string | null = null;
  private result: string | null = null;
  private error: string | null = null;

  /**
   * `readonly` on the parameter freezes the BINDING, not the object behind it,
   * so `run.limits.policy = "autonomous"` type-checked and took effect on the
   * very next gate call. The limits are the contract the run was started
   * under; they are frozen at construction so that contract cannot be
   * rewritten from outside while the run is alive.
   */
  private constructor(
    readonly id: string,
    readonly name: string,
    readonly limits: Readonly<RunLimits>,
    private readonly now: () => number,
  ) {
    Object.freeze(this.limits);
  }

  /**
   * Declare a run. Invalid limits throw here rather than degrading to a
   * default, because a run whose budget was silently replaced is a run nobody
   * budgeted.
   */
  static create(opts: RunOptions): Run {
    const bad = validateLimits(opts.limits);
    if (bad) throw new Error(`invalid run limits: ${bad}`);
    const run = new Run(opts.id, opts.name, { ...opts.limits }, opts.now);
    run.push({ type: "created", run: opts.id, name: opts.name, limits: { ...opts.limits } });
    return run;
  }

  /**
   * Bring a run back from its snapshot and its transcript.
   *
   * A snapshot taken with a turn in flight means the process died inside that
   * turn. Nobody knows what it did or how far it got, so the run comes back
   * FAILED rather than running: resuming it would replay an unknown amount of
   * work, and calling it blocked would suggest a human can fix it by answering
   * a question that was never asked.
   */
  static restore(snapshot: RunSnapshot, entries: readonly RunEntry[], now: () => number): Run {
    const bad = validateLimits(snapshot.limits);
    if (bad) throw new Error(`invalid run limits: ${bad}`);
    if (!(RUN_STATES as readonly string[]).includes(snapshot.state)) {
      throw new Error(`invalid run state: ${String(snapshot.state)}`);
    }
    // THE LIMITS COME FROM THE TRANSCRIPT, NOT FROM THE SNAPSHOT.
    //
    // Trusting the snapshot was the third escalation path, and the quietest:
    // editing one field of a JSON file on disk turned a read_only run into an
    // autonomous one, while its own audit record kept saying read_only. The
    // transcript is append-only and its first entry records the contract the
    // run was created under, so that is the authority. A snapshot that
    // disagrees is not repaired, it is refused: the two disagreeing at all
    // means one of them was edited, and guessing which would be the whole
    // problem again.
    const created = entries.find((e) => e.type === "created");
    if (created && created.type === "created") {
      const a = JSON.stringify(sortedLimits(created.limits));
      const b = JSON.stringify(sortedLimits(snapshot.limits));
      if (a !== b) {
        throw new Error(
          "run limits disagree with the transcript: snapshot says " +
            `${b}, the created entry says ${a}`,
        );
      }
    }
    const source = created && created.type === "created" ? created.limits : snapshot.limits;
    const run = new Run(snapshot.id, snapshot.name, { ...source }, now);
    // Both loops are loops on purpose. `push(...entries)` and
    // `Math.max(...entries.map(...))` pass one argument per entry, and a long
    // run has hundreds of thousands: the spread threw RangeError, so the run
    // that had been working longest was exactly the one that could not be
    // brought back.
    for (const entry of entries) run.entries.push(entry);
    let seq = snapshot.seq > 0 ? snapshot.seq : 0;
    for (const entry of entries) if (entry.seq + 1 > seq) seq = entry.seq + 1;
    run.seq = seq;
    run.state = snapshot.state;
    run.turnsUsed = snapshot.turnsUsed;
    run.startedAt = snapshot.startedAt;
    run.workedMs = Number.isFinite(snapshot.workedMs) ? Math.max(0, snapshot.workedMs) : 0;
    // The open span starts NOW, never at the timestamp the previous process
    // died holding. The hours in between are not work and are not charged.
    run.runningSince = snapshot.state === "running" ? now() : null;
    run.cancelRequested = snapshot.cancelRequested;
    run.question = snapshot.question;
    run.result = snapshot.result;
    run.error = snapshot.error;
    run.turnInFlight = false;
    if (snapshot.turnInFlight) {
      run.push({
        type: "turn_end",
        turn: snapshot.turnsUsed,
        outcome: "failed",
        detail: "interrupted",
      });
      run.error = "interrupted";
      run.transition("failed", "interrupted");
    }
    return run;
  }

  // ------------------------------------------------------------ reading

  getState(): RunState {
    return this.state;
  }

  /** What the run is waiting for, only while blocked. */
  pendingQuestion(): string | null {
    return this.state === "blocked" ? this.question : null;
  }

  /** The final answer, only once finished. */
  finalResult(): string | null {
    return this.state === "finished" ? this.result : null;
  }

  /** Why it failed, only once failed. */
  failure(): string | null {
    return this.state === "failed" ? this.error : null;
  }

  /** A copy: the transcript is append-only and only this class appends. */
  transcript(): readonly RunEntry[] {
    return this.entries.slice();
  }

  toJsonl(): string {
    return transcriptToJsonl(this.entries);
  }

  snapshot(): RunSnapshot {
    return {
      id: this.id,
      name: this.name,
      limits: { ...this.limits },
      state: this.state,
      turnsUsed: this.turnsUsed,
      startedAt: this.startedAt,
      // The open span is closed into the snapshot: a snapshot taken mid run
      // must carry the time already worked, or a crash would refund it.
      workedMs: this.elapsedMs(),
      turnInFlight: this.turnInFlight,
      question: this.question,
      result: this.result,
      error: this.error,
      cancelRequested: this.cancelRequested,
      seq: this.seq,
    };
  }

  /**
   * Working time: the spans this run has actually spent running, in this
   * process and in every earlier one, including the span still open. Queued is
   * not work, blocked is not work, and neither is a closed app.
   */
  elapsedMs(): number {
    const open = this.runningSince !== null ? Math.max(0, this.now() - this.runningSince) : 0;
    return this.workedMs + open;
  }

  /**
   * The budget, read without spending any of it. `ok` answers one question
   * only: may a turn START now.
   */
  budget(): BudgetStatus {
    const elapsedMs = this.elapsedMs();
    const turnsLeft = Math.max(0, this.limits.maxTurns - this.turnsUsed);
    const msLeft = Math.max(0, this.limits.maxWallClockMs - elapsedMs);
    // Turns first: a run out of both should report the limit it was designed
    // around, and turns are the one the caller set deliberately.
    const reason = turnsLeft === 0 ? "turns" : msLeft === 0 ? "clock" : null;
    return { ok: reason === null, turnsUsed: this.turnsUsed, turnsLeft, elapsedMs, msLeft, reason };
  }

  // ------------------------------------------------------------ transitions

  /**
   * Take a turn. The budget is spent here and checked BEFORE it is: a refusal
   * moves the run to `exhausted` and no turn number is issued, so the caller
   * cannot run a turn it was not granted.
   */
  beginTurn(): BeginTurnResult {
    if (isTerminal(this.state)) return this.refuse("beginTurn", "terminal");
    if (this.turnInFlight) return this.refuse("beginTurn", "turn_in_flight");
    if (this.state === "blocked") return this.refuse("beginTurn", "blocked");
    const budget = this.budget();
    if (!budget.ok) {
      const reason: RunRefusal = budget.reason === "turns" ? "budget_turns" : "budget_clock";
      this.push({ type: "refused", action: "beginTurn", state: this.state, reason });
      this.transition("exhausted", reason);
      return { ok: false, state: this.state, reason };
    }
    if (this.startedAt === null) this.startedAt = this.now();
    if (this.state === "queued") this.transition("running", "first_turn");
    this.turnsUsed += 1;
    this.turnInFlight = true;
    this.question = null;
    this.push({ type: "turn_begin", turn: this.turnsUsed });
    return { ok: true, turn: this.turnsUsed, state: this.state };
  }

  /**
   * Close the turn opened by beginTurn.
   *
   * A cancel that landed while the turn was in flight wins over every outcome,
   * including a final answer: the run reports what the user asked for, and the
   * transcript still carries the real outcome above the state change, so
   * nothing the turn produced is lost.
   */
  endTurn(outcome: TurnOutcome): RunAck {
    if (!this.turnInFlight) {
      return this.refuse("endTurn", isTerminal(this.state) ? "terminal" : "no_turn_in_flight");
    }
    this.turnInFlight = false;
    const detail =
      outcome.kind === "final"
        ? outcome.text
        : outcome.kind === "blocked"
          ? outcome.question
          : outcome.kind === "failed"
            ? outcome.error
            : "";
    this.push({ type: "turn_end", turn: this.turnsUsed, outcome: outcome.kind, detail });
    if (this.cancelRequested) {
      this.transition("cancelled", "cancelled_in_flight");
      return { ok: true, state: this.state };
    }
    switch (outcome.kind) {
      case "continue":
        // No clock check here on purpose. A turn that overran is stopped by the
        // gate refusing "expired" for the rest of that turn, and the run ends
        // at the next beginTurn: exhaustion has exactly one door, and adding a
        // second one here would report "terminal" where the caller expects the
        // limit that was actually hit.
        return { ok: true, state: this.state };
      case "final":
        this.result = outcome.text;
        this.transition("finished", "final_answer");
        return { ok: true, state: this.state };
      case "blocked":
        this.question = outcome.question;
        this.push({ type: "question", text: outcome.question });
        this.transition("blocked", "needs_human");
        return { ok: true, state: this.state };
      case "failed":
        this.error = outcome.error;
        this.transition("failed", "turn_failed");
        return { ok: true, state: this.state };
    }
  }

  /**
   * Answer what the run was waiting for. A human taking an hour to reply costs
   * the run nothing: the clock stopped when it entered `blocked` and starts
   * again on the way out, in transition().
   */
  resume(answer: string): RunAck {
    if (this.state !== "blocked") {
      return this.refuse("resume", isTerminal(this.state) ? "terminal" : "not_blocked");
    }
    this.question = null;
    this.push({ type: "answer", text: answer });
    this.transition("running", "resumed");
    return { ok: true, state: this.state };
  }

  /**
   * Stop the run. Immediate when no turn is in flight; when one is, the request
   * is recorded, every subsequent gate call refuses, and the state changes when
   * the turn closes. Reporting `cancelled` while the turn is still executing
   * would be a lie the caller could act on.
   */
  cancel(reason = "user"): RunAck {
    if (isTerminal(this.state)) return this.refuse("cancel", "terminal");
    this.cancelRequested = true;
    if (this.turnInFlight) {
      this.push({ type: "note", text: `cancel requested: ${reason}` });
      return { ok: true, state: this.state };
    }
    this.transition("cancelled", reason);
    return { ok: true, state: this.state };
  }

  // ------------------------------------------------------------ the gate

  /**
   * The permission gate for an unattended turn.
   *
   * Nothing here can reach a human, so the only three answers are allow, refuse
   * and block. Every call is recorded whatever the answer: an audit that only
   * kept the denials would not prove what the run actually did.
   */
  gate(req: RunPermissionRequest): RunGateOutcome {
    // The state guard comes FIRST, and its absence was a real escalation path:
    // a run that had finished, been cancelled, run out of budget or blocked
    // still answered allow, because only cancelRequested was consulted. A
    // permission belongs to a turn that is actually running and to nothing
    // else. Refusing outside one costs a caller that asked too late; allowing
    // there costs a capability the run was never granted.
    const outOfTurn =
      isTerminal(this.state) || !this.turnInFlight
        ? { decision: "refuse" as const, reason: "out_of_turn" as const }
        : null;
    // The wall clock was checked at beginTurn and nowhere else, so it bounded
    // how many turns could START and not how long one could RUN: a single turn
    // that looped for ten hours never met the limit again. A turn cannot be
    // interrupted from here, but it can stop being granted anything, which is
    // the part that matters, and endTurn then closes the run as exhausted.
    const expired =
      this.limits.maxWallClockMs - this.elapsedMs() <= 0
        ? { decision: "refuse" as const, reason: "expired" as const }
        : null;
    const outcome: RunGateOutcome = outOfTurn
      ? outOfTurn
      : this.cancelRequested
        ? { decision: "refuse", reason: "cancelled" }
        : expired
          ? expired
          : decideGate(this.limits.policy, req, this.limits.preauthorizeEveryTime === true);
    this.push({
      type: "gate",
      kind: req.kind,
      detail: req.detail,
      elevated: req.elevated,
      decision: outcome.decision,
      reason: outcome.decision === "allow" ? "policy" : outcome.reason,
    });
    return outcome;
  }

  // ------------------------------------------------------------ driving

  /**
   * Run one turn with the budget, the transcript and the failure path already
   * wired.
   *
   * The reason this exists next to beginTurn/endTurn: a turn that throws must
   * still close, or the transcript ends on a turn_begin with no turn_end and
   * the run stays "running" forever with nothing running. Here the close is in
   * a finally-shaped path, so a thrown turn is a failed turn and the record
   * stays balanced.
   */
  async execute(work: (ctx: RunTurnContext) => Promise<TurnOutcome>): Promise<BeginTurnResult> {
    const begun = this.beginTurn();
    if (!begun.ok) return begun;
    const ctx: RunTurnContext = {
      turn: begun.turn,
      gate: (req) => this.gate(req),
      tool: (name, detail, result) => this.push({ type: "tool", name, detail, result }),
      output: (text) => this.push({ type: "output", text }),
      note: (text) => this.push({ type: "note", text }),
      cancelled: () => this.cancelRequested,
    };
    let outcome: TurnOutcome;
    try {
      outcome = await work(ctx);
    } catch (err) {
      outcome = { kind: "failed", error: err instanceof Error ? err.message : String(err) };
    }
    this.endTurn(outcome);
    return { ok: true, turn: begun.turn, state: this.state };
  }

  // ------------------------------------------------------------ internals

  private push(entry: RunEntryBody): void {
    this.entries.push({ ...entry, seq: this.seq++, at: this.now() } as RunEntry);
  }

  /**
   * The one place the clock moves. Entering `running` opens a span, leaving it
   * closes the span into `workedMs`. Keeping this here, rather than at the four
   * call sites that used to credit blocked time by hand, is why blocked, queued
   * and terminated all stop the clock without anyone having remembered to.
   */
  private transition(to: RunState, reason: string): void {
    const from = this.state;
    if (from === "running" && to !== "running") {
      if (this.runningSince !== null) {
        this.workedMs += Math.max(0, this.now() - this.runningSince);
        this.runningSince = null;
      }
    } else if (to === "running" && from !== "running") {
      this.runningSince = this.now();
    }
    this.state = to;
    this.push({ type: "state", from, to, reason });
  }

  private refuse(action: string, reason: RunRefusal): { ok: false; state: RunState; reason: RunRefusal } {
    this.push({ type: "refused", action, state: this.state, reason });
    return { ok: false, state: this.state, reason };
  }
}
