// Regressions for the defects found in review.
//
// Every one of them passed the original 56 test suite. The first one is the
// important one: the module's whole premise is that the badge never claims
// tier A while rust-analyzer cannot answer, and one progress begin arriving
// before the initialize response, which the module's own comments say is the
// NORMAL ordering on a cold workspace, made it claim exactly that for the
// entire multi-minute index.

import {
  configureRustLsp,
  disableRustLsp,
  enableRustLsp,
  lspRangeToOffsets,
  onEvent,
  planRustRename,
  registerRustLsp,
  resetRustLspForTests,
  rustLspRoot,
  rustLspState,
  rustLspStatus,
  rustReady,
  rustTierNote,
  syncRustBuffer,
  workspaceEditFiles,
  type RustLspEvent,
  type RustLspStatus,
  type RustLspTransport,
  type TextDocLike,
} from "../../src/code/rust-lsp.js";

const builtin = (name: string): Promise<any> => import(name);
const { test } = await builtin("node:test");
const assert = (await builtin("node:assert/strict")).default;

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
  emit(event: RustLspEvent): void;
  answers: Map<string, unknown>;
  startResult: RustLspStatus;
  /** When set, start() parks until the returned function is called. */
  gate: (() => void) | null;
  starts: number;
  stopped: number;
  listeners: number;
}

function fake(): Fake {
  let handler: ((e: RustLspEvent) => void) | null = null;
  const f: Fake = {
    sent: [],
    answers: new Map(),
    startResult: OK,
    gate: null,
    starts: 0,
    stopped: 0,
    listeners: 0,
    async start() {
      f.starts += 1;
      if (f.gate) await new Promise<void>((r) => (f.gate = r));
      return f.startResult;
    },
    async stop() {
      f.stopped += 1;
    },
    async request(method) {
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

const progress = (token: string, kind: "begin" | "end", title = token): RustLspEvent => ({
  kind: "progress",
  params: { token, value: { kind, title } },
});

/** Let the microtask queue drain, so a gated start() can actually park. */
const tick = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

// -------------------------------------------- progress before initialize

test("a progress begin that beats the initialize response still shows indexing", async () => {
  resetRustLspForTests();
  const f = fake();
  f.gate = () => {};
  configureRustLsp(f);
  const booting = enableRustLsp("/w");
  await tick();
  // Cold workspace: rust-analyzer starts scanning before it answers initialize.
  f.emit(progress("Roots Scanned", "begin"));
  assert.equal(rustLspState(), "starting", "progress must not promote a starting session");
  f.gate!();
  await booting;

  assert.equal(rustLspState(), "indexing", "the outstanding token must be honoured");
  assert.equal(rustReady(), false, "no tier A while the crate graph is being read");
  assert.equal(rustTierNote()?.key, "rustlsp.indexing");

  // A second token overlapping the first must not end the indexing early.
  f.emit(progress("Building CrateGraph", "begin"));
  f.emit(progress("Roots Scanned", "end"));
  assert.equal(rustLspState(), "indexing");
  f.emit(progress("Building CrateGraph", "end"));
  assert.equal(rustLspState(), "ready");
  assert.equal(rustReady(), true);
  await disableRustLsp();
});

test("a boot with nothing outstanding still goes straight to ready", async () => {
  resetRustLspForTests();
  const f = fake();
  configureRustLsp(f);
  await enableRustLsp("/w");
  assert.equal(rustLspState(), "ready");
  await disableRustLsp();
});

// ------------------------------------------------------- restart after death

test("a crashed server can be started again for the same root", async () => {
  resetRustLspForTests();
  const f = fake();
  configureRustLsp(f);
  await enableRustLsp("/w");
  f.emit({ kind: "stopped", reason: "boom" });
  assert.equal(rustLspState(), "failed");

  const again = await enableRustLsp("/w");
  assert.equal(again, "ready", "the second attempt must really boot, not replay a stale answer");
  assert.equal(rustLspState(), "ready");
  assert.equal(f.starts, 2, "transport.start must be called a second time");
  await disableRustLsp();
});

test("enabling a root that is already live does not restart anything", async () => {
  resetRustLspForTests();
  const f = fake();
  configureRustLsp(f);
  await enableRustLsp("/w");
  await enableRustLsp("/w");
  assert.equal(f.starts, 1);
  await disableRustLsp();
});

// ------------------------------------------------------- generation guard

test("a boot abandoned by a workspace switch cannot overwrite the new session", async () => {
  resetRustLspForTests();
  const f1 = fake();
  f1.gate = () => {};
  f1.startResult = { ...OK, root: "/w1", cargo: false, note: "no cargo on this Mac", server: "OLD" };
  configureRustLsp(f1);
  const stale = enableRustLsp("/w1");
  await tick();

  const f2 = fake();
  f2.startResult = { ...OK, root: "/w2", cargo: true, note: null, server: "NEW" };
  configureRustLsp(f2);
  await enableRustLsp("/w2");

  f1.gate!(); // the abandoned boot finally answers
  await stale;

  assert.equal(rustLspRoot(), "/w2");
  assert.equal(rustLspStatus()?.server, "NEW", "the previous workspace must not write its status");
  assert.equal(rustTierNote(), null, "and must not report its limitation on a workspace that has cargo");
  await disableRustLsp();
});

test("a boot that lands after disableRustLsp cannot resurrect the session", async () => {
  resetRustLspForTests();
  const f = fake();
  f.gate = () => {};
  configureRustLsp(f);
  const stale = enableRustLsp("/w");
  await tick();
  await disableRustLsp();
  assert.equal(rustLspStatus(), null);
  f.gate!();
  await stale;
  assert.equal(rustLspStatus(), null, "a stopped server must stay stopped");
  assert.equal(rustLspState(), "off");
});

// ------------------------------------------------------- writes to the dead

test("nothing is sent to a server that has died", async () => {
  resetRustLspForTests();
  const f = fake();
  configureRustLsp(f);
  await enableRustLsp("/w");
  syncRustBuffer("src/a.rs", "fn a() {}");
  const afterOpen = f.sent.length;
  assert.ok(afterOpen > 0, "the live server does get the buffer");

  f.emit({ kind: "stopped", reason: "boom" });
  for (let i = 0; i < 5; i++) syncRustBuffer("src/a.rs", `fn a() {} // ${i}`);
  assert.equal(f.sent.length, afterOpen, "a dead server must receive nothing at all");
  await disableRustLsp();
});

// ------------------------------------------------------- lint refresh

test("a publication asks the editor to lint that file again", async () => {
  resetRustLspForTests();
  const f = fake();
  configureRustLsp(f);
  const refreshed: string[] = [];
  registerRustLsp({ registerDiagnostics: () => {}, refresh: (rel) => refreshed.push(rel) });
  await enableRustLsp("/w");
  syncRustBuffer("src/a.rs", "fn a() {}");

  f.emit({
    kind: "diagnostics",
    params: { uri: "file:///w/src/a.rs", diagnostics: [] },
  });
  assert.deepEqual(refreshed, ["src/a.rs"]);

  // A file the editor does not have open must not trigger anything.
  f.emit({ kind: "diagnostics", params: { uri: "file:///w/src/other.rs", diagnostics: [] } });
  assert.deepEqual(refreshed, ["src/a.rs"]);
  await disableRustLsp();
});

// ------------------------------------------------------- rename, one file

test("two edit entries for the same file produce ONE proposal, not two conflicting ones", async () => {
  const flat = workspaceEditFiles({
    documentChanges: [
      {
        textDocument: { uri: "file:///w/src/a.rs" },
        edits: [{ range: { start: { line: 0, character: 3 }, end: { line: 0, character: 6 } }, newText: "nu" }],
      },
      {
        textDocument: { uri: "file:///w/src/a.rs" },
        edits: [{ range: { start: { line: 1, character: 12 }, end: { line: 1, character: 15 } }, newText: "nu" }],
      },
    ],
  });
  assert.equal(flat.length, 1, "one file, one entry");
  assert.equal(flat[0].edits.length, 2);

  resetRustLspForTests();
  const f = fake();
  configureRustLsp(f);
  await enableRustLsp("/w");
  const text = "fn old() {}\nfn main() { old(); }\n";
  syncRustBuffer("src/a.rs", text);
  f.answers.set("textDocument/rename", {
    documentChanges: [
      {
        textDocument: { uri: "file:///w/src/a.rs" },
        edits: [{ range: { start: { line: 0, character: 3 }, end: { line: 0, character: 6 } }, newText: "nu" }],
      },
      {
        textDocument: { uri: "file:///w/src/a.rs" },
        edits: [{ range: { start: { line: 1, character: 12 }, end: { line: 1, character: 15 } }, newText: "nu" }],
      },
    ],
  });
  const edits = await planRustRename("src/a.rs", doc(text), 4, "nu", async () => undefined, doc);
  assert.equal(edits.length, 1, "one proposal per file, always");
  assert.equal(edits[0].content, "fn nu() {}\nfn main() { nu(); }\n", "both edits must be in it");
  await disableRustLsp();
});

// ------------------------------------------------------- end of file marker

test("a diagnostic at the very end of the buffer is still one character wide", () => {
  const d = doc("fn a() {}");
  const r = lspRangeToOffsets(d, {
    start: { line: 0, character: 99 },
    end: { line: 0, character: 99 },
  });
  assert.ok(r.to > r.from, `a zero width marker draws nothing: ${JSON.stringify(r)}`);
  assert.equal(r.to, 9);
  assert.equal(r.from, 8);
});

test("an empty document produces a harmless range rather than a negative one", () => {
  const r = lspRangeToOffsets(doc(""), {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
  });
  assert.deepEqual(r, { from: 0, to: 0 });
});
