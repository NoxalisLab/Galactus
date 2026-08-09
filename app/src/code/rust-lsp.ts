// Galactus, Code view: the .rs tier, driven by the bundled rust-analyzer.
//
// The bundle already carries the server and 70 MB of standard library sources
// (scripts/fetch-rust-tooling.sh). This is the editor half: document
// synchronisation, diagnostics, hover, completion, go to definition,
// references and a rename that is a plan rather than a write. The process half
// is src-tauri/src/lsp.rs, which owns framing, correlation and the allowlist
// of read-only methods.
//
// Shaped after tsintel/bindings.ts on purpose, including the choice that file
// documents at its `tsCompletion`: completions are added through
// `Language.data.of({autocomplete})` and NEVER through
// `autocompletion({override})`. `override` REPLACES every source, which would
// silently kill the snippet and word completions the Rust grammar already
// provides, and would turn a server hiccup into an editor that offers nothing
// at all. `data.of` adds, so the difference between a running server and a
// dead one is what is gained, never what disappeared.
//
// HONESTY IS THE FEATURE. Everything here re-checks `rustReady()` on every
// call and answers "nothing" when the server is absent, still indexing or
// dead. A .rs file then keeps the Syntax tier it had before this module
// existed, and `rustTierNote()` gives the badge the words to say why. The
// alternative, a hover that silently never appears, reads as a broken editor.
//
// THE POSITION TRAP, because it is the bug that would survive review. LSP
// positions are {line, character} where `character` counts UTF-16 code units,
// and the editor's positions are absolute offsets into a JavaScript string,
// which is also UTF-16. The two therefore convert with no encoding maths at
// all, but ONLY because lsp.rs advertises `positionEncodings: ["utf-16"]` and
// refuses to run if the server picks anything else. Any change to that
// negotiation makes every accented line report its columns a few units off.

import type { EditorState, Extension } from "@codemirror/state";
import { EditorView, hoverTooltip, keymap, type Tooltip } from "@codemirror/view";
import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import type { Language, LanguageSupport } from "@codemirror/language";
import type { Diagnostic } from "@codemirror/lint";

// ---------------------------------------------------------------- contract

/** Identifier the Rust diagnostics are filed under. */
export const RUST_LSP_SOURCE = "rust";

/**
 * How long a diagnostic request waits for the server to publish a fresh set
 * after the buffer changed. Diagnostics are UNSOLICITED in LSP: the server
 * pushes them when it feels like it, so the source cannot simply ask. Past
 * this it returns the last published set, which is stale by a few keystrokes
 * and infinitely better than an empty gutter that flickers on every edit.
 */
export const DIAGNOSTIC_WAIT_MS = 1200;

/** Requests the editor makes while the user waits. Kept well under the Rust
 *  side's default so a slow answer is reported here, with our own wording. */
export const INTERACTIVE_TIMEOUT_MS = 6000;

/**
 * The smallest slice of `EditorState["doc"]` this module needs.
 *
 * Declared structurally rather than importing CodeMirror's `Text` so the
 * conversions below can be unit tested against a three-line fake with no
 * editor, no DOM and no bundle. `Text` satisfies it as written.
 */
export interface TextDocLike {
  readonly length: number;
  readonly lines: number;
  line(n: number): { from: number; to: number; text: string };
  toString(): string;
}

export interface EditorStateLike {
  readonly doc: TextDocLike;
}

/**
 * Compile-time proof that CodeMirror's own `EditorState` satisfies the narrow
 * interface above, so `registerDiagnosticSource` accepts this module's source
 * with no cast. If a future CodeMirror reshapes `Text`, the failure lands here,
 * next to the definition, instead of at the one call site in the Code view.
 */
type StateIsCompatible = EditorState extends EditorStateLike ? true : never;
const _stateIsCompatible: StateIsCompatible = true;

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnostic {
  range: LspRange;
  /** 1 error, 2 warning, 3 information, 4 hint. Absent means error. */
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

/** Mirrors LspStatus in src-tauri/src/lsp.rs. */
export interface RustLspStatus {
  running: boolean;
  root: string | null;
  root_uri: string | null;
  server: string | null;
  sysroot: string | null;
  sysroot_src: string | null;
  cargo: boolean;
  pid: number | null;
  note: string | null;
}

/** One hit of `textDocument/references`, in the shape the Code view paints. */
export interface RustRefHit {
  rel: string;
  line: number;
  col: number;
  /** Offset of the hit inside `rel`, when the file is open in the editor. */
  start: number;
  text: string;
}

/** Same shape as tsintel/rename.ts: whole files, never patches, never writes. */
export interface RustRenameEdit {
  rel: string;
  content: string;
}

export interface RustLspDeps {
  /** The open file, relative to the workspace root, or null. */
  file(): string | null;
  /** Open a file and put the cursor there. The Code view already has this. */
  openFile(rel: string, line: number, col: number): void;
  /** Show the references list. `html` comes from `rustReferencesHtml`. */
  showReferences?(html: string, hits: RustRefHit[]): void;
  /** Translate a UI string, with an English fallback so this module never
   *  blocks on the i18n table landing. */
  t?(key: string, fallback: string): string;
}

/** The transport. Injected so every test runs with no Tauri and no window. */
export interface RustLspTransport {
  start(root: string): Promise<RustLspStatus>;
  stop(): Promise<void>;
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
  /** Subscribe to `galactus://rust-lsp`. Returns the unsubscribe function. */
  listen(handler: (payload: RustLspEvent) => void): Promise<() => void>;
  log?(line: string): void;
}

/** What arrives unsolicited on the event channel. */
export type RustLspEvent =
  | { kind: "diagnostics"; params: { uri: string; version?: number; diagnostics: LspDiagnostic[] } }
  | { kind: "progress"; params: { token: unknown; value: { kind?: string; title?: string; message?: string } } }
  | { kind: "log"; params: { type?: number; message?: string } }
  | { kind: "stopped"; reason: string };

// ---------------------------------------------------------------- state machine

/**
 * Five states, and the badge depends on telling them apart.
 *
 *   off       nothing has been asked for, or the workspace is not Rust.
 *   starting  the process is up but `initialize` has not come back.
 *   indexing  initialized, and the server is reading the crate graph. Answers
 *             during this window are INCOMPLETE, not wrong: hover on a std
 *             item returns nothing until the sysroot is loaded, so promising
 *             tier A here would produce a feature that works one time in three.
 *   ready     answering.
 *   failed    absent, refused to start, or died. Terminal until a new start.
 */
export type RustLspState = "off" | "starting" | "indexing" | "ready" | "failed";

export type RustLspTransition =
  | "start"
  | "initialized"
  | "indexBegin"
  | "indexEnd"
  | "fail"
  | "stop";

/**
 * The transition table, as a pure function so the awkward cases can be
 * asserted: progress that begins before `initialize` returns, an `indexEnd`
 * with no matching begin, a failure arriving after a stop.
 */
export function rustLspReduce(state: RustLspState, event: RustLspTransition): RustLspState {
  if (event === "stop") return "off";
  if (event === "fail") return "failed";
  if (event === "start") return "starting";
  switch (state) {
    case "starting":
      // Progress notifications arrive before the initialize response on a cold
      // workspace. They must not promote the session to a state that claims to
      // answer, so they are absorbed here.
      return event === "initialized" ? "ready" : "starting";
    case "ready":
      return event === "indexBegin" ? "indexing" : "ready";
    case "indexing":
      return event === "indexEnd" ? "ready" : "indexing";
    // A stale event about a session that is off or failed changes nothing: only
    // an explicit `start` revives either.
    case "off":
    case "failed":
      return state;
  }
}

// ---------------------------------------------------------------- uri

/**
 * A file URI for a path. Twin of `path_to_uri` in src-tauri/src/lsp.rs, and
 * the two MUST agree: the Rust side builds the workspace URI at `initialize`,
 * this side builds every document URI, and rust-analyzer keys its documents on
 * the exact string.
 *
 * `encodeURIComponent` cannot do this job alone. It escapes `/`, which has to
 * survive, and it leaves `'`, `(`, `)`, `!`, `*` alone, which the Rust side
 * escapes. Doing it byte by byte over the UTF-8 encoding is the only way to
 * get one answer on both sides.
 */
export function pathToUri(absolutePath: string): string {
  const bytes = new TextEncoder().encode(absolutePath);
  let out = "file://";
  for (const b of bytes) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-._~/]/.test(c)) out += c;
    else out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/** Percent-decoding, over bytes, so a multi-byte character survives the trip. */
export function uriToPath(uri: string): string {
  const withoutScheme = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
  const bytes: number[] = [];
  for (let i = 0; i < withoutScheme.length; i++) {
    const c = withoutScheme[i];
    if (c === "%" && i + 2 < withoutScheme.length) {
      const hex = withoutScheme.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    for (const b of new TextEncoder().encode(c)) bytes.push(b);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * A URI back to a workspace-relative path, or null when it points outside.
 *
 * Outside is normal and common: go to definition on `HashMap` lands in the
 * bundled standard library sources, which are in the app bundle and not in the
 * user's project. Returning null lets the caller decline politely instead of
 * opening a path the file tree cannot show.
 */
export function uriToRel(root: string, uri: string): string | null {
  const path = uriToPath(uri);
  const base = root.endsWith("/") ? root : root + "/";
  if (path === root) return "";
  if (!path.startsWith(base)) return null;
  return path.slice(base.length);
}

// ---------------------------------------------------------------- positions

/** Editor offset to LSP position. Clamped: a stale offset must not throw. */
export function posToLsp(doc: TextDocLike, pos: number): LspPosition {
  const clamped = Math.max(0, Math.min(Math.trunc(pos) || 0, doc.length));
  const n = lineNumberAt(doc, clamped);
  return { line: n - 1, character: clamped - doc.line(n).from };
}

/** LSP position to editor offset. Clamped at both ends, for the same reason:
 *  a server answering about a buffer the user has already edited must produce
 *  a harmless position, not an exception inside a tooltip. */
export function lspToPos(doc: TextDocLike, position: LspPosition): number {
  const n = Math.min(Math.max(Math.trunc(position.line) + 1, 1), doc.lines);
  const line = doc.line(n);
  const character = Math.max(Math.trunc(position.character) || 0, 0);
  return Math.min(line.from + character, line.to);
}

export function lspRangeToOffsets(doc: TextDocLike, range: LspRange): { from: number; to: number } {
  const from = lspToPos(doc, range.start);
  let to = lspToPos(doc, range.end);
  // A zero-width range underlines nothing at all, which is how a real error
  // ends up invisible. One character is the smallest honest marker.
  //
  // Widening FORWARD is a no-op at the very end of the buffer, and a server
  // one edit behind reports end-of-file errors there routinely, so that case
  // widens backwards instead. Only an empty document has nowhere to go.
  if (to <= from) {
    if (from < doc.length) to = from + 1;
    else return { from: Math.max(0, from - 1), to: from };
  }
  return { from, to };
}

/**
 * Which line an offset is on, by binary search.
 *
 * CodeMirror's `Text` has `lineAt`, which would do this in one call, but
 * `TextDocLike` deliberately declares the smallest surface a test fake can
 * implement honestly. `line(n)` is enough: line starts increase with n, so the
 * search is exact and costs log(n) rather than the linear scan a naive version
 * would do on every keystroke of a 4 MB file.
 */
function lineNumberAt(doc: TextDocLike, pos: number): number {
  let low = 1;
  let high = doc.lines;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (doc.line(mid).from <= pos) low = mid;
    else high = mid - 1;
  }
  return low;
}

// ---------------------------------------------------------------- module state

let transport: RustLspTransport | null = null;
let state: RustLspState = "off";
let statusInfo: RustLspStatus | null = null;
let reason = "";
let currentRoot: string | null = null;
let unlisten: (() => void) | null = null;
let starting: Promise<RustLspState> | null = null;

/** Open documents, by workspace-relative path. LSP is stateful: the server
 *  answers about the version it was last told, so this is the source of truth
 *  for what it believes. */
interface OpenDoc {
  uri: string;
  version: number;
  text: string;
}
const open = new Map<string, OpenDoc>();

/** Last published diagnostics, by URI, plus whoever is waiting for the next
 *  set. Keyed by URI because that is what the server sends. */
interface DiagSlot {
  items: LspDiagnostic[];
  waiters: Array<(items: LspDiagnostic[]) => void>;
}
const published = new Map<string, DiagSlot>();

/** Outstanding `$/progress` tokens. See the progress branch of `onEvent`. */
const tokens = new Set<string>();
/** Title of the oldest outstanding progress token, for the badge. */
let indexTitle = "";

/**
 * Which session a boot belongs to.
 *
 * The Rust side has had a generation counter from the start and this side had
 * none, which was exactly half a fix. A boot abandoned by a workspace switch
 * still ran to completion and wrote its status over the session that replaced
 * it: the badge then reported the PREVIOUS workspace's limitation ("no cargo
 * on this Mac") for a workspace that has cargo, and a boot that finished after
 * disableRustLsp() resurrected `statusInfo` to running for a server that had
 * been stopped.
 */
let generation = 0;

/** Ask the host to re-run the linter. See the diagnostics branch of onEvent. */
let refreshDiagnostics: (rel: string) => void = () => {};

export function configureRustLsp(t: RustLspTransport): void {
  transport = t;
}

export function rustLspState(): RustLspState {
  return state;
}

/** True only while the server can actually answer. Everything gates on this. */
export function rustReady(): boolean {
  return state === "ready";
}

export function rustLspStatus(): RustLspStatus | null {
  return statusInfo;
}

export function rustLspRoot(): string | null {
  return currentRoot;
}

export function isRust(rel: string): boolean {
  return rel.toLowerCase().endsWith(".rs");
}

/**
 * Cheap cold-start gate, the twin of `shouldLoadTsIntel`. A folder of notes
 * must not spawn a language server, and a Rust project is recognisable from
 * its top level entries alone.
 */
export function shouldStartRustLsp(rootEntryNames: readonly string[]): boolean {
  return (
    rootEntryNames.includes("Cargo.toml") ||
    rootEntryNames.includes("rust-toolchain.toml") ||
    rootEntryNames.includes("rust-toolchain")
  );
}

function log(line: string): void {
  transport?.log?.(`[rust-lsp] ${line}`);
}

function move(event: RustLspTransition, why?: string): void {
  const before = state;
  state = rustLspReduce(state, event);
  if (why !== undefined) reason = why;
  if (state !== before) log(`${before} -> ${state}${why ? `: ${why}` : ""}`);
}

// ---------------------------------------------------------------- badge copy

/**
 * What the badge should say, as an i18n key plus an English fallback and the
 * text to interpolate. Returned rather than rendered: this module owns no DOM
 * and the Code view owns the badge.
 *
 * Two different truths get conflated if this is skipped. "No server in this
 * build" is permanent and means reinstall; "no cargo on this Mac" means the
 * standard library resolves and the project's dependencies do not, which is a
 * genuinely useful half-working state.
 */
export function rustTierNote(): { key: string; fallback: string; detail: string } | null {
  switch (state) {
    case "off":
      return null;
    case "starting":
      return {
        key: "rustlsp.starting",
        fallback: "Starting the Rust language server",
        detail: "",
      };
    case "indexing":
      return {
        key: "rustlsp.indexing",
        fallback: "Indexing the crate graph: answers are incomplete until this finishes",
        detail: reason,
      };
    case "failed":
      return { key: "rustlsp.failed", fallback: "Rust intelligence is off: %s", detail: reason };
    case "ready":
      return statusInfo?.note
        ? { key: "rustlsp.partial", fallback: "Rust intelligence is limited: %s", detail: statusInfo.note }
        : null;
  }
}

// ---------------------------------------------------------------- lifecycle

/**
 * Bring the server up for one workspace.
 *
 * Resolves with the state either way: "failed" is a normal outcome, not an
 * exception. Callers keep the Syntax tier and say so, which is what the app
 * did before this module existed.
 */
export async function enableRustLsp(root: string): Promise<RustLspState> {
  if (!transport) throw new Error("configureRustLsp has not been called");
  // A boot already in flight for this root is JOINED, never duplicated.
  if (currentRoot === root && starting) return starting;
  // A live session for this root needs nothing done.
  //
  // The first version memoised `starting` and never cleared it, which is not
  // the same thing at all: after the server crashed, this returned a stale
  // "ready" while rustLspState() said "failed", the caller repainted a tier A
  // badge for a process that did not exist, transport.start was never called
  // again, and only a workspace switch and back could recover. The distinction
  // between "already running" and "was running once" is the whole fix.
  if (currentRoot === root && (state === "ready" || state === "indexing")) return state;
  await disableRustLsp();
  const gen = ++generation;
  currentRoot = root;
  move("start");
  const attempt = boot(root, gen).catch((e: unknown) => {
    if (gen !== generation) return state;
    // The subscription is taken before the spawn, so a spawn that throws
    // leaves a listener pointed at a session that will never exist.
    unlisten?.();
    unlisten = null;
    move("fail", e instanceof Error ? e.message : String(e));
    return state;
  });
  starting = attempt;
  void attempt.then(
    () => {
      if (starting === attempt) starting = null;
    },
    () => {
      if (starting === attempt) starting = null;
    }
  );
  return attempt;
}

async function boot(root: string, gen: number): Promise<RustLspState> {
  const t = transport!;
  // Subscribe BEFORE starting: rust-analyzer publishes its first progress
  // notification during initialize, and a listener attached afterwards misses
  // the begin and then waits forever for its end.
  const off = await t.listen(onEvent);
  // Superseded while we were subscribing. Drop OUR subscription and touch
  // nothing else: whoever replaced us owns the module state now.
  if (gen !== generation) {
    off();
    return state;
  }
  unlisten = off;
  const info = await t.start(root);
  if (gen !== generation) return state;
  statusInfo = info;
  if (!info.running) {
    move("fail", "the Rust language server did not start");
    return state;
  }
  move("initialized", info.note ?? "");
  // A $/progress begin that arrived BEFORE the initialize response was
  // absorbed by the reducer, which is right (a starting session must not be
  // promoted by progress) but left the counter poisoned: `tokens` was no
  // longer empty, so every later begin saw wasIdle === false and `indexing`
  // was never entered again. The badge then claimed tier A for the whole cold
  // index, which on a large workspace is minutes of hovers answering null and
  // a gutter cleared of its markers. That ordering is the NORMAL one on a cold
  // workspace, so it gets its own transition here rather than a comment.
  if (tokens.size > 0) move("indexBegin", indexTitle);
  log(`ready: ${info.server ?? "unknown server"}, cargo=${info.cargo}`);
  // Anything the editor opened while the server was booting is replayed, or
  // the server would answer about files it has never seen.
  for (const [, doc] of open) {
    void t
      .notify("textDocument/didOpen", {
        textDocument: { uri: doc.uri, languageId: "rust", version: doc.version, text: doc.text },
      })
      .catch(() => {});
  }
  return state;
}

/** Stop the server and forget everything about it. Safe to call when off. */
export async function disableRustLsp(): Promise<void> {
  const t = transport;
  // Nothing was ever started: stopping would spawn a round trip to the backend
  // on every workspace open, including the ones that are not Rust at all.
  const wasRunning = state !== "off" || currentRoot !== null;
  // Anything still booting is now stale, whatever it eventually answers.
  generation++;
  unlisten?.();
  unlisten = null;
  starting = null;
  currentRoot = null;
  statusInfo = null;
  open.clear();
  // Every waiter resolves with what it had, so nothing is left hanging on a
  // publication that will never come.
  for (const [, slot] of published) {
    for (const w of slot.waiters) w(slot.items);
    slot.waiters.length = 0;
  }
  published.clear();
  tokens.clear();
  indexTitle = "";
  move("stop", "");
  if (t && wasRunning) await t.stop().catch(() => {});
}

/** Test hook, and the reset the Code view needs when a workspace closes. */
export function resetRustLspForTests(): void {
  transport = null;
  state = "off";
  statusInfo = null;
  reason = "";
  currentRoot = null;
  unlisten = null;
  starting = null;
  open.clear();
  published.clear();
  tokens.clear();
  indexTitle = "";
  generation++;
  refreshDiagnostics = () => {};
}

// ---------------------------------------------------------------- events

export function onEvent(event: RustLspEvent): void {
  switch (event.kind) {
    case "diagnostics": {
      const uri = event.params?.uri;
      if (!uri) return;
      const items = Array.isArray(event.params.diagnostics) ? event.params.diagnostics : [];
      const slot = published.get(uri) ?? { items: [], waiters: [] };
      slot.items = items;
      published.set(uri, slot);
      const waiters = slot.waiters.splice(0, slot.waiters.length);
      for (const w of waiters) w(items);
      // Nothing else asks the editor to lint again, and without that the
      // gutter never catches up. The editor debounces its lint by
      // LINT_DELAY_MS; by the time it runs, the edit that triggered it has
      // already bumped the document version through syncRustBuffer, so
      // rustDiagnosticSource takes the "unchanged buffer" branch and hands
      // back the PREVIOUS set. The user fixes the error, stops typing, and the
      // red squiggle on the corrected line stays until they type again. The
      // publication is the only event that knows the answer moved, so it is
      // the one that has to ask.
      for (const [rel, doc] of open) {
        if (doc.uri === uri) refreshDiagnostics(rel);
      }
      return;
    }
    case "progress": {
      // rust-analyzer reports every phase through $/progress, and it runs
      // SEVERAL AT ONCE: on this repo, Fetching, Building CrateGraph and Roots
      // Scanned all overlap. Reacting to each begin and end directly would
      // flip the badge back to ready the moment the first of three finished,
      // which is the same lie as not tracking progress at all. Only the
      // transitions of the outstanding set are forwarded to the reducer.
      const value = event.params?.value ?? {};
      const token = JSON.stringify(event.params?.token ?? null);
      if (value.kind === "begin") {
        const wasIdle = tokens.size === 0;
        tokens.add(token);
        if (wasIdle) indexTitle = value.title ?? "";
        if (wasIdle) move("indexBegin", indexTitle);
      } else if (value.kind === "end") {
        tokens.delete(token);
        if (tokens.size === 0) {
          indexTitle = "";
          move("indexEnd", "");
        }
      }
      return;
    }
    case "stopped":
      move("fail", event.reason || "the Rust language server stopped");
      return;
    case "log":
      if (event.params?.message) log(`server: ${event.params.message}`);
      return;
  }
}

// ---------------------------------------------------------------- documents

function uriFor(rel: string): string | null {
  if (!currentRoot) return null;
  const base = currentRoot.endsWith("/") ? currentRoot.slice(0, -1) : currentRoot;
  return pathToUri(`${base}/${rel}`);
}

/**
 * Tell the server what the buffer contains now.
 *
 * Full-text `didChange` rather than incremental ranges. Incremental sync is
 * the documented optimisation and it is the wrong trade here: it requires the
 * client and the server to agree on the document history exactly, and one
 * missed or reordered change desynchronises them silently, after which every
 * answer is subtly about the wrong text. A 4 MB file is the workspace's own
 * read limit, and sending it costs a memcpy on a local pipe.
 *
 * Cheap to call on every keystroke: unchanged text sends nothing.
 */
export function syncRustBuffer(rel: string, text: string): void {
  if (!transport || !isRust(rel)) return;
  // The LIFECYCLE, not just the existence of a transport object. Checking only
  // the transport meant that after the server died every keystroke went on
  // serialising the whole buffer across the Tauri IPC to a backend answering
  // "the Rust language server is not running", forever, swallowed by the
  // catch, with nothing on screen to say so. On the 4 MB file this module's
  // own comment cites as the workspace read limit, that is a 4 MB copy per
  // keystroke. `starting` still syncs: boot() replays `open` once the server
  // is up, so a file opened during the boot is not forgotten.
  if (state === "off" || state === "failed") return;
  const uri = uriFor(rel);
  if (!uri) return;
  const existing = open.get(rel);
  if (existing && existing.text === text) return;
  if (!existing) {
    const doc: OpenDoc = { uri, version: 1, text };
    open.set(rel, doc);
    void transport
      .notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "rust", version: 1, text },
      })
      .catch(() => {});
    return;
  }
  existing.version += 1;
  existing.text = text;
  void transport
    .notify("textDocument/didChange", {
      textDocument: { uri, version: existing.version },
      contentChanges: [{ text }],
    })
    .catch(() => {});
}

/** The buffer closed. The server drops its diagnostics for it, and so do we. */
export function closeRustBuffer(rel: string): void {
  const doc = open.get(rel);
  if (!doc) return;
  open.delete(rel);
  published.delete(doc.uri);
  void transport?.notify("textDocument/didClose", { textDocument: { uri: doc.uri } }).catch(() => {});
}

/** Diagnostics currently known for a file. Exported for the tests and for a
 *  caller that wants them without waiting. */
export function publishedFor(rel: string): LspDiagnostic[] {
  const doc = open.get(rel);
  if (!doc) return [];
  return published.get(doc.uri)?.items ?? [];
}

/**
 * Wait for the next publication about `uri`, or give up and return the last
 * one. The give-up path is the normal one on an unchanged buffer: the server
 * has no reason to republish, and a source that waited forever would hold the
 * whole lint run hostage.
 */
function waitForDiagnostics(uri: string, timeoutMs: number): Promise<LspDiagnostic[]> {
  const slot = published.get(uri) ?? { items: [], waiters: [] };
  published.set(uri, slot);
  return new Promise<LspDiagnostic[]>((resolve) => {
    let settled = false;
    const finish = (items: LspDiagnostic[]) => {
      if (settled) return;
      settled = true;
      resolve(items);
    };
    slot.waiters.push(finish);
    const timer = setTimeout(() => {
      const at = slot.waiters.indexOf(finish);
      if (at >= 0) slot.waiters.splice(at, 1);
      finish(slot.items);
    }, timeoutMs);
    // Node keeps the process alive for a pending timer; the tests would hang
    // on it after the last assertion.
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

// ---------------------------------------------------------------- diagnostics

export function severityOf(d: LspDiagnostic): Diagnostic["severity"] {
  switch (d.severity) {
    case 2:
      return "warning";
    case 3:
      return "info";
    case 4:
      return "hint";
    default:
      // Absent severity means error, per the specification. Guessing "info"
      // here would hide the only diagnostics that matter.
      return "error";
  }
}

/** `unresolved-import` reads better than `rust(3)`, and rust-analyzer always
 *  sends a code for its own diagnostics. */
export function sourceLabel(d: LspDiagnostic): string {
  const code = d.code !== undefined && d.code !== null ? String(d.code) : "";
  return code ? `${RUST_LSP_SOURCE}(${code})` : RUST_LSP_SOURCE;
}

/** Map one published set onto the buffer the editor is showing right now. */
export function toEditorDiagnostics(doc: TextDocLike, items: readonly LspDiagnostic[]): Diagnostic[] {
  return items.map((d) => {
    const { from, to } = lspRangeToOffsets(doc, d.range);
    return { from, to, severity: severityOf(d), source: sourceLabel(d), message: d.message };
  });
}

/**
 * A source in the shape `registerDiagnosticSource` expects. Registered by the
 * integrator so Rust errors sit alongside the grammar pass rather than
 * replacing it.
 *
 * Returns nothing at all unless the server is ready. During indexing the
 * server publishes an EMPTY set for files it has not analysed yet, and
 * forwarding that would clear real markers and put them back a second later,
 * which is the flicker that makes people turn a linter off.
 */
export function rustDiagnosticSource(): (
  state: EditorStateLike,
  rel: string
) => Promise<Diagnostic[]> {
  return async (editorState: EditorStateLike, rel: string): Promise<Diagnostic[]> => {
    if (!isRust(rel) || !rustReady()) return [];
    const text = editorState.doc.toString();
    const before = open.get(rel)?.version ?? 0;
    syncRustBuffer(rel, text);
    const doc = open.get(rel);
    if (!doc) return [];
    // Unchanged buffer: whatever the server last said is still true, so do not
    // sit through the timeout for it.
    const items =
      doc.version === before
        ? (published.get(doc.uri)?.items ?? [])
        : await waitForDiagnostics(doc.uri, DIAGNOSTIC_WAIT_MS);
    return toEditorDiagnostics(editorState.doc, items);
  };
}

// ---------------------------------------------------------------- requests

async function ask<T>(method: string, params: unknown): Promise<T | null> {
  if (!transport || !rustReady()) return null;
  try {
    return (await transport.request(method, params, INTERACTIVE_TIMEOUT_MS)) as T;
  } catch (e: unknown) {
    log(`${method} failed: ${String((e as { message?: string })?.message ?? e)}`);
    return null;
  }
}

/**
 * The `{textDocument, position}` every positional request needs, and the
 * synchronisation that makes it meaningful.
 *
 * Syncing here rather than trusting the caller is deliberate. A hover asked
 * about a buffer the server was never told about is answered from the file ON
 * DISK, which is right until the first unsaved keystroke and then quietly
 * wrong forever. `syncRustBuffer` costs nothing when the text has not changed,
 * so paying it on every request is cheaper than the class of bug it removes.
 */
function docParams(rel: string, doc: TextDocLike, pos: number): Record<string, unknown> | null {
  syncRustBuffer(rel, doc.toString());
  const uri = open.get(rel)?.uri ?? uriFor(rel);
  if (!uri) return null;
  return { textDocument: { uri }, position: posToLsp(doc, pos) };
}

// ---------------------------------------------------------------- hover

function tr(deps: RustLspDeps, key: string, fallback: string): string {
  return deps.t ? deps.t(key, fallback) : fallback;
}

function esc(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!
  );
}

/**
 * rust-analyzer answers hover as markdown: fenced signature blocks, then prose,
 * then a horizontal rule and the doc comment. The editor's tooltip is a plain
 * box, so this splits it into the signature and the rest instead of rendering
 * markdown, which would mean shipping a markdown renderer into the Code view
 * for one tooltip.
 */
export function splitHoverMarkdown(markdown: string): { signature: string; docs: string } {
  const fences = [...markdown.matchAll(/```(?:rust)?\n([\s\S]*?)```/g)].map((m) => m[1].trim());
  const signature = fences.join("\n").trim();
  const rest = markdown
    .replace(/```(?:rust)?\n[\s\S]*?```/g, "")
    .replace(/^\s*-{3,}\s*$/gm, "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .join("\n")
    .trim();
  return { signature, docs: rest };
}

function hoverValue(result: unknown): string {
  const contents = (result as { contents?: unknown })?.contents;
  if (typeof contents === "string") return contents;
  if (contents && typeof contents === "object" && "value" in contents) {
    return String((contents as { value: unknown }).value ?? "");
  }
  return "";
}

/** `textDocument/hover`, as a CodeMirror tooltip. */
export function rustHover(deps: RustLspDeps): Extension {
  return hoverTooltip(async (view, pos): Promise<Tooltip | null> => {
    const rel = deps.file();
    if (!rel || !isRust(rel) || !rustReady()) return null;
    const params = docParams(rel, view.state.doc, pos);
    if (!params) return null;
    const result = await ask<unknown>("textDocument/hover", params);
    if (!result) return null;
    const { signature, docs } = splitHoverMarkdown(hoverValue(result));
    if (!signature && !docs) return null;
    const range = (result as { range?: LspRange }).range;
    const span = range ? lspRangeToOffsets(view.state.doc, range) : { from: pos, to: pos };
    return {
      pos: span.from,
      end: span.to,
      above: true,
      create: () => {
        const dom = document.createElement("div");
        // Same class as the TypeScript tooltip: one tooltip style, not two.
        dom.className = "ts-hover";
        dom.innerHTML =
          (signature ? `<div class="sig mono">${esc(signature)}</div>` : "") +
          (docs ? `<div class="doc">${esc(docs)}</div>` : "");
        return { dom };
      },
    };
  });
}

// ---------------------------------------------------------------- completion

/** LSP CompletionItemKind, mapped onto the icons CodeMirror draws. */
export function completionType(kind: number | undefined): string {
  switch (kind) {
    case 2: // Method
    case 3: // Function
    case 4: // Constructor
      return "function";
    case 5: // Field
    case 10: // Property
      return "property";
    case 6: // Variable
      return "variable";
    case 7: // Class
    case 22: // Struct
      return "class";
    case 8: // Interface
      return "interface";
    case 9: // Module
      return "namespace";
    case 13: // Enum
    case 20: // EnumMember
      return "enum";
    case 14: // Keyword
      return "keyword";
    case 21: // Constant
      return "constant";
    case 25: // TypeParameter
      return "type";
    default:
      return "text";
  }
}

interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  textEdit?: { range?: LspRange; newText?: string };
}

/** The items, whether the server answered a list or a bare array. */
export function completionItems(result: unknown): LspCompletionItem[] {
  if (Array.isArray(result)) return result as LspCompletionItem[];
  const items = (result as { items?: unknown })?.items;
  return Array.isArray(items) ? (items as LspCompletionItem[]) : [];
}

export function rustCompletionSource(deps: RustLspDeps): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const rel = deps.file();
    if (!rel || !isRust(rel) || !rustReady()) return null;
    const word = context.matchBefore(/[\w]*/);
    // After `.` or `::` there is no word to match, and refusing there would
    // kill the two completions people actually wait for in Rust.
    const trigger = context.matchBefore(/(\.|::)\s*$/);
    if (!trigger && (!word || (word.from === word.to && !context.explicit))) return null;
    const params = docParams(rel, context.state.doc, context.pos);
    if (!params) return null;
    const result = await ask<unknown>("textDocument/completion", params);
    const items = completionItems(result);
    if (!items.length) return null;
    const options: Completion[] = items.map((item) => ({
      label: item.label,
      apply: item.textEdit?.newText ?? item.insertText ?? item.label,
      type: completionType(item.kind),
      detail: item.detail,
      // rust-analyzer has already ranked these; `sortText` carries the ranking
      // and CodeMirror would otherwise re-sort them alphabetically, which puts
      // `abs` above the field you were typing.
      boost: item.sortText && item.sortText < "ff" ? 1 : 0,
    }));
    return { from: word ? word.from : context.pos, options, validFor: /^[\w]*$/ };
  };
}

/**
 * Add the source to the Rust grammar WITHOUT replacing what it already offers.
 * See the note at the top of this file: `autocompletion({override})` is the
 * mistake that turns "rust-analyzer completions" into "rust-analyzer
 * completions and nothing else", including nothing at all when the server is
 * down.
 */
export function rustCompletion(language: Language, deps: RustLspDeps): Extension {
  return language.data.of({ autocomplete: rustCompletionSource(deps) });
}

// ---------------------------------------------------------------- navigation

/** `Location`, `Location[]` and `LocationLink[]` all mean the same thing. */
export function locations(result: unknown): Array<{ uri: string; range: LspRange }> {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  const out: Array<{ uri: string; range: LspRange }> = [];
  for (const entry of list) {
    const e = entry as {
      uri?: string;
      range?: LspRange;
      targetUri?: string;
      targetSelectionRange?: LspRange;
      targetRange?: LspRange;
    };
    const uri = e.uri ?? e.targetUri;
    const range = e.range ?? e.targetSelectionRange ?? e.targetRange;
    if (uri && range) out.push({ uri, range });
  }
  return out;
}

/**
 * Go to definition. Returns false when there is nowhere in the WORKSPACE to
 * go, so a keymap entry can fall through.
 *
 * A definition inside the bundled standard library sources is a real answer
 * and still returns false: those files live in the app bundle, the file tree
 * cannot show them, and opening a read-only path from inside a .app is a worse
 * experience than doing nothing. Said out loud here rather than looking like
 * a bug.
 */
export async function gotoRustDefinition(deps: RustLspDeps, doc: TextDocLike, pos: number): Promise<boolean> {
  const rel = deps.file();
  if (!rel || !isRust(rel) || !rustReady() || !currentRoot) return false;
  const params = docParams(rel, doc, pos);
  if (!params) return false;
  const result = await ask<unknown>("textDocument/definition", params);
  for (const loc of locations(result)) {
    const target = uriToRel(currentRoot, loc.uri);
    if (target === null) continue;
    deps.openFile(target, loc.range.start.line + 1, loc.range.start.character);
    return true;
  }
  return false;
}

/** Find references and hand the rendered list to the view. */
export async function findRustReferences(
  deps: RustLspDeps,
  doc: TextDocLike,
  pos: number
): Promise<RustRefHit[]> {
  const rel = deps.file();
  if (!rel || !isRust(rel) || !rustReady() || !currentRoot) return [];
  const params = docParams(rel, doc, pos);
  if (!params) return [];
  const result = await ask<unknown>("textDocument/references", {
    ...params,
    context: { includeDeclaration: true },
  });
  const hits: RustRefHit[] = [];
  for (const loc of locations(result)) {
    const target = uriToRel(currentRoot, loc.uri);
    if (target === null) continue;
    // Only the open document can be quoted: the others are on disk and this
    // module does not read files. The Code view fills the text in if it wants.
    const sameDoc = target === rel;
    hits.push({
      rel: target,
      line: loc.range.start.line + 1,
      col: loc.range.start.character,
      start: sameDoc ? lspToPos(doc, loc.range.start) : 0,
      text: sameDoc ? doc.line(Math.min(loc.range.start.line + 1, doc.lines)).text : "",
    });
  }
  deps.showReferences?.(rustReferencesHtml(hits, deps), hits);
  return hits;
}

/**
 * The references list, as pure HTML. Identical markup to the TypeScript one so
 * the existing stylesheet and the existing click handler both work unchanged.
 */
export function rustReferencesHtml(hits: readonly RustRefHit[], deps?: RustLspDeps): string {
  const label = (k: string, f: string) => (deps ? tr(deps, k, f) : f);
  if (!hits.length) {
    return `<div class="ts-refs empty">${esc(label("tsintel.noRefs", "no references"))}</div>`;
  }
  const byFile = new Map<string, RustRefHit[]>();
  for (const h of hits) {
    const list = byFile.get(h.rel);
    if (list) list.push(h);
    else byFile.set(h.rel, [h]);
  }
  let out = `<div class="ts-refs"><div class="rh">${esc(
    label("tsintel.refCount", "%n references in %f files")
      .replace("%n", String(hits.length))
      .replace("%f", String(byFile.size))
  )}</div>`;
  for (const rel of [...byFile.keys()].sort()) {
    const rows = byFile.get(rel)!.slice().sort((a, b) => a.line - b.line || a.col - b.col);
    out += `<div class="rf"><div class="fn mono">${esc(rel)}</div>`;
    for (const h of rows) {
      out +=
        `<div class="rr" data-ref-file="${esc(h.rel)}" data-ref-line="${h.line}" ` +
        `data-ref-col="${h.col}">` +
        `<span class="ln">${h.line}</span><span class="tx mono">${esc(h.text.trim())}</span></div>`;
    }
    out += `</div>`;
  }
  return out + `</div>`;
}

/** F12 for definition, Shift-F12 for references, Cmd-click for definition. */
export function rustNavigation(deps: RustLspDeps): Extension {
  return [
    keymap.of([
      {
        key: "F12",
        run: (view) => {
          void gotoRustDefinition(deps, view.state.doc, view.state.selection.main.head);
          return true;
        },
      },
      {
        key: "Shift-F12",
        run: (view) => {
          void findRustReferences(deps, view.state.doc, view.state.selection.main.head);
          return true;
        },
      },
    ]),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (!event.metaKey || event.button !== 0) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        event.preventDefault();
        void gotoRustDefinition(deps, view.state.doc, pos);
        return true;
      },
    }),
  ];
}

// ---------------------------------------------------------------- rename

interface WorkspaceEdit {
  changes?: Record<string, Array<{ range: LspRange; newText: string }>>;
  documentChanges?: Array<{
    textDocument?: { uri?: string };
    edits?: Array<{ range: LspRange; newText: string }>;
  }>;
}

/**
 * Both shapes of WorkspaceEdit, flattened to ONE entry per file.
 *
 * Per file and not per entry, and that is a correctness fix. A server may
 * legitimately send two `documentChanges` entries for the same URI, and both
 * shapes may arrive in the same answer. planRustRename applies each entry to
 * the ORIGINAL text, so two entries for one file produced two conflicting
 * whole-file proposals, each silently dropping the other's edits: the user was
 * shown two diffs for one file and whichever they accepted last reverted half
 * the rename. Merging them into one edit list instead means applyEdits sees
 * every span at once, so its back-to-front application and its overlap refusal
 * do the job they were written for.
 */
export function workspaceEditFiles(
  edit: WorkspaceEdit
): Array<{ uri: string; edits: Array<{ range: LspRange; newText: string }> }> {
  const byUri = new Map<string, Array<{ range: LspRange; newText: string }>>();
  const push = (uri: string, edits: Array<{ range: LspRange; newText: string }>): void => {
    const slot = byUri.get(uri);
    if (slot) slot.push(...edits);
    else byUri.set(uri, [...edits]);
  };
  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) push(uri, edits);
  }
  for (const change of edit.documentChanges ?? []) {
    const uri = change.textDocument?.uri;
    // A documentChanges entry can also be a create/rename/delete operation,
    // which has no textDocument. Those are refused by planRustRename below;
    // dropping them silently here would produce a plan that looks complete.
    if (uri && change.edits) push(uri, change.edits);
  }
  return [...byUri].map(([uri, edits]) => ({ uri, edits }));
}

/**
 * Apply one file's edits to its text.
 *
 * Back to front, so an earlier edit's change in length cannot move a later
 * one, and refusing on overlap: an overlapping plan is not a plan, and writing
 * a subtly wrong file is worse than refusing a rename.
 */
export function applyEdits(
  doc: TextDocLike,
  text: string,
  edits: ReadonlyArray<{ range: LspRange; newText: string }>
): string {
  const spans = edits
    .map((e) => ({ ...lspRangeToOffsetsExact(doc, e.range), newText: e.newText }))
    .sort((a, b) => b.from - a.from);
  let out = text;
  let last = Number.POSITIVE_INFINITY;
  for (const s of spans) {
    if (s.to > last) throw new Error("the rename produced overlapping edits");
    last = s.from;
    out = out.slice(0, s.from) + s.newText + out.slice(s.to);
  }
  return out;
}

/** Like `lspRangeToOffsets` but WITHOUT the one-character minimum: an edit
 *  range is allowed to be empty, and widening it would delete a character. */
function lspRangeToOffsetsExact(doc: TextDocLike, range: LspRange): { from: number; to: number } {
  const from = lspToPos(doc, range.start);
  const to = Math.max(from, lspToPos(doc, range.end));
  return { from, to };
}

/**
 * Plan a rename. Nothing is written: the caller hands these to
 * `fileProposal(...)` and the user accepts them hunk by hunk, exactly like a
 * model edit. That rule is the reason the Code view exists in this shape, and
 * a language server is not an exception to it.
 *
 * `makeDoc` turns a file's text into something positions can be resolved
 * against, because the ranges the server returns are line and character and
 * the other files are not open in the editor.
 */
export async function planRustRename(
  rel: string,
  doc: TextDocLike,
  pos: number,
  newName: string,
  readFile: (rel: string) => Promise<string | undefined>,
  makeDoc: (text: string) => TextDocLike
): Promise<RustRenameEdit[]> {
  if (!newName.trim()) throw new Error("a rename needs a new name");
  if (!transport || !rustReady() || !currentRoot) {
    throw new Error("rename needs the Rust language server");
  }
  // Same reason as docParams: a rename planned against the file on disk and
  // applied to the buffer in memory produces a diff nobody can explain.
  syncRustBuffer(rel, doc.toString());
  const uri = open.get(rel)?.uri ?? uriFor(rel);
  if (!uri) throw new Error("this file is not in the workspace");
  const result = (await transport.request(
    "textDocument/rename",
    { textDocument: { uri }, position: posToLsp(doc, pos), newName },
    INTERACTIVE_TIMEOUT_MS
  )) as WorkspaceEdit | null;
  if (!result) throw new Error("this cannot be renamed");
  const files = workspaceEditFiles(result);
  // A rename that also creates or deletes files is beyond what a plan of full
  // file contents can express. Refuse rather than apply half of it.
  const operations = (result.documentChanges ?? []).filter((c) => !c.textDocument);
  if (operations.length) throw new Error("this rename would create or delete files");
  if (!files.length) return [];

  const out: RustRenameEdit[] = [];
  for (const file of files.sort((a, b) => a.uri.localeCompare(b.uri))) {
    const target = uriToRel(currentRoot, file.uri);
    if (target === null) {
      throw new Error("this rename touches a file outside the workspace");
    }
    const before = open.get(target)?.text ?? (await readFile(target));
    if (before === undefined) throw new Error(`rename touches ${target}, which cannot be read`);
    const content = applyEdits(makeDoc(before), before, file.edits);
    if (content !== before) out.push({ rel: target, content });
  }
  return out;
}

// ---------------------------------------------------------------- assembly

/**
 * Everything at once, for the Rust grammar the Code view already built. Safe
 * to install while the server is off: every binding re-checks and contributes
 * nothing, so the extension set does not have to be rebuilt when the state
 * changes.
 */
export function rustIntelExtensions(support: LanguageSupport, deps: RustLspDeps): Extension[] {
  return [rustCompletion(support.language, deps), rustHover(deps), rustNavigation(deps)];
}

/**
 * Wire the Rust tier into the app. The diagnostic registry is owned by another
 * module, so it arrives as a callback: one call in the integrator's setup and
 * no import cycle, the same shape `registerPyLang` uses.
 */
export function registerRustLsp(reg: {
  registerDiagnostics(id: string, source: (state: EditorStateLike, rel: string) => Promise<Diagnostic[]>): void;
  /**
   * Ask the editor to lint `rel` again, because the server just published a
   * new set for it. Optional only so a test can leave it out; the app must
   * supply it, or the gutter never catches up after the last keystroke.
   */
  refresh?(rel: string): void;
}): void {
  reg.registerDiagnostics(RUST_LSP_SOURCE, rustDiagnosticSource());
  if (reg.refresh) refreshDiagnostics = reg.refresh;
}
