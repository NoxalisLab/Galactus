// Bridge to the Rust side (Tauri commands) and to the local llama-server.
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export interface HwInfo {
  chip: string;
  cores: number;
  ram_gb: number;
  disk_free_gb: number;
}

export interface MeasuredPoint {
  cache_gb: number;
  gen_tps: number;
  prompt_tps?: number;
  mac_gb?: number;
}

export interface ModelEntry {
  id: string;
  name: string;
  arch: string;
  status: string;
  gguf_bytes?: number;
  expert_bytes_total?: number;
  non_expert_bytes?: number;
  min_ram_gb?: number;
  native_fit_ram_gb?: number | null;
  runs_nowhere_natively?: boolean;
  experts?: number;
  experts_used?: number;
  measured?: MeasuredPoint[];
  installed?: boolean;
  gguf_present?: boolean;
  pack_present?: boolean;
  pack_internal?: string;
  pack_external?: string;
}

export interface VolumeInfo {
  name: string;
  mount: string;
  /** Suggested pack directory on this volume. */
  dir: string;
  /** Path the bandwidth probe reads from. */
  probe: string;
  free_gb: number;
  total_gb: number;
}

export interface InstallVolumes {
  internal_dir: string;
  external_dir?: string;
}

export interface ServerStatus {
  running: boolean;
  model_id?: string;
  port: number;
  phase: string; // stopped | starting | ready
  mode?: string; // resident-metal | streamed-metal | cpu-bit-exact
}

export interface McpToolInfo {
  server: string;
  name: string;
  description: string;
  input_schema: unknown;
}

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  scope: string; // "global" | "workspace"
}

export const api = {
  hwInfo: () => invoke<HwInfo>("hw_info"),
  registry: () => invoke<ModelEntry[]>("load_registry"),
  detectRoot: () => invoke<string | null>("detect_root"),
  pickFolder: () => invoke<string | null>("pick_folder"),
  serverStatus: () => invoke<ServerStatus>("server_status"),
  serverStart: (modelId: string, cacheGb: number | null) =>
    invoke<void>("server_start", { modelId, cacheGb }),
  serverStop: () => invoke<void>("server_stop"),
  installModel: (modelId: string, volumes?: InstallVolumes | null) =>
    invoke<void>("install_model", { modelId, volumes: volumes ?? null }),
  cancelInstall: (modelId: string) => invoke<void>("cancel_install", { modelId }),
  deleteModel: (modelId: string) => invoke<string>("delete_model", { modelId }),
  listVolumes: () => invoke<VolumeInfo[]>("list_volumes"),
  volumeBandwidth: (path: string) => invoke<number>("volume_bandwidth", { path }),
  fsRead: (path: string, maxBytes: number, offset?: number) =>
    invoke<string>("tool_fs_read", { path, maxBytes, offset }),
  scratchWrite: (name: string, content: string) =>
    invoke<string>("scratch_write", { name, content }),
  webFetch: (url: string, maxBytes?: number) =>
    invoke<string>("tool_web_fetch", { url, maxBytes }),
  fsWrite: (path: string, content: string) =>
    invoke<string>("tool_fs_write", { path, content }),
  fsPreview: (path: string, content: string) =>
    invoke<{
      path: string;
      before: string;
      after: string;
      added: number;
      removed: number;
      existed: boolean;
    }>("tool_fs_preview", { path, content }),
  fsRevert: (path: string) => invoke<string>("tool_fs_revert", { path }),
  notify: (title: string, body: string) =>
    invoke<void>("notify", { title, body }),
  serverLog: () => invoke<string>("server_log"),
  serverMetrics: () => invoke<{ running: boolean; rss_bytes?: number }>("server_metrics"),
  fsList: (path: string) => invoke<string>("tool_fs_list", { path }),
  shellRun: (command: string, timeoutSecs: number) =>
    invoke<string>("tool_shell_run", { command, timeoutSecs }),
  settingsGet: () => invoke<Record<string, string>>("settings_get"),
  settingsSet: (key: string, value: string) =>
    invoke<void>("settings_set", { key, value }),
  mcpReload: () => invoke<McpToolInfo[]>("mcp_reload"),
  mcpTools: () => invoke<McpToolInfo[]>("mcp_tools"),
  mcpCall: (server: string, tool: string, args: unknown) =>
    invoke<string>("mcp_call", { server, tool, args: JSON.stringify(args) }),
  memoryRead: () => invoke<string>("memory_read"),
  memoryWrite: (text: string) => invoke<void>("memory_write", { text }),
  memoryAppend: (text: string) => invoke<string>("memory_append", { text }),
  obsidianSearch: (query: string) => invoke<string>("obsidian_search", { query }),
  obsidianRead: (note: string) => invoke<string>("obsidian_read", { note }),
  obsidianAppend: (note: string, text: string) =>
    invoke<string>("obsidian_append", { note, text }),
  obsidianWrite: (note: string, text: string) =>
    invoke<void>("obsidian_write", { note, text }),
  obsidianResolve: (note: string) => invoke<string>("obsidian_resolve", { note }),
  obsidianCreateVault: (path: string) =>
    invoke<string>("obsidian_create_vault", { path }),
  obsidianGraph: () =>
    invoke<{ nodes: { n: string; p: string; d: number }[]; edges: [number, number][] }>("obsidian_graph"),
  skillsList: () => invoke<SkillInfo[]>("skills_list"),
  skillRead: (name: string) => invoke<string>("skill_read", { name }),
  convList: () => invoke<unknown[]>("conv_list"),
  convLoad: (id: string) => invoke<unknown>("conv_load", { id }),
  convSave: (id: string, data: string) => invoke<void>("conv_save", { id, data }),
  convDelete: (id: string) => invoke<void>("conv_delete", { id }),
  docRead: (path: string, mode?: string) => invoke<string>("doc_read", { path, mode }),
  docCapabilities: () => invoke<{ swiftc: boolean; helper: boolean }>("doc_capabilities"),
  voiceStart: (locale?: string) => invoke<void>("voice_start", { locale }),
  voiceStop: () => invoke<void>("voice_stop"),
  ttsSpeak: (text: string) => invoke<void>("tts_speak", { text }),
  ttsStop: () => invoke<void>("tts_stop"),
  kbFolders: () => invoke<string[]>("kb_folders"),
  kbSetFolders: (folders: string[]) => invoke<void>("kb_set_folders", { folders }),
  kbReindex: () =>
    invoke<{ files: number; chunks: number; folders: string[]; indexed_at: number }>("kb_reindex"),
  kbStats: () =>
    invoke<{ files: number; chunks: number; folders: string[]; indexed_at: number } | null>("kb_stats"),
  kbSearch: (query: string, k?: number) =>
    invoke<{ path: string; snippet: string; score: number; line: number }[]>("kb_search", { query, k }),
};

export function onEvent(
  name: string,
  cb: (payload: any) => void
): Promise<UnlistenFn> {
  return listen(name, (e) => cb(e.payload));
}

// ---- llama-server OpenAI-compatible client ----

/** Real context window of the loaded model (llama-server /props). */
export async function fetchCtxSize(port: number): Promise<number> {
  const r = await fetch(`http://127.0.0.1:${port}/props`);
  if (!r.ok) throw new Error(`server ${r.status}`);
  const j: any = await r.json();
  const n = Number(j?.default_generation_settings?.n_ctx ?? j?.n_ctx);
  return Number.isFinite(n) && n > 0 ? n : 32768;
}

/**
 * Quick throughput measurement against the running server: one fixed-length
 * generation, tokens counted by the server itself (usage), wall-clock here.
 */
export async function benchOnce(port: number): Promise<{ tps: number; tokens: number; ms: number }> {
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "galactus-local",
      messages: [{ role: "user", content: "Write a vivid two-paragraph description of a nebula." }],
      temperature: 0.7,
      max_tokens: 160,
      stream: false,
    }),
  });
  if (!r.ok) throw new Error(`server ${r.status}`);
  const j: any = await r.json();
  const ms = Date.now() - t0;
  const tokens = Number(j?.usage?.completion_tokens ?? 0);
  if (!tokens) throw new Error("no usage in response");
  // llama-server reports its own generation speed (prompt eval and network
  // excluded) — far more honest than wall-clock; fall back to wall-clock.
  const serverTps = Number(j?.timings?.predicted_per_second);
  const tps = Number.isFinite(serverTps) && serverTps > 0 ? serverTps : tokens / (ms / 1000);
  return { tps, tokens, ms };
}

/** One non-streamed completion (no tools). Used for history summarization. */
export async function chatOnce(
  port: number,
  messages: { role: string; content: string }[],
  temperature = 0.2,
  abort?: AbortSignal
): Promise<string> {
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "galactus-local", messages, temperature, stream: false }),
    signal: abort,
  });
  if (!r.ok) throw new Error(`server ${r.status}`);
  const j: any = await r.json();
  return String(j.choices?.[0]?.message?.content ?? "");
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onToolCalls: (calls: ToolCall[]) => void;
  onDone: () => void;
  onError: (err: string) => void;
}

/**
 * Stream one chat completion. Returns true when the stream finished normally
 * (including a user abort, which is not an error) and false when the request
 * failed — in that case onError has already been called and the caller must
 * NOT treat the turn as completed.
 */
export async function streamChat(
  port: number,
  messages: ChatMessage[],
  tools: ToolDef[],
  handlers: StreamHandlers,
  abort: AbortSignal,
  temperature = 0.6
): Promise<boolean> {
  const body: any = {
    model: "galactus-local",
    messages,
    stream: true,
    temperature,
  };
  if (tools.length > 0) body.tools = tools;

  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abort,
    });
  } catch (e: any) {
    // A user stop while connecting surfaces as an AbortError — not an error.
    if (abort.aborted) {
      handlers.onDone();
      return true;
    }
    handlers.onError(String(e?.message ?? e));
    return false;
  }
  if (!response.ok || !response.body) {
    // llama-server explains the refusal in the body (context overflow,
    // template error…): surface it instead of a bare status code.
    let msg = `server ${response.status}`;
    try {
      const body = await response.text();
      const j = JSON.parse(body);
      const m = j?.error?.message ?? j?.message;
      if (m) msg += `: ${String(m).slice(0, 300)}`;
    } catch {}
    handlers.onError(msg);
    return false;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pending: Map<number, ToolCall> = new Map();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue;
        const data = s.slice(5).trim();
        if (data === "[DONE]") continue;
        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;
        if (typeof delta.content === "string" && delta.content.length > 0) {
          handlers.onDelta(delta.content);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (let i = 0; i < delta.tool_calls.length; i++) {
            const tc = delta.tool_calls[i];
            // Some backends send all calls in one delta without `index`: fall
            // back to the array position so two calls never merge into one.
            const idx = tc.index ?? i;
            const cur =
              pending.get(idx) ??
              ({ id: "", type: "function", function: { name: "", arguments: "" } } as ToolCall);
            if (tc.id) cur.id = tc.id;
            // The name arrives whole (never chunked): assign, don't append —
            // appending doubles it when a server repeats it per chunk.
            if (tc.function?.name) cur.function.name = tc.function.name;
            if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
            pending.set(idx, cur);
          }
        }
      }
    }
  } catch (e: any) {
    if (abort.aborted) {
      handlers.onDone();
      return true;
    }
    handlers.onError(String(e?.message ?? e));
    return false;
  }

  if (pending.size > 0) {
    const calls = [...pending.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    for (let i = 0; i < calls.length; i++) {
      if (!calls[i].id) calls[i].id = `call_${i}`;
    }
    handlers.onToolCalls(calls);
  }
  handlers.onDone();
  return true;
}
