// The dispatcher, exercised without a worker.
//
// `handle` is a plain function, which is the whole reason it is a plain
// function: every request kind and every way a request can be wrong is one
// call away. The contract being tested is narrow and absolute. `handle` never
// throws. A malformed message comes back as `{ok:false}` with a reason, because
// a worker that dies on a bad message takes the feature down for the session
// and the message that killed it is the one nobody can reproduce.

import { WorkspaceHost, ts } from "../../src/tsintel/host.js";
import { handle, type Req, type RefHit, type Res } from "../../src/tsintel/protocol.js";
import * as client from "../../src/tsintel/client.js";
import { referencesHtml } from "../../src/tsintel/bindings.js";

const builtin = (name: string): Promise<any> => import(name);
const { test } = await builtin("node:test");
const assert = (await builtin("node:assert/strict")).default;
const fs = await builtin("node:fs");
const path = await builtin("node:path");
const { fileURLToPath } = await builtin("node:url");

function appDir(): string {
  let d = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(d, "src", "tsintel", "host.ts"))) return d;
    d = path.dirname(d);
  }
  throw new Error("cannot locate the app directory");
}

const APP = appDir();
const PROJ = path.join(APP, "tools", "tsintel", "fixtures", "proj");
const TSLIB = path.join(APP, "public", "tslib");
const read = (rel: string): string => fs.readFileSync(path.join(PROJ, rel), "utf8");

const A = read("a.ts");
const B = read("b.ts");
const CALL = B.indexOf("distance(origin, target)") + 2;
const DECL = A.indexOf("export function distance") + "export function di".length;

async function build() {
  const host = new WorkspaceHost();
  const files: Array<[string, string]> = [];
  let bytes = 0;
  for (const name of fs.readdirSync(PROJ).sort()) {
    const text = fs.readFileSync(path.join(PROJ, name), "utf8");
    files.push([name, text]);
    bytes += text.length;
  }
  host.setSnapshot(files, false, bytes);
  await host.loadLibs(async (n: string) => fs.readFileSync(path.join(TSLIB, n), "utf8"));
  const svc = ts.createLanguageService(host, ts.createDocumentRegistry());
  return { host, svc, bytes };
}

/** Every response carries back the id it was asked with, so the client's
 *  promise map cannot resolve the wrong caller. */
function ok(res: Res, id: number): any {
  assert.equal(res.id, id, `response came back with the wrong id`);
  if (!res.ok) assert.fail(`expected ok, got error: ${res.error}`);
  return (res as { value: unknown }).value;
}

function bad(res: Res, id: number, needle: string): void {
  assert.equal(res.id, id);
  assert.equal(res.ok, false, "expected a refusal");
  assert.ok(
    !res.ok && res.error.includes(needle),
    `expected an error mentioning ${JSON.stringify(needle)}, got ${!res.ok ? res.error : ""}`
  );
}

// ---------------------------------------------------------------- kinds

test("init reports the program, the libraries and the config it found", async () => {
  const { host, svc } = await build();
  const v = ok(handle({ id: 1, kind: "init", root: "/w" } as Req, svc, host), 1);
  assert.equal(v.root, "/w");
  assert.equal(host.root, "/w");
  assert.equal(v.configPath, "tsconfig.json");
  assert.equal(v.libFiles, 67);
  assert.ok(v.libBytes > 2_000_000);
  assert.deepEqual(v.missingLibs, []);
  assert.equal(v.snapshot.files, 3);
  assert.equal(v.snapshot.sourceFiles, 2);
  assert.equal(v.snapshot.truncated, false);
  assert.equal(typeof v.programMs, "number");
  assert.ok(v.programMs >= 0);
});

test("setSnapshot replaces the workspace and reports truncation", async () => {
  const { host, svc } = await build();
  const v = ok(
    handle(
      { id: 2, kind: "setSnapshot", files: [["only.ts", "export const x = 1;\n"]], truncated: true, totalBytes: 19 } as Req,
      svc,
      host
    ),
    2
  );
  assert.equal(v.snapshot.files, 1);
  assert.equal(v.snapshot.sourceFiles, 1);
  assert.equal(v.snapshot.truncated, true, "truncation must survive the round trip");
  assert.equal(typeof v.programMs, "number");
});

test("updateBuffer bumps a version, and only when the text moved", async () => {
  const { host, svc } = await build();
  const first = ok(handle({ id: 3, kind: "updateBuffer", rel: "b.ts", text: "export const q = 1;\n" } as Req, svc, host), 3);
  assert.equal(first.rel, "b.ts");
  assert.ok(first.version >= 2);
  const again = ok(handle({ id: 4, kind: "updateBuffer", rel: "b.ts", text: "export const q = 1;\n" } as Req, svc, host), 4);
  assert.equal(again.version, first.version);
});

test("hover", async () => {
  const { host, svc } = await build();
  const v = ok(handle({ id: 5, kind: "hover", rel: "b.ts", pos: CALL } as Req, svc, host), 5);
  assert.equal(v.signature, "(alias) distance(from: Point, to: Point): number\nimport distance");
  assert.equal(B.slice(v.start, v.start + v.length), "distance");
  // A position with nothing under it answers null, not an error: the tooltip
  // asks on every mouse move.
  const none = ok(handle({ id: 6, kind: "hover", rel: "b.ts", pos: 1 } as Req, svc, host), 6);
  assert.equal(none, null);
});

test("definition crosses the file boundary and carries a line and column", async () => {
  const { host, svc } = await build();
  const v = ok(handle({ id: 7, kind: "definition", rel: "b.ts", pos: CALL } as Req, svc, host), 7);
  assert.equal(v.length, 1);
  assert.equal(v[0].rel, "a.ts", "the path handed to openFile must be workspace relative");
  assert.equal(v[0].line, 9);
  assert.equal(v[0].col, 17);
  assert.equal(A.slice(v[0].start, v[0].start + v[0].length), "distance");
});

test("references reads without opening anything", async () => {
  const { host, svc } = await build();
  const v = ok(handle({ id: 8, kind: "references", rel: "a.ts", pos: DECL } as Req, svc, host), 8);
  assert.equal(v.length, 4);
  assert.deepEqual([...new Set(v.map((h: any) => h.rel))].sort(), ["a.ts", "b.ts"]);
  const decl = v.find((h: any) => h.rel === "a.ts");
  assert.equal(decl.isDefinition, true);
  assert.equal(decl.text, "export function distance(from: Point, to: Point): number {");
  // Every hit carries the whole source line, which is what the list renders.
  for (const h of v) assert.ok(h.text.includes("distance"), h.text);
});

test("completions", async () => {
  const { host, svc } = await build();
  const v = ok(handle({ id: 9, kind: "completions", rel: "b.ts", pos: CALL } as Req, svc, host), 9);
  const names = v.map((c: any) => c.name);
  assert.ok(names.includes("distance"), "the imported symbol is missing from completions");
  assert.ok(names.includes("origin"));
  const d = v.find((c: any) => c.name === "distance");
  assert.equal(d.kind, "alias");
  assert.equal(typeof d.sortText, "string");
  assert.equal(typeof d.hasAction, "boolean");
});

test("diagnostics separate the syntactic from the semantic", async () => {
  const { host, svc } = await build();
  const v = ok(handle({ id: 10, kind: "diagnostics", rel: "b.ts" } as Req, svc, host), 10);
  assert.equal(v.length, 1);
  assert.deepEqual(
    { ...v[0], start: undefined, length: undefined },
    {
      start: undefined,
      length: undefined,
      message: "Type 'number' is not assignable to type 'string'.",
      category: "error",
      code: 2322,
      origin: "semantic",
    }
  );
  assert.equal(B.slice(v[0].start, v[0].start + v[0].length), "label");
  // And a real syntax error is reported as syntactic, before anything else.
  handle({ id: 11, kind: "updateBuffer", rel: "b.ts", text: "export const x = ;\n" } as Req, svc, host);
  const s = ok(handle({ id: 12, kind: "diagnostics", rel: "b.ts" } as Req, svc, host), 12);
  assert.ok(s.length >= 1);
  assert.equal(s[0].origin, "syntactic");
});

test("renameLocations answers a plan, never an edit", async () => {
  const { host, svc } = await build();
  const v = ok(handle({ id: 13, kind: "renameLocations", rel: "a.ts", pos: DECL, newName: "span" } as Req, svc, host), 13);
  assert.equal(v.canRename, true);
  assert.equal(v.displayName, "distance");
  assert.equal(v.hits.length, 4);
  assert.deepEqual([...new Set(v.hits.map((h: any) => h.rel))].sort(), ["a.ts", "b.ts"]);
  // Nothing here is a file content. The plan is spans; applying them is
  // somebody else's job, and the user's decision.
  for (const h of v.hits) assert.deepEqual(Object.keys(h).sort(), ["length", "prefixText", "rel", "start", "suffixText"]);
});

test("renameLocations refuses politely where a rename makes no sense", async () => {
  const { host, svc } = await build();
  // Offset 3 sits inside the leading comment.
  const v = ok(handle({ id: 14, kind: "renameLocations", rel: "b.ts", pos: 3, newName: "span" } as Req, svc, host), 14);
  assert.equal(v.canRename, false);
  assert.ok(v.reason.length > 0, "a refusal must say why");
  assert.deepEqual(v.hits, []);
});

// ---------------------------------------------------------------- malformed

test("every malformed request comes back as a refusal, never a throw", async () => {
  const { host, svc } = await build();
  const cases: Array<[unknown, number, string]> = [
    [null, -1, "malformed request"],
    ["hover", -1, "malformed request"],
    [{ id: 20 }, 20, "unknown kind"],
    [{ id: 21, kind: "nope" }, 21, "unknown kind"],
    [{ id: 22, kind: 7 }, 22, "unknown kind"],
    [{ kind: "hover", rel: "b.ts", pos: 0 }, -1, "id must be a number"],
    [{ id: 24, kind: "init" }, 24, "root must be a string"],
    [{ id: 25, kind: "setSnapshot", files: "nope" }, 25, "files must be an array"],
    [{ id: 26, kind: "setSnapshot", files: [["a.ts"]] }, 26, "[path, content] pairs"],
    [{ id: 27, kind: "setSnapshot", files: [[1, 2]] }, 27, "[path, content] pairs"],
    [{ id: 28, kind: "updateBuffer", rel: "b.ts" }, 28, "must be strings"],
    [{ id: 29, kind: "hover", rel: "", pos: 0 }, 29, "non-empty string"],
    [{ id: 30, kind: "hover", rel: 5, pos: 0 }, 30, "non-empty string"],
    [{ id: 31, kind: "hover", rel: "b.ts", pos: -1 }, 31, "non-negative"],
    [{ id: 32, kind: "hover", rel: "b.ts", pos: "x" }, 32, "non-negative"],
    [{ id: 33, kind: "hover", rel: "b.ts", pos: NaN }, 33, "non-negative"],
    [{ id: 34, kind: "definition", rel: "ghost.ts", pos: 0 }, 34, "not in the snapshot"],
    [{ id: 35, kind: "diagnostics", rel: "ghost.ts" }, 35, "not in the snapshot"],
    [{ id: 36, kind: "renameLocations", rel: "a.ts", pos: DECL, newName: "  " }, 36, "newName is empty"],
  ];
  for (const [req, id, needle] of cases) {
    let res: Res;
    try {
      res = handle(req as Req, svc, host);
    } catch (e) {
      assert.fail(`handle threw on ${JSON.stringify(req)}: ${String(e)}`);
    }
    bad(res!, id, needle);
  }
});

test("a crash inside the language service becomes an error response", async () => {
  const { host } = await build();
  const exploding = {
    getQuickInfoAtPosition() {
      throw new TypeError("boom");
    },
  } as unknown as import("typescript").LanguageService;
  const res = handle({ id: 40, kind: "hover", rel: "b.ts", pos: CALL } as Req, exploding, host);
  bad(res, 40, "TypeError: boom");
});

// ------------------------------------------------------- the gate and the view
//
// Neither of these needs a worker or a document, which is the point: the tier
// gate has to be provable, because the whole argument for shipping 1.6 MB of
// TypeScript is that the app refuses to when it would not pay off.

test("an over-budget workspace never even starts a worker", async () => {
  let asked = 0;
  client.configureTsIntel(
    {
      snapshot: async () => {
        asked++;
        // Deliberately larger than the budget below.
        return { files: [["a.ts", "export const a = 1;\n"]], truncated: false, total_bytes: 99_000_000 };
      },
    },
    { maxSnapshotBytes: 1000, maxSnapshotFiles: 10, maxProgramMs: 4000 }
  );
  const r = await client.enable("/some/huge/repo");
  assert.equal(asked, 1);
  assert.equal(r.tier, "B");
  assert.equal(client.tier(), "B");
  assert.ok(r.reason.includes("over the Tier A budget"), r.reason);
  assert.equal(r.bytes, 99_000_000);
  // Every query still answers, emptily, so a caller written once works in both
  // tiers instead of having to branch.
  assert.equal(await client.hover("a.ts", 0), null);
  assert.deepEqual(await client.definition("a.ts", 0), []);
  assert.deepEqual(await client.references("a.ts", 0), []);
  assert.deepEqual(await client.completions("a.ts", 0), []);
  assert.deepEqual(await client.diagnostics("a.ts"), []);
  client.updateBuffer("a.ts", "whatever");
  await assert.rejects(() => client.planRenameFromClient("a.ts", 0, "b", async () => ""), /needs the TypeScript/);
  client.disable();
});

test("a truncated snapshot is refused, because half a program answers confidently", async () => {
  client.configureTsIntel({
    snapshot: async () => ({ files: [["a.ts", "export const a = 1;\n"]], truncated: true, total_bytes: 19 }),
  });
  const r = await client.enable("/w");
  assert.equal(r.tier, "B");
  assert.equal(r.truncated, true);
  assert.ok(r.reason.includes("does not fit the Tier A budget"), r.reason);
  client.disable();
});

test("a backend that fails leaves the editor in tier B, not broken", async () => {
  client.configureTsIntel({
    snapshot: async () => {
      throw new Error("code_snapshot is not registered");
    },
  });
  const r = await client.enable("/w");
  assert.equal(r.tier, "B");
  assert.ok(r.reason.includes("code_snapshot is not registered"));
  client.disable();
});

test("tier A defaults on only for a project that looks like one", () => {
  assert.equal(client.autoEnable(["package.json", "src"]), true);
  assert.equal(client.autoEnable(["tsconfig.json"]), true);
  assert.equal(client.autoEnable(["Cargo.toml", "src", "README.md"]), false);
  assert.equal(client.autoEnable([]), false);
});

test("referencesHtml groups, escapes and stays pure", () => {
  const hits: RefHit[] = [
    { rel: "b.ts", start: 1, length: 8, line: 13, col: 21, text: "  use(x);", isWrite: false, isDefinition: false },
    { rel: "a.ts", start: 2, length: 8, line: 9, col: 17, text: "let x = 1;", isWrite: true, isDefinition: true },
    { rel: "b.ts", start: 0, length: 8, line: 2, col: 1, text: 'const s = "<b>&";', isWrite: false, isDefinition: false },
  ];
  const html = referencesHtml(hits);
  assert.ok(html.includes("2 references in 2 files") === false);
  assert.ok(html.includes("3 references in 2 files"));
  // Files sorted, hits sorted by offset inside each file.
  assert.ok(html.indexOf(">a.ts<") < html.indexOf(">b.ts<"));
  assert.ok(html.indexOf('data-ref-line="2"') < html.indexOf('data-ref-line="13"'));
  assert.ok(html.includes('class="rr def write"'));
  // Source text is escaped, or a file containing markup rewrites the panel.
  assert.ok(html.includes("&lt;b&gt;&amp;"));
  assert.ok(!html.includes("<b>&"));
  assert.equal(referencesHtml([]), '<div class="ts-refs empty">no references</div>');
});

test("a position past the end of a file does not crash the dispatcher", async () => {
  const { host, svc } = await build();
  const res = handle({ id: 41, kind: "hover", rel: "b.ts", pos: B.length + 5000 } as Req, svc, host);
  assert.equal(res.id, 41);
  // Either answer is acceptable; a throw is not.
  assert.ok(res.ok === true || res.ok === false);
});
