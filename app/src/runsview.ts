// Galactus, the runs view: the surface of a machine nobody is sitting at.
//
// Server mode already serves a model. This is what makes it more than a host:
// a task is declared here, with the budget and the policy it will live under,
// and then it is left alone. Nothing on this screen has to stay open for the
// run to keep going, and nothing about it is lost when the app closes.
//
// The three moving parts are all elsewhere, deliberately:
//
//   runs.ts       decides what a run may do, and records everything it did
//   rundrive.ts   translates the run's gate into the agent's dialog answers
//   runrecord.ts  what survives a restart, and the grant rule around a block
//
// What is left here is the screen and the wiring: build an Agent, hand its
// hooks to the turn, paint the transcript as it grows, and put a real question
// in front of a human when the run stops on something only a human can settle.
//
// Two things this module must never do, both of them for the same reason as
// rundrive's refusal to ever answer "always":
//
//   it never calls Agent.setAutoApprove(true). The run's gate IS the approval,
//   and an agent approving itself would make the policy decorative.
//
//   it never grants an elevated request. It cannot, in fact: rundrive refuses
//   those rather than parking on them, so no human is ever asked, and
//   RunGrants.grant refuses one anyway if the question is ever put to it.

import { api } from "./api";
import { Agent, type PermissionDecision, type PermissionRequest } from "./agent";
import { t } from "./i18n";
import {
  RUN_POLICIES,
  Run,
  isTerminal,
  policyGrants,
  type RunEntry,
  type RunLimits,
  type RunPolicy,
  type RunState,
} from "./runs";
import {
  driveRun,
  type DrivableAgent,
  type DrivePermissionRequest,
  type RunTurnHooks,
} from "./rundrive";
import {
  RunGrants,
  decodeRun,
  encodeRun,
  formatDuration,
  grantAnswer,
  isRunId,
  makeRunId,
  recordEntries,
  refuseAnswer,
  requestBehind,
  transcriptLines,
  type RunRecord,
} from "./runrecord";

// ---------------------------------------------------------------- host

/**
 * What the view needs from the app shell. An interface rather than an import
 * of main.ts, which imports this module: the port and the toast are the two
 * things that only the shell knows, and passing them in keeps the edge going
 * one way.
 */
export interface RunsHost {
  /** The engine port. Read per turn: a model restart changes it. */
  port(): number;
  /** Whether a model is loaded, ready, and able to emit tool calls. */
  ready(): boolean;
  toast(message: string, kind?: "err" | "ok"): void;
}

let host: RunsHost = {
  port: () => 8737,
  ready: () => false,
  toast: () => {},
};

export function configureRuns(h: RunsHost): void {
  host = h;
}

// ---------------------------------------------------------------- state

/**
 * A run as this process holds it: the run itself, the agent driving it, and
 * the three things that only exist while it is alive (the turn's hooks, the
 * text still streaming, and the grants a human handed it).
 */
interface LiveRun {
  run: Run;
  name: string;
  prompt: string;
  created: number;
  updated: number;
  agent: Agent | null;
  /** The hooks of the turn in flight, or null between turns. */
  hooks: RunTurnHooks | null;
  grants: RunGrants;
  /** Assistant text of the turn in flight: the transcript only gets it at the end. */
  streaming: string;
  /** True while driveRun is looping, so a second Start cannot double-drive. */
  driving: boolean;
  /** Whether the card shows its transcript. */
  open: boolean;
  /** Draft of the note a human may attach to an answer, kept across repaints. */
  note: string;
}

const live = new Map<string, LiveRun>();
/** The stored runs have been read once. */
let loaded = false;
let loading = false;
/** The mounted view, so a background event can repaint what is on screen. */
let mounted: HTMLElement | null = null;
/** One debounce timer per run, exactly as store.ts does per conversation. */
const saveTimers = new Map<string, number>();
let tick: number | null = null;

/** The declaration form, kept out of the DOM so a full render never eats it. */
const draft = {
  name: "",
  prompt: "",
  policy: "read_only" as RunPolicy,
  turns: 8,
  minutes: 20,
};

// ---------------------------------------------------------------- prompts

/**
 * What the model is told before the task. It is not decoration: an agent that
 * believes a human is reading will end a turn with a question, and a question
 * nobody answers burns the whole budget one turn at a time.
 */
const UNATTENDED =
  "You are running unattended. Nobody is watching this turn and nobody can answer a question. " +
  "Work with the permissions you are granted; when a step is refused, continue without it or " +
  "stop and state plainly what you needed. Do not ask for confirmation. " +
  "When the task is done, answer with the result itself, not with a plan to produce it.";

function firstPrompt(task: string): string {
  return `${UNATTENDED}\n\nTask:\n${task.trim()}`;
}

/**
 * The nudge for a turn that produced nothing at all. Kept short: it is fed to
 * a model that already has the task in its history, and repeating the task
 * would spend context re-establishing what it never lost.
 */
const CONTINUE = "Continue the task. Answer with the result once it is done.";

// ---------------------------------------------------------------- persistence
//
// Same storage path as conversations (store.ts): one JSON file per run,
// written atomically by conv_save and read back by conv_load, with the writes
// debounced because a streaming turn would otherwise write on every token. The
// id carries the run- prefix, which is what keeps runs out of the conversation
// list; store.refreshList drops them.

function recordOf(run: LiveRun): RunRecord {
  return {
    id: run.run.id,
    name: run.name,
    prompt: run.prompt,
    created: run.created,
    updated: Date.now(),
    snapshot: run.run.snapshot(),
    transcript: run.run.toJsonl(),
  };
}

function persist(run: LiveRun, immediate = false): void {
  const id = run.run.id;
  run.updated = Date.now();
  const write = () => {
    api.convSave(id, encodeRun(recordOf(run))).catch(() => {});
  };
  const pending = saveTimers.get(id);
  if (immediate) {
    if (pending !== undefined) {
      clearTimeout(pending);
      saveTimers.delete(id);
    }
    write();
    return;
  }
  if (pending !== undefined) return;
  saveTimers.set(
    id,
    window.setTimeout(() => {
      saveTimers.delete(id);
      // Re-read the live run rather than a captured snapshot: it kept moving
      // while the timer was armed.
      const fresh = live.get(id);
      if (fresh) api.convSave(id, encodeRun(recordOf(fresh))).catch(() => {});
    }, 1500),
  );
}

/** Flush every pending write now. Called on the same checkpoint as store.flushAll. */
export function flushRuns(): void {
  for (const id of [...saveTimers.keys()]) {
    const timer = saveTimers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    saveTimers.delete(id);
    const run = live.get(id);
    if (run) api.convSave(id, encodeRun(recordOf(run))).catch(() => {});
  }
}

/**
 * Bring the stored runs back.
 *
 * A run restored in `running` is a run whose process died between two turns:
 * nothing is driving it and nothing ever will, exactly the case store.ts's
 * settleInterrupted answers for a tool card that never completed. It is
 * cancelled with a reason rather than left spinning, because a state that says
 * "running" while nothing runs is the one thing a monitoring screen must not
 * show. A turn that died mid flight is already handled by Run.restore, which
 * brings it back failed.
 */
async function loadStored(): Promise<void> {
  if (loaded || loading) return;
  loading = true;
  try {
    const metas = (await api.convList()) as { id?: unknown }[];
    for (const meta of metas) {
      const id = String(meta?.id ?? "");
      if (!id || !isRunId(id) || live.has(id)) continue;
      let record: RunRecord | null = null;
      try {
        record = decodeRun(await api.convLoad(id));
      } catch {
        record = null;
      }
      if (!record) continue;
      const entries = recordEntries(record);
      let run: Run;
      try {
        run = Run.restore(record.snapshot, entries, () => Date.now());
      } catch {
        // A snapshot that disagrees with its own transcript is refused by
        // Run.restore. Skipping it leaves the file untouched and auditable
        // rather than replacing it with something that parses.
        continue;
      }
      if (run.getState() === "running") run.cancel("interrupted: the app closed while it was running");
      const entry: LiveRun = {
        run,
        name: record.name,
        prompt: record.prompt,
        created: record.created,
        updated: record.updated,
        agent: null,
        hooks: null,
        grants: RunGrants.fromTranscript(run.transcript()),
        streaming: "",
        driving: false,
        open: false,
        note: "",
      };
      live.set(id, entry);
      if (run.getState() === "cancelled") persist(entry, true);
    }
    loaded = true;
  } finally {
    loading = false;
    schedulePaint();
  }
}

async function forget(run: LiveRun): Promise<void> {
  const id = run.run.id;
  const timer = saveTimers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  saveTimers.delete(id);
  live.delete(id);
  await api.convDelete(id).catch(() => {});
  schedulePaint();
}

// ---------------------------------------------------------------- the agent

/**
 * The agent of one run, built once and kept for its whole life so turn 4 still
 * remembers turn 1.
 *
 * Every hook lands on the hooks of the turn in flight, which rundrive hands
 * over through `bind`. Between turns there are none, and a callback arriving
 * then is dropped: it belongs to a turn that is already closed, and pushing it
 * into the next one would file work under a turn that did not do it.
 */
async function ensureAgent(run: LiveRun): Promise<Agent> {
  if (run.agent) return run.agent;
  const agent = new Agent(
    {
      onAssistantDelta: (text) => run.hooks?.onDelta(text),
      onAssistantDone: () => {
        /* the turn ends when send() resolves; rundrive owns the outcome */
      },
      onToolStart: (name, detail) => run.hooks?.onTool(name, detail),
      onToolResult: (name, result) => run.hooks?.onToolResult(name, result),
      onPlan: () => {
        /* the plan is a chat surface; a run's record is its transcript */
      },
      onError: (err) => run.hooks?.onError(err),
      onNotice: (text) => run.hooks?.onNotice(text),
      askPermission: (req) => askPermission(run, req),
    },
    host.port(),
    // "sub", not "main", and for two reasons that both come from nobody being
    // there: a main agent notifies the desktop at the end of every turn, which
    // a ten turn run would do ten times, and a main agent may recruit a team
    // into the conversation it belongs to. A run belongs to no conversation.
    "sub",
  );
  // NOT setAutoApprove(true), under any policy. `autonomous` is expressed by
  // the run's gate answering allow, which is recorded; an auto-approving agent
  // would answer before the gate and record nothing.
  agent.setMode("agent");
  run.agent = agent;
  try {
    const [settings, memory, tools, skills, folders] = await Promise.all([
      api.settingsGet(),
      api.memoryRead().catch(() => ""),
      api.mcpTools().catch(() => []),
      api.skillsList().catch(() => []),
      api.kbFolders().catch(() => [] as string[]),
    ]);
    agent.setMemory(settings["memory_on"] !== "0" ? memory : "", !!settings["obsidian_vault"]);
    agent.setMcpTools(tools);
    agent.setSkills(skills);
    agent.setKnowledge(folders.length > 0);
  } catch {
    /* a run still works without memory, connectors or skills */
  }
  return agent;
}

/**
 * The permission hook of a run's agent. It forwards, and decides nothing.
 *
 * Deciding here was the first shape of this and it was wrong. Grants were
 * consulted BEFORE the turn's hook, so a granted request never reached the
 * gate, and the gate is not only the policy: it is also the state check and the
 * record. A cancelled run went on being served, so did one past its wall clock,
 * and neither request appeared in the transcript. Grants now reach rundrive as
 * grants, are consulted only once the gate has answered `block`, and overrule
 * the policy alone.
 */
async function askPermission(run: LiveRun, req: PermissionRequest): Promise<PermissionDecision> {
  const hooks = run.hooks;
  // No turn in flight: nothing owns this request, and there is no run context
  // to charge it to. Deny is the only answer that cannot be wrong.
  if (!hooks) return "deny";
  return hooks.askPermission({
    kind: req.kind,
    detail: req.detail,
    elevated: req.elevated,
    noAlways: req.noAlways,
  });
}

// ---------------------------------------------------------------- driving

function sinkFor(run: LiveRun) {
  return {
    delta: (text: string) => {
      run.streaming += text;
      schedulePaint();
    },
    tool: () => schedulePaint(),
    toolResult: () => {
      persist(run);
      schedulePaint();
    },
    gate: () => {
      persist(run);
      schedulePaint();
    },
    notice: () => schedulePaint(),
  };
}

/**
 * Take turns until the run stops taking them. The stopping conditions belong
 * to driveRun; what belongs here is making sure exactly one loop is running
 * per run, and that whatever happened is on disk before the loop returns.
 */
async function drive(run: LiveRun, prompt: string): Promise<void> {
  if (run.driving) return;
  run.driving = true;
  run.streaming = "";
  schedulePaint();
  try {
    const agent = await ensureAgent(run);
    const drivable: DrivableAgent = {
      send: (text) => agent.send(text),
      stop: () => agent.stop(),
    };
    await driveRun(
      run.run,
      drivable,
      prompt,
      (hooks) => {
        run.hooks = hooks;
        run.streaming = "";
        persist(run);
        schedulePaint();
      },
      (last) => (last.kind === "continue" ? CONTINUE : null),
      sinkFor(run),
      // The grants are read through the live set rather than captured, so a
      // permission granted while the run is looping applies to the next turn
      // without restarting anything.
      { granted: (req) => run.grants.has(req) },
    );
  } catch (err) {
    // driveRun swallows a failing turn into the run's record; anything that
    // escapes it is the wiring itself failing (no model, no port), and the run
    // must say so rather than sit in `running` with nothing running.
    run.run.cancel(err instanceof Error ? err.message : String(err));
  } finally {
    run.hooks = null;
    run.driving = false;
    run.streaming = "";
    persist(run, true);
    announce(run);
    schedulePaint();
  }
}

/**
 * Tell the desktop when a run stops needing the machine and starts needing a
 * person. Skipped when this view is open and the window has focus: the card
 * already says it, and a notification for something on screen is noise.
 */
function announce(run: LiveRun): void {
  if (mounted && mounted.isConnected && document.hasFocus()) return;
  const state = run.run.getState();
  if (state === "blocked") {
    api.notify("Galactus", `${run.name}: ${t("runs.notifyBlocked")}`).catch(() => {});
    return;
  }
  if (!isTerminal(state)) return;
  api.notify("Galactus", `${run.name}: ${t(`runs.state.${state}`)}`).catch(() => {});
}

function startRun(run: LiveRun): void {
  if (!host.ready()) {
    host.toast(t("runs.needModel"));
    return;
  }
  void drive(run, firstPrompt(run.prompt));
}

/**
 * Stop a run. The run records the request; the agent is told separately,
 * because a turn already streaming would otherwise keep going to its natural
 * end before anything noticed.
 */
function cancelRun(run: LiveRun): void {
  run.run.cancel("user");
  run.agent?.stop();
  persist(run, true);
  schedulePaint();
}

/**
 * Every run loses its engine.
 *
 * Called when the model is stopped or replaced, on the same path that stops
 * every conversation's agent (stopAllThreads). A run whose engine went away
 * cannot take another turn, and leaving it in `running` would put the one
 * state this screen must never show on it: moving, with nothing moving it. The
 * agent is dropped as well, so the next start builds one on the port the new
 * engine is actually listening on.
 */
export function stopRuns(reason: string): void {
  for (const run of live.values()) {
    // Only what was actually using the engine. A queued run has not started,
    // and a blocked one is waiting on a human with its clock stopped: neither
    // of them loses anything when the model is replaced, and cancelling them
    // would throw away work nobody asked to throw away.
    if (run.run.getState() !== "running" && !run.driving) continue;
    run.run.cancel(reason);
    run.agent?.stop();
    run.agent = null;
    persist(run, true);
  }
  schedulePaint();
}

/**
 * Answer a parked run.
 *
 * Grant and refuse both resume it: the difference is whether the step it
 * stopped on becomes available. A refusal is not a cancellation, it is the
 * same thing a user pressing Deny does in an attended turn, and the model is
 * told so it can continue without it.
 */
function answerRun(run: LiveRun, grant: boolean): void {
  const question = run.run.pendingQuestion();
  if (question === null) return;
  // Checked BEFORE the run is resumed. Resuming first would move it out of
  // `blocked` and leave it running with no engine to run on, which is exactly
  // the state loadStored refuses to bring back.
  if (!host.ready()) {
    host.toast(t("runs.needModel"));
    return;
  }
  const req = requestBehind(question, run.run.transcript());
  const note = run.note.trim();
  if (!req) {
    // The question is parked but its gate entry cannot be found, which means
    // the transcript and the state disagree. Resuming would hand the model a
    // grant for something nobody can name, so the run is left where it is.
    host.toast(t("runs.untraceable"));
    return;
  }
  const granted = grant && run.grants.grant(req);
  // The note goes on its own line: the first line is the machine readable
  // half, the one RunGrants.fromTranscript reads back after a restart.
  const answer = (granted ? grantAnswer(req) : refuseAnswer(req)) + (note ? `\n${note}` : "");
  const ack = run.run.resume(answer);
  run.note = "";
  if (!ack.ok) {
    host.toast(t("runs.notBlocked"));
    schedulePaint();
    return;
  }
  persist(run, true);
  const prompt = granted
    ? `A human granted ${req.kind}: ${req.detail} for this run. Retry that step and continue.` +
      (note ? `\nThey added: ${note}` : "")
    : `A human refused ${req.kind}: ${req.detail}. Continue without it, or stop and state what you needed.` +
      (note ? `\nThey added: ${note}` : "");
  void drive(run, prompt);
}

function declareRun(): void {
  const task = draft.prompt.trim();
  if (!task) {
    host.toast(t("runs.needTask"));
    return;
  }
  const limits: RunLimits = {
    maxTurns: clampInt(draft.turns, 1, 200),
    maxWallClockMs: clampInt(draft.minutes, 1, 24 * 60) * 60_000,
    policy: draft.policy,
  };
  const now = Date.now();
  const id = makeRunId(now);
  let run: Run;
  try {
    run = Run.create({
      id,
      name: draft.name.trim() || task.replace(/\s+/g, " ").slice(0, 48),
      limits,
      now: () => Date.now(),
    });
  } catch (err) {
    host.toast(String(err instanceof Error ? err.message : err));
    return;
  }
  const entry: LiveRun = {
    run,
    name: run.name,
    prompt: task,
    created: now,
    updated: now,
    agent: null,
    hooks: null,
    grants: new RunGrants(),
    streaming: "",
    driving: false,
    open: true,
    note: "",
  };
  live.set(id, entry);
  persist(entry, true);
  draft.name = "";
  draft.prompt = "";
  paintForm();
  schedulePaint();
  startRun(entry);
}

function clampInt(value: number, min: number, max: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

// ---------------------------------------------------------------- painting

function el(html: string): HTMLElement {
  const box = document.createElement("div");
  box.innerHTML = html.trim();
  return box.firstElementChild as HTMLElement;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

let paintPending = false;

/**
 * Repaint the list on the next frame. A streaming turn calls this once per
 * token, and the coalescing is what keeps a run that writes fast from
 * repainting faster than the screen refreshes.
 */
function schedulePaint(): void {
  if (paintPending) return;
  paintPending = true;
  requestAnimationFrame(() => {
    paintPending = false;
    paintList();
  });
}

/**
 * The clock only moves while something is running, so the second-by-second
 * repaint only exists then. It stops on its own once the view is gone: the
 * runs keep going without it, which is the entire point of the surface.
 */
function ensureTick(): void {
  if (tick !== null) return;
  tick = window.setInterval(() => {
    if (!mounted || !mounted.isConnected) {
      if (tick !== null) clearInterval(tick);
      tick = null;
      return;
    }
    for (const run of live.values()) {
      if (run.run.getState() === "running") {
        paintList();
        return;
      }
    }
  }, 1000);
}

export function runsView(): HTMLElement {
  const wrap = el(`<div class="main">
    <div class="topbar" data-tauri-drag-region><span class="ttl">${esc(t("nav.runs"))}</span><span class="sub">${esc(t("runs.subtitle"))}</span></div>
    <div class="page"><div class="hold">
      <div class="sect"><b>${esc(t("runs.sectNew"))}</b><span>${esc(t("runs.sectNewHint"))}</span></div>
      <div class="card plate" id="runform"></div>
      <div class="sect"><b>${esc(t("runs.sectList"))}</b><span>${esc(t("runs.sectListHint"))}</span></div>
      <div id="runlist"></div>
    </div></div>
  </div>`);
  mounted = wrap;
  paintForm(wrap);
  const list = wrap.querySelector<HTMLElement>("#runlist")!;
  list.replaceWith(listEl());
  void loadStored();
  ensureTick();
  return wrap;
}

// ---- the declaration form ----

function policyCard(policy: RunPolicy): string {
  const grants = policyGrants(policy).join(", ");
  return `<div class="auton ${draft.policy === policy ? "on" : ""}" data-policy="${policy}">
    <div class="r"><span class="rd"></span><b>${esc(t(`runs.policy.${policy}`))}</b></div>
    <div class="d">${esc(t(`runs.policyHint.${policy}`))}</div>
    <div class="d mono runs-grants">${esc(grants)}</div>
  </div>`;
}

/**
 * The form is rebuilt from `draft`, never read back from the DOM at submit
 * time: a full app render (a server event, a mode switch) throws the nodes
 * away, and a value that only lived in an input would go with them.
 */
function paintForm(scope?: HTMLElement): void {
  const box = (scope ?? mounted)?.querySelector<HTMLElement>("#runform");
  if (!box) return;
  box.innerHTML = `
    <div class="runs-field"><small>${esc(t("runs.name"))}</small>
      <div class="inset-input"><input id="rf-name" type="text" placeholder="${esc(t("runs.namePlaceholder"))}" value="${esc(draft.name)}"/></div>
    </div>
    <div class="runs-field"><small>${esc(t("runs.task"))}</small>
      <textarea class="mem" id="rf-task" rows="4" placeholder="${esc(t("runs.taskPlaceholder"))}">${esc(draft.prompt)}</textarea>
    </div>
    <div class="runs-field"><small>${esc(t("runs.policy"))}</small>
      <div class="g3" id="rf-policy">${RUN_POLICIES.map(policyCard).join("")}</div>
    </div>
    <div class="runs-budget">
      <div class="runs-field"><small>${esc(t("runs.turns"))}</small>
        <div class="inset-input"><input id="rf-turns" type="number" min="1" max="200" value="${draft.turns}"/></div>
      </div>
      <div class="runs-field"><small>${esc(t("runs.minutes"))}</small>
        <div class="inset-input"><input id="rf-minutes" type="number" min="1" max="1440" value="${draft.minutes}"/></div>
      </div>
      <span class="runs-budget-hint">${esc(t("runs.budgetHint"))}</span>
      <button class="bp" id="rf-start">${esc(t("runs.start"))}</button>
    </div>`;
  const name = box.querySelector<HTMLInputElement>("#rf-name")!;
  const task = box.querySelector<HTMLTextAreaElement>("#rf-task")!;
  const turns = box.querySelector<HTMLInputElement>("#rf-turns")!;
  const minutes = box.querySelector<HTMLInputElement>("#rf-minutes")!;
  name.addEventListener("input", () => { draft.name = name.value; });
  task.addEventListener("input", () => { draft.prompt = task.value; });
  turns.addEventListener("input", () => { draft.turns = clampInt(Number(turns.value), 1, 200); });
  minutes.addEventListener("input", () => { draft.minutes = clampInt(Number(minutes.value), 1, 1440); });
  box.querySelector<HTMLElement>("#rf-policy")!.addEventListener("click", (e) => {
    const card = (e.target as HTMLElement).closest("[data-policy]") as HTMLElement | null;
    if (!card) return;
    draft.policy = card.dataset.policy as RunPolicy;
    paintForm();
  });
  box.querySelector<HTMLButtonElement>("#rf-start")!.addEventListener("click", () => declareRun());
}

// ---- the list ----

function budgetLine(run: LiveRun): string {
  const budget = run.run.budget();
  const limits = run.run.limits;
  const turns = `${budget.turnsUsed}/${limits.maxTurns} ${t("runs.turnsUnit")}`;
  const clock = `${formatDuration(budget.elapsedMs)} / ${formatDuration(limits.maxWallClockMs)}`;
  return `${turns} · ${clock}`;
}

function stateLabel(state: RunState): string {
  return t(`runs.state.${state}`);
}

/** The last slice of the record: a long run must not paint ten thousand rows. */
const LOG_TAIL = 200;

function logHtml(entries: readonly RunEntry[], streaming: string): string {
  const lines = transcriptLines(entries);
  const shown = lines.slice(-LOG_TAIL);
  const head =
    lines.length > shown.length
      ? `<div class="runs-line"><span class="rl-t">···</span><span class="rl-x">${esc(
          t("runs.logTrimmed").replace("%n", String(lines.length - shown.length)),
        )}</span></div>`
      : "";
  const body = shown
    .map(
      (l) =>
        `<div class="runs-line tone-${l.tone}"><span class="rl-n">${l.seq}</span><span class="rl-t">${esc(l.label)}</span><span class="rl-x">${esc(l.text)}</span></div>`,
    )
    .join("");
  const tail = streaming.trim()
    ? `<div class="runs-line tone-stream"><span class="rl-n"></span><span class="rl-t">···</span><span class="rl-x">${esc(streaming.trim().slice(-1200))}</span></div>`
    : "";
  return head + body + tail;
}

function cardHtml(run: LiveRun): string {
  const state = run.run.getState();
  const question = run.run.pendingQuestion();
  const result = run.run.finalResult();
  const failure = run.run.failure();
  const terminal = isTerminal(state);
  const actions: string[] = [];
  if (state === "queued") actions.push(`<button class="bs" data-act="start">${esc(t("runs.start"))}</button>`);
  if (!terminal) actions.push(`<button class="bs" data-act="cancel">${esc(t("runs.stop"))}</button>`);
  if (terminal) actions.push(`<button class="bs" data-act="delete">${esc(t("runs.delete"))}</button>`);
  const grants = run.grants.size();
  return `<div class="runcard plate${question !== null ? " needs-answer" : ""}" data-run="${esc(run.run.id)}">
    <div class="runs-head">
      <span class="runs-state s-${state}">${esc(stateLabel(state))}</span>
      <b>${esc(run.name)}</b>
      <span class="runs-pol">${esc(t(`runs.policy.${run.run.limits.policy}`))}</span>
      ${grants > 0 ? `<span class="runs-pol runs-granted" title="${esc(t("runs.grantsHint"))}">${esc(t("runs.grantsCount").replace("%n", String(grants)))}</span>` : ""}
      <span class="runs-grow"></span>
      <span class="runs-budget-read mono">${esc(budgetLine(run))}</span>
      ${actions.join("")}
      <button class="bs runs-toggle" data-act="toggle">${esc(run.open ? t("runs.hideLog") : t("runs.showLog"))}</button>
    </div>
    <div class="runs-task">${esc(run.prompt)}</div>
    ${
      question !== null
        ? `<div class="runs-block plate">
             <div class="runs-block-hd"><b>${esc(t("runs.blockedTitle"))}</b><span>${esc(t("runs.blockedHint"))}</span></div>
             <div class="runs-question">${esc(question)}</div>
             <div class="runs-answer">
               <div class="inset-input"><input data-field="note" type="text" placeholder="${esc(t("runs.notePlaceholder"))}" value="${esc(run.note)}"/></div>
               <button class="bp" data-act="grant">${esc(t("runs.grant"))}</button>
               <button class="bd" data-act="refuse">${esc(t("runs.refuse"))}</button>
             </div>
           </div>`
        : ""
    }
    ${result !== null ? `<div class="runs-result"><span class="eyebrow">${esc(t("runs.result"))}</span><div>${esc(result)}</div></div>` : ""}
    ${failure !== null ? `<div class="runs-failure"><span class="eyebrow">${esc(t("runs.failure"))}</span><div>${esc(failure)}</div></div>` : ""}
    ${run.open ? `<div class="runs-log">${logHtml(run.run.transcript(), run.streaming)}</div>` : ""}
  </div>`;
}

function sortedRuns(): LiveRun[] {
  return [...live.values()].sort((a, b) => {
    // Anything still moving sits above anything finished: the screen is read
    // to find out what needs a human, not to browse history.
    const liveA = isTerminal(a.run.getState()) ? 1 : 0;
    const liveB = isTerminal(b.run.getState()) ? 1 : 0;
    if (liveA !== liveB) return liveA - liveB;
    return b.created - a.created;
  });
}

function listEl(): HTMLElement {
  const box = el(`<div class="runlist" id="runlist"></div>`);
  const runs = sortedRuns();
  if (!runs.length) {
    box.appendChild(
      el(`<div class="empty-block"><span class="big">◌</span><b>${esc(
        loaded ? t("runs.empty") : t("runs.loading"),
      )}</b><span>${esc(t("runs.emptyHint"))}</span></div>`),
    );
    return box;
  }
  box.innerHTML = runs.map(cardHtml).join("");
  box.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
    if (!btn) return;
    const card = btn.closest("[data-run]") as HTMLElement | null;
    const run = card ? live.get(card.dataset.run ?? "") : null;
    if (!run) return;
    switch (btn.dataset.act) {
      case "start": startRun(run); break;
      case "cancel": cancelRun(run); break;
      case "delete": void forget(run); break;
      case "grant": answerRun(run, true); break;
      case "refuse": answerRun(run, false); break;
      case "toggle":
        run.open = !run.open;
        paintList();
        break;
    }
  });
  box.addEventListener("input", (e) => {
    const input = e.target as HTMLInputElement;
    if (input.dataset.field !== "note") return;
    const card = input.closest("[data-run]") as HTMLElement | null;
    const run = card ? live.get(card.dataset.run ?? "") : null;
    if (run) run.note = input.value;
  });
  return box;
}

/**
 * Rebuild the list in place.
 *
 * The node is replaced rather than patched, which is how the rest of the app
 * repaints (renderSidebarOnly does the same with the conversation list), so
 * the handlers above are re-bound on every paint by construction. What a
 * replacement costs is the caret: a human typing a note into a blocked run
 * would lose it the moment another run streams a token, so the focused field
 * and its selection are put back.
 */
function paintList(): void {
  if (!mounted || !mounted.isConnected) return;
  const old = mounted.querySelector<HTMLElement>("#runlist");
  if (!old) return;
  const active = document.activeElement as HTMLInputElement | null;
  const focus =
    active && active.dataset && active.dataset.field && old.contains(active)
      ? {
          run: (active.closest("[data-run]") as HTMLElement | null)?.dataset.run ?? "",
          field: active.dataset.field,
          start: active.selectionStart,
          end: active.selectionEnd,
        }
      : null;
  const fresh = listEl();
  old.replaceWith(fresh);
  if (!focus) return;
  const back = fresh.querySelector<HTMLInputElement>(
    `[data-run="${CSS.escape(focus.run)}"] [data-field="${focus.field}"]`,
  );
  if (!back) return;
  back.focus();
  if (focus.start !== null && focus.end !== null) back.setSelectionRange(focus.start, focus.end);
}
