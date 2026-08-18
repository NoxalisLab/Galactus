import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check as checkForUpdate, type Update } from "@tauri-apps/plugin-updater";
import { api, benchOnce, chatOnce, fetchCtxSize, HwInfo, inlineCodeOnce, InstallVolumes, ModelEntry, onEvent, RelayStatus, ServerStatus, SkillInfo, VolumeInfo } from "./api";
import {
  Agent,
  AgentDirectory,
  clearStandingPermissions,
  configureSampling,
  configureThinking,
  loadStandingPermissions,
  PermissionDecision,
  PermissionRequest,
  setAgentDirectory,
  setCodeWorkspace,
  TeamMember,
} from "./agent";
import * as codeview from "./code";
import { CATALOG, ConnectorPreset, EnabledConnector, loadEnabled, saveEnabled } from "./connectors";
import { getLang, Lang, setLang, t } from "./i18n";
import { PixelMode, PixelViz } from "./pixel";
import { renderMarkdown, wireCodeCopy } from "./markdown";
import { REASONING_TRUNCATED, reasoningGist, visibleReasoning } from "./reasoning";
import { Cosmos } from "./cosmos";
import { detectPreviewable, PreviewKind, PreviewPanel } from "./preview";
import { currentTask, loadTasks, pickModelFor, setCurrentTask, TaskDef, TaskId } from "./tasks";
import { detectTask, getAutoMode, mayAutoSwap, planSwap, setAutoMode, type AutoMode } from "./autotask";
import { exportConversationMarkdown, formatStats, searchConversations, wireDropZone } from "./chatx";
import * as store from "./store";
import type { ChatItem, Conversation, ConvMeta, SubAgent, ThreadData } from "./store";
import { hasVerifiedDownload, modelAvailability, modelCertification } from "./model-policy";
import { clampSampling, readSampling, SAMPLING_DEFAULT, type Sampling } from "./sampling";
import { isFollowing } from "./follow";
import { engineAdvice, isEngineDecodeFailure, modeLabelKey } from "./engine-error";
import { layoutBriefKey, machineBrief, machineSummary } from "./machine-brief";
import * as runsview from "./runsview";
import { learnedView } from "./learnedview";
import { configurePanePreferences, wirePaneResizer } from "./layout/pane-resize";
import {
  applyMention,
  rankCandidates,
  resolveMentions,
  scanMentions,
  type MentionCandidate,
} from "./mentions";
import {
  applyChunk,
  autoCheckAllowed,
  downloadLabel,
  emptyProgress,
  isNewer,
  progressPercent,
  restartVerdict,
  summariseNotes,
  type DownloadProgress,
} from "./update";

const app = document.getElementById("app")!;
const LOGO = "/galactus-mark.svg";

type View = "chat" | "code" | "models" | "connectors" | "runs" | "memory" | "agent" | "learned" | "settings";
type Autonomy = "manual" | "assisted" | "autonomous";

let view: View = "chat";
let root: string | null = null;
let hw: HwInfo | null = null;
let registry: ModelEntry[] = [];
let server: ServerStatus = { running: false, port: 8737, phase: "stopped" };
let enabled: EnabledConnector[] = [];
let mcpCount = 0;
let autonomy: Autonomy = "assisted";
let ramMode: "eco" | "balanced" | "perf" = "balanced";
let autoTabOn = true;
let skillsOff: Set<string> = new Set();
let serverFail: {
  kind: "failed" | "timeout";
  code?: number;
  log: string;
  /** The engine's own verdict on the log: memory | context | unknown. */
  cause?: string;
} | null = null;
/**
 * True when the running model was MEASURED unable to emit tool calls.
 *
 * Deliberately false while the verdict is unknown: the probe runs just after
 * the server announces ready, and blocking the Code view during that second
 * would make every start look broken. The window is short, and the cost of
 * being wrong for one second is a single tool call that returns nothing,
 * against a view that flickers shut on every launch.
 */
/**
 * Ready-to-paste configuration for the clients people actually use.
 *
 * Showing a base URL and stopping there looks complete and is not: every one
 * of these tools wants the same three values under a different key, in a
 * different file, and getting one of them wrong fails silently with an empty
 * completion. The snippets are generated from the live relay state, so the
 * host and port are the ones that are actually listening rather than an
 * example the reader has to adapt.
 *
 * The key is included verbatim. It is a secret, and it is on screen, which is
 * the same trade the key line above already makes: a configuration the user
 * has to reassemble by hand is a configuration they get wrong.
 */
function connectionSnippets(base: string, key: string, model: string): { name: string; body: string }[] {
  const k = key || "YOUR_KEY";
  return [
    {
      name: "curl",
      body: `curl ${base}/chat/completions \\\n  -H "Authorization: Bearer ${k}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${model}","messages":[{"role":"user","content":"hello"}]}'`,
    },
    {
      name: "Cursor, Continue, any OpenAI client",
      body: `Base URL   ${base}\nAPI key    ${k}\nModel      ${model}`,
    },
    {
      name: "Zed (settings.json)",
      body: `"language_models": {\n  "openai": {\n    "api_url": "${base}",\n    "available_models": [{ "name": "${model}", "max_tokens": 8192 }]\n  }\n}`,
    },
    {
      name: "Obsidian, Python, Node (OpenAI SDK)",
      body: `OPENAI_BASE_URL=${base}\nOPENAI_API_KEY=${k}`,
    },
  ];
}

function toolsBlocked(): boolean {
  return server.running && server.phase === "ready" && server.tools_ok === false;
}

/**
 * Assistant or server.
 *
 * Server mode is not a different app, it is the same one with the assistant
 * surfaces taken away: the model, the settings, the measurements and the API
 * stay; the chat, the workspace, the memory and the agent go. Someone running
 * Galactus to serve a model to their editor has no use for a conversation
 * pane, and every surface that reads files is one more thing to reason about
 * on a machine that is now listening on the network.
 */
type AppMode = "app" | "server";
let appMode: AppMode = "app";
/**
 * Whether the launch screen still owes the user a choice.
 *
 * The mode existed before this and could only be reached through one row of
 * the settings page, in the network section, which is to say it could not be
 * reached: someone who starts Galactus to serve a model to their editor had to
 * first open the assistant, find a setting they did not know existed, and
 * switch. A mode that decides which half of the app exists is a launch
 * question, so it is asked at launch.
 */
let modePending = false;
/** Ask again on every start, for someone who alternates. Off by default. */
let modeAskAlways = false;
/**
 * The only views that survive server mode.
 *
 * Runs is here rather than beside the assistant surfaces because it is the
 * reason server mode is more than a model host: a machine serving a model with
 * nobody in front of it can still be given a task and left alone. It stays
 * available in assistant mode too, like the other three.
 */
const SERVER_MODE_VIEWS: View[] = ["models", "connectors", "runs", "settings"];

/**
 * Put Galactus in the menu bar, or take it out.
 *
 * Server mode runs scheduled jobs, and the agent loop that runs them lives in
 * this webview: destroying the window would destroy the loop, so the red
 * button hides the window instead (see on_window_event in lib.rs). An app that
 * is working with no window and no icon anywhere is an app people force quit,
 * so server mode also gets a menu bar item, which is the one place that both
 * says "still here" and offers the action that genuinely stops the work.
 */
function syncTray(): void {
  api.traySet(appMode === "server").catch(() => {});
}

/** Port the relay listens on. Distinct from the engine's, which stays local. */
const RELAY_PORT = 8788;
let relay: RelayStatus = { running: false, bind: "", port: 0, keyed: false };
let relayBind: "127.0.0.1" | "0.0.0.0" = "127.0.0.1";
/**
 * The freshly minted key, held in memory for exactly as long as the settings
 * screen shows it. The app never writes it to disk: a key at rest in a plain
 * settings file is a key in every backup and every sync folder.
 */
let relayKey = "";
let relayLanAddress = "";
/** Which address to print in the connection line. */
function relayHost(): string {
  return relay.bind === "0.0.0.0" ? relayLanAddress || "0.0.0.0" : "127.0.0.1";
}

const installProgress = new Map<string, { pct: number; label: string }>();
/** Real measured throughput per model id (persisted in settings as bench_<id>). */
const benchResults: Record<string, number> = {};

// ---------- new-feature state ----------
let previewPanel: PreviewPanel | null = null; // chat-side preview (destroyed on every render)
let tasks: TaskDef[] = [];
let taskId: TaskId = currentTask();
let taskOffer: { modelId: string; modelName: string } | null = null;
let dropUnsub: (() => void) | null = null; // drag&drop unsubscribe, per chat view
let shellResizeCleanup: (() => void) | null = null;
let convQuery = "";
/** Skills cache for the slash-command autocomplete. */
let slashSkills: SkillInfo[] = [];
/** One-shot: the next message goes through the sourced-research workflow. */
let deepResearch = false;
/** Dictation state: text present in the input before dictation started. */
let dictating = false;
let dictBase = "";
/** Read-aloud state, global on purpose: the DOM is rebuilt on every repaint. */
let ttsPlaying = false;
/** Live header metrics: engine RSS + generation speed. */
let liveRss = 0;
let liveTps: number | null = null;
/** When the current model load started (null when not loading). */
let loadStartMs: number | null = null;

// ---------- live threads (a conversation and its team) ----------
//
// A conversation is a small tree: the user's thread, plus the persistent
// thread of every sub-agent it owns. Each one runs on its own Agent, with its
// own history, plan, queue and activity scene. Everything that used to be a
// module-level singleton (`agent`, `generating`, `queuedMsgs`, `genStats`,
// the activity scene) lives in a Thread record, so a teammate working in the
// background never touches the state of the thread on screen.
//
// Two bounds, both real, never a UI convention:
//  - concurrent TURNS are capped by the engine's decode slots (llama-server
//    --parallel, reported in server.slots). A turn beyond that waits for a
//    slot instead of piling requests the server would serialize anyway.
//  - the TEAM is capped by store.teamLimit(), and idle conversations are
//    released from memory past MAX_LIVE_CONVS.

interface Thread {
  /**
   * Set by Stop on a turn that has not reached the model yet.
   *
   * A turn waiting for an engine slot has no agent: `stopThread` called
   * `sess.agent?.stop()` on null, changed nothing, and reported nothing, so the
   * stop looked accepted and the turn started generating the moment a slot
   * freed. Cleared when a turn begins, so it can never cancel a later one.
   */
  cancelPending?: boolean;
  /** conv.id for a conversation's own thread, "convId#subId" for a teammate. */
  key: string;
  conv: Conversation;
  /** The thread's own data: the conversation itself, or the sub-agent. */
  data: ThreadData;
  /** null for the conversation's own thread. */
  sub: SubAgent | null;
  agent: Agent | null;
  generating: boolean;
  /** Messages typed while the model is writing: shown at once, sent next turn. */
  queued: string[];
  /** Streamed chars / elapsed time for the running turn (~4 chars per token). */
  genStats: { chars: number; startMs: number; endMs: number | null } | null;
  /** Last non-done activity, so a repaint can restore the scene. */
  activity: { mode: PixelMode; label?: string } | null;
  /** Agents blocked on this thread's current turn (ask_agent). */
  waiters: ((answer: string) => void)[];
  /** True while this thread holds one of the engine's decode slots. */
  holdsSlot: boolean;
  touched: number;
}

const threads = new Map<string, Thread>();
const MAX_LIVE_CONVS = 8;

function threadKey(convId: string, subId?: string | null): string {
  return subId ? `${convId}#${subId}` : convId;
}

function threadOf(conv: Conversation, sub: SubAgent | null = null): Thread {
  const key = threadKey(conv.id, sub?.id);
  let th = threads.get(key);
  if (!th) {
    th = {
      key,
      conv,
      data: sub ?? conv,
      sub,
      agent: null,
      generating: false,
      queued: [],
      genStats: null,
      activity: null,
      waiters: [],
      holdsSlot: false,
      touched: Date.now(),
    };
    threads.set(key, th);
  } else {
    // store.open() hands back the same object for a live conversation, but a
    // reopened one is a fresh object: keep the thread pointing at the truth.
    th.conv = conv;
    if (sub) {
      th.sub = sub;
      th.data = sub;
    } else {
      th.data = conv;
    }
  }
  th.touched = Date.now();
  return th;
}

/** The sub-agent thread the chat view is focused on, if any. */
let focusAgent: string | null = null;

function focusedSub(): SubAgent | null {
  if (!focusAgent) return null;
  return store.findSubAgent(store.current(), focusAgent) ?? null;
}

/** The thread the chat view is showing: the conversation, or a teammate of it. */
function active(): Thread {
  const conv = store.current();
  const sub = focusedSub();
  if (focusAgent && !sub) focusAgent = null; // the teammate is gone
  return threadOf(conv, sub);
}

/** Every live thread of one conversation: its own, then its team. */
function convThreads(conv: Conversation): Thread[] {
  const out: Thread[] = [];
  const own = threads.get(threadKey(conv.id));
  if (own) out.push(own);
  for (const sub of conv.team) {
    const th = threads.get(threadKey(conv.id, sub.id));
    if (th) out.push(th);
  }
  return out;
}

/** Teammates of a conversation, materialized so their state is addressable. */
function teamThreads(conv: Conversation): Thread[] {
  return conv.team.map((sub) => threadOf(conv, sub));
}

function busyIn(conv: Conversation): number {
  return convThreads(conv).filter((th) => th.generating).length;
}

/**
 * Drop the least recently touched IDLE conversation past the cap, with its
 * whole team. The file on disk stays, so opening it again reloads everything.
 */
function pruneConversations(): void {
  const activeId = store.current().id;
  const ids = new Set([...threads.values()].map((th) => th.conv.id));
  while (ids.size > MAX_LIVE_CONVS) {
    let victimId: string | null = null;
    let oldest = Infinity;
    for (const id of ids) {
      if (id === activeId) continue;
      const group = convThreads(store.get(id) ?? ({ id, team: [] } as unknown as Conversation));
      if (group.some((th) => th.generating || th.waiters.length > 0)) continue;
      const t = Math.max(...group.map((th) => th.touched), 0);
      if (t < oldest) { oldest = t; victimId = id; }
    }
    if (!victimId) return; // everything is busy: the cap yields, memory is bounded by the slots
    cancelPermissionsOfConv(victimId);
    for (const th of [...threads.values()]) {
      if (th.conv.id !== victimId) continue;
      th.agent?.stop();
      threads.delete(th.key);
    }
    store.release(victimId);
    ids.delete(victimId);
  }
}

// ---------- engine decode slots ----------

/** Slots the running engine serves; 1 until the backend says otherwise. */
function engineSlots(): number {
  const n = Number(server.slots);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

let slotsInUse = 0;
const slotWaiters: (() => void)[] = [];

function acquireSlot(): Promise<void> {
  if (slotsInUse < engineSlots()) {
    slotsInUse++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    slotWaiters.push(() => {
      slotsInUse++;
      resolve();
    });
  });
}

function releaseSlot(): void {
  slotsInUse = Math.max(0, slotsInUse - 1);
  const next = slotWaiters.shift();
  if (next) next();
}

function loadElapsedText(): string {
  if (!loadStartMs) return "";
  const s = Math.floor((Date.now() - loadStartMs) / 1000);
  const txt = s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s` : `${s} s`;
  return t("load.elapsed").replace("%s", txt);
}

function loadingCard(): HTMLElement {
  const m = registry.find((r) => r.id === server.model_id);
  return el(`<div class="loadcard">
    <img class="spin" src="${LOGO}" alt=""/>
    <div class="lt">
      <b>${esc(t("load.title").replace("%m", m?.name ?? "…"))}<span class="dots"></span></b>
      <span class="el" id="loadelapsed">${esc(loadElapsedText())}</span>
      <span class="hint">${esc(t("load.hint"))}</span>
    </div>
  </div>`);
}

function paintLive(): void {
  const box = document.getElementById("livebar");
  if (!box) return;
  const parts: string[] = [];
  if (server.running && liveRss > 0) {
    parts.push(
      `<span class="lv" title="${esc(t("live.ram"))}"><span class="k">RAM</span><b>${(liveRss / 1e9).toFixed(1)} Go</b></span>`
    );
  }
  const sess = active();
  const gs = sess.genStats;
  const tps =
    sess.generating && gs && gs.chars > 40
      ? gs.chars / 4 / Math.max((Date.now() - gs.startMs) / 1000, 0.25)
      : liveTps;
  if (tps && Number.isFinite(tps) && tps > 0) {
    parts.push(
      `<span class="lv ${sess.generating ? "hot" : ""}" title="${esc(t("live.tps"))}"><span class="k">tok/s</span><b>${tps.toFixed(1)}</b></span>`
    );
  }
  // How many threads have a turn in flight. NOT shown as "n / slots": a
  // teammate blocked inside ask_agent is in flight without decoding, so the
  // count legitimately exceeds the slot count and "3/2" would read as a bug.
  const busy = [...threads.values()].filter((th) => th.generating).length;
  if (busy > 1) {
    parts.push(
      `<span class="lv hot" title="${esc(t("live.threadsHint").replace("%n", String(engineSlots())))}"><span class="k">${esc(t("live.threads"))}</span><b>${busy}</b></span>`
    );
  }
  box.innerHTML = parts.join("");
}

// ---------- agent activity bar (PixelViz) ----------
//
// The scene itself is per-thread (Thread.activity): a teammate working in the
// background keeps its own state and gets its scene back untouched when the
// user opens it. Only ONE canvas exists, the one of the thread on screen; the
// others advertise themselves through their block and the sidebar dot.
let pixel: PixelViz | null = null;
let pixelHost: HTMLElement | null = null;
/** Pending "done" confetti hide; a queued turn reuses the same PixelViz. */
let doneHideTimer: number | null = null;

/**
 * Retour au repos : l'atelier reste, le personnage s'y remet a errer.
 *
 * Il vivait le temps d'une reponse puis disparaissait, et son atelier avec
 * lui. Un lieu qui n'existe que pendant le travail n'est pas un lieu ; c'est
 * un indicateur de chargement deguise. La scene est donc permanente et seul
 * le mode change, ce qui rend aussi la reprise instantanee : plus de canvas a
 * recreer au premier jeton.
 */
function idleActivity(): void {
  const bar = document.getElementById("actbar");
  const host = document.getElementById("pixelhost");
  if (!bar || !host) return;
  if (pixel && pixelHost !== host) { pixel.destroy(); pixel = null; pixelHost = null; }
  if (!pixel) { pixel = new PixelViz(host); pixelHost = host; }
  bar.style.visibility = "visible";
  pixel.setMode("idle");
}

/** Retire vraiment la scene : changement de fil, ou vue demontee. */
function hideActivity() {
  const bar = document.getElementById("actbar");
  if (bar) bar.style.visibility = "hidden";
  pixel?.destroy();
  pixel = null;
  pixelHost = null;
}

/**
 * Record an activity for one session, and paint it when that session is the
 * one on screen. A background thread never steals the visible scene.
 */
function onThreadActivity(sess: Thread, mode: PixelMode, label?: string) {
  const visible = sess.key === active().key;
  if (mode === "done") {
    // Laisser les confettis jouer avant de ranger la scene; une nouvelle
    // activite (message en file) recree simplement un PixelViz.
    sess.activity = null;
    if (!visible) return;
    if (pixel) {
      pixel.setMode("done");
      const px = pixel;
      if (doneHideTimer !== null) clearTimeout(doneHideTimer);
      doneHideTimer = window.setTimeout(() => {
        doneHideTimer = null;
        if (pixel === px) idleActivity();
      }, 2600);
    } else {
      idleActivity();
    }
    return;
  }
  if (mode === "thinking" && !label) label = t("px.thinking");
  if (!sess.generating) {
    sess.activity = null;
    if (visible) idleActivity();
    return;
  }
  sess.activity = { mode, label };
  if (!visible) return;
  // A "done" hide armed by the previous turn must not fire during the NEXT
  // queued turn and blank the bar mid-activity.
  if (doneHideTimer !== null) { clearTimeout(doneHideTimer); doneHideTimer = null; }
  const bar = document.getElementById("actbar");
  const host = document.getElementById("pixelhost");
  if (!bar || !host) return;
  if (pixel && pixelHost !== host) { pixel.destroy(); pixel = null; pixelHost = null; }
  if (!pixel) { pixel = new PixelViz(host); pixelHost = host; }
  bar.style.visibility = "visible";
  pixel.setMode(mode, label ? prettyTool(label) : undefined);
}

/** Repaint the visible thread's scene after a DOM rebuild or a thread switch. */
function restoreActivity(): void {
  const sess = active();
  if (sess.generating && sess.activity) onThreadActivity(sess, sess.activity.mode, sess.activity.label);
  else idleActivity();
}

// ---------- svg icons ----------
const I = {
  chat: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 21l1.9-5A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z"/></svg>`,
  code: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m8 17-5-5 5-5"/><path d="m16 7 5 5-5 5"/><path d="M13.5 4.5 10.5 19.5"/></svg>`,
  models: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 3 7l9 5 9-5-9-5z"/><path d="M3 12l9 5 9-5"/><path d="M3 17l9 5 9-5"/></svg>`,
  conn: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17H7a5 5 0 0 1 0-10h2"/><path d="M15 7h2a5 5 0 0 1 0 10h-2"/><path d="M8 12h8"/></svg>`,
  mem: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4a4 4 0 0 0-4 4 3.5 3.5 0 0 0-1 6.8V17a3 3 0 0 0 5 2.2A3 3 0 0 0 17 17v-2.2A3.5 3.5 0 0 0 16 8a4 4 0 0 0-4-4z"/></svg>`,
  agent: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3"/><rect x="5" y="6" width="14" height="11" rx="3"/><path d="M9 11h.01M15 11h.01"/><path d="M9 14h6"/><path d="M5 12H3M21 12h-2"/></svg>`,
  runs: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h9M4 12h9M4 19h6"/><path d="M17 15v6l5-3z"/></svg>`,
  set: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.5 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 1.1-2.7H1.7a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 7.5a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V1.7a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-1.1 2.7h.1a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.1z"/></svg>`,
  plus: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
  up: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`,
  file: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`,
  term: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></svg>`,
  folder: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8a7cff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
  chip: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/></svg>`,
  scope: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/><path d="M11 8v6M8 11h6"/></svg>`,
  mic: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3.5"/></svg>`,
};

// ---------- toast (alert() is unreliable inside WKWebView) ----------
function toast(msg: string, kind: "err" | "ok" = "err") {
  let host = document.getElementById("toasts");
  if (!host) {
    host = document.createElement("div");
    host.className = "toasts";
    host.id = "toasts";
    document.body.appendChild(host);
  }
  const item = document.createElement("div");
  item.className = `toast ${kind}`;
  item.textContent = msg;
  host.appendChild(item);
  setTimeout(() => {
    item.classList.add("out");
    setTimeout(() => item.remove(), 300);
  }, 5000);
}

// ---------- helpers ----------
function el(html: string): HTMLElement {
  const d = document.createElement("div");
  d.innerHTML = html.trim();
  return d.firstElementChild as HTMLElement;
}
function esc(s: string): string {
  // Quotes matter too: esc() output lands inside HTML attributes (title, data-*).
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function fmtGb(b?: number): string { return b ? (b / 1e9).toFixed(0) + " GB" : "?"; }

function expectedTps(m: ModelEntry): number | null {
  if (!hw || !m.measured || !m.measured.length) return null;
  // Same ceiling as plan_cache: weights, then the measured runtime overhead
  // (KV cache, compute buffers, graph, which tracks the non-expert weights),
  // then a reserve so the machine can still run macOS. A flat constant used to
  // stand for the middle term and understated it, so the shown estimate
  // assumed a cache the engine would never get.
  //
  // Installed RAM on purpose, NOT the live free memory. This is plan_cache's
  // HARDWARE ceiling, the one the three modes are defined against: an estimate
  // that moved every time the user opened a browser tab would describe the
  // weather rather than the model. What a machine under pressure changes is
  // which mode the planner starts in, and that is announced separately.
  const nonExpert = (m.non_expert_bytes ?? 5e9) / 1e9;
  // Keep the UI estimate identical to Rust: 2 GB through 32 GB, then 6.25%
  // of unified memory on larger Macs.
  const systemReserve = Math.max(2, hw.ram_gb / 16);
  // Everything the engine pays before a single expert byte is cached, INCLUDING
  // the KV cache of every decode slot past the first (0.8 GB each, measured).
  // Rust pays it too; an estimate that skipped it would promise a cache 0.8 GB
  // larger than a default two-slot start actually gets.
  const fixed = nonExpert + (2.5 + nonExpert * 0.45) + (engineSlots() - 1) * 0.8;
  // The 70 percent cap bounds the TOTAL, exactly as engine_budget_bytes does.
  // It used to bound this arena alone, with `fixed` added on top, so the
  // estimate assumed a cache 5 GB larger than any start would ever plan and
  // promised a throughput the engine could not reach. Same defect as the one
  // fixed in plan_cache, and it had been copied here.
  //
  // The GPU working set is the third bound, and it belongs in the HARDWARE
  // ceiling rather than the live one: recommendedMaxWorkingSetSize is a
  // property of the device, not of the moment, so it does not make the
  // estimate move when a browser tab opens. Without it, a Mac whose GPU
  // limit sits below 70 percent of its memory would read an estimate for a
  // cache no start on that machine can ever plan.
  const workingSet = hw.gpu_working_set_bytes;
  const budget = Math.min(
    hw.ram_gb - systemReserve,
    hw.ram_gb * 0.7,
    workingSet === null ? Infinity : workingSet / 1e9,
  );
  const maxCache = Math.min(budget - fixed, (m.expert_bytes_total ?? Infinity) / 1e9);
  const pts = [...m.measured].sort((a, b) => a.cache_gb - b.cache_gb);
  // Mirror the backend's memory-footprint policy so the shown estimate
  // matches what a start would actually plan.
  let cache = maxCache;
  if (ramMode === "eco") {
    cache = Math.min(pts[0].cache_gb, maxCache);
  } else if (ramMode === "balanced" && !(m.expert_bytes_total && maxCache >= m.expert_bytes_total / 1e9)) {
    // Balanced takes full residency whenever the ceiling already reaches every
    // routed expert byte (the condition negated above), because a resident
    // cache stops evicting and the micro-batch becomes 512 instead of a
    // handful of tokens. Only a machine that cannot hold the experts stops at
    // the knee: smallest measured cache reaching 90% of the best generation
    // throughput reachable here.
    const reachable = Math.max(...pts.filter((p) => p.cache_gb <= maxCache).map((p) => p.gen_tps), pts[0].gen_tps);
    const knee = pts.find((p) => p.gen_tps >= 0.9 * reachable);
    cache = Math.min(knee ? knee.cache_gb : maxCache, maxCache);
  }
  if (cache <= pts[0].cache_gb) return pts[0].gen_tps;
  const last = pts[pts.length - 1];
  if (cache >= last.cache_gb) return last.gen_tps;
  for (let i = 0; i + 1 < pts.length; i++)
    if (cache >= pts[i].cache_gb && cache <= pts[i + 1].cache_gb) {
      const f = (cache - pts[i].cache_gb) / (pts[i + 1].cache_gb - pts[i].cache_gb);
      return pts[i].gen_tps + f * (pts[i + 1].gen_tps - pts[i].gen_tps);
    }
  return last.gen_tps;
}
function verdict(m: ModelEntry): { ok: boolean; note: string } {
  const availability = modelAvailability(m.status, m.min_ram_gb, hw?.ram_gb);
  if (!availability.canExecute) {
    return {
      ok: false,
      note:
        availability.reason === "hardware"
          ? t("models.tooSmall")
          : t(availability.badge === "pending" ? "models.certPendingNote" : "models.certBlockedNote"),
    };
  }
  if (!hw) return { ok: false, note: t("models.tooSmall") };
  if (m.native_fit_ram_gb && hw.ram_gb >= m.native_fit_ram_gb && !m.runs_nowhere_natively)
    return { ok: true, note: t("models.nativeFit") };
  return { ok: true, note: "" };
}

function engineModeLabel(mode?: string): string {
  if (mode === "resident-bit-exact") return t("engine.resident");
  if (mode === "streamed-bit-exact") return t("engine.streamed");
  if (mode === "cpu-bit-exact") return t("engine.cpu");
  return "";
}

/** Autonomy is a global preference: every live agent follows it. */
function applyAutonomy() {
  for (const th of threads.values()) {
    // A teammate always works in agent mode: it was recruited to carry a task
    // to the end, not to chat. Only the conversation's own agent follows the
    // Manual / Assisted / Autonomous switch.
    // A model with no tool calls is forced to plain chat whatever the selector
    // says: leaving it in agent mode would ship tool definitions the model
    // ignores, burning context to no effect and producing an assistant that
    // announces actions it never takes.
    const chatOnly = autonomy === "manual" || toolsBlocked();
    th.agent?.setMode(chatOnly && !th.sub ? "chat" : "agent");
    th.agent?.setAutoApprove(autonomy === "autonomous");
  }
}

const AUTONOMY_ORDER: Autonomy[] = ["manual", "assisted", "autonomous"];

/**
 * Switch autonomy WITHOUT rebuilding the view: a full render would wipe the
 * draft typed in the composer. Only the segment buttons repaint.
 */
async function setAutonomy(a: Autonomy): Promise<void> {
  autonomy = a;
  applyAutonomy();
  document
    .querySelectorAll<HTMLElement>("#modeseg [data-a]")
    .forEach((b) => b.classList.toggle("on", b.dataset.a === a));
  await api.settingsSet("autonomy", a);
}

function cycleAutonomy(): void {
  const next = AUTONOMY_ORDER[(AUTONOMY_ORDER.indexOf(autonomy) + 1) % AUTONOMY_ORDER.length];
  void setAutonomy(next);
}

/**
 * Purging the queue must also remove the user bubbles submitChat pushed 1:1
 * when the messages were queued: the model never received them, and a
 * transcript keeping them would show an exchange that never happened.
 * Matched from the tail because streaming can interleave assistant items
 * after a queued bubble.
 */
function dropQueuedBubbles(sess: Thread): void {
  if (!sess.queued.length) return;
  const items = sess.data.items;
  for (let q = sess.queued.length - 1; q >= 0; q--) {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "user" && it.text === sess.queued[q]) {
        items.splice(i, 1);
        break;
      }
    }
  }
  sess.queued = [];
}

/**
 * Checkpoint one thread: persist what the model context really holds, or
 * reopening it would replay a history missing the last exchange (the
 * transcript and the context would diverge permanently).
 */
function checkpoint(sess: Thread): void {
  if (sess.generating && sess.agent) {
    store.syncHistory(sess, sess.agent.history(), sess.agent.summary());
    store.trimEmptyTail(sess);
  }
  store.save(sess.conv, true);
}

/** Checkpoint a conversation and every teammate thread it owns. */
function checkpointConv(conv: Conversation): void {
  for (const th of convThreads(conv)) checkpoint(th);
}

/**
 * Stop EVERY live agent and reset every thread. Only for events that take the
 * engine away (model stop, model swap): a thread switch must never do this.
 */
function stopAllThreads(): void {
  // Every agent is going away: a dialog left open would answer for nobody, and
  // the gate waiting on it would hold its turn open forever.
  cancelPermissions(() => true);
  // Unattended runs drive their own agents on the same engine, and nobody is
  // watching them: a run left in `running` after its engine went away would
  // sit there claiming to work until someone opened the view.
  runsview.stopRuns(t("runs.engineGone"));
  for (const th of threads.values()) {
    checkpoint(th);
    th.agent?.stop();
    th.agent = null;
    th.generating = false;
    dropQueuedBubbles(th);
    th.genStats = null;
    th.activity = null;
    for (const w of th.waiters.splice(0)) w(`error: ${t("agent.engineStopped")}`);
    if (th.holdsSlot) { th.holdsSlot = false; releaseSlot(); }
  }
  hideActivity();
}

/**
 * Stop ONE thread. Stopping must also cancel whatever that thread is asking
 * the user, or a turn parked on a permission dialog would keep its decode slot
 * and never finish: the gate awaits a promise only the dialog can settle, and
 * the abort flag alone never reaches it.
 */
function stopThread(sess: Thread): void {
  // Before the agent exists there is nothing to stop, and that used to mean the
  // press did nothing at all: the mark is what the queued turn reads when its
  // slot arrives.
  if (!sess.agent && sess.generating) sess.cancelPending = true;
  sess.agent?.stop();
  cancelPermissions((k) => k === sess.key);
}

/**
 * Switch the view to another conversation. The one being left keeps working:
 * its agent, its team, their queues and their scenes are untouched, only the
 * painting moves.
 */
function switchTo(conv: Conversation, agentId: string | null = null): void {
  focusAgent = agentId;
  threadOf(conv);
  teamThreads(conv); // materialize the team so its state is addressable
  pruneConversations();
  // The Code view carries the same thread pane: opening another conversation
  // from it must not throw the user out of the workspace they are reading.
  if (view !== "code") view = "chat";
  render();
}

/** Open a teammate's own thread inside the conversation on screen. */
function openTeamThread(agentId: string | null): void {
  checkpoint(active());
  focusAgent = agentId;
  if (view !== "code") view = "chat";
  render();
}

function newChat() {
  checkpointConv(store.current());
  switchTo(store.startNew());
}

async function openConversation(id: string) {
  checkpointConv(store.current());
  const conv = await store.open(id);
  if (!conv) return;
  switchTo(conv);
}

// ---------- tasks (persona + preferred-model routing) ----------
function installedIds(): string[] {
  return registry.filter((m) => m.installed).map((m) => m.id);
}

/** Load task_personas/task_models from the raw registry file (with fallbacks). */
async function loadTaskDefs(): Promise<void> {
  if (!root) { tasks = loadTasks(null); return; }
  try {
    tasks = loadTasks(await api.fsRead(root + "/scripts/models-registry.json", 500_000));
  } catch {
    tasks = loadTasks(null);
  }
}

function applyTaskPersona(): void {
  const td = tasks.find((x) => x.id === taskId);
  // The persona belongs to the user's own thread; a teammate has its brief.
  if (td) for (const th of threads.values()) if (!th.sub) th.agent?.setTaskSystem(td.system, td.temp);
}

function taskDot(td: TaskDef): string {
  const runningId = server.model_id ?? null;
  if (runningId && td.models.includes(runningId)) return "ok";
  const pick = pickModelFor(td, installedIds(), runningId);
  if (pick.modelId && pick.needsSwitch) return "swap";
  return pick.modelId ? "ok" : "off";
}

function selectTask(id: TaskId): void {
  taskId = id;
  setCurrentTask(id);
  applyTaskPersona();
  taskOffer = null;
  const td = tasks.find((x) => x.id === id);
  if (td) {
    // Never switch models silently: a pack reload is expensive. Offer it.
    const pick = pickModelFor(td, installedIds(), server.model_id ?? null);
    if (pick.needsSwitch && pick.modelId) {
      const m = registry.find((r) => r.id === pick.modelId);
      taskOffer = { modelId: pick.modelId, modelName: m?.name ?? pick.modelId };
    }
  }
  render();
}

async function acceptTaskSwitch(): Promise<void> {
  const offer = taskOffer;
  taskOffer = null;
  if (!offer) return;
  // The engine is about to be replaced: every live thread loses its server.
  stopAllThreads();
  try {
    serverFail = null;
    if (server.running) await api.serverStop();
    await api.serverStart(offer.modelId, null);
  } catch (e: any) {
    toast(String(e?.message ?? e));
  }
  await refreshServer();
  render();
}

// ---------- server failure ----------
function wireCopy(btn: HTMLElement, getText: () => string) {
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(getText());
      const prev = btn.textContent;
      btn.textContent = t("srvfail.copied");
      setTimeout(() => { btn.textContent = prev; }, 1400);
    } catch {}
  });
}

async function showServerLogModal() {
  const m = el(`<div class="modal-bd"><div class="modal wide">
    <h3>${esc(t("srvfail.logTitle"))}</h3>
    <pre class="logpre">${esc(t("srvfail.loading"))}</pre>
    <div class="acts">
      <button class="bs" data-copy>${esc(t("srvfail.copy"))}</button>
      <button class="bp" data-close>${esc(t("common.close"))}</button>
    </div></div></div>`);
  document.body.appendChild(m);
  const pre = m.querySelector<HTMLElement>(".logpre")!;
  let text = "";
  try { text = await api.serverLog(); } catch (e: any) { text = String(e?.message ?? e); }
  pre.textContent = text.trim().length ? text : t("srvfail.emptyLog");
  pre.scrollTop = pre.scrollHeight;
  wireCopy(m.querySelector<HTMLElement>("[data-copy]")!, () => text);
  m.addEventListener("click", (e) => {
    const tg = e.target as HTMLElement;
    if (tg === m || tg.closest("[data-close]")) m.remove();
  });
}

/**
 * Replace an unexplained engine failure with something a person can act on.
 *
 * A user met "Compute error." mid-conversation on a 24 GB Mac and found his
 * way out by trying eco mode at random. The three words come from llama-server
 * when llama_decode returns below -1, and they carry no cause: memory is one
 * of several things that produce them. The backend reads the engine's own log
 * (llama-server.log and the .1 beside it) and returns a verdict, and only a
 * verdict that says something replaces the text. An `unknown` keeps the
 * engine's words, because a message that blames memory for every failure would
 * send users to free memory that was never the problem.
 *
 * Runs after the turn has already ended: nothing here may delay the UI going
 * back to idle, and a backend that does not answer costs nothing but the
 * original message staying as it was.
 */
async function explainEngineFailure(th: store.ThreadTarget, raw: string): Promise<void> {
  let verdict;
  try {
    verdict = await api.engineDiagnose(raw);
  } catch {
    return;
  }
  const advice = engineAdvice(verdict);
  if (!advice) return;
  let text = advice.modeKey ? t(advice.key).replace("%s", t(advice.modeKey)) : t(advice.key);
  // The engine's own line, so the diagnosis can be checked rather than trusted.
  if (verdict.evidence) text += " " + t("engfail.evidence").replace("%s", verdict.evidence);
  // Rewrite the error already in the thread rather than appending a second
  // one: two messages about one failure read as two failures.
  const items = th.data.items;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "error" && it.text === raw) {
      it.text = text;
      break;
    }
  }
  store.save(th.conv, true);
  if (view === "chat" || view === "code") {
    paintChat();
    scrollChatDown();
  }
}

function serverFailCard(): HTMLElement {
  const f = serverFail!;
  const tail = f.log.trim().split("\n").slice(-12).join("\n");
  // A load that died for want of memory says so, instead of handing the user
  // twelve lines of Metal log to interpret. The verdict comes from the engine's
  // own log, decided in Rust, not from the exit code.
  const memory = f.kind === "failed" && f.cause === "memory";
  const title = f.kind === "timeout"
    ? t("srvfail.timeoutTitle")
    : memory ? t("srvfail.memoryTitle") : t("srvfail.title");
  const card = el(`<div class="errcard">
    <div class="eh"><span class="edot"></span><b>${esc(title)}</b>${f.code != null ? `<span class="code">exit ${f.code}</span>` : ""}</div>
    ${memory ? `<span class="eb">${esc(t("srvfail.memoryBody"))}</span>` : ""}
    ${tail ? `<span class="eb">${esc(t("srvfail.body"))}</span><pre class="etail">${esc(tail)}</pre>` : ""}
    <div class="ea">
      <button class="bs" data-copy>${esc(t("srvfail.copy"))}</button>
      <button class="bs" data-view>${esc(t("srvfail.viewLog"))}</button>
    </div></div>`);
  wireCopy(card.querySelector<HTMLElement>("[data-copy]")!, () => f.log);
  card.querySelector("[data-view]")!.addEventListener("click", () => { showServerLogModal(); });
  return card;
}

// ---------- diff rendering (simple block diff: common prefix/suffix) ----------
type FsDiff = NonNullable<PermissionRequest["diff"]>;

function diffRows(d: FsDiff): string {
  const before = d.existed ? d.before.split("\n") : [];
  const after = d.after.split("\n");
  let pre = 0;
  const min = Math.min(before.length, after.length);
  while (pre < min && before[pre] === after[pre]) pre++;
  let suf = 0;
  while (suf < min - pre && before[before.length - 1 - suf] === after[after.length - 1 - suf]) suf++;

  const CAP = 200;
  const row = (cls: string, sign: string, text: string) =>
    `<div class="dl ${cls}"><span class="dsign">${esc(sign.trim())}</span>` +
    `<span class="dtx">${esc(text.length ? text : " ")}</span></div>`;
  const block = (lines: string[], cls: string, sign: string) => {
    const shown = lines.slice(0, CAP);
    let html = shown.map((l) => row(cls, sign, l)).join("");
    if (lines.length > CAP)
      html += `<div class="dl skip">${esc(t("diff.omitted").replace("%n", String(lines.length - CAP)))}</div>`;
    return html;
  };

  let html = "";
  const ctxA = before.slice(Math.max(0, pre - 3), pre);
  if (pre > 3) html += `<div class="dl skip">${esc(t("diff.omitted").replace("%n", String(pre - 3)))}</div>`;
  html += block(ctxA, "", " ");
  html += block(before.slice(pre, before.length - suf), "rem", "-");
  html += block(after.slice(pre, after.length - suf), "add", "+");
  if (suf > 0) {
    const ctxB = after.slice(after.length - suf, Math.min(after.length, after.length - suf + 3));
    html += block(ctxB, "", " ");
    if (suf > 3) html += `<div class="dl skip">${esc(t("diff.omitted").replace("%n", String(suf - 3)))}</div>`;
  }
  return html;
}

/**
 * Left-to-right mark. The four path pills in the app truncate at the START,
 * which needs `direction: rtl` on the box; a leading "/" is bidi-neutral and
 * gets reordered to the visual end there, so "/Volumes/x" rendered as
 * "Volumes/x/". One strong LTR character in front fixes the run.
 */
const LRM = "\u200e";

function diffPanelHtml(path: string, d: FsDiff): string {
  return `<div class="diffhead">
      <span class="path mono">${LRM}${esc(path)}</span>
      <span class="bdg add">+${d.added}</span><span class="bdg rem">−${d.removed}</span>
      ${!d.existed ? `<span class="bdg new">${esc(t("perm.newFile"))}</span>` : ""}
    </div>
    <div class="diffpane">${diffRows(d)}</div>`;
}

function extractPath(detail: string): string {
  try { const o = JSON.parse(detail); if (o.path) return String(o.path); } catch {}
  const m = detail.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) { try { return JSON.parse(`"${m[1]}"`) as string; } catch {} }
  return "";
}

/** Translate the raw labels emitted by the Rust install pipeline. */
function installLabel(l: string): string {
  if (l.startsWith("download")) return t("install.download") + l.slice("download".length);
  if (l === "profiling") return t("install.profiling");
  if (l === "planning") return t("install.planning");
  if (l === "building pack") return t("install.building");
  if (l === "probing volumes") return t("install.probing");
  if (l.startsWith("dual ok")) return t("install.dualOk") + l.slice("dual ok".length);
  if (l.startsWith("dual fallback")) return t("install.dualFallback") + l.slice("dual fallback".length);
  if (l.startsWith("pack ")) return t("install.pack") + l.slice("pack".length);
  const k = "install." + l;
  const v = t(k);
  return v === k ? l : v;
}

// ---------- permission requests ----------
//
// A conversation runs a team, so several threads can ask for permission at the
// same time and the user is looking at one of them at most. Requests are
// therefore QUEUED, never stacked: two dialogs appended to the body cover each
// other, the one underneath is invisible and unclickable, and the thread behind
// it looks exactly like a thread running a tool with nothing asking. One dialog
// is on screen at a time, it names the thread that asked, it says how many
// requests are behind it, and every request ends in one of two ways only: the
// user answers it, or the thread that asked is stopped and it is cancelled.
// Nothing else settles it, and nothing removes it from the screen.

interface PendingPermission {
  req: PermissionRequest;
  /** Key of the thread that asked, and the name to show for it. */
  owner: string;
  origin: string;
  resolve: (d: PermissionDecision) => void;
  settled: boolean;
}

const permQueue: PendingPermission[] = [];
let permOpen: { entry: PendingPermission; el: HTMLElement } | null = null;

/** True while that thread has a dialog on screen, or one waiting behind it. */
function permWaiting(key: string): boolean {
  return permOpen?.entry.owner === key || permQueue.some((p) => p.owner === key);
}

/** True while ANY thread of that conversation is waiting for an answer. */
function permWaitingIn(conv: Conversation): boolean {
  if (permOpen && permOpen.entry.owner.split("#")[0] === conv.id) return true;
  return permQueue.some((p) => p.owner.split("#")[0] === conv.id);
}

function settlePermission(entry: PendingPermission, decision: PermissionDecision): void {
  if (entry.settled) return;
  entry.settled = true;
  entry.resolve(decision);
}

/**
 * Show the next request, or keep the current one alive. Called after every
 * answer AND at the end of every render(): the dialog lives on the body,
 * outside the app root a rebuild empties, and if anything ever detaches it it
 * is put back rather than left pending with nothing on screen to answer.
 */
function pumpPermissions(): void {
  if (permOpen) {
    if (!document.body.contains(permOpen.el)) document.body.appendChild(permOpen.el);
    return;
  }
  const entry = permQueue.shift();
  if (!entry) return;
  permOpen = { entry, el: permissionDialogEl(entry) };
  document.body.appendChild(permOpen.el);
}

/**
 * Repaint the places that say a thread is waiting for the user: the queue
 * counter on the open dialog, and the marks on every thread listed behind it
 * (the backdrop dims the app, it does not hide it).
 */
function permPaintWaiting(): void {
  if (permOpen) {
    const acts = permOpen.el.querySelector(".acts");
    const badge = acts?.querySelector(".pqueue");
    if (acts) {
      if (!permQueue.length) badge?.remove();
      else if (badge) badge.textContent = t("perm.more").replace("%n", String(permQueue.length));
      else acts.prepend(el(`<span class="pqueue">${esc(t("perm.more").replace("%n", String(permQueue.length)))}</span>`));
    }
  }
  if (view === "chat" || view === "code") renderSidebarOnly();
}

/**
 * Deny and dismiss every pending request of the matching threads. Called
 * whenever a thread stops or goes away: the gate awaits a promise only this
 * dialog can settle, so without this the turn would never end, the decode slot
 * would never come back, and the dialog would sit on the screen answering for
 * an agent that no longer exists.
 */
function cancelPermissions(match: (ownerKey: string) => boolean): void {
  for (let i = permQueue.length - 1; i >= 0; i--) {
    if (!match(permQueue[i].owner)) continue;
    settlePermission(permQueue.splice(i, 1)[0], "deny");
  }
  if (permOpen && match(permOpen.entry.owner)) {
    const entry = permOpen.entry;
    permOpen.el.remove();
    permOpen = null;
    settlePermission(entry, "deny");
  }
  pumpPermissions();
  permPaintWaiting();
}

/** Cancel everything pending for one conversation, its team included. */
function cancelPermissionsOfConv(convId: string): void {
  cancelPermissions((k) => k === convId || k.startsWith(`${convId}#`));
}

/**
 * Ask the user. `owner` is the thread's key: it is what a later Stop cancels,
 * and what the "waiting" marks in the sidebar are keyed on. `origin` is that
 * thread's name, shown whenever the request does not come from the thread the
 * user is looking at.
 */
function askPermission(req: PermissionRequest, owner: string, origin: string): Promise<PermissionDecision> {
  return new Promise<PermissionDecision>((resolve) => {
    permQueue.push({ req, owner, origin, resolve, settled: false });
    pumpPermissions();
    permPaintWaiting();
  });
}

function permissionDialogEl(entry: PendingPermission): HTMLElement {
  const req = entry.req;
  // Whose request this is: only worth saying when it is not the thread on
  // screen, which is decided when the dialog OPENS, not when it was queued.
  const origin = entry.owner === active().key ? "" : entry.origin;
  const behind = permQueue.length;
  const kind =
    req.kind === "fs_read" ? t("perm.readFile")
    : req.kind === "fs_write" ? t("perm.writeFile")
    : req.kind === "fs_list" ? t("perm.listDir")
    : req.kind === "shell" ? t("perm.runCommand")
    : req.kind === "obsidian" ? t("perm.obsidian")
    : req.kind === "memory" ? t("perm.memory")
    : req.kind === "web" ? t("perm.web")
    : req.kind === "agent" ? t("perm.agent")
    : req.kind === "conversations" ? t("perm.conversations")
    : req.kind === "code" ? t("perm.code")
    : req.kind === "git" ? t("perm.git")
    : t("perm.mcpTool");
  // "perm" lifts it above every other full-screen layer (the constellation
  // overlay, the install dialogs): a permission dialog nobody can see is a
  // thread blocked with no way out.
  const m = el(`<div class="modal-bd perm"><div class="modal ${req.elevated ? "elev" : ""} ${req.diff ? "wide" : ""}">
      <h3>${esc(t("perm.title"))}</h3>
      <div class="ps">${esc(t("perm.sub"))} <b>${esc(kind)}</b></div>
      ${origin ? `<div class="porigin">${esc(t("perm.origin").replace("%s", origin))}</div>` : ""}
      ${req.elevated ? `<div class="warn">⚠ ${esc(t("perm.elevated"))}</div>` : ""}
      ${req.diff ? diffPanelHtml(req.detail, req.diff) : `<div class="pd ${req.kind === "git" ? "sentence" : ""}">${esc(req.detail)}</div>`}
      ${req.kind === "code" ? `<div class="pnote">${esc(t("perm.codeNote"))}</div>` : ""}
      ${req.elevated ? `<input class="confirm" id="pc" placeholder="${esc(t("perm.elevatedPlaceholder"))}" autocomplete="off"/>` : ""}
      <div class="acts">
        ${behind > 0 ? `<span class="pqueue">${esc(t("perm.more").replace("%n", String(behind)))}</span>` : ""}
        <button class="bs" data-d="deny">${esc(t("perm.deny"))}</button>
        ${!req.elevated && !req.noAlways ? `<button class="bs" data-d="always">${esc(t("perm.allowAlways"))}</button>` : ""}
        <button class="${req.elevated ? "bd" : "bp"}" data-d="once" ${req.elevated ? "disabled" : ""}>${esc(t("perm.allowOnce"))}</button>
      </div></div></div>`);
  if (req.elevated) {
    const inp = m.querySelector<HTMLInputElement>("#pc")!;
    const ok = m.querySelector<HTMLButtonElement>('[data-d="once"]')!;
    inp.addEventListener("input", () => (ok.disabled = inp.value.trim() !== "ALLOW"));
    setTimeout(() => inp.focus(), 30);
  }
  m.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("[data-d]") as HTMLElement | null;
    if (!b) return;
    // Only a button ever settles a request, and only the one it belongs to:
    // the dialog on screen may not be this element any more if the owning
    // thread was stopped while it was open.
    if (permOpen?.entry !== entry) { m.remove(); return; }
    m.remove();
    permOpen = null;
    settlePermission(entry, b.dataset.d as PermissionDecision);
    permPaintWaiting();
    pumpPermissions();
  });
  return m;
}

// ---------- chat ----------
const STOP_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;

function taskBarHtml(): string {
  if (!tasks.length) return "";
  return `<div class="task-bar" id="taskbar" title="${esc(t("task.title"))}">${tasks
    .map(
      (td) =>
        `<button class="task-chip ${td.id === taskId ? "active" : ""}" data-task="${td.id}"><span class="dot ${taskDot(td)}"></span>${esc(td.label)}</button>`
    )
    .join("")}</div>`;
}

/**
 * The team, above the conversation: one chip per teammate, live state on it,
 * and a click straight into its thread.
 */
function teamStripHtml(conv: Conversation): string {
  const chips = conv.team
    .map((sub) => {
      const th = threads.get(threadKey(conv.id, sub.id));
      const busy = !!th?.generating;
      const asking = permWaiting(threadKey(conv.id, sub.id));
      const label = asking
        ? t("perm.waiting")
        : busy && th?.activity?.label ? prettyTool(th.activity.label) : sub.role || t("team.noRole");
      return `<button class="tchip ${busy ? "busy" : ""} ${asking ? "asking" : ""}" data-agent="${esc(sub.id)}" title="${esc(asking ? t("perm.waiting") : sub.role)}">
        ${asking ? `<span class="askpip">?</span>` : busy ? `<span class="runpip"></span>` : `<span class="subdot"></span>`}
        <b>${esc(sub.name)}</b><span class="rl">${esc(label)}</span><span class="n">${sub.items.length}</span>
      </button>`;
    })
    .join("");
  return `<div class="teamstrip" id="teamstrip"><span class="lbl">${esc(t("team.label"))}</span>${chips}</div>`;
}

function chatView(): HTMLElement {
  const running = registry.find((m) => m.id === server.model_id);
  const tps = running ? expectedTps(running) : null;
  const ready = server.running && server.phase === "ready";
  const sess = active();
  const sub = sess.sub;
  const generating = sess.generating;
  const conv = sess.conv;
  // Inside a teammate's thread the top bar becomes its identity card, with the
  // way back to the conversation: two clicks from anywhere to "what did the
  // reviewer actually say", and one to come back.
  const crumb = sub
    ? `<span class="ttl"><span class="crumb" id="backconv">${esc(convLabel(conv))}</span><span class="sep">›</span>${esc(sub.name)}</span>`
    : `<span class="ttl">${esc(t("nav.chat"))}</span>`;
  const wrap = el(`<div class="main">
    <div class="topbar" data-tauri-drag-region>
      ${crumb}
      <div class="right">
        <div class="livebar" id="livebar"></div>
        ${sub ? "" : taskBarHtml()}
        ${running ? `<div class="mpill" title="${esc(engineModeLabel(server.mode))}"><span class="d"></span><span class="n">${esc(running.name.split(" ")[0])}</span>${server.mode === "resident-bit-exact" ? `<span class="s">${esc(t("engine.residentShort"))}</span>` : ""}${tps ? `<span class="s">~${tps.toFixed(0)} tok/s</span>` : ""}</div>` : ""}
        <div class="iconbtn" id="newchat" title="${esc(t("nav.newchat"))}">${I.plus}</div>
      </div>
    </div>
    ${sub ? `<div class="subhead">
      <span class="back" id="backbtn">‹ ${esc(t("team.back"))}</span>
      <span class="who"><b>${esc(sub.name)}</b><span class="rl">${esc(sub.role || t("team.noRole"))}</span></span>
      <span class="grow"></span>
      <span class="brieftgl" id="brieftgl">${esc(t("team.brief"))}</span>
    </div><div class="briefbox" id="briefbox" style="display:none">${esc(sub.brief)}</div>` : ""}
    ${!sub && conv.team.length ? teamStripHtml(conv) : ""}
  </div>`);
  wrap.appendChild(threadPaneEl());

  wrap.querySelector("#newchat")!.addEventListener("click", newChat);
  wrap.querySelector("#backbtn")?.addEventListener("click", () => openTeamThread(null));
  wrap.querySelector("#backconv")?.addEventListener("click", () => openTeamThread(null));
  wrap.querySelector("#brieftgl")?.addEventListener("click", () => {
    const box = document.getElementById("briefbox");
    if (box) box.style.display = box.style.display === "none" ? "block" : "none";
  });
  wrap.querySelector("#teamstrip")?.addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement).closest("[data-agent]") as HTMLElement | null;
    if (chip) openTeamThread(chip.dataset.agent!);
  });
  wrap.querySelector("#taskbar")?.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("[data-task]") as HTMLElement | null;
    if (!b) return;
    selectTask(b.dataset.task as TaskId);
  });
  return wrap;
}

/**
 * The thread itself: the log, the activity bar and the composer. The Chat view
 * and the Code view both mount THIS, with the same element ids, so every paint
 * function (paintChat, paintPlan, restoreActivity, setSendState) keeps finding
 * what it looks up and both views drive the very same Agent, the very same
 * permission queue and the very same tool cards. There is one thread; the Code
 * view simply shows it beside the files.
 */
function threadPaneEl(): HTMLElement {
  const ready = server.running && server.phase === "ready";
  const sess = active();
  const sub = sess.sub;
  const generating = sess.generating;

  const wrap = el(`<div class="threadpane">
    <div class="chat-scroll" id="scroller"><div class="thread"><div id="plan"></div><div id="log"></div></div></div>
    ${taskOffer ? `<div class="task-switch-hint" id="taskhint"><span class="tx">${esc(t("task.better").replace("%m", taskOffer.modelName))}</span><button class="bs" id="taskswap">${esc(t("task.switch"))}</button><span class="x" id="taskdismiss">×</span></div>` : ""}
    <div class="actbar" id="actbar"><div class="pxhost" id="pixelhost"></div></div>
    <div class="composer">
      <div class="comp-box">
      <textarea id="ci" rows="2" placeholder="${esc(sub ? t("team.placeholder").replace("%s", sub.name) : t("chat.placeholder"))}"></textarea>
      <div class="comp-bar">
        <div class="tool-btn" id="gotoconn">${I.conn}<span>${mcpCount}</span></div>
        ${slashSkills.some((s) => s.name === "recherche-sourcee") ? `<div class="tool-btn deep ${deepResearch ? "on" : ""}" id="deepbtn" title="${esc(t("chat.deepHint"))}">${I.scope}<span>${esc(t("chat.deep"))}</span></div>` : ""}
        <div class="seg-mode ${sub || toolsBlocked() ? "off" : ""}" id="modeseg"${toolsBlocked() ? ` title="${esc(t("tools.forcedManual"))}"` : ""}>
          <button data-a="manual" class="${autonomy === "manual" ? "on" : ""}">${esc(t("mode.manual"))}</button>
          <button data-a="assisted" class="${autonomy === "assisted" ? "on" : ""}">${esc(t("mode.assisted"))}</button>
          <button data-a="autonomous" class="${autonomy === "autonomous" ? "on" : ""}">${esc(t("mode.autonomous"))}</button>
        </div>
        <span class="grow"></span>
        <div class="tool-btn ${dictating ? "rec" : ""}" id="micbtn" title="${esc(t(dictating ? "chat.micStop" : "chat.mic"))}">${I.mic}</div>
        <span class="hint" id="drophint">${esc(t("chat.localHint"))}</span>
        <div class="send ${generating ? "stop" : ""} ${!ready && !generating ? "off" : ""}" id="send">${generating ? STOP_ICON : I.up}</div>
      </div>
      </div>
    </div>
  </div>`);

  const input = wrap.querySelector<HTMLTextAreaElement>("#ci")!;
  wrap.querySelector("#gotoconn")!.addEventListener("click", () => { view = "connectors"; render(); });
  wrap.querySelector("#deepbtn")?.addEventListener("click", (e) => {
    deepResearch = !deepResearch;
    (e.currentTarget as HTMLElement).classList.toggle("on", deepResearch);
  });
  wrap.querySelector("#micbtn")?.addEventListener("click", async () => {
    if (dictating) {
      api.voiceStop().catch(() => {});
      return;
    }
    const inp = document.getElementById("ci") as HTMLTextAreaElement | null;
    dictBase = inp ? (inp.value.trim() ? inp.value.trimEnd() + " " : "") : "";
    dictating = true;
    document.getElementById("micbtn")?.classList.add("rec");
    try {
      await api.voiceStart(getLang() === "fr" ? "fr-FR" : "en-US");
    } catch (e: any) {
      dictating = false;
      document.getElementById("micbtn")?.classList.remove("rec");
      toast(t("voice.error").replace("%s", String(e?.message ?? e)));
    }
  });
  wrap.querySelector("#modeseg")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("[data-a]") as HTMLElement | null;
    if (!b) return;
    void setAutonomy(b.dataset.a as Autonomy);
  });
  wrap.querySelector("#taskswap")?.addEventListener("click", () => { acceptTaskSwitch(); });
  wrap.querySelector("#taskdismiss")?.addEventListener("click", () => { taskOffer = null; render(); });

  // Drag & drop: file paths land in the input; the user decides what to do.
  dropUnsub?.();
  dropUnsub = wireDropZone(wrap.querySelector<HTMLElement>(".comp-box")!, (paths) => {
    const inp = document.getElementById("ci") as HTMLTextAreaElement | null; // fresh lookup, never stale
    if (!inp || !paths.length) return;
    inp.value = (inp.value.trim() ? inp.value.trimEnd() + "\n" : "") + paths.join("\n") + "\n";
    inp.dispatchEvent(new Event("input"));
    inp.focus();
    const hint = document.getElementById("drophint");
    if (hint) {
      hint.textContent = t("chat.dropHint");
      hint.classList.add("lit");
      setTimeout(() => {
        const h = document.getElementById("drophint");
        if (h) { h.textContent = t("chat.localHint"); h.classList.remove("lit"); }
      }, 5000);
    }
  });

  // While generating the input stays usable (draft the next message); Enter is
  // simply inert so a re-render can never swallow typed text via stop().
  if (!ready && !generating) input.disabled = true;
  const sendBtn = wrap.querySelector<HTMLElement>("#send")!;
  sendBtn.addEventListener("click", submitChat);

  // ---- slash-command autocomplete (/skill) ----
  // ---- @file and @symbol mentions ----
  //
  // Candidates come from the open code workspace ONLY. With no workspace there
  // is nothing a mention could name, so the picker never opens: an empty list
  // that steals the Enter key is worse than no feature at all.
  const mentionBox = el(`<div class="slash-menu mention-menu" id="mentionmenu" style="display:none"></div>`);
  wrap.querySelector<HTMLElement>(".comp-box")!.prepend(mentionBox);
  let mentionRows: MentionCandidate[] = [];
  let mentionSel = 0;
  let mentionFiles: MentionCandidate[] = [];
  let mentionSymbols: MentionCandidate[] = [];
  /** Guards against an out of order symbol answer overwriting a newer one. */
  let symbolQueryGen = 0;
  let symbolTimer: ReturnType<typeof setTimeout> | null = null;

  const loadMentionFiles = async (): Promise<void> => {
    const r = codeview.codeRoot();
    if (!r) { mentionFiles = []; return; }
    // `false`: the cached list. Forcing a rescan on every composer mount would
    // walk the whole workspace for a picker the user may never open.
    const files = await api.searchFiles(r, false).catch(() => [] as string[]);
    mentionFiles = files.map((path) => ({ kind: "file", path }) as MentionCandidate);
  };

  /**
   * Symbols are asked for lazily and debounced. The file list is one cached
   * array; the symbol index is a query per keystroke against the Rust side, so
   * it waits for the typing to settle and for a query worth answering.
   */
  const loadMentionSymbols = (query: string): void => {
    const r = codeview.codeRoot();
    if (symbolTimer) clearTimeout(symbolTimer);
    if (!r || query.length < 2) { mentionSymbols = []; return; }
    const gen = ++symbolQueryGen;
    symbolTimer = setTimeout(() => {
      void api
        .symbolsQuery(r, query, 60)
        .then((hits) => {
          if (gen !== symbolQueryGen) return; // a newer keystroke already won
          mentionSymbols = hits.map((h) => ({
            kind: "symbol",
            path: h.path,
            symbol: h.name,
            detail: h.kind,
            line: h.line,
          }) as MentionCandidate);
          paintMentions();
        })
        .catch(() => {
          if (gen === symbolQueryGen) mentionSymbols = [];
        });
    }, 120);
  };

  const paintMentions = () => {
    const active = scanMentions(input.value, input.selectionStart ?? input.value.length);
    if (!active) {
      mentionBox.style.display = "none";
      mentionRows = [];
      mentionSymbols = [];
      return;
    }
    loadMentionSymbols(active.query);
    const pool = mentionFiles.concat(mentionSymbols);
    if (!pool.length) { mentionBox.style.display = "none"; mentionRows = []; return; }
    const ranked = rankCandidates(pool, active.query, 40);
    mentionRows = ranked.map((r) => r.candidate);
    if (!ranked.length) { mentionBox.style.display = "none"; return; }
    mentionSel = Math.min(mentionSel, ranked.length - 1);
    mentionBox.style.display = "block";
    mentionBox.innerHTML = ranked
      .map((r, i) => {
        const set = new Set(r.positions);
        const marked = [...r.text]
          .map((ch, k) => (set.has(k) ? `<i>${esc(ch)}</i>` : esc(ch)))
          .join("");
        const badge = r.candidate.detail ? `<em>${esc(r.candidate.detail)}</em>` : "";
        return `<div class="mention-item ${i === mentionSel ? "on" : ""}" data-mention="${i}"><b>${marked}</b>${badge}</div>`;
      })
      .join("");
  };

  const pickMention = (i: number) => {
    const active = scanMentions(input.value, input.selectionStart ?? input.value.length);
    if (!active || !mentionRows[i]) return;
    const out = applyMention(input.value, active, mentionRows[i]);
    input.value = out.text;
    input.setSelectionRange(out.caret, out.caret);
    mentionBox.style.display = "none";
    mentionRows = [];
    input.focus();
  };

  mentionBox.addEventListener("mousedown", (e) => {
    e.preventDefault(); // keep the textarea focused
    const it = (e.target as HTMLElement).closest("[data-mention]") as HTMLElement | null;
    if (it) pickMention(Number(it.dataset.mention));
  });
  void loadMentionFiles();

  const slashBox = el(`<div class="slash-menu" id="slashmenu" style="display:none"></div>`);
  wrap.querySelector<HTMLElement>(".comp-box")!.prepend(slashBox);
  let slashSel = 0;
  const slashMatches = (): SkillInfo[] => {
    const m = input.value.match(/^\/([\w-]*)$/);
    if (!m) return [];
    const q = m[1].toLowerCase();
    return slashSkills.filter((s) => s.name.toLowerCase().startsWith(q)).slice(0, 6);
  };
  const paintSlash = () => {
    const list = slashMatches();
    if (!list.length) { slashBox.style.display = "none"; return; }
    slashSel = Math.min(slashSel, list.length - 1);
    slashBox.style.display = "block";
    slashBox.innerHTML = list
      .map(
        (s, i) =>
          `<div class="slash-item ${i === slashSel ? "on" : ""}" data-slash="${esc(s.name)}"><b>/${esc(s.name)}</b><span>${esc(s.description || "")}</span></div>`
      )
      .join("");
  };
  const pickSlash = (name: string) => {
    input.value = `/${name} `;
    slashBox.style.display = "none";
    input.focus();
  };
  slashBox.addEventListener("mousedown", (e) => {
    e.preventDefault(); // keep the textarea focused
    const it = (e.target as HTMLElement).closest("[data-slash]") as HTMLElement | null;
    if (it) pickSlash(it.dataset.slash!);
  });

  input.addEventListener("keydown", (e) => {
    if (mentionRows.length && mentionBox.style.display !== "none") {
      if (e.key === "ArrowDown") { e.preventDefault(); mentionSel = (mentionSel + 1) % mentionRows.length; paintMentions(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); mentionSel = (mentionSel - 1 + mentionRows.length) % mentionRows.length; paintMentions(); return; }
      if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); pickMention(mentionSel); return; }
      if (e.key === "Escape") { e.preventDefault(); mentionBox.style.display = "none"; mentionRows = []; return; }
    }
    const list = slashMatches();
    if (list.length && slashBox.style.display !== "none") {
      if (e.key === "ArrowDown") { e.preventDefault(); slashSel = (slashSel + 1) % list.length; paintSlash(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); slashSel = (slashSel - 1 + list.length) % list.length; paintSlash(); return; }
      if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); pickSlash(list[slashSel].name); return; }
      if (e.key === "Escape") { slashBox.style.display = "none"; return; }
    }
    // ⇧Tab cycles Manual → Assisted → Autonomous without leaving the keyboard.
    // Not from a teammate's thread: the switch is disabled there, so the flip
    // would be invisible, and Autonomous is exactly what stops asking.
    if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); if (!sub) cycleAutonomy(); return; }
    // Enter always submits: during generation a typed message is queued for
    // the next turn (an empty Enter stays inert, never an accidental stop).
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!active().generating || input.value.trim()) void submitChat();
    }
    if (e.key === "Escape" && active().generating) { stopThread(active()); }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
    slashSel = 0;
    paintSlash();
    mentionSel = 0;
    paintMentions();
    // During generation the button follows the composer: text = send (queued
    // for the next turn), empty = stop.
    if (active().generating) {
      const b = document.getElementById("send");
      if (b) {
        const hasText = input.value.trim().length > 0;
        b.innerHTML = hasText ? I.up : STOP_ICON;
        b.classList.toggle("stop", !hasText);
      }
    }
  });
  // A caret moved with the mouse or the arrow keys changes which token is
  // active without firing `input`, and the picker has to follow it.
  input.addEventListener("click", () => { mentionSel = 0; paintMentions(); });
  input.addEventListener("keyup", (e) => {
    if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") {
      mentionSel = 0;
      paintMentions();
    }
  });
  // In the Code view the editor is what the user came for: the composer must
  // not take the caret out of it on every repaint.
  if (view === "chat") setTimeout(() => { if (!input.disabled) input.focus(); }, 40);
  return wrap;
}

/**
 * Enable or disable the composer in place. Server events fire for minutes
 * while a model loads; in the Code view a full rebuild would destroy the
 * editor (and its pending diff) on every one of them.
 */
function paintComposerReady(): void {
  const ready = server.running && server.phase === "ready";
  const generating = active().generating;
  const input = document.getElementById("ci") as HTMLTextAreaElement | null;
  if (input) input.disabled = !ready && !generating;
  const send = document.getElementById("send");
  if (send) send.classList.toggle("off", !ready && !generating);
}

// ---------- chat painting (state -> DOM, never the reverse) ----------
// Every paint looks the DOM up fresh, so a re-render can never orphan it.

function chatLog(): HTMLElement | null { return document.getElementById("log"); }
function chatScroller(): HTMLElement | null { return document.getElementById("scroller"); }

function scrollChatDown() {
  const s = chatScroller();
  if (s) s.scrollTop = s.scrollHeight;
}

/**
 * Follow a streaming answer, unless the reader has gone somewhere else.
 *
 * The unconditional version above fires on every token. A reader who scrolls up
 * to re-read an earlier message, or who is halfway through selecting text to
 * copy, was dragged back to the bottom within one frame, for as long as the
 * answer kept coming. A background teammate's tokens did it too, to a thread
 * the reader had not asked about.
 *
 * "Within 40px of the end" is the question actually being asked: were they
 * following? If they were, keep following. If they were not, leave them alone.
 * The same rule the reasoning block already uses.
 */
function scrollChatDownIfFollowing() {
  const s = chatScroller();
  if (s && isFollowing(s)) s.scrollTop = s.scrollHeight;
}

/**
 * `from` is set when another conversation's agent sent this message: it is
 * labelled and styled apart, so nothing ever arrives in a thread without the
 * user seeing who put it there.
 */
function userRowEl(text: string, from?: string, queued?: boolean): HTMLElement {
  if (from) {
    return el(`<div class="row-u from-agent">
      <div class="bub-u"><span class="fromtag">${esc(t("chat.fromAgent").replace("%s", from))}</span>${esc(text)}</div>
      <div class="av u agent" title="${esc(t("chat.fromAgent").replace("%s", from))}">⇄</div>
    </div>`);
  }
  // A queued message says it is waiting. Without that it is the same bubble as
  // one being answered, and during a long turn its sender concludes it was
  // dropped, which is the one thing it was not.
  return el(`<div class="row-u${queued ? " queued" : ""}"><div class="bub-u">${esc(text)}${
    queued ? `<span class="qtag">${esc(t("chat.queuedTag"))}</span>` : ""
  }</div><div class="av u">${esc(t("chat.you")[0] || "V")}</div></div>`);
}

function assistantBodyEl(): { row: HTMLElement; body: HTMLElement } {
  const row = el(`<div class="row-a"><div class="av a">G</div><div class="body"></div></div>`);
  return { row, body: row.querySelector(".body")! };
}

/**
 * The model's thinking, dimmer than its answer, and giving way to it.
 *
 * WHAT "REPLACE" MEANS HERE. While the thoughts stream the block is open and
 * is the only thing on screen, which is the whole point: it is what tells a
 * reader that a model taking thirty seconds is working rather than stuck. The
 * moment the answer starts, the block closes to a single quiet line and the
 * answer takes the reading surface. The thinking is therefore replaced where
 * it matters, on screen, without being destroyed: someone who wants to check
 * what the model reasoned reopens it, and someone who does not never sees it
 * again. Deleting it would have made that second reader impossible to serve.
 *
 * Returns null when the channel carried nothing readable, which is what most
 * turns of most models produce. No block, no heading, no empty frame.
 */
function reasoningCardEl(it: Extract<ChatItem, { kind: "reasoning" }>): HTMLElement | null {
  // The sentinel becomes a sentence here, in the reader's language. It lives in
  // the stored text as a marker so the pure module can stay free of the
  // translation table, and it is never shown raw.
  const text = renderReasoning(it.text);
  if (text.trim() === "") return null;
  const live = !it.done;
  // Open while it streams, closed once it has settled. The gist only appears
  // on a settled block: while the block is open the text is right there, and a
  // header repeating its first line would be the same words twice.
  const gist = live ? "" : reasoningGist(it.text);
  const card = el(`<div class="think${live ? " open" : ""}"${live ? " data-live" : ""}>
    <div class="think-h">${I.mem}<span class="nm">${esc(t("chat.reasoning"))}</span><span class="arg">${esc(gist)}</span><span class="st">${live ? esc(t("chat.reasoningLive")) : ""}</span><span class="chev">▾</span></div>
    <div class="think-b"><div class="think-t">${esc(text)}</div></div>
  </div>`);
  card.querySelector(".think-h")!.addEventListener("click", () => card.classList.toggle("open"));
  if (live) {
    followReasoning(card);
  }
  return card;
}

/**
 * Keep a streaming reasoning block showing its last lines.
 *
 * The block is capped in height and scrolls, and it used to sit at its top: a
 * model thinking for minutes filled it with lines nobody could see while the
 * visible ones stopped changing after two seconds.
 *
 * .think-t carries the height cap and the overflow, so it is what scrolls.
 * .think-b only decides whether the block is shown at all.
 *
 * A reader who has scrolled up is left alone. Dragging someone back to the
 * bottom every time a token lands is worse than never following at all, and
 * "within 24px of the end" is the usual way to ask whether they were following
 * in the first place.
 */
/** The stored thought as the reader sees it: sentinel swapped for a sentence. */
function renderReasoning(stored: string): string {
  const body = visibleReasoning(stored);
  return body.startsWith(REASONING_TRUNCATED)
    ? t("chat.reasoningTrimmed") + "\n" + body.slice(REASONING_TRUNCATED.length)
    : body;
}

function followReasoning(card: HTMLElement): void {
  const stream = card.querySelector<HTMLElement>(".think-t");
  if (!stream || !isFollowing(stream)) return;
  requestAnimationFrame(() => {
    stream.scrollTop = stream.scrollHeight;
  });
}

/**
 * Move the live reasoning block in place, without rebuilding the thread.
 *
 * paintChat empties the log and builds every card again. At one call per token
 * that is the whole conversation reconstructed several times a second, and the
 * block's scroll position went with it: the element was new, so it started at
 * the top, and the follow above put it back at the bottom. Between those two
 * the eye saw a block flicking between its first and its last lines.
 *
 * Returns false when there is no live block on screen yet, which is the first
 * token of a turn: that one needs the full paint, since the card does not exist.
 */
function paintLiveReasoning(text: string): boolean {
  const log = chatLog();
  const stream = log?.querySelector<HTMLElement>(".think[data-live] .think-t");
  if (!log || !stream) return false;
  const visible = renderReasoning(text);
  if (visible.trim() === "") return false;
  stream.textContent = visible;
  followReasoning(stream.closest(".think") as HTMLElement);
  return true;
}

function toolCardEl(it: Extract<ChatItem, { kind: "tool" }>): HTMLElement {
  const icon = it.name === "run_command" ? I.term : I.file;
  const status = it.done ? t("chat.done") : t("chat.running");
  const card = el(`<div class="tool">
    <div class="tool-h">${icon}<span class="nm">${esc(prettyTool(it.name))}</span><span class="arg">${esc(argPreview(it.arg))}</span><span class="st">${esc(status)}</span><span class="chev">▾</span></div>
    <div class="tool-b"><pre>${esc(it.done ? it.result : "…")}</pre>${it.done && it.name === "write_file" && it.path ? `<div class="revert"><span class="link" data-revert="${esc(it.path)}">${esc(t("chat.revert"))}</span></div>` : ""}</div>
  </div>`);
  card.querySelector(".tool-h")!.addEventListener("click", () => card.classList.toggle("open"));
  const rev = card.querySelector<HTMLElement>("[data-revert]");
  rev?.addEventListener("click", async () => {
    const p = rev.dataset.revert!;
    // Two-step: restoring overwrites the current file, one accidental click
    // must not be enough.
    if (!rev.dataset.armed) {
      rev.dataset.armed = "1";
      rev.textContent = t("chat.revertConfirm");
      setTimeout(() => {
        if (rev.dataset.armed) { delete rev.dataset.armed; rev.textContent = t("chat.revert"); }
      }, 4000);
      return;
    }
    delete rev.dataset.armed;
    try { await api.fsRevert(p); rev.textContent = t("chat.reverted"); }
    catch { rev.textContent = t("chat.revertFail"); }
  });
  return card;
}

/**
 * A teammate's work, seen from the thread that asked for it. It is live while
 * the teammate runs (its current tool shows here), it carries the question and
 * the answer, and it opens the teammate's own thread in one click, which is
 * the whole point: the work is inspectable, not summarised away.
 */
function agentBlockEl(it: Extract<ChatItem, { kind: "agent" }>, conv: Conversation): HTMLElement {
  const sub = store.findSubAgent(conv, it.agentId);
  const th = sub ? threads.get(threadKey(conv.id, sub.id)) : undefined;
  const live = !!th?.generating;
  const status = live
    ? th?.activity?.label
      ? prettyTool(th.activity.label)
      : t("chat.running")
    : it.failed
      ? t("team.failed")
      : it.done
        ? t("chat.done")
        : t("chat.running");
  const entries = sub ? sub.items.length : 0;
  const card = el(`<div class="agentblk ${live ? "live" : ""} ${it.failed ? "bad" : ""}">
    <div class="ab-h">
      <span class="ab-av">${live ? `<span class="runpip"></span>` : "⌁"}</span>
      <span class="nm">${esc(it.name)}</span>
      <span class="rl">${esc(it.role || "")}</span>
      <span class="st">${esc(status)}</span>
      ${sub ? `<span class="open" data-open="${esc(it.agentId)}">${esc(t("team.openThread").replace("%n", String(entries)))}</span>` : ""}
    </div>
    <div class="ab-q">${esc(it.ask)}</div>
    ${it.done || it.answer ? `<div class="ab-a md"></div>` : ""}
  </div>`);
  const ansBox = card.querySelector<HTMLElement>(".ab-a");
  if (ansBox) {
    ansBox.innerHTML = renderMarkdown(it.answer, { streaming: false });
    wireCodeCopy(ansBox, t("chat.copied"));
  }
  card.querySelector("[data-open]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openTeamThread(it.agentId);
  });
  return card;
}

/** Full repaint of the thread from the store. */
function paintChat(): void {
  const log = chatLog();
  if (!log) return;
  log.innerHTML = "";

  if (serverFail) log.appendChild(serverFailCard());
  const loading = server.running && server.phase === "starting";
  if (loading) log.appendChild(loadingCard());

  const sess = active();
  const generating = sess.generating;
  if (sess.data.items.length === 0) {
    const ready = server.running && server.phase === "ready";
    if (!loading) {
      log.appendChild(
        el(`<div class="empty"><img class="big-mark" src="${LOGO}" alt=""/>${esc(
          sess.sub ? t("team.emptyThread") : ready ? t("chat.empty") : t("chat.noserver")
        )}</div>`)
      );
    }
    paintPlan();
    return;
  }

  let body: HTMLElement | null = null; // current assistant group
  for (const it of sess.data.items) {
    if (it.kind === "user") {
      body = null;
      log.appendChild(userRowEl(it.text, it.from, it.queued));
    } else if (it.kind === "assistant") {
      if (!body) { const r = assistantBodyEl(); log.appendChild(r.row); body = r.body; }
      const md = el(`<div class="msg-a md"></div>`);
      md.innerHTML = renderMarkdown(it.text, { streaming: !it.text.endsWith("\n") && generating });
      wireCodeCopy(md, t("chat.copied"));
      addPreviewButtons(md);
      body.appendChild(md);
    } else if (it.kind === "reasoning") {
      const card = reasoningCardEl(it);
      // The group is opened only when there IS a card, so a turn whose
      // reasoning channel said nothing does not leave an empty avatar row
      // hanging above the answer.
      if (card) {
        if (!body) { const r = assistantBodyEl(); log.appendChild(r.row); body = r.body; }
        body.appendChild(card);
      }
    } else if (it.kind === "tool") {
      if (!body) { const r = assistantBodyEl(); log.appendChild(r.row); body = r.body; }
      body.appendChild(toolCardEl(it));
    } else if (it.kind === "agent") {
      if (!body) { const r = assistantBodyEl(); log.appendChild(r.row); body = r.body; }
      body.appendChild(agentBlockEl(it, sess.conv));
    } else if (it.kind === "notice") {
      body = null;
      log.appendChild(el(`<div class="notice">${esc(it.text)}</div>`));
    } else {
      body = null;
      const r = assistantBodyEl();
      r.body.appendChild(el(`<div class="msg-a" style="color:var(--bad)">${esc(it.text)}</div>`));
      log.appendChild(r.row);
    }
  }

  // Read-aloud: a discreet control on every finished assistant group.
  if (!generating) {
    for (const row of Array.from(log.querySelectorAll<HTMLElement>(".row-a"))) {
      const b = row.querySelector<HTMLElement>(".body");
      if (!b || b.querySelector(".sayrow")) continue;
      const text = Array.from(b.querySelectorAll<HTMLElement>(".msg-a"))
        .map((mEl) => mEl.textContent ?? "")
        .join("\n")
        .trim();
      if (!text) continue;
      const say = el(`<div class="sayrow"><span class="link">${I.mic} ${esc(t("chat.speak"))}</span></div>`);
      say.querySelector(".link")!.addEventListener("click", () => {
        // Global toggle: closures die on repaint, the flag must not.
        if (ttsPlaying) { api.ttsStop().catch(() => {}); ttsPlaying = false; return; }
        ttsPlaying = true;
        // The backend spawns `say` and returns at once, so this resolves when
        // speech STARTS, not when it ends. Clearing the flag on success as well
        // as on failure is what stops the next click being swallowed as a
        // "stop" of something that finished minutes ago.
        api.ttsSpeak(text).then(
          () => { ttsPlaying = false; },
          () => { ttsPlaying = false; },
        );
      });
      b.appendChild(say);
    }
  }

  // Live generation stats under the last answer: streamed chars / elapsed
  // time. An ESTIMATE (≈4 chars per token), and labelled as such.
  const last = sess.data.items[sess.data.items.length - 1];
  const gs = sess.genStats;
  if (gs && body && last && last.kind === "assistant") {
    const tokens = Math.round(gs.chars / 4);
    const ms = (gs.endMs ?? Date.now()) - gs.startMs;
    if (tokens > 0) {
      body.appendChild(
        el(`<div class="genstats" title="${esc(t("chatx.estimated"))}">≈ ${esc(formatStats({ tokens, ms }))}</div>`)
      );
    }
  }
  paintPlan();
}

// ---------- code-block preview (PreviewPanel) ----------

/** Add an "Apercu" button next to "copy" on every previewable code block. */
function addPreviewButtons(container: HTMLElement): void {
  for (const cb of Array.from(container.querySelectorAll<HTMLElement>(".cb"))) {
    const head = cb.querySelector<HTMLElement>(".cb-h");
    const copy = cb.querySelector<HTMLElement>(".cb-c");
    if (!head || !copy) continue;
    const rawLabel = head.querySelector(".cb-l")?.textContent ?? "";
    const lang = rawLabel === "code" ? "" : rawLabel; // "code" is the empty-lang label
    // dataset.code is already entity-decoded by the HTML parser.
    const code = copy.dataset.code ?? "";
    const kind = detectPreviewable(code, lang);
    if (kind === "none") continue;
    const acts = document.createElement("span");
    acts.className = "cb-acts";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cb-c cb-p";
    btn.textContent = t("chat.preview");
    btn.addEventListener("click", (e) => {
      e.stopPropagation(); // keep it away from the copy delegation
      openPreview(code, kind, rawLabel || kind);
    });
    acts.append(btn, copy); // moves the copy button into the action group
    head.appendChild(acts);
  }
}

function openPreview(code: string, kind: PreviewKind, title: string): void {
  if (view !== "chat" && view !== "code") return;
  const host = document.querySelector<HTMLElement>(".main");
  if (!host) return;
  if (!previewPanel) previewPanel = new PreviewPanel(host);
  previewPanel.show(code, kind, title);
}

function paintPlan(): void {
  const box = document.getElementById("plan");
  if (!box) return;
  const plan = active().data.plan;
  if (!plan.length) { box.innerHTML = ""; return; }
  const done = plan.filter((s) => s.status === "done").length;
  box.innerHTML = `<div class="plan"><div class="ph">◆ ${esc(t("chat.plan"))}<span class="c">${done}/${plan.length}</span></div>${plan
    .map((s) => `<div class="pr ${s.status}"><span class="pi">${s.status === "done" ? "✓" : s.status === "doing" ? "◐" : "○"}</span><span class="tt">${esc(s.title)}</span></div>`)
    .join("")}</div>`;
}

let paintPending = false;
function schedulePaint(): void {
  if (paintPending) return;
  paintPending = true;
  requestAnimationFrame(() => { paintPending = false; paintChat(); scrollChatDownIfFollowing(); paintLive(); paintTeamStrip(); });
}

function setSendState(busy: boolean): void {
  const b = document.getElementById("send");
  if (!b) return;
  b.innerHTML = busy ? STOP_ICON : I.up;
  b.classList.toggle("stop", busy);
}

/**
 * Create the agent of one thread: a conversation's own, or a teammate's.
 * Every hook is bound to that thread and guarded against the instance being
 * replaced (model change, engine stop): a callback landing after the thread
 * moved on must never touch the store, it would mutate a thread that is no
 * longer the one it belongs to.
 *
 * Painting is conditional on the thread being the one on screen. A teammate
 * working in the background mutates its own thread and saves it inside the
 * parent conversation; the only thing it repaints is what says it is alive:
 * its block in the parent thread and its sidebar row.
 */
async function ensureAgent(sess: Thread): Promise<void> {
  if (sess.agent) return;
  const mine = () => sess.agent === inst;
  const visible = () => sess.key === active().key;
  /** The parent thread is on screen and shows this teammate's live block. */
  const blockVisible = () => !!sess.sub && active().key === threadKey(sess.conv.id);
  const repaint = () => {
    if (visible() || blockVisible()) schedulePaint();
  };
  const inst: Agent = new Agent(
    {
      onAssistantDelta: (text) => {
        if (!mine()) return;
        if (sess.genStats) {
          // Clock from the first token, so tok/s reflects generation, not setup.
          if (sess.genStats.chars === 0) sess.genStats.startMs = Date.now();
          sess.genStats.chars += text.length;
        }
        // The pixel types along while the answer streams (setMode dedupes;
        // a fresh action scene finishes its hold before this applies).
        onThreadActivity(sess, "responding", t("px.responding"));
        store.appendAssistant(sess, text);
        repaint();
      },
      // The first thing that moves on a reasoning turn, and the reason this
      // whole path exists. It runs on the model's FIRST thought token, long
      // before any answer: the block appears, and the activity label stops
      // saying the generic "thinking" and says the model is reasoning out
      // loud, which is a claim the screen can now back up.
      onReasoningDelta: (text) => {
        if (!mine()) return;
        store.appendReasoning(sess, text);
        onThreadActivity(sess, "thinking", t("px.reasoning"));
          // In place while the block is already on screen. A full repaint only
          // for the first token, the one that has to create the card: paintChat
          // empties the log, so at one call per token the block was a new
          // element several times a second and its scroll position went with it.
          const last = sess.data.items[sess.data.items.length - 1];
          const live = last && last.kind === "reasoning" && !last.done ? last.text : null;
          if (!(live !== null && paintLiveReasoning(live))) repaint();
      },
      onAssistantDone: () => {
        if (!mine()) return;
        store.trimEmptyTail(sess);
        sess.generating = false;
        if (sess.genStats) {
          sess.genStats.endMs = Date.now();
          // Keep the last real speed visible in the header between turns.
          if (sess.genStats.chars > 40 && visible()) {
            liveTps = sess.genStats.chars / 4 / Math.max((sess.genStats.endMs - sess.genStats.startMs) / 1000, 0.25);
          }
        }
        onThreadActivity(sess, "done");
        if (visible()) setSendState(false);
        store.syncHistory(sess, inst.history(), inst.summary());
        store.save(sess.conv, true);
        // Hand the answer to whoever delegated this turn (ask_agent).
        const answer = store.lastAssistantText(sess.data);
        for (const w of sess.waiters.splice(0)) w(answer);
        store.refreshList().then(() => { if (view === "chat" || view === "code") renderSidebarOnly(); });
        if (visible() || blockVisible()) { paintChat(); scrollChatDown(); }
        renderSidebarOnly();
        dispatchQueued(sess);
      },
      onToolStart: (name, detail) => {
        if (!mine()) return;
        // ask_agent is represented by the live teammate block the directory
        // opens, which carries the same question and far more: a tool card
        // beside it would show the exchange twice.
        if (name === "ask_agent") return;
        let path: string | undefined;
        try { path = JSON.parse(detail).path; } catch { /* not a path tool */ }
        store.pushTool(sess, name, detail, path);
        repaint();
      },
      onToolResult: (name, result) => {
        if (!mine()) return;
        if (name === "ask_agent") return;
        store.completeTool(sess, result);
        repaint();
      },
      onPlan: (steps) => {
        if (!mine()) return;
        store.setPlan(sess, steps);
        if (visible()) paintPlan();
      },
      onActivity: (mode, label) => { if (mine()) onThreadActivity(sess, mode, label); },
      onNotice: (text) => {
        if (!mine()) return;
        store.pushNotice(sess, text);
        repaint();
      },
      onError: (err) => {
        if (!mine()) return;
        store.pushError(sess, err);
        // "Compute error." is what the engine says when the graph did not run,
        // and it names no cause. Ask the backend what the engine's own log
        // says, then replace the three words in place. Asynchronous on
        // purpose: the turn must end now, whatever the log turns out to say.
        if (isEngineDecodeFailure(err)) explainEngineFailure(sess, err).catch(() => undefined);
        // Persist what the model context really holds, or reopening the
        // thread would replay a history missing the last exchange.
        store.syncHistory(sess, inst.history(), inst.summary());
        store.save(sess.conv, true);
        sess.generating = false;
        if (sess.genStats) sess.genStats.endMs = Date.now();
        sess.activity = null;
        for (const w of sess.waiters.splice(0)) w(`error: ${err}`);
        if (visible()) {
          hideActivity();
          setSendState(false);
        }
        if (visible() || blockVisible()) { paintChat(); scrollChatDown(); }
        renderSidebarOnly();
        // Queued messages still run, one per turn: each gets its answer or
        // its own error, and the queue always drains.
        dispatchQueued(sess);
      },
      askPermission: (req) => {
        // A stale agent must not pop dialogs over the new thread.
        if (!mine()) return Promise.resolve("deny" as PermissionDecision);
        // The request is filed under THIS thread whether or not it is the one
        // on screen: a teammate working in the background still gets its
        // dialog, in turn, named, and cancellable with that thread's Stop.
        return askPermission(req, sess.key, threadLabel(sess));
      },
    },
    server.port,
    sess.sub ? "sub" : "main"
  );
  sess.agent = inst;
  // The conversation's own agent has a short stable name for the team: a
  // teammate's thread showing "from « Monte une equipe de trois sous-agents
  // pour concevoir un peti »" says nothing useful.
  inst.setIdentity(
    sess.conv.id,
    sess.sub ? sess.sub.id : sess.conv.id,
    sess.sub ? sess.sub.name : t("team.parentName")
  );
  // Procedural memory: this Agent runs in front of a human who answers the
  // permission dialogs. See learned.ts, section ORIGIN. Without this line the
  // Agent keeps its strict default and every skill it writes is described as
  // unattended, which is the safe way to be wrong.
  inst.setOrigin("conversation");
  applyAutonomy();
  if (sess.sub) {
    // A teammate's persona IS its brief: it never inherits the conversation's
    // task persona, or every member of the team would answer the same way.
    inst.setTaskSystem(teammateSystem(sess.sub), 0.4);
  } else {
    applyTaskPersona();
  }
  // Restore this thread's context, then load memory/skills/connectors BEFORE
  // the first turn, otherwise the first message runs without any of them.
  if (sess.data.history.length) inst.loadHistory(sess.data.history, sess.data.contextSummary);
  try {
    const [mem, s, tools, skills, kbFolders] = await Promise.all([
      api.memoryRead(), api.settingsGet(), api.mcpTools(), api.skillsList(),
      api.kbFolders().catch(() => [] as string[]),
    ]);
    if (!mine()) return;
    const memOn = s["memory_on"] !== "0";
    inst.setMemory(memOn ? mem : "", !!(s["obsidian_vault"] && s["obsidian_vault"].length));
    inst.setMcpTools(tools);
    inst.setSkills(skills.filter((k) => !skillsOff.has(k.name)));
    inst.setKnowledge(kbFolders.length > 0);
  } catch {
    /* the agent still works without memory/MCP/skills */
  }
}

/** Standing persona of a teammate: who it is, and how it must report. */
function teammateSystem(sub: SubAgent): string {
  return (
    `You are "${sub.name}", a member of a Galactus team working for the user on one job. ` +
    `Your responsibility: ${sub.role || "as briefed below"}.\n\n` +
    `Your brief:\n${sub.brief}\n\n` +
    "Stay inside your responsibility. Work with your tools and cite a source (URL, file path or command) for anything " +
    "a tool told you. Answer whoever asks you with a compact, self-contained result, and say explicitly what you could " +
    "not verify instead of guessing. Match the effort to the question: when it can be answered directly, answer it " +
    "directly, without publishing a plan and without running tools you do not need. Somebody is blocked waiting for you."
  );
}

/** Human name of a conversation. */
function convLabel(conv: Conversation): string {
  return conv.title.trim() || t("conv.untitled");
}

/** Human name of a thread: the conversation's title, or the teammate's name. */
function threadLabel(th: Thread): string {
  return th.sub ? th.sub.name : convLabel(th.conv);
}

/**
 * Read the task from the message and act on it before the turn starts.
 * Persona changes are free and applied silently. A model reload is not: it is
 * only performed on its own when the running model is genuinely unfit AND the
 * detection is confident; a mere "a better model exists" is always an offer.
 */
async function autoRouteTask(text: string): Promise<void> {
  const mode = getAutoMode();
  if (mode === "off") return;

  const detection = detectTask(text, taskId);
  const prefs: Record<string, string[]> = {};
  for (const td of tasks) prefs[td.id] = td.models;
  const plan = planSwap(detection, prefs, installedIds(), server.model_id ?? null);

  // Free part: follow the detected task's persona.
  if (plan.task !== taskId && detection.confidence >= 0.45) {
    taskId = plan.task;
    setCurrentTask(taskId);
    applyTaskPersona();
    const td = tasks.find((x) => x.id === taskId);
    store.pushNotice(store.mainThread(store.current()), t("auto.switched").replace("%s", td?.label ?? taskId));
  }

  if (!plan.modelId) return;
  const m = registry.find((r) => r.id === plan.modelId);
  const name = m?.name ?? plan.modelId;

  if (mode === "auto" && mayAutoSwap(plan)) {
    // Costly but warranted: tell the user what is happening, then reload.
    // The engine goes away, so EVERY live thread stops, not just this one.
    store.pushNotice(store.mainThread(store.current()), t("auto.swapping").replace("%s", name));
    paintChat();
    stopAllThreads();
    try {
      serverFail = null;
      if (server.running) await api.serverStop();
      await api.serverStart(plan.modelId, null);
      await waitServerReady(180);
    } catch (e: any) {
      store.pushError(store.mainThread(store.current()), String(e?.message ?? e));
    }
    await refreshServer();
    render();
    return;
  }
  // Otherwise: offer, never impose.
  taskOffer = { modelId: plan.modelId, modelName: name };
}

/** Poll until the freshly started server answers, so the turn can proceed. */
async function waitServerReady(seconds: number): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    await refreshServer();
    if (server.phase === "ready") return;
    if (server.phase === "failed") throw new Error(t("srvfail.title"));
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error(t("auto.swapTimeout"));
}

let submitting = false;

async function submitChat(): Promise<void> {
  const input = document.getElementById("ci") as HTMLTextAreaElement | null;
  const sess = active();
  if (sess.generating) {
    // While the model writes, a typed message queues for the next turn and
    // shows in the log right away; with an empty composer the button stays
    // the stop control. The queue is this conversation's, not the app's.
    const queued = input?.value.trim() ?? "";
    if (queued && input) {
      input.value = "";
      input.style.height = "";
      input.dispatchEvent(new Event("input"));
      sess.queued.push(queued);
      store.pushUser(sess, queued);
      paintChat();
      scrollChatDown();
    } else {
      stopThread(sess);
    }
    return;
  }
  if (submitting) return; // autoRouteTask below can await a model swap for minutes
  if (!input) return;
  const text = input.value.trim();
  if (!text || !(server.running && server.phase === "ready")) return;
  // Clear the input BEFORE the await: autoRouteTask may re-render the view
  // and the captured node would be a detached ghost.
  input.value = "";
  input.style.height = "";
  submitting = true;
  try {
    await autoRouteTask(text);
  } finally {
    submitting = false;
  }
  if (!(server.running && server.phase === "ready")) {
    // Swap failed: give the user their message back instead of losing it.
    const fresh = document.getElementById("ci") as HTMLTextAreaElement | null;
    if (fresh) { fresh.value = text; fresh.dispatchEvent(new Event("input")); }
    return;
  }
  // The thread may have changed while the swap was awaited.
  //
  // Mentions are resolved HERE, not inside the Agent: what the user sees in
  // the log is the sentence they wrote, and the attached bodies ride with the
  // turn. The budget is a third of the live window, the same share agent.ts
  // gives one tool result, so a mention can never crowd out the conversation.
  await dispatchTurn(active(), await withMentions(text), { show: true });
}

/**
 * Attach the files and symbols the user pointed at with "@".
 *
 * Confinement, budgeting and the wording of every omission live in mentions.ts,
 * which is pure and unit tested; this wrapper only supplies the live window
 * size and a reader bound to the open workspace. With no workspace open there
 * is nothing a mention could name, so the text goes through untouched rather
 * than being parsed against a root that does not exist.
 */
async function withMentions(text: string): Promise<string> {
  const root = codeview.codeRoot();
  if (!root) return text;
  let ctx = 32768;
  try {
    ctx = await fetchCtxSize(server.port);
  } catch {
    // The default is a deliberate floor, not a guess gone wrong: a mention
    // budget computed from a context size nobody could read would be worse.
  }
  const budget = Math.max(512, Math.floor(ctx * 0.3));
  try {
    const out = await resolveMentions(
      text,
      { read: (rel) => api.codeRead(root, rel).catch(() => null) },
      budget
    );
    return out.text;
  } catch {
    // A failed attachment must never eat the turn: the model still gets the
    // question, and the mention tokens in it tell it what to read_file.
    return text;
  }
}

interface TurnOptions {
  /** Push the user bubble; a queued message was already shown. */
  show?: boolean;
  /** Set when a teammate or the parent agent sent this message. */
  from?: string;
  /** Delegation chain of this turn, caller first. */
  chain?: string[];
  /**
   * The caller already holds a decode slot and is blocked waiting for us, so
   * this turn runs under it instead of taking a second one. Without this a
   * one-slot engine would deadlock on the very first delegation.
   */
  borrowSlot?: boolean;
}

/**
 * Run one turn of one thread. Concurrency is bounded here and only here: a
 * turn waits for a free engine decode slot before it starts, so the app never
 * asks the server for more streams than it was started with.
 */
async function dispatchTurn(sess: Thread, text: string, opts: TurnOptions = {}): Promise<void> {
  const visible = () => sess.key === active().key;
  const shown = () => visible() || (!!sess.sub && active().key === threadKey(sess.conv.id));
  // A stop from a PREVIOUS turn must not cancel this one.
  sess.cancelPending = false;
  sess.generating = true;
  sess.touched = Date.now();
  if (visible()) setSendState(true);
  if (opts.show) store.pushUser(sess, text, opts.from);
  sess.genStats = { chars: 0, startMs: Date.now(), endMs: null };
  if (shown()) { paintChat(); scrollChatDown(); }
  renderSidebarOnly();
  // Immediate feedback: the scene shows BEFORE agent setup (memory, skills,
  // connectors on the first turn) and before the server's first token.
  onThreadActivity(sess, "thinking");

  if (!opts.borrowSlot) {
    if (slotsInUse >= engineSlots()) onThreadActivity(sess, "thinking", t("px.queued"));
    await acquireSlot();
    sess.holdsSlot = true;
    // Stop may have been pressed while this turn sat in the queue. It had no
    // agent to receive it, so the press left a mark here instead.
    if (sess.cancelPending) {
      sess.cancelPending = false;
      sess.holdsSlot = false;
      sess.generating = false;
      sess.activity = null;
      releaseSlot();
      if (visible()) { hideActivity(); setSendState(false); }
      if (shown()) paintChat();
      renderSidebarOnly();
      for (const w of sess.waiters.splice(0)) w("(stopped before it started)");
      return;
    }
    onThreadActivity(sess, "thinking");
  }
  try {
    // A model swap or an engine stop can land while a slot was awaited.
    if (!(server.running && server.phase === "ready")) {
      store.pushError(sess, t("chat.noserver"));
      sess.generating = false;
      sess.activity = null;
      if (visible()) { hideActivity(); setSendState(false); }
      if (shown()) paintChat();
      for (const w of sess.waiters.splice(0)) w(`error: ${t("chat.noserver")}`);
      return;
    }
    await ensureAgent(sess);
    const inst = sess.agent;
    if (!inst) return;
    inst.setChain(opts.chain ?? []);
    // One-shot: whatever branch wins, the deep-research arm is consumed. It
    // only ever belongs to a turn the user typed, never to a delegated one.
    const wantDeep = deepResearch && !opts.from;
    if (!opts.from) {
      deepResearch = false;
      document.getElementById("deepbtn")?.classList.remove("on");
    }
    // "/skill rest…" routes through the named skill's instructions.
    const slash = text.match(/^\/([\w-]+)\s*([\s\S]*)$/);
    if (slash && slashSkills.some((sk) => sk.name === slash[1])) {
      await inst.sendSkill(slash[1], slash[2]);
    } else if (wantDeep && slashSkills.some((sk) => sk.name === "recherche-sourcee")) {
      await inst.sendSkill("recherche-sourcee", text);
    } else {
      await inst.send(text);
    }
  } finally {
    if (sess.holdsSlot) { sess.holdsSlot = false; releaseSlot(); }
  }
}

/** After a turn ends (done or error), a queued message starts the next one. */
function dispatchQueued(sess: Thread): void {
  const next = sess.queued.shift();
  if (next) {
    // Its turn has come: the bubble stops saying it is waiting.
    store.clearQueuedMark(sess, next);
    void dispatchTurn(sess, next, {});
  } else renderSidebarOnly();
}

// ---------- the team (spawn_agent / list_agents / ask_agent) ----------
//
// ask_agent is BLOCKING by design: an agent asked a teammate a question and
// the answer belongs in the same turn, as the tool result the user can read.
// The wait is bounded (DELEGATION_TIMEOUT_MS); on expiry the caller is told so
// and the teammate keeps working rather than being killed mid-thought.
//
// The exchange is visible on both sides: the message lands in the teammate's
// own thread as a bubble tagged with the sender's name, and a live block
// opens in the sender's thread, filled in place when the answer returns and
// clickable straight through to the teammate's thread.

/**
 * How long a caller blocks on a teammate. Generous on purpose: a teammate is
 * a full agent running on a local model at a few tens of tokens per second,
 * and a real task takes minutes. The user is never blind while it runs (the
 * block shows the teammate's live state and opens its thread), so the bound
 * exists to guarantee the caller's turn ends, not to keep it short. Measured
 * at 300 s first: an ordinary "propose a schema" ask blew through it while
 * the teammate was still working normally.
 */
const DELEGATION_TIMEOUT_MS = 900_000;

function memberOf(th: Thread): TeamMember {
  return {
    id: th.sub ? th.sub.id : th.conv.id,
    name: th.sub ? th.sub.name : t("team.parentName"),
    role: th.sub ? th.sub.role : t("team.parentRole"),
    busy: th.generating,
    messages: th.data.items.length,
  };
}

const teamDirectory: AgentDirectory = {
  team(convId): TeamMember[] {
    const conv = store.get(convId);
    if (!conv) return [];
    // The conversation's own agent is listed too: a teammate must be able to
    // see who briefed it, even though it cannot delegate back up the chain.
    return [threadOf(conv), ...teamThreads(conv)].map(memberOf);
  },

  async spawn(convId, name, role, brief): Promise<TeamMember | string> {
    const conv = store.get(convId);
    if (!conv) return "this conversation is no longer live";
    const sub = store.addSubAgent(conv, name, role, brief);
    if (!sub) return `the team is full (${store.teamLimit()} members); reuse one with ask_agent`;
    const th = threadOf(conv, sub);
    store.pushNotice(threadOf(conv), t("team.created").replace("%n", sub.name).replace("%r", sub.role || "-"));
    if (conv.id === store.current().id) { paintChat(); scrollChatDown(); }
    render();
    return memberOf(th);
  },

  async ask(convId, targetId, message, from, chain): Promise<string> {
    const conv = store.get(convId);
    if (!conv) return "error: this conversation is no longer live";
    if (targetId === conv.id) {
      return "error: that is the conversation's own agent, which answers the user; do your part and report back to whoever asked you";
    }
    const sub = store.findSubAgent(conv, targetId);
    if (!sub) return `error: teammate ${targetId} is gone`;
    const sess = threadOf(conv, sub);
    if (sess.generating) return `error: "${sub.name}" started working in the meantime`;
    const senderName = from.name || t("team.parentName");
    const caller = threads.get(threadKey(conv.id, from.id === conv.id ? null : from.id));
    sess.touched = Date.now();
    // The live block goes in the thread that ASKED, so the user watches the
    // teammate work from where the request came from and opens its thread
    // from there.
    if (caller) store.pushAgentBlock(caller, sub, message);
    if (conv.id === store.current().id) { paintChat(); scrollChatDown(); }
    renderSidebarOnly();

    const answer = await new Promise<string>((resolve) => {
      let settled = false;
      const once = (v: string) => { if (!settled) { settled = true; resolve(v); } };
      const timer = window.setTimeout(() => {
        once(
          `timed out after ${Math.round(DELEGATION_TIMEOUT_MS / 1000)} s: "${sub.name}" is still working. ` +
            "Its answer will appear in its own thread; carry on without it or ask again later."
        );
      }, DELEGATION_TIMEOUT_MS);
      sess.waiters.push((v) => { clearTimeout(timer); once(v); });
      // The caller is blocked inside a tool call and is not decoding, so this
      // turn runs under the slot it already holds.
      dispatchTurn(sess, message, { show: true, from: senderName, chain, borrowSlot: true })
        .then(() => {
          // Safety net: a turn that ended without going through
          // onAssistantDone (aborted, no agent) must never leave the caller
          // hanging until the timeout.
          clearTimeout(timer);
          once(store.lastAssistantText(sess.data) || "(this teammate produced no answer)");
        })
        .catch((e: any) => { clearTimeout(timer); once(`error: ${String(e?.message ?? e)}`); });
    });
    if (caller) store.completeAgentBlock(caller, sub.id, answer, answer.startsWith("error:"));
    store.save(conv, true);
    if (conv.id === store.current().id) { paintChat(); scrollChatDown(); }
    renderSidebarOnly();
    return answer;
  },
};

function argPreview(detail: string): string {
  try {
    const o = JSON.parse(detail);
    // A team card must show WHO and WHAT, not a raw payload.
    if (o.agent) return o.message ? `${String(o.agent)} · ${String(o.message)}` : String(o.agent);
    if (o.role && o.name) return `${String(o.name)} · ${String(o.role)}`;
    return o.path || o.command || o.query || o.note || o.name || o.id || detail;
  } catch { return detail; }
}
function prettyTool(name: string): string {
  const map: Record<string, string> = {
    read_file: t("tool.read"), write_file: t("tool.write"), list_directory: t("tool.list"),
    run_command: t("tool.run"), remember: t("tool.remember"), use_skill: t("tool.skill"),
    read_document: t("tool.doc"), run_workflow: t("tool.workflow"), fetch_url: t("tool.web"),
    search_knowledge: t("tool.kb"),
    obsidian_search: t("tool.osearch"), obsidian_read: t("tool.oread"), obsidian_append: t("tool.owrite"),
    obsidian_update: t("tool.oupdate"),
    spawn_agent: t("tool.spawnAgent"), list_agents: t("tool.listAgents"), ask_agent: t("tool.askAgent"),
    search_conversations: t("tool.convSearch"), read_conversation: t("tool.convRead"),
    search_workspace: t("tool.searchWorkspace"), find_files: t("tool.findFiles"),
  };
  if (map[name]) return map[name];
  if (name.startsWith("mcp__")) return name.split("__").slice(1).join(" · ");
  return name;
}

// ---------- install (volume choice + dual-SSD dialog) ----------

function startInstall(m: ModelEntry, volumes: InstallVolumes | null): void {
  installProgress.set(m.id, { pct: 0, label: "download" });
  render();
  // Errors raised before the install thread starts come back here, not
  // through the progress event: surface them and unfreeze the bar.
  api.installModel(m.id, volumes).catch((e: any) => {
    installProgress.delete(m.id);
    toast(String(e?.message ?? e));
    render();
  });
}

/** The candidate whose mount carries the Galactus root (longest prefix). */
function rootVolumeIndex(cands: VolumeInfo[]): number {
  if (!root) return -1;
  let best = -1;
  let bestLen = -1;
  cands.forEach((v, i) => {
    const mount = v.mount === "/System/Volumes/Data" ? "/" : v.mount;
    if (root!.startsWith(mount) && mount.length > bestLen) {
      best = i;
      bestLen = mount.length;
    }
  });
  return best;
}

/**
 * Volume detection drives what the dialog offers: one candidate shows the
 * plain mono install, two or more open the mono/dual choice with a real
 * bandwidth measure and the bottleneck verdict BEFORE confirming. The final
 * guard lives in the pipeline: a dual install whose slow SSD is under 35% of
 * the fast one falls back to mono on the fast SSD, with a warning.
 */
async function showInstallModal(m: ModelEntry): Promise<void> {
  // A dense model has no pack, so there is no pack to place: the dialog would
  // measure two SSDs, ask which should hold the halves of a file that will
  // never exist, and then be ignored by an installer that stops after the
  // download. Asking a question whose answer changes nothing is worse than not
  // asking: it teaches the reader that the choice does not matter.
  if (m.dense) {
    startInstall(m, null);
    return;
  }
  let vols: VolumeInfo[] = [];
  try {
    vols = await api.listVolumes();
  } catch {
    startInstall(m, null); // detection unavailable: classic install
    return;
  }
  const packGb = (m.expert_bytes_total ?? m.gguf_bytes ?? 0) / 1e9;
  const cands = vols.filter((v) => v.free_gb >= Math.max(0.32 * packGb + 2, 8));
  if (!cands.length) {
    toast(t("installdlg.noVolume"));
    return;
  }
  const single = cands.length === 1;
  let mode: "mono" | "dual" = "mono";
  const rootIdx = Math.max(rootVolumeIndex(cands), 0);
  let iSel = rootIdx;
  let eSel = cands.findIndex((_, i) => i !== iSel);
  const bw: (number | null)[] = cands.map(() => null);

  const mm = el(`<div class="modal-bd"><div class="modal">
    <h3>${esc(t("installdlg.title").replace("%s", m.name))}</h3>
    <div class="ps">${esc(t("installdlg.hint"))}</div>
    <div class="voldlg">
      ${single ? "" : `<div class="seg" id="mseg"><button data-m="mono" class="on">${esc(t("installdlg.mono"))}</button><button data-m="dual">${esc(t("installdlg.dual"))}</button></div>`}
      <div id="volsel"></div>
      <div class="bwline" id="bwline"></div>
      <div class="bwline warn" id="spaceline"></div>
    </div>
    <div class="acts">
      <button class="bs" data-x>${esc(t("installdlg.cancel"))}</button>
      <button class="bs" id="bwbtn">${esc(t("installdlg.measure"))}</button>
      <button class="bp" id="go">${esc(t("installdlg.install"))}</button>
    </div></div></div>`);

  const volsel = mm.querySelector<HTMLElement>("#volsel")!;
  const bwline = mm.querySelector<HTMLElement>("#bwline")!;
  const spaceline = mm.querySelector<HTMLElement>("#spaceline")!;
  const goBtn = mm.querySelector<HTMLButtonElement>("#go")!;
  const bwBtn = mm.querySelector<HTMLButtonElement>("#bwbtn")!;

  const optLabel = (v: VolumeInfo) =>
    `${v.name} · ${t("installdlg.free").replace("%s", String(v.free_gb))}`;
  const options = (sel: number, skip: number) =>
    cands
      .map((v, i) =>
        i === skip ? "" : `<option value="${i}" ${i === sel ? "selected" : ""}>${esc(optLabel(v))}</option>`
      )
      .join("");

  const paintVerdict = () => {
    if (mode === "dual" && bw[iSel] != null && bw[eSel] != null) {
      const a = bw[iSel]!;
      const b = bw[eSel]!;
      const parts = `${esc(cands[iSel].name)}: <b>${a.toFixed(1)}</b> ${esc("GB/s")} · ${esc(cands[eSel].name)}: <b>${b.toFixed(1)}</b> ${esc("GB/s")}`;
      const ok = Math.min(a, b) >= 0.35 * Math.max(a, b);
      bwline.classList.toggle("bad", !ok);
      bwline.innerHTML = `${parts}<br/>${esc(ok ? t("installdlg.verdictOk") : t("installdlg.verdictSlow"))}`;
    } else if (mode === "mono" && bw[iSel] != null) {
      bwline.classList.remove("bad");
      bwline.innerHTML = `${esc(cands[iSel].name)}: <b>${bw[iSel]!.toFixed(1)}</b> ${esc("GB/s")}`;
    } else {
      bwline.classList.remove("bad");
      bwline.textContent = "";
    }
  };

  const paintSpace = () => {
    // Rough per-volume needs: full pack in mono, the P0v2 shares in dual.
    let lacking: string | null = null;
    if (mode === "mono") {
      if (cands[iSel].free_gb < packGb + 2) lacking = cands[iSel].name;
    } else {
      if (cands[iSel].free_gb < 0.75 * packGb + 2) lacking = cands[iSel].name;
      else if (cands[eSel].free_gb < 0.32 * packGb + 2) lacking = cands[eSel].name;
    }
    spaceline.textContent = lacking ? t("installdlg.noSpace").replace("%s", lacking) : "";
    goBtn.disabled = lacking != null;
  };

  const paintSel = () => {
    if (mode === "mono") {
      volsel.innerHTML = single
        ? `<div class="fld"><small>${esc(t("installdlg.volume"))}</small><div class="volone">${esc(optLabel(cands[0]))}</div></div>`
        : `<div class="fld"><small>${esc(t("installdlg.volume"))}</small><select id="vi">${options(iSel, -1)}</select></div>`;
    } else {
      volsel.innerHTML = `
        <div class="fld"><small>${esc(t("installdlg.primary"))}</small><select id="vi">${options(iSel, -1)}</select></div>
        <div class="fld"><small>${esc(t("installdlg.secondary"))}</small><select id="ve">${options(eSel, iSel)}</select></div>`;
    }
    volsel.querySelector<HTMLSelectElement>("#vi")?.addEventListener("change", (e) => {
      iSel = Number((e.target as HTMLSelectElement).value);
      if (eSel === iSel) eSel = cands.findIndex((_, i) => i !== iSel);
      paintSel();
    });
    volsel.querySelector<HTMLSelectElement>("#ve")?.addEventListener("change", (e) => {
      eSel = Number((e.target as HTMLSelectElement).value);
      paintVerdict();
      paintSpace();
    });
    paintVerdict();
    paintSpace();
  };
  paintSel();

  mm.querySelector<HTMLElement>("#mseg")?.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("[data-m]") as HTMLElement | null;
    if (!b) return;
    mode = b.dataset.m as "mono" | "dual";
    mm.querySelectorAll<HTMLElement>("#mseg button").forEach((x) =>
      x.classList.toggle("on", x.dataset.m === mode)
    );
    paintSel();
  });

  bwBtn.addEventListener("click", async () => {
    bwBtn.disabled = true;
    bwline.classList.remove("bad");
    bwline.textContent = t("installdlg.measuring");
    const targets = mode === "dual" ? [iSel, eSel] : [iSel];
    try {
      for (const idx of targets) {
        bw[idx] = await api.volumeBandwidth(cands[idx].probe);
      }
      paintVerdict();
    } catch (e: any) {
      bwline.textContent = t("installdlg.measureFail").replace("%s", String(e?.message ?? e));
    }
    bwBtn.disabled = false;
  });

  goBtn.addEventListener("click", () => {
    const volumes: InstallVolumes | null =
      mode === "dual"
        ? { internal_dir: cands[iSel].dir, external_dir: cands[eSel].dir }
        : iSel === rootVolumeIndex(cands)
          ? null // classic location inside the Galactus folder
          : { internal_dir: cands[iSel].dir };
    mm.remove();
    startInstall(m, volumes);
  });
  mm.addEventListener("click", (e) => {
    const tg = e.target as HTMLElement;
    if (tg === mm || tg.closest("[data-x]")) mm.remove();
  });
  document.body.appendChild(mm);
}

// ---------- models ----------

/**
 * Discreet control that drops the measured tok/s of a model so its card falls
 * back to the estimate. Returns null when the model carries no measurement.
 *
 * settings.json exposes no key removal, so the key is blanked instead: boot()
 * only keeps a bench_* entry whose JSON holds a finite tps, and an empty value
 * fails that parse the same way a missing key would.
 */
function benchResetBtn(m: ModelEntry): HTMLButtonElement | null {
  if (!Number.isFinite(benchResults[m.id])) return null;
  const b = el(`<button class="bs bglyph" title="${esc(t("models.benchReset"))}">↺</button>`) as HTMLButtonElement;
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await api.settingsSet("bench_" + m.id, "");
    } catch (e: any) {
      b.disabled = false;
      toast(t("models.benchResetFail").replace("%s", String(e?.message ?? e)));
      return;
    }
    delete benchResults[m.id];
    toast(t("models.benchResetDone"), "ok");
    render();
  });
  return b;
}

/**
 * What this Mac IS, not only how much memory it was sold with.
 *
 * A 16 GB M1 and a 16 GB M4 Max used to render identically here, and on the
 * binned Max parts the GPU core count is the only reading that tells two chips
 * of the same name apart at all.
 *
 * Painted from the cached `hw` first so the bar is never empty, then repainted
 * from a fresh reading. The three live figures in it, what the Mac can spare
 * and whether it is on battery, are exactly the ones that go stale while the
 * user has the window open.
 */
function paintHwBar(bar: HTMLElement): void {
  const render = (info: HwInfo) => {
    const s = machineSummary(info);
    const gpu = s.gpuCores === null ? "" : `
      <div class="div"></div>
      <div class="st"><small>${esc(t("hw.gpu"))}</small><b>${esc(t("hw.gpuCores").replace("%n", String(s.gpuCores)))}</b></div>`;
    // Apple publishes no bandwidth figure for some chips and none at all for
    // any chip newer than this build. A blank is the honest rendering of that.
    const bandwidth = s.bandwidthGbs === null ? "" : `
      <div class="div"></div>
      <div class="st"><small>${esc(t("hw.bandwidth"))}</small><b>${s.bandwidthGbs} GB/s</b></div>`;
    bar.innerHTML = `
      <div class="ico">${I.chip}</div>
      <div class="st"><small>${esc(t("hw.chip"))}</small><b>${esc(s.chip || "Mac")}</b></div>
      ${gpu}
      <div class="div"></div>
      <div class="st"><small>${esc(t("hw.ram"))}</small><b>${s.ramGb} GB</b></div>
      ${bandwidth}
      <div class="div"></div>
      <div class="st" title="${esc(t("hw.budgetHint"))}"><small>${esc(t("hw.budget"))}</small><b>${s.budgetGb.toFixed(0)} GB</b></div>
      <div class="div"></div>
      <div class="st"><small>${esc(t("hw.disk"))}</small><b>${info.disk_free_gb} GB</b></div>
      <span class="grow"></span>
      <span class="note">${esc(s.onBattery ? t("hw.onBattery") : t("models.hwNote"))}</span>`;
  };
  if (hw) render(hw);
  void api
    .hwInfo()
    .then((fresh) => {
      hw = fresh;
      if (bar.isConnected) render(fresh);
    })
    .catch(() => undefined);
}

function modelsView(): HTMLElement {
  const wrap = el(`<div class="main">
    <div class="topbar" data-tauri-drag-region><span class="ttl">${esc(t("nav.models"))}</span><span class="sub">${esc(t("models.subtitle"))}</span></div>
    <div class="page">
      <div id="srvfail"></div>
      <div class="hwbar" id="hw"></div>
      <div class="grid2" id="grid"></div>
    </div></div>`);
  if (serverFail) {
    const slot = wrap.querySelector<HTMLElement>("#srvfail")!;
    slot.style.marginBottom = "16px";
    slot.appendChild(serverFailCard());
  }
  const hwbar = wrap.querySelector<HTMLElement>("#hw")!;
  paintHwBar(hwbar);
  const grid = wrap.querySelector<HTMLElement>("#grid")!;
  if (!registry.length) {
    grid.replaceWith(el(`<div class="empty-block"><span class="big">◇</span><b>${esc(t("models.empty"))}</b><span>${esc(t("models.emptyHint"))}</span></div>`));
    return wrap;
  }
  // The primary catalogue is an actionable recommendation, not a dump of the
  // registry. Models that fail certification or this Mac's unified-memory
  // floor are explained separately and never receive install/start controls.
  const available = registry.filter((m) => verdict(m).ok);
  const unavailable = registry.filter((m) => !verdict(m).ok);
  if (!available.length) {
    grid.replaceWith(el(`<div class="empty-block"><span class="big">◇</span><b>${esc(t("models.noneCompatible"))}</b><span>${esc(t("models.noneCompatibleHint"))}</span></div>`));
  }
  const maxTps = Math.max(
    ...available.map((m) => Math.max(expectedTps(m) ?? 0, benchResults[m.id] ?? 0)),
    1
  );
  for (const m of available) {
    const v = verdict(m);
    const certification = modelCertification(m.status);
    const certLabel = t(
      certification.badge === "composition"
        ? "models.certComposition"
        : certification.badge === "stock"
          ? "models.certStock"
          : certification.badge === "pending"
            ? "models.certPending"
            : certification.badge === "blocked"
              ? "models.certBlocked"
              : "models.certified"
    );
    const estimate = expectedTps(m);
    const measured = benchResults[m.id];
    const tps = measured ?? estimate; // a real measurement beats the interpolation
    const runningHere = server.running && server.model_id === m.id;
    const downloadable = hasVerifiedDownload(m.download);
    const prog = installProgress.get(m.id);
    const bar = tps ? Math.min(100, Math.max(6, (tps / maxTps) * 100)) : 0;
    const speedColor = !v.ok ? "var(--dim)" : "var(--acc-tx)";
    const card = el(`<div class="mcard ${certification.canExecute ? "" : "uncertified"}" data-mcard="${esc(m.id)}">
      <div class="top">
        <div class="info">
          <div class="nm"><b>${esc(m.name)}</b><span class="chip-cert ${certification.canExecute ? "" : "pending"}">${certification.canExecute ? "✓" : "◷"} ${esc(certLabel)}</span></div>
          <span class="meta">${esc(m.arch)} · ${fmtGb(m.gguf_bytes)} · ${m.experts_used ?? "?"}/${m.experts ?? "?"}</span>
        </div>
        <div class="spd"><b style="color:${speedColor}">${tps && v.ok ? (measured ? "" : "~") + tps.toFixed(0) : "·"}</b><small>${esc(v.ok ? t(measured ? "models.measured" : "models.onThisMac") : "·")}</small></div>
      </div>
      <div class="bar"><div style="width:${bar}%"></div></div>
      <div class="brief" data-brief="${esc(m.id)}"></div>
      <div class="foot"><span class="n" data-plabel>${prog ? `<b style="color:var(--acc-tx)">${Math.round(prog.pct)}%</b> · ${esc(installLabel(prog.label))}` : esc(v.note || (m.installed ? t("models.installed") : (m.arch + " · " + (m.experts_used ?? "?") + " active")))}</span><span data-a></span></div>
      ${prog ? `<div class="bar" data-prog style="margin-top:2px"><div style="width:${prog.pct}%"></div></div>` : ""}
    </div>`);
    const slot = card.querySelector<HTMLElement>("[data-a]")!;
    if (!v.ok) { /* no action */ }
    else if (prog) { const b = el(`<button class="bs">✕</button>`); b.addEventListener("click", () => api.cancelInstall(m.id)); slot.replaceWith(b); }
    else if (!m.installed && downloadable) {
      const b = el(`<button class="bp">${esc(t("models.download"))}</button>`);
      b.addEventListener("click", () => {
        void showInstallModal(m);
      });
      slot.replaceWith(b);
    } else if (!m.installed) {
      slot.replaceWith(el(`<span class="model-manual">${esc(t("models.manualInstall"))}</span>`));
    } else if (runningHere) {
      const box = el(`<span style="display:flex;gap:8px"></span>`);
      const bench = el(`<button class="bs">${esc(t("models.bench"))}</button>`) as HTMLButtonElement;
      bench.addEventListener("click", async () => {
        if (server.phase !== "ready") return;
        bench.disabled = true;
        bench.textContent = t("models.benchRunning");
        try {
          const r = await benchOnce(server.port);
          benchResults[m.id] = r.tps;
          await api.settingsSet("bench_" + m.id, JSON.stringify({ tps: r.tps, at: Date.now() }));
          toast(t("models.benchDone").replace("%s", r.tps.toFixed(1)), "ok");
        } catch (e: any) {
          toast(String(e?.message ?? e));
        }
        render();
      });
      const b = el(`<button class="bd">${esc(t("models.stop"))}</button>`);
      b.addEventListener("click", async () => {
        // A turn may be streaming: nulling the agent without resetting the
        // generating state would leave the chat locked on a dead stop control.
        // The engine is going away: no live thread can keep generating.
        stopAllThreads();
        await api.serverStop();
        await refreshServer();
        render();
      });
      const reset = benchResetBtn(m);
      if (reset) box.append(bench, reset, b);
      else box.append(bench, b);
      slot.replaceWith(box);
    } else {
      const box = el(`<span style="display:flex;gap:10px;align-items:center"></span>`);
      // Discreet delete with a two-step confirmation, like the file revert.
      const del = el(`<span class="link dellink">${esc(t("models.delete"))}</span>`);
      del.addEventListener("click", async () => {
        if (!del.dataset.armed) {
          del.dataset.armed = "1";
          del.textContent = t("models.deleteConfirm").replace("%s", fmtGb(m.gguf_bytes));
          setTimeout(() => {
            if (del.dataset.armed) { delete del.dataset.armed; del.textContent = t("models.delete"); }
          }, 4000);
          return;
        }
        delete del.dataset.armed;
        del.textContent = t("models.deleting");
        try {
          const summary = await api.deleteModel(m.id);
          delete benchResults[m.id];
          toast(summary, "ok");
        } catch (e: any) {
          toast(t("models.deleteFail").replace("%s", String(e?.message ?? e)));
        }
        try { registry = await api.registry(); } catch {}
        render();
      });
      const b = el(`<button class="bp">${esc(t("models.start"))}</button>`);
      b.addEventListener("click", async () => {
        try {
          serverFail = null;
          await api.serverStart(m.id, null);
          // The backend has now replaced the engine. No live thread may keep
          // a generation tied to the previous process.
          stopAllThreads();
          await refreshServer();
          render();
        } catch (e: any) {
          // A deterministic preflight leaves the previous server untouched.
          // If a later spawn failed after replacement began, reconcile the
          // UI with the real process state and release any stranded turns.
          await refreshServer().catch(() => undefined);
          if (!server.running) stopAllThreads();
          toast(String(e?.message ?? e));
        }
      });
      // Also offered when the model is stopped: a measurement outlives the run
      // that produced it, so it must be clearable without restarting the model.
      const reset = benchResetBtn(m);
      if (reset) box.append(del, reset, b);
      else box.append(del, b);
      slot.replaceWith(box);
    }
    grid.appendChild(card);
  }
  if (unavailable.length) {
    const locked = el(`<details class="model-locked">
      <summary>${esc(t("models.unavailable").replace("%n", String(unavailable.length)))}</summary>
      <div class="locked-list"></div>
    </details>`);
    const list = locked.querySelector<HTMLElement>(".locked-list")!;
    for (const m of unavailable) {
      const c = modelCertification(m.status);
      const label = c.badge === "pending"
        ? t("models.certPending")
        : c.badge === "blocked"
          ? t("models.certBlocked")
          : t("models.incompatible");
      list.appendChild(el(`<div class="locked-model">
        <span><b>${esc(m.name)}</b><small>${esc(verdict(m).note)}</small></span>
        <span class="chip-cert pending">${c.canExecute ? "!" : "◷"} ${esc(label)}</span>
      </div>`));
    }
    wrap.querySelector<HTMLElement>(".page")!.appendChild(locked);
  }
  void paintBriefs(wrap, available);
  return wrap;
}

/**
 * Fill in, on each card, the one sentence saying what this Mac will do with
 * this model.
 *
 * Asynchronous and best effort. The cards render first and stay usable if the
 * backend never answers: a recommendation that fails to arrive must leave the
 * catalogue exactly as it was, never an empty state or a spinner. Each answer
 * is written only if its card is still on screen, so a user who switches views
 * mid-flight does not repaint a detached node.
 *
 * No volumes are passed: this is the catalogue, where the question is what
 * would RUN, not where a pack would land. The install dialog is the surface
 * that has measured drives to reason about, and it asks for the layout there.
 */
async function paintBriefs(wrap: HTMLElement, models: ModelEntry[]): Promise<void> {
  for (const m of models) {
    let rec;
    try {
      rec = await api.recommendForModel(m.id);
    } catch {
      continue; // no recommendation is strictly better than a wrong one
    }
    // A command that RESOLVES with null gets past that catch, and machineBrief
    // reads rec.mode on its first line. The planner answers null whenever it has
    // nothing to say about a model, so this was a crash reachable from ordinary
    // data rather than from a fault, and it took the whole models page with it.
    // Same treatment as a throw: say nothing about this card.
    if (!rec) continue;
    // Matched on the dataset rather than through a selector built from the id:
    // a model id is registry data, and building a selector out of data is how
    // a quoting bug becomes a broken query.
    const slot = Array.from(wrap.querySelectorAll<HTMLElement>("[data-brief]")).find(
      (n) => n.dataset.brief === m.id,
    );
    if (!slot || !slot.isConnected) continue;
    const b = machineBrief(rec);
    // A refusal is rendered verbatim: the planner already wrote the only
    // sentence that carries the real numbers.
    const sentence = b.reason ? b.reason : t(b.key)
      .replace("%m", t(b.modeKey))
      .replace("%q", t(b.requestedModeKey))
      .replace("%n", String(b.slots))
      .replace("%r", b.residentGb.toFixed(1))
      .replace("%b", b.budgetGb.toFixed(1));
    slot.className = `brief ${b.tone}`;
    slot.textContent = sentence;
  }
}

// ---------- connectors ----------
function connectorsView(): HTMLElement {
  const wrap = el(`<div class="main">
    <div class="topbar" data-tauri-drag-region><span class="ttl">${esc(t("nav.connectors"))}</span><span class="sub">${esc(t("conn.subtitle"))}</span></div>
    <div class="page"><div class="hold"><div id="list"></div></div></div></div>`);
  const list = wrap.querySelector<HTMLElement>("#list")!;
  const lang = getLang();
  if (!CATALOG.length)
    list.appendChild(el(`<div class="empty-block" style="margin-bottom:14px"><span class="big">◌</span><b>${esc(t("conn.empty"))}</b><span>${esc(t("conn.emptyHint"))}</span></div>`));
  for (const p of CATALOG) list.appendChild(connectorRow(p, lang));
  // custom form (collapsed → dashed opener)
  const holder = el(`<div id="customholder"></div>`);
  const dashed = el(`<div class="dashed">${I.plus}<span>${esc(t("conn.custom"))}</span></div>`);
  dashed.addEventListener("click", () => { holder.innerHTML = ""; holder.appendChild(customForm(dashed, holder)); dashed.style.display = "none"; });
  list.appendChild(holder);
  list.appendChild(dashed);
  return wrap;
}
function connectorRow(p: ConnectorPreset, lang: Lang): HTMLElement {
  const active = enabled.find((e) => e.id === p.id);
  const row = el(`<div class="crow">
    <div class="top">
      <div class="cico">${p.icon}</div>
      <div class="ci"><b>${esc(p.name)}</b><span>${esc(p.desc[lang])}</span></div>
      <div class="tgl ${active ? "on" : ""}" data-t><div class="k"></div></div>
    </div>
    <div class="fields" data-f style="${active && p.fields.length ? "" : "display:none"}"></div>
  </div>`);
  const f = row.querySelector<HTMLElement>("[data-f]")!;
  if (active) for (const fld of p.fields) {
    const val = active.values[fld.key] ?? "";
    const box = el(`<div class="fld"><small>${esc(fld.label[lang])}</small><div class="fbox"><input type="${fld.kind === "secret" ? "password" : "text"}" placeholder="${esc(fld.placeholder ?? "")}"/>${fld.kind === "folder" ? `<span class="link" data-pick>${esc(t("conn.choose"))}</span>` : ""}</div></div>`);
    const inp = box.querySelector("input")!; inp.value = val;
    inp.addEventListener("change", async () => { active.values[fld.key] = inp.value.trim(); mcpCount = await saveEnabled(enabled); });
    box.querySelector("[data-pick]")?.addEventListener("click", async () => { const p2 = await pickFolderOrSay(); if (p2) { inp.value = p2; active.values[fld.key] = p2; mcpCount = await saveEnabled(enabled); } });
    f.appendChild(box);
  }
  row.querySelector("[data-t]")!.addEventListener("click", async (e) => {
    const tgl = e.currentTarget as HTMLElement;
    if (tgl.classList.contains("busy")) return;
    const activating = !active;
    // Optimistic visual + busy state: connecting an MCP server can take a
    // minute (first npx run downloads the package) and MUST show it.
    tgl.classList.add("busy");
    tgl.classList.toggle("on", activating);
    const previous = enabled;
    enabled = activating
      ? [...enabled, { id: p.id, values: {} }]
      : enabled.filter((x) => x.id !== p.id);
    try {
      mcpCount = await saveEnabled(enabled);
      if (activating) toast(t("conn.connected").replace("%s", p.name), "ok");
      render();
    } catch (err: any) {
      // Roll back both the state and the persisted config, and SAY IT.
      enabled = previous;
      await saveEnabled(enabled).catch(() => {});
      toast(t("conn.failed").replace("%s", String(err?.message ?? err)));
      render();
    }
  });
  return row;
}
function customForm(dashed: HTMLElement, holder: HTMLElement): HTMLElement {
  const form = el(`<div class="custom-form">
    <b style="font-size:13px">${esc(t("conn.customTitle"))}</b>
    <div class="g3">
      <div class="fld"><small>${esc(t("conn.customName"))}</small><input id="cn" placeholder="notion"/></div>
      <div class="fld"><small>${esc(t("conn.customCommand"))}</small><input id="cc" placeholder="npx"/></div>
      <div class="fld"><small>${esc(t("conn.customArgs"))}</small><input id="ca" placeholder="-y @notion/mcp"/></div>
    </div>
    <div style="display:flex;gap:9px"><button class="bp" id="cadd">${esc(t("conn.add"))}</button><button class="bs" id="ccancel">${esc(t("conn.cancel"))}</button></div>
  </div>`);
  form.querySelector("#ccancel")!.addEventListener("click", () => { holder.innerHTML = ""; dashed.style.display = "flex"; });
  form.querySelector("#cadd")!.addEventListener("click", async () => {
    const name = (form.querySelector<HTMLInputElement>("#cn")!.value || "").trim();
    const command = (form.querySelector<HTMLInputElement>("#cc")!.value || "").trim();
    const argStr = (form.querySelector<HTMLInputElement>("#ca")!.value || "").trim();
    if (!name || !command) return;
    enabled.push({ id: `custom:${name}`, values: {}, custom: { name, command, args: argStr ? argStr.split(/\s+/) : [] } });
    mcpCount = await saveEnabled(enabled);
    render();
  });
  return form;
}

// ---------- memory ----------
function memoryView(): HTMLElement {
  const wrap = el(`<div class="main">
    <div class="topbar" data-tauri-drag-region><span class="ttl">${esc(t("nav.memory"))}</span><span class="sub">${esc(t("mem.subtitle"))}</span></div>
    <div class="page"><div class="hold">
      <div class="sect"><b>${esc(t("sect.memory"))}</b><span>${esc(t("sect.memoryHint"))}</span></div>
      <div class="card">
        <div class="hd"><div class="grow"><b>${esc(t("mem.enable"))}</b><span class="d">${esc(t("mem.enableHint"))}</span></div><div class="tgl" id="memtog"><div class="k"></div></div></div>
        <div id="membody" style="display:none;flex-direction:column;gap:14px">
          <div style="display:flex;align-items:center;gap:14px;padding:12px 13px;border-radius:10px;background:rgba(255,255,255,.025);border:1px solid var(--bd)">
            <span style="font-size:12px;color:var(--dim2)">${esc(t("mem.scope"))}</span>
            <div class="seg" id="scope"><button data-s="global">${esc(t("mem.scopeGlobal"))}</button><button data-s="workspace">${esc(t("mem.scopeWorkspace"))}</button></div>
            <div class="inset-input" id="wsrow" style="flex:1;display:none"><input id="wspath" readonly placeholder="${esc(t("mem.workspaceNone"))}"/><span class="link" id="wspick">${esc(t("mem.change"))}</span></div>
            <span id="scopehint" style="flex:1;font-size:11.5px;color:var(--dim3)">${esc(t("mem.scopeGlobalHint"))}</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:8px">
            <div style="display:flex;align-items:center;gap:8px"><span style="font-size:11px;color:var(--dim)">${esc(t("mem.content"))}</span><span class="grow" style="flex:1"></span><span class="link" id="memsave">${esc(t("mem.save"))}</span></div>
            <textarea class="mem" id="memtext" rows="7"></textarea>
          </div>
        </div>
      </div>
      <div class="sect"><b>${esc(t("sect.knowledge"))}</b><span>${esc(t("sect.knowledgeHint"))}</span></div>
      <div class="card">
        <div class="hd"><div class="cico">⌘</div><div class="grow"><b>${esc(t("kb.title"))}</b><span class="d" id="kbstats">${esc(t("kb.hint"))}</span></div>
          <button class="bs" id="kbadd">${esc(t("kb.add"))}</button>
          <button class="bp" id="kbreindex">${esc(t("kb.reindex"))}</button>
        </div>
        <div id="kbfolders" style="display:flex;flex-direction:column;gap:6px"></div>
      </div>
      <div class="sect"><b>${esc(t("sect.obsidian"))}</b><span>${esc(t("sect.obsidianHint"))}</span></div>
      <div class="card">
        <div class="hd"><div class="cico">◈</div><div class="grow"><b>Obsidian</b><span class="d" id="vaultline">${esc(t("mem.vaultNone"))}</span></div><button class="bs" id="vcosmos">${esc(t("mem.cosmos"))}</button><button class="bs" id="vnew">${esc(t("mem.newVault"))}</button><button class="bs" id="vpick">${esc(t("mem.chooseVault"))}</button></div>
      </div>
    </div></div></div>`);

  const tog = wrap.querySelector<HTMLElement>("#memtog")!;
  const body = wrap.querySelector<HTMLElement>("#membody")!;
  const memtext = wrap.querySelector<HTMLTextAreaElement>("#memtext")!;
  const scope = wrap.querySelector<HTMLElement>("#scope")!;
  const wsrow = wrap.querySelector<HTMLElement>("#wsrow")!;
  const wspath = wrap.querySelector<HTMLInputElement>("#wspath")!;
  const scopehint = wrap.querySelector<HTMLElement>("#scopehint")!;
  const vaultline = wrap.querySelector<HTMLElement>("#vaultline")!;

  function paintScope(s: string) {
    scope.querySelectorAll("button").forEach((b) => b.classList.toggle("on", (b as HTMLElement).dataset.s === s));
    wsrow.style.display = s === "workspace" ? "flex" : "none";
    scopehint.style.display = s === "workspace" ? "none" : "block";
  }
  Promise.all([api.settingsGet(), api.memoryRead()]).then(([s, mem]) => {
    const on = s["memory_on"] !== "0";
    tog.classList.toggle("on", on); body.style.display = on ? "flex" : "none";
    memtext.value = mem;
    wspath.value = s["workspace"] ?? "";
    if (s["obsidian_vault"]) vaultline.textContent = s["obsidian_vault"];
    paintScope(s["memory_scope"] === "workspace" ? "workspace" : "global");
  });
  tog.addEventListener("click", async () => { tog.classList.toggle("on"); const on = tog.classList.contains("on"); body.style.display = on ? "flex" : "none"; await api.settingsSet("memory_on", on ? "1" : "0"); });
  scope.addEventListener("click", async (e) => { const b = (e.target as HTMLElement).closest("[data-s]") as HTMLElement | null; if (!b) return; paintScope(b.dataset.s!); await api.settingsSet("memory_scope", b.dataset.s!); memtext.value = await api.memoryRead(); });
  wrap.querySelector("#wspick")!.addEventListener("click", async () => { const p = await pickFolderOrSay(); if (p) { wspath.value = p; await api.settingsSet("workspace", p); memtext.value = await api.memoryRead(); } });
  {
    const b = wrap.querySelector<HTMLElement>("#memsave")!;
    b.addEventListener("click", async () => {
      await api.memoryWrite(memtext.value);
      const prev = b.textContent;
      b.textContent = t("mem.saved");
      setTimeout(() => { b.textContent = prev; }, 1500);
    });
  }
  wrap.querySelector("#vpick")!.addEventListener("click", async () => { const p = await pickFolderOrSay(); if (p) { vaultline.textContent = p; await api.settingsSet("obsidian_vault", p); } });
  wrap.querySelector("#vcosmos")!.addEventListener("click", () => { openCosmos(); });
  wrap.querySelector("#vnew")!.addEventListener("click", async () => {
    const p = await pickFolderOrSay();
    if (!p) return;
    try {
      const created = await api.obsidianCreateVault(p);
      vaultline.textContent = created;
      toast(t("mem.vaultCreated"), "ok");
    } catch (e: any) {
      toast(String(e?.message ?? e));
    }
  });

  // ---- knowledge folders ----
  {
    const foldersBox = wrap.querySelector<HTMLElement>("#kbfolders")!;
    const statsLine = wrap.querySelector<HTMLElement>("#kbstats")!;
    let kbList: string[] = [];
    const paintKb = () => {
      foldersBox.innerHTML = "";
      if (!kbList.length) {
        foldersBox.appendChild(
          el(`<div class="empty-block small" style="width:100%"><span>${esc(t("kb.empty"))}</span></div>`)
        );
        return;
      }
      for (const f of kbList) {
        const row = el(`<div class="kbrow"><span class="mono">${esc(f)}</span><span class="cx" data-del title="✕">×</span></div>`);
        row.querySelector("[data-del]")!.addEventListener("click", async () => {
          kbList = kbList.filter((x) => x !== f);
          await api.kbSetFolders(kbList);
          for (const th of threads.values()) th.agent?.setKnowledge(kbList.length > 0);
          paintKb();
        });
        foldersBox.appendChild(row);
      }
    };
    api.kbFolders().then((f) => { kbList = f; paintKb(); }).catch(() => paintKb());
    api.kbStats().then((s) => {
      if (s) statsLine.textContent = t("kb.stats").replace("%f", String(s.files)).replace("%c", String(s.chunks));
    }).catch(() => {});
    wrap.querySelector("#kbadd")!.addEventListener("click", async () => {
      const p = await pickFolderOrSay();
      if (!p || kbList.includes(p)) return;
      kbList.push(p);
      await api.kbSetFolders(kbList);
      for (const th of threads.values()) th.agent?.setKnowledge(true);
      paintKb();
    });
    const reBtn = wrap.querySelector<HTMLButtonElement>("#kbreindex")!;
    reBtn.addEventListener("click", async () => {
      reBtn.disabled = true;
      const prev = reBtn.textContent;
      reBtn.textContent = t("kb.reindexing");
      try {
        const s = await api.kbReindex();
        statsLine.textContent = t("kb.stats").replace("%f", String(s.files)).replace("%c", String(s.chunks));
        toast(t("kb.done").replace("%f", String(s.files)).replace("%c", String(s.chunks)), "ok");
      } catch (e: any) {
        toast(String(e?.message ?? e));
      }
      reBtn.disabled = false;
      reBtn.textContent = prev;
    });
  }
  return wrap;
}

// ---------- Obsidian constellation (cosmos.ts) ----------
async function openCosmos(): Promise<void> {
  let data;
  try {
    data = await api.obsidianGraph();
  } catch (e: any) {
    toast(String(e?.message ?? e));
    return;
  }
  if (!data.nodes.length) {
    toast(t("cosmos.empty"));
    return;
  }
  const overlay = el(`<div class="cosmos">
    <div class="cosmos-head" data-tauri-drag-region>
      <img class="mark" src="${LOGO}" alt=""/>
      <b>${esc(t("cosmos.title"))}</b>
      <span class="sub">${esc(t("cosmos.sub").replace("%n", String(data.nodes.length)).replace("%e", String(data.edges.length)))}</span>
      <span class="grow"></span>
      <span class="hint">${esc(t("cosmos.hint"))}</span>
      <button class="bs" data-close>${esc(t("common.close"))}</button>
    </div>
    <div class="cosmos-body"></div>
    <div class="cosmos-note" id="cnote" style="display:none">
      <div class="cn-head"><b id="cntitle"></b><span class="grow"></span>
        <button class="bp" id="cnsave">${esc(t("cosmos.save"))}</button>
        <button class="bs" id="cnclose">×</button>
      </div>
      <textarea id="cntext" spellcheck="false"></textarea>
    </div>
  </div>`);
  document.body.appendChild(overlay);
  const body = overlay.querySelector<HTMLElement>(".cosmos-body")!;

  // ---- panneau note : lecture + édition + sauvegarde ----
  const notePanel = overlay.querySelector<HTMLElement>("#cnote")!;
  const noteTitle = overlay.querySelector<HTMLElement>("#cntitle")!;
  const noteText = overlay.querySelector<HTMLTextAreaElement>("#cntext")!;
  const noteSave = overlay.querySelector<HTMLButtonElement>("#cnsave")!;
  let notePath: string | null = null;
  const openNote = async (name: string, path: string) => {
    try {
      const content = await api.obsidianRead(path);
      notePath = path;
      noteTitle.textContent = name;
      noteText.value = content;
      notePanel.style.display = "flex";
    } catch (e: any) {
      toast(String(e?.message ?? e));
    }
  };
  noteSave.addEventListener("click", async () => {
    if (!notePath) return;
    noteSave.disabled = true;
    try {
      await api.obsidianWrite(notePath, noteText.value);
      toast(t("cosmos.saved").replace("%s", noteTitle.textContent ?? ""), "ok");
    } catch (e: any) {
      toast(String(e?.message ?? e));
    }
    noteSave.disabled = false;
  });
  overlay.querySelector("#cnclose")!.addEventListener("click", () => {
    notePanel.style.display = "none";
    notePath = null;
  });

  let viz: Cosmos | null = null;
  try {
    viz = new Cosmos(body, data, (name, path) => { void openNote(name, path); });
  } catch (e: any) {
    overlay.remove();
    toast(String(e?.message ?? e));
    return;
  }
  const close = () => {
    viz?.destroy();
    overlay.remove();
    window.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    // Échap ferme d'abord la note, puis la constellation.
    if (notePanel.style.display !== "none") {
      notePanel.style.display = "none";
      notePath = null;
    } else {
      close();
    }
  };
  window.addEventListener("keydown", onKey);
  overlay.querySelector("[data-close]")!.addEventListener("click", close);
}

// ---------- agent (workspace + autonomy + skills) ----------
function agentView(): HTMLElement {
  const wrap = el(`<div class="main">
    <div class="topbar" data-tauri-drag-region><span class="ttl">${esc(t("nav.agent"))}</span><span class="sub">${esc(t("agent.subtitle"))}</span></div>
    <div class="page"><div class="hold">
      <div class="card">
        <div class="hd"><div class="grow"><b>${esc(t("agent.workspaceTitle"))}</b><span class="d">${esc(t("agent.workspaceDesc"))}</span></div></div>
        <div style="display:flex;align-items:center;gap:10px">
          <div class="inset-input" style="flex:1;height:36px"><span style="flex:none">${I.folder}</span><input id="wspath" readonly placeholder="${esc(t("agent.workspaceNone"))}"/></div>
          <button class="bs" id="wspick">${esc(t("common.choose"))}</button>
        </div>
      </div>
      <div class="card">
        <div class="hd"><div class="grow"><b>${esc(t("agent.autonomyTitle"))}</b><span class="d">${esc(t("agent.autonomyDesc"))}</span></div></div>
        <div class="g3" id="auton"></div>
      </div>
      <div class="card">
        <div class="hd"><div class="grow"><b>Skills</b><span class="d">${esc(t("agent.skillsDesc"))}</span></div></div>
        <div class="skgrid" id="skills"></div>
      </div>
    </div></div></div>`);

  const wspath = wrap.querySelector<HTMLInputElement>("#wspath")!;
  api.settingsGet().then((s) => { wspath.value = s["workspace"] ?? ""; });
  wrap.querySelector("#wspick")!.addEventListener("click", async () => { const p = await pickFolderOrSay(); if (p) { wspath.value = p; await api.settingsSet("workspace", p); render(); } });

  const modes: { id: Autonomy; name: string; desc: string }[] = [
    { id: "manual", name: t("mode.manual"), desc: t("agent.manualDesc") },
    { id: "assisted", name: t("mode.assisted"), desc: t("agent.assistedDesc") },
    { id: "autonomous", name: t("mode.autonomous"), desc: t("agent.autonomousDesc") },
  ];
  const autonBox = wrap.querySelector<HTMLElement>("#auton")!;
  for (const md of modes) {
    const c = el(`<div class="auton ${autonomy === md.id ? "on" : ""}"><div class="r"><span class="rd"></span><b>${esc(md.name)}</b></div><div class="d">${esc(md.desc)}</div></div>`);
    c.addEventListener("click", async () => { autonomy = md.id; await api.settingsSet("autonomy", autonomy); applyAutonomy(); render(); });
    autonBox.appendChild(c);
  }

  const skBox = wrap.querySelector<HTMLElement>("#skills")!;
  api.skillsList().then((skills) => {
    if (!skills.length) {
      skBox.innerHTML = `<div class="empty-block small" style="grid-column:1/-1"><span>${esc(t("agent.skillsEmpty"))}</span></div>`;
      return;
    }
    for (const k of skills) {
      const on = !skillsOff.has(k.name);
      const c = el(`<div class="skcard"><div class="kico">📖</div><div class="ki"><b>${esc(k.name)}</b><span>${esc(k.description || "·")}</span></div><div class="tgl sm ${on ? "on" : ""}" data-t><div class="k"></div></div></div>`);
      c.querySelector("[data-t]")!.addEventListener("click", async () => {
        if (skillsOff.has(k.name)) skillsOff.delete(k.name); else skillsOff.add(k.name);
        await api.settingsSet("skills_off", JSON.stringify([...skillsOff]));
        const fresh = (await api.skillsList()).filter((s) => !skillsOff.has(s.name));
        for (const th of threads.values()) th.agent?.setSkills(fresh);
        slashSkills = fresh;
        render();
      });
      skBox.appendChild(c);
    }
  });
  return wrap;
}

// ---------- settings ----------
// ---------- updates ----------
//
// AUTOMATIC OR MANUAL, and why it is both.
//
// The two halves of an update are not the same decision and they do not get
// the same answer.
//
// The CHECK is automatic, once, a few seconds after launch, in assistant mode
// only. Manual-only checking sounds safer and is not: this project ships a
// version a day, the check lives at the bottom of a settings page, and a
// button nobody presses is a fleet that never updates. What the check does is
// one HTTPS GET of a 8 kB JSON file; it downloads nothing, writes nothing and
// changes nothing, and if it fails it fails silently, because a machine that
// happens to be offline at launch has not done anything wrong.
//
// The INSTALL is manual, always, in both modes. It replaces the running
// application and then relaunches the process, and this process is where the
// agent loop that drives runs lives. There is no schedule, no idle timer and
// no "install on quit" path: the only thing that starts a download is the
// button, and the only thing that restarts Galactus is the second button after
// the download.
//
// SERVER MODE, which is what the whole shape is for. A Mac in server mode
// hosts a model for other machines and runs scheduled jobs with its window
// hidden behind a menu bar item. It gets NO automatic check at all: an offer
// on a screen nobody is watching is an offer that can only be answered by
// accident, and until it is answered it is a banner sitting on top of a
// working machine. Someone who wants the new version opens the window and
// presses Check now, which is exactly the act of a human being present.
//
// And under both of those, one rule with a test: restartVerdict. A restart
// needs a human AND an idle scheduler. A run that is halfway through has
// already written files and already spent an hour, and it does not come back;
// so even a deliberate click is refused while anything is moving, with the
// reason on screen.

type UpdateStage =
  | "idle"
  | "checking"
  | "uptodate"
  | "available"
  | "downloading"
  | "ready"
  | "error";

let updateStage: UpdateStage = "idle";
/** The plugin's handle. Held because install() is a second call on the same object. */
let updateHandle: Update | null = null;
let updateOffer: { version: string; notes: string; date: string } | null = null;
let updateProgress: DownloadProgress = emptyProgress();
/** Free text under the version row: the error, or what just happened. */
let updateMessage = "";
/** Stored preference. Governs the CHECK only, and only in assistant mode. */
let updateAutoCheck = true;
/** At most one automatic check per process, whatever happens to it. */
let updateAutoDone = false;
let appVersion = "";

/** Tauri hands back "2026-08-10 09:00:00.0 +00:00:00". Only the day is useful. */
function updateDay(raw: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(raw ?? "");
  return m ? m[1] : "";
}

/**
 * How much work a restart would destroy, counted from both ends.
 *
 * The frontend map is the honest one, because it holds manually declared runs
 * as well as scheduled ones. Rust is asked too: between a job coming due and
 * the run being declared there is a window in which the scheduler considers a
 * job in flight and this webview has nothing yet.
 */
async function workInFlight(): Promise<number> {
  const here = runsview.runsInFlight();
  let there = 0;
  try {
    const raw = (await api.jobsList()) as { jobs?: { in_flight?: boolean }[] } | null;
    there = (raw?.jobs ?? []).filter((j) => j?.in_flight === true).length;
  } catch {
    // The scheduler could not be asked. Not treated as "busy": that would
    // make a broken jobs.json block every future update forever, and the
    // frontend count above is the one that actually knows about live agents.
    there = 0;
  }
  return Math.max(here, there);
}

/** The block under the version row. Empty when there is nothing to offer. */
function updateOfferHtml(): string {
  if (!updateOffer) return "";
  const o = updateOffer;
  const day = updateDay(o.date);
  const notes = summariseNotes(o.notes);
  const pct = progressPercent(updateProgress);
  const busy = updateStage === "downloading";
  const done = updateStage === "ready";
  return `<div class="upd-offer plate">
    <div class="upd-head"><b>${esc(t("update.version").replace("%s", o.version))}</b>${day ? `<span class="d">${esc(day)}</span>` : ""}</div>
    ${notes ? `<div class="upd-notes">${esc(notes)}</div>` : ""}
    ${appMode === "server" ? `<div class="upd-warn">${esc(t("update.serverWarn"))}</div>` : ""}
    ${busy ? `<div class="upd-prog"><div class="bar"><div style="width:${pct ?? 8}%"></div></div><span class="n">${esc(downloadLabel(updateProgress))}</span></div>` : ""}
    <div class="upd-actions">
      ${done
        ? `<button class="bp" id="updrestart">${esc(t("update.restart"))}</button><span class="upd-status ok">${esc(t("update.readyHint"))}</span>`
        : `<button class="bp" id="updgo" ${busy ? "disabled" : ""}>${esc(busy ? t("update.downloading") : t("update.install"))}</button><button class="bs" id="updlater" ${busy ? "disabled" : ""}>${esc(t("update.later"))}</button>`}
    </div>
  </div>`;
}

/**
 * Repaint the update rows in place.
 *
 * In place rather than through render(), because a download lasts a minute and
 * a full re-render would rebuild the settings page under the user's cursor
 * forty times. A no-op when the settings screen is not the one on display,
 * which is the case that matters: the progress keeps arriving whether or not
 * anyone is looking, and comes back correct when they return, because the
 * markup is rebuilt from this same state.
 */
function paintUpdate(): void {
  const status = document.getElementById("updstatus");
  if (status) {
    status.textContent = updateMessage;
    status.className = `upd-status${updateStage === "error" ? " bad" : updateStage === "uptodate" ? " ok" : ""}`;
  }
  const btn = document.getElementById("updcheck") as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = updateStage === "checking" || updateStage === "downloading";
    btn.textContent = updateStage === "checking" ? t("update.checking") : t("update.check");
  }
  const host = document.getElementById("updoffer");
  if (!host) return;
  host.innerHTML = updateOfferHtml();
  wireUpdateOffer(host);
}

function wireUpdateOffer(host: HTMLElement): void {
  host.querySelector<HTMLButtonElement>("#updgo")?.addEventListener("click", () => { void downloadUpdate(); });
  host.querySelector<HTMLButtonElement>("#updlater")?.addEventListener("click", () => {
    // Declining is a real answer and it sticks for this run of the app. The
    // offer comes back on the next launch, or on the next Check now.
    updateOffer = null;
    updateHandle = null;
    updateStage = "idle";
    updateMessage = t("update.declined").replace("%s", appVersion);
    paintUpdate();
  });
  host.querySelector<HTMLButtonElement>("#updrestart")?.addEventListener("click", () => { void restartForUpdate(); });
}

/**
 * Ask the endpoint whether there is anything newer.
 *
 * `silent` is the automatic call: it says nothing on failure and nothing when
 * the app is already current, because neither is news to somebody who did not
 * ask a question.
 */
async function checkUpdate(silent: boolean): Promise<void> {
  if (updateStage === "checking" || updateStage === "downloading") return;
  updateStage = "checking";
  updateMessage = silent ? "" : t("update.checking");
  paintUpdate();
  let found: Update | null = null;
  try {
    found = await checkForUpdate();
  } catch (e) {
    updateStage = silent ? "idle" : "error";
    updateMessage = silent ? "" : t("update.failed").replace("%s", String(e));
    paintUpdate();
    return;
  }
  // The plugin compares versions itself. It is compared AGAIN here against the
  // running binary, because the one failure this must not have is a downgrade:
  // an endpoint briefly serving the previous release would otherwise hand
  // every install a correctly signed archive of an older Galactus, which
  // installs cleanly and looks exactly like an update.
  if (!found || !isNewer(appVersion, found.version)) {
    updateHandle = null;
    updateOffer = null;
    updateStage = silent ? "idle" : "uptodate";
    updateMessage = silent ? "" : t("update.upToDate").replace("%s", appVersion);
    paintUpdate();
    return;
  }
  updateHandle = found;
  updateOffer = { version: found.version, notes: found.body ?? "", date: found.date ?? "" };
  updateProgress = emptyProgress();
  updateStage = "available";
  updateMessage = t("update.found").replace("%s", found.version);
  // Only surface enough to be noticed. The offer itself is a settings row, not
  // a modal: nothing is taken over, and a user in the middle of a turn keeps
  // their screen.
  if (silent && view !== "settings") toast(t("update.found").replace("%s", found.version), "ok");
  paintUpdate();
}

/**
 * Fetch and unpack, with the bar moving.
 *
 * `download` and `install` are called separately rather than through
 * `downloadAndInstall`, because the two halves answer to different rules: the
 * download may run while a job runs, since it only writes to a temporary file,
 * and the install replaces the bundle. The restart, which is the part that
 * actually ends work, stays behind its own button and its own verdict.
 */
async function downloadUpdate(): Promise<void> {
  if (!updateHandle || updateStage === "downloading") return;
  // Asked here as well as before the restart, and for a different reason.
  // install() swaps the application bundle on disk, and a run in flight reads
  // out of that bundle for its skills, its Python and its engine library:
  // replacing it underneath a working agent breaks the run without ending it,
  // which is worse than refusing. The download itself would be harmless, but
  // a download that cannot be installed is a progress bar that lies.
  {
    const jobs = await workInFlight();
    if (restartVerdict({ userInitiated: true, jobsInFlight: jobs }) !== "ok") {
      toast(t("update.busyJobs"));
      return;
    }
  }
  updateStage = "downloading";
  updateProgress = emptyProgress();
  updateMessage = "";
  paintUpdate();
  try {
    await updateHandle.download((event) => {
      if (event.event === "Started") {
        updateProgress = applyChunk(emptyProgress(), 0, event.data.contentLength ?? 0);
      } else if (event.event === "Progress") {
        updateProgress = applyChunk(updateProgress, event.data.chunkLength);
      }
      paintUpdate();
    });
    await updateHandle.install();
  } catch (e) {
    updateStage = "error";
    updateMessage = t("update.failed").replace("%s", String(e));
    paintUpdate();
    return;
  }
  updateStage = "ready";
  updateMessage = "";
  paintUpdate();
  toast(t("update.installedHint"), "ok");
}

/**
 * The only call to relaunch() in the whole app.
 *
 * Guarded by restartVerdict, which has its own suite. `userInitiated: true` is
 * written here and nowhere else: there is no timer, no event handler and no
 * quit hook that reaches this function, and if one is ever added it will have
 * to write that literal, which is the moment somebody has to think about it.
 */
async function restartForUpdate(): Promise<void> {
  const jobs = await workInFlight();
  const verdict = restartVerdict({ userInitiated: true, jobsInFlight: jobs });
  if (verdict === "jobs-in-flight") {
    // Refused, and said out loud. The new version is already on disk and will
    // be the one that starts whenever Galactus is next launched, so nothing is
    // lost by waiting: a job that began during the download keeps its hour.
    toast(t("update.busyJobs"));
    return;
  }
  if (verdict !== "ok") return;
  // Everything unsaved goes to disk first. A relaunch is a process ending.
  try { runsview.flushRuns(); } catch {}
  try { store.flushAll(); } catch {}
  try {
    await relaunch();
  } catch (e) {
    updateStage = "error";
    updateMessage = t("update.failed").replace("%s", String(e));
    paintUpdate();
  }
}

/** The launch check, subject to the mode and the preference. */
function maybeAutoCheck(): void {
  if (updateAutoDone) return;
  if (!autoCheckAllowed({ mode: appMode, enabled: updateAutoCheck })) return;
  updateAutoDone = true;
  // Deliberately late. The first seconds after launch belong to reading the
  // registry, probing the hardware and reopening a conversation; a network
  // call in that window competes with the things the user is waiting for.
  window.setTimeout(() => { void checkUpdate(true); }, 8000);
}

function settingsView(): HTMLElement {
  const wrap = el(`<div class="main">
    <div class="topbar" data-tauri-drag-region><span class="ttl">${esc(t("nav.settings"))}</span></div>
    <div class="page"><div class="hold narrow">
      <div class="sect"><b>${esc(t("sect.updates"))}</b><span>${esc(t("sect.updatesHint"))}</span></div>
      <div class="set-row"><div class="grow"><b>${esc(t("update.current"))}</b><span>${esc(appVersion ? `Galactus ${appVersion}` : "Galactus")}</span><span class="upd-status" id="updstatus"></span></div>
        <button class="bs" id="updcheck">${esc(t("update.check"))}</button>
      </div>
      <div id="updoffer"></div>
      <div class="set-row"><div class="grow"><b>${esc(t("update.autoTitle"))}</b><span>${esc(appMode === "server" ? t("update.autoServer") : t("update.autoHint"))}</span></div>
        <div class="seg" id="updautoseg"><button data-u="0" class="${updateAutoCheck ? "" : "on"}"${appMode === "server" ? " disabled" : ""}>${esc(t("common.off"))}</button><button data-u="1" class="${updateAutoCheck ? "on" : ""}"${appMode === "server" ? " disabled" : ""}>${esc(t("common.on"))}</button></div>
      </div>
      <div class="sect"><b>${esc(t("sect.appearance"))}</b><span>${esc(t("sect.appearanceHint"))}</span></div>
      <div class="set-row"><div class="grow"><b>${esc(t("settings.language"))}</b><span>${esc(t("settings.languageDesc"))}</span></div>
        <div class="seg" id="lang"><button data-l="fr" class="${getLang() === "fr" ? "on" : ""}">Français</button><button data-l="en" class="${getLang() === "en" ? "on" : ""}">English</button></div>
      </div>
      <div class="set-row"><div class="grow"><b>${esc(t("settings.folder"))}</b><span class="mono" id="rootp">${esc(root ?? "")}</span></div><button class="bs" id="rpick">${esc(t("common.choose"))}</button></div>
      <div class="sect"><b>${esc(t("sect.engine"))}</b><span>${esc(t("sect.engineHint"))}</span></div>
      <div class="set-row"><div class="grow"><b>${esc(t("settings.cache"))}</b><span>${esc(t("settings.cacheHint"))}</span></div>
        <span class="badge-auto">${esc(t("settings.auto"))}</span>
      </div>
      <div class="set-row"><div class="grow"><b>${esc(t("settings.ram"))}</b><span>${esc(t("settings.ramHint"))}</span></div>
        <div class="seg" id="ramseg">
          <button data-rm="eco">${esc(t("settings.ramEco"))}</button>
          <button data-rm="balanced">${esc(t("settings.ramBalanced"))}</button>
          <button data-rm="perf">${esc(t("settings.ramPerf"))}</button>
        </div>
      </div>
      <div class="set-row"><div class="grow"><b>${esc(t("settings.slots"))}</b><span>${esc(t("settings.slotsHint"))}</span><span>${esc(t("brief.autoHint"))}</span></div>
        <div class="seg" id="slotseg">
          <button data-sl="">${esc(t("brief.auto"))}</button>
          <button data-sl="1">1</button>
          <button data-sl="2">2</button>
          <button data-sl="3">3</button>
          <button data-sl="4">4</button>
        </div>
      </div>
      <div class="set-row"><div class="grow"><b>${esc(t("settings.ctx"))}</b><span>${esc(t("settings.ctxHint"))}</span></div>
        <div class="seg" id="ctxseg">
          <button data-ctx="8192">8K</button>
          <button data-ctx="16384">16K</button>
          <button data-ctx="32768">32K</button>
          <button data-ctx="65536">64K</button>
          <button data-ctx="131072">128K</button>
        </div>
      </div>
      <div class="set-row"><div class="grow"><b>${esc(t("settings.thinking"))}</b><span>${esc(t("settings.thinkingHint"))}</span></div>
        <button class="tgl" id="thinktgl" role="switch" aria-checked="true"><span class="k"></span></button>
      </div>
      <div class="set-row"><div class="grow"><b>${esc(t("settings.sampling"))}</b><span>${esc(t("settings.samplingHint"))}</span></div>
        <div class="set-actions">
          <label class="samp"><small>${esc(t("settings.temp"))}</small><input id="samptemp" type="number" step="0.05" min="0" max="2"/></label>
          <label class="samp"><small>${esc(t("settings.topP"))}</small><input id="samptopp" type="number" step="0.01" min="0" max="1"/></label>
          <label class="samp"><small>${esc(t("settings.topK"))}</small><input id="samptopk" type="number" step="1" min="0" max="200"/></label>
          <button class="bs" id="sampreset">${esc(t("settings.samplingReset"))}</button>
        </div>
      </div>
      <div class="set-row"><div class="grow"><b>${esc(t("auto.title"))}</b><span>${esc(t("auto.hint"))}</span></div>
        <div class="seg" id="autoseg">
          <button data-am="off">${esc(t("auto.off"))}</button>
          <button data-am="ask">${esc(t("auto.ask"))}</button>
          <button data-am="auto">${esc(t("auto.auto"))}</button>
        </div>
      </div>
      <div class="sect"><b>${esc(t("sect.ide"))}</b><span>${esc(t("sect.ideHint"))}</span></div>
      <div class="set-row"><div class="grow"><b>${esc(t("settings.autoTab"))}</b><span>${esc(t("settings.autoTabHint"))}</span></div>
        <button class="tgl ${autoTabOn ? "on" : ""}" id="autotab" role="switch" aria-checked="${autoTabOn}"><span class="k"></span></button>
      </div>
      <div class="set-row"><div class="grow"><b>${esc(t("settings.syntax"))}</b><span>${esc(t("settings.syntaxHint"))}</span></div><span class="badge-auto">${esc(t("common.ready"))}</span></div>
      <div class="set-row"><div class="grow"><b>${esc(t("settings.extensions"))}</b><span>${esc(t("settings.extensionsHint"))}</span></div>
        <div class="set-actions"><button class="bs" id="openconnectors">${esc(t("settings.openConnectors"))}</button><button class="bs" id="openskills">${esc(t("settings.openSkills"))}</button></div>
      </div>
      <div class="sect"><b>${esc(t("sect.access"))}</b><span>${esc(t("sect.accessHint"))}</span></div>
      <div class="set-row"><div class="grow"><b>${esc(t("settings.api"))}</b><span>${esc(t("settings.apiHint"))}</span><span class="mono api-url">${server.running && server.phase === "ready" ? esc(`http://127.0.0.1:${server.port}/v1`) : esc(t("settings.apiOff"))}</span></div>
        ${server.running && server.phase === "ready" ? `<button class="bs" id="apicopy">${esc(t("settings.apiCopy"))}</button>` : ""}
      </div>
      <div class="sect"><b>${esc(t("sect.network"))}</b><span>${esc(t("sect.networkHint"))}</span></div>
      <div class="set-row"><div class="grow"><b>${esc(t("net.mode"))}</b><span>${esc(t("net.modeHint"))}</span></div>
        <div class="seg" id="appmodeseg"><button data-m="app" class="${appMode === "app" ? "on" : ""}">${esc(t("net.modeApp"))}</button><button data-m="server" class="${appMode === "server" ? "on" : ""}">${esc(t("net.modeServer"))}</button></div>
      </div>
      <div class="set-row"><div class="grow"><b>${esc(t("net.modeAsk"))}</b><span>${esc(t("net.modeAskHint"))}</span></div>
        <div class="seg" id="modeaskseg"><button data-a="0" class="${modeAskAlways ? "" : "on"}">${esc(t("common.off"))}</button><button data-a="1" class="${modeAskAlways ? "on" : ""}">${esc(t("common.on"))}</button></div>
      </div>
      <div class="set-row"><div class="grow"><b>${esc(t("net.expose"))}</b><span>${esc(t("net.exposeHint"))}</span></div>
        <div class="seg" id="bindseg"><button data-b="127.0.0.1" class="${relayBind === "127.0.0.1" ? "on" : ""}">${esc(t("net.localOnly"))}</button><button data-b="0.0.0.0" class="${relayBind === "0.0.0.0" ? "on" : ""}">${esc(t("net.network"))}</button></div>
      </div>
      <div class="set-row"><div class="grow"><b>${esc(t("net.key"))}</b><span>${esc(t("net.keyHint"))}</span><span class="mono api-url" id="relaykey">${relayKey ? esc(relayKey) : ""}</span></div>
        <button class="bs" id="newkey">${esc(t("net.newKey"))}</button>
      </div>
      <div class="set-row"><div class="grow"><b>${esc(t("net.snippets"))}</b><span>${esc(t("net.snippetsHint"))}</span><span class="mono api-url">${relay.running ? esc(`${t("net.open")} http://${relayHost()}:${relay.port}/v1`) : esc(t("net.closed"))}</span></div>
        <button class="bs" id="relaytoggle">${relay.running ? esc(t("net.stop")) : esc(t("net.start"))}</button>
      </div>
      ${relay.running ? connectionSnippets(`http://${relayHost()}:${relay.port}/v1`, relayKey, "galactus-local").map((s, i) => `
      <div class="set-row snip"><div class="grow"><b>${esc(s.name)}</b><pre class="snipbody" id="snip${i}">${esc(s.body)}</pre></div>
        <button class="bs" data-snip="${i}">${esc(t("net.copy"))}</button>
      </div>`).join("") : `<div class="set-row"><div class="grow"><span>${esc(t("net.needOpen"))}</span></div></div>`}
      <div class="set-row"><div class="grow"><b>${esc(t("settings.permissions"))}</b><span>${esc(t("settings.permissionsHint"))}</span></div><button class="bs" id="pclear">${esc(t("settings.permissionsClear"))}</button></div>
    </div></div></div>`);
  wrap.querySelector<HTMLButtonElement>("#updcheck")!.addEventListener("click", () => { void checkUpdate(false); });
  {
    const seg = wrap.querySelector<HTMLElement>("#updautoseg")!;
    seg.addEventListener("click", async (e) => {
      const b = (e.target as HTMLElement).closest("[data-u]") as HTMLElement | null;
      if (!b || (b as HTMLButtonElement).disabled) return;
      updateAutoCheck = b.dataset.u === "1";
      seg.querySelectorAll("button").forEach((x) =>
        x.classList.toggle("on", (x as HTMLElement).dataset.u === (updateAutoCheck ? "1" : "0"))
      );
      await api.settingsSet("update_check_auto", updateAutoCheck ? "1" : "0");
    });
  }
  // Rebuilt from state on every mount, so a download that started before the
  // user walked away is still on screen, at the right percentage, when they
  // come back.
  {
    const host = wrap.querySelector<HTMLElement>("#updoffer")!;
    host.innerHTML = updateOfferHtml();
    wireUpdateOffer(host);
    const status = wrap.querySelector<HTMLElement>("#updstatus")!;
    status.textContent = updateMessage;
    if (updateStage === "error") status.classList.add("bad");
    if (updateStage === "uptodate") status.classList.add("ok");
  }
  wrap.querySelector("#lang")!.addEventListener("click", async (e) => { const b = (e.target as HTMLElement).closest("[data-l]") as HTMLElement | null; if (!b) return; setLang(b.dataset.l as Lang); await loadTaskDefs(); render(); });
  wrap.querySelector("#rpick")!.addEventListener("click", async () => { const p = await pickFolderOrSay(); if (p) await setRoot(p); });
  wrap.querySelector<HTMLButtonElement>("#autotab")!.addEventListener("click", async (e) => {
    autoTabOn = !autoTabOn;
    const b = e.currentTarget as HTMLButtonElement;
    b.classList.toggle("on", autoTabOn);
    b.setAttribute("aria-checked", String(autoTabOn));
    await api.settingsSet("auto_tab", autoTabOn ? "1" : "0");
  });
  wrap.querySelector("#openconnectors")!.addEventListener("click", () => { view = "connectors"; render(); });
  wrap.querySelector("#openskills")!.addEventListener("click", () => { view = "agent"; render(); });
  {
    const askSeg = wrap.querySelector<HTMLElement>("#modeaskseg");
    askSeg?.addEventListener("click", async (e) => {
      const b = (e.target as HTMLElement).closest("[data-a]") as HTMLElement | null;
      if (!b) return;
      modeAskAlways = b.dataset.a === "1";
      askSeg.querySelectorAll("button").forEach((x) =>
        x.classList.toggle("on", (x as HTMLElement).dataset.a === (modeAskAlways ? "1" : "0"))
      );
      await api.settingsSet("app_mode_ask", modeAskAlways ? "1" : "0");
    });
    const seg = wrap.querySelector<HTMLElement>("#autoseg");
    if (seg) {
      const paint = (m: AutoMode) =>
        seg.querySelectorAll("button").forEach((b) =>
          b.classList.toggle("on", (b as HTMLElement).dataset.am === m)
        );
      paint(getAutoMode());
      seg.addEventListener("click", (e) => {
        const b = (e.target as HTMLElement).closest("[data-am]") as HTMLElement | null;
        if (!b) return;
        const m = b.dataset.am as AutoMode;
        setAutoMode(m);
        paint(m);
      });
    }
  }
  {
    // Decode slots: the real bound on how many conversations may generate at
    // once. Applied on the next model start, like the memory footprint.
    //
    // Automatic is the empty string, and it is the shipped default: a setting
    // that does not parse as a number is what the Rust side reads as "no
    // choice made", and it then works the count out per model and per machine.
    // The settings file has no key removal, so blanking is how a user goes
    // back to automatic after having picked a number, exactly as the bench
    // reset blanks bench_<id>.
    const seg = wrap.querySelector<HTMLElement>("#slotseg")!;
    const paint = (n: string) =>
      seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", (b as HTMLElement).dataset.sl === n));
    paint("");
    api.settingsGet().then((st) => {
      const stored = Number(st["engine_slots"]);
      paint(Number.isFinite(stored) && stored >= 1 ? String(Math.min(stored, 4)) : "");
    });
    seg.addEventListener("click", async (e) => {
      const b = (e.target as HTMLElement).closest("[data-sl]") as HTMLElement | null;
      if (!b) return;
      paint(b.dataset.sl!);
      await api.settingsSet("engine_slots", b.dataset.sl!);
      if (server.running) toast(t("settings.slotsRestart"), "ok");
      await refreshServer();
      paintLive();
    });
  }
  {
    // Context window. Applied at the next engine start, like the memory mode:
    // a running server holds a cache sized for the window it was started with,
    // and resizing it under a live conversation is not a thing llama.cpp does.
    {
      const ctxseg = wrap.querySelector<HTMLElement>("#ctxseg")!;
      const paintCtx = (v: string) =>
        ctxseg.querySelectorAll("button").forEach((b) =>
          (b as HTMLElement).classList.toggle("on", (b as HTMLElement).dataset.ctx === v));
      api.settingsGet().then((s) => paintCtx(s["engine_ctx"] || "8192"));
      ctxseg.addEventListener("click", async (e) => {
        const b = (e.target as HTMLElement).closest("[data-ctx]") as HTMLElement | null;
        if (!b) return;
        paintCtx(b.dataset.ctx!);
        await api.settingsSet("engine_ctx", b.dataset.ctx!);
        toast(t("settings.appliedNextStart"), "ok");
      });
    }
    // Sampling. Applied to the NEXT conversation, not to threads already open:
    // two answers in one thread coming from two different samplings is not
    // something a reader could ever untangle.
    {
      const temp = wrap.querySelector<HTMLInputElement>("#samptemp")!;
      const topp = wrap.querySelector<HTMLInputElement>("#samptopp")!;
      const topk = wrap.querySelector<HTMLInputElement>("#samptopk")!;
      const fill = (s: Sampling) => {
        temp.value = String(s.temperature);
        topp.value = String(s.top_p);
        topk.value = String(s.top_k);
      };
      api.settingsGet().then((s) => fill(readSampling(s)));
      const save = async (key: keyof Sampling, input: HTMLInputElement) => {
        const value = clampSampling(key, Number(input.value));
        input.value = String(value);
        await api.settingsSet(`sampling_${key}`, String(value));
        configureSampling(readSampling(await api.settingsGet()));
      };
      temp.addEventListener("change", () => void save("temperature", temp));
      topp.addEventListener("change", () => void save("top_p", topp));
      topk.addEventListener("change", () => void save("top_k", topk));
      wrap.querySelector("#sampreset")!.addEventListener("click", async () => {
        for (const [key, value] of Object.entries(SAMPLING_DEFAULT)) {
          await api.settingsSet(`sampling_${key}`, String(value));
        }
        fill(SAMPLING_DEFAULT);
        configureSampling(SAMPLING_DEFAULT);
      });
    }
    // Reasoning on or off. Takes effect on the NEXT turn, not the running one:
    // a turn that has already started thinking cannot be told to stop.
    {
      const tgl = wrap.querySelector<HTMLButtonElement>("#thinktgl")!;
      const paintTh = (on: boolean) => {
        tgl.classList.toggle("on", on);
        tgl.setAttribute("aria-checked", String(on));
      };
      api.settingsGet().then((s) => paintTh(s["thinking"] !== "0"));
      tgl.addEventListener("click", async () => {
        const on = !tgl.classList.contains("on");
        paintTh(on);
        await api.settingsSet("thinking", on ? "1" : "0");
        configureThinking(on);
      });
    }
    const seg = wrap.querySelector<HTMLElement>("#ramseg")!;
    const paint = (m: string) =>
      seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", (b as HTMLElement).dataset.rm === m));
    api.settingsGet().then((s) => paint(s["ram_mode"] === "eco" || s["ram_mode"] === "perf" ? s["ram_mode"] : "balanced"));
    seg.addEventListener("click", async (e) => {
      const b = (e.target as HTMLElement).closest("[data-rm]") as HTMLElement | null;
      if (!b) return;
      paint(b.dataset.rm!);
      ramMode = b.dataset.rm as typeof ramMode;
      await api.settingsSet("ram_mode", b.dataset.rm!);
      // Applied on the next model start; a running server keeps its cache.
    });
  }
  wrap.querySelector<HTMLButtonElement>("#apicopy")?.addEventListener("click", async (e) => {
    const b = e.currentTarget as HTMLButtonElement;
    try {
      await navigator.clipboard.writeText(`http://127.0.0.1:${server.port}/v1`);
      const prev = b.textContent;
      b.textContent = t("settings.apiCopied");
      setTimeout(() => { b.textContent = prev; }, 1400);
    } catch {}
  });
  wrap.querySelectorAll<HTMLButtonElement>("#appmodeseg button").forEach((b) =>
    b.addEventListener("click", async () => {
      appMode = b.dataset.m === "server" ? "server" : "app";
      await api.settingsSet("app_mode", appMode);
      // Server mode hides the assistant surfaces, so a view that no longer has
      // a nav entry must not stay on screen.
      if (appMode === "server" && !SERVER_MODE_VIEWS.includes(view)) view = "models";
      syncTray();
      // Coming back to assistant mode makes the launch check legal again, and
      // this is the moment a human is demonstrably present. Going the other
      // way needs nothing: the check has already either run or been skipped.
      maybeAutoCheck();
      render();
    })
  );
  wrap.querySelectorAll<HTMLButtonElement>("#bindseg button").forEach((b) =>
    b.addEventListener("click", async () => {
      relayBind = b.dataset.b === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
      await api.settingsSet("relay_bind", relayBind);
      // Moving where it listens while it listens would leave the old socket
      // bound: it closes, and the user reopens deliberately.
      if (relay.running) relay = await api.relayStop();
      render();
    })
  );
  wrap.querySelector<HTMLButtonElement>("#newkey")!.addEventListener("click", async () => {
    relayKey = await api.relayNewKey();
    try {
      await navigator.clipboard.writeText(relayKey);
    } catch {}
    render();
  });
  wrap.querySelectorAll<HTMLButtonElement>("[data-snip]").forEach((b) =>
    b.addEventListener("click", async () => {
      const pre = wrap.querySelector<HTMLElement>(`#snip${b.dataset.snip}`);
      if (!pre) return;
      try {
        await navigator.clipboard.writeText(pre.textContent ?? "");
        const prev = b.textContent;
        b.textContent = t("net.copied");
        setTimeout(() => { b.textContent = prev; }, 1400);
      } catch {}
    })
  );
  wrap.querySelector<HTMLButtonElement>("#relaytoggle")!.addEventListener("click", async () => {
    if (relay.running) {
      relay = await api.relayStop();
      render();
      return;
    }
    if (!(server.running && server.phase === "ready")) {
      toast(t("net.needModel"));
      return;
    }
    if (!relayKey) {
      toast(t("net.needKey"));
      return;
    }
    try {
      relay = await api.relayStart(relayBind, RELAY_PORT, relayKey);
    } catch (e) {
      toast(String(e));
      return;
    }
    render();
  });
  {
    const b = wrap.querySelector<HTMLButtonElement>("#pclear")!;
    b.addEventListener("click", async () => {
      await clearStandingPermissions();
      const prev = b.textContent;
      b.textContent = t("settings.permissionsCleared");
      setTimeout(() => { b.textContent = prev; }, 1500);
    });
  }
  return wrap;
}

// ---------- the launch choice ----------

/**
 * Two doors, before anything else is drawn.
 *
 * Not a modal over the app: picking `server` removes the chat, the workspace,
 * the memory and the agent, so drawing them first and then taking them away
 * would be showing the user something that was never theirs. The choice is
 * remembered, and the settings row still switches it afterwards.
 */
function modeChoiceView(): HTMLElement {
  const card = (mode: AppMode, title: string, body: string, points: string[]) => `
    <button class="modepick plate" data-m="${mode}">
      <b>${esc(title)}</b>
      <span class="d">${esc(body)}</span>
      <ul>${points.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
    </button>`;
  const wrap = el(`<div class="onb modechoice"><div class="box">
    <img class="g" src="${LOGO}" alt="Galactus"/>
    <h1>${esc(t("mode.title"))}</h1>
    <p>${esc(t("mode.body"))}</p>
    <div class="modepicks">
      ${card("app", t("net.modeApp"), t("mode.appBody"), [t("mode.appA"), t("mode.appB"), t("mode.appC")])}
      ${card("server", t("net.modeServer"), t("mode.serverBody"), [t("mode.serverA"), t("mode.serverB"), t("mode.serverC")])}
    </div>
    <label class="modeask"><input type="checkbox" id="modeask" ${modeAskAlways ? "checked" : ""}/><span>${esc(t("mode.askAlways"))}</span></label>
  </div></div>`);
  const ask = wrap.querySelector<HTMLInputElement>("#modeask")!;
  ask.addEventListener("change", () => {
    modeAskAlways = ask.checked;
    void api.settingsSet("app_mode_ask", modeAskAlways ? "1" : "0");
  });
  wrap.querySelectorAll<HTMLElement>("[data-m]").forEach((b) => {
    b.addEventListener("click", () => {
      appMode = b.dataset.m === "server" ? "server" : "app";
      void api.settingsSet("app_mode", appMode);
      void api.settingsSet("app_mode_chosen", "1");
      if (appMode === "server" && !SERVER_MODE_VIEWS.includes(view)) view = "models";
      modePending = false;
      syncTray();
      maybeAutoCheck();
      render();
    });
  });
  return wrap;
}

// ---------- onboarding ----------
function onboardView(): HTMLElement {
  const wrap = el(`<div class="onb"><div class="box">
    <img class="g" src="${LOGO}" alt="Galactus"/>
    <h1>${esc(t("onboard.title"))}</h1>
    <p>${esc(t("onboard.body"))}</p>
    <div class="checks" id="checks">
      <div class="chk"><span class="mark wait">…</span><span class="l">${esc(t("onboard.detecting"))}</span><span class="v" id="dv"></span></div>
    </div>
    <div class="row" id="row"></div>
  </div></div>`);
  const checks = wrap.querySelector<HTMLElement>("#checks")!;
  const row = wrap.querySelector<HTMLElement>("#row")!;
  api.detectRoot().then((found) => {
    if (found) {
      checks.innerHTML = `<div class="chk"><span class="mark">✓</span><span class="l">${esc(t("onboard.detected"))}</span><span class="v mono" style="font-size:11px">${esc(found)}</span></div>`;
      const use = el(`<button class="bp" style="padding:9px 18px">${esc(t("onboard.use"))}</button>`);
      use.addEventListener("click", () => setRoot(found));
      const choose = el(`<button class="bs" style="padding:9px 18px">${esc(t("onboard.choose"))}</button>`);
      choose.addEventListener("click", pickRoot);
      row.append(use, choose);
    } else {
      checks.innerHTML = `<div class="chk"><span class="mark wait">!</span><span class="l">${esc(t("onboard.notfound"))}</span></div>`;
      const choose = el(`<button class="bp" style="padding:9px 18px">${esc(t("onboard.choose"))}</button>`);
      choose.addEventListener("click", pickRoot);
      row.appendChild(choose);
    }
  });
  return wrap;
}
/**
 * The folder chooser, with its failures said out loud.
 *
 * api.pickFolder rejects when the panel could not be opened at all, which is a
 * different thing from the user pressing Cancel and used to be reported as the
 * same nothing. Every caller wants that distinction and none of them wants to
 * write it out, so it lives here.
 */
async function pickFolderOrSay(): Promise<string | null> {
  try {
    return await api.pickFolder();
  } catch (e: any) {
    toast(String(e?.message ?? e));
    return null;
  }
}

async function pickRoot() { const p = await pickFolderOrSay(); if (p) await setRoot(p); }
async function setRoot(p: string) {
  await api.settingsSet("root", p);
  root = p;
  try { registry = await api.registry(); } catch { registry = []; }
  try { hw = await api.hwInfo(); } catch {}
  await loadTaskDefs();
  view = registry.length ? "models" : "settings";
  render();
}

// ---------- shell ----------
/**
 * The last footprint decision this UI has already told the user about.
 *
 * refreshServer runs on every server tick, and a start emits dozens of them.
 * Keyed on the model and the pair of modes, so the notice appears once per
 * start and reappears if the same model is later started differently.
 */
let footprintNoticed = "";

async function refreshServer() {
  try {
    server = await api.serverStatus();
  } catch {
    return;
  }
  // A step-down is said out loud. A user who picked Performance and silently
  // got Eco would rightly call that a bug, and a user who is never told why
  // learns nothing about his own machine.
  const f = server.footprint;
  if (!f || f.mode === f.requested) {
    if (!f) footprintNoticed = "";
    return;
  }
  const key = `${server.model_id ?? ""}:${f.requested}>${f.mode}`;
  if (key === footprintNoticed) return;
  footprintNoticed = key;
  toast(
    t("footprint.steppedDown")
      .replace(/%m/g, t(modeLabelKey(f.mode)))
      .replace(/%a/g, t(modeLabelKey(f.requested)))
      .replace("%g", (f.budget_bytes / 1e9).toFixed(1))
  );
}

let composerDraft = "";
/** Where each view was scrolled to, so a rebuild can put it back. */
const pageScroll: Partial<Record<View, number>> = {};

/** Sidebar server pill state, shared by render() and the targeted repaint. */
function serverPillState(): { pill: string; text: string } {
  const running = registry.find((m) => m.id === server.model_id);
  const pill = serverFail ? "failed" : server.phase === "ready" ? "ready" : server.phase === "starting" ? "starting" : "";
  const text = serverFail
    ? (serverFail.kind === "timeout" ? t("server.timeout") : t("server.failed"))
    : server.phase === "ready" ? (running?.name ?? t("server.ready")) : server.phase === "starting" ? t("server.starting") : t("server.stopped");
  return { pill, text };
}

/**
 * Repaint ONLY the sidebar server pill. Used for background server events
 * while the Memory or Connectors view is open: a full rebuild there wipes
 * unsaved edits (memory textarea, custom-connector form), and those views
 * surface server state through the pill alone.
 */
function renderServerPill(): void {
  const srv = document.querySelector<HTMLElement>(".side .srv");
  if (!srv) return;
  const { pill, text } = serverPillState();
  srv.className = `srv ${pill}`;
  srv.innerHTML = `<span class="dot"></span><div class="t"><b>${esc(t("server.label"))}</b><span>${esc(text)}</span></div>`;
}

/** Add native keyboard semantics to the remaining custom controls. */
function wireUiSemantics(scope: ParentNode): void {
  scope.querySelectorAll<HTMLElement>(".tgl").forEach((control) => {
    control.setAttribute("role", "switch");
    control.tabIndex = control.getAttribute("aria-disabled") === "true" ? -1 : 0;
    control.setAttribute("aria-checked", String(control.classList.contains("on")));
    control.addEventListener("click", () => {
      control.setAttribute("aria-checked", String(control.classList.contains("on")));
    });
  });
  scope.querySelectorAll<HTMLElement>(".iconbtn, .dashed, .link, .auton, .conv").forEach((control) => {
    if (control.matches("button, a, input, textarea, select, [role]")) return;
    control.setAttribute("role", "button");
    control.tabIndex = 0;
  });
  scope.querySelectorAll<HTMLElement>('[role="button"], [role="switch"]').forEach((control) => {
    control.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      control.click();
    });
  });
}

function render() {
  shellResizeCleanup?.(); shellResizeCleanup = null;
  pixel?.destroy(); pixel = null; pixelHost = null;
  // A rebuild must never eat a draft: whatever is typed in the composer
  // survives every render (server events, install progress, view switches).
  {
    const ci = document.getElementById("ci") as HTMLTextAreaElement | null;
    if (ci) composerDraft = ci.value;
  }
  // And a rebuild must never eat the scroll position either. An install emits a
  // progress event every few hundred milliseconds, each one a full render, and
  // a page that returns to the top on every one of them cannot be read at all:
  // the card whose download you are watching is the one that scrolls away.
  // Keyed by view, because arriving at a view you have not been looking at
  // should start at its top, not where some other page happened to be.
  {
    const pg = document.querySelector(".page") as HTMLElement | null;
    if (pg) pageScroll[view] = pg.scrollTop;
  }
  // The whole DOM is rebuilt: tear down anything attached to the old tree.
  previewPanel?.destroy(); previewPanel = null;
  dropUnsub?.(); dropUnsub = null;
  app.innerHTML = "";
  if (!root) {
    const l = el(`<div class="layout"></div>`);
    l.appendChild(onboardView());
    app.appendChild(l);
    wireUiSemantics(l);
    return;
  }

  if (modePending) {
    const l = el(`<div class="layout"></div>`);
    l.appendChild(modeChoiceView());
    app.appendChild(l);
    wireUiSemantics(l);
    return;
  }

  const { pill, text: srvText } = serverPillState();
  // A model that cannot call tools cannot drive anything agentic: the Code
  // view would open on an assistant that reads no file and writes no patch,
  // and the failure would be silent. The surfaces that need tools are
  // disabled, carrying the reason, rather than left to disappoint.
  const nav = (v: View, ic: string, label: string, badge = 0) => {
    // A run drives the same agent loop as the Code view, so a model that emits
    // no tool call gives it nothing to do either: it would read no file, run
    // no command, and burn its budget answering in prose.
    const off = (v === "code" || v === "runs") && toolsBlocked();
    const why = off ? esc(t("tools.blocked")) : "";
    return `<button type="button" class="nav-item ${view === v ? "on" : ""}${off ? " off" : ""}" data-v="${v}"${off ? ` disabled aria-disabled="true" title="${why}"` : ""} aria-current="${view === v ? "page" : "false"}">${ic}<span>${esc(label)}</span>${badge > 0 ? `<span class="navbadge" title="${esc(t("code.pendingNav"))}">${badge}</span>` : ""}</button>`;
  };

  const layout = el(`<div class="layout">
    <div class="side">
      <div class="side-head" data-tauri-drag-region></div>
      <div class="brand2"><img class="mark" src="${LOGO}" alt="Galactus"/><div class="txt"><b>Galactus</b><span class="brandby">${esc(appVersion ? `${t("brand.by")} · v${appVersion}` : t("brand.by"))}</span></div></div>
      <div class="nav">
        ${appMode === "server" ? "" : nav("chat", I.chat, t("nav.chat"))}
        ${appMode === "server" ? "" : nav("code", I.code, t("nav.code"), codeview.pendingCount())}
        ${nav("models", I.models, t("nav.models"))}
        ${nav("connectors", I.conn, t("nav.connectors"))}
        ${nav("runs", I.runs, t("nav.runs"))}
        ${appMode === "server" ? "" : nav("memory", I.mem, t("nav.memory"))}
        ${appMode === "server" ? "" : nav("agent", I.agent, t("nav.agent"))}
        ${nav("learned", I.mem, t("learned.title"))}
        ${nav("settings", I.set, t("nav.settings"))}
      </div>
      <div class="convslot"></div>
      <div class="spacer"></div>
      <div class="srv ${pill}"><span class="dot"></span><div class="t"><b>${esc(t("server.label"))}</b><span>${esc(srvText)}</span></div></div>
    </div>
    <div class="pane-splitter shell-splitter" id="shellsplit"></div>
  </div>`);
  const slot = layout.querySelector(".convslot");
  if (slot) slot.replaceWith(convListEl());
  layout.querySelector(".nav")!.addEventListener("click", (e) => {
    const it = (e.target as HTMLElement).closest("[data-v]") as HTMLElement | null;
    if (!it) return; view = it.dataset.v as View; render();
  });
  layout.appendChild(
    view === "chat" ? chatView()
    : view === "code" ? codeview.codeView()
    : view === "models" ? modelsView()
    : view === "connectors" ? connectorsView()
    : view === "runs" ? runsview.runsView()
    : view === "memory" ? memoryView()
    : view === "agent" ? agentView()
    : view === "learned" ? learnedView()
    : settingsView()
  );
  app.appendChild(layout);
  shellResizeCleanup = wirePaneResizer({
    handle: layout.querySelector<HTMLElement>("#shellsplit")!,
    container: layout,
    pane: layout.querySelector<HTMLElement>(".side")!,
    edge: "before",
    setting: "ui_sidebar_width",
    label: t("layout.resizeSidebar"),
    hint: t("layout.resizeHint"),
    min: 184,
    max: 340,
    defaultSize: 228,
    reserved: () => 680,
  });
  // The Code view mounts the same thread pane as the Chat view, so both are
  // painted the same way: one thread, two places to read it from.
  if (view === "chat" || view === "code") {
    if (composerDraft) {
      const ci = document.getElementById("ci") as HTMLTextAreaElement | null;
      if (ci && !ci.value) {
        ci.value = composerDraft;
        ci.dispatchEvent(new Event("input"));
      }
    }
    paintChat();
    scrollChatDown();
    // The rebuild destroyed the activity canvas: restore the current scene.
    restoreActivity();
  }
  // Put the page back where the user had it. Restored synchronously, before the
  // browser paints the new tree, so the jump to the top is never seen rather
  // than seen and undone.
  {
    const pg = layout.querySelector(".page") as HTMLElement | null;
    const want = pageScroll[view];
    if (pg && want) {
      pg.scrollTop = want;
      // Again after layout. A scrollTop written into a subtree the engine has
      // not measured yet is clamped to whatever height it currently believes,
      // which for a fresh tree can be zero, and the assignment above silently
      // becomes a scroll to the top. The second write lands once the height is
      // real. It is a no-op whenever the first one worked.
      requestAnimationFrame(() => { if (pg.scrollTop !== want) pg.scrollTop = want; });
    }
  }
  wireUiSemantics(layout);
  // A rebuild must never orphan an open permission dialog. It lives on the
  // body, not in the app root, so it survives on its own; this puts it back if
  // anything ever detaches it, and opens the next queued one if none is up.
  pumpPermissions();
}

/**
 * Repaint the team strip in place. A teammate's chip carries live state (busy,
 * current tool, entry count) and must follow it without rebuilding the view,
 * which would cost the composer its draft on every token.
 */
function paintTeamStrip(): void {
  const strip = document.getElementById("teamstrip");
  const sess = active();
  if (!strip) return;
  if (sess.sub || !sess.conv.team.length) { strip.remove(); return; }
  strip.innerHTML = el(teamStripHtml(sess.conv)).innerHTML;
}

/**
 * Move one model card's install bar, in place, touching nothing else.
 *
 * WHY THIS EXISTS RATHER THAN ANOTHER render(). A download emits a progress
 * event every few hundred milliseconds and each one used to rebuild the entire
 * application: sidebar, navigation, every card. The user watching the model they
 * are installing lost their place on every tick, because the tree holding their
 * scroll position no longer existed. Preserving the scroll across the rebuild
 * treats the symptom; the disease is rebuilding a thousand nodes to move one bar
 * two pixels.
 *
 * Returns false when the card is not on screen in its downloading shape, which
 * is the FIRST tick (the card still shows a Download button that must become a
 * cancel button) and any tick arriving while another view is open. The caller
 * falls back to a full render for those, so the in-place path only ever handles
 * the case it can handle completely.
 */
function paintInstallProgress(id: string): boolean {
  const prog = installProgress.get(id);
  if (!prog) return false;
  // Found by walking rather than by selector: a model id goes into an attribute
  // selector unescaped otherwise, and CSS.escape is not in the test DOM.
  const cards = document.querySelectorAll<HTMLElement>("[data-mcard]");
  let card: HTMLElement | null = null;
  cards.forEach((c) => { if (c.dataset.mcard === id) card = c; });
  if (!card) return false;
  const bar = (card as HTMLElement).querySelector<HTMLElement>("[data-prog] > div");
  const label = (card as HTMLElement).querySelector<HTMLElement>("[data-plabel]");
  if (!bar || !label) return false;
  bar.style.width = `${prog.pct}%`;
  label.innerHTML =
    `<b style="color:var(--acc-tx)">${Math.round(prog.pct)}%</b> · ${esc(installLabel(prog.label))}`;
  return true;
}

/** Repaint only the sidebar (conversation list) without touching the thread. */
function renderSidebarOnly() {
  paintTeamStrip();
  const side = document.querySelector(".side");
  if (!side) return;
  const list = side.querySelector("#convlist");
  if (list) list.replaceWith(convListEl());
}

/**
 * Stored conversations plus the live ones that have no file yet. A thread that
 * is generating must be listed even before its first debounced save, or its
 * running indicator would have nowhere to appear.
 */
function metasWithLive(): ConvMeta[] {
  const out = [...store.metas()];
  for (const th of threads.values()) {
    if (th.sub) continue;
    if (out.some((m) => m.id === th.conv.id)) continue;
    if (th.conv.items.length === 0) continue;
    out.push({
      id: th.conv.id,
      title: th.conv.title,
      created: th.conv.created,
      updated: th.conv.updated,
      count: th.conv.items.length,
    });
  }
  out.sort((a, b) => b.updated - a.updated);
  return out;
}

function convListEl(): HTMLElement {
  const box = el(`<div class="convlist" id="convlist"></div>`);
  const metas = metasWithLive();
  if (!metas.length) return box;
  box.appendChild(el(`<div class="conv-h">${esc(t("conv.recent"))}</div>`));

  const search = el(`<div class="conv-search"><input id="convq" placeholder="${esc(t("conv.search"))}" autocomplete="off"/></div>`);
  const qInput = search.querySelector<HTMLInputElement>("input")!;
  qInput.value = convQuery;
  const rows = el(`<div class="conv-rows"></div>`);
  const paintRows = () => {
    rows.innerHTML = "";
    const filtered = searchConversations(metasWithLive(), convQuery);
    const activeId = store.current().id;
    for (const m of filtered.slice(0, convQuery.trim() ? 50 : 12)) {
      rows.appendChild(convRowEl(m, activeId));
      // The tree: a conversation that has a team shows it, indented under it.
      const conv = store.get(m.id);
      if (!conv || !conv.team.length) continue;
      for (const sub of conv.team) rows.appendChild(teamRowEl(conv, sub, m.id === activeId));
    }
    if (!filtered.length) rows.appendChild(el(`<div class="conv-none">${esc(t("conv.noMatch"))}</div>`));
  };
  qInput.addEventListener("input", () => { convQuery = qInput.value; paintRows(); });
  paintRows();
  box.append(search, rows);
  return box;
}

/** One teammate under its conversation: name, role, and whether it is working. */
function teamRowEl(conv: Conversation, sub: SubAgent, convActive: boolean): HTMLElement {
  const th = threads.get(threadKey(conv.id, sub.id));
  const busy = !!th?.generating;
  const asking = permWaiting(threadKey(conv.id, sub.id));
  const on = convActive && focusAgent === sub.id;
  const row = el(`<div class="conv sub ${on ? "on" : ""} ${busy ? "busy" : ""} ${asking ? "asking" : ""}" title="${esc(asking ? t("perm.waiting") : sub.role || sub.name)}">
    <span class="tw"></span>
    ${asking ? `<span class="askpip" title="${esc(t("perm.waiting"))}">?</span>` : busy ? `<span class="runpip" title="${esc(t("conv.running"))}"></span>` : `<span class="subdot"></span>`}
    <span class="ct">${esc(sub.name)}</span>
    <span class="cn">${sub.items.length}</span>
  </div>`);
  row.addEventListener("click", async () => {
    if (conv.id !== store.current().id) await openConversation(conv.id);
    openTeamThread(sub.id);
  });
  return row;
}

function convRowEl(m: ConvMeta, activeId: string): HTMLElement {
  // Running indicator: a thread that is generating says so wherever the user
  // is. With a team, the count is what tells the user how much of the
  // conversation is alive right now.
  const conv = store.get(m.id);
  const own = threads.get(threadKey(m.id));
  const busy = conv ? busyIn(conv) : own?.generating ? 1 : 0;
  const queued = own ? own.queued.length : 0;
  const teamSize = conv?.team.length ?? 0;
  const asking = conv ? permWaitingIn(conv) : permWaiting(m.id);
  const row = el(`<div class="conv ${m.id === activeId ? "on" : ""} ${busy ? "busy" : ""} ${asking ? "asking" : ""}" data-c="${esc(m.id)}" ${asking ? `title="${esc(t("perm.waiting"))}"` : ""}>
    ${asking ? `<span class="askpip" title="${esc(t("perm.waiting"))}">?</span>` : busy ? `<span class="runpip" title="${esc(t("conv.running"))}"></span>` : ""}
    <span class="ct">${esc(m.title || t("conv.untitled"))}</span>
    ${teamSize ? `<span class="cteam" title="${esc(t("team.size").replace("%n", String(teamSize)))}">${teamSize}</span>` : ""}
    ${queued > 0 ? `<span class="cq" title="${esc(t("conv.queued"))}">+${queued}</span>` : ""}
    <span class="cx exp" data-exp="${esc(m.id)}" title="${esc(t("conv.export"))}">↓</span>
    <span class="cx" data-del="${esc(m.id)}">×</span>
  </div>`);
  row.addEventListener("click", async (e) => {
    const exp = (e.target as HTMLElement).closest("[data-exp]") as HTMLElement | null;
    if (exp) {
      e.stopPropagation();
      await exportConversation(m.id, exp);
      return;
    }
    const del = (e.target as HTMLElement).closest("[data-del]") as HTMLElement | null;
    if (del) {
      e.stopPropagation();
      const delId = del.dataset.del!;
      cancelPermissionsOfConv(delId);
      // The whole tree goes with the file: leaving an agent alive would keep
      // streaming into a thread that no longer exists, and the debounced save
      // would recreate the conversation on disk.
      for (const th of [...threads.values()]) {
        if (th.conv.id !== delId) continue;
        th.agent?.stop();
        th.agent = null;
        th.generating = false;
        for (const w of th.waiters.splice(0)) w("error: that conversation was deleted");
        if (th.holdsSlot) { th.holdsSlot = false; releaseSlot(); }
        threads.delete(th.key);
      }
      const wasActive = store.current().id === delId;
      await store.remove(delId);
      if (wasActive) { focusAgent = null; hideActivity(); }
      render();
      return;
    }
    if (m.id !== store.current().id) await openConversation(m.id);
    else if (focusAgent) openTeamThread(null);
  });
  return row;
}

/** Export a conversation to Markdown in a folder the user picks. */
async function exportConversation(id: string, trigger: HTMLElement): Promise<void> {
  let conv: Conversation | null = store.current().id === id ? store.current() : null;
  if (!conv) {
    try {
      const v = (await api.convLoad(id)) as any;
      conv = {
        id: String(v.id ?? id),
        title: String(v.title ?? ""),
        created: Number(v.created ?? Date.now()),
        updated: Number(v.updated ?? Date.now()),
        items: Array.isArray(v.items) ? v.items : [],
        history: Array.isArray(v.history) ? v.history : [],
        contextSummary: typeof v.contextSummary === "string" ? v.contextSummary : "",
        plan: Array.isArray(v.plan) ? v.plan : [],
        team: Array.isArray(v.team) ? v.team : [],
      };
    } catch {
      return;
    }
  }
  if (!conv) return;
  const md = exportConversationMarkdown(conv);
  const dir = await pickFolderOrSay();
  if (!dir) return;
  const name =
    (conv.title || t("conv.untitled")).replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 60) || "conversation";
  try {
    await api.fsWrite(`${dir}/${name}.md`, md);
    trigger.textContent = "✓"; // transient, the row is rebuilt on next render
  } catch (e: any) {
    trigger.textContent = "!";
    trigger.title = String(e?.message ?? e);
  }
}

/**
 * Everything the Code view needs from the shell. It never imports main.ts back
 * (that would be a cycle): the shell hands it these, exactly like the Agent
 * gets its team directory.
 */
const codeDeps: codeview.CodeDeps = {
  toast,
  ask: async (req: PermissionRequest) => {
    // Same queue, same dialog, same z-order as a model's request. The owner is
    // the view, not a thread: stopping an agent must not answer for the user
    // here, and nothing else can settle it either.
    const d = await askPermission(req, "code:view", t("nav.code"));
    return d === "once" || d === "always";
  },
  mountAgent: (host: HTMLElement) => {
    host.appendChild(
      el(`<div class="cside-h"><span class="t">${esc(t("code.agentPane"))}</span><span class="grow"></span><div class="iconbtn" id="cnewchat" title="${esc(t("nav.newchat"))}">${I.plus}</div></div>`)
    );
    host.appendChild(threadPaneEl());
    host.querySelector("#cnewchat")!.addEventListener("click", newChat);
  },
  paintNav: () => {
    const item = document.querySelector<HTMLElement>('.nav [data-v="code"]');
    if (!item) return;
    const n = codeview.pendingCount();
    const badge = item.querySelector(".navbadge");
    if (!n) badge?.remove();
    else if (badge) badge.textContent = String(n);
    else item.appendChild(el(`<span class="navbadge" title="${esc(t("code.pendingNav"))}">${n}</span>`));
  },
  saveSetting: (key, value) => api.settingsSet(key, value),
  autoTabReady: () => autoTabOn && server.running && server.phase === "ready",
  inlineComplete: (rel, prefix, suffix, signal) =>
    inlineCodeOnce(server.port, rel, prefix, suffix, signal).catch(() => null),
  // Deliberately NOT gated on autoTabOn. Cmd+K is an explicit gesture, and
  // switching ghost text off is not a request to lose the editor's only way to
  // ask for a rewrite.
  inlineEditReady: () => server.running && server.phase === "ready",
  inlineEdit: (prompt, signal) =>
    chatOnce(
      server.port,
      [
        {
          role: "system",
          content:
            "You are a code editing engine. Reply with the replacement code only: " +
            "no explanation, no markdown fence, no line numbers, no commentary.",
        },
        { role: "user", content: prompt },
      ],
      0.1,
      signal
    ).catch(() => null),
};

async function boot() {
  // The Agent can now hand work to other conversations: give it the directory
  // before anything can create one.
  setAgentDirectory(teamDirectory);
  codeview.setCodeDeps(codeDeps);
  // A write inside the open workspace is a proposal, not a write. Installed
  // before any agent exists so no turn can ever run without it.
  setCodeWorkspace({
    root: () => codeview.codeRoot(),
    propose: (path, rel, content) => codeview.fileProposal(path, rel, content, true),
  });
  // What the runs view cannot know on its own: which port the engine is on
  // right now, whether it can actually drive an agent, and how to say
  // something to the user. Installed before any run can be declared.
  runsview.configureRuns({
    port: () => server.port,
    ready: () => server.running && server.phase === "ready" && !toolsBlocked(),
    toast: (message, kind) => toast(message, kind),
  });
  await loadStandingPermissions().catch(() => {});
  // Before the first agent exists: an Agent reads the configured sampling at
  // construction, so a conversation opened during boot would otherwise be
  // built with the defaults and keep them for its whole life.
  {
    const s = await api.settingsGet().catch(() => ({}) as Record<string, string>);
    configureSampling(readSampling(s));
    configureThinking(s["thinking"] !== "0");
  }
  const s = await api.settingsGet().catch(() => ({} as Record<string, string>));
  configurePanePreferences(s, (key, value) => api.settingsSet(key, value));
  if (s["root"]) { root = s["root"]; try { registry = await api.registry(); if (!registry.length) root = null; } catch { root = null; } }
  if (s["autonomy"]) autonomy = s["autonomy"] as Autonomy;
  autoTabOn = s["auto_tab"] !== "0";
  // The Code workspace comes back where it was left.
  await codeview.initCodeRoot(s["code_root"], s["code_tabs"]).catch(() => {});
  if (s["ram_mode"] === "eco" || s["ram_mode"] === "perf") ramMode = s["ram_mode"];
  if (s["app_mode"] === "server") appMode = "server";
  modeAskAlways = s["app_mode_ask"] === "1";
  // Keyed on "was the question ever PUT", not on "is there a value".
  //
  // app_mode has existed for two releases, written by a settings row nobody
  // could find, so plenty of installs already hold one. Reading it as an answer
  // would mean the people this screen exists for, the ones who have a stored
  // mode they never deliberately chose, are exactly the ones who never see it.
  // A separate key is the only thing that can tell a choice from a leftover.
  modePending = modeAskAlways || s["app_mode_chosen"] !== "1";
  // Defaults on. The launch check is one GET of a small JSON file and it
  // installs nothing; the setting exists for people who would rather their app
  // never spoke to the network unasked, and server mode ignores it entirely
  // (see autoCheckAllowed).
  updateAutoCheck = s["update_check_auto"] !== "0";
  // The version the updater compares against is the one this binary reports,
  // never the one in package.json: those two have drifted before, and a stale
  // constant here is either an update that is never offered or one that is
  // offered forever.
  try { appVersion = await getVersion(); } catch { appVersion = ""; }
  if (s["relay_bind"] === "0.0.0.0") relayBind = "0.0.0.0";
  // The relay never survives a restart: the key lived in memory only, so there
  // is nothing to reopen with. Its status is read anyway, since a previous
  // window of the same process could have left it listening.
  api.relayStatus().then((r) => { relay = r; }).catch(() => {});
  api.relayAddresses().then((a) => { relayLanAddress = a[1] ?? ""; }).catch(() => {});
  try { skillsOff = new Set(JSON.parse(s["skills_off"] ?? "[]")); } catch {}
  for (const [k, val] of Object.entries(s)) {
    if (!k.startsWith("bench_")) continue;
    try {
      const parsed = JSON.parse(val);
      if (Number.isFinite(parsed?.tps)) benchResults[k.slice(6)] = Number(parsed.tps);
    } catch {}
  }
  try { hw = await api.hwInfo(); } catch {}
  enabled = await loadEnabled().catch(() => []);
  await loadTaskDefs();
  await store.refreshList().catch(() => {});
  // Reopen the most recent thread instead of landing on a blank one. Quitting
  // the app used to lose the conversation entirely: the store starts with no
  // active thread, current() hands out a blank, and a user typing "carry on"
  // was talking to an empty context.
  {
    const recent = store.metas()[0];
    if (recent) await store.open(recent.id).catch(() => null);
    // The visible thread always has a record, and so does every teammate it
    // owns: their rows and blocks read live state from it.
    threadOf(store.current());
    teamThreads(store.current());
  }
  try { slashSkills = (await api.skillsList()).filter((k) => !skillsOff.has(k.name)); } catch {}
  try { mcpCount = (await api.mcpTools()).length; } catch {}
  await refreshServer();
  if (server.running && server.phase === "starting") loadStartMs = Date.now();
  render();
  syncTray();
  // Never before the first paint, and never in server mode. See the comment
  // above the update section: this is a check, not an install, and it is the
  // only thing in this feature that happens without a click.
  maybeAutoCheck();
  // A job came due. Rust owns the clock and has already decided this is the
  // one fire to honour (see the catch-up rule in scheduler.rs); all that is
  // left here is to declare the run and drive it. Subscribed at the app shell
  // rather than inside the Runs view, because a job must fire whether or not
  // anyone is looking at that screen.
  await onEvent("galactus://job-due", (p: any) => {
    runsview.runScheduledJob(p);
    if (view === "runs") render();
  });
  await onEvent("galactus://install-progress", (p: any) => {
    if (p.done) {
      installProgress.delete(p.model_id);
      if (p.phase === "error") toast(t("install.failed").replace("%s", String(p.label ?? "")));
      api.registry().then((r) => { registry = r; render(); }).catch(() => render());
    } else {
      installProgress.set(p.model_id, { pct: p.pct, label: p.label });
      // In place when the card already shows a bar, which is every tick but the
      // first. The first one needs a full render, because the Download button
      // has to become a cancel button.
      if (view === "models" && !paintInstallProgress(p.model_id)) render();
    }
  });
  await onEvent("galactus://voice", (p: any) => {
    const inp = document.getElementById("ci") as HTMLTextAreaElement | null;
    if (p.kind === "partial") {
      if (inp) { inp.value = dictBase + String(p.text ?? ""); inp.dispatchEvent(new Event("input")); }
      return;
    }
    dictating = false;
    document.getElementById("micbtn")?.classList.remove("rec");
    if (p.kind === "final") {
      const spoken = String(p.text ?? "");
      if (inp) {
        inp.value = (dictBase + spoken).trimEnd() + (spoken.trim() ? " " : "");
        inp.dispatchEvent(new Event("input"));
        inp.focus();
      } else if (spoken.trim()) {
        // The user left the chat view mid-dictation: never lose the words.
        toast(spoken, "ok");
      }
    } else if (p.kind === "error") {
      const msg = String(p.text ?? "");
      toast(msg === "permission_denied" ? t("voice.denied") : t("voice.error").replace("%s", msg));
    }
  });
  await onEvent("galactus://server", async (p: any) => {
    if (p && (p.phase === "failed" || p.phase === "timeout")) {
      serverFail = {
        kind: p.phase,
        code: typeof p.code === "number" ? p.code : undefined,
        log: String(p.log ?? ""),
        cause: typeof p.kind === "string" ? p.kind : undefined,
      };
    } else if (p && typeof p.phase === "string") {
      serverFail = null;
    }
    await refreshServer();
    if (server.running && server.phase === "starting") {
      if (loadStartMs === null) loadStartMs = Date.now();
    } else {
      loadStartMs = null;
    }
    // A model start fires this event repeatedly for minutes. A full rebuild
    // while the user types in the Memory textarea or the custom-connector
    // form would wipe their edits; those views only show server state in
    // the sidebar pill, so repaint just that.
    // The Code view holds a live editor, and possibly a pending diff nobody
    // has answered yet: a rebuild on every load tick would throw both away.
    // The tool probe can land while the Code view is already open, on a model
    // that turns out to drive nothing. Leaving the user in a view whose whole
    // point is an agent that cannot act is worse than moving them out of it,
    // so this fallback takes precedence over the partial repaint below.
    if (view === "code" && toolsBlocked()) {
      view = "chat";
      render();
      return;
    }
    // The Runs view is in the same list, and for a stronger reason than a
    // draft: it repaints itself from its own state as its runs move, and a
    // rebuild every two seconds during a model start would fight that repaint
    // and take the caret out of a note somebody is typing into a blocked run.
    if (view === "memory" || view === "connectors" || view === "code" || view === "runs") {
      renderServerPill();
      paintComposerReady();
    } else render();
  });

  // Loading elapsed ticker: refresh the counter without repainting the view.
  setInterval(() => {
    const e = document.getElementById("loadelapsed");
    if (e && loadStartMs) e.textContent = loadElapsedText();
  }, 1000);

  // Window dragging: WKWebView ignores `-webkit-app-region` (Electron-only),
  // so the hidden-titlebar window has NO native grab area. Drive it manually:
  // any press on a drag-region zone that is not an interactive control starts
  // a native window drag; a double press toggles maximize like a real titlebar.
  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (!t.closest("[data-tauri-drag-region]")) return;
    if (t.closest("button, input, textarea, select, a, .iconbtn, .mpill, .task-bar, .seg, .seg-mode, .tgl, .link")) return;
    const win = getCurrentWindow();
    if (e.detail >= 2) win.toggleMaximize().catch(() => {});
    else win.startDragging().catch(() => {});
  });

  // Live header metrics: engine RSS every 2 s while a model runs, and the
  // tok/s chip refreshed even between deltas.
  setInterval(async () => {
    if (server.running) {
      try {
        const m = await api.serverMetrics();
        liveRss = m.running && m.rss_bytes ? m.rss_bytes : 0;
      } catch { liveRss = 0; }
    } else {
      liveRss = 0;
      liveTps = null;
    }
    paintLive();
  }, 2000);

  // Quitting or hiding the window: flush EVERY thread's pending debounced
  // save. With one timer per conversation, a single global flush on the active
  // one would have dropped whatever the background threads just wrote.
  // Runs are on the same checkpoint: their debounced writes are the only
  // record of a turn that already happened.
  window.addEventListener("beforeunload", () => { store.flushAll(); runsview.flushRuns(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { store.flushAll(); runsview.flushRuns(); }
  });

  // Keyboard shortcuts: ⌘N new chat, ⌘1..8 navigation, and inside the Code
  // view ⌘P (file palette), ⇧⌘O (symbol palette), ⇧⌘F (project search).
  /**
   * The views server mode keeps. It removes the assistant surfaces: the chat,
   * the workspace, the memory and the agent. Written once here so the keyboard
   * and the navigation buttons cannot disagree about it, which they did.
   */
  const SERVER_VIEWS: View[] = ["models", "connectors", "runs", "learned", "settings"];
  const NAV_ORDER: View[] = ["chat", "code", "models", "connectors", "runs", "memory", "agent", "learned", "settings"];
  window.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    if (!root) return;
    const k = e.key.toLowerCase();
    // The Code view claims three combinations, and only while it is on screen.
    // ⌘P is the webview's print binding, so it has to be taken explicitly.
    if (view === "code" && (k === "p" || (e.shiftKey && (k === "o" || k === "f")))) {
      // A palette owns the keyboard while it is up; the shell keeps out except
      // to close it, which codeShortcut answers for.
      if (document.querySelector(".modal-bd") && !codeview.paletteIsOpen()) return;
      if (codeview.codeShortcut(k, e.shiftKey)) {
        e.preventDefault();
        return;
      }
    }
    // Everything below is a bare ⌘, never a ⇧⌘: ⇧⌘N is not "new chat".
    if (e.shiftKey) return;
    if (document.querySelector(".modal-bd")) return;
    if (k === "n") {
      e.preventDefault();
      newChat();
    } else if (view === "code" && codeview.tabShortcut(e)) {
      // Inside the Code view the tab gestures win: Cmd-1..9 selects a tab
      // there, and selects a view everywhere else. Consulted before the
      // navigation branch below so the two cannot both fire.
      e.preventDefault();
    } else if (k >= "1" && k <= "8" && k.length === 1) {
      e.preventDefault();
      const target = NAV_ORDER[Number(k) - 1];
      // The same two gates the navigation buttons apply. They were absent here,
      // so a shortcut reached views the app had deliberately removed: server
      // mode exists to take the chat away, and Code and Runs are disabled on a
      // model measured unable to emit tool calls. A keyboard path around a
      // guard is the guard not existing.
      if (appMode === "server" && !SERVER_VIEWS.includes(target)) return;
      if ((target === "code" || target === "runs") && toolsBlocked()) return;
      view = target;
      render();
    }
  });
}
boot().catch((error: unknown) => {
  const message = String((error as any)?.message ?? error ?? "Erreur inconnue");
  // Keep an already usable shell alive if a late event subscription fails.
  if (app.querySelector(".layout")) {
    toast(`Initialisation partielle : ${message}`);
    return;
  }
  app.innerHTML = "";
  const failure = el(`<div class="boot-shell boot-failed" role="alert">
    <img src="${LOGO}" alt=""/>
    <div><b>Galactus n’a pas pu démarrer</b><span>${esc(message)}</span></div>
    <button class="bs" type="button">Réessayer</button>
  </div>`);
  failure.querySelector("button")!.addEventListener("click", () => window.location.reload());
  app.appendChild(failure);
});
