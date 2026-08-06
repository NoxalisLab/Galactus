// The agent loop: chat with the local model, execute tool calls behind the
// permission gate, feed results back, until the model answers in plain text.
import {
  api,
  ChatMessage,
  chatOnce,
  fetchCtxSize,
  StreamHandlers,
  streamChat,
  ToolCall,
  ToolDef,
  McpToolInfo,
  SkillInfo,
} from "./api";
import { getLang, t } from "./i18n";

export type PermissionKind =
  | "fs_read"
  | "fs_write"
  | "fs_list"
  | "shell"
  | "obsidian"
  | "memory"
  | "mcp";

export interface PermissionRequest {
  kind: PermissionKind;
  detail: string;
  elevated: boolean;
  /** Filled only for kind === "fs_write", via api.fsPreview, when a dialog will show. */
  diff?: {
    before: string;
    after: string;
    added: number;
    removed: number;
    existed: boolean;
  };
}

export type PermissionDecision = "once" | "always" | "deny";

export type AgentMode = "chat" | "agent";

export interface PlanStep {
  title: string;
  status: "todo" | "doing" | "done";
}

export interface AgentHooks {
  onAssistantDelta: (text: string) => void;
  onAssistantDone: () => void;
  onToolStart: (name: string, detail: string) => void;
  onToolResult: (name: string, result: string) => void;
  onPlan: (steps: PlanStep[]) => void;
  onError: (err: string) => void;
  askPermission: (req: PermissionRequest) => Promise<PermissionDecision>;
  onActivity?: (mode: import("./pixel").PixelMode, label?: string) => void;
  /** Discreet system line in the thread (sub-agent progress…). */
  onNotice?: (text: string) => void;
}

export type AgentRole = "main" | "sub";

const ELEVATED_PATTERNS = [
  /\bsudo\b/,
  /\bdiskutil\b/,
  /\bkillall\b/,
  /\blaunchctl\b/,
  /\bcsrutil\b/,
  /\/System\//,
  /\/Library\/(?!Caches)/,
  /\bchmod\s+[0-7]*7[0-7]*\s+\//,
  /\bmkfs\b/,
  /\bshred\b/,
  /\bdd\s+.*of=\/dev\//,
  /\bfind\b.*\s-delete\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b/,
  /\bgit\s+checkout\s+--\s/,
];

const SENSITIVE_WRITE_PREFIXES = ["/System", "/Library", "/usr", "/bin", "/sbin", "/etc", "/private"];

// Persistence / credential paths under $HOME are just as system-modifying as
// /System: writing them silently would allow login hooks or key injection.
const SENSITIVE_WRITE_PATTERNS = [
  /\/Library\/(LaunchAgents|LaunchDaemons)\//,
  /\/\.ssh\//,
  /\/\.(zshrc|zshenv|zprofile|bashrc|bash_profile|profile)$/,
  /\/\.gitconfig$/,
];

export function isElevatedCommand(cmd: string): boolean {
  if (ELEVATED_PATTERNS.some((re) => re.test(cmd))) return true;
  // Destructive rm in ANY flag layout: `rm -rf`, `rm -r -f`, `rm --recursive`,
  // `rm -f x` … Split on every separator that can chain commands — newlines
  // and subshell parens included — and scan EVERY `rm` token: an indexOf of
  // the first occurrence misses `echo ok && rm …`, `for …; do rm …; done`,
  // and `VAR=1 rm …`. Over-matching (a quoted "rm -rf" in an echo) only costs
  // an extra confirmation, under-matching costs the user's files.
  for (const seg of cmd.split(/[|;&\n()]+/)) {
    const toks = seg.trim().split(/\s+/);
    for (let i = 0; i < toks.length; i++) {
      if (toks[i] !== "rm") continue;
      const flags = toks.slice(i + 1).filter((tk) => tk.startsWith("-"));
      if (flags.some((tk) => /^-[a-zA-Z]*[rRf]/.test(tk) || tk === "--recursive" || tk === "--force")) {
        return true;
      }
    }
  }
  // A nested shell (`sh -c '…'`, `zsh -lc "…"`) makes the real command opaque
  // to this filter: treat it as elevated rather than guess.
  if (/(?:^|[\s|;&(])(?:sh|bash|zsh|dash|ksh)\b[^|;&\n]*\s-\w*c\b/.test(cmd)) return true;
  return false;
}

export function isElevatedWrite(path: string): boolean {
  return (
    SENSITIVE_WRITE_PREFIXES.some((p) => path.startsWith(p)) ||
    SENSITIVE_WRITE_PATTERNS.some((re) => re.test(path))
  );
}

interface StandingRule {
  kind: PermissionKind;
  prefix: string;
}

let standing: StandingRule[] = [];

export async function loadStandingPermissions(): Promise<StandingRule[]> {
  const s = await api.settingsGet();
  try {
    const parsed = JSON.parse(s["permissions"] ?? "[]");
    standing = Array.isArray(parsed) ? parsed : [];
  } catch {
    standing = [];
  }
  return standing;
}

export async function clearStandingPermissions(): Promise<void> {
  standing = [];
  await api.settingsSet("permissions", "[]");
}

export function listStandingPermissions(): StandingRule[] {
  return standing;
}

async function grantStanding(kind: PermissionKind, prefix: string) {
  standing.push({ kind, prefix });
  await api.settingsSet("permissions", JSON.stringify(standing));
}

function isStanding(kind: PermissionKind, detail: string): boolean {
  return standing.some((r) => {
    if (r.kind !== kind) return false;
    // An empty prefix would match EVERYTHING for this kind — never honour one
    // (legacy rules stored by older builds become inert).
    if (r.prefix === "") return false;
    // Shell, vault, memory and file-write rules are exact: a prefix match
    // would let "ls" grant "lsof", or "Always" on one file grant the folder.
    if (kind === "shell" || kind === "obsidian" || kind === "memory" || kind === "fs_write")
      return detail === r.prefix;
    return detail.startsWith(r.prefix);
  });
}

const WORKFLOW_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "run_workflow",
    description:
      "Split a broad subject into 2-6 focused sub-tasks and run a dedicated sub-agent on each one, in sequence. Every sub-agent starts with a CLEAN context (none of this conversation's accumulated output), works with the same tools, and returns a compact factual report with its sources. Use this for multi-source research, comparisons, or any task where raw intermediate output would pollute your context. You receive the reports and must synthesize them.",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          description: "The sub-tasks, each handled by one sub-agent",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Short label shown to the user" },
              goal: { type: "string", description: "Precise, self-contained instruction for the sub-agent (it knows NOTHING of this conversation)" },
            },
            required: ["title", "goal"],
          },
        },
      },
      required: ["tasks"],
    },
  },
};

function builtinTools(hasVault: boolean, role: AgentRole = "main"): ToolDef[] {
  const tools: ToolDef[] = [
    {
      type: "function",
      function: {
        name: "update_plan",
        description:
          "Publish or update your step-by-step plan so the user can follow along. Call it at the start of any multi-step task, then again each time a step changes state (todo → doing → done).",
        parameters: {
          type: "object",
          properties: {
            steps: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  status: { type: "string", enum: ["todo", "doing", "done"] },
                },
                required: ["title", "status"],
              },
            },
          },
          required: ["steps"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description:
          "Read a text file from the user's disk. For large files, read targeted sections with offset/max_bytes instead of loading everything.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute file path" },
            offset: { type: "number", description: "Byte offset to start reading from (default 0)" },
            max_bytes: { type: "number", description: "How many bytes to read (default 200000)" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write (create or overwrite) a text file on the user's disk.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_directory",
        description: "List the entries of a directory on the user's disk.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "run_command",
        description:
          "Run a shell command (zsh) on the user's machine. Output truncated to 200 KB.",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "remember",
        description:
          "Save a durable fact about the user or their preferences so future conversations recall it. Use sparingly, for lasting facts only.",
        parameters: {
          type: "object",
          properties: { fact: { type: "string", description: "The fact to remember, one sentence" } },
          required: ["fact"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_document",
        description:
          "Read the text of a document: PDF (including scanned ones, via OCR), image (png/jpg/heic/tiff — text is extracted with OCR), Word/PowerPoint/Excel, RTF, HTML, or any plain-text file. Use this instead of read_file for anything that is not source code or plain text.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute path to the document" },
            mode: {
              type: "string",
              enum: ["auto", "ocr", "text"],
              description: "auto (default) uses the text layer and falls back to OCR; ocr forces OCR; text reads the text layer only",
            },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "use_skill",
        description:
          "Load the full instructions of a named skill, then follow them for the current task.",
        parameters: {
          type: "object",
          properties: { name: { type: "string", description: "The skill's name" } },
          required: ["name"],
        },
      },
    },
  ];
  if (hasVault) {
    tools.push(
      {
        type: "function",
        function: {
          name: "obsidian_search",
          description: "Search the user's Obsidian vault for notes matching a query.",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "obsidian_read",
          description: "Read a note from the Obsidian vault (path relative to the vault).",
          parameters: {
            type: "object",
            properties: { note: { type: "string" } },
            required: ["note"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "obsidian_append",
          description: "Append text to a note in the Obsidian vault (creates it if missing).",
          parameters: {
            type: "object",
            properties: { note: { type: "string" }, text: { type: "string" } },
            required: ["note", "text"],
          },
        },
      }
    );
  }
  // Sub-agents never delegate further: one level of fan-out, no recursion.
  if (role === "main") tools.push(WORKFLOW_TOOL);
  return tools;
}

/** Short human label for sub-agent activity lines. */
function prettyToolLabel(name: string): string {
  if (name.startsWith("mcp__")) return name.split("__").slice(1).join(" ");
  return name.replace(/_/g, " ");
}

function activityModeFor(tool: string): import("./pixel").PixelMode {
  if (tool.startsWith("mcp__")) return "connector";
  if (tool === "run_workflow") return "connector";
  switch (tool) {
    case "read_document":
    case "read_file":
    case "list_directory":
    case "obsidian_read":
    case "obsidian_search":
    case "use_skill":
      return "reading";
    case "write_file":
    case "obsidian_append":
    case "remember":
      return "writing";
    case "run_command":
      return "running";
    default:
      return "thinking";
  }
}

function mcpToolDefs(mcp: McpToolInfo[]): ToolDef[] {
  return mcp.map((tool) => ({
    type: "function" as const,
    function: {
      name: `mcp__${tool.server}__${tool.name}`,
      description: `[${tool.server}] ${tool.description}`.slice(0, 1024),
      parameters: tool.input_schema ?? { type: "object", properties: {} },
    },
  }));
}

export class Agent {
  private messages: ChatMessage[] = [];
  private mcp: McpToolInfo[] = [];
  private memory = "";
  private hasVault = false;
  private skills: SkillInfo[] = [];
  private mode: AgentMode = "chat";
  private autoApprove = false;
  private abort: AbortController | null = null;
  private taskSystem: string | null = null;
  private taskTemp: number | null = null;

  constructor(
    private hooks: AgentHooks,
    private port: number,
    private role: AgentRole = "main"
  ) {
    this.reset();
  }

  reset() {
    this.messages = [{ role: "system", content: this.systemPrompt() }];
  }

  setMcpTools(tools: McpToolInfo[]) {
    this.mcp = tools;
  }

  setSkills(skills: SkillInfo[]) {
    this.skills = skills;
    if (this.messages[0]?.role === "system") this.messages[0].content = this.systemPrompt();
  }

  setMode(mode: AgentMode) {
    this.mode = mode;
    if (this.messages[0]?.role === "system") this.messages[0].content = this.systemPrompt();
  }

  setAutoApprove(on: boolean) {
    this.autoApprove = on;
  }

  getMode(): AgentMode {
    return this.mode;
  }

  /**
   * Apply a task persona: its system prompt replaces the identity paragraph
   * of the system message, its temperature is used for every request.
   */
  setTaskSystem(system: string, temp: number) {
    this.taskSystem = system.trim().length > 0 ? system.trim() : null;
    this.taskTemp = Number.isFinite(temp) ? Math.min(Math.max(temp, 0), 2) : null;
    if (this.messages[0]?.role === "system") this.messages[0].content = this.systemPrompt();
  }

  setMemory(text: string, hasVault: boolean) {
    this.memory = text;
    this.hasVault = hasVault;
    if (this.messages[0]?.role === "system") {
      this.messages[0].content = this.systemPrompt();
    }
  }

  private systemPrompt(): string {
    const lang = getLang() === "fr" ? "French" : "English";
    const identity =
      this.taskSystem ??
      "You are Galactus, a local AI assistant by Noxalis Lab, running fully on the user's Mac.";
    let p =
      identity + " " +
      "You can read and write files, list folders and run shell commands through tools; every action " +
      "is gated by the user's explicit permission, so ask for what you need and use tools freely when helpful. " +
      "You can remember lasting facts with the remember tool. " +
      "Be concise and warm. Answer in " + lang + " unless the user writes in another language.";
    if (this.hasVault) {
      p += " The user has an Obsidian vault you can search, read and append to with the obsidian_* tools.";
    }
    if (this.mode === "agent") {
      p +=
        "\n\nYou are in AGENT MODE. Work autonomously toward the user's goal without stopping to ask for " +
        "confirmation on ordinary steps. First call update_plan with a short checklist of the steps you will take. " +
        "Then carry them out one by one with your tools, calling update_plan again to mark each step 'doing' then 'done'. " +
        "Do the work yourself instead of telling the user how to do it. When everything is complete, give a short final summary. " +
        "Only stop early if you are truly blocked or a step would be destructive and needs a human decision.";
      if (this.role === "main") {
        p +=
          " For broad or multi-source subjects (research across several sites, comparisons, large analyses), " +
          "call run_workflow to fan the work out to focused sub-agents with clean contexts, then synthesize their reports yourself.";
      }
    }
    if (this.skills.length > 0) {
      p +=
        "\n\nSkills are packaged instructions for specific tasks. When the user's request matches one, " +
        "call use_skill with its name to load its full instructions, then follow them. Available skills:\n" +
        this.skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    }
    if (this.memory.trim().length > 0) {
      p += "\n\nWhat you remember about the user:\n" + this.memory.trim();
    }
    if (this.contextSummary.trim().length > 0) {
      p +=
        "\n\nFaithful summary of the EARLIER part of this conversation (auto-condensed to keep the context clean; treat as established facts, do not re-derive or embellish them):\n" +
        this.contextSummary.trim();
    }
    return p;
  }

  stop() {
    this.abort?.abort();
    this.activeSub?.stop();
  }

  history(): ChatMessage[] {
    return this.messages;
  }

  /** Restore a saved thread: system prompt is rebuilt, the rest replayed. */
  loadHistory(messages: ChatMessage[]): void {
    const body = messages.filter((m) => m.role !== "system");
    this.messages = [{ role: "system", content: this.systemPrompt() }, ...body];
  }

  async send(userText: string): Promise<void> {
    this.messages.push({ role: "user", content: userText });
    await this.turn(0);
  }

  // ---------------- adaptive context management ----------------
  //
  // Anti-hallucination hygiene: the model's window never fills with stale
  // raw dumps. Oversized tool outputs spill to scratch files (the model
  // re-reads precise sections on demand), and when the window approaches
  // capacity the OLDEST turns are summarized BY THE MODEL under a strict
  // "facts, numbers, paths, sources, nothing invented" instruction, then
  // folded into the system prompt. Blind truncation is the last resort only.

  private nCtx: number | null = null;
  private contextSummary = "";

  private async ensureCtxSize(): Promise<number> {
    if (this.nCtx) return this.nCtx;
    try {
      this.nCtx = await fetchCtxSize(this.port);
    } catch {
      this.nCtx = 32768;
    }
    return this.nCtx;
  }

  /** Rough token estimate of the request body (~4 chars per token). */
  private estimateTokens(): number {
    let chars = 0;
    for (const m of this.messages) {
      chars += (typeof m.content === "string" ? m.content.length : 0) + 20;
      if (m.tool_calls) for (const tc of m.tool_calls) chars += tc.function.name.length + tc.function.arguments.length + 30;
    }
    return Math.ceil(chars / 4) + 2500; // + tool schemas overhead
  }

  /**
   * Fold the oldest ~60% of the thread into a model-written faithful summary.
   * Falls back to hard trimming only if the summarization call itself fails.
   */
  private async digestHistory(): Promise<boolean> {
    const msgs = this.messages;
    if (msgs.length < 6) return this.compactHistory();
    let cut = 1 + Math.floor((msgs.length - 1) * 0.6);
    // Never split an assistant tool_calls / tool-results pair.
    while (cut < msgs.length - 1 && msgs[cut].role === "tool") cut++;
    if (cut >= msgs.length - 1) cut = msgs.length - 2;
    if (cut <= 1) return this.compactHistory();

    const chunk = msgs.slice(1, cut);
    const rendered = chunk
      .map((m) => {
        let c = typeof m.content === "string" ? m.content : "";
        if (c.length > 3000) c = c.slice(0, 3000) + "…";
        const calls = m.tool_calls
          ?.map((tc) => `${tc.function.name}(${tc.function.arguments.slice(0, 200)})`)
          .join(", ");
        return `[${m.role}]${calls ? ` tool calls: ${calls}` : ""} ${c}`;
      })
      .join("\n");

    try {
      const summary = await chatOnce(
        this.port,
        [
          {
            role: "system",
            content:
              "You compress conversation history. Keep EVERY fact, number, URL, file path, decision and source attribution exactly as stated. Never invent, embellish or reinterpret anything. If something is uncertain in the original, keep it marked uncertain. Output a tight bullet list.",
          },
          { role: "user", content: "Summarize this conversation segment faithfully:\n\n" + rendered.slice(0, 60_000) },
        ],
        0.1,
        this.abort?.signal
      );
      if (!summary.trim()) return this.compactHistory();
      this.contextSummary = (this.contextSummary ? this.contextSummary + "\n" : "") + summary.trim();
      if (this.contextSummary.length > 8000) this.contextSummary = this.contextSummary.slice(-8000);
      this.messages = [msgs[0], ...msgs.slice(cut)];
      if (this.messages[0].role === "system") this.messages[0].content = this.systemPrompt();
      return true;
    } catch {
      return this.compactHistory();
    }
  }

  /** Emergency fallback: trim old tool outputs in place, no model call. */
  private compactHistory(): boolean {
    const toolIdx = this.messages
      .map((m, i) => (m.role === "tool" ? i : -1))
      .filter((i) => i >= 0);
    let changed = false;
    toolIdx.forEach((i, rank) => {
      const m = this.messages[i];
      const keep = rank >= toolIdx.length - 2 ? 6000 : 800;
      if (typeof m.content === "string" && m.content.length > keep) {
        m.content = m.content.slice(0, keep) + "\n…(older tool output trimmed to fit the context)";
        changed = true;
      }
    });
    return changed;
  }

  private async turn(depth: number, retriedAfterCompact = false): Promise<void> {
    const maxDepth = this.mode === "agent" ? 30 : 12;
    if (depth > maxDepth) {
      this.hooks.onError("tool loop limit reached");
      return;
    }
    this.abort = new AbortController();
    this.hooks.onActivity?.("thinking");

    // Proactive: digest BEFORE the window overflows, not after the server
    // rejects us. 75% leaves room for the answer being generated.
    const nCtx = await this.ensureCtxSize();
    if (this.estimateTokens() > nCtx * 0.75) {
      await this.digestHistory();
    }

    let assistantText = "";
    let toolCalls: ToolCall[] = [];
    let streamErr: string | null = null;

    const handlers: StreamHandlers = {
      onDelta: (text) => {
        assistantText += text;
        this.hooks.onAssistantDelta(text);
      },
      onToolCalls: (calls) => {
        toolCalls = calls;
      },
      onDone: () => {},
      onError: (err) => {
        streamErr = err;
      },
    };

    const tools = [...builtinTools(this.hasVault, this.role), ...mcpToolDefs(this.mcp)];
    const ok = await streamChat(
      this.port,
      this.messages,
      tools,
      handlers,
      this.abort.signal,
      this.taskTemp ?? 0.6
    );
    if (!ok && !this.abort.signal.aborted) {
      // Context overflow (huge tool outputs, long thread): summarize the
      // history once and retry instead of killing the conversation.
      const looksLikeCtx = streamErr !== null && /context|exceed|too (long|large|many)|kv[ _-]?cache|n_ctx|token/i.test(streamErr);
      if (looksLikeCtx && !retriedAfterCompact && assistantText.length === 0) {
        if (await this.digestHistory()) {
          return this.turn(depth, true);
        }
      }
      // Request failed for real: surface it. Do NOT push an empty assistant
      // message nor call finishTurn — that would end the turn twice.
      this.hooks.onError(streamErr ?? "request failed");
      this.hooks.onActivity?.("done");
      return;
    }

    if (this.abort.signal.aborted) {
      // User stopped: keep the partial text as a normal turn, drop tool calls
      // so history stays well-formed (no dangling tool_calls without results).
      if (assistantText.length > 0) {
        this.messages.push({ role: "assistant", content: assistantText });
      }
      this.finishTurn(assistantText);
      return;
    }

    // content is never null: some jinja tool templates iterate message.content
    // and fail on null. Empty string renders as an empty turn, which is valid.
    const assistantMessage: ChatMessage = { role: "assistant", content: assistantText };
    if (toolCalls.length > 0) {
      // Guarantee unique, non-empty ids so each tool result maps back cleanly.
      const seen = new Set<string>();
      toolCalls.forEach((c, i) => {
        if (!c.id || seen.has(c.id)) c.id = `call_${depth}_${i}`;
        seen.add(c.id);
      });
      assistantMessage.tool_calls = toolCalls;
    }
    this.messages.push(assistantMessage);

    if (toolCalls.length === 0) {
      this.finishTurn(assistantText);
      return;
    }

    // Execute every tool call and push exactly one tool message per call, in
    // order — the API requires a 1:1 match with the assistant's tool_calls.
    for (let ci = 0; ci < toolCalls.length; ci++) {
      const call = toolCalls[ci];
      let result: string;
      try {
        result = await this.executeCall(call);
      } catch (e: any) {
        result = `error: ${String(e?.message ?? e)}`;
      }
      // A raw web-page dump can weigh 200 KB (≈ 50k tokens): pushed whole, a
      // handful of those blows the context window and every later request
      // gets rejected. Oversized outputs spill WHOLE to a scratch file and
      // the history keeps the head plus the path: the model re-reads precise
      // sections with read_file(offset) instead of working from a blind cut.
      // Workflow reports are ALREADY distilled: give them more room before
      // spilling, or the whole point of the fan-out is lost.
      const HIST_TOOL_MAX = call.function.name === "run_workflow" ? 40_000 : 20_000;
      let hist = result && result.length > 0 ? result : "(no output)";
      if (hist.length > HIST_TOOL_MAX) {
        let note: string;
        try {
          const fname = `tool-${Date.now().toString(36)}-${call.function.name.replace(/[^\w-]/g, "_").slice(0, 40)}.txt`;
          const path = await api.scratchWrite(fname, result);
          note = `\n[output truncated here — the FULL output (${result.length} chars) is saved at: ${path}\nRead precise sections with read_file (offset=<byte>, max_bytes=…) instead of assuming the rest.]`;
        } catch {
          note = `\n…(truncated, ${result.length} chars total)`;
        }
        hist = hist.slice(0, 8_000) + note;
      }
      this.messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: hist,
      });
      if (this.abort.signal.aborted) {
        // Even on Stop the history must stay 1:1 with tool_calls: fill the
        // remaining slots or the next request replays a malformed body.
        for (const rest of toolCalls.slice(ci + 1)) {
          this.messages.push({ role: "tool", tool_call_id: rest.id, content: "(aborted by user)" });
        }
        break;
      }
    }
    if (this.abort.signal.aborted) {
      this.finishTurn(assistantText);
      return;
    }
    await this.turn(depth + 1);
  }

  /** End of a task: notify if the window is unfocused, then signal "done". */
  private finishTurn(assistantText: string) {
    if (this.role === "main" && !document.hasFocus()) {
      const firstLine = assistantText
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      api.notify("Galactus", firstLine ?? t("agent.doneNotify")).catch(() => {});
    }
    this.hooks.onActivity?.("done");
    this.hooks.onAssistantDone();
  }

  // ---------------- multi-agent workflow ----------------

  private autoApproveValue(): boolean {
    return this.autoApprove;
  }

  private activeSub: Agent | null = null;

  /**
   * Run each sub-task on a dedicated sub-agent with a CLEAN context. They run
   * in sequence (the local server serves one slot), each spills its full
   * transcript to a scratch file, and the main context only receives the
   * compact sourced reports.
   */
  private async runWorkflow(tasksArg: unknown): Promise<string> {
    const tasks: { title: string; goal: string }[] = Array.isArray(tasksArg)
      ? tasksArg
          .map((tk: any) => ({
            title: String(tk?.title ?? "").slice(0, 80) || "task",
            goal: String(tk?.goal ?? ""),
          }))
          .filter((tk) => tk.goal.trim().length > 0)
          .slice(0, 6)
      : [];
    if (tasks.length === 0) return "error: run_workflow needs tasks: [{title, goal}, …]";

    const reports: string[] = [];
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      if (this.abort?.signal.aborted) {
        reports.push(`### ${i + 1}. ${task.title}\n(aborted by user)`);
        continue;
      }
      this.hooks.onNotice?.(
        t("wf.run").replace("%i", String(i + 1)).replace("%n", String(tasks.length)).replace("%t", task.title)
      );
      this.hooks.onActivity?.("connector", `${i + 1}/${tasks.length} · ${task.title}`);

      const transcript: string[] = [];
      const parent = this;
      const report = await new Promise<string>((resolve) => {
        let text = "";
        const sub = new Agent(
          {
            onAssistantDelta: (tx) => { text += tx; },
            onAssistantDone: () => resolve(text),
            onToolStart: (name, detail) => {
              transcript.push(`→ ${name} ${detail}`);
              parent.hooks.onActivity?.(activityModeFor(name), `${i + 1}/${tasks.length} · ${prettyToolLabel(name)}`);
            },
            onToolResult: (_n, r) => { transcript.push(r.slice(0, 2000)); },
            onPlan: () => {},
            onError: (err) => resolve(text ? text + `\n[stopped: ${err}]` : `error: ${err}`),
            askPermission: (req) => parent.hooks.askPermission(req),
          },
          this.port,
          "sub"
        );
        this.activeSub = sub;
        sub.setAutoApprove(this.autoApproveValue());
        sub.setMcpTools(this.mcp);
        sub.setMode("agent");
        sub.setTaskSystem(
          "You are a focused Galactus sub-agent handling exactly ONE task. Work factually with your tools. " +
            "Cite a source (URL, file path or command) for every claim that comes from a tool. " +
            "Finish with a compact report: findings first, then a 'Sources:' list. " +
            "If something could not be verified, say so explicitly instead of guessing.",
          0.4
        );
        sub.send(task.goal).catch((e: any) => resolve(`error: ${String(e?.message ?? e)}`));
      });
      this.activeSub = null;

      // Full transcript spills to scratch; the main context stays clean.
      let pathNote = "";
      try {
        const p = await api.scratchWrite(
          `subagent-${Date.now().toString(36)}-${i + 1}.txt`,
          `# ${task.title}\n\n## Goal\n${task.goal}\n\n## Tool trace\n${transcript.join("\n")}\n\n## Report\n${report}`
        );
        pathNote = `\n(full transcript: ${p})`;
      } catch {}
      reports.push(`### ${i + 1}. ${task.title}\n${report.slice(0, 6000)}${pathNote}`);
      this.hooks.onNotice?.(
        t("wf.done").replace("%i", String(i + 1)).replace("%n", String(tasks.length)).replace("%t", task.title)
      );
    }
    return reports.join("\n\n");
  }

  private async gate(req: PermissionRequest): Promise<boolean> {
    if (this.abort?.signal.aborted) return false;
    if (!req.elevated && isStanding(req.kind, req.detail)) return true;
    // Agent mode autonomy: auto-approve ordinary actions for the run.
    // Elevated (system-modifying) actions ALWAYS ask, even in agent mode.
    if (!req.elevated && this.autoApprove) return true;
    const decision = await this.hooks.askPermission(req);
    // The user may have hit Stop while the dialog was open: an approval that
    // lands after the abort must NOT execute the pending tool.
    if (this.abort?.signal.aborted) return false;
    if (decision === "deny") return false;
    if (decision === "always" && !req.elevated) {
      let prefix = req.detail;
      if (req.kind === "fs_read" || req.kind === "fs_list") {
        const i = req.detail.lastIndexOf("/");
        prefix = i > 0 ? req.detail.slice(0, i + 1) : req.detail;
      } else if (req.kind === "mcp") {
        // Keep the trailing slash: "github" must not also grant "githubfoo".
        prefix = (req.detail.split("/")[0] ?? req.detail) + "/";
      }
      // shell / obsidian / memory / fs_write: the FULL detail is stored and
      // matched exactly — a broader rule (first token, whole folder) is an
      // escalation the user never saw.
      await grantStanding(req.kind, prefix);
    }
    return true;
  }

  private async executeCall(call: ToolCall): Promise<string> {
    let args: any = {};
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      return "error: invalid tool arguments";
    }
    const name = call.function.name;

    // The plan is surfaced in its own panel, not as a tool card.
    if (name === "update_plan") {
      const steps: PlanStep[] = Array.isArray(args.steps) ? args.steps : [];
      this.hooks.onPlan(steps);
      return "plan updated";
    }

    this.hooks.onToolStart(name, JSON.stringify(args).slice(0, 300));
    this.hooks.onActivity?.(activityModeFor(name), name);

    try {
      let result: string;
      if (name === "read_file") {
        const p = String(args.path ?? "");
        const ok = await this.gate({ kind: "fs_read", detail: p, elevated: false });
        const off = Number(args.offset) > 0 ? Math.floor(Number(args.offset)) : undefined;
        const cap = Math.min(Math.max(Math.floor(Number(args.max_bytes)) || 200_000, 1_000), 200_000);
        result = ok ? await api.fsRead(p, cap, off) : "denied by user";
      } else if (name === "write_file") {
        const p = String(args.path ?? "");
        const content = String(args.content ?? "");
        const elevated = isElevatedWrite(p);
        const req: PermissionRequest = { kind: "fs_write", detail: p, elevated };
        // Preview only when a dialog will actually show; skip it when the
        // gate would pass silently (standing rule or agent auto-approval).
        const silent = !elevated && (isStanding("fs_write", p) || this.autoApprove);
        if (!silent) {
          try {
            const d = await api.fsPreview(p, content);
            req.diff = {
              before: d.before,
              after: d.after,
              added: d.added,
              removed: d.removed,
              existed: d.existed,
            };
          } catch {
            // Preview failure must not block the permission flow.
          }
        }
        const ok = await this.gate(req);
        result = ok ? await api.fsWrite(p, content) : "denied by user";
      } else if (name === "list_directory") {
        const p = String(args.path ?? "");
        const ok = await this.gate({ kind: "fs_list", detail: p, elevated: false });
        result = ok ? await api.fsList(p) : "denied by user";
      } else if (name === "run_command") {
        const cmd = String(args.command ?? "");
        const ok = await this.gate({ kind: "shell", detail: cmd, elevated: isElevatedCommand(cmd) });
        result = ok ? await api.shellRun(cmd, 120) : "denied by user";
      } else if (name === "remember") {
        // Memory is injected into every future conversation: an ungated write
        // here would let any read document poison it silently.
        const fact = String(args.fact ?? "");
        const ok = await this.gate({ kind: "memory", detail: fact.slice(0, 300), elevated: false });
        result = ok ? await api.memoryAppend(fact) : "denied by user";
        if (ok) {
          this.memory = await api.memoryRead();
          if (this.messages[0]?.role === "system") this.messages[0].content = this.systemPrompt();
        }
      } else if (name === "read_document") {
        const p = String(args.path ?? "");
        const ok = await this.gate({ kind: "fs_read", detail: p, elevated: false });
        result = ok ? await api.docRead(p, args.mode ? String(args.mode) : undefined) : "denied by user";
      } else if (name === "run_workflow" && this.role === "main") {
        result = await this.runWorkflow(args.tasks);
      } else if (name === "use_skill") {
        result = await api.skillRead(String(args.name ?? ""));
      } else if (name === "obsidian_search") {
        const ok = await this.gate({ kind: "obsidian", detail: `search: ${args.query}`, elevated: false });
        result = ok ? await api.obsidianSearch(String(args.query ?? "")) : "denied by user";
      } else if (name === "obsidian_read") {
        const ok = await this.gate({ kind: "obsidian", detail: `read: ${args.note}`, elevated: false });
        result = ok ? await api.obsidianRead(String(args.note ?? "")) : "denied by user";
      } else if (name === "obsidian_append") {
        const ok = await this.gate({ kind: "obsidian", detail: `append: ${args.note}`, elevated: false });
        result = ok ? await api.obsidianAppend(String(args.note ?? ""), String(args.text ?? "")) : "denied by user";
      } else if (name.startsWith("mcp__")) {
        const parts = name.split("__");
        const server = parts[1] ?? "";
        const tool = parts.slice(2).join("__");
        const ok = await this.gate({ kind: "mcp", detail: `${server}/${tool}`, elevated: false });
        result = ok ? await api.mcpCall(server, tool, args) : "denied by user";
      } else {
        result = `error: unknown tool ${name}`;
      }
      const shown = result.length > 4000 ? result.slice(0, 4000) + "\n…(truncated)" : result;
      this.hooks.onToolResult(name, shown);
      return result;
    } catch (e: any) {
      const msg = `error: ${String(e?.message ?? e)}`;
      this.hooks.onToolResult(name, msg);
      return msg;
    }
  }
}
