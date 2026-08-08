// The language service, driven headlessly.
//
// `ts.createLanguageService` has no idea it is normally inside a worker inside
// a WKWebView. Given the same host, it answers the same way in Node, which
// means the part of this feature that is genuinely hard to verify by looking at
// a window is the part that is easiest to verify here.
//
//   ./node_modules/.bin/tsc -p tools/tsintel/tsconfig.json
//   node --test tools/tsintel/out/

import { WorkspaceHost, lineColOf, lineTextOf, toPath, toRel, ts } from "../../src/tsintel/host.js";

// @types/node is not a dependency of this app. A literal `import "node:fs"`
// would not type-check; a computed specifier is left alone by TypeScript and
// resolved normally by Node at runtime.
const builtin = (name: string): Promise<any> => import(name);
const { test } = await builtin("node:test");
const assert = (await builtin("node:assert/strict")).default;
const fs = await builtin("node:fs");
const path = await builtin("node:path");
const { fileURLToPath, pathToFileURL } = await builtin("node:url");

/** Walk up until the app directory, so the tests run from anywhere. */
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

function read(rel: string): string {
  return fs.readFileSync(path.join(PROJ, rel), "utf8");
}

async function build(): Promise<{ host: WorkspaceHost; svc: any }> {
  const host = new WorkspaceHost();
  const files: Array<[string, string]> = [];
  let bytes = 0;
  for (const name of fs.readdirSync(PROJ).sort()) {
    const text = fs.readFileSync(path.join(PROJ, name), "utf8");
    files.push([name, text]);
    bytes += text.length;
  }
  host.setSnapshot(files, false, bytes);
  host.setRoot(PROJ);
  // Exactly what the worker does, with fs standing in for fetch: the same
  // transitive walk over the same 67 bundled files.
  await host.loadLibs(async (name: string) => fs.readFileSync(path.join(TSLIB, name), "utf8"));
  const svc = ts.createLanguageService(host, ts.createDocumentRegistry());
  return { host, svc };
}

const A = read("a.ts");
const B = read("b.ts");
/** Offset inside the `distance` identifier of `distance(origin, target)`. */
const CALL = B.indexOf("distance(origin, target)") + 2;
/** Offset inside `distance` where a.ts declares it. */
const DECL = A.indexOf("export function distance") + "export function di".length;

test("the bundled tslib closure is the one copy-libs produces", async () => {
  const mod = await builtin(pathToFileURL(path.join(APP, "tools", "tsintel", "copy-libs.mjs")).href);
  const { files, missing } = mod.closure();
  assert.deepEqual(missing, []);
  assert.equal(files.size, 67);
  const shipped = fs.readdirSync(TSLIB).filter((f: string) => f.endsWith(".d.ts")).sort();
  assert.deepEqual(shipped, [...files.keys()].sort(), "public/tslib is stale, run copy-libs.mjs");
  const utf8 = new TextEncoder();
  let bytes = 0;
  for (const t of files.values()) bytes += utf8.encode(t as string).length;
  assert.equal(bytes, 2434320);
});

test("the host loads the default libraries and roots only the sources", async () => {
  const { host } = await build();
  assert.equal(host.libStats().files, 67);
  assert.deepEqual([...host.missedLibs], []);
  // tsconfig.json is in the Map but is not a program root, and neither is
  // anything under node_modules.
  assert.deepEqual(host.getScriptFileNames(), ["/a.ts", "/b.ts"]);
  assert.equal(host.stats().files, 3);
  assert.equal(host.configPath, "tsconfig.json");
  assert.equal(host.getCompilationSettings().strict, true);
  assert.equal(host.getCompilationSettings().noEmit, true);
});

test("exactly one semantic diagnostic, and it is the seeded one", async () => {
  const { svc } = await build();
  assert.deepEqual(svc.getSemanticDiagnostics("/a.ts"), []);
  assert.deepEqual(svc.getSyntacticDiagnostics("/a.ts"), []);
  assert.deepEqual(svc.getSyntacticDiagnostics("/b.ts"), []);
  const diags = svc.getSemanticDiagnostics("/b.ts");
  assert.equal(diags.length, 1, `expected one diagnostic, got ${diags.length}`);
  const d = diags[0];
  assert.equal(
    ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    "Type 'number' is not assignable to type 'string'."
  );
  assert.equal(d.code, 2322);
  // The span covers `label`, the declaration that asked for the wrong type.
  assert.equal(B.slice(d.start, d.start + d.length), "label");
});

test("a workspace with no tsconfig still gets a modern strict program", async () => {
  const host = new WorkspaceHost();
  host.setSnapshot(
    [
      ["a.ts", read("a.ts")],
      ["b.ts", read("b.ts")],
    ],
    false,
    0
  );
  await host.loadLibs(async (n: string) => fs.readFileSync(path.join(TSLIB, n), "utf8"));
  assert.equal(host.configPath, null);
  const o = host.getCompilationSettings();
  assert.equal(o.strict, true);
  assert.equal(o.target, ts.ScriptTarget.ES2022);
  assert.equal(o.moduleResolution, ts.ModuleResolutionKind.Bundler);
  const svc = ts.createLanguageService(host, ts.createDocumentRegistry());
  // Same single error: the fallback has to be a working program, not a
  // permissive one that quietly stops finding anything.
  assert.equal(svc.getSemanticDiagnostics("/b.ts").length, 1);
});

test("getQuickInfoAtPosition returns the real signature", async () => {
  const { svc } = await build();
  // At the declaration: the function itself.
  const decl = svc.getQuickInfoAtPosition("/a.ts", DECL);
  assert.ok(decl, "no quick info at the declaration");
  assert.equal(
    ts.displayPartsToString(decl.displayParts),
    "function distance(from: Point, to: Point): number"
  );
  // At the call in b.ts: the imported alias, with the same signature resolved
  // THROUGH the import. Getting this one right is what proves the program
  // actually crosses the file boundary rather than guessing from the text.
  const call = svc.getQuickInfoAtPosition("/b.ts", CALL);
  assert.ok(call, "no quick info at the call site");
  assert.equal(
    ts.displayPartsToString(call.displayParts),
    "(alias) distance(from: Point, to: Point): number\nimport distance"
  );
  assert.equal(B.slice(call.textSpan.start, call.textSpan.start + call.textSpan.length), "distance");
});

test("getDefinitionAtPosition crosses the file boundary", async () => {
  const { svc } = await build();
  const defs = svc.getDefinitionAtPosition("/b.ts", CALL);
  assert.ok(defs && defs.length >= 1);
  assert.equal(defs[0].fileName, "/a.ts");
  assert.equal(defs[0].name, "distance");
  const a = read("a.ts");
  assert.equal(a.slice(defs[0].textSpan.start, defs[0].textSpan.start + defs[0].textSpan.length), "distance");
});

test("findRenameLocations reaches every site in both files", async () => {
  const { svc } = await build();
  const locs = svc.findRenameLocations("/a.ts", DECL, false, false, {
    providePrefixAndSuffixTextForRename: true,
  });
  assert.ok(locs);
  assert.equal(locs.length, 4, `expected 4 rename sites, got ${locs.length}`);
  const files = [...new Set(locs.map((l: any) => l.fileName))].sort();
  assert.deepEqual(files, ["/a.ts", "/b.ts"]);
  // One declaration in a.ts, one import specifier and two calls in b.ts.
  assert.equal(locs.filter((l: any) => l.fileName === "/a.ts").length, 1);
  assert.equal(locs.filter((l: any) => l.fileName === "/b.ts").length, 3);
  assert.deepEqual(locs.map((l: any) => l.prefixText ?? null), [null, null, null, null]);
});

test("renaming through an import stays local, and says so with prefixText", async () => {
  const { svc } = await build();
  // Renaming from the CALL site renames b.ts's alias, not a.ts's export. The
  // import must become `distance as newName`, which TypeScript expresses as
  // prefixText on the import specifier. An implementation that drops prefixText
  // writes `import { newName }` instead, which does not resolve, and it writes
  // it into three files at once.
  const locs = svc.findRenameLocations("/b.ts", CALL, false, false, {
    providePrefixAndSuffixTextForRename: true,
  });
  assert.equal(locs.length, 3);
  assert.deepEqual([...new Set(locs.map((l: any) => l.fileName))], ["/b.ts"]);
  assert.equal(locs.filter((l: any) => l.prefixText === "distance as ").length, 1);
});

test("findReferences groups are flattened without duplicates", async () => {
  const { svc } = await build();
  const groups = svc.findReferences("/a.ts", DECL);
  const spans = new Set<string>();
  for (const g of groups) for (const r of g.references) spans.add(`${r.fileName}:${r.textSpan.start}`);
  assert.equal(spans.size, 4);
  assert.equal([...spans].filter((s) => s.startsWith("/a.ts")).length, 1);
});

test("an editor buffer outranks the snapshot and bumps only its own version", async () => {
  const { host, svc } = await build();
  const v0 = host.getScriptVersion("/b.ts");
  const av0 = host.getScriptVersion("/a.ts");
  // Fix the seeded error in the buffer without touching any file.
  host.updateBuffer("b.ts", B.replace("export const label: string =", "export const label: number ="));
  assert.notEqual(host.getScriptVersion("/b.ts"), v0);
  assert.equal(host.getScriptVersion("/a.ts"), av0);
  assert.deepEqual(svc.getSemanticDiagnostics("/b.ts"), []);
  // Rewriting identical text must not bump anything: the editor pushes on every
  // keystroke and a spurious version invalidates the whole program.
  const v1 = host.getScriptVersion("/b.ts");
  host.updateBuffer("b.ts", host.text("b.ts")!);
  assert.equal(host.getScriptVersion("/b.ts"), v1);
});

test("a fresh snapshot replaces the buffers rather than layering under them", async () => {
  const { host, svc } = await build();
  host.updateBuffer("b.ts", "export const label: number = 1;\n");
  assert.deepEqual(svc.getSemanticDiagnostics("/b.ts"), []);
  host.setSnapshot(
    [
      ["a.ts", read("a.ts")],
      ["b.ts", read("b.ts")],
      ["tsconfig.json", read("tsconfig.json")],
    ],
    false,
    0
  );
  assert.equal(svc.getSemanticDiagnostics("/b.ts").length, 1);
});

test("the host reports truncation instead of hiding it", async () => {
  const host = new WorkspaceHost();
  host.setSnapshot([["a.ts", read("a.ts")]], true, 999);
  assert.equal(host.stats().truncated, true);
});

test("module resolution reaches node_modules typings without rooting them", async () => {
  const host = new WorkspaceHost();
  host.setSnapshot(
    [
      ["tsconfig.json", read("tsconfig.json")],
      ["main.ts", 'import { greet } from "tiny";\nexport const hello: number = greet("x");\n'],
      ["node_modules/tiny/package.json", '{"name":"tiny","types":"index.d.ts"}\n'],
      ["node_modules/tiny/index.d.ts", "export declare function greet(who: string): string;\n"],
    ],
    false,
    0
  );
  await host.loadLibs(async (n: string) => fs.readFileSync(path.join(TSLIB, n), "utf8"));
  assert.deepEqual(host.getScriptFileNames(), ["/main.ts"], "a d.ts must never be a program root");
  const svc = ts.createLanguageService(host, ts.createDocumentRegistry());
  const diags = svc.getSemanticDiagnostics("/main.ts");
  // If the package.json exception did not work, `greet` would be `any` and
  // this assignment would produce NO error. That silence is exactly the
  // failure mode the exception exists to prevent.
  assert.equal(diags.length, 1);
  assert.equal(
    ts.flattenDiagnosticMessageText(diags[0].messageText, "\n"),
    "Type 'string' is not assignable to type 'number'."
  );
});

test("path helpers are exact", () => {
  assert.equal(toPath("src/a.ts"), "/src/a.ts");
  assert.equal(toPath("./src/a.ts"), "/src/a.ts");
  assert.equal(toPath("/src/a.ts"), "/src/a.ts");
  assert.equal(toRel("/src/a.ts"), "src/a.ts");
  const text = "one\ntwo\nthree\n";
  assert.deepEqual(lineColOf(text, 0), { line: 1, col: 1 });
  assert.deepEqual(lineColOf(text, 4), { line: 2, col: 1 });
  assert.deepEqual(lineColOf(text, 6), { line: 2, col: 3 });
  assert.equal(lineTextOf(text, 6), "two");
  assert.equal(lineTextOf("a\r\nb", 0), "a");
});
