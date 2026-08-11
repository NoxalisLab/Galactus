// Galactus, conversation store.
//
// The chat used to be drawn straight into DOM nodes captured by the agent's
// callbacks. Any re-render (server event, mode switch, navigation) detached
// those nodes and every later token went into a dead subtree, the thread
// simply stopped updating. Everything now lives in this store; the view is a
// pure function of it, and callbacks mutate state then ask for a repaint.
//
// A conversation is no longer one thread but a small tree: the user's thread,
// plus the persistent thread of every sub-agent it owns (its team). They all
// run at the same time, each with its own Agent, so the store holds a map of
// loaded conversations instead of a single active one, every mutation names
// the THREAD it touches, and each conversation owns its debounce timer: two
// threads writing at the same time must never flush each other's state into
// the wrong file. A sub-agent's thread is stored inside its parent's file, so
// reopening a conversation brings the whole team back with it.

import { api, ChatMessage } from "./api";
import type { PlanStep } from "./agent";
import { isRunId } from "./runrecord";
import { appendReasoning as growThought, hasReasoning } from "./reasoning";

export type ChatItem =
  | { kind: "user"; text: string; /** Set when another agent of the team sent this. */ from?: string }
  | { kind: "assistant"; text: string }
  /**
   * What the model thought before it wrote anything. `done` is false only
   * while it streams: the moment the answer, a tool call or the end of the
   * turn arrives, the block settles and the answer takes the reading surface.
   *
   * STORED, like every other item, and for the same reason: a conversation
   * that reopens with its answers but not the thinking that produced them
   * loses something the reader watched happen. It is NOT put in `history`,
   * so it never re-enters the model's context. See agent.ts.
   */
  | { kind: "reasoning"; text: string; done: boolean }
  | { kind: "tool"; name: string; arg: string; result: string; done: boolean; path?: string }
  | { kind: "error"; text: string }
  | { kind: "notice"; text: string }
  /**
   * A teammate's work, shown in the thread that asked for it. It is a live
   * block, not a summary: it names the agent, carries what it was asked and
   * what it answered, and opens its full thread.
   */
  | {
      kind: "agent";
      agentId: string;
      name: string;
      role: string;
      ask: string;
      answer: string;
      done: boolean;
      failed?: boolean;
    };

/**
 * Everything that makes a thread: what the user sees, what the model sees, and
 * what an interrupted window had to be condensed into. A conversation is one,
 * and so is every sub-agent of its team.
 */
export interface ThreadData {
  items: ChatItem[];
  history: ChatMessage[];
  /**
   * What the model wrote about the part of the thread that no longer fits the
   * window. It lives in the Agent while the app runs, and it MUST be stored:
   * a digested thread whose summary is lost reopens with only its trimmed
   * tail, which is why a long conversation used to come back amnesic.
   */
  contextSummary: string;
  plan: PlanStep[];
}

/**
 * A named teammate of one conversation, with its OWN persistent thread.
 *
 * The point of the team is that the work is inspectable: the sub-agent's
 * messages, tool calls and results are stored in full, alongside the parent
 * conversation and in the same file, so reopening the conversation brings the
 * whole team back exactly where it was.
 */
export interface SubAgent extends ThreadData {
  id: string;
  /** Short handle the model addresses it by ("architect", "reviewer"). */
  name: string;
  /** One line: what this teammate is responsible for. */
  role: string;
  /** Standing instructions; becomes its system persona. */
  brief: string;
  created: number;
  updated: number;
}

export interface Conversation extends ThreadData {
  id: string;
  title: string;
  created: number;
  updated: number;
  /** The sub-agents this conversation owns, each with its own thread. */
  team: SubAgent[];
}

/**
 * What a mutation writes into: a conversation, or one of its sub-agents.
 * `conv` is always the file the change has to be persisted to.
 */
export interface ThreadTarget {
  conv: Conversation;
  data: ThreadData;
}

export function mainThread(conv: Conversation): ThreadTarget {
  return { conv, data: conv };
}

export interface ConvMeta {
  id: string;
  title: string;
  created: number;
  updated: number;
  count: number;
}

let list: ConvMeta[] = [];
/** Every conversation loaded in memory, keyed by id. */
const live = new Map<string, Conversation>();
/** The one the chat view is showing. */
let activeId: string | null = null;
/** One debounce timer per conversation: threads never flush each other. */
const saveTimers = new Map<string, number>();

function newId(): string {
  return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function current(): Conversation {
  if (activeId) {
    const c = live.get(activeId);
    if (c) return c;
  }
  const blankConv = blank();
  live.set(blankConv.id, blankConv);
  activeId = blankConv.id;
  return blankConv;
}

export function currentId(): string {
  return current().id;
}

/** A conversation already loaded in memory, if any. */
export function get(id: string): Conversation | undefined {
  return live.get(id);
}

/** Ids of every conversation currently held in memory. */
export function liveIds(): string[] {
  return [...live.keys()];
}

export function metas(): ConvMeta[] {
  return list;
}

function blank(): Conversation {
  const now = Date.now();
  return { id: newId(), title: "", created: now, updated: now, items: [], history: [], contextSummary: "", plan: [], team: [] };
}

/** Flush a pending debounced save of one conversation NOW. */
function flushPending(id: string): void {
  const timer = saveTimers.get(id);
  if (timer === undefined) return;
  clearTimeout(timer);
  saveTimers.delete(id);
  const conv = live.get(id);
  if (conv && conv.items.length > 0) api.convSave(conv.id, JSON.stringify(conv)).catch(() => {});
}

/** Flush every pending save (app-wide checkpoint). */
export function flushAll(): void {
  for (const id of [...saveTimers.keys()]) flushPending(id);
}

export function startNew(): Conversation {
  const conv = blank();
  live.set(conv.id, conv);
  activeId = conv.id;
  return conv;
}

export async function refreshList(): Promise<ConvMeta[]> {
  try {
    const raw = (await api.convList()) as any[];
    // Unattended runs are stored through the same per-file path (runsview.ts
    // persists a run exactly the way this module persists a thread), so they
    // come back in the same listing. They are not conversations and must not
    // appear in the sidebar as empty ones: the id namespace is what tells them
    // apart, and this is the only place the distinction has to be made.
    list = raw.filter((v) => !isRunId(String(v?.id ?? ""))).map((v) => ({
      id: String(v.id ?? ""),
      title: String(v.title ?? ""),
      created: Number(v.created ?? 0),
      updated: Number(v.updated ?? 0),
      count: Number(v.count ?? 0),
    }));
  } catch {
    list = [];
  }
  return list;
}

/**
 * Close whatever was in flight when the app went away. A tool card or a
 * teammate block stored with done:false comes back spinning forever: the run
 * that would have completed it died with the process. Reopening must say so
 * instead of pretending the work is still going.
 */
function settleInterrupted(items: ChatItem[]): ChatItem[] {
  for (const it of items) {
    if (it.kind === "tool" && !it.done) {
      it.done = true;
      if (it.result === "") it.result = INTERRUPTED;
    } else if (it.kind === "agent" && !it.done) {
      it.done = true;
      it.failed = true;
      if (it.answer === "") it.answer = INTERRUPTED;
    } else if (it.kind === "reasoning" && !it.done) {
      // A block stored mid-thought would reopen expanded and animated, as if
      // a model that died with the process were still thinking. It settles
      // instead, and keeps whatever it had got to.
      it.done = true;
    }
  }
  return items;
}

const INTERRUPTED = "(interrupted: the app was closed before this finished)";

function hydrate(id: string, v: any): Conversation {
  return {
    id: String(v.id ?? id),
    title: String(v.title ?? ""),
    created: Number(v.created ?? Date.now()),
    updated: Number(v.updated ?? Date.now()),
    items: settleInterrupted(Array.isArray(v.items) ? v.items : []),
    history: Array.isArray(v.history) ? v.history : [],
    contextSummary: typeof v.contextSummary === "string" ? v.contextSummary : "",
    plan: Array.isArray(v.plan) ? v.plan : [],
    // A conversation saved before teams existed has no team key: it reopens
    // with an empty one rather than undefined, so every consumer can iterate.
    team: Array.isArray(v.team) ? v.team.map(hydrateSub).filter((a: SubAgent | null) => a !== null) : [],
  };
}

function hydrateSub(v: any): SubAgent | null {
  const id = String(v?.id ?? "");
  const name = String(v?.name ?? "");
  if (!id || !name) return null;
  return {
    id,
    name,
    role: String(v.role ?? ""),
    brief: String(v.brief ?? ""),
    created: Number(v.created ?? Date.now()),
    updated: Number(v.updated ?? Date.now()),
    items: settleInterrupted(Array.isArray(v.items) ? v.items : []),
    history: Array.isArray(v.history) ? v.history : [],
    contextSummary: typeof v.contextSummary === "string" ? v.contextSummary : "",
    plan: Array.isArray(v.plan) ? v.plan : [],
  };
}

/**
 * Load a conversation into memory WITHOUT making it active. A conversation
 * already live is returned as it stands: re-reading the file would throw away
 * whatever its agent is streaming right now.
 */
export async function load(id: string): Promise<Conversation | null> {
  const known = live.get(id);
  if (known) return known;
  try {
    const conv = hydrate(id, (await api.convLoad(id)) as any);
    live.set(conv.id, conv);
    return conv;
  } catch {
    return null;
  }
}

export async function open(id: string): Promise<Conversation | null> {
  const conv = await load(id);
  if (!conv) return null;
  activeId = conv.id;
  return conv;
}

/** Make an already-live conversation the visible one. */
export function activate(id: string): Conversation | null {
  const conv = live.get(id);
  if (!conv) return null;
  activeId = conv.id;
  return conv;
}

/**
 * Drop an idle conversation from memory (its file stays). Callers must have
 * stopped its agent first; the pending save is flushed so nothing is lost.
 */
export function release(id: string): void {
  if (id === activeId) return;
  flushPending(id);
  live.delete(id);
}

export async function remove(id: string): Promise<void> {
  // A pending debounced save for this conversation would recreate the file
  // on disk right after the delete.
  const timer = saveTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    saveTimers.delete(id);
  }
  await api.convDelete(id).catch(() => {});
  live.delete(id);
  if (activeId === id) activeId = null;
  await refreshList();
}

/** Persist one conversation, debounced: streaming would write on every token. */
export function save(conv: Conversation, immediate = false): void {
  if (!conv || conv.items.length === 0) return;
  conv.updated = Date.now();
  if (!conv.title) {
    const first = conv.items.find((i) => i.kind === "user") as { text: string } | undefined;
    if (first) conv.title = first.text.replace(/\s+/g, " ").slice(0, 60);
  }
  const id = conv.id;
  if (immediate) {
    const timer = saveTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      saveTimers.delete(id);
    }
    api.convSave(id, JSON.stringify(conv)).catch(() => {});
    return;
  }
  if (saveTimers.has(id)) return;
  saveTimers.set(
    id,
    window.setTimeout(() => {
      saveTimers.delete(id);
      // Always re-read the live object: the conversation kept mutating while
      // the timer was armed, and a captured snapshot would write stale items.
      const fresh = live.get(id) ?? conv;
      if (fresh.items.length === 0) return;
      api.convSave(id, JSON.stringify(fresh)).catch(() => {});
    }, 1500)
  );
}

// ---- team ----

const MAX_TEAM = 6;

/** Slug the model can address: lowercase, dashes, unique inside the team. */
function teamHandle(conv: Conversation, wanted: string): string {
  const base =
    wanted
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "agent";
  let name = base;
  let n = 2;
  while (conv.team.some((a) => a.name === name)) name = `${base}-${n++}`;
  return name;
}

export function findSubAgent(conv: Conversation, nameOrId: string): SubAgent | undefined {
  const key = nameOrId.trim().toLowerCase();
  return conv.team.find((a) => a.id === nameOrId || a.name.toLowerCase() === key);
}

/**
 * Add a teammate to a conversation. Returns null when the team is full: the
 * cap is what keeps a model from spawning an unbounded crowd, and it is a
 * refusal the model can read, not a silent drop.
 */
export function addSubAgent(
  conv: Conversation,
  name: string,
  role: string,
  brief: string
): SubAgent | null {
  if (conv.team.length >= MAX_TEAM) return null;
  const now = Date.now();
  const sub: SubAgent = {
    id: "a" + now.toString(36) + Math.random().toString(36).slice(2, 6),
    name: teamHandle(conv, name),
    role: role.trim().slice(0, 200),
    brief: brief.trim().slice(0, 4000),
    created: now,
    updated: now,
    items: [],
    history: [],
    contextSummary: "",
    plan: [],
  };
  conv.team.push(sub);
  save(conv);
  return sub;
}

export function teamLimit(): number {
  return MAX_TEAM;
}

// ---- mutations used by the agent callbacks ----
//
// Each names the THREAD it writes into and the conversation that thread is
// stored in: the agent calling them is not necessarily the one the user is
// looking at, and it may be a sub-agent whose thread lives inside a parent
// conversation's file.

function touch(th: ThreadTarget): void {
  if (th.data !== th.conv) (th.data as SubAgent).updated = Date.now();
  save(th.conv);
}

export function pushUser(th: ThreadTarget, text: string, from?: string): void {
  settleReasoning(th);
  th.data.items.push(from ? { kind: "user", text, from } : { kind: "user", text });
  touch(th);
}

/**
 * Append streamed reasoning to the trailing block, opening one if needed.
 *
 * EVERY chunk is accumulated, including the ones that are not yet readable.
 * The first chunk of a stream can be half a delimiter ("<thi", with "nk>ok"
 * to follow), and a store that refused to open a block for it would then open
 * one on the second chunk and put "nk>ok" on screen as if the model had
 * written it. Whether there is anything worth SHOWING is a separate question,
 * asked by the view on every repaint and by `settleReasoning` at the end.
 */
export function appendReasoning(th: ThreadTarget, text: string): void {
  const last = th.data.items[th.data.items.length - 1];
  if (last && last.kind === "reasoning" && !last.done) {
    last.text = growThought(last.text, text);
    return;
  }
  th.data.items.push({ kind: "reasoning", text: growThought("", text), done: false });
}

/**
 * The thinking gives way: close the trailing block, or drop it if it held
 * nothing.
 *
 * Called by everything that can follow a thought (the answer, a tool call, a
 * teammate, a notice, an error, the end of the turn), so no stored block can
 * be left claiming to still be streaming while something else is on screen.
 *
 * Dropping rather than closing is what keeps a model that emitted only
 * whitespace, or only its own delimiters, out of the conversation file, out of
 * its markdown export and out of the Rust side's conversation search. A block
 * that carried nothing is not a block that is empty; it is a block that never
 * happened.
 */
export function settleReasoning(th: ThreadTarget): void {
  const last = th.data.items[th.data.items.length - 1];
  if (!last || last.kind !== "reasoning" || last.done) return;
  if (!hasReasoning(last.text)) {
    th.data.items.pop();
    return;
  }
  last.done = true;
}

/** Append streamed text to the trailing assistant item, creating it if needed. */
export function appendAssistant(th: ThreadTarget, text: string): void {
  settleReasoning(th);
  const last = th.data.items[th.data.items.length - 1];
  if (last && last.kind === "assistant") last.text += text;
  else th.data.items.push({ kind: "assistant", text });
}

/** Text of the trailing assistant item, empty when the tail is not one. */
export function lastAssistantText(td: ThreadData): string {
  for (let i = td.items.length - 1; i >= 0; i--) {
    const it = td.items[i];
    if (it.kind === "assistant") return it.text;
    if (it.kind === "user") break;
  }
  return "";
}

export function pushTool(th: ThreadTarget, name: string, arg: string, path?: string): void {
  settleReasoning(th);
  th.data.items.push({ kind: "tool", name, arg, result: "", done: false, path });
}

export function completeTool(th: ThreadTarget, result: string): void {
  for (let i = th.data.items.length - 1; i >= 0; i--) {
    const it = th.data.items[i];
    if (it.kind === "tool" && !it.done) {
      it.result = result;
      it.done = true;
      break;
    }
  }
  touch(th);
}

/**
 * Open a teammate block in the thread that delegates. It is filled in place
 * when the answer comes back, so the user watches one block instead of seeing
 * a question and an answer drift apart.
 */
export function pushAgentBlock(th: ThreadTarget, sub: SubAgent, ask: string): void {
  settleReasoning(th);
  th.data.items.push({
    kind: "agent",
    agentId: sub.id,
    name: sub.name,
    role: sub.role,
    ask,
    answer: "",
    done: false,
  });
  touch(th);
}

export function completeAgentBlock(th: ThreadTarget, agentId: string, answer: string, failed = false): void {
  for (let i = th.data.items.length - 1; i >= 0; i--) {
    const it = th.data.items[i];
    if (it.kind === "agent" && it.agentId === agentId && !it.done) {
      it.answer = answer;
      it.done = true;
      it.failed = failed;
      break;
    }
  }
  touch(th);
}

/** A discreet system line in the thread (task switched, model swapping…). */
export function pushNotice(th: ThreadTarget, text: string): void {
  settleReasoning(th);
  th.data.items.push({ kind: "notice", text });
  touch(th);
}

export function pushError(th: ThreadTarget, text: string): void {
  settleReasoning(th);
  th.data.items.push({ kind: "error", text });
  touch(th);
}

export function setPlan(th: ThreadTarget, plan: PlanStep[]): void {
  th.data.plan = plan;
}

export function syncHistory(th: ThreadTarget, history: ChatMessage[], contextSummary = ""): void {
  th.data.history = history;
  // Never overwrite a stored summary with an empty one: a fresh Agent that has
  // not digested anything yet would erase what an earlier session condensed.
  if (contextSummary) th.data.contextSummary = contextSummary;
}

/**
 * Close the turn's tail: drop what carries nothing, settle what is still open.
 *
 * A trailing assistant item that never received a token is dropped, as it
 * always was, and whatever reasoning was under it is then settled by the same
 * rule as everywhere else. A turn that thought and was stopped mid-thought
 * keeps its thought; a turn whose reasoning channel carried only whitespace
 * leaves nothing behind.
 */
export function trimEmptyTail(th: ThreadTarget): void {
  const last = th.data.items[th.data.items.length - 1];
  if (last && last.kind === "assistant" && last.text.trim() === "") th.data.items.pop();
  settleReasoning(th);
}
