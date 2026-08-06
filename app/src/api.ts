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
}

export interface ServerStatus {
  running: boolean;
  model_id?: string;
  port: number;
  phase: string; // stopped | starting | ready
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
  installModel: (modelId: string) => invoke<void>("install_model", { modelId }),
  cancelInstall: (modelId: string) => invoke<void>("cancel_install", { modelId }),
  fsRead: (path: string, maxBytes: number) =>
    invoke<string>("tool_fs_read", { path, maxBytes }),
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
  skillsList: () => invoke<SkillInfo[]>("skills_list"),
  skillRead: (name: string) => invoke<string>("skill_read", { name }),
  convList: () => invoke<unknown[]>("conv_list"),
  convLoad: (id: string) => invoke<unknown>("conv_load", { id }),
  convSave: (id: string, data: string) => invoke<void>("conv_save", { id, data }),
  convDelete: (id: string) => invoke<void>("conv_delete", { id }),
  docRead: (path: string, mode?: string) => invoke<string>("doc_read", { path, mode }),
  docCapabilities: () => invoke<{ swiftc: boolean; helper: boolean }>("doc_capabilities"),
};

export function onEvent(
  name: string,
  cb: (payload: any) => void
): Promise<UnlistenFn> {
  return listen(name, (e) => cb(e.payload));
}

// ---- llama-server OpenAI-compatible client ----

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
    handlers.onError(`server ${response.status}`);
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
