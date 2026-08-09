import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, benchOnce, HwInfo, inlineCodeOnce, InstallVolumes, ModelEntry, onEvent, ServerStatus, SkillInfo, VolumeInfo } from "./api";
import {
  Agent,
  AgentDirectory,
  clearStandingPermissions,
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
import { Cosmos } from "./cosmos";
import { detectPreviewable, PreviewKind, PreviewPanel } from "./preview";
import { currentTask, loadTasks, pickModelFor, setCurrentTask, TaskDef, TaskId } from "./tasks";
import { detectTask, getAutoMode, mayAutoSwap, planSwap, setAutoMode, type AutoMode } from "./autotask";
import { exportConversationMarkdown, formatStats, searchConversations, wireDropZone } from "./chatx";
import * as store from "./store";
import type { ChatItem, Conversation, ConvMeta, SubAgent, ThreadData } from "./store";
import { hasVerifiedDownload, modelAvailability, modelCertification } from "./model-policy";
import { configurePanePreferences, wirePaneResizer } from "./layout/pane-resize";

const app = document.getElementById("app")!;
const LOGO = "/galactus-mark.svg";

type View = "chat" | "code" | "models" | "connectors" | "memory" | "agent" | "settings";
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
let serverFail: { kind: "failed" | "timeout"; code?: number; log: string } | null = null;
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

function hideActivity() {
  const bar = document.getElementById("actbar");
  // Masque sans retirer la place : la saisie ne doit pas sauter quand il
  // sort de scene.
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
        if (pixel === px) hideActivity();
      }, 2600);
    } else {
      hideActivity();
    }
    return;
  }
  if (mode === "thinking" && !label) label = t("px.thinking");
  if (!sess.generating) {
    sess.activity = null;
    if (visible) hideActivity();
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
  else hideActivity();
}

// ---------- svg icons ----------
const I = {
  chat: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 21l1.9-5A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z"/></svg>`,
  code: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m8 17-5-5 5-5"/><path d="m16 7 5 5-5 5"/><path d="M13.5 4.5 10.5 19.5"/></svg>`,
  models: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 3 7l9 5 9-5-9-5z"/><path d="M3 12l9 5 9-5"/><path d="M3 17l9 5 9-5"/></svg>`,
  conn: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17H7a5 5 0 0 1 0-10h2"/><path d="M15 7h2a5 5 0 0 1 0 10h-2"/><path d="M8 12h8"/></svg>`,
  mem: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4a4 4 0 0 0-4 4 3.5 3.5 0 0 0-1 6.8V17a3 3 0 0 0 5 2.2A3 3 0 0 0 17 17v-2.2A3.5 3.5 0 0 0 16 8a4 4 0 0 0-4-4z"/></svg>`,
  agent: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3"/><rect x="5" y="6" width="14" height="11" rx="3"/><path d="M9 11h.01M15 11h.01"/><path d="M9 14h6"/><path d="M5 12H3M21 12h-2"/></svg>`,
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
  const nonExpert = (m.non_expert_bytes ?? 5e9) / 1e9;
  // Keep the UI estimate identical to Rust: 2 GB through 32 GB, then 6.25%
  // of unified memory on larger Macs.
  const systemReserve = Math.max(2, hw.ram_gb / 16);
  const overhead = nonExpert + (2.5 + nonExpert * 0.45) + systemReserve;
  const maxCache = Math.min(hw.ram_gb - overhead, hw.ram_gb * 0.7, (m.expert_bytes_total ?? Infinity) / 1e9);
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
    th.agent?.setMode(autonomy === "manual" && !th.sub ? "chat" : "agent");
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

function serverFailCard(): HTMLElement {
  const f = serverFail!;
  const tail = f.log.trim().split("\n").slice(-12).join("\n");
  const card = el(`<div class="errcard">
    <div class="eh"><span class="edot"></span><b>${esc(f.kind === "timeout" ? t("srvfail.timeoutTitle") : t("srvfail.title"))}</b>${f.code != null ? `<span class="code">exit ${f.code}</span>` : ""}</div>
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
    <div class="composer">
      <div class="actbar" id="actbar" style="visibility:hidden"><div class="pxhost" id="pixelhost"></div></div>
      <div class="comp-box">
      <textarea id="ci" rows="2" placeholder="${esc(sub ? t("team.placeholder").replace("%s", sub.name) : t("chat.placeholder"))}"></textarea>
      <div class="comp-bar">
        <div class="tool-btn" id="gotoconn">${I.conn}<span>${mcpCount}</span></div>
        ${slashSkills.some((s) => s.name === "recherche-sourcee") ? `<div class="tool-btn deep ${deepResearch ? "on" : ""}" id="deepbtn" title="${esc(t("chat.deepHint"))}">${I.scope}<span>${esc(t("chat.deep"))}</span></div>` : ""}
        <div class="seg-mode ${sub ? "off" : ""}" id="modeseg">
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
      <div class="pxden-void" aria-hidden="true"></div>
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
 * `from` is set when another conversation's agent sent this message: it is
 * labelled and styled apart, so nothing ever arrives in a thread without the
 * user seeing who put it there.
 */
function userRowEl(text: string, from?: string): HTMLElement {
  if (from) {
    return el(`<div class="row-u from-agent">
      <div class="bub-u"><span class="fromtag">${esc(t("chat.fromAgent").replace("%s", from))}</span>${esc(text)}</div>
      <div class="av u agent" title="${esc(t("chat.fromAgent").replace("%s", from))}">⇄</div>
    </div>`);
  }
  return el(`<div class="row-u"><div class="bub-u">${esc(text)}</div><div class="av u">${esc(t("chat.you")[0] || "V")}</div></div>`);
}

function assistantBodyEl(): { row: HTMLElement; body: HTMLElement } {
  const row = el(`<div class="row-a"><div class="av a">G</div><div class="body"></div></div>`);
  return { row, body: row.querySelector(".body")! };
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
      log.appendChild(userRowEl(it.text, it.from));
    } else if (it.kind === "assistant") {
      if (!body) { const r = assistantBodyEl(); log.appendChild(r.row); body = r.body; }
      const md = el(`<div class="msg-a md"></div>`);
      md.innerHTML = renderMarkdown(it.text, { streaming: !it.text.endsWith("\n") && generating });
      wireCodeCopy(md, t("chat.copied"));
      addPreviewButtons(md);
      body.appendChild(md);
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
        api.ttsSpeak(text).catch(() => { ttsPlaying = false; });
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
  requestAnimationFrame(() => { paintPending = false; paintChat(); scrollChatDown(); paintLive(); paintTeamStrip(); });
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
  await dispatchTurn(active(), text, { show: true });
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
  if (next) void dispatchTurn(sess, next, {});
  else renderSidebarOnly();
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
  if (hw) {
    hwbar.innerHTML = `
      <div class="ico">${I.chip}</div>
      <div class="st"><small>${esc(t("hw.chip"))}</small><b>${esc(hw.chip || "Mac")}</b></div>
      <div class="div"></div>
      <div class="st"><small>${esc(t("hw.ram"))}</small><b>${hw.ram_gb} GB</b></div>
      <div class="div"></div>
      <div class="st"><small>${esc(t("hw.disk"))}</small><b>${hw.disk_free_gb} GB</b></div>
      <span class="grow"></span>
      <span class="note">${esc(t("models.hwNote"))}</span>`;
  }
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
    const card = el(`<div class="mcard ${certification.canExecute ? "" : "uncertified"}">
      <div class="top">
        <div class="info">
          <div class="nm"><b>${esc(m.name)}</b><span class="chip-cert ${certification.canExecute ? "" : "pending"}">${certification.canExecute ? "✓" : "◷"} ${esc(certLabel)}</span></div>
          <span class="meta">${esc(m.arch)} · ${fmtGb(m.gguf_bytes)} · ${m.experts_used ?? "?"}/${m.experts ?? "?"}</span>
        </div>
        <div class="spd"><b style="color:${speedColor}">${tps && v.ok ? (measured ? "" : "~") + tps.toFixed(0) : "·"}</b><small>${esc(v.ok ? t(measured ? "models.measured" : "models.onThisMac") : "·")}</small></div>
      </div>
      <div class="bar"><div style="width:${bar}%"></div></div>
      <div class="foot"><span class="n">${prog ? `<b style="color:var(--acc-tx)">${Math.round(prog.pct)}%</b> · ${esc(installLabel(prog.label))}` : esc(v.note || (m.installed ? t("models.installed") : (m.arch + " · " + (m.experts_used ?? "?") + " active")))}</span><span data-a></span></div>
      ${prog ? `<div class="bar" style="margin-top:2px"><div style="width:${prog.pct}%"></div></div>` : ""}
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
  return wrap;
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
    box.querySelector("[data-pick]")?.addEventListener("click", async () => { const p2 = await api.pickFolder(); if (p2) { inp.value = p2; active.values[fld.key] = p2; mcpCount = await saveEnabled(enabled); } });
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
  wrap.querySelector("#wspick")!.addEventListener("click", async () => { const p = await api.pickFolder(); if (p) { wspath.value = p; await api.settingsSet("workspace", p); memtext.value = await api.memoryRead(); } });
  {
    const b = wrap.querySelector<HTMLElement>("#memsave")!;
    b.addEventListener("click", async () => {
      await api.memoryWrite(memtext.value);
      const prev = b.textContent;
      b.textContent = t("mem.saved");
      setTimeout(() => { b.textContent = prev; }, 1500);
    });
  }
  wrap.querySelector("#vpick")!.addEventListener("click", async () => { const p = await api.pickFolder(); if (p) { vaultline.textContent = p; await api.settingsSet("obsidian_vault", p); } });
  wrap.querySelector("#vcosmos")!.addEventListener("click", () => { openCosmos(); });
  wrap.querySelector("#vnew")!.addEventListener("click", async () => {
    const p = await api.pickFolder();
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
      const p = await api.pickFolder();
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
  wrap.querySelector("#wspick")!.addEventListener("click", async () => { const p = await api.pickFolder(); if (p) { wspath.value = p; await api.settingsSet("workspace", p); render(); } });

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
function settingsView(): HTMLElement {
  const wrap = el(`<div class="main">
    <div class="topbar" data-tauri-drag-region><span class="ttl">${esc(t("nav.settings"))}</span></div>
    <div class="page"><div class="hold narrow">
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
      <div class="set-row"><div class="grow"><b>${esc(t("settings.slots"))}</b><span>${esc(t("settings.slotsHint"))}</span></div>
        <div class="seg" id="slotseg">
          <button data-sl="1">1</button>
          <button data-sl="2">2</button>
          <button data-sl="3">3</button>
          <button data-sl="4">4</button>
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
      <div class="set-row"><div class="grow"><b>${esc(t("settings.permissions"))}</b><span>${esc(t("settings.permissionsHint"))}</span></div><button class="bs" id="pclear">${esc(t("settings.permissionsClear"))}</button></div>
    </div></div></div>`);
  wrap.querySelector("#lang")!.addEventListener("click", async (e) => { const b = (e.target as HTMLElement).closest("[data-l]") as HTMLElement | null; if (!b) return; setLang(b.dataset.l as Lang); await loadTaskDefs(); render(); });
  wrap.querySelector("#rpick")!.addEventListener("click", async () => { const p = await api.pickFolder(); if (p) await setRoot(p); });
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
    const seg = wrap.querySelector<HTMLElement>("#slotseg")!;
    const paint = (n: string) =>
      seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", (b as HTMLElement).dataset.sl === n));
    paint(String(engineSlots()));
    api.settingsGet().then((st) => paint(String(Math.min(Math.max(Number(st["engine_slots"]) || 2, 1), 4))));
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
async function pickRoot() { const p = await api.pickFolder(); if (p) await setRoot(p); }
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
async function refreshServer() { try { server = await api.serverStatus(); } catch {} }

let composerDraft = "";

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

  const { pill, text: srvText } = serverPillState();
  const nav = (v: View, ic: string, label: string, badge = 0) =>
    `<button type="button" class="nav-item ${view === v ? "on" : ""}" data-v="${v}" aria-current="${view === v ? "page" : "false"}">${ic}<span>${esc(label)}</span>${badge > 0 ? `<span class="navbadge" title="${esc(t("code.pendingNav"))}">${badge}</span>` : ""}</button>`;

  const layout = el(`<div class="layout">
    <div class="side">
      <div class="side-head" data-tauri-drag-region></div>
      <div class="brand2"><img class="mark" src="${LOGO}" alt="Galactus"/><div class="txt"><b>Galactus</b><span>${esc(t("brand.by"))}</span></div></div>
      <div class="nav">
        ${nav("chat", I.chat, t("nav.chat"))}
        ${nav("code", I.code, t("nav.code"), codeview.pendingCount())}
        ${nav("models", I.models, t("nav.models"))}
        ${nav("connectors", I.conn, t("nav.connectors"))}
        ${nav("memory", I.mem, t("nav.memory"))}
        ${nav("agent", I.agent, t("nav.agent"))}
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
    : view === "memory" ? memoryView()
    : view === "agent" ? agentView()
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
  const dir = await api.pickFolder();
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
  await loadStandingPermissions().catch(() => {});
  const s = await api.settingsGet().catch(() => ({} as Record<string, string>));
  configurePanePreferences(s, (key, value) => api.settingsSet(key, value));
  if (s["root"]) { root = s["root"]; try { registry = await api.registry(); if (!registry.length) root = null; } catch { root = null; } }
  if (s["autonomy"]) autonomy = s["autonomy"] as Autonomy;
  autoTabOn = s["auto_tab"] !== "0";
  // The Code workspace comes back where it was left.
  await codeview.initCodeRoot(s["code_root"]).catch(() => {});
  if (s["ram_mode"] === "eco" || s["ram_mode"] === "perf") ramMode = s["ram_mode"];
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
  await onEvent("galactus://install-progress", (p: any) => {
    if (p.done) {
      installProgress.delete(p.model_id);
      if (p.phase === "error") toast(t("install.failed").replace("%s", String(p.label ?? "")));
      api.registry().then((r) => { registry = r; render(); }).catch(() => render());
    } else { installProgress.set(p.model_id, { pct: p.pct, label: p.label }); if (view === "models") render(); }
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
    if (view === "memory" || view === "connectors" || view === "code") {
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
  window.addEventListener("beforeunload", () => store.flushAll());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") store.flushAll();
  });

  // Keyboard shortcuts: ⌘N new chat, ⌘1..7 navigation, and inside the Code
  // view ⌘P (file palette), ⇧⌘O (symbol palette), ⇧⌘F (project search).
  const NAV_ORDER: View[] = ["chat", "code", "models", "connectors", "memory", "agent", "settings"];
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
    } else if (k >= "1" && k <= "7" && k.length === 1) {
      e.preventDefault();
      view = NAV_ORDER[Number(k) - 1];
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
