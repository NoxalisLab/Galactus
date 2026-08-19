// Bridge to the Rust side (Tauri commands) and to the local llama-server.
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
// Type only, so this adds no runtime edge from api.ts into the Code view. It
// stops the wire shape from drifting away from the module that consumes it.
import type { RustLspStatus } from "./code/rust-lsp";

/** One tier of CPU cores, named as macOS names it. */
export interface CoreLevel {
  /** Verbatim hw.perflevelN.name. Never a name the app chose: this machine
   *  reports "Super" and "Performance", and no level called "Efficiency". */
  name: string;
  count: number;
}

export interface HwInfo {
  chip: string;
  cores: number;
  ram_gb: number;
  disk_free_gb: number;
  /** GPU cores. Null on Intel or in a virtual machine. */
  gpu_cores: number | null;
  /** CPU tiers, fastest first. */
  core_levels: CoreLevel[];
  /** What Metal will let the GPU keep resident, bytes. Null when unknown. */
  gpu_working_set_bytes: number | null;
  /** Apple's published memory bandwidth for this chip, GB/s. Null when Apple
   *  published none, or the chip is newer than this build. Shown, not used. */
  bandwidth_gbs: number | null;
  /** What the engine may hold in total right now, bytes. */
  engine_budget_bytes: number;
  power_source: "ac" | "battery" | "unknown";
  power_mode: "automatic" | "low" | "high" | "unknown";
}

/** Where a model's pack should be written. */
export type PackLayout =
  | { kind: "single"; mount: string }
  | { kind: "dual"; internal: string; external: string }
  | { kind: "no-room" };

/** Everything the app chose for one model on this Mac. */
export interface Recommendation {
  model_id: string;
  mode: string;
  requested_mode: string;
  slots: number;
  slots_chosen_by_user: boolean;
  variant: string | null;
  layout: PackLayout | null;
  resident_bytes: number;
  budget_bytes: number;
  ubatch: number;
  /** The planner's own sentence, with its numbers, when nothing fits. */
  blocked: string | null;
}

/** A measured drive, as `recommendForModel` wants them. */
export interface MeasuredVolume {
  mount: string;
  free_bytes: number;
  /** GB/s from volumeBandwidth. Omitted when this drive was not probed, and
   *  an unprobed drive is never made half of a split pack. */
  bandwidth_gbs?: number;
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
  /** No routed experts: nothing to pack, nothing to stream, nothing to cache. */
  dense?: boolean;
  measured?: MeasuredPoint[];
  installed?: boolean;
  gguf_present?: boolean;
  pack_present?: boolean;
  pack_internal?: string;
  pack_external?: string;
  download?: {
    base?: string;
    files?: string[];
  };
}

/** One machine saved for a remote terminal. */
export interface SshHost {
  id: string;
  label: string;
  /** user@host, or an alias from the user's own ~/.ssh/config. */
  target: string;
  port?: number | null;
}

/** One open port from a defensive scan. Closed ports are not returned. */
export interface PortResult {
  port: number;
  open: boolean;
  service: string | null;
  banner: string | null;
}

/** One observation from a web audit, with how much it matters. */
export interface SecFinding {
  /** "ok" | "warn" | "risk"; the view colours on it. */
  level: string;
  title: string;
  detail: string;
}

export interface WebAudit {
  url: string;
  status: number | null;
  findings: SecFinding[];
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

export interface RelayStatus {
  running: boolean;
  /** The address actually bound, "127.0.0.1" or "0.0.0.0". */
  bind: string;
  port: number;
  /** Whether a key is set. The key itself never crosses this boundary twice. */
  keyed: boolean;
}

export interface ServerStatus {
  running: boolean;
  model_id?: string;
  port: number;
  phase: string; // stopped | starting | ready
  mode?: string; // resident-bit-exact | streamed-bit-exact | cpu-bit-exact | stock-llamacpp
  /**
   * Concurrent decode streams the engine serves (llama-server --parallel).
   * The hard bound on how many conversations may generate at the same time.
   */
  slots?: number;
  /**
   * The context window per slot the engine is actually serving.
   *
   * Not always the one that was asked for: each model is capped by the window
   * it was trained on, and by a cautious ceiling when it declares none.
   */
  ctx_per_slot?: number;
  /**
   * Whether the running model actually emits tool calls, MEASURED at warmup.
   * Undefined while unknown. False disables every agent surface, because
   * without tool calls the agent reads no file and runs no command.
   */
  tools_ok?: boolean;
  /**
   * The memory-footprint decision the running engine was started with.
   * Undefined while stopped.
   */
  footprint?: ModeDecision;
}

/**
 * Which memory footprint the engine actually started in, and why.
 *
 * `mode` differs from `requested` when the planner stepped down: the machine
 * could not give what the requested mode would have held, and the alternative
 * was llama_decode failing mid-graph with "Compute error.".
 */
export interface ModeDecision {
  mode: string;
  requested: string;
  impossible: boolean;
  resident_bytes: number;
  budget_bytes: number;
}

/**
 * What the engine's own log says about a failure the user just met.
 *
 * `kind` is "memory", "context" or "unknown". It comes from the log, not from
 * the API message: llama-server says the same three words whatever happened.
 */
export interface EngineDiagnosis {
  kind: string;
  mode: string;
  can_step_down: boolean;
  evidence: string;
  message: string;
}

/** One excerpt found in a stored conversation. */
export interface ConvHit {
  id: string;
  title: string;
  created: number;
  updated: number;
  line: number;
  snippet: string;
  score: number;
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

// ---- code workspace (code.rs) ----

/** One entry of a directory level, decorated with its git worktree status. */
export interface CodeEntry {
  name: string;
  /** Path relative to the workspace root. */
  path: string;
  dir: boolean;
  size: number;
  /** "M", "A", "D", "?" or "". */
  status: string;
}

export interface GitCommitInfo {
  hash: string;
  short: string;
  author: string;
  when: string;
  subject: string;
}

export interface GitInfo {
  repo: boolean;
  /**
   * False when this Mac carries no usable git. Distinct from `repo`: the panel
   * says "not a repository" for one and "git is not installed" for the other,
   * and never raises Apple's Command Line Tools installer to find out.
   */
  available: boolean;
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  dirty: boolean;
}

export interface GitChange {
  path: string;
  index: string;
  work: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  from: string;
}

// ---- workspace engine (search.rs, symbols.rs, toolchain.rs) ----

// There is no `Toolchains` binding here on purpose. toolchain.rs probes node,
// cargo and make for its headless driver, but the app only ever needs to know
// about git, and it learns that from `GitInfo.available` below. A typed client
// for a command nobody calls is dead weight that looks live.

export interface ImageModelInfo {
  id: string;
  name: string;
  bytes: number;
  roles: Record<string, string>;
  download: unknown;
  defaults: { steps?: number; cfg?: number; width?: number; height?: number };
  min_ram_gb: number;
  measured: Array<{ mac_gb?: number; width?: number; height?: number; steps?: number; seconds?: number }>;
  note: string;
  installed: boolean;
}

export interface ImageRequest {
  model: string;
  prompt: string;
  negative: string;
  steps: number;
  cfg: number;
  width: number;
  height: number;
  /** Negative asks the engine for a random one. */
  seed: number;
}

/** Wire shape of `SearchOpts` in search.rs: snake_case, not the UI's camel. */
export interface SearchOptsWire {
  case_sensitive: boolean;
  whole_word: boolean;
  regex: boolean;
  include_globs: string[];
  exclude_globs: string[];
}

export interface SearchHitWire {
  /** Relative to the workspace root, POSIX separators. */
  path: string;
  /** 1-based. */
  line: number;
  /** 1-based CHARACTER column, ready for a CodeMirror selection. */
  col: number;
  /** Byte offset of the match from the start of the file. */
  offset: number;
  /** Byte length of the match. */
  len: number;
  /** The whole line, no terminator, capped by the backend. */
  text: string;
}

/** One streamed batch on `galactus://search`. */
export interface SearchEvent {
  gen: number;
  hits: SearchHitWire[];
  done: boolean;
  capped: boolean;
  timed_out: boolean;
  cancelled?: boolean;
  matches?: number;
  scanned?: number;
  files?: number;
  error?: string;
}

export interface SymbolHitWire {
  name: string;
  kind: string;
  path: string;
  line: number;
  container: string;
  score: number;
}

/** Bulk workspace read for the in-app TypeScript service (snapshot.rs). */
export interface SnapshotPayload {
  files: [string, string][];
  truncated: boolean;
  total_bytes: number;
}

export const api = {
  // Hands the preview document to the app's own scheme and returns its URL:
  // served that way it carries its own content policy instead of inheriting
  // the app's, which blocks everything external.
  /**
   * Point the preview at a folder, or at nothing.
   *
   * Distinct from previewPublish, which hands over one self-contained document.
   * A site is a folder: index.html asks for styles.css, and only a root can
   * resolve that.
   */
  /** Clone a repository into a folder, returning the path it created. */
  gitClone: (url: string, parent: string, depth?: number) =>
    invoke<string>("git_clone", { url, parent, depth }),
  /** Machines saved for a remote terminal. Never a password, only an address. */
  sshHosts: () => invoke<SshHost[]>("ssh_hosts"),
  sshHostSave: (label: string, target: string, port?: number, id?: string) =>
    invoke<SshHost[]>("ssh_host_save", { id, label, target, port }),
  sshHostRemove: (id: string) => invoke<SshHost[]>("ssh_host_remove", { id }),
  /** Defensive audit of a machine the user controls: what is listening. */
  secScanPorts: (host: string, ports: number[]) =>
    invoke<PortResult[]>("sec_scan_ports", { host, ports }),
  /** Defensive audit of a web endpoint: headers, TLS, cookies. Read only. */
  secAuditWeb: (url: string) => invoke<WebAudit>("sec_audit_web", { url }),
  sshSpawn: (id: string, cwd: string, cols: number, rows: number) =>
    invoke<{ id: string; cols: number; rows: number; shell: string; cwd: string }>("ssh_spawn", {
      id, cwd, cols, rows,
    }),
  previewSetRoot: (root: string | null) => invoke<void>("preview_set_root", { root }),
  previewPublish: (html: string) => invoke<string>("preview_publish", { html }),
  hwInfo: () => invoke<HwInfo>("hw_info"),
  registry: () => invoke<ModelEntry[]>("load_registry"),
  detectRoot: () => invoke<string | null>("detect_root"),
  pickFolder: () => invoke<string | null>("pick_folder"),
  serverStatus: () => invoke<ServerStatus>("server_status"),
  serverStart: (modelId: string, cacheGb: number | null) =>
    invoke<void>("server_start", { modelId, cacheGb }),
  serverStop: () => invoke<void>("server_stop"),
  /**
   * Ask the backend what the engine's own log says about a failure.
   *
   * Never called speculatively: only when a turn ended on one of the engine's
   * decode messages, which are the ones that carry no cause of their own.
   */
  engineDiagnose: (message: string) => invoke<EngineDiagnosis>("engine_diagnose", { message }),
  installModel: (modelId: string, volumes?: InstallVolumes | null) =>
    invoke<void>("install_model", { modelId, volumes: volumes ?? null }),
  cancelInstall: (modelId: string) => invoke<void>("cancel_install", { modelId }),
  deleteModel: (modelId: string) => invoke<string>("delete_model", { modelId }),
  listVolumes: () => invoke<VolumeInfo[]>("list_volumes"),
  volumeBandwidth: (path: string) => invoke<number>("volume_bandwidth", { path }),
  /**
   * What the app would choose for one model on this Mac, without starting it.
   *
   * `volumes` are the measured drives, and are omitted for an installed model
   * or when the caller does not care where the pack would go: the layout then
   * comes back null rather than as a guess over drives nobody measured.
   */
  recommendForModel: (modelId: string, volumes?: MeasuredVolume[] | null) =>
    invoke<Recommendation>("recommend_for_model", { modelId, volumes: volumes ?? null }),
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
  /** The release notes shipped with this build, for the what-changed panel. */
  releaseNotes: () => invoke<string>("release_notes"),
  settingsGet: () => invoke<Record<string, string>>("settings_get"),
  /** The two settings the page may not write directly: they run programs. */
  mcpConfigSet: (config: string) => invoke<void>("mcp_config_set", { config }),
  rootSet: (path: string) => invoke<void>("root_set", { path }),
  settingsSet: (key: string, value: string) =>
    invoke<void>("settings_set", { key, value }),
  mcpReload: () => invoke<McpToolInfo[]>("mcp_reload"),
  mcpTools: () => invoke<McpToolInfo[]>("mcp_tools"),
  mcpCall: (server: string, tool: string, args: unknown) =>
    invoke<string>("mcp_call", { server, tool, args: JSON.stringify(args) }),
  memoryRead: () => invoke<string>("memory_read"),
  /** Save only if the file still holds `expected`. False when it moved. */
  memorySave: (text: string, expected: string) => invoke<boolean>("memory_save", { text, expected }),
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

  // The agent's own procedural memory. Deliberately NOT reachable through
  // skillsList / skillRead: the thirty shipped skills and the notes the agent
  // wrote for itself must never share a listing or a read path. See
  // learned.ts, section GOVERNANCE, G5.
  learnedList: () => invoke<{ slug: string; body: string }[]>("learned_list"),
  learnedWrite: (slug: string, body: string) =>
    invoke<string>("learned_write", { slug, body }),
  /** No slug empties the whole bank. */
  learnedDelete: (slug?: string) => invoke<void>("learned_delete", { slug: slug ?? null }),
  learnedFolder: () => invoke<string>("learned_folder"),
  convList: () => invoke<unknown[]>("conv_list"),
  convLoad: (id: string) => invoke<unknown>("conv_load", { id }),
  convSave: (id: string, data: string) => invoke<void>("conv_save", { id, data }),
  convDelete: (id: string) => invoke<void>("conv_delete", { id }),
  convSearch: (query: string, k?: number) => invoke<ConvHit[]>("conv_search", { query, k }),
  convRead: (id: string, maxChars?: number) => invoke<string>("conv_read", { id, maxChars }),
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
  // ---- network relay (relay.rs) ----
  //
  // The engine itself always stays on 127.0.0.1. Everything below drives the
  // authenticating relay that fronts it; see relay.rs for why the engine is
  // never bound to an outside interface directly.
  relayStatus: () => invoke<RelayStatus>("relay_status"),
  /** Mint a key. Returned once; the app shows it once and does not store it. */
  relayNewKey: () => invoke<string>("relay_new_key"),
  relayStart: (bind: string, port: number, key: string) =>
    invoke<RelayStatus>("relay_start", { bind, port, key }),
  relayStop: () => invoke<RelayStatus>("relay_stop"),
  relayAddresses: () => invoke<string[]>("relay_addresses"),

  // ---- scheduled jobs (scheduler.rs, cron.rs) ----
  //
  // Rust owns the clock, the definitions, the runtime state and the catch-up
  // decision, because the agent loop lives in this webview and a schedule that
  // lived here too would stop the moment a window closed. Everything below
  // returns the whole view rather than an acknowledgement: a save that changed
  // one job also changed the next fire of that job, and a second round trip to
  // learn that would be a second chance to be out of date.
  //
  // Every value ending in `_at` is unix SECONDS, not milliseconds.
  /** Arm the scheduler. Called once, after the job-due listener exists. */
  jobsReady: () => invoke<void>("jobs_ready"),
  jobsList: () => invoke<unknown>("jobs_list"),
  jobsSave: (job: Record<string, unknown>) => invoke<unknown>("jobs_save", { job }),
  jobsDelete: (id: string) => invoke<unknown>("jobs_delete", { id }),
  jobsEnable: (id: string, enabled: boolean) => invoke<unknown>("jobs_enable", { id, enabled }),
  jobsRunNow: (id: string) => invoke<unknown>("jobs_run_now", { id }),
  /** What became of a dispatched job. Also the only trigger for delivery. */
  jobsReport: (id: string, runId: string, outcome: string, detail: string) =>
    invoke<unknown>("jobs_report", { id, runId, outcome, detail }),
  /** The next few fires of a schedule that has not been saved yet. Seconds. */
  jobsPreview: (schedule: string, count?: number) =>
    invoke<number[]>("jobs_preview", { schedule, count }),
  /**
   * Show or hide the menu bar item. Server mode hides its window on close
   * rather than destroying it, so something has to say the app is still there.
   */
  traySet: (on: boolean) => invoke<void>("tray_set", { on }),

  kbStats: () =>
    invoke<{ files: number; chunks: number; folders: string[]; indexed_at: number } | null>("kb_stats"),
  // budgetTokens is what makes this useful: without it the search returns a
  // fixed 1490 tokens whatever the window can hold, which measured 0.364 on
  // the share of questions whose answer actually reached the model, against
  // 0.813 once the window is filled.
  kbSearch: (query: string, k?: number, budgetTokens?: number) =>
    invoke<{ path: string; snippet: string; score: number; line: number }[]>("kb_search", { query, k, budgetTokens }),
  // Retrieval over one oversized tool output kept whole on disk. Same BM25,
  // same budget discipline as kbSearch, restricted to a single scratch file.
  digestSearch: (path: string, query: string, budgetTokens?: number) =>
    invoke<{ path: string; snippet: string; score: number; line: number }[]>("digest_search", { path, query, budgetTokens }),

  // Code workspace. Every path is relative to `root` and confined to it in
  // Rust, not merely here: the model reaches these commands too.
  codeTree: (root: string, sub: string) => invoke<CodeEntry[]>("code_tree", { root, sub }),
  codeRead: (root: string, path: string) => invoke<string>("code_read", { root, path }),
  /** `expect` is the stamp from codeStamp; empty skips the freshness check. */
  codeWrite: (root: string, path: string, content: string, expect?: string) =>
    invoke<void>("code_write", { root, path, content, expect }),
  codeStamp: (root: string, path: string) => invoke<string>("code_stamp", { root, path }),
  /** Image generation. Nothing here reaches the network at generation time. */
  imageModels: () => invoke<ImageModelInfo[]>("image_models"),
  imageInstall: (id: string) => invoke<void>("image_install", { id }),
  imageInstallCancel: () => invoke<void>("image_install_cancel"),
  imageEnginePresent: () => invoke<boolean>("image_engine_present"),
  imageGenerate: (req: ImageRequest) => invoke<string>("image_generate", { req }),
  imageCancel: () => invoke<void>("image_cancel"),
  imageGallery: () => invoke<string[]>("image_gallery"),
  /** A generated image as a data URL: the page's policy allows data:, not files. */
  imageRead: (path: string) => invoke<string>("image_read", { path }),
  imageForget: (path: string) => invoke<void>("image_forget", { path }),
  codeCreate: (root: string, path: string, dir: boolean) =>
    invoke<string>("code_create", { root, path, dir }),
  codeRename: (root: string, from: string, to: string) =>
    invoke<string>("code_rename", { root, from, to }),
  /** Moves to the Trash, never unlinks. Returns where it landed. */
  codeDelete: (root: string, path: string) => invoke<string>("code_delete", { root, path }),
  gitInfo: (root: string) => invoke<GitInfo>("git_info", { root }),
  gitStatus: (root: string) => invoke<GitChange[]>("git_status", { root }),
  gitLog: (root: string, limit?: number, path?: string) =>
    invoke<GitCommitInfo[]>("git_log", { root, limit, path }),
  gitDiff: (root: string, path?: string, rev?: string) =>
    invoke<string>("git_diff", { root, path, rev }),
  gitFileDiff: (root: string, path: string, staged: boolean) =>
    invoke<string>("git_file_diff", { root, path, staged }),
  gitShowFile: (root: string, rev: string, path: string) =>
    invoke<string>("git_show_file", { root, rev, path }),
  gitStage: (root: string, paths: string[], unstage: boolean) =>
    invoke<void>("git_stage", { root, paths, unstage }),
  gitCommit: (root: string, message: string, all: boolean) =>
    invoke<string>("git_commit", { root, message, all }),
  gitPush: (root: string) => invoke<string>("git_push", { root }),
  gitPull: (root: string, rebase: boolean) => invoke<string>("git_pull", { root, rebase }),
  gitBranches: (root: string) => invoke<string[]>("git_branches", { root }),
  gitCheckout: (root: string, branch: string, create: boolean) =>
    invoke<string>("git_checkout", { root, branch, create }),

  // Integrated terminal. `origin` and `gated` are not decoration: pty.rs
  // refuses a model write that does not state it passed the shell gate, so a
  // caller that forgets gets an error instead of a silent execution.
  ptySpawn: (cwd: string, cols: number, rows: number, owner: "user" | "model") =>
    invoke<{ id: string; cols: number; rows: number; shell: string; cwd: string }>("pty_spawn", {
      cwd,
      cols,
      rows,
      owner,
    }),
  ptyWrite: (id: string, data: string, origin: "user" | "model", gated: boolean) =>
    invoke<void>("pty_write", { id, data, origin, gated }),
  ptyResize: (id: string, cols: number, rows: number) =>
    invoke<[number, number]>("pty_resize", { id, cols, rows }),
  ptyKill: (id: string) => invoke<void>("pty_kill", { id }),
  ptyList: () => invoke<string[]>("pty_list"),

  // Workspace engine. Read-only and confined to `root` in Rust, exactly like
  // the code_* commands: the model reaches two of these as well.
  searchStart: (root: string, query: string, opts: SearchOptsWire) =>
    invoke<number>("search_start", { root, query, opts }),
  searchCancel: (gen: number) => invoke<void>("search_cancel", { gen }),
  searchFiles: (root: string, refresh: boolean) =>
    invoke<string[]>("search_files", { root, refresh }),
  symbolsIndex: (root: string, refresh: boolean) =>
    invoke<number>("symbols_index", { root, refresh }),
  symbolsQuery: (root: string, q: string, limit?: number) =>
    invoke<SymbolHitWire[]>("symbols_query", { root, q, limit }),
  /** Bulk read for the language service. Tauri maps capBytes -> cap_bytes. */
  codeSnapshot: (root: string, exts: string[], capBytes: number, capFiles: number) =>
    invoke<SnapshotPayload>("code_snapshot", { root, exts, capBytes, capFiles }),

  // The bundled rust-analyzer. These five are the transport and nothing else:
  // code/rust-lsp.ts owns the protocol, the document state and the fallbacks.
  rustLspStart: (root: string) => invoke<RustLspStatus>("rust_lsp_start", { root }),
  rustLspStop: () => invoke<void>("rust_lsp_stop"),
  rustLspStatus: () => invoke<RustLspStatus>("rust_lsp_status"),
  rustLspRequest: (method: string, params: unknown, timeoutMs?: number) =>
    invoke<unknown>("rust_lsp_request", { method, params, timeoutMs }),
  rustLspNotify: (method: string, params: unknown) =>
    invoke<void>("rust_lsp_notify", { method, params }),
  // `py_analyze` is deliberately absent. code/pylang.ts owns that call: it
  // types the payload (this binding returned `unknown`), it debounces it, and
  // it routes it through an injectable invoker so the tests can drive Python
  // analysis with no Tauri. A second, untyped entry point beside it was a
  // caller-less copy that would have bypassed all three.
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
  // excluded), far more honest than wall-clock; fall back to wall-clock.
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

/**
 * One insertion-only completion for the Code view. The request stays local,
 * carries only a bounded window around the caret and is independently
 * cancellable as soon as the user keeps typing.
 */
export async function inlineCodeOnce(
  port: number,
  file: string,
  prefix: string,
  suffix: string,
  abort: AbortSignal
): Promise<string> {
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "galactus-local",
      messages: [
        {
          role: "system",
          content:
            "You are an inline code completion engine. Return only the exact text to insert at <CURSOR>. " +
            "Never use Markdown fences, explanations, XML tags, or repeat text already present. " +
            "Preserve the file's language and indentation. Return an empty string when uncertain.",
        },
        {
          role: "user",
          content: `FILE: ${file}\n\n<BEFORE>\n${prefix}\n<CURSOR>\n<AFTER>\n${suffix}`,
        },
      ],
      temperature: 0.05,
      max_tokens: 192,
      stream: false,
    }),
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
  /**
   * The model's thoughts, when the server separated them from the answer.
   *
   * llama-server is started with --reasoning-format deepseek, which puts
   * thinking in `delta.reasoning_content` and leaves `delta.content` holding
   * the answer alone. The two channels interleave inside one stream, so this
   * is a second live feed and not a preamble: a caller that appends both to
   * the same buffer would splice thoughts into the middle of the reply.
   *
   * OPTIONAL, and most turns never call it. Plenty of models emit no
   * reasoning at all, and a model that reasoned on one turn reasons on none of
   * the next: a caller must show nothing rather than an empty container.
   */
  onReasoning?: (text: string) => void;
  onToolCalls: (calls: ToolCall[]) => void;
  onDone: () => void;
  onError: (err: string) => void;
}

/**
 * Stream one chat completion. Returns true when the stream finished normally
 * (including a user abort, which is not an error) and false when the request
 * failed, in that case onError has already been called and the caller must
 * NOT treat the turn as completed.
 */
export async function streamChat(
  port: number,
  messages: ChatMessage[],
  tools: ToolDef[],
  handlers: StreamHandlers,
  abort: AbortSignal,
  temperature = 0.6,
  // Sent whole when the caller has them. Omitted entirely otherwise, so a
  // caller that knows nothing about sampling still gets llama.cpp's defaults
  // rather than this file's opinion of them.
  sampling?: { top_p: number; top_k: number },
  // False asks the chat template to skip the reasoning phase. Qwen honours it;
  // templates that do not simply ignore an unknown key, which is why it is sent
  // rather than guarded by a per-model list that would go stale.
  thinking = true,
): Promise<boolean> {
  const body: any = {
    model: "galactus-local",
    messages,
    stream: true,
    temperature,
  };
  if (sampling) {
    body.top_p = sampling.top_p;
    body.top_k = sampling.top_k;
  }
  if (!thinking) body.chat_template_kwargs = { enable_thinking: false };
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
    // A user stop while connecting surfaces as an AbortError, not an error.
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
        // llama-server can push an error frame AFTER the stream opened (slot
        // failure, context overflow discovered late): without this the turn
        // would end as a silent success with an empty answer.
        if (parsed.error || (parsed.message && !parsed.choices)) {
          const err = parsed.error ?? parsed;
          const msg =
            typeof err === "string" ? err : String(err.message ?? JSON.stringify(err));
          try {
            await reader.cancel();
          } catch {}
          handlers.onError(msg.slice(0, 300));
          return false;
        }
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;
        // Reasoning BEFORE content, and not only for tidiness: one delta can
        // carry both (the frame where thinking ends and the answer starts),
        // and a thought delivered after the words it produced would read as
        // an afterthought instead of the reason for them.
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
          handlers.onReasoning?.(delta.reasoning_content);
        }
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
            // The name arrives whole (never chunked): assign, don't append,
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
