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

import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, ViewUpdate } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { getChunks, getOriginalDoc, unifiedMergeView } from "@codemirror/merge";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";

import { api, CodeEntry, GitChange, GitCommitInfo, GitInfo } from "./api";
import type { PermissionRequest } from "./agent";
import { t } from "./i18n";

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

type LeftTab = "files" | "changes" | "history" | "branches";

let root: string | null = null;
let openPath: string | null = null;
/** Text of the open file as it stands in the editor. */
let buffer = "";
/** Text of the open file as it stands on disk. */
let savedContent = "";
/** Error returned by the backend for the open file (binary, too large…). */
let openError: string | null = null;
/**
 * The merge view's base for the open file: the disk content the pending diff
 * is measured against, updated on every accepted hunk. null when the open file
 * has no pending proposal.
 */
let mergeBase: string | null = null;

const proposals = new Map<string, Proposal>();
const expanded = new Set<string>();
const treeCache = new Map<string, CodeEntry[]>();

let leftTab: LeftTab = "files";
let git: GitInfo | null = null;
let changes: GitChange[] = [];
let commits: GitCommitInfo[] = [];
let branches: string[] = [];
/** History filtered to one path, null for the whole repository. */
let historyPath: string | null = null;
let commitMessage = "";

/** What the middle column shows. */
let mid: "editor" | "patch" = "editor";
let patch: { title: string; sub: string; body: string } | null = null;

let editor: EditorView | null = null;
const mergeComp = new Compartment();
/** Serializes the writes triggered by accepted hunks. */
let writeChain: Promise<void> = Promise.resolve();


export function codeRoot(): string | null {
  return root;
}

export function pendingCount(): number {
  return proposals.size;
}

/** Restore the workspace chosen in a previous session. */
export async function initCodeRoot(saved: string | undefined): Promise<void> {
  if (!saved) return;
  root = saved.replace(/\/+$/, "");
  await refreshGit().catch(() => {});
}

// ---------------------------------------------------------------- proposals

/**
 * Called by the Agent when it writes a file inside the workspace. Nothing is
 * written here: the change is filed, and the user answers it in the editor.
 */
export async function fileProposal(path: string, rel: string, content: string): Promise<string> {
  if (!root) return "error: no code workspace is open";
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
  // The file on screen must show the diff at once; any other file is listed as
  // pending and opens on a click.
  if (openPath === rel) await openFile(rel);
  paintPending();
  paintTree();
  deps?.paintNav();
  deps?.toast(t("code.proposalToast").replace("%s", rel), "ok");
  return (
    `proposed: ${rel} is now a PENDING diff in the user's editor. Nothing was written to disk. ` +
    "They will accept or reject it hunk by hunk; do not assume the file changed, and do not " +
    "propose it again unless they ask."
  );
}

/** Every file with a pending proposal, in the order they arrived. */
export function pendingPaths(): string[] {
  return [...proposals.values()].sort((a, b) => a.created - b.created).map((p) => p.rel);
}

// ---------------------------------------------------------------- workspace

export async function chooseWorkspace(): Promise<void> {
  const p = await api.pickFolder();
  if (!p) return;
  await setWorkspace(p);
}

async function setWorkspace(p: string): Promise<void> {
  root = p.replace(/\/+$/, "");
  openPath = null;
  buffer = "";
  savedContent = "";
  openError = null;
  mergeBase = null;
  proposals.clear();
  expanded.clear();
  treeCache.clear();
  commits = [];
  branches = [];
  historyPath = null;
  mid = "editor";
  patch = null;
  await deps?.saveSetting("code_root", root);
  await refreshGit();
  await loadDir("");
  paintAll();
  deps?.paintNav();
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
  let out = "";
  for (const e of rows) {
    const pad = 8 + depth * 13;
    const pending = proposals.has(e.path);
    if (e.dir) {
      const open = expanded.has(e.path);
      out +=
        `<div class="trow dir ${open ? "open" : ""}" data-dir="${esc(e.path)}" style="padding-left:${pad}px">` +
        `<span class="tw">${open ? "▾" : "▸"}</span><span class="tn">${esc(e.name)}</span>${statusDot(e.status)}</div>`;
      if (open) out += treeRowsHtml(e.path, depth + 1);
    } else {
      out +=
        `<div class="trow file ${openPath === e.path ? "on" : ""} ${pending ? "pending" : ""}" data-file="${esc(e.path)}" style="padding-left:${pad + 13}px">` +
        `<span class="tn">${esc(e.name)}</span>${pending ? `<span class="gs prop">◆</span>` : ""}${statusDot(e.status)}</div>`;
    }
  }
  return out;
}

// ---------------------------------------------------------------- editor

function langFor(path: string) {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return [javascript({ jsx: ext === "jsx" })];
    case "ts":
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

function onEditorUpdate(u: ViewUpdate): void {
  if (!u.docChanged && !u.transactions.some((tr) => tr.effects.length > 0)) return;
  buffer = u.state.doc.toString();
  if (mergeBase === null) {
    paintFileHead();
    return;
  }
  // In merge mode the ORIGINAL document is the disk truth: it starts at the
  // file's current content and only moves when a hunk is accepted. A reject
  // rewrites the editor buffer instead and leaves it alone, which is exactly
  // why the disk never sees a rejected hunk.
  const original = getOriginalDoc(u.state).toString();
  if (original !== mergeBase) {
    mergeBase = original;
    writeAccepted(original);
  }
  const ch = getChunks(u.state);
  if (ch && ch.chunks.length === 0) {
    // Every hunk answered: leave review mode. Deferred, so the transaction
    // that resolved the last chunk finishes applying first.
    const path = openPath;
    setTimeout(() => {
      if (openPath === path) void finishReview();
    }, 0);
  }
}

/**
 * The ONLY place an accepted change reaches the disk. `content` is always the
 * merge view's original document, never the editor buffer.
 */
function writeAccepted(content: string): void {
  const path = openPath;
  if (!root || !path) return;
  writeChain = writeChain
    .then(() => api.codeWrite(root!, path, content))
    .then(async () => {
      savedContent = content;
      await refreshGit();
      await reloadTree();
      paintTree();
      paintChanges();
      paintFileHead();
    })
    .catch((e: any) => {
      deps?.toast(t("code.saveFail").replace("%s", String(e?.message ?? e)));
    });
}

/** All hunks answered: drop the proposal and go back to a plain editor. */
async function finishReview(): Promise<void> {
  if (!openPath) return;
  proposals.delete(openPath);
  mergeBase = null;
  await writeChain.catch(() => {});
  savedContent = buffer;
  paintMid();
  paintPending();
  deps?.paintNav();
}

function remountEditor(): void {
  const host = document.getElementById("cmhost");
  editor?.destroy();
  editor = null;
  if (!host || openPath === null || openError !== null) return;
  const merge =
    mergeBase !== null
      ? unifiedMergeView({
          original: mergeBase,
          mergeControls: true,
          gutter: true,
          collapseUnchanged: { margin: 3, minSize: 4 },
        })
      : [];
  editor = new EditorView({
    state: EditorState.create({
      doc: buffer,
      extensions: [
        keymap.of([
          {
            key: "Mod-s",
            run: () => {
              void saveOpenFile();
              return true;
            },
          },
        ]),
        basicSetup,
        oneDark,
        ...langFor(openPath),
        mergeComp.of(merge),
        EditorView.updateListener.of(onEditorUpdate),
      ],
    }),
    parent: host,
  });
}

export async function openFile(rel: string): Promise<void> {
  if (!root) return;
  openPath = rel;
  mid = "editor";
  patch = null;
  openError = null;
  mergeBase = null;
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
      openError = msg;
      buffer = "";
      savedContent = "";
      paintMid();
      paintTree();
      return;
    }
  }
  savedContent = exists ? disk : "";
  let prop = proposals.get(rel);
  if (prop && prop.after === savedContent) {
    // The disk caught up with the proposal (the user saved the same edit, or
    // git changed under it): there is nothing left to answer.
    proposals.delete(rel);
    prop = undefined;
    deps?.paintNav();
  }
  if (prop) {
    mergeBase = savedContent;
    buffer = prop.after;
  } else {
    buffer = savedContent;
  }
  paintMid();
  paintTree();
}

async function saveOpenFile(): Promise<void> {
  if (!root || !openPath) return;
  if (mergeBase !== null) {
    deps?.toast(t("code.saveBlocked"));
    return;
  }
  try {
    await api.codeWrite(root, openPath, buffer);
    savedContent = buffer;
    await refreshGit();
    await reloadTree();
    paintTree();
    paintChanges();
    paintFileHead();
  } catch (e: any) {
    deps?.toast(t("code.saveFail").replace("%s", String(e?.message ?? e)));
  }
}

/** Take the whole proposal: write the editor buffer, then leave review mode. */
async function acceptAll(): Promise<void> {
  if (!root || !openPath || mergeBase === null) return;
  const content = buffer;
  try {
    await api.codeWrite(root, openPath, content);
  } catch (e: any) {
    deps?.toast(t("code.saveFail").replace("%s", String(e?.message ?? e)));
    return;
  }
  mergeBase = content;
  savedContent = content;
  await finishReview();
  await refreshGit();
  await reloadTree();
  paintTree();
  paintChanges();
}

/** Drop the whole proposal. Nothing is written: the disk never saw it. */
async function rejectAll(): Promise<void> {
  if (!openPath || mergeBase === null) return;
  buffer = mergeBase;
  await finishReview();
}

/** Drop a pending proposal for a file that is not open. */
async function discardProposal(rel: string): Promise<void> {
  proposals.delete(rel);
  if (openPath === rel) {
    mergeBase = null;
    buffer = savedContent;
    paintMid();
  }
  paintPending();
  paintTree();
  deps?.paintNav();
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
  if (!git.upstream) {
    deps?.toast(t("code.noUpstream"));
    return;
  }
  if (git.ahead === 0) {
    deps?.toast(t("code.nothingToPush"));
    return;
  }
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
  if (!git.upstream) {
    deps?.toast(t("code.noUpstream"));
    return;
  }
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
    if (openPath) await openFile(openPath);
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
    : `<span class="cpill off">${esc(t("code.noRepo"))}</span>`;
  return (
    `<span class="cpath mono" title="${esc(root)}">${esc(root)}</span>` +
    branch +
    (g?.repo
      ? `<button class="bs" id="cpull">${esc(t("code.pull"))}</button><button class="bs" id="cpush">${esc(t("code.push"))}</button>`
      : "") +
    `<button class="bs" id="cpick">${esc(t("code.change"))}</button>`
  );
}

function paintLeft(): void {
  const box = document.getElementById("codeleft");
  if (!box) return;
  box.innerHTML = "";
  box.appendChild(el(`<div class="ctabs">
    ${(["files", "changes", "history", "branches"] as LeftTab[])
      .map((k) => {
        const n =
          k === "changes" && git?.repo
            ? changes.length
            : 0;
        return `<button class="ctab ${leftTab === k ? "on" : ""}" data-tab="${k}">${esc(t("code.tab." + k))}${n ? `<span class="n">${n}</span>` : ""}</button>`;
      })
      .join("")}
  </div>`));
  box.appendChild(el(`<div class="cpending" id="codepending"></div>`));
  box.appendChild(el(`<div class="cpanel" id="codepanel"></div>`));
  paintPending();
  paintPanel();
}

function paintPanel(): void {
  const box = document.getElementById("codepanel");
  if (!box) return;
  if (leftTab === "files") {
    box.innerHTML = `<div class="ctree" id="ctree">${treeRowsHtml("", 0)}</div>`;
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
  if (!box) return;
  box.innerHTML = treeRowsHtml("", 0);
}

function paintChanges(): void {
  if (leftTab === "changes") paintPanel();
  const tabs = document.querySelector(".ctabs");
  if (tabs) {
    const b = tabs.querySelector<HTMLElement>('[data-tab="changes"]');
    if (b) {
      const n = git?.repo ? changes.length : 0;
      b.innerHTML = `${esc(t("code.tab.changes"))}${n ? `<span class="n">${n}</span>` : ""}`;
    }
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
  box.style.display = "block";
  box.innerHTML =
    `<div class="ph">${esc(t("code.pendingTitle").replace("%n", String(list.length)))}</div>` +
    list
      .map(
        (p) =>
          `<div class="prow ${openPath === p ? "on" : ""}" data-open="${esc(p)}"><span class="dot">◆</span><span class="nm mono" title="${esc(p)}">${esc(baseName(p))}</span><span class="x" data-drop="${esc(p)}" title="${esc(t("code.discard"))}">×</span></div>`
      )
      .join("");
}

function changesHtml(): string {
  if (!git?.repo) return `<div class="cempty">${esc(t("code.noRepoHint"))}</div>`;
  const staged = changes.filter((c) => c.staged);
  const unstaged = changes.filter((c) => c.unstaged && !c.untracked);
  const untracked = changes.filter((c) => c.untracked);
  const group = (title: string, rows: GitChange[], action: "stage" | "unstage") => {
    if (!rows.length) return "";
    return (
      `<div class="cgh">${esc(title)}<span class="n">${rows.length}</span>` +
      `<span class="all" data-all="${action}">${esc(action === "stage" ? t("code.stageAll") : t("code.unstageAll"))}</span></div>` +
      rows
        .map(
          (c) =>
            `<div class="crow" data-change="${esc(c.path)}" data-side="${action === "unstage" ? "staged" : "work"}">` +
            `<span class="gs ${c.untracked ? "unt" : (action === "unstage" ? c.index : c.work) === "A" ? "add" : (action === "unstage" ? c.index : c.work) === "D" ? "del" : "mod"}">${esc(c.untracked ? "?" : action === "unstage" ? c.index : c.work)}</span>` +
            `<span class="nm mono" title="${esc(c.path)}">${esc(c.path)}</span>` +
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
  if (!git?.repo) return `<div class="cempty">${esc(t("code.noRepoHint"))}</div>`;
  const filter = openPath
    ? `<div class="cfilter"><label><input type="checkbox" id="chfilter" ${historyPath ? "checked" : ""}/> ${esc(t("code.historyFile").replace("%s", baseName(openPath)))}</label></div>`
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
  if (!git?.repo) return `<div class="cempty">${esc(t("code.noRepoHint"))}</div>`;
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

function paintFileHead(): void {
  const box = document.getElementById("cfilehead");
  if (!box) return;
  box.innerHTML = fileHeadHtml();
}

function fileHeadHtml(): string {
  if (!openPath) return "";
  const pending = mergeBase !== null;
  const dirty = !pending && buffer !== savedContent;
  return (
    `<span class="fp mono" title="${esc(openPath)}">${esc(openPath)}</span>` +
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
  editor?.destroy();
  editor = null;
  box.innerHTML = "";
  if (mid === "patch" && patch) {
    box.appendChild(
      el(`<div class="cfilehead">
        <span class="fp mono" title="${esc(patch.title)}">${esc(patch.title)}</span>
        <span class="fsub">${esc(patch.sub)}</span>
        <span class="grow"></span>
        <button class="bs" id="fpatchclose">${esc(t("code.backToEditor"))}</button>
      </div>`)
    );
    box.appendChild(el(`<div class="cpatch diffpane">${patchHtml(patch.body)}</div>`));
    return;
  }
  if (!openPath) {
    box.appendChild(
      el(`<div class="cempty big">${esc(t("code.pickFile"))}</div>`)
    );
    return;
  }
  box.appendChild(el(`<div class="cfilehead" id="cfilehead">${fileHeadHtml()}</div>`));
  if (openError) {
    box.appendChild(
      el(`<div class="cerror"><b>${esc(t("code.cannotOpen"))}</b><span class="mono">${esc(openError)}</span></div>`)
    );
    return;
  }
  if (mergeBase !== null) {
    box.appendChild(el(`<div class="creviewbar">${esc(t("code.reviewHint"))}</div>`));
  }
  box.appendChild(el(`<div class="cmhost" id="cmhost"></div>`));
  remountEditor();
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
      <div class="codemid" id="codemid"></div>
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
    const id = (e.target as HTMLElement).closest("button")?.id;
    if (id === "cpick") void chooseWorkspace();
    else if (id === "cpush") void push();
    else if (id === "cpull") void pull();
  });

  // Left column: tabs, pending proposals, tree / changes / history / branches.
  const left = wrap.querySelector<HTMLElement>("#codeleft")!;
  left.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;

    const tab = target.closest("[data-tab]") as HTMLElement | null;
    if (tab) {
      leftTab = tab.dataset.tab as LeftTab;
      void (async () => {
        if (leftTab === "history") await refreshHistory();
        if (leftTab === "branches") await refreshBranches();
        paintLeft();
      })();
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
      historyPath = (target as HTMLInputElement).checked ? openPath : null;
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

  // Middle column: the file header's own buttons.
  const midBox = wrap.querySelector<HTMLElement>("#codemid")!;
  midBox.addEventListener("click", (e) => {
    const id = (e.target as HTMLElement).closest("button")?.id;
    if (id === "fsave") void saveOpenFile();
    else if (id === "faccall") void acceptAll();
    else if (id === "frejall") void rejectAll();
    else if (id === "fpatchclose") {
      mid = "editor";
      patch = null;
      paintMid();
    }
  });

  // Right column: the SAME agent thread as the Chat view.
  deps?.mountAgent(wrap.querySelector<HTMLElement>("#codeside")!);

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
  })();

  return wrap;
}
