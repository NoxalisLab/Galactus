// Galactus, the Code view.
//
// A folder, opened as a workspace: the file tree on the left, an editor in the
// middle, the SAME agent thread as the Chat view on the right. Version control
// lives in the left column, next to the tree, because it is about the same
// files.
//
// The one rule the whole view is built around: a change the model makes is a
// PROPOSAL. It arrives as a pending diff in the editor, hunk by hunk, and the
// disk only ever receives what the user accepted. That guarantee is enforced
// here, in one place: `writeAccepted()` is the only function in this module
// that writes an edited file, and it writes the merge view's ORIGINAL document
// (the base plus the accepted hunks), never the editor's buffer, which still
// holds whatever the user has not answered yet.
//
// Every open file is a Doc (code/docs.ts): its own EditorState, its own saved
// content, its own merge base, its own write chain. Switching tabs is a
// `view.setState`, never a rebuild, so the cursor, the scroll, the selection,
// the undo history and the folds survive.

import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as tg } from "@lezer/highlight";
import { getChunks, getOriginalDoc, unifiedMergeView } from "@codemirror/merge";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";

import { api, onEvent, CodeEntry, GitChange, GitCommitInfo, GitInfo } from "./api";
import type { PermissionRequest } from "./agent";
import { isElevatedCommand } from "./agent";
import { t, getLang } from "./i18n";

import { Docs, type Doc } from "./code/docs";
import { editorExtensions, intelComp } from "./code/extensions";
import { tabsHtml, onTabsClick } from "./code/tabs";
import { cmPhrases } from "./code/phrases";
import { classifyRootError, resolveRestoredRoot } from "./code/restored-root";
import { affectsPreview, chooseEntry, DEVICE_PRESETS, frameScale } from "./code/preview-pane";
import { ReviewGate, reviewInstruction } from "./code/review-gate";
import { autoTabExtension } from "./code/auto-tab";
import { inlineEditExtension } from "./code/inline-edit";
import { diagnosticsExtension, registerDiagnosticSource } from "./code/diagnostics";
import type { Diagnostic } from "./code/diagnostics";
import {
  activeOutlineIndex,
  outline,
  outlineHtml,
  outlineIsComplete,
  langIdFor,
  type OutlineItem,
} from "./code/outline";
import { registerTreeDiagnostics, setDiagTranslator } from "./code/treediag";
import { setTierTranslator, tierBadgeHtml, tierFor } from "./code/tiers";
import { forgetPython, isPython, pyDiagnostics, pyOutline } from "./code/pylang";
import {
  closeRustBuffer,
  configureRustLsp,
  disableRustLsp,
  enableRustLsp,
  isRust,
  planRustRename,
  registerRustLsp,
  rustIntelExtensions,
  rustReady,
  rustTierNote,
  shouldStartRustLsp,
  syncRustBuffer,
} from "./code/rust-lsp";
import { TerminalPanel } from "./code/terminal";
import type { PtyOutputEvent, TerminalHost } from "./code/terminal";
import {
  cancelSearch,
  makeSearchSink,
  newSearchState,
  onSearchPanelEvent,
  searchOpts,
  searchPanelHtml,
  searchResultsHtml,
  type SearchPanelDeps,
  type SearchPanelState,
} from "./code/searchpanel";
import { openFilePalette, openSymbolPalette, closePalette, paletteOpen } from "./code/palette";
import { planReplace, REPLACE_FILE_CAP, ReplaceCapError } from "./code/replace";
import type {
  SearchHit,
  SearchOpts as WsSearchOpts,
  SearchProgress,
  SymbolHit,
  WorkspaceApi,
} from "./code/workspace-api";
import type * as TsIntel from "./tsintel/client";
import type * as TsBindings from "./tsintel/bindings";
import { shouldLoadTsIntel } from "./tsintel/eligibility";
import { wirePaneResizer } from "./layout/pane-resize";
import { forceLinting } from "@codemirror/lint";

// ---------------------------------------------------------------- helpers

function el(h: string): HTMLElement {
  const d = document.createElement("div");
  d.innerHTML = h.trim();
  return d.firstElementChild as HTMLElement;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * Left-to-right mark. The path pills truncate at the START, which needs
 * `direction: rtl` on the box; a leading "/" is bidi-neutral and gets
 * reordered to the visual end there, so "/Volumes/x" rendered as "Volumes/x/".
 * One strong LTR character in front keeps the path one left-to-right run.
 */
const LRM = "\u200e";

// ---------------------------------------------------------------- deps

export interface CodeDeps {
  toast(msg: string, kind?: "err" | "ok"): void;
  /** Ask the user through the app's permission queue. True when approved. */
  ask(req: PermissionRequest): Promise<boolean>;
  /** Mount the shared agent thread pane (same Agent, same queue, same cards). */
  mountAgent(host: HTMLElement): void;
  /** Repaint the sidebar: the Code nav item carries the pending count. */
  paintNav(): void;
  /** Persist a setting (the workspace path comes back at launch). */
  saveSetting(key: string, value: string): Promise<void>;
  /** Whether the local model is ready and Auto Tab is enabled. */
  autoTabReady(): boolean;
  /** Request one local, insertion-only completion around the caret. */
  inlineComplete(rel: string, prefix: string, suffix: string, signal: AbortSignal): Promise<string | null>;
  /**
   * The local model can answer right now. Deliberately NOT the Auto Tab flag:
   * Cmd+K is an explicit gesture, and switching ghost text off is not a
   * request to lose the editor's only way to ask for a rewrite.
   */
  inlineEditReady(): boolean;
  /**
   * One inline edit (Cmd+K): a whole prompt in, the model's raw answer out.
   * Raw on purpose. code/inline-edit.ts knows what the region was and is the
   * only place that can tell a usable answer from a chatty one.
   */
  inlineEdit(prompt: string, signal: AbortSignal): Promise<string | null>;
}

let deps: CodeDeps | null = null;

export function setCodeDeps(d: CodeDeps): void {
  deps = d;
}

// ---------------------------------------------------------------- state

/** A change the model wants to make, waiting for the user to answer it. */
export interface Proposal {
  /** Path relative to the workspace root. */
  rel: string;
  /** Full proposed content of the file. */
  after: string;
  /** Content on disk when the model proposed, for the "stale" notice. */
  before: string;
  created: number;
}

type LeftTab = "files" | "search" | "outline" | "changes" | "history" | "branches";

const EXPLORER_TABS: LeftTab[] = ["files", "search", "outline"];
const GIT_TABS: LeftTab[] = ["changes", "history", "branches"];

let root: string | null = null;

const proposals = new Map<string, Proposal>();
const reviewGate = new ReviewGate();
const expanded = new Set<string>();
const treeCache = new Map<string, CodeEntry[]>();

let leftTab: LeftTab = "files";
/**
 * Tri-state on purpose. `undefined` means "the probe has not answered yet",
 * which is a different screen from "this is not a repository": the panel used
 * to flash the no-repo hint on every launch inside a real repository.
 */
let git: GitInfo | null | undefined = undefined;
let changes: GitChange[] = [];
let commits: GitCommitInfo[] = [];
let branches: string[] = [];
/** History filtered to one path, null for the whole repository. */
let historyPath: string | null = null;
let commitMessage = "";

/** What the middle column shows. */
let mid: "editor" | "patch" | "refs" = "editor";
let patch: { title: string; sub: string; body: string } | null = null;
let refsHtml = "";

let editor: EditorView | null = null;
const mergeComp = new Compartment();

/** Files opened recently, most recent first. Feeds the palette's ranking. */
const recentPaths: string[] = [];

/**
 * The Rust side enumerates the workspace once and caches it; there is no
 * filesystem watcher, by design (a watcher is a crate). So the two moments the
 * app KNOWS a path appeared or vanished are recorded here, and the next
 * consumer pays for one re-enumeration instead of every consumer paying for
 * one on every call. Without this, a file the model just created stays
 * invisible to search and to the palette.
 */
let indexStale = false;
/** Proposals that would CREATE a file, so accepting one marks the index. */
const creations = new Set<string>();

async function freshIndex(): Promise<void> {
  if (!indexStale || !root) return;
  indexStale = false;
  await api.searchFiles(root, true).catch(() => []);
  await api.symbolsIndex(root, true).catch(() => 0);
}

/** Outline of the active document, recomputed on a throttle. */
let outlineItems: OutlineItem[] = [];
let outlineExact = false;
/** The 50 ms parse budget ran out: the list on screen is not the whole file. */
let outlinePartial = false;
let outlineTimer: ReturnType<typeof setTimeout> | null = null;

/** The project search panel, and its subscription to `galactus://search`. */
const searchState = newSearchState();
let offSearch: (() => void) | null = null;

/** The TypeScript service, imported only when a workspace holds JS or TS. */
let tsintel: typeof TsIntel | null = null;
let tsbind: typeof TsBindings | null = null;
let tsLoading: Promise<void> | null = null;

// ---------------------------------------------------------------- syntax colours

/**
 * One palette for the whole product. one-dark's structural theme is kept (the
 * editor chrome it styles is real work) but its highlight half is overridden:
 * a keyword in the chat's markdown renderer and a keyword in the editor were
 * two different violets, and the editor's was a pink that appears nowhere else
 * in Galactus. The five hexes are the same ones styles.css uses for `.md .cb`.
 */
const galactusHighlight = HighlightStyle.define([
  { tag: tg.keyword, color: "#b06cff" },
  { tag: [tg.controlKeyword, tg.moduleKeyword, tg.operatorKeyword], color: "#b06cff" },
  { tag: [tg.string, tg.special(tg.string), tg.regexp], color: "#7fd6a4" },
  { tag: [tg.comment, tg.lineComment, tg.blockComment, tg.docComment], color: "#5c5c6a", fontStyle: "italic" },
  { tag: [tg.number, tg.bool, tg.null, tg.atom], color: "#e0a86a" },
  { tag: [tg.function(tg.variableName), tg.function(tg.propertyName)], color: "#8ab4ff" },
  { tag: [tg.typeName, tg.className, tg.namespace, tg.tagName], color: "#c0b4ff" },
  { tag: [tg.propertyName, tg.attributeName], color: "#c4c4d2" },
  { tag: [tg.variableName, tg.definition(tg.variableName)], color: "#e9e9ef" },
  { tag: [tg.operator, tg.punctuation, tg.separator, tg.bracket], color: "#8b8b99" },
  { tag: tg.meta, color: "#8b8b99" },
  { tag: tg.invalid, color: "#d16b6b" },
  { tag: tg.link, color: "#8ab4ff", textDecoration: "underline" },
  { tag: [tg.heading], color: "#cfc8ff", fontWeight: "600" },
  { tag: tg.emphasis, fontStyle: "italic" },
  { tag: tg.strong, fontWeight: "600" },
]);

// ---------------------------------------------------------------- documents

function langFor(path: string): Extension[] {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return [javascript({ jsx: ext === "jsx" })];
    case "ts":
    case "mts":
    case "cts":
      return [javascript({ typescript: true })];
    case "tsx":
      return [javascript({ typescript: true, jsx: true })];
    case "py":
      return [python()];
    case "rs":
      return [rust()];
    case "json":
      return [json()];
    case "md":
    case "markdown":
      return [markdown()];
    case "html":
    case "htm":
    case "svg":
      return [html()];
    case "css":
      return [css()];
    default:
      // Everything else still gets line numbers, search and undo; only the
      // grammar is missing, which is a plain editor, not a broken one.
      return [];
  }
}

/**
 * The single place an EditorState is built. Every state in this view comes
 * through here, which is what makes `docs.byView()` exact: a state built
 * anywhere else would carry no `docRel` facet and its edits would be dropped.
 */
const docs: Docs = new Docs((rel, text, extra): EditorState =>
  EditorState.create({
    doc: text,
    extensions: [
      editorExtensions({
        onSave: () => void saveOpenFile(),
        phrases: cmPhrases(getLang()),
        language: langFor(rel),
        diagnostics: [diagnosticsExtension(() => docs.activeRel())],
      }),
      oneDark,
      syntaxHighlighting(galactusHighlight),
      autoTabExtension({
        file: () => docs.activeRel(),
        enabled: () => deps?.autoTabReady() ?? false,
        reviewing: () => docs.active()?.mergeBase !== null,
        complete: (file, prefix, suffix, signal) =>
          deps?.inlineComplete(file, prefix, suffix, signal) ?? Promise.resolve(null),
      }),
      // Cmd+K at the cursor. It never writes: the rewritten document goes
      // through fileProposal like any model edit, so it lands as a pending
      // diff reviewed hunk by hunk in the same merge view. `rel` and not
      // docs.activeRel(), because the region belongs to THIS document's state
      // and the box may outlive a tab switch by a few milliseconds.
      inlineEditExtension({
        file: () => rel,
        enabled: () => deps?.inlineEditReady() ?? false,
        reviewing: () => docs.active()?.mergeBase !== null,
        ask: (request, signal) =>
          deps?.inlineEdit(request.prompt, signal) ?? Promise.resolve(null),
        propose: async (target, next) => {
          if (root) await fileProposal(root + "/" + target, target, next);
        },
        t,
      }),
      mergeComp.of([]),
      EditorView.updateListener.of(onEditorUpdate),
      extra,
    ],
  })
);

export function codeRoot(): string | null {
  return root;
}

export function pendingCount(): number {
  return proposals.size;
}

/** Restore the workspace chosen in a previous session. */
export async function initCodeRoot(saved: string | undefined): Promise<void> {
  const outcome = await resolveRestoredRoot(saved, async (candidate) => {
    try {
      await api.codeTree(candidate, "");
      return "usable" as const;
    } catch (e: any) {
      return classifyRootError(String(e?.message ?? e));
    }
  });
  if (outcome.forget) {
    // A temporary demo folder or disconnected volume must never hold the
    // entire application on its splash screen. Forget only the workspace
    // pointer; no project data is touched.
    if (saved?.trim()) await deps?.saveSetting("code_root", "").catch(() => {});
    return;
  }
  if (outcome.unreadable) {
    // The folder is there and macOS is holding it back, most often the Desktop
    // or Documents before the app has been granted them. Say so and KEEP the
    // pointer: a permission is granted once and the workspace should be waiting
    // on the other side of it, not deleted for having been unreachable once.
    deps?.toast(t("code.rootUnreadable"));
    return;
  }
  if (!outcome.root) return;
  root = outcome.root;
  await refreshGit().catch(() => {});
  await loadDir("");
  await startWorkspaceServices();
}


// ---------------------------------------------------------------- preview

/**
 * The preview pane's state, kept at module level for the same reason the
 * terminal's is: render() in main.ts rebuilds this whole view on every
 * navigation, and an iframe rebuilt with it would lose the scroll position and
 * the running state of the page it shows. The element is re-parented instead.
 */
let prevOpen = false;
let prevHost: HTMLElement | null = null;
let prevFrame: HTMLIFrameElement | null = null;
let prevEntry: string | null = null;
let prevDevice = DEVICE_PRESETS[0];
let prevGen = 0;
let prevTimer: ReturnType<typeof setTimeout> | null = null;

function togglePreview(wrap: HTMLElement): void {
  prevOpen = !prevOpen;
  mountPreview(wrap);
}

/** The workspace changed: the page previewed a moment ago no longer exists. */
function disposePreview(): void {
  prevOpen = false;
  prevHost = null;
  prevFrame = null;
  prevEntry = null;
  if (prevTimer) { clearTimeout(prevTimer); prevTimer = null; }
  void api.previewSetRoot(null).catch(() => undefined);
}

/**
 * Put the preview into THIS instance of the Code view.
 *
 * Mirror of mountTerminal, including the part that matters: the host element is
 * built once and moved, never rebuilt, so the page inside keeps its scroll and
 * its state across every repaint of the editor beside it.
 */
function mountPreview(wrap: HTMLElement): void {
  const box = wrap.querySelector<HTMLElement>("#codeprev");
  const midwrap = wrap.querySelector<HTMLElement>("#codemidwrap");
  if (!box || !midwrap) return;
  midwrap.classList.toggle("showprev", prevOpen);
  if (!prevOpen || !root) return;
  if (!prevHost) {
    prevHost = el(`<div class="codeprev-inner" style="display:flex;flex-direction:column;flex:1;min-height:0"></div>`);
  }
  if (prevHost.parentElement !== box) {
    box.innerHTML = "";
    box.appendChild(prevHost);
  }
  void api.previewSetRoot(root).catch(() => undefined);
  paintPreview();
}

/** Choose what to show, then draw the pane around it. */
function paintPreview(): void {
  if (!prevHost || !prevOpen) return;
  const top = (treeCache.get("") ?? []).filter((e) => !e.dir).map((e) => e.name);
  const entry = chooseEntry(docs.activeRel(), top);
  const changed = entry !== prevEntry;
  prevEntry = entry;

  const pending = proposals.size;
  const head = `<div class="codeprev-head">
      <span class="nm">${esc(entry ?? "")}</span>
      <span class="sp"></span>
      ${DEVICE_PRESETS.map((d) =>
        `<button class="bs" data-dev="${d.id}"${d.id === prevDevice.id ? ' style="border-color:var(--acc)"' : ""}>${esc(d.label)}</button>`,
      ).join("")}
      <button class="bs" data-prev-reload>${esc(t("prev.reload"))}</button>
    </div>
    ${pending > 0 ? `<div class="codeprev-note">${esc(t("prev.pending").replace("%n", String(pending)))}</div>` : ""}
    <div class="codeprev-note" style="color:var(--dim)">${esc(t("prev.sealed"))}</div>`;

  if (!entry) {
    prevHost.innerHTML = `${head}<div class="codeprev-stage"><div class="codeprev-empty">${esc(t("prev.nothing"))}</div></div>`;
    prevFrame = null;
    wirePreviewHead();
    return;
  }
  if (changed || !prevFrame) {
    prevHost.innerHTML = `${head}<div class="codeprev-stage"></div>`;
    const stage = prevHost.querySelector<HTMLElement>(".codeprev-stage")!;
    prevFrame = el(
      // No allow-same-origin: the page lives in an opaque origin with no access
      // to the app and no IPC. Same isolation the Chat preview uses.
      `<iframe sandbox="allow-scripts allow-forms" title="preview"></iframe>`,
    ) as HTMLIFrameElement;
    stage.appendChild(prevFrame);
    reloadPreview();
  } else {
    // Only the header changed: replace it without touching the frame, or the
    // page loses its scroll every time a proposal count moves.
    const old = prevHost.querySelector(".codeprev-head");
    const notes = prevHost.querySelectorAll(".codeprev-note");
    notes.forEach((n) => n.remove());
    if (old) old.outerHTML = head;
  }
  wirePreviewHead();
  sizePreviewFrame();
}

function wirePreviewHead(): void {
  prevHost?.querySelectorAll<HTMLElement>("[data-dev]").forEach((b) => {
    b.addEventListener("click", () => {
      prevDevice = DEVICE_PRESETS.find((d) => d.id === b.dataset.dev) ?? DEVICE_PRESETS[0];
      paintPreview();
    });
  });
  prevHost?.querySelector("[data-prev-reload]")?.addEventListener("click", () => reloadPreview());
}

/**
 * Apply the device frame.
 *
 * The iframe keeps the device's CSS pixels and is SCALED, never resized: a
 * media query must answer for the phone, not for the pane it is drawn in.
 */
function sizePreviewFrame(): void {
  if (!prevFrame || !prevHost) return;
  const stage = prevHost.querySelector<HTMLElement>(".codeprev-stage");
  if (!stage) return;
  const d = prevDevice;
  if (d.width === null) {
    stage.classList.remove("framed");
    prevFrame.style.cssText = "width:100%;height:100%;transform:none";
    return;
  }
  stage.classList.add("framed");
  const k = frameScale(d.width, stage.clientWidth || d.width);
  prevFrame.style.cssText =
    `width:${d.width}px;height:${d.height}px;transform:scale(${k});` +
    `transform-origin:top center;margin:12px 0`;
}

/** Point the frame at the entry again, with a fresh id so nothing is cached. */
function reloadPreview(): void {
  if (!prevFrame || !prevEntry) return;
  prevGen += 1;
  prevFrame.src = `gxpreview://localhost/${prevEntry}?v=${prevGen}`;
}

/**
 * A file just reached the disk.
 *
 * Debounced, because accepting a multi-file change writes N files in a burst
 * and N reloads would be N thrown-away scroll positions for one edit. Filtered,
 * because a README changing is not a reason to reload a page at all.
 */
function notifyPreviewWrite(rel: string): void {
  if (!prevOpen || !affectsPreview(rel)) return;
  if (prevTimer) clearTimeout(prevTimer);
  prevTimer = setTimeout(() => {
    prevTimer = null;
    paintPreview();
    reloadPreview();
  }, 250);
}

// ---------------------------------------------------------------- proposals

/**
 * Called by the Agent when it writes a file inside the workspace. Nothing is
 * written here: the change is filed, and the user answers it in the editor.
 */
export async function fileProposal(
  path: string,
  rel: string,
  content: string,
  waitForReview = false
): Promise<string> {
  if (!root) return "error: no code workspace is open";
  if (proposals.has(rel)) {
    return `error: ${rel} already has a pending diff; wait for the user to accept or reject it`;
  }
  let before = "";
  let existed = true;
  try {
    before = await api.codeRead(root, rel);
  } catch {
    existed = false;
  }
  if (existed && before === content) {
    return `no change: ${rel} already holds exactly that content`;
  }
  proposals.set(rel, { rel, after: content, before, created: Date.now() });
  if (!existed) creations.add(rel);
  // A file already open, foreground OR background, enters review mode in its
  // own document; anything else is listed as pending and opens on a click.
  if (docs.has(rel)) {
    docs.open(rel, existed ? before : "", content);
    setReview(rel, existed ? before : "");
    applyTsBindings(rel);
    applyRustBindings(rel);
    if (docs.activeRel() === rel) paintMid();
  }
  paintPending();
  paintTree();
  paintTabs();
  deps?.paintNav();
  deps?.toast(t("code.proposalToast").replace("%s", rel), "ok");
  const filed =
    `proposed: ${rel} is now a PENDING diff in the user's editor. Nothing was written to disk. ` +
    "They will accept or reject it hunk by hunk; do not assume the file changed, and do not " +
    "propose it again unless they ask.";
  if (!waitForReview) return filed;
  const outcome = await reviewGate.wait(rel);
  return `${filed}\n\n${reviewInstruction(outcome)}`;
}

/** Every file with a pending proposal, in the order they arrived. */
export function pendingPaths(): string[] {
  return [...proposals.values()].sort((a, b) => a.created - b.created).map((p) => p.rel);
}

// ---------------------------------------------------------------- workspace

export async function chooseWorkspace(): Promise<void> {
  let p: string | null;
  try {
    p = await api.pickFolder();
  } catch (e: any) {
    // A chooser that cannot open now says so. It used to return "nothing
    // chosen", the same answer as Cancel, and the button read as dead.
    deps?.toast(String(e?.message ?? e));
    return;
  }
  if (!p) return;
  await setWorkspace(p);
}

/**
 * What happens to a pending proposal when the workspace changes: the user is
 * TOLD, by name, and has to confirm.
 *
 * Switching used to clear `proposals` in silence. A proposal is the only copy
 * of an edit the model made: nothing was written to disk, and the model has
 * been told not to propose it again. Dropping it without a word is losing
 * work the user never saw the end of.
 *
 * Refusing the switch outright was the other candidate, and it is what
 * `checkout()` does, but the two cases are not the same. A checkout rewrites
 * the very files the proposals are measured against, so a proposal cannot
 * survive it in any meaningful sense and the answer is "deal with these
 * first". Opening a different folder is a navigation, and a user who has
 * decided to leave should not be held hostage by an edit they have already
 * mentally rejected. So: warn, name the files, and require an explicit
 * confirmation. Cancel keeps the workspace exactly as it was.
 */
async function confirmDroppingProposals(): Promise<boolean> {
  const pending = pendingPaths();
  if (!pending.length) return true;
  const list = pending.map((rel) => `<div class="cf"><span class="mono">${esc(rel)}</span></div>`).join("");
  return await confirmModal(
    t("code.switchPendingTitle"),
    t("code.switchPendingSub").replace("%n", String(pending.length)),
    `<div class="ccommit"><div class="cfiles">${list}</div></div>`,
    t("code.switchPendingDo")
  );
}

async function setWorkspace(p: string): Promise<void> {
  const next = p.replace(/\/+$/, "");
  // Reopening the same folder is not a switch and must not threaten anything.
  if (next !== root && !(await confirmDroppingProposals())) return;
  root = next;
  docs.closeAll();
  editor?.destroy();
  editor = null;
  proposals.clear();
  reviewGate.resolveAll("discarded");
  // Keyed on the relative path like `proposals`, so it has to go with them:
  // "src/main.rs" left behind here would mark the NEW workspace's file as a
  // creation and re-enumerate the index for a file that already existed.
  creations.clear();
  expanded.clear();
  treeCache.clear();
  recentPaths.length = 0;
  commits = [];
  branches = [];
  historyPath = null;
  mid = "editor";
  patch = null;
  refsHtml = "";
  outlineItems = [];
  git = undefined;
  offSearch?.();
  offSearch = null;
  tsintel?.disable();
  // The previous workspace's crate index is worth hundreds of megabytes, and
  // nothing on screen would say it is still held.
  void disableRustLsp();
  // Same for the shells: their cwd is a folder the user just left, and a
  // terminal sitting in a directory the file tree no longer shows is a trap.
  disposeTerminal();
  disposePreview();
  await deps?.saveSetting("code_root", root);
  // Everything from here is DECORATION on a switch that has already happened:
  // the folder is chosen and written to the settings. These three were awaited
  // bare, so one of them throwing skipped the repaint below and left the view
  // on the screen that asks for a folder, having just been given one. The
  // button read as dead while the workspace behind it had in fact changed, and
  // the next launch reopened a folder the user was told had not been accepted.
  //
  // Each is now independent. A failure costs its own feature and nothing else,
  // and the view is painted whatever happened.
  await refreshGit().catch(() => undefined);
  await loadDir("").catch((e: any) => {
    // The tree is the one failure worth naming: a workspace whose contents
    // cannot be listed shows an empty file panel, which reads as an empty
    // folder rather than as a folder being withheld.
    deps?.toast(
      classifyRootError(String(e?.message ?? e)) === "unreadable"
        ? t("code.rootUnreadable")
        : String(e?.message ?? e),
    );
  });
  await startWorkspaceServices().catch(() => undefined);
  paintAll();
  deps?.paintNav();
}

/**
 * Deferred start of the Rust language server.
 *
 * `armed` says the workspace deserves one; `fired` says it has been asked for.
 * Two flags rather than one because they answer different questions, and
 * collapsing them would make "a Rust project the user never opened a .rs file
 * in" indistinguishable from "already running".
 */
const rustLsp = { armed: false, fired: false };

/**
 * Start rust-analyzer if this workspace deserves one and it is not started.
 *
 * Called when a Rust file is opened, never at launch. Idempotent on purpose:
 * a user moving between two .rs files must not spawn a second server. The
 * lifecycle lock in lsp.rs would turn that into a slow no-op rather than two
 * processes, but relying on a lock to paper over a double call is how the
 * process leak that lock exists for came back the first time.
 */
function fireRustLsp(): void {
  if (!rustLsp.armed || rustLsp.fired || !root) return;
  rustLsp.fired = true;
  void enableRustLsp(root).then(() => {
    applyRustBindings();
    paintFileHead();
    paintTabs();
  });
}

/**
 * Bring up everything that depends on having a root: the search subscription
 * and, when the folder looks like a JavaScript or TypeScript project, the
 * in-app language service. Both are lazy and neither is required.
 */
async function startWorkspaceServices(): Promise<void> {
  if (!root) return;
  if (!offSearch) {
    offSearch = workspaceApi.onSearch(makeSearchSink(searchState, searchDeps()));
  }
  const top = treeCache.get("")?.map((e) => e.name) ?? [];
  // Rust is independent of the TypeScript gate: a repository can be both, and
  // this one is. It also has to be decided BEFORE the early return below, or a
  // pure Rust workspace would never reach it.
  //
  // Decided here, STARTED later. This function runs at launch on the restored
  // workspace, before the user has opened anything, and a cold rust-analyzer
  // spends minutes on `cargo metadata` and indexing. Paying that for someone
  // who reopened the app to write a paragraph in Chat is the wrong default, so
  // the server is armed and the first Rust file opened fires it. A Rust
  // workspace nobody opens a Rust file in now costs nothing.
  rustLsp.armed = shouldStartRustLsp(top);
  rustLsp.fired = false;
  if (!rustLsp.armed) void disableRustLsp();
  if (!shouldLoadTsIntel(top)) {
    tsintel?.disable();
    return;
  }
  await loadTsIntel();
  if (!tsintel) return;
  applyTsBindings();
  if (tsintel.autoEnable(top)) {
    void tsintel.enable(root).then((r) => {
      if (r.tier === "B" && r.reason) deps?.toast(t("tsintel.tierB").replace("%s", r.reason));
      paintFileHead();
      paintTabs();
    });
  } else {
    tsintel.disable();
  }
}

/**
 * The language service is 9 MB of TypeScript. It is imported only once, only
 * when a workspace could use it, and the import itself is what keeps it off
 * the cold start path.
 */
async function loadTsIntel(): Promise<void> {
  if (tsintel) return;
  if (!tsLoading) {
    tsLoading = (async () => {
      const [client, bindings] = await Promise.all([
        import("./tsintel/client"),
        import("./tsintel/bindings"),
      ]);
      tsintel = client;
      tsbind = bindings;
      client.configureTsIntel({
        snapshot: (r, exts, capBytes, capFiles) => api.codeSnapshot(r, exts, capBytes, capFiles),
      });
      // TypeScript's own errors join the syntax pass rather than replacing it.
      const source = bindings.tsDiagnosticSource(tsDeps);
      registerDiagnosticSource("ts", async (state, rel) => {
        if (!/\.(m|c)?[jt]sx?$/i.test(rel)) return [];
        return source(rel, state.doc.toString());
      });
    })().catch((e: unknown) => {
      // Tier B is a normal outcome. The editor keeps its grammar either way.
      console.warn("the language service could not be loaded:", e);
      tsintel = null;
      tsbind = null;
    });
  }
  await tsLoading;
}

/** True while the TypeScript service is actually answering. Never a promise. */
function tsActive(): boolean {
  return tsintel?.tier() === "A";
}

// ---------------------------------------------------------------- git state

async function refreshGit(): Promise<void> {
  if (!root) return;
  try {
    git = await api.gitInfo(root);
  } catch {
    git = null;
  }
  if (git?.repo) {
    try {
      changes = await api.gitStatus(root);
    } catch {
      changes = [];
    }
  } else {
    changes = [];
  }
}

async function refreshHistory(): Promise<void> {
  if (!root || !git?.repo) {
    commits = [];
    return;
  }
  try {
    commits = await api.gitLog(root, 80, historyPath ?? undefined);
  } catch {
    commits = [];
  }
}

async function refreshBranches(): Promise<void> {
  if (!root || !git?.repo) {
    branches = [];
    return;
  }
  try {
    branches = await api.gitBranches(root);
  } catch {
    branches = [];
  }
}

// ---------------------------------------------------------------- tree

/** Refresh every directory level already loaded, so decorations stay true. */
async function reloadTree(): Promise<void> {
  await Promise.all([...treeCache.keys()].map((k) => loadDir(k)));
}

async function loadDir(sub: string): Promise<void> {
  if (!root) return;
  try {
    treeCache.set(sub, await api.codeTree(root, sub));
  } catch (e: any) {
    treeCache.set(sub, []);
    deps?.toast(String(e?.message ?? e));
  }
}

function statusDot(status: string): string {
  if (!status) return "";
  const cls = status === "?" ? "unt" : status === "A" ? "add" : status === "D" ? "del" : "mod";
  return `<span class="gs ${cls}">${esc(status)}</span>`;
}

function treeRowsHtml(sub: string, depth: number): string {
  const rows = treeCache.get(sub);
  if (!rows) return "";
  const active = docs.activeRel();
  let out = "";
  for (const e of rows) {
    // Files and folders share one layout: both carry the twist spacer, so a
    // file name lines up with the folder names around it instead of sitting
    // three pixels to their left.
    const pad = 6 + depth * 14;
    const pending = proposals.has(e.path);
    if (e.dir) {
      const open = expanded.has(e.path);
      out +=
        `<div class="trow dir ${open ? "open" : ""}" data-dir="${esc(e.path)}" style="padding-left:${pad}px">` +
        `<span class="tw">${open ? "▾" : "▸"}</span><span class="tn">${esc(e.name)}</span>${statusDot(e.status)}</div>`;
      if (open) out += treeRowsHtml(e.path, depth + 1);
    } else {
      out +=
        `<div class="trow file ${active === e.path ? "on" : ""} ${pending ? "pending" : ""}" data-file="${esc(e.path)}" style="padding-left:${pad}px">` +
        `<span class="tw"></span><span class="tn">${esc(e.name)}</span>${pending ? `<span class="gs prop">◆</span>` : ""}${statusDot(e.status)}</div>`;
    }
  }
  return out;
}

/** Six shimmering rows, so "still loading" never looks like "nothing here". */
function skeletonRows(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += `<div class="skel skrow" style="width:${60 + ((i * 37) % 34)}%"></div>`;
  return `<div class="skelbox">${out}</div>`;
}

// ---------------------------------------------------------------- editor

function onEditorUpdate(u: ViewUpdate): void {
  if (!u.docChanged && !u.transactions.some((tr) => tr.effects.length > 0)) return;
  // The update lands on the document the VIEW is showing, read from the state
  // itself, not on whatever happens to be active. That is the fix for the
  // corruption where an accepted hunk in one file rewrote another file's
  // "content on disk".
  const d = docs.byView(u.view);
  if (!d) return;
  d.state = u.state;
  if (u.docChanged) {
    scheduleOutline();
    if (tsActive()) tsintel!.updateBuffer(d.rel, u.state.doc.toString());
    if (isRust(d.rel)) syncRustBuffer(d.rel, u.state.doc.toString());
  }
  if (d.mergeBase === null) {
    paintFileHead();
    paintTabsIfChanged();
    return;
  }
  // In merge mode the ORIGINAL document is the disk truth: it starts at the
  // file's current content and only moves when a hunk is accepted. A reject
  // rewrites the editor buffer instead and leaves it alone, which is exactly
  // why the disk never sees a rejected hunk.
  const original = getOriginalDoc(u.state).toString();
  if (original !== d.mergeBase) {
    d.mergeBase = original;
    writeAccepted(d.rel, original);
  }
  const ch = getChunks(u.state);
  if (ch && ch.chunks.length === 0) {
    // Every hunk answered: leave review mode. Deferred, so the transaction
    // that resolved the last chunk finishes applying first.
    const rel = d.rel;
    setTimeout(() => {
      if (docs.get(rel)?.mergeBase !== null) void finishReview(rel);
    }, 0);
  }
  paintFileHead();
  paintTabsIfChanged();
}

/**
 * Enter or leave review mode for one document. A transaction on a compartment,
 * never a rebuild: the undo history the user built before the model proposed
 * survives the diff appearing and disappearing.
 */
function setReview(rel: string, base: string | null): void {
  const d = docs.get(rel);
  if (!d) return;
  d.mergeBase = base;
  const content =
    base === null
      ? []
      : unifiedMergeView({
          original: base,
          mergeControls: true,
          gutter: true,
          collapseUnchanged: { margin: 3, minSize: 4 },
        });
  const live = editor !== null && docs.byView(editor)?.rel === rel;
  if (live) {
    editor!.dispatch({ effects: mergeComp.reconfigure(content) });
    docs.capture(editor!);
  } else {
    d.state = d.state.update({ effects: mergeComp.reconfigure(content) }).state;
  }
}

/**
 * The ONLY place an accepted change reaches the disk. `content` is always the
 * merge view's original document, never the editor buffer, and the write is
 * queued on THIS document's chain so two files never serialize behind each
 * other and two writes to one file never race.
 */
function writeAccepted(rel: string, content: string): void {
  if (!root) return;
  void docs
    .queueWrite(rel, async () => {
      await api.codeWrite(root!, rel, content);
      notifyPreviewWrite(rel);
      docs.setSaved(rel, content);
      if (creations.delete(rel)) indexStale = true;
      await refreshGit();
      await reloadTree();
      paintTree();
      paintChanges();
      paintFileHead();
      paintTabs();
    })
    .catch((e: any) => {
      deps?.toast(t("code.saveFail").replace("%s", String(e?.message ?? e)));
    });
}

/** All hunks answered: drop the proposal and go back to a plain editor. */
async function finishReview(rel: string): Promise<void> {
  const proposal = proposals.get(rel);
  proposals.delete(rel);
  setReview(rel, null);
  await docs.settle(rel);
  const d = docs.get(rel);
  const finalContent = d?.state.doc.toString() ?? proposal?.before ?? "";
  if (d) docs.setSaved(rel, finalContent);
  if (proposal) {
    const decision = finalContent === proposal.after
      ? "accepted"
      : finalContent === proposal.before
        ? "rejected"
        : "partial";
    reviewGate.resolve(rel, decision);
  }
  if (docs.activeRel() === rel) paintMid();
  paintPending();
  paintTabs();
  deps?.paintNav();
}

/**
 * Mount or re-point the editor. There is exactly ONE EditorView for the whole
 * view; a tab switch is `setState`, which is what preserves the undo history,
 * the folds, the selection and (with the snapshot below) the scroll.
 */
function mountEditor(): void {
  const host = document.getElementById("cmhost");
  const d = docs.active();
  if (!host || !d || d.error !== null) {
    editor?.destroy();
    editor = null;
    return;
  }
  if (!editor || !host.contains(editor.dom)) {
    editor?.destroy();
    editor = new EditorView({ state: d.state, parent: host });
  } else if (docs.byView(editor)?.rel !== d.rel) {
    docs.capture(editor, editor.scrollSnapshot());
    editor.setState(d.state);
  }
  if (d.scroll) editor.dispatch({ effects: d.scroll });
  applyReveal();
  scheduleOutline();
}

export async function openFile(rel: string): Promise<void> {
  if (!root) return;
  // The moment the Rust server is actually worth its cold index. Fired before
  // the read rather than after, so the server is already coming up while the
  // file loads; it is idempotent, so every later .rs open is free.
  if (isRust(rel)) fireRustLsp();
  mid = "editor";
  patch = null;
  let disk = "";
  let exists = true;
  try {
    disk = await api.codeRead(root, rel);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    // A proposal that CREATES a file is not a read failure: there is simply
    // nothing on disk yet, and the whole file is one added hunk.
    if (proposals.has(rel) && /no such file|not found|os error 2/i.test(msg)) {
      exists = false;
    } else {
      docs.openError(rel, msg);
      remember(rel);
      paintMid();
      paintTree();
      return;
    }
  }
  const saved = exists ? disk : "";
  let prop = proposals.get(rel);
  if (prop && prop.after === saved) {
    // The disk caught up with the proposal (the user saved the same edit, or
    // git changed under it): there is nothing left to answer.
    proposals.delete(rel);
    prop = undefined;
    deps?.paintNav();
  }
  docs.open(rel, saved, prop?.after);
  if (prop) setReview(rel, saved);
  applyTsBindings(rel);
  applyRustBindings(rel);
  remember(rel);
  paintMid();
  paintTree();
}

/**
 * Re-read every open document from disk.
 *
 * `docs.open()` deliberately keeps an already-open document's state, so that
 * clicking a file in the tree twice does not throw the user's edits away. That
 * is right for a click and wrong after a checkout or a pull, where the disk is
 * the authority and the buffer describes a tree that no longer exists. This is
 * the one place allowed to rebuild a document from the file.
 *
 * TWO buffers are exempt, not one. A pending review is the user's to answer,
 * and so is a plain DIRTY buffer: unsaved typing is work that exists nowhere
 * else, and rebuilding the document from disk deletes it with no undo, since
 * `rebuild` replaces the EditorState and its history along with it. The pull
 * or the checkout still happened, so the user is told which files were left
 * alone rather than being allowed to keep typing into a buffer whose base has
 * silently moved.
 */
async function reloadOpenFromDisk(): Promise<void> {
  if (!root) return;
  const kept: string[] = [];
  for (const d of docs.list()) {
    if (d.mergeBase !== null) continue; // a pending review is the user's to answer
    let disk: string;
    try {
      disk = await api.codeRead(root, d.rel);
    } catch (e: any) {
      // A dirty buffer whose file just vanished is the last copy of that work:
      // turning the tab into an error card would throw it away.
      if (docs.isDirty(d.rel)) {
        kept.push(d.rel);
        continue;
      }
      docs.openError(d.rel, String(e?.message ?? e));
      continue;
    }
    if (disk === d.saved && !docs.isDirty(d.rel)) continue;
    if (docs.isDirty(d.rel)) {
      // Unsaved edits win over the disk. `saved` is deliberately NOT moved to
      // the new disk content: the dirty marker and the Save button must keep
      // describing a buffer that differs from the file, which it does.
      if (disk !== d.saved) kept.push(d.rel);
      continue;
    }
    docs.rebuild(d.rel, disk);
    docs.setSaved(d.rel, disk);
    docs.setError(d.rel, null);
    applyTsBindings(d.rel);
    applyRustBindings(d.rel);
    forgetPython(d.rel);
    closeRustBuffer(d.rel);
  }
  if (kept.length) {
    deps?.toast(
      t("code.reloadKeptDirty").replace("%n", String(kept.length)).replace("%s", kept.join(", "))
    );
  }
  // The view is showing a state object that no longer exists: force a remount.
  editor?.destroy();
  editor = null;
}

/** Keep the recency list the file palette ranks with. */
function remember(rel: string): void {
  const at = recentPaths.indexOf(rel);
  if (at >= 0) recentPaths.splice(at, 1);
  recentPaths.unshift(rel);
  if (recentPaths.length > 40) recentPaths.length = 40;
}

async function saveOpenFile(): Promise<void> {
  const d = docs.active();
  if (!root || !d) return;
  if (d.mergeBase !== null) {
    deps?.toast(t("code.saveBlocked"));
    return;
  }
  const content = d.state.doc.toString();
  try {
    await api.codeWrite(root, d.rel, content);
    notifyPreviewWrite(d.rel);
    docs.setSaved(d.rel, content);
    if (creations.delete(d.rel)) indexStale = true;
    await refreshGit();
    await reloadTree();
    paintTree();
    paintChanges();
    paintFileHead();
    paintTabs();
  } catch (e: any) {
    deps?.toast(t("code.saveFail").replace("%s", String(e?.message ?? e)));
  }
}

/** Take the whole proposal: write the editor buffer, then leave review mode. */
async function acceptAll(): Promise<void> {
  const d = docs.active();
  if (!root || !d || d.mergeBase === null) return;
  const content = d.state.doc.toString();
  try {
    await api.codeWrite(root, d.rel, content);
    notifyPreviewWrite(d.rel);
  } catch (e: any) {
    deps?.toast(t("code.saveFail").replace("%s", String(e?.message ?? e)));
    return;
  }
  d.mergeBase = content;
  docs.setSaved(d.rel, content);
  await finishReview(d.rel);
  await refreshGit();
  await reloadTree();
  paintTree();
  paintChanges();
}

/** Drop the whole proposal. Nothing is written: the disk never saw it. */
async function rejectAll(): Promise<void> {
  const d = docs.active();
  if (!d || d.mergeBase === null) return;
  const base = d.mergeBase;
  if (editor && docs.byView(editor)?.rel === d.rel) {
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: base } });
    docs.capture(editor);
  } else {
    d.state = d.state.update({ changes: { from: 0, to: d.state.doc.length, insert: base } }).state;
  }
  await finishReview(d.rel);
}

/** Drop a pending proposal for a file that may or may not be open. */
async function discardProposal(rel: string): Promise<void> {
  proposals.delete(rel);
  creations.delete(rel);
  reviewGate.resolve(rel, "rejected");
  const d = docs.get(rel);
  if (d && d.mergeBase !== null) {
    const base = d.mergeBase;
    if (editor && docs.byView(editor)?.rel === rel) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: base } });
      docs.capture(editor);
    } else {
      d.state = d.state.update({ changes: { from: 0, to: d.state.doc.length, insert: base } }).state;
    }
    setReview(rel, null);
    docs.setSaved(rel, base);
    if (docs.activeRel() === rel) paintMid();
  }
  paintPending();
  paintTree();
  paintTabs();
  deps?.paintNav();
}

// ---------------------------------------------------------------- reveal

let pendingReveal: { line: number; col: number } | null = null;

/** Put the caret on a line. Deferred: `openFile` repaints the middle column. */
function revealLine(line: number, col: number): void {
  pendingReveal = { line, col };
  applyReveal();
}

function applyReveal(): void {
  if (!pendingReveal || !editor) return;
  const { line, col } = pendingReveal;
  pendingReveal = null;
  const doc = editor.state.doc;
  if (line < 1 || line > doc.lines) return;
  const l = doc.line(line);
  const pos = Math.min(l.to, l.from + Math.max(0, col - 1));
  editor.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
  editor.focus();
}

// ---------------------------------------------------------------- outline

/**
 * The outline is recomputed on a throttle, and again once the parse has
 * reached the end of the document: the 50 ms budget in `outline()` is
 * deliberate, so the first answer on a large file is partial by design.
 */
function scheduleOutline(): void {
  if (outlineTimer) clearTimeout(outlineTimer);
  outlineTimer = setTimeout(() => {
    outlineTimer = null;
    void computeOutline();
  }, 120);
}

async function computeOutline(): Promise<void> {
  const d = docs.active();
  if (!d || d.error !== null) {
    outlineItems = [];
    outlineExact = false;
    paintOutline();
    return;
  }
  const lezer = outline(d.state, d.rel);
  const complete = outlineIsComplete(d.state);
  outlineItems = lezer;
  outlineExact = false;
  outlinePartial = !complete;
  paintOutline();
  if (isPython(d.rel)) {
    // CPython's own ast is authoritative when it parses; when it does not, the
    // grammar's partial outline stays rather than the panel going blank.
    const exact = await pyOutline(d.state, d.rel).catch(() => null);
    if (exact && docs.activeRel() === d.rel) {
      outlineItems = exact;
      outlineExact = true;
      outlinePartial = false;
      paintOutline();
    }
    return;
  }
  if (!complete) {
    // Ask again with the whole document parsed, once, without a budget.
    setTimeout(() => {
      const now = docs.active();
      if (!now || now.rel !== d.rel) return;
      if (!outlineIsComplete(now.state)) return;
      outlineItems = outline(now.state, now.rel, 300);
      outlinePartial = false;
      paintOutline();
    }, 250);
  }
}

function outlinePanelHtml(): string {
  const d = docs.active();
  if (!d) return `<div class="cempty">${esc(t("code.pickFile"))}</div>`;
  if (!langIdFor(d.rel)) return `<div class="cempty">${esc(t("outline.noGrammar"))}</div>`;
  const pos = editor ? editor.state.selection.main.head : 0;
  // The panel says what it knows AND what it does not. An outline with no
  // caveat reads as a compiler's answer, and it is a grammar's.
  const lines = outlineExact
    ? [t("outline.pythonExact"), t("diag.pythonNoTypes")]
    : isPython(d.rel)
      ? [t("diag.pythonNoTypes")]
      : [t("diag.syntaxOnly")];
  if (outlinePartial) lines.unshift(t("outline.partial"));
  const note = `<div class="cnote">${lines.map(esc).join("<br>")}</div>`;
  if (!outlineItems.length) return note + `<div class="cempty">${esc(t("outline.empty"))}</div>`;
  return note + outlineHtml(outlineItems, activeOutlineIndex(outlineItems, pos));
}

function paintOutline(): void {
  if (leftTab !== "outline") return;
  const box = document.getElementById("codepanel");
  if (box) box.innerHTML = outlinePanelHtml();
}

// ---------------------------------------------------------------- workspace api

/**
 * The real backend behind the navigation surfaces. The panel, the palettes and
 * the replace planner all talk to this and to nothing else, which is what lets
 * them be exercised against an in-memory fake.
 */
const workspaceApi: WorkspaceApi = {
  files: async (r, refresh = false) => {
    if (indexStale) {
      indexStale = false;
      refresh = true;
    }
    return api.searchFiles(r, refresh);
  },
  searchStart: async (r, query, o: WsSearchOpts) => {
    await freshIndex();
    return api.searchStart(r, query, {
      case_sensitive: o.caseSensitive,
      whole_word: o.wholeWord,
      include_globs: o.include,
      exclude_globs: o.exclude,
    });
  },
  searchCancel: (gen) => api.searchCancel(gen),
  onSearch(cb: (p: SearchProgress) => void): () => void {
    let off: (() => void) | null = null;
    let dead = false;
    const sub = onEvent("galactus://search", (payload: any) => {
      cb({
        gen: payload.gen,
        hits: payload.hits as SearchHit[],
        done: !!payload.done,
        capped: !!payload.capped,
        timedOut: !!payload.timed_out,
        error: payload.error,
      });
    });
    void sub.then((u) => {
      if (dead) u();
      else off = u;
    });
    return () => {
      dead = true;
      off?.();
    };
  },
  symbolsQuery: async (r, q, limit): Promise<SymbolHit[]> => {
    await freshIndex();
    const hits = await api.symbolsQuery(r, q, limit);
    return hits.map((h) => ({
      name: h.name,
      kind: h.kind,
      path: h.path,
      line: h.line,
      container: h.container,
    }));
  },
  read: (r, rel) => api.codeRead(r, rel),
};

function searchDeps(): SearchPanelDeps {
  return {
    root: root ?? "",
    api: workspaceApi,
    openFile: (rel) => void openFile(rel),
    revealLine,
    repaint: (scope) => {
      if (leftTab !== "search") return;
      if (scope === "results") {
        const b = document.getElementById("srchres");
        if (b) {
          b.innerHTML = searchResultsHtml(searchState);
          return;
        }
      }
      paintPanel();
    },
    toast: (m) => deps?.toast(m),
    requestReplace: (s) => void runReplace(s),
  };
}

/**
 * Project-wide replace. It does not write: it plans, and every affected file
 * becomes a pending proposal, reviewed hunk by hunk like a model edit.
 * `writeAccepted()` stays the only writer in the app.
 */
async function runReplace(s: SearchPanelState): Promise<void> {
  if (!root || !s.hits.length) return;
  const files = new Set(s.hits.map((h) => h.path)).size;
  if (files > REPLACE_FILE_CAP) {
    deps?.toast(
      t("code.replace.tooMany").replace("%f", String(files)).replace("%c", String(REPLACE_FILE_CAP))
    );
    return;
  }
  const ok = await confirmModal(
    t("code.replace.title"),
    t("code.replace.sub").replace("%f", String(files)).replace("%n", String(s.hits.length)),
    `<div class="pd">${esc(s.query)} → ${esc(s.replacement)}</div>`,
    t("code.replace.do")
  );
  if (!ok) return;
  let plan;
  try {
    plan = await planReplace(s.hits, s.query, s.replacement, searchOpts(s), (rel) =>
      api.codeRead(root!, rel)
    );
  } catch (e: any) {
    deps?.toast(e instanceof ReplaceCapError ? e.message : String(e?.message ?? e));
    return;
  }
  if (!plan.length) {
    deps?.toast(t("code.replace.none"));
    return;
  }
  for (const f of plan) await fileProposal(root + "/" + f.rel, f.rel, f.content);
  if (plan.length < files) {
    deps?.toast(
      t("code.replace.partial").replace("%n", String(plan.length)).replace("%m", String(files))
    );
  }
}

// ---------------------------------------------------------------- palettes

/** Cmd-P and Cmd-Shift-O, called by the shell's global shortcut handler. */
export function openPalette(kind: "files" | "symbols"): void {
  if (!root) return;
  const d = {
    root,
    api: workspaceApi,
    openFile: (rel: string) => void openFile(rel),
    recent: () => recentPaths,
    revealLine,
  };
  if (kind === "files") openFilePalette(d);
  else openSymbolPalette(d);
}

/** Cmd-Shift-F: focus the project search tab and its query box. */
export function openProjectSearch(): void {
  if (!root) return;
  leftTab = "search";
  paintLeft();
  document.getElementById("srchq")?.focus();
}

/** True while a palette owns the keyboard, so the shell keeps out of its way. */
export function paletteIsOpen(): boolean {
  return paletteOpen();
}

// ---------------------------------------------------------------- ts intel

const tsDeps: TsBindings.TsBindingDeps = {
  file: () => docs.activeRel(),
  openFile: (rel: string, line: number, col: number) => {
    void openFile(rel).then(() => revealLine(line, col));
  },
  showReferences: (html: string) => {
    refsHtml = html;
    mid = "refs";
    paintMid();
  },
  t: (key: string, fallback: string) => {
    const s = t(key);
    return s === key ? fallback : s;
  },
};

/**
 * Push the language-service bindings into every open JavaScript or TypeScript
 * document, through the one `intelComp` the extension set declares.
 *
 * A compartment reconfiguration is a transaction, so this can run at any
 * moment: when the service finishes booting (9 MB of TypeScript arrive well
 * after the first file is on screen), and again whenever a document opens. The
 * bindings themselves re-check the tier on every call, so installing them
 * while the service is still in tier B costs nothing and changes nothing.
 */
function applyTsBindings(rel?: string): void {
  if (!tsbind) return;
  const targets = rel ? [docs.get(rel)].filter((d): d is Doc => d !== null) : docs.list();
  for (const d of targets) {
    if (!/\.(m|c)?[jt]sx?$/i.test(d.rel)) continue;
    const support = langFor(d.rel);
    if (!support.length) continue;
    // `javascript()` hands back a LanguageSupport wrapping one of four
    // module-level Language singletons, so attaching the completion source to
    // `support.language` reaches the very grammar this document is parsed by.
    const ext = tsbind.tsIntelExtensions(support[0] as never, tsDeps);
    if (editor && docs.byView(editor)?.rel === d.rel) {
      editor.dispatch({ effects: intelComp.reconfigure(ext) });
      docs.capture(editor);
    } else {
      d.state = d.state.update({ effects: intelComp.reconfigure(ext) }).state;
    }
  }
}

/**
 * The Rust equivalent of `applyTsBindings`, through the same `intelComp`.
 *
 * Safe to run while the server is off, starting or dead: every binding
 * re-checks `rustReady()` on each call and contributes nothing when it is
 * false, so the extension set never has to be rebuilt on a state change.
 * `tsDeps` is reused as is because `RustLspDeps` declares exactly the same
 * four members, and two objects saying the same thing is how they drift.
 */
function applyRustBindings(rel?: string): void {
  const targets = rel ? [docs.get(rel)].filter((d): d is Doc => d !== null) : docs.list();
  for (const d of targets) {
    if (!isRust(d.rel)) continue;
    const support = langFor(d.rel);
    if (!support.length) continue;
    const ext = rustIntelExtensions(support[0] as never, tsDeps);
    if (editor && docs.byView(editor)?.rel === d.rel) {
      editor.dispatch({ effects: intelComp.reconfigure(ext) });
      docs.capture(editor);
    } else {
      d.state = d.state.update({ effects: intelComp.reconfigure(ext) }).state;
    }
  }
}

/** F2 on the caret: a rename, as proposals, never as a write. */
async function renameAtCaret(): Promise<void> {
  const d = docs.active();
  if (!root || !d || !editor) return;
  // Rust first, because the TypeScript guard below would otherwise refuse a
  // .rs file with a message about a service that was never going to serve it.
  if (isRust(d.rel)) {
    await renameRustAtCaret(d, editor);
    return;
  }
  if (!tsintel || !tsActive()) {
    deps?.toast(t("tsintel.needsTierA"));
    return;
  }
  const pos = editor.state.selection.main.head;
  const name = await promptModal(t("tsintel.renameTitle"), t("tsintel.renameBody"), t("tsintel.renamePrompt"));
  if (!name) return;
  try {
    const edits = await tsintel.planRenameFromClient(d.rel, pos, name, async (rel) => {
      try {
        return await api.codeRead(root!, rel);
      } catch {
        return undefined;
      }
    });
    if (!edits.length) {
      deps?.toast(t("code.replace.none"));
      return;
    }
    for (const e of edits) await fileProposal(root + "/" + e.rel, e.rel, e.content);
    deps?.toast(t("tsintel.renameProposed").replace("%n", String(edits.length)), "ok");
  } catch (e: any) {
    deps?.toast(t("tsintel.renameFail").replace("%s", String(e?.message ?? e)));
  }
}

/**
 * The Rust half of F2. Same contract as the TypeScript one, and the same
 * ending: whole files handed to `fileProposal`, never a write. The server is
 * asked only once it has finished indexing, because a rename planned against a
 * half-loaded crate graph misses call sites, and a rename that misses call
 * sites is worse than no rename at all.
 */
async function renameRustAtCaret(d: Doc, view: EditorView): Promise<void> {
  if (!rustReady()) {
    deps?.toast(t("rustlsp.needsReady"));
    return;
  }
  const name = await promptModal(
    t("tsintel.renameTitle"),
    t("tsintel.renameBody"),
    t("tsintel.renamePrompt")
  );
  if (!name) return;
  try {
    const edits = await planRustRename(
      d.rel,
      view.state.doc,
      view.state.selection.main.head,
      name,
      async (rel) => {
        try {
          return await api.codeRead(root!, rel);
        } catch {
          return undefined;
        }
      },
      (text) => EditorState.create({ doc: text }).doc
    );
    if (!edits.length) {
      deps?.toast(t("code.replace.none"));
      return;
    }
    for (const e of edits) await fileProposal(root + "/" + e.rel, e.rel, e.content);
    deps?.toast(t("tsintel.renameProposed").replace("%n", String(edits.length)), "ok");
  } catch (e: any) {
    deps?.toast(t("tsintel.renameFail").replace("%s", String(e?.message ?? e)));
  }
}

// ---------------------------------------------------------------- patches

/** Colour a unified patch the way the permission dialog colours a write. */
function patchHtml(text: string): string {
  const lines = text.split("\n");
  const CAP = 4000;
  let out = "";
  for (const raw of lines.slice(0, CAP)) {
    const cls = raw.startsWith("+++") || raw.startsWith("---")
      ? "meta"
      : raw.startsWith("@@")
        ? "hunk"
        : raw.startsWith("+")
          ? "add"
          : raw.startsWith("-")
            ? "rem"
            : raw.startsWith("diff ") || raw.startsWith("index ")
              ? "meta"
              : "";
    out += `<div class="dl ${cls}">${esc(raw.length ? raw : " ")}</div>`;
  }
  if (lines.length > CAP) {
    out += `<div class="dl skip">${esc(t("diff.omitted").replace("%n", String(lines.length - CAP)))}</div>`;
  }
  return out;
}

async function showCommit(c: GitCommitInfo): Promise<void> {
  if (!root) return;
  try {
    const body = await api.gitDiff(root, historyPath ?? undefined, c.hash);
    patch = {
      title: `${c.short} · ${c.subject}`,
      sub: `${c.author} · ${c.when.slice(0, 19).replace("T", " ")}${historyPath ? ` · ${historyPath}` : ""}`,
      body,
    };
    mid = "patch";
    paintMid();
  } catch (e: any) {
    deps?.toast(String(e?.message ?? e));
  }
}

async function showChange(ch: GitChange, staged: boolean): Promise<void> {
  if (!root) return;
  try {
    let body: string;
    if (ch.untracked) {
      // git has no diff for a file it does not track: render it as one added
      // block rather than an empty pane.
      const text = await api.codeRead(root, ch.path);
      body =
        `--- /dev/null\n+++ b/${ch.path}\n` +
        text.split("\n").map((l) => "+" + l).join("\n");
    } else {
      body = await api.gitFileDiff(root, ch.path, staged);
      if (!body.trim()) body = await api.gitFileDiff(root, ch.path, !staged);
    }
    patch = {
      title: ch.path,
      sub: ch.untracked
        ? t("code.untracked")
        : staged
          ? t("code.stagedSide")
          : t("code.unstagedSide"),
      body: body.trim() ? body : t("code.noDiff"),
    };
    mid = "patch";
    paintMid();
  } catch (e: any) {
    deps?.toast(String(e?.message ?? e));
  }
}

// ---------------------------------------------------------------- git actions

async function stage(paths: string[], unstage: boolean): Promise<void> {
  if (!root || !paths.length) return;
  try {
    await api.gitStage(root, paths, unstage);
    await refreshGit();
    paintChanges();
    paintTree();
  } catch (e: any) {
    deps?.toast(String(e?.message ?? e));
  }
}

/**
 * Commit. Local and reversible, so it is not gated, but the user sees the
 * exact list of what goes in before it runs, which is what the gate would have
 * been there for.
 */
async function commitStaged(): Promise<void> {
  if (!root) return;
  const msg = commitMessage.trim();
  if (!msg) {
    deps?.toast(t("code.commitNoMessage"));
    return;
  }
  const staged = changes.filter((c) => c.staged);
  if (!staged.length) {
    deps?.toast(t("code.commitNothing"));
    return;
  }
  const ok = await confirmModal(
    t("code.commitTitle"),
    t("code.commitSub").replace("%n", String(staged.length)).replace("%b", git?.branch ?? "?"),
    `<div class="ccommit"><div class="cmsg">${esc(msg)}</div><div class="cfiles">${staged
      .map((c) => `<div class="cf"><span class="gs ${c.index === "A" ? "add" : c.index === "D" ? "del" : "mod"}">${esc(c.index)}</span><span class="mono">${esc(c.path)}</span></div>`)
      .join("")}</div></div>`,
    t("code.commitDo")
  );
  if (!ok) return;
  try {
    const out = await api.gitCommit(root, msg, false);
    commitMessage = "";
    await refreshGit();
    await refreshHistory();
    paintLeft();
    paintTree();
    deps?.toast(t("code.commitDone").replace("%s", out.trim()), "ok");
  } catch (e: any) {
    deps?.toast(String(e?.message ?? e));
  }
}

/**
 * Push. Network, and a branch other people read: it is gated explicitly, the
 * dialog names the remote, the branch and how many commits are going, and no
 * standing rule can ever make it silent.
 */
async function push(): Promise<void> {
  if (!root || !git) return;
  if (!git.upstream || git.ahead === 0) return;
  const detail = t("code.pushDetail")
    .replace("%n", String(git.ahead))
    .replace("%b", git.branch)
    .replace("%u", git.upstream);
  const ok = await deps!.ask({ kind: "git", detail, elevated: false, noAlways: true });
  if (!ok) return;
  try {
    const out = await api.gitPush(root);
    await refreshGit();
    paintLeft();
    paintHead();
    deps?.toast(out.trim().split("\n").slice(-1)[0] || t("code.pushDone"), "ok");
  } catch (e: any) {
    deps?.toast(String(e?.message ?? e));
  }
}

/** Pull. Same treatment as push, and never folded into the same button. */
async function pull(): Promise<void> {
  if (!root || !git) return;
  if (!git.upstream) return;
  const detail = t("code.pullDetail")
    .replace("%n", String(git.behind))
    .replace("%u", git.upstream)
    .replace("%b", git.branch);
  const ok = await deps!.ask({ kind: "git", detail, elevated: false, noAlways: true });
  if (!ok) return;
  try {
    const out = await api.gitPull(root, false);
    await refreshGit();
    await refreshHistory();
    treeCache.clear();
    await loadDir("");
    // The file list, the symbol index and the language service all hold a
    // photograph of the tree. A pull is one of the two moments the app KNOWS
    // it moved, so all three are told.
    indexStale = false;
    await api.searchFiles(root, true).catch(() => []);
    await api.symbolsIndex(root, true).catch(() => 0);
    await tsintel?.refreshSnapshot().catch(() => null);
    await reloadOpenFromDisk();
    paintAll();
    deps?.toast(out.trim().split("\n").slice(-1)[0] || t("code.pullDone"), "ok");
  } catch (e: any) {
    deps?.toast(String(e?.message ?? e));
  }
}

async function checkout(branch: string, create: boolean): Promise<void> {
  if (!root) return;
  if (proposals.size > 0) {
    deps?.toast(t("code.branchPending"));
    return;
  }
  try {
    await api.gitCheckout(root, branch, create);
    treeCache.clear();
    await refreshGit();
    await refreshBranches();
    await refreshHistory();
    await loadDir("");
    await reloadOpenFromDisk();
    indexStale = false;
    await api.searchFiles(root, true).catch(() => []);
    await api.symbolsIndex(root, true).catch(() => 0);
    await tsintel?.refreshSnapshot().catch(() => null);
    paintAll();
  } catch (e: any) {
    deps?.toast(String(e?.message ?? e));
  }
}

/** A confirmation dialog in the app's own modal language. */
function confirmModal(title: string, sub: string, bodyHtml: string, okLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const m = el(`<div class="modal-bd"><div class="modal wide">
      <h3>${esc(title)}</h3>
      <div class="ps">${esc(sub)}</div>
      ${bodyHtml}
      <div class="acts">
        <button class="bs" data-x="0">${esc(t("conn.cancel"))}</button>
        <button class="bp" data-x="1">${esc(okLabel)}</button>
      </div></div></div>`);
    m.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("[data-x]") as HTMLElement | null;
      if (!b) return;
      m.remove();
      resolve(b.dataset.x === "1");
    });
    document.body.appendChild(m);
  });
}

/** The same shell, with one text field. Resolves null when cancelled. */
function promptModal(title: string, sub: string, placeholder: string): Promise<string | null> {
  return new Promise((resolve) => {
    const m = el(`<div class="modal-bd"><div class="modal">
      <h3>${esc(title)}</h3>
      <div class="ps">${esc(sub)}</div>
      <div class="cbox"><input id="pmv" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false"/></div>
      <div class="acts">
        <button class="bs" data-x="0">${esc(t("conn.cancel"))}</button>
        <button class="bp" data-x="1">${esc(t("code.create"))}</button>
      </div></div></div>`);
    const input = m.querySelector<HTMLInputElement>("#pmv")!;
    const done = (ok: boolean) => {
      m.remove();
      resolve(ok ? input.value.trim() || null : null);
    };
    m.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("[data-x]") as HTMLElement | null;
      if (b) done(b.dataset.x === "1");
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") done(true);
      else if (e.key === "Escape") done(false);
    });
    document.body.appendChild(m);
    input.focus();
  });
}

// ---------------------------------------------------------------- painting

function paintAll(): void {
  paintHead();
  paintLeft();
  paintMid();
}

function paintHead(): void {
  const box = document.getElementById("codehead");
  if (!box) return;
  box.innerHTML = headHtml();
}

function headHtml(): string {
  if (!root) return "";
  const g = git;
  const branch = g?.repo
    ? `<span class="cpill"><span class="d"></span>${esc(g.branch || "HEAD")}${
        g.ahead ? `<span class="s">↑${g.ahead}</span>` : ""
      }${g.behind ? `<span class="s">↓${g.behind}</span>` : ""}</span>`
    : g === undefined
      ? `<span class="cpill off">${esc(t("code.loading"))}</span>`
      : `<span class="cpill off">${esc(g && !g.available ? t("code.gitUnavailable") : t("code.noRepo"))}</span>`;
  // Pull and Push carry their counts and go inert with a reason rather than
  // firing and answering with a toast.
  const netButtons = g?.repo
    ? `<button class="bs" id="cpull" ${g.upstream ? "" : "disabled"} title="${esc(
        g.upstream ? t("code.pullDone") : t("code.noUpstream")
      )}">${esc(t("code.pull"))}${g.behind ? ` ↓${g.behind}` : ""}</button>` +
      `<button class="bs" id="cpush" ${g.upstream && g.ahead ? "" : "disabled"} title="${esc(
        !g.upstream ? t("code.noUpstream") : g.ahead ? t("code.push") : t("code.nothingToPush")
      )}">${esc(t("code.push"))}${g.ahead ? ` ↑${g.ahead}` : ""}</button>`
    : "";
  return (
    `<span class="cpath mono" title="${esc(root)}">${LRM}${esc(root)}</span>` +
    branch +
    netButtons +
    `<button class="bs" id="cpick">${esc(t("code.change"))}</button>` +
    `<button class="bs" id="cprevt">${esc(t("prev.toggle"))}</button>` +
    `<button class="bs" id="ctermt">${esc(t("term.toggle"))}</button>` +
    `<button class="iconbtn cagentt" id="cagentt" title="${esc(t("code.agentPane"))}">☰</button>`
  );
}

function tabStripHtml(keys: LeftTab[], extra = ""): string {
  return `<div class="seg sm fill ctabs ${extra}">
    ${keys
      .map((k) => {
        const n =
          k === "changes" && git?.repo
            ? changes.length
            : k === "search" && searchState.hits.length
              ? searchState.hits.length
              : 0;
        return `<button class="${leftTab === k ? "on" : ""}" data-tab="${k}">${esc(
          t("code.tab." + k)
        )}${n ? `<span class="n">${n > 999 ? "999+" : n}</span>` : ""}</button>`;
      })
      .join("")}
  </div>`;
}

function paintLeft(): void {
  const box = document.getElementById("codeleft");
  if (!box) return;
  box.innerHTML = "";
  // Two rows, because they are two subjects: what the folder contains, and
  // what the repository thinks of it. Six labels never fit on one 274 px line
  // in either language, and abbreviating them would cost more than a row.
  box.appendChild(el(tabStripHtml(EXPLORER_TABS)));
  box.appendChild(el(tabStripHtml(GIT_TABS, "git")));
  box.appendChild(el(`<div class="cpending" id="codepending"></div>`));
  box.appendChild(el(`<div class="cpanel" id="codepanel"></div>`));
  paintPending();
  paintPanel();
}

function paintPanel(): void {
  const box = document.getElementById("codepanel");
  if (!box) return;
  if (leftTab === "files") {
    // "Loading" and "empty" are two different screens. They used to be one
    // blank column.
    box.innerHTML = treeCache.has("")
      ? treeCache.get("")!.length
        ? `<div class="ctree" id="ctree">${treeRowsHtml("", 0)}</div>`
        : `<div class="cempty">${esc(t("code.emptyFolder"))}</div>`
      : skeletonRows(9);
    return;
  }
  if (leftTab === "search") {
    box.innerHTML = searchPanelHtml(searchState);
    return;
  }
  if (leftTab === "outline") {
    box.innerHTML = outlinePanelHtml();
    return;
  }
  if (git === undefined) {
    box.innerHTML = skeletonRows(6);
    return;
  }
  if (leftTab === "changes") {
    box.innerHTML = changesHtml();
    const ta = box.querySelector<HTMLTextAreaElement>("#cmsg");
    if (ta) {
      ta.value = commitMessage;
      ta.addEventListener("input", () => {
        commitMessage = ta.value;
        const b = document.getElementById("cdocommit") as HTMLButtonElement | null;
        if (b) b.disabled = !commitMessage.trim() || !changes.some((c) => c.staged);
      });
    }
    return;
  }
  if (leftTab === "history") {
    box.innerHTML = historyHtml();
    return;
  }
  box.innerHTML = branchesHtml();
}

function paintTree(): void {
  if (leftTab !== "files") return;
  const box = document.getElementById("ctree");
  if (!box) {
    paintPanel();
    return;
  }
  box.innerHTML = treeRowsHtml("", 0);
}

function paintChanges(): void {
  if (leftTab === "changes") paintPanel();
  const b = document.querySelector<HTMLElement>('.ctabs [data-tab="changes"]');
  if (b) {
    const n = git?.repo ? changes.length : 0;
    b.innerHTML = `${esc(t("code.tab.changes"))}${n ? `<span class="n">${n}</span>` : ""}`;
  }
}

function paintPending(): void {
  const box = document.getElementById("codepending");
  if (!box) return;
  const list = pendingPaths();
  if (!list.length) {
    box.innerHTML = "";
    box.style.display = "none";
    return;
  }
  const active = docs.activeRel();
  box.style.display = "block";
  box.innerHTML =
    `<div class="eyebrow ph">${esc(t("code.pendingTitle").replace("%n", String(list.length)))}</div>` +
    list
      .map(
        (p) =>
          `<div class="prow ${active === p ? "on" : ""}" data-open="${esc(p)}"><span class="dot">◆</span><span class="nm mono" title="${esc(p)}">${esc(baseName(p))}</span><span class="x" data-drop="${esc(p)}" title="${esc(t("code.discard"))}">×</span></div>`
      )
      .join("");
}

/** The panel every git tab falls back to when git cannot answer. */
function gitBlockedHtml(): string {
  if (git && !git.available) {
    return (
      `<div class="empty-block small"><span class="big">⌥</span>` +
      `<b>${esc(t("code.gitUnavailable"))}</b>` +
      `<span>${esc(t("code.gitUnavailableBody"))}</span></div>`
    );
  }
  return `<div class="cempty">${esc(t("code.noRepoHint"))}</div>`;
}

function changesHtml(): string {
  if (!git?.repo) return gitBlockedHtml();
  const staged = changes.filter((c) => c.staged);
  const unstaged = changes.filter((c) => c.unstaged && !c.untracked);
  const untracked = changes.filter((c) => c.untracked);
  const group = (title: string, rows: GitChange[], action: "stage" | "unstage") => {
    if (!rows.length) return "";
    return (
      `<div class="cgh eyebrow">${esc(title)}<span class="n">${rows.length}</span>` +
      `<span class="all" data-all="${action}">${esc(action === "stage" ? t("code.stageAll") : t("code.unstageAll"))}</span></div>` +
      rows
        .map(
          (c) =>
            `<div class="crow" data-change="${esc(c.path)}" data-side="${action === "unstage" ? "staged" : "work"}">` +
            `<span class="gs ${c.untracked ? "unt" : (action === "unstage" ? c.index : c.work) === "A" ? "add" : (action === "unstage" ? c.index : c.work) === "D" ? "del" : "mod"}">${esc(c.untracked ? "?" : action === "unstage" ? c.index : c.work)}</span>` +
            `<span class="nm mono" title="${esc(c.path)}">${LRM}${esc(c.path)}</span>` +
            `<span class="act" data-${action}="${esc(c.path)}">${esc(action === "stage" ? "+" : "−")}</span></div>`
        )
        .join("")
    );
  };
  const canCommit = staged.length > 0 && commitMessage.trim().length > 0;
  return (
    group(t("code.staged"), staged, "unstage") +
    group(t("code.unstaged"), unstaged, "stage") +
    group(t("code.untrackedGroup"), untracked, "stage") +
    (changes.length === 0 ? `<div class="cempty">${esc(t("code.clean"))}</div>` : "") +
    `<div class="cbox">
       <textarea id="cmsg" rows="3" placeholder="${esc(t("code.commitPlaceholder"))}"></textarea>
       <button class="bp" id="cdocommit" ${canCommit ? "" : "disabled"}>${esc(t("code.commit").replace("%n", String(staged.length)))}</button>
     </div>`
  );
}

function historyHtml(): string {
  if (!git?.repo) return gitBlockedHtml();
  const open = docs.activeRel();
  const filter = open
    ? `<div class="cfilter"><label><input type="checkbox" id="chfilter" ${historyPath ? "checked" : ""}/> ${esc(t("code.historyFile").replace("%s", baseName(open)))}</label></div>`
    : "";
  if (!commits.length) return filter + `<div class="cempty">${esc(t("code.noCommits"))}</div>`;
  return (
    filter +
    commits
      .map(
        (c) =>
          `<div class="hrow" data-commit="${esc(c.hash)}"><div class="l1"><span class="sh mono">${esc(c.short)}</span><span class="sj">${esc(c.subject)}</span></div>` +
          `<div class="l2">${esc(c.author)} · ${esc(c.when.slice(0, 10))}</div></div>`
      )
      .join("")
  );
}

function branchesHtml(): string {
  if (!git?.repo) return gitBlockedHtml();
  return (
    branches
      .map(
        (b) =>
          `<div class="brow ${b === git!.branch ? "on" : ""}" data-branch="${esc(b)}"><span class="d"></span><span class="nm mono">${esc(b)}</span></div>`
      )
      .join("") +
    `<div class="cbox"><input id="cnewbranch" placeholder="${esc(t("code.newBranch"))}" autocomplete="off"/><button class="bs" id="cmkbranch">${esc(t("code.create"))}</button></div>`
  );
}

let lastTabsHtml = "";

function paintTabs(): void {
  const host = document.getElementById("ctabshost");
  if (!host) return;
  lastTabsHtml = tabsHtml(docs.list(), docs.activeRel(), new Set(proposals.keys()), {
    close: t("code.tabClose"),
    unsaved: t("code.unsaved"),
    proposed: t("code.reviewing"),
  });
  host.innerHTML = lastTabsHtml;
}

/**
 * The strip on a keystroke. Rendering it is cheap, but replacing the DOM of a
 * bar the pointer may be hovering, sixty times a second, is not: only a real
 * change (the dirty dot appearing, a proposal landing) redraws it.
 */
function paintTabsIfChanged(): void {
  const host = document.getElementById("ctabshost");
  if (!host) return;
  const next = tabsHtml(docs.list(), docs.activeRel(), new Set(proposals.keys()), {
    close: t("code.tabClose"),
    unsaved: t("code.unsaved"),
    proposed: t("code.reviewing"),
  });
  if (next === lastTabsHtml) return;
  lastTabsHtml = next;
  host.innerHTML = next;
}

function paintFileHead(): void {
  const box = document.getElementById("cfilehead");
  if (!box) return;
  box.innerHTML = fileHeadHtml();
}

/**
 * The Rust server's state as a badge, or nothing.
 *
 * Only on .rs files, and only when there is something honest to add: on a
 * ready server with a full toolchain `rustTierNote()` returns null and the
 * tier badge already says everything. The fallback English comes from the
 * module itself, so the badge is never a raw key.
 */
function rustBadgeHtml(rel: string): string {
  if (!isRust(rel)) return "";
  const note = rustTierNote();
  if (!note) return "";
  const translated = t(note.key);
  const text = (translated === note.key ? note.fallback : translated).replace("%s", note.detail);
  return `<span class="fbadge rustlsp" title="${esc(text)}">${esc(text)}</span>`;
}

function fileHeadHtml(): string {
  const d = docs.active();
  if (!d) return "";
  const pending = d.mergeBase !== null;
  const dirty = !pending && docs.isDirty(d.rel);
  return (
    `<span class="fp mono" title="${esc(d.rel)}">${LRM}${esc(d.rel)}</span>` +
    tierBadgeHtml(tierFor(d.rel, tsActive(), rustReady())) +
    // The Rust server's own state, next to the tier it produced. "Starting",
    // "indexing" and "limited: no cargo" are three different answers to "why
    // is this file only Syntax", and a badge that says only "Syntax" makes all
    // three read as a bug.
    rustBadgeHtml(d.rel) +
    (deps?.autoTabReady() && !pending ? `<span class="fbadge autotab">${esc(t("code.autoTabReady"))}</span>` : "") +
    (pending ? `<span class="fbadge">${esc(t("code.reviewing"))}</span>` : "") +
    (dirty ? `<span class="fbadge dirty">${esc(t("code.unsaved"))}</span>` : "") +
    `<span class="grow"></span>` +
    (pending
      ? `<button class="bs" id="frejall">${esc(t("code.rejectAll"))}</button><button class="bp" id="faccall">${esc(t("code.acceptAll"))}</button>`
      : `<button class="bs" id="fsave" ${dirty ? "" : "disabled"}>${esc(t("code.save"))}</button>`)
  );
}

function paintMid(): void {
  const box = document.getElementById("codemid");
  if (!box) return;
  if (editor) docs.capture(editor, editor.scrollSnapshot());
  editor?.destroy();
  editor = null;
  box.innerHTML = "";

  if (mid === "patch" && patch) {
    box.appendChild(
      el(`<div class="cfilehead">
        <span class="fp mono" title="${esc(patch.title)}">${LRM}${esc(patch.title)}</span>
        <span class="fsub">${esc(patch.sub)}</span>
        <span class="grow"></span>
        <button class="bs" id="fpatchclose">${esc(t("code.backToEditor"))}</button>
      </div>`)
    );
    box.appendChild(el(`<div class="cpatch diffpane">${patchHtml(patch.body)}</div>`));
    return;
  }
  if (mid === "refs") {
    box.appendChild(
      el(`<div class="cfilehead">
        <span class="fp">${esc(t("code.tab.refs"))}</span>
        <span class="fsub">${esc(docs.activeRel() ?? "")}</span>
        <span class="grow"></span>
        <button class="bs" id="fpatchclose">${esc(t("code.backToEditor"))}</button>
      </div>`)
    );
    box.appendChild(el(`<div class="crefs">${refsHtml}</div>`));
    return;
  }

  // The tab strip lives above the file header and survives every repaint of
  // the pane below it.
  box.appendChild(el(`<div id="ctabshost"></div>`));

  const d = docs.active();
  if (!d) {
    box.appendChild(
      el(`<div class="cempty-wrap"><div class="empty-block">
        <span class="big">⌘</span>
        <b>${esc(t("code.pickFileTitle"))}</b>
        <span>${esc(t("code.pickFile"))}</span>
      </div></div>`)
    );
    paintTabs();
    return;
  }
  box.appendChild(el(`<div class="cfilehead" id="cfilehead">${fileHeadHtml()}</div>`));
  if (d.error) {
    box.appendChild(
      el(`<div class="cerror"><b>${esc(t("code.cannotOpen"))}</b><span class="mono">${esc(d.error)}</span></div>`)
    );
    paintTabs();
    return;
  }
  if (d.mergeBase !== null) {
    box.appendChild(el(`<div class="creviewbar">${esc(t("code.reviewHint"))}</div>`));
  }
  box.appendChild(el(`<div class="cmhost" id="cmhost"></div>`));
  paintTabs();
  mountEditor();
}

/**
 * The cheap repaint. Rebuilding the whole middle column on every keystroke
 * would throw the EditorView away, which is the exact thing the Doc registry
 * exists to stop.
 */
function paintEditorChrome(): void {
  paintTabs();
  paintFileHead();
}

// ---------------------------------------------------------------- terminal

let terminal: TerminalPanel | null = null;
let termOpen = false;

/**
 * The cell box, measured once against the real font.
 *
 * Hard coding it would be wrong twice: on the first paint the webfont has not
 * loaded, and at any other zoom level the metric moves. A cell width off by a
 * pixel puts the child's column count out by several columns on a wide pane,
 * and the shell then wraps in the wrong place for the rest of the session.
 */
let cellBox: { width: number; height: number } | null = null;

function measureCell(): { width: number; height: number } {
  if (cellBox) return cellBox;
  const probe = el(
    `<span style="position:absolute;visibility:hidden;white-space:pre;` +
      `font-family:var(--mono);font-size:12px;line-height:1.35">${"M".repeat(100)}</span>`
  );
  document.body.appendChild(probe);
  const r = probe.getBoundingClientRect();
  probe.remove();
  const box = { width: r.width / 100, height: r.height };
  // Before the webfont resolves the probe can measure zero. Never cache a
  // zero: gridSizeFor would then fall back to 80x24 for the rest of the
  // session, whatever the pane is really worth.
  if (box.width > 0 && box.height > 0) cellBox = box;
  return cellBox ?? { width: 7.2, height: 16.2 };
}

const terminalHost: TerminalHost = {
  spawn: (r) => api.ptySpawn(r.cwd, r.cols, r.rows, r.owner),
  write: (r) => api.ptyWrite(r.id, r.data, r.origin, r.gated),
  resize: (id, cols, rows) => api.ptyResize(id, cols, rows),
  kill: (id) => api.ptyKill(id),
  onOutput: (cb) => {
    let off: (() => void) | null = null;
    let cancelled = false;
    void onEvent("galactus://pty", (p: PtyOutputEvent) => cb(p)).then((u) => {
      // The panel may have been disposed before the subscription resolved.
      if (cancelled) u();
      else off = u;
    });
    return () => {
      cancelled = true;
      off?.();
      off = null;
    };
  },
  // The SAME dialog `run_command` raises, with the same `shell` kind. A
  // terminal must never get a cheaper permission than the tool that does the
  // identical thing, or the terminal becomes the way round the gate.
  //
  // `deps.ask` answers with a boolean, and decideTerminalWrite wants a
  // decision, so the mapping is to "once" and never to "always". That is the
  // conservative direction: a standing licence would have to be granted by the
  // app's own permission queue, which is where standing rules belong, and
  // never invented here.
  requestShellPermission: async (detail: string) => {
    const req: PermissionRequest = { kind: "shell", detail, elevated: isElevatedCommand(detail) };
    const ok = (await deps?.ask(req)) ?? false;
    return ok ? "once" : "deny";
  },
};

/** Kill every terminal. Called when the workspace changes: the cwd is gone. */
function disposeTerminal(): void {
  terminal?.dispose();
  terminal = null;
  termOpen = false;
}

function toggleTerminal(wrap: HTMLElement): void {
  termOpen = !termOpen;
  mountTerminal(wrap);
  mountPreview(wrap);
}

/**
 * Put the terminal into THIS instance of the Code view.
 *
 * The panel object outlives the DOM on purpose. `render()` in main.ts rebuilds
 * the whole view on every navigation, and disposing here would mean switching
 * to Chat and back kills the user's shells, including whatever long build was
 * running in them. The panel's element is simply re-parented into the new
 * host, which is why `TerminalPanel` never assumes it is connected.
 */
function mountTerminal(wrap: HTMLElement): void {
  const box = wrap.querySelector<HTMLElement>("#codeterm");
  const midwrap = wrap.querySelector<HTMLElement>("#codemidwrap");
  if (!box || !midwrap) return;
  midwrap.classList.toggle("showterm", termOpen);
  if (!termOpen) return;
  if (!terminal) {
    terminal = new TerminalPanel({
      host: terminalHost,
      root: () => root,
      repaint: () => undefined, // the panel drives its own frame-scheduled paint
      toast: (m) => deps?.toast(m),
      // Closing the last tab closes the pane. The panel object survives, so the
      // Terminal button reopens instantly with a fresh shell; what goes is the
      // third of the editor that was being spent on a sentence saying there was
      // no terminal.
      onEmpty: () => {
        if (!termOpen) return;
        termOpen = false;
        mountTerminal(wrap);
  mountPreview(wrap);
      },
      cell: measureCell,
    });
  }
  box.appendChild(terminal.element());
  terminal.paint();
  // The pane was display:none until now, so it measured zero: size it only
  // once it is really on screen and has a box.
  requestAnimationFrame(() => {
    if (!terminal) return;
    if (terminal.controller.sessions.size === 0) void terminal.openSession();
    else terminal.fit();
  });
}

// ---------------------------------------------------------------- view

export function codeView(): HTMLElement {
  const wrap = el(`<div class="main">
    <div class="topbar" data-tauri-drag-region>
      <span class="ttl">${esc(t("nav.code"))}</span>
      <div class="right" id="codehead"></div>
    </div>
    <div class="codebody">
      <div class="codeleft" id="codeleft"></div>
      <div class="pane-splitter code-left-splitter" id="codeleftsplit"></div>
      <div class="codemidwrap" id="codemidwrap">
        <div class="codemid" id="codemid"></div>
        <div class="codeterm" id="codeterm"></div>
      </div>
      <div class="pane-splitter code-agent-splitter" id="codeagentsplit"></div>
      <div class="codeside" id="codeside"></div>
    </div>
  </div>`);

  if (!root) {
    wrap.querySelector(".codebody")!.remove();
    const onb = el(`<div class="page"><div class="hold narrow">
      <div class="empty-block">
        <span class="big">⌘</span>
        <b>${esc(t("code.openTitle"))}</b>
        <span>${esc(t("code.openBody"))}</span>
        <button class="bp" id="copen" style="margin-top:12px">${esc(t("code.openFolder"))}</button>
      </div>
    </div></div>`);
    onb.querySelector("#copen")!.addEventListener("click", () => void chooseWorkspace());
    wrap.appendChild(onb);
    return wrap;
  }

  // Top bar actions.
  wrap.querySelector("#codehead")!.innerHTML = headHtml();
  wrap.querySelector(".topbar")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
    if (!b || b.disabled) return;
    if (b.id === "cpick") void chooseWorkspace();
    else if (b.id === "cpush") void push();
    else if (b.id === "cpull") void pull();
    else if (b.id === "cagentt") wrap.querySelector(".codebody")!.classList.toggle("showagent");
    else if (b.id === "ctermt") toggleTerminal(wrap);
    else if (b.id === "cprevt") togglePreview(wrap);
  });

  // Left column: tabs, pending proposals, tree / search / outline / git.
  const left = wrap.querySelector<HTMLElement>("#codeleft")!;
  const routeSearch = (e: Event): boolean => {
    if (leftTab !== "search") return false;
    onSearchPanelEvent(e, searchState, searchDeps());
    return true;
  };
  left.addEventListener("input", routeSearch);
  left.addEventListener("keydown", routeSearch);
  left.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;

    const tab = target.closest("[data-tab]") as HTMLElement | null;
    if (tab) {
      const next = tab.dataset.tab as LeftTab;
      if (leftTab === "search" && next !== "search") void cancelSearch(searchState, searchDeps());
      leftTab = next;
      void (async () => {
        if (leftTab === "history") await refreshHistory();
        if (leftTab === "branches") await refreshBranches();
        paintLeft();
        if (leftTab === "outline") void computeOutline();
        if (leftTab === "search") document.getElementById("srchq")?.focus();
      })();
      return;
    }

    // The search panel owns everything inside it.
    if (leftTab === "search" && target.closest(".srch")) {
      onSearchPanelEvent(e, searchState, searchDeps());
      return;
    }

    const out = target.closest("[data-outline]") as HTMLElement | null;
    if (out && editor) {
      const anchor = Number(out.dataset.outline);
      editor.dispatch({
        selection: { anchor },
        effects: EditorView.scrollIntoView(anchor, { y: "center" }),
      });
      editor.focus();
      paintOutline();
      return;
    }

    const drop = target.closest("[data-drop]") as HTMLElement | null;
    if (drop) {
      e.stopPropagation();
      void discardProposal(drop.dataset.drop!);
      return;
    }
    const openProp = target.closest("[data-open]") as HTMLElement | null;
    if (openProp) {
      void openFile(openProp.dataset.open!);
      return;
    }

    const dir = target.closest("[data-dir]") as HTMLElement | null;
    if (dir) {
      const p = dir.dataset.dir!;
      void (async () => {
        if (expanded.has(p)) expanded.delete(p);
        else {
          expanded.add(p);
          if (!treeCache.has(p)) await loadDir(p);
        }
        paintTree();
      })();
      return;
    }
    const file = target.closest("[data-file]") as HTMLElement | null;
    if (file) {
      void openFile(file.dataset.file!);
      return;
    }

    const st = target.closest("[data-stage]") as HTMLElement | null;
    if (st) {
      e.stopPropagation();
      void stage([st.dataset.stage!], false);
      return;
    }
    const un = target.closest("[data-unstage]") as HTMLElement | null;
    if (un) {
      e.stopPropagation();
      void stage([un.dataset.unstage!], true);
      return;
    }
    const all = target.closest("[data-all]") as HTMLElement | null;
    if (all) {
      const unstage = all.dataset.all === "unstage";
      const paths = changes.filter((c) => (unstage ? c.staged : c.unstaged || c.untracked)).map((c) => c.path);
      void stage(paths, unstage);
      return;
    }
    const chg = target.closest("[data-change]") as HTMLElement | null;
    if (chg) {
      const c = changes.find((x) => x.path === chg.dataset.change);
      if (c) void showChange(c, chg.dataset.side === "staged");
      return;
    }
    if (target.id === "cdocommit") {
      void commitStaged();
      return;
    }

    const commit = target.closest("[data-commit]") as HTMLElement | null;
    if (commit) {
      const c = commits.find((x) => x.hash === commit.dataset.commit);
      if (c) void showCommit(c);
      return;
    }
    if (target.id === "chfilter") {
      historyPath = (target as HTMLInputElement).checked ? docs.activeRel() : null;
      void refreshHistory().then(paintPanel);
      return;
    }

    const br = target.closest("[data-branch]") as HTMLElement | null;
    if (br && br.dataset.branch !== git?.branch) {
      void checkout(br.dataset.branch!, false);
      return;
    }
    if (target.id === "cmkbranch") {
      const inp = document.getElementById("cnewbranch") as HTMLInputElement | null;
      const name = inp?.value.trim() ?? "";
      if (name) void checkout(name, true);
      return;
    }
  });

  // Middle column: the tab strip, then the file header's own buttons.
  const midBox = wrap.querySelector<HTMLElement>("#codemid")!;
  midBox.addEventListener("click", (e) => {
    const tab = onTabsClick(e as MouseEvent);
    if (tab) {
      if (tab.action === "close") {
        if (editor) docs.capture(editor, editor.scrollSnapshot());
        forgetPython(tab.rel);
        closeRustBuffer(tab.rel);
        docs.close(tab.rel);
        paintMid();
        paintTree();
      } else if (tab.rel !== docs.activeRel()) {
        docs.activate(tab.rel);
        mountEditor();
        paintEditorChrome();
        paintTree();
      }
      return;
    }
    const b = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
    if (!b || b.disabled) return;
    if (b.id === "fsave") void saveOpenFile();
    else if (b.id === "faccall") void acceptAll();
    else if (b.id === "frejall") void rejectAll();
    else if (b.id === "fpatchclose") {
      mid = "editor";
      patch = null;
      paintMid();
    }
  });

  // A reference row jumps to its site, exactly like a search hit.
  midBox.addEventListener("click", (e) => {
    const r = (e.target as HTMLElement).closest("[data-ref-file]") as HTMLElement | null;
    if (!r) return;
    mid = "editor";
    void openFile(r.dataset.refFile!).then(() =>
      revealLine(Number(r.dataset.refLine), Number(r.dataset.refCol))
    );
  });

  // Right column: the SAME agent thread as the Chat view.
  const body = wrap.querySelector<HTMLElement>(".codebody")!;
  const side = wrap.querySelector<HTMLElement>("#codeside")!;
  deps?.mountAgent(side);
  wirePaneResizer({
    handle: wrap.querySelector<HTMLElement>("#codeleftsplit")!,
    container: body,
    pane: left,
    edge: "before",
    setting: "ui_code_left_width",
    label: t("layout.resizeFiles"),
    hint: t("layout.resizeHint"),
    min: 180,
    max: 420,
    defaultSize: 250,
    reserved: () => 340 + (side.offsetParent ? side.offsetWidth : 0),
  });
  wirePaneResizer({
    handle: wrap.querySelector<HTMLElement>("#codeagentsplit")!,
    container: body,
    pane: side,
    edge: "after",
    setting: "ui_code_agent_width",
    label: t("layout.resizeAgent"),
    hint: t("layout.resizeHint"),
    min: 280,
    max: 560,
    defaultSize: 380,
    reserved: () => 340 + left.offsetWidth,
  });

  // Painted on the next microtask: render() has not attached this element
  // yet, and every paint below finds its host by id.
  void (async () => {
    await Promise.resolve();
    paintLeft();
    paintMid();
    if (!treeCache.has("")) await loadDir("");
    await refreshGit();
    if (leftTab === "history") await refreshHistory();
    if (leftTab === "branches") await refreshBranches();
    paintHead();
    paintLeft();
    paintMid();
    mountTerminal(wrap);
  mountPreview(wrap);
    await startWorkspaceServices();
  })();

  return wrap;
}

// ---------------------------------------------------------------- keyboard

/**
 * Shortcuts the shell forwards when the Code view is on screen. Returns true
 * when the key was consumed.
 */
export function codeShortcut(key: string, shift: boolean): boolean {
  if (!root) return false;
  if (paletteOpen()) {
    closePalette();
    return true;
  }
  if (!shift && key === "p") {
    openPalette("files");
    return true;
  }
  if (shift && key === "o") {
    openPalette("symbols");
    return true;
  }
  if (shift && key === "f") {
    openProjectSearch();
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- boot

/**
 * Wire the language-agnostic tiers once, at module init. Both registries are
 * owned here, and Python is registered AFTER the grammar pass so its exact
 * CPython message wins the de-duplication for .py files.
 */
setDiagTranslator(t);
setTierTranslator(t);

// The Rust tier. The transport is the five Tauri commands and nothing more;
// everything else about LSP (framing, correlation, the read-only allowlist)
// lives in src-tauri/src/lsp.rs, and everything about the editor side lives in
// code/rust-lsp.ts.
configureRustLsp({
  start: (r) => api.rustLspStart(r),
  stop: () => api.rustLspStop(),
  request: (method, params, timeoutMs) => api.rustLspRequest(method, params, timeoutMs),
  notify: (method, params) => api.rustLspNotify(method, params),
  listen: (handler) => onEvent("galactus://rust-lsp", handler),
  log: (line) => console.debug(line),
});
registerRustLsp({
  registerDiagnostics: (id, source) => registerDiagnosticSource(id, source),
  // Diagnostics are UNSOLICITED in LSP, and the editor's linter is debounced,
  // so without this the gutter shows the pre-fix set until the user types
  // again. `forceLinting` is the only way to ask CodeMirror to re-run a
  // debounced linter out of band.
  refresh: (rel) => {
    if (editor && docs.byView(editor)?.rel === rel) forceLinting(editor);
  },
});
registerTreeDiagnostics((id, src) =>
  registerDiagnosticSource(id, async (state, rel) => {
    // The grammar pass says nothing about Python: CPython answers for it, one
    // registration below, and two messages for one error help nobody.
    if (isPython(rel)) return [];
    return (await src(state, rel)) as Diagnostic[];
  })
);
registerDiagnosticSource("python", (state, rel) => pyDiagnostics(state, rel) as Promise<Diagnostic[]>);

// Keyboard: F2 renames through the language service, as proposals.
window.addEventListener("keydown", (e) => {
  if (e.key !== "F2" || !editor || !editor.hasFocus) return;
  e.preventDefault();
  void renameAtCaret();
});
