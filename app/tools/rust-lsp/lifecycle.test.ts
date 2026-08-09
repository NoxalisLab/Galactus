// The lifecycle of the .rs tier, driven through a fake transport.
//
// The transport is an interface precisely so this file can exist: a real
// rust-analyzer cannot be made to die in the middle of a request, publish an
// empty diagnostic set during indexing or run three overlapping progress
// tokens on command, and those are the states the badge has to get right.
//
// The contract under test, in one sentence: the module answers nothing rather
// than answering wrongly, and it always says which of the two happened.

import {
  closeRustBuffer,
  configureRustLsp,
  disableRustLsp,
  enableRustLsp,
  findRustReferences,
  gotoRustDefinition,
  onEvent,
  planRustRename,
  publishedFor,
  resetRustLspForTests,
  rustDiagnosticSource,
  rustLspReduce,
  rustLspState,
  rustReady,
  rustTierNote,
  shouldStartRustLsp,
  syncRustBuffer,
  type RustLspDeps,
  type RustLspEvent,
  type RustLspState,
  type RustLspStatus,
  type RustLspTransport,
  type TextDocLike,
} from "../../src/code/rust-lsp.js";

const builtin = (name: string): Promise<any> => import(name);
const { test } = await builtin("node:test");
const assert = (await builtin("node:assert/strict")).default;
const fs = await builtin("node:fs");
const path = await builtin("node:path");
const { fileURLToPath } = await builtin("node:url");

// ---------------------------------------------------------------- harness

function doc(text: string): TextDocLike {
  const lines = text.split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const l of lines) {
    starts.push(at);
    at += l.length + 1;
  }
  return {
    length: text.length,
    lines: lines.length,
    line(n: number) {
      const i = Math.min(Math.max(n, 1), lines.length) - 1;
      return { from: starts[i], to: starts[i] + lines[i].length, text: lines[i] };
    },
    toString: () => text,
  };
}

const OK: RustLspStatus = {
  running: true,
  root: "/w",
  root_uri: "file:///w",
  server: "rust-analyzer 0.0.0",
  sysroot: "/opt/rust",
  sysroot_src: "/bundle/library",
  cargo: true,
  pid: 4242,
  note: null,
};

interface Fake extends RustLspTransport {
  sent: Array<{ method: string; params: any }>;
  requests: Array<{ method: string; params: any }>;
  emit(event: RustLspEvent): void;
  answers: Map<string, unknown>;
  startResult: RustLspStatus;
  startError: Error | null;
  stopped: number;
  listeners: number;
}

function fake(): Fake {
  let handler: ((e: RustLspEvent) => void) | null = null;
  const f: Fake = {
    sent: [],
    requests: [],
    answers: new Map(),
    startResult: OK,
    startError: null,
    stopped: 0,
    listeners: 0,
    async start() {
      if (f.startError) throw f.startError;
      return f.startResult;
    },
    async stop() {
      f.stopped += 1;
    },
    async request(method, params) {
      f.requests.push({ method, params });
      if (!f.answers.has(method)) throw new Error(`no fake answer for ${method}`);
      return f.answers.get(method);
    },
    async notify(method, params) {
      f.sent.push({ method, params });
    },
    async listen(h) {
      handler = h;
      f.listeners += 1;
      return () => {
        handler = null;
        f.listeners -= 1;
      };
    },
    emit(event) {
      handler?.(event);
    },
  };
  return f;
}

async function ready(): Promise<Fake> {
  resetRustLspForTests();
  const f = fake();
  configureRustLsp(f);
  await enableRustLsp("/w");
  assert.equal(rustLspState(), "ready");
  return f;
}

const progress = (token: string, kind: "begin" | "end"): RustLspEvent => ({
  kind: "progress",
  params: { token, value: { kind, title: token } },
});

const diags = (uri: string, items: any[]): RustLspEvent => ({
  kind: "diagnostics",
  params: { uri, diagnostics: items },
});

const RANGE = { start: { line: 0, character: 3 }, end: { line: 0, character: 7 } };

/** The deps the bindings take, with an openFile a test can watch. */
function deps(rel: string): RustLspDeps {
  return { file: () => rel, openFile: () => {} };
}

// ---------------------------------------------------------------- reducer

test("the reducer refuses to promote a session that has not initialized", () => {
  // Progress arrives BEFORE the initialize response on a cold workspace. A
  // reducer that treated it as a signal of life would claim tier A while the
  // server still cannot answer a single question.
  let s: RustLspState = "off";
  s = rustLspReduce(s, "start");
  assert.equal(s, "starting");
  s = rustLspReduce(s, "indexBegin");
  assert.equal(s, "starting");
  s = rustLspReduce(s, "indexEnd");
  assert.equal(s, "starting");
  s = rustLspReduce(s, "initialized");
  assert.equal(s, "ready");
});

test("indexing is a state of its own, between two ready states", () => {
  let s: RustLspState = "ready";
  s = rustLspReduce(s, "indexBegin");
  assert.equal(s, "indexing");
  s = rustLspReduce(s, "initialized");
  assert.equal(s, "indexing", "a stray initialize must not end indexing");
  s = rustLspReduce(s, "indexEnd");
  assert.equal(s, "ready");
});

test("a stale event about a dead session revives nothing", () => {
  for (const dead of ["off", "failed"] as RustLspState[]) {
    assert.equal(rustLspReduce(dead, "initialized"), dead);
    assert.equal(rustLspReduce(dead, "indexBegin"), dead);
    assert.equal(rustLspReduce(dead, "indexEnd"), dead);
  }
  assert.equal(rustLspReduce("failed", "start"), "starting");
});

test("failure and stop win from anywhere", () => {
  for (const s of ["off", "starting", "indexing", "ready", "failed"] as RustLspState[]) {
    assert.equal(rustLspReduce(s, "fail"), "failed");
    assert.equal(rustLspReduce(s, "stop"), "off");
  }
});

// ---------------------------------------------------------------- eligibility

test("only a Rust workspace starts a Rust server", () => {
  assert.equal(shouldStartRustLsp(["Cargo.toml", "src"]), true);
  assert.equal(shouldStartRustLsp(["rust-toolchain.toml"]), true);
  assert.equal(shouldStartRustLsp(["package.json", "notes.md"]), false);
  assert.equal(shouldStartRustLsp([]), false);
});

// ---------------------------------------------------------------- lifecycle

test("a start subscribes before it spawns", async () => {
  // The first progress notification arrives DURING initialize. A listener
  // attached afterwards misses the begin and then waits forever for its end.
  resetRustLspForTests();
  const f = fake();
  let listenedBeforeStart = false;
  const originalStart = f.start.bind(f);
  f.start = async (root: string) => {
    listenedBeforeStart = f.listeners > 0;
    return originalStart(root);
  };
  configureRustLsp(f);
  await enableRustLsp("/w");
  assert.equal(listenedBeforeStart, true);
});

test("a server that refuses to start leaves the editor in the syntax tier", async () => {
  resetRustLspForTests();
  const f = fake();
  f.startError = new Error("rust-analyzer is not in this build of Galactus");
  configureRustLsp(f);
  const s = await enableRustLsp("/w");
  assert.equal(s, "failed");
  assert.equal(rustReady(), false);
  const note = rustTierNote();
  assert.ok(note && note.detail.includes("not in this build"), "the badge must be able to say why");
  // And every query is a no-op rather than a rejected promise.
  assert.deepEqual(await rustDiagnosticSource()({ doc: doc("fn f() {}") }, "src/a.rs"), []);
});

test("a server that dies mid-session degrades honestly", async () => {
  const f = await ready();
  f.emit({ kind: "stopped", reason: "the Rust language server closed its output" });
  assert.equal(rustLspState(), "failed");
  assert.equal(rustReady(), false);
  assert.ok(rustTierNote()!.detail.includes("closed its output"));
  assert.deepEqual(await rustDiagnosticSource()({ doc: doc("fn f() {}") }, "src/a.rs"), []);
});

test("overlapping progress tokens do not flip the badge back early", async () => {
  // Measured against the real server: Fetching, Building CrateGraph and Roots
  // Scanned overlap. Ending the first must not claim the work is done.
  const f = await ready();
  f.emit(progress("Fetching", "begin"));
  assert.equal(rustLspState(), "indexing");
  f.emit(progress("CrateGraph", "begin"));
  f.emit(progress("Fetching", "end"));
  assert.equal(rustLspState(), "indexing", "one token of three finished");
  f.emit(progress("CrateGraph", "end"));
  assert.equal(rustLspState(), "ready");
});

test("nothing is promised while the crate graph is being read", async () => {
  const f = await ready();
  f.emit(progress("Fetching", "begin"));
  assert.equal(rustReady(), false);
  const note = rustTierNote();
  assert.ok(note && note.key === "rustlsp.indexing");
  assert.deepEqual(await rustDiagnosticSource()({ doc: doc("fn f() {}") }, "src/a.rs"), []);
});

test("a partial toolchain is reported, not hidden", async () => {
  resetRustLspForTests();
  const f = fake();
  f.startResult = { ...OK, cargo: false, note: "no cargo on this Mac" };
  configureRustLsp(f);
  await enableRustLsp("/w");
  assert.equal(rustReady(), true, "a missing cargo is a limitation, not a failure");
  const note = rustTierNote();
  assert.ok(note && note.detail.includes("no cargo"));
});

test("stopping unsubscribes, stops the process and forgets the documents", async () => {
  const f = await ready();
  syncRustBuffer("src/a.rs", "fn a() {}");
  f.emit(diags("file:///w/src/a.rs", [{ range: RANGE, message: "x" }]));
  assert.equal(publishedFor("src/a.rs").length, 1);
  await disableRustLsp();
  assert.equal(rustLspState(), "off");
  assert.equal(f.stopped, 1);
  assert.equal(f.listeners, 0);
  assert.equal(publishedFor("src/a.rs").length, 0);
});

// ---------------------------------------------------------------- documents

test("a buffer opens once and then changes, with a version that climbs", async () => {
  const f = await ready();
  syncRustBuffer("src/a.rs", "fn a() {}");
  syncRustBuffer("src/a.rs", "fn a() { 1 }");
  syncRustBuffer("src/a.rs", "fn a() { 2 }");
  const kinds = f.sent.map((s) => s.method);
  assert.deepEqual(kinds, [
    "textDocument/didOpen",
    "textDocument/didChange",
    "textDocument/didChange",
  ]);
  assert.equal(f.sent[0].params.textDocument.uri, "file:///w/src/a.rs");
  assert.equal(f.sent[1].params.textDocument.version, 2);
  assert.equal(f.sent[2].params.textDocument.version, 3);
  // Full text sync: an incremental client that lost one change would answer
  // about the wrong document forever after.
  assert.equal(f.sent[2].params.contentChanges[0].text, "fn a() { 2 }");
});

test("an unchanged buffer sends nothing at all", async () => {
  const f = await ready();
  syncRustBuffer("src/a.rs", "fn a() {}");
  const after = f.sent.length;
  syncRustBuffer("src/a.rs", "fn a() {}");
  syncRustBuffer("src/a.rs", "fn a() {}");
  assert.equal(f.sent.length, after, "a keystroke that changed nothing must cost nothing");
});

test("only .rs files reach the server", async () => {
  const f = await ready();
  syncRustBuffer("src/main.ts", "const a = 1;");
  syncRustBuffer("Cargo.toml", "[package]");
  assert.equal(f.sent.length, 0);
});

test("closing a buffer tells the server and drops its diagnostics", async () => {
  const f = await ready();
  syncRustBuffer("src/a.rs", "fn a() {}");
  f.emit(diags("file:///w/src/a.rs", [{ range: RANGE, message: "x" }]));
  closeRustBuffer("src/a.rs");
  assert.equal(f.sent.at(-1)!.method, "textDocument/didClose");
  assert.equal(publishedFor("src/a.rs").length, 0);
});

// ---------------------------------------------------------------- diagnostics

test("a changed buffer waits for the publication that answers it", async () => {
  const f = await ready();
  const source = rustDiagnosticSource();
  const text = "fn a() { bad }";
  const pending = source({ doc: doc(text) }, "src/a.rs");
  // The server publishes after the didChange, as it does in reality.
  f.emit(
    diags("file:///w/src/a.rs", [
      { range: RANGE, severity: 1, code: "E0425", message: "cannot find value" },
    ])
  );
  const out = await pending;
  assert.equal(out.length, 1);
  assert.equal(out[0].message, "cannot find value");
  assert.deepEqual({ from: out[0].from, to: out[0].to }, { from: 3, to: 7 });
});

test("an unchanged buffer answers from the last publication without waiting", async () => {
  const f = await ready();
  const source = rustDiagnosticSource();
  const text = "fn a() { bad }";
  const first = source({ doc: doc(text) }, "src/a.rs");
  f.emit(diags("file:///w/src/a.rs", [{ range: RANGE, severity: 2, message: "unused" }]));
  await first;
  // No publication this time. If this waited it would take DIAGNOSTIC_WAIT_MS,
  // on every lint run, on a file nobody is editing.
  const started = Date.now();
  const again = await source({ doc: doc(text) }, "src/a.rs");
  assert.ok(Date.now() - started < 200, "an unchanged buffer must not sit through the timeout");
  assert.equal(again.length, 1);
  assert.equal(again[0].severity, "warning");
});

test("a publication that never comes falls back to what is known", async () => {
  const f = await ready();
  const source = rustDiagnosticSource();
  f.emit(diags("file:///w/src/a.rs", [{ range: RANGE, severity: 1, message: "old" }]));
  syncRustBuffer("src/a.rs", "fn a() { 0 }");
  // A new version, and the server says nothing about it. The source must
  // resolve on its own rather than hold the whole lint run hostage.
  const out = await source({ doc: doc("fn a() { 1 }") }, "src/a.rs");
  assert.equal(out.length, 1);
  assert.equal(out[0].message, "old");
});

test("diagnostics for another file are not shown in this one", async () => {
  const f = await ready();
  const source = rustDiagnosticSource();
  const pending = source({ doc: doc("fn a() { bad }") }, "src/a.rs");
  f.emit(diags("file:///w/src/other.rs", [{ range: RANGE, severity: 1, message: "elsewhere" }]));
  f.emit(diags("file:///w/src/a.rs", []));
  assert.deepEqual(await pending, []);
});

// ---------------------------------------------------------------- navigation

test("a positional request synchronises the buffer before it asks", async () => {
  // Otherwise the server answers from the file ON DISK, which is right until
  // the first unsaved keystroke and then quietly wrong forever.
  const f = await ready();
  f.answers.set("textDocument/definition", null);
  await gotoRustDefinition(deps("src/a.rs"), doc("fn a() {}\n"), 3);
  assert.equal(f.sent[0].method, "textDocument/didOpen");
  assert.equal(f.sent[0].params.textDocument.text, "fn a() {}\n");
  assert.equal(f.requests[0].method, "textDocument/definition");
  assert.deepEqual(f.requests[0].params.position, { line: 0, character: 3 });
});

test("go to definition opens a workspace file and reports that it did", async () => {
  const f = await ready();
  f.answers.set("textDocument/definition", {
    uri: "file:///w/src/b.rs",
    range: { start: { line: 41, character: 7 }, end: { line: 41, character: 12 } },
  });
  const opened: Array<[string, number, number]> = [];
  const d = deps("src/a.rs");
  d.openFile = (rel, line, col) => opened.push([rel, line, col]);
  assert.equal(await gotoRustDefinition(d, doc("fn a() {}\n"), 3), true);
  // LSP lines are zero based and the Code view's are one based.
  assert.deepEqual(opened, [["src/b.rs", 42, 7]]);
});

test("a definition inside the bundled standard library opens nothing", async () => {
  // Those files live in the .app. Opening one would show the user a read-only
  // path their file tree cannot display, which reads as a bug.
  const f = await ready();
  f.answers.set("textDocument/definition", {
    uri: "file:///Applications/Galactus.app/Contents/Resources/rust-tooling/rust-src/library/core/src/time.rs",
    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
  });
  let opened = 0;
  const d = deps("src/a.rs");
  d.openFile = () => {
    opened += 1;
  };
  assert.equal(await gotoRustDefinition(d, doc("fn a() {}\n"), 3), false);
  assert.equal(opened, 0);
});

test("a request that fails answers nothing instead of rejecting", async () => {
  // A rejected promise inside a hover tooltip is an unhandled rejection in the
  // console and a tooltip that never closes.
  const f = await ready();
  f.answers.delete("textDocument/references");
  const hits = await findRustReferences(deps("src/a.rs"), doc("fn a() {}\n"), 3);
  assert.deepEqual(hits, []);
});

test("references outside the workspace are dropped from the list", async () => {
  const f = await ready();
  const text = "fn a() {}\nfn b() { a(); }\n";
  f.answers.set("textDocument/references", [
    { uri: "file:///w/src/a.rs", range: { start: { line: 1, character: 9 }, end: { line: 1, character: 10 } } },
    { uri: "file:///elsewhere/x.rs", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
  ]);
  const hits = await findRustReferences(deps("src/a.rs"), doc(text), 3);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].rel, "src/a.rs");
  assert.equal(hits[0].line, 2);
  // The open document can be quoted; nothing else can, because this module
  // does not read files.
  assert.equal(hits[0].text, "fn b() { a(); }");
});

// ---------------------------------------------------------------- rename

test("a rename produces file contents and writes nothing", async () => {
  const f = await ready();
  const text = "fn old() {}\nfn main() { old(); }\n";
  syncRustBuffer("src/a.rs", text);
  const other = "use crate::a::old;\nfn go() { old(); }\n";
  f.answers.set("textDocument/rename", {
    documentChanges: [
      {
        textDocument: { uri: "file:///w/src/a.rs" },
        edits: [
          { range: { start: { line: 0, character: 3 }, end: { line: 0, character: 6 } }, newText: "renamed" },
          { range: { start: { line: 1, character: 12 }, end: { line: 1, character: 15 } }, newText: "renamed" },
        ],
      },
      {
        textDocument: { uri: "file:///w/src/b.rs" },
        edits: [
          { range: { start: { line: 0, character: 14 }, end: { line: 0, character: 17 } }, newText: "renamed" },
          { range: { start: { line: 1, character: 10 }, end: { line: 1, character: 13 } }, newText: "renamed" },
        ],
      },
    ],
  });
  const edits = await planRustRename(
    "src/a.rs",
    doc(text),
    3,
    "renamed",
    async (rel) => (rel === "src/b.rs" ? other : undefined),
    doc
  );
  assert.deepEqual(edits, [
    { rel: "src/a.rs", content: "fn renamed() {}\nfn main() { renamed(); }\n" },
    { rel: "src/b.rs", content: "use crate::a::renamed;\nfn go() { renamed(); }\n" },
  ]);
});

test("a rename that would create or delete a file is refused", async () => {
  // Renaming a module renames its file. A plan made of file contents cannot
  // express that, and applying half of it would leave the crate broken.
  const f = await ready();
  syncRustBuffer("src/a.rs", "mod old;\n");
  f.answers.set("textDocument/rename", {
    documentChanges: [
      { textDocument: { uri: "file:///w/src/a.rs" }, edits: [{ range: RANGE, newText: "new" }] },
      { kind: "rename", oldUri: "file:///w/src/old.rs", newUri: "file:///w/src/new.rs" },
    ],
  });
  await assert.rejects(
    () => planRustRename("src/a.rs", doc("mod old;\n"), 4, "new", async () => undefined, doc),
    /create or delete files/
  );
});

test("a rename touching the standard library is refused, not half applied", async () => {
  const f = await ready();
  syncRustBuffer("src/a.rs", "fn a() {}\n");
  f.answers.set("textDocument/rename", {
    changes: {
      "file:///w/src/a.rs": [{ range: RANGE, newText: "b" }],
      "file:///bundle/library/core/src/lib.rs": [{ range: RANGE, newText: "b" }],
    },
  });
  await assert.rejects(
    () => planRustRename("src/a.rs", doc("fn a() {}\n"), 3, "b", async () => "", doc),
    /outside the workspace/
  );
});

test("a rename is impossible without a server", async () => {
  resetRustLspForTests();
  const f = fake();
  f.startError = new Error("no server");
  configureRustLsp(f);
  await enableRustLsp("/w");
  await assert.rejects(
    () => planRustRename("src/a.rs", doc("fn a() {}"), 3, "b", async () => "", doc),
    /needs the Rust language server/
  );
});

test("an empty new name is refused before anything is asked of the server", async () => {
  const f = await ready();
  await assert.rejects(
    () => planRustRename("src/a.rs", doc("fn a() {}"), 3, "   ", async () => "", doc),
    /needs a new name/
  );
  assert.equal(f.requests.length, 0);
});

// ---------------------------------------------------------------- containment

test("the module never reaches Tauri or the filesystem on its own", () => {
  // The transport is injected for a reason: this module must be drivable from
  // a test, and it must be impossible for it to write a file behind the
  // proposals system. Asserted on the EMITTED JavaScript so a future import
  // cannot sneak past by being tree-shaken in one build and not another.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const emitted = path.join(here, "..", "..", "src", "code", "rust-lsp.js");
  const js: string = fs.readFileSync(emitted, "utf8");
  for (const forbidden of ["@tauri-apps", "node:fs", "writeFile", "codeWrite"]) {
    assert.ok(!js.includes(forbidden), `rust-lsp.ts must not reference ${forbidden}`);
  }
});
