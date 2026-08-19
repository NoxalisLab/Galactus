// Galactus, the bridge between an unattended run and the agent loop.
//
// runs.ts decides what a run may do; agent.ts does the work and asks before
// each step. Neither knows about the other, and this module is the only place
// they meet. It is a separate file for one reason: everything here is the
// translation between a gate that answers three ways and a dialog that answers
// three OTHER ways, and getting that mapping wrong is how an unattended run
// ends up holding something nobody granted it.
//
// The mapping, in full:
//
//   gate allow   -> "once"     the step proceeds, this once
//   gate refuse  -> "deny"     the model is told no and carries on, exactly as
//                              if a human had pressed Deny
//   gate block   -> "deny", then the turn is stopped and the run is parked in
//                   `blocked` with the question recorded. A human can grant it
//                   later; guessing on their behalf is the thing this whole
//                   module exists to avoid.
//
// "always" is never returned, under any policy, for any kind. A standing rule
// written by a run nobody was watching would outlive that run and silently
// pre-approve the SAME action in a later attended session, in a different
// project, for a different user. The run's grant dies with the run.
//
// PURE by construction, like runs.ts: no import of api.ts, no DOM, no clock.
// The agent is taken as an interface with the two methods actually used, so
// the whole bridge can be driven by a fake in a test.

import type { RunPermissionKind, RunPermissionRequest, TurnOutcome } from "./runs.js";
import { Run } from "./runs.js";

/** What a dialog would have answered. Mirrors agent.ts's PermissionDecision. */
export type RunDecision = "once" | "always" | "deny";

/** The part of agent.ts a run needs, and nothing more. */
export interface DrivableAgent {
  send(userText: string): Promise<void>;
  stop(): void;
  /**
   * Tell the agent why the next refusal happened.
   *
   * Optional so the tests can drive a minimal stub, and so a caller that has
   * no better answer than "the user said no" simply does not set one.
   */
  setDenialReason?(reason: string): void;
}

/**
 * The request as agent.ts hands it over. Structurally the same as
 * PermissionRequest minus `diff`, which exists to render a dialog, and there is
 * no dialog here.
 */
export interface DrivePermissionRequest {
  kind: RunPermissionKind;
  detail: string;
  elevated: boolean;
  noAlways?: boolean;
}

/**
 * What a human already granted this run.
 *
 * A block exists so a person can decide, and a decision nobody can act on twice
 * is not much of a decision: without this, granting a permission would park the
 * run again on the very next identical request. So a grant turns a BLOCK into an
 * allow, and nothing else.
 *
 * It is consulted here, after the gate has spoken, and never before it. Placing
 * it in front of the gate is the obvious shortcut and it is wrong three times
 * over: a cancelled run would still be served, a run past its wall clock would
 * too, and neither request would appear in the transcript, because the gate is
 * also what records. A grant may overrule the policy, which is what a human
 * granted. It may not overrule the run's state, which nobody granted.
 */
export interface DriveGrants {
  /** True when a human already granted this exact request for this run. */
  granted(req: DrivePermissionRequest): boolean;
}

/** Where the driver reports what happened, for a UI or for a log. */
export interface DriveSink {
  /** Assistant text, as it streams. */
  delta?(text: string): void;
  /** A tool call about to run, already granted. */
  tool?(name: string, detail: string): void;
  /** Its result. */
  toolResult?(name: string, result: string): void;
  /** A gate answer, whatever it was. */
  gate?(req: DrivePermissionRequest, decision: RunDecision): void;
  /** Something worth showing that is not model output. */
  notice?(text: string): void;
}

/**
 * One turn's worth of mutable state. Held here rather than in the closure so
 * that the outcome is computed from one object with one rule, instead of from
 * three flags read in whatever order the callbacks happened to fire.
 */
interface TurnAccumulator {
  text: string;
  blockedOn: string | null;
  error: string | null;
}

/**
 * The precedence between outcomes, stated once.
 *
 * A turn can end having produced text AND having been blocked AND having
 * errored, because the callbacks are independent and the model keeps streaming
 * for a moment after a stop. Blocked wins: a run that stopped on a decision a
 * human can make must come back to that human, not report a half answer as
 * final. Failure comes next, because an error means the text is not an answer.
 */
function outcomeOf(acc: TurnAccumulator): TurnOutcome {
  if (acc.blockedOn !== null) return { kind: "blocked", question: acc.blockedOn };
  if (acc.error !== null) return { kind: "failed", error: acc.error };
  const text = acc.text.trim();
  if (text) return { kind: "final", text };
  // No text, no error, no block. Something ran and produced nothing, which is
  // not an answer and not a failure either: the run may take another turn.
  return { kind: "continue" };
}

/**
 * The sentence a human sees when a run parks. It carries the kind and the
 * detail because "the run needs permission" is not a question anyone can
 * answer, and the whole point of blocking rather than refusing is that someone
 * CAN answer it.
 */
export function blockQuestion(req: DrivePermissionRequest, reason: "policy" | "every_time"): string {
  const what = `${req.kind}: ${req.detail}`;
  return reason === "every_time"
    ? `${what} is shown every time and cannot be granted in advance. Approve this one?`
    : `${what} is outside this run's policy. Grant it?`;
}

/**
 * The same question in the reader's language.
 *
 * NOT a translation of blockQuestion in place. That string is an IDENTITY: a
 * parked run stores it, and requestBehind() finds the request it came from by
 * comparing text. Translating it would break the match for every run recorded
 * before the change, and again for anyone who switches language while a run is
 * parked. So the stored form stays English and stable, and this reads it back
 * for the screen.
 *
 * Falls back to the stored text for anything it does not recognise, which is
 * what a question written by an older version looks like.
 */
export function blockQuestionText(question: string, translate: (key: string) => string): string {
  const everyTime = " is shown every time and cannot be granted in advance. Approve this one?";
  const policy = " is outside this run's policy. Grant it?";
  if (question.endsWith(everyTime)) {
    return translate("runs.blockEveryTime").replace("%s", question.slice(0, -everyTime.length));
  }
  if (question.endsWith(policy)) {
    return translate("runs.blockPolicy").replace("%s", question.slice(0, -policy.length));
  }
  return question;
}

/**
 * Run one turn of an agent under a run's budget and policy.
 *
 * The agent is built by the caller, because building one needs api.ts and a
 * port and this module has neither. What the caller must do is route its
 * `askPermission` hook to the returned `askPermission`, and its streaming hooks
 * to the returned callbacks, all of which belong to THIS turn.
 */
/** The refusal in words that name the actual cause. */
function refusalText(reason: string | undefined): string {
  switch (reason) {
    case "policy":
      return "refused: outside what this run is allowed to do";
    case "expired":
      return "refused: this run is out of time";
    case "cancelled":
      return "refused: this run was stopped";
    case "out_of_turn":
      return "refused: nothing may be done between turns";
    case "elevated":
      return "refused: this needs a person, and a run has none";
    default:
      return "refused: not allowed here";
  }
}

export async function driveTurn(
  run: Run,
  agent: DrivableAgent,
  prompt: string,
  bind: (turn: RunTurnHooks) => void,
  sink: DriveSink = {},
  grants: DriveGrants | null = null,
): Promise<TurnOutcome | null> {
  // Tool targets seen on the start event, waiting for their outcome.
  const pendingDetail = new Map<string, string>();
  let outcome: TurnOutcome | null = null;
  await run.execute(async (ctx) => {
    const acc: TurnAccumulator = { text: "", blockedOn: null, error: null };
    bind({
      askPermission: async (req) => {
        const gated = ctx.gate(req as RunPermissionRequest);
        if (gated.decision === "allow") {
          sink.gate?.(req, "once");
          return "once";
        }
        if (gated.decision === "block") {
          // A grant turns this one block into an allow. The gate entry above
          // already recorded that the policy said no, and the note below
          // records why it went ahead anyway: an audit that showed "allow"
          // here would hide the human, which is the only interesting part.
          if (!req.elevated && grants?.granted(req)) {
            ctx.note(`granted earlier by a human: ${req.kind}: ${req.detail}`);
            sink.gate?.(req, "once");
            return "once";
          }
          // Park the run on the FIRST thing a human could grant. Recording
          // later ones would only queue questions nobody asked for yet, and the
          // model's next step probably depends on this one anyway.
          if (acc.blockedOn === null) acc.blockedOn = blockQuestion(req, gated.reason);
          // What the model is told. "denied by user" is a lie here: nobody is
          // watching a run, and the model builds its final report on this
          // sentence, which is what a scheduled job then delivers.
          agent.setDenialReason?.(refusalText(gated.reason));
          sink.gate?.(req, "deny");
          agent.stop();
          return "deny";
        }
        agent.setDenialReason?.(refusalText(gated.reason));
        sink.gate?.(req, "deny");
        return "deny";
      },
      onDelta: (text) => {
        acc.text += text;
        sink.delta?.(text);
      },
      onTool: (name, detail) => {
        // Held until the result arrives. The transcript records one line per
        // tool, and the TARGET is on the start event while the OUTCOME is on
        // the end one; writing "" as the detail meant the record said which
        // tool ran and never on what. For anything that does not pass the gate
        // (search_knowledge, retrieve, use_skill) there was then no trace of a
        // target anywhere, which is the one question an audit asks.
        pendingDetail.set(name, detail);
        sink.tool?.(name, detail);
      },
      onToolResult: (name, result) => {
        const detail = pendingDetail.get(name) ?? "";
        pendingDetail.delete(name);
        ctx.tool(name, detail, result);
        sink.toolResult?.(name, result);
      },
      onError: (err) => {
        // First error wins. A failing turn tends to produce several, and the
        // first one is the one that explains the rest.
        if (acc.error === null) acc.error = err;
      },
      onNotice: (text) => {
        ctx.note(text);
        sink.notice?.(text);
      },
    });
    try {
      await agent.send(prompt);
    } catch (err) {
      if (acc.error === null) acc.error = err instanceof Error ? err.message : String(err);
    }
    if (acc.text.trim()) ctx.output(acc.text.trim());
    outcome = outcomeOf(acc);
    return outcome;
  });
  return outcome;
}

/** The hooks a turn owns, handed to the caller to wire into its Agent. */
export interface RunTurnHooks {
  askPermission(req: DrivePermissionRequest): Promise<RunDecision>;
  onDelta(text: string): void;
  onTool(name: string, detail: string): void;
  onToolResult(name: string, result: string): void;
  onError(err: string): void;
  onNotice(text: string): void;
}

/**
 * Take turns until the run stops taking them.
 *
 * The loop is here and not in the caller because the stopping conditions are
 * the run's, not the UI's: a run ends when it answers, when it blocks, when it
 * fails, when a human cancels it, or when it runs out of budget. A caller
 * looping on its own would have to re-derive all five, and would get it wrong
 * the day a sixth is added.
 *
 * `nextPrompt` is asked for the text of each turn after the first, which is
 * what lets a driver feed the model its own last output, a checklist, or a
 * fixed nudge. Returning null ends the run cleanly.
 */
export async function driveRun(
  run: Run,
  agent: DrivableAgent,
  firstPrompt: string,
  bind: (turn: RunTurnHooks) => void,
  nextPrompt: (last: TurnOutcome, turn: number) => string | null,
  sink: DriveSink = {},
  grants: DriveGrants | null = null,
): Promise<void> {
  let prompt: string | null = firstPrompt;
  let turn = 0;
  while (prompt !== null) {
    turn += 1;
    const outcome = await driveTurn(run, agent, prompt, bind, sink, grants);
    // Null means the run refused the turn: out of budget, cancelled, already
    // terminal. The run has recorded why; there is nothing to add here.
    if (outcome === null) return;
    if (outcome.kind !== "continue") return;
    prompt = nextPrompt(outcome, turn);
  }
}
