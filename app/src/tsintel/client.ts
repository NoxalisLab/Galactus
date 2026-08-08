// Galactus, the main thread side of the language service, and the tier gate.
//
// Two jobs. The first is plumbing: one worker, one promise per request, one
// snapshot. The second is the one that matters, and it is a refusal.
//
// TIER A IS NOT ALWAYS WORTH IT. It costs 1.6 MB gzipped of TypeScript, 326 kB
// gzipped of default libraries, and however much memory the workspace snapshot
// takes. On a small project that buys real hover, real go to definition and a
// rename that is actually correct. On a large monorepo it buys a beachball. So
// the cost is MEASURED at init, on the machine and the workspace the user
// actually has, and if it comes out over budget the module says so and steps
// aside: `tier()` returns 'B', the worker is terminated, its memory goes back,
// and the UI badges the editor honestly instead of pretending.
//
// One real limitation, stated rather than hidden: the snapshot is a photograph.
// A file changed on disk by anything other than this app, a terminal, another
// editor, a build script, is stale to the language service until the next
// refresh. Refreshes happen when the app already knows the tree moved: after
// `pull()` and after `checkout()`.

import type {
  BufferInfo,
  CompletionItem,
  Diag,
  HoverInfo,
  InitInfo,
  Loc,
  RefHit,
  RenamePlan,
  Req,
  Res,
  SnapshotInfo,
} from "./protocol.js";
import type { RenameEdit } from "./rename.js";
import { applyRenameHits } from "./rename.js";

export type Tier = "A" | "B";

/** Result of `code_snapshot`, exactly as the Rust command returns it. */
export interface SnapshotPayload {
  files: Array<[string, string]>;
  truncated: boolean;
  total_bytes: number;
}

export interface TsIntelDeps {
  /** Calls the `code_snapshot` Tauri command. Injected so this module has no
   *  opinion about the transport and can be exercised from Node. */
  snapshot(root: string, exts: string[], capBytes: number, capFiles: number): Promise<SnapshotPayload>;
  /** Optional trace sink; the app routes it to its own log. */
  log?(line: string): void;
}

export interface TierBudget {
  /** Over this, the workspace is too big to keep a whole program in a webview. */
  maxSnapshotBytes: number;
  maxSnapshotFiles: number;
  /** Over this, the first program took long enough that every later keystroke
   *  will too. */
  maxProgramMs: number;
}

export const DEFAULT_BUDGET: TierBudget = {
  maxSnapshotBytes: 48 * 1024 * 1024,
  maxSnapshotFiles: 6000,
  maxProgramMs: 4000,
};

/** What the snapshot asks the backend for. `d.ts` files under node_modules and
 *  package.json are admitted by the command itself, not by this list. */
export const SNAPSHOT_EXTS = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json"];

export interface TierReport {
  tier: Tier;
  /** i18n key for the badge, plus the numbers it interpolates. */
  reason: string;
  files: number;
  sourceFiles: number;
  bytes: number;
  truncated: boolean;
  programMs: number;
  libFiles: number;
  configPath: string | null;
  missingLibs: string[];
}

// ---------------------------------------------------------------- state

let deps: TsIntelDeps | null = null;
let budget: TierBudget = DEFAULT_BUDGET;

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();

let currentRoot: string | null = null;
let currentTier: Tier = "B";
let report: TierReport | null = null;
let starting: Promise<TierReport> | null = null;
/** Buffers pushed while the worker was still booting, replayed after init. */
const pendingBuffers = new Map<string, string>();

export function configureTsIntel(d: TsIntelDeps, b?: Partial<TierBudget>): void {
  deps = d;
  budget = { ...DEFAULT_BUDGET, ...(b ?? {}) };
}

export function tier(): Tier {
  return currentTier;
}

export function tierReport(): TierReport | null {
  return report;
}

export function tsIntelRoot(): string | null {
  return currentRoot;
}

/**
 * Tier A defaults on only when the workspace looks like a JavaScript or
 * TypeScript project. A Rust repository or a folder of notes should not pay a
 * 2 MB parse to be told nothing, and the user can still turn it on by hand.
 */
export function autoEnable(rootEntryNames: readonly string[]): boolean {
  return rootEntryNames.includes("tsconfig.json") || rootEntryNames.includes("package.json");
}

function log(line: string): void {
  deps?.log?.(`[tsintel] ${line}`);
}

// ---------------------------------------------------------------- worker

function ensureWorker(): Worker {
  if (worker) return worker;
  // `new Worker(new URL(...))` is the ONE form that survives here. Vite emits
  // worker.ts as a separate same-origin chunk and rewrites this URL to it; a
  // dynamic `import()` would pull TypeScript into the main thread instead, and
  // a blob: worker is refused by the CSP. Constructing it lazily, only from
  // `enable()`, is what keeps 9 MB off the cold start path.
  const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (e: MessageEvent) => {
    const res = e.data as Res;
    const slot = waiting.get(res?.id);
    if (!slot) return;
    waiting.delete(res.id);
    if (res.ok) slot.resolve((res as { value: unknown }).value);
    else slot.reject(new Error(res.error));
  };
  w.onerror = (e: ErrorEvent) => {
    const message = e.message || "the language service worker failed to start";
    log(`worker error: ${message}`);
    for (const [, slot] of waiting) slot.reject(new Error(message));
    waiting.clear();
    fallback(`worker error: ${message}`);
  };
  worker = w;
  return w;
}

function send<T>(req: Omit<Req, "id"> & { id?: number }): Promise<T> {
  const w = worker;
  if (!w) return Promise.reject(new Error("the language service is not running"));
  const id = ++seq;
  const message = { ...req, id } as Req;
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage(message);
  });
}

/** Give up on Tier A: stop the worker, hand the memory back, remember why. */
function fallback(reason: string): void {
  currentTier = "B";
  if (report) report = { ...report, tier: "B", reason };
  worker?.terminate();
  worker = null;
  waiting.clear();
  log(`tier B: ${reason}`);
}

// ---------------------------------------------------------------- lifecycle

/**
 * Bring the language service up for one workspace and decide its tier.
 *
 * Returns a report either way. Tier B is a normal outcome, not an error: the
 * editor keeps CodeMirror's own TypeScript grammar, which is what it had
 * before this module existed.
 */
export async function enable(root: string): Promise<TierReport> {
  if (!deps) throw new Error("configureTsIntel has not been called");
  if (currentRoot === root && starting) return starting;
  disable();
  currentRoot = root;
  starting = boot(root).catch((e: unknown) => {
    const reason = e instanceof Error ? e.message : String(e);
    fallback(reason);
    const r: TierReport = {
      tier: "B",
      reason,
      files: 0,
      sourceFiles: 0,
      bytes: 0,
      truncated: false,
      programMs: 0,
      libFiles: 0,
      configPath: null,
      missingLibs: [],
    };
    report = r;
    return r;
  });
  return starting;
}

async function boot(root: string): Promise<TierReport> {
  const payload = await deps!.snapshot(root, SNAPSHOT_EXTS, budget.maxSnapshotBytes, budget.maxSnapshotFiles);

  // First gate, before a single byte of TypeScript is parsed: if the workspace
  // is already over budget there is no point paying 9 MB to find out.
  //
  // `truncated` is the load-bearing condition. The backend stops AT the cap
  // rather than reporting what it would have been, so a workspace over budget
  // arrives as a complete-looking snapshot with a flag set. Running Tier A on a
  // truncated program is the worst outcome available: every unresolved import
  // becomes `any`, and hover answers confidently about nothing.
  if (
    payload.truncated ||
    payload.total_bytes > budget.maxSnapshotBytes ||
    payload.files.length > budget.maxSnapshotFiles
  ) {
    const r: TierReport = {
      tier: "B",
      reason: payload.truncated
        ? `the workspace does not fit the Tier A budget of ${budget.maxSnapshotFiles} files / ${budget.maxSnapshotBytes} bytes`
        : `snapshot is ${payload.files.length} files / ${payload.total_bytes} bytes, over the Tier A budget`,
      files: payload.files.length,
      sourceFiles: 0,
      bytes: payload.total_bytes,
      truncated: payload.truncated,
      programMs: 0,
      libFiles: 0,
      configPath: null,
      missingLibs: [],
    };
    currentTier = "B";
    report = r;
    log(r.reason);
    return r;
  }

  ensureWorker();
  const t0 = Date.now();
  const snap = await send<SnapshotInfo>({
    kind: "setSnapshot",
    files: payload.files,
    truncated: payload.truncated,
    totalBytes: payload.total_bytes,
  } as Omit<Req, "id">);
  const info = await send<InitInfo>({ kind: "init", root } as Omit<Req, "id">);
  const bootMs = Date.now() - t0;

  // Second gate, on the number that actually predicts the experience: how long
  // the first program took. It includes the worker's own cold start, which is
  // the honest figure, because the user waits for all of it.
  const programMs = Math.max(snap.programMs, info.programMs, bootMs);
  const r: TierReport = {
    tier: "A",
    reason: "",
    files: info.snapshot.files,
    sourceFiles: info.snapshot.sourceFiles,
    bytes: info.snapshot.bytes,
    truncated: info.snapshot.truncated,
    programMs,
    libFiles: info.libFiles,
    configPath: info.configPath,
    missingLibs: info.missingLibs,
  };
  if (programMs > budget.maxProgramMs) {
    r.tier = "B";
    r.reason = `the first program took ${programMs} ms, over the ${budget.maxProgramMs} ms Tier A budget`;
    currentTier = "B";
    report = r;
    fallback(r.reason);
    return r;
  }
  currentTier = "A";
  report = r;
  log(
    `tier A: ${r.sourceFiles} source files, ${r.files} snapshot files, ${r.bytes} bytes, ` +
      `${r.libFiles} libs, program in ${programMs} ms` +
      (r.truncated ? " (snapshot TRUNCATED, answers may be incomplete)" : "")
  );
  // Anything the editor typed while the worker was booting is replayed, or the
  // service would answer about a file the user has already moved past.
  for (const [rel, text] of pendingBuffers) void send<BufferInfo>({ kind: "updateBuffer", rel, text } as Omit<Req, "id">);
  pendingBuffers.clear();
  return r;
}

export function disable(): void {
  worker?.terminate();
  worker = null;
  waiting.clear();
  pendingBuffers.clear();
  starting = null;
  report = null;
  currentTier = "B";
  currentRoot = null;
}

/**
 * Re-read the workspace. Called where the Code view already knows the files
 * moved under it: after a pull and after a checkout. Everything else, an
 * external editor, a terminal `git stash`, a build script, is stale until one
 * of those happens or the user reopens the workspace.
 */
export async function refreshSnapshot(): Promise<TierReport | null> {
  if (currentTier !== "A" || !currentRoot || !deps) return report;
  const root = currentRoot;
  const payload = await deps.snapshot(root, SNAPSHOT_EXTS, budget.maxSnapshotBytes, budget.maxSnapshotFiles);
  // A workspace that grew past the budget between two refreshes drops to tier B
  // here rather than quietly answering from half a program.
  if (payload.truncated) {
    const reason = `the workspace no longer fits the Tier A budget of ${budget.maxSnapshotFiles} files / ${budget.maxSnapshotBytes} bytes`;
    fallback(reason);
    if (report) report = { ...report, truncated: true };
    return report;
  }
  const snap = await send<SnapshotInfo>({
    kind: "setSnapshot",
    files: payload.files,
    truncated: payload.truncated,
    totalBytes: payload.total_bytes,
  } as Omit<Req, "id">);
  if (report) {
    report = {
      ...report,
      files: snap.snapshot.files,
      sourceFiles: snap.snapshot.sourceFiles,
      bytes: snap.snapshot.bytes,
      truncated: snap.snapshot.truncated,
      programMs: snap.programMs,
    };
  }
  return report;
}

/** Push the editor's buffer. Cheap, unawaited, and safe to call on every
 *  keystroke: the host only bumps a version when the text actually changed. */
export function updateBuffer(rel: string, text: string): void {
  if (currentTier !== "A" || !worker) {
    if (currentRoot) pendingBuffers.set(rel, text);
    return;
  }
  void send<BufferInfo>({ kind: "updateBuffer", rel, text } as Omit<Req, "id">).catch(() => {});
}

// ---------------------------------------------------------------- queries

/** Every query answers `null`/`[]` in Tier B rather than throwing, so a caller
 *  can be written once and work in both tiers. */
function off<T>(value: T): Promise<T> {
  return Promise.resolve(value);
}

export function hover(rel: string, pos: number): Promise<HoverInfo | null> {
  if (currentTier !== "A") return off(null);
  return send<HoverInfo | null>({ kind: "hover", rel, pos } as Omit<Req, "id">).catch(() => null);
}

export function definition(rel: string, pos: number): Promise<Loc[]> {
  if (currentTier !== "A") return off<Loc[]>([]);
  return send<Loc[]>({ kind: "definition", rel, pos } as Omit<Req, "id">).catch(() => []);
}

export function references(rel: string, pos: number): Promise<RefHit[]> {
  if (currentTier !== "A") return off<RefHit[]>([]);
  return send<RefHit[]>({ kind: "references", rel, pos } as Omit<Req, "id">).catch(() => []);
}

export function completions(rel: string, pos: number): Promise<CompletionItem[]> {
  if (currentTier !== "A") return off<CompletionItem[]>([]);
  return send<CompletionItem[]>({ kind: "completions", rel, pos } as Omit<Req, "id">).catch(() => []);
}

export function diagnostics(rel: string): Promise<Diag[]> {
  if (currentTier !== "A") return off<Diag[]>([]);
  return send<Diag[]>({ kind: "diagnostics", rel } as Omit<Req, "id">).catch(() => []);
}

/**
 * Plan a rename from the main thread. The worker finds the sites; the edits are
 * applied here, against the contents the caller reads, and RETURNED. Nothing is
 * written: the integrator hands these to `fileProposal(...)` and the user
 * accepts them hunk by hunk like any other change.
 */
export async function planRenameFromClient(
  rel: string,
  pos: number,
  newName: string,
  readFile: (rel: string) => Promise<string | undefined>
): Promise<RenameEdit[]> {
  if (currentTier !== "A") throw new Error("rename needs the TypeScript language service");
  const plan = await send<RenamePlan>({ kind: "renameLocations", rel, pos, newName } as Omit<Req, "id">);
  if (!plan.canRename) throw new Error(plan.reason);
  if (!plan.hits.length) return [];
  const contents = new Map<string, string>();
  for (const target of new Set(plan.hits.map((h) => h.rel))) {
    const text = await readFile(target);
    if (text === undefined) throw new Error(`rename touches ${target}, which cannot be read`);
    contents.set(target, text);
  }
  return applyRenameHits(plan.hits, newName, contents);
}
