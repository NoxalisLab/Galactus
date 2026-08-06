// Galactus — conversation store.
//
// The chat used to be drawn straight into DOM nodes captured by the agent's
// callbacks. Any re-render (server event, mode switch, navigation) detached
// those nodes and every later token went into a dead subtree — the thread
// simply stopped updating. Everything now lives in this store; the view is a
// pure function of it, and callbacks mutate state then ask for a repaint.

import { api, ChatMessage } from "./api";
import type { PlanStep } from "./agent";

export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; arg: string; result: string; done: boolean; path?: string }
  | { kind: "error"; text: string }
  | { kind: "notice"; text: string };

export interface Conversation {
  id: string;
  title: string;
  created: number;
  updated: number;
  items: ChatItem[];
  history: ChatMessage[];
  plan: PlanStep[];
}

export interface ConvMeta {
  id: string;
  title: string;
  created: number;
  updated: number;
  count: number;
}

let list: ConvMeta[] = [];
let active: Conversation | null = null;
let saveTimer: number | null = null;

function newId(): string {
  return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function current(): Conversation {
  if (!active) active = blank();
  return active;
}

export function metas(): ConvMeta[] {
  return list;
}

function blank(): Conversation {
  const now = Date.now();
  return { id: newId(), title: "", created: now, updated: now, items: [], history: [], plan: [] };
}

/** Flush any pending debounced save of the current conversation NOW. */
function flushPending(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
    const conv = active;
    if (conv && conv.items.length > 0) api.convSave(conv.id, JSON.stringify(conv)).catch(() => {});
  }
}

export function startNew(): Conversation {
  flushPending(); // leaving a thread must not lose its last debounced write
  active = blank();
  return active;
}

export async function refreshList(): Promise<ConvMeta[]> {
  try {
    const raw = (await api.convList()) as any[];
    list = raw.map((v) => ({
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

export async function open(id: string): Promise<Conversation | null> {
  flushPending();
  try {
    const v = (await api.convLoad(id)) as any;
    active = {
      id: String(v.id ?? id),
      title: String(v.title ?? ""),
      created: Number(v.created ?? Date.now()),
      updated: Number(v.updated ?? Date.now()),
      items: Array.isArray(v.items) ? v.items : [],
      history: Array.isArray(v.history) ? v.history : [],
      plan: Array.isArray(v.plan) ? v.plan : [],
    };
    return active;
  } catch {
    return null;
  }
}

export async function remove(id: string): Promise<void> {
  // A pending debounced save for this conversation would recreate the file
  // on disk right after the delete.
  if (saveTimer !== null && active?.id === id) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await api.convDelete(id).catch(() => {});
  if (active?.id === id) active = blank();
  await refreshList();
}

/** Persist, debounced — streaming would otherwise write on every token. */
export function save(immediate = false): void {
  const conv = active;
  if (!conv || conv.items.length === 0) return;
  conv.updated = Date.now();
  if (!conv.title) {
    const first = conv.items.find((i) => i.kind === "user") as { text: string } | undefined;
    if (first) conv.title = first.text.replace(/\s+/g, " ").slice(0, 60);
  }
  // The timer always flushes the conversation that is ACTIVE when it fires,
  // not the one captured when it was armed: switching threads inside the
  // debounce window must not drop the new thread's mutations (they save on
  // the next tick of the same shared timer).
  const flush = () => {
    saveTimer = null;
    const live = active;
    if (!live || live.items.length === 0) return;
    api.convSave(live.id, JSON.stringify(live)).catch(() => {});
  };
  if (immediate) {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    api.convSave(conv.id, JSON.stringify(conv)).catch(() => {});
    return;
  }
  if (saveTimer !== null) return;
  saveTimer = window.setTimeout(flush, 1500);
}

// ---- mutations used by the agent callbacks ----

export function pushUser(text: string): void {
  current().items.push({ kind: "user", text });
  save();
}

export function pushAssistant(text: string): void {
  current().items.push({ kind: "assistant", text });
}

/** Append streamed text to the trailing assistant item, creating it if needed. */
export function appendAssistant(text: string): void {
  const c = current();
  const last = c.items[c.items.length - 1];
  if (last && last.kind === "assistant") last.text += text;
  else c.items.push({ kind: "assistant", text });
}

export function pushTool(name: string, arg: string, path?: string): void {
  current().items.push({ kind: "tool", name, arg, result: "", done: false, path });
}

export function completeTool(result: string): void {
  const c = current();
  for (let i = c.items.length - 1; i >= 0; i--) {
    const it = c.items[i];
    if (it.kind === "tool" && !it.done) {
      it.result = result;
      it.done = true;
      break;
    }
  }
  save();
}

/** A discreet system line in the thread (task switched, model swapping…). */
export function pushNotice(text: string): void {
  current().items.push({ kind: "notice", text });
  save();
}

export function pushError(text: string): void {
  current().items.push({ kind: "error", text });
  save();
}

export function setPlan(plan: PlanStep[]): void {
  current().plan = plan;
}

export function syncHistory(history: ChatMessage[]): void {
  current().history = history;
}

/** Drop a trailing assistant item that never received any text. */
export function trimEmptyTail(): void {
  const c = current();
  const last = c.items[c.items.length - 1];
  if (last && last.kind === "assistant" && last.text.trim() === "") c.items.pop();
}
