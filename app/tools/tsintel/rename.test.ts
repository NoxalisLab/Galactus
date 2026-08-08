// Rename: the exact bytes, and the proof that nothing was written.
//
// Two things are being defended here. The first is correctness of the edit
// itself, asserted byte for byte on whole files, because a rename that is
// almost right is worse than one that fails: it lands in five files and the
// user finds the damage a week later. The second is the product rule. This
// module must have NO writer, and `no writer survives into the compiled
// output` greps the emitted JavaScript to say so, which is the only form of
// that assertion that cannot be defeated by a refactor.

import { WorkspaceHost, ts } from "../../src/tsintel/host.js";
import { applyRenameHits, planRename } from "../../src/tsintel/rename.js";
import type { RenameHit } from "../../src/tsintel/protocol.js";

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
  for (const name of fs.readdirSync(PROJ).sort()) {
    files.push([name, fs.readFileSync(path.join(PROJ, name), "utf8")]);
  }
  host.setSnapshot(files, false, 0);
  await host.loadLibs(async (n: string) => fs.readFileSync(path.join(TSLIB, n), "utf8"));
  const svc = ts.createLanguageService(host, ts.createDocumentRegistry());
  const readFile = async (rel: string) => host.text(rel);
  return { host, svc, readFile };
}

// The whole files, as they must come out. Written in full rather than derived
// with a replace, because a derived expectation would make the same mistake the
// implementation might: a global replace also rewrites the word `distance`
// inside b.ts's comment, and that comment is here precisely to catch it.
const A_AFTER = `// Fixture: the file that DEFINES things. Kept deliberately small and
// deliberately typed, so a test can assert an exact hover string.

export interface Point {
  x: number;
  y: number;
}

export function span(from: Point, to: Point): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return Math.sqrt(dx * dx + dy * dy);
}
`;

const B_AFTER = `// Fixture: the file that USES a.ts, and carries exactly ONE seeded type error.
//
// One error, not two, so a test can assert the count as well as the message: a
// host that half works usually produces either zero diagnostics (nothing
// resolved) or a flood (the default library never loaded), and both of those
// are caught by asserting exactly one.

import { span, Point } from "./a";

const origin: Point = { x: 0, y: 0 };
const target: Point = { x: 3, y: 4 };

export const near = span(origin, target);

// SEEDED ERROR: distance returns a number, and this asks for a string.
export const label: string = span(origin, target);
`;

/** Renaming from the import alias is a LOCAL rename: a.ts keeps its export and
 *  b.ts gains an `as` clause. */
const B_AFTER_ALIAS = `// Fixture: the file that USES a.ts, and carries exactly ONE seeded type error.
//
// One error, not two, so a test can assert the count as well as the message: a
// host that half works usually produces either zero diagnostics (nothing
// resolved) or a flood (the default library never loaded), and both of those
// are caught by asserting exactly one.

import { distance as span, Point } from "./a";

const origin: Point = { x: 0, y: 0 };
const target: Point = { x: 3, y: 4 };

export const near = span(origin, target);

// SEEDED ERROR: distance returns a number, and this asks for a string.
export const label: string = span(origin, target);
`;

test("planRename produces both files, byte for byte", async () => {
  const { svc, readFile } = await build();
  const edits = await planRename(svc, "/a.ts", DECL, "span", readFile);
  assert.deepEqual(edits.map((e) => e.rel), ["a.ts", "b.ts"]);
  assert.equal(edits[0].content, A_AFTER);
  assert.equal(edits[1].content, B_AFTER);
  // The comment mentioning the old name is untouched, which is the difference
  // between a rename and a search and replace.
  assert.ok(edits[1].content.includes("// SEEDED ERROR: distance returns a number"));
});

test("planRename through an import stays local and keeps the export", async () => {
  const { svc, readFile } = await build();
  const edits = await planRename(svc, "/b.ts", CALL, "span", readFile);
  assert.deepEqual(edits.map((e) => e.rel), ["b.ts"]);
  assert.equal(edits[0].content, B_AFTER_ALIAS);
});

test("planRename writes nothing, and the fixtures prove it", async () => {
  const before = fs.readdirSync(PROJ).sort().map((n: string) => {
    const p = path.join(PROJ, n);
    const st = fs.statSync(p);
    return [n, fs.readFileSync(p, "utf8"), st.mtimeMs, st.size];
  });
  const { svc, readFile } = await build();
  const edits = await planRename(svc, "/a.ts", DECL, "span", readFile);
  assert.equal(edits.length, 2);
  const after = fs.readdirSync(PROJ).sort().map((n: string) => {
    const p = path.join(PROJ, n);
    const st = fs.statSync(p);
    return [n, fs.readFileSync(p, "utf8"), st.mtimeMs, st.size];
  });
  assert.deepEqual(after, before, "planRename touched the disk");
});

test("planRename refuses rather than guessing", async () => {
  const { svc, readFile } = await build();
  await assert.rejects(() => planRename(svc, "/a.ts", DECL, "   ", readFile), /needs a new name/);
  await assert.rejects(() => planRename(svc, "/a.ts", DECL, "distance", readFile), /already the name/);
  // Offset 3 is inside a comment.
  await assert.rejects(() => planRename(svc, "/b.ts", 3, "span", readFile), /./);
  // A file the caller cannot read is a refusal, not a partial rename.
  await assert.rejects(
    () => planRename(svc, "/a.ts", DECL, "span", async (rel: string) => (rel === "a.ts" ? A : undefined)),
    /cannot be read/
  );
});

// ---------------------------------------------------------------- unit

test("applyRenameHits edits back to front so earlier spans cannot shift later ones", () => {
  const src = "aa bbbb cc\n";
  const hits: RenameHit[] = [
    { rel: "f.ts", start: 0, length: 2 },
    { rel: "f.ts", start: 3, length: 4 },
    { rel: "f.ts", start: 8, length: 2 },
  ];
  const out = applyRenameHits(hits, "XYZ", new Map([["f.ts", src]]));
  assert.deepEqual(out, [{ rel: "f.ts", content: "XYZ XYZ XYZ\n" }]);
});

test("applyRenameHits honours prefixText and suffixText", () => {
  const src = "const { a } = o;\n";
  const out = applyRenameHits(
    [{ rel: "f.ts", start: 8, length: 1, prefixText: "a: " }],
    "b",
    new Map([["f.ts", src]])
  );
  assert.equal(out[0].content, "const { a: b } = o;\n");
});

test("applyRenameHits refuses overlapping edits and unknown files", () => {
  const src = "abcdef\n";
  assert.throws(
    () =>
      applyRenameHits(
        [
          { rel: "f.ts", start: 0, length: 4 },
          { rel: "f.ts", start: 2, length: 4 },
        ],
        "X",
        new Map([["f.ts", src]])
      ),
    /overlapping/
  );
  assert.throws(
    () => applyRenameHits([{ rel: "ghost.ts", start: 0, length: 1 }], "X", new Map()),
    /not in the snapshot/
  );
});

test("applyRenameHits leaves a file alone when the edit changes nothing", () => {
  const out = applyRenameHits(
    [{ rel: "f.ts", start: 0, length: 1 }],
    "a",
    new Map([["f.ts", "abc"]])
  );
  assert.deepEqual(out, []);
});

// ---------------------------------------------------------------- the rule

test("no writer survives into the compiled output", () => {
  const js = path.join(APP, "tools", "tsintel", "out", "src", "tsintel", "rename.js");
  assert.ok(fs.existsSync(js), "compile first: tsc -p tools/tsintel/tsconfig.json");
  // Comments survive compilation and this file explains at length what it must
  // not do, so the grep runs on code with the comments stripped.
  const src = fs
    .readFileSync(js, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  // Anything that could reach a disk, a backend command or another thread. If
  // one of these ever appears, the rename stopped being a proposal.
  const forbidden = [
    "writeFile",
    "writeFileSync",
    "codeWrite",
    "code_write",
    "invoke(",
    "node:fs",
    'require("fs")',
    "postMessage",
    "localStorage",
    "XMLHttpRequest",
    "fetch(",
  ];
  for (const needle of forbidden) {
    assert.ok(!src.includes(needle), `rename.js contains ${JSON.stringify(needle)}`);
  }
  // And it imports NOTHING at runtime. Every one of its imports is type-only
  // and therefore erased, which is what keeps the 9 MB typescript module out of
  // the main thread: client.ts calls applyRenameHits, and one value import from
  // host.ts here would pull the whole language service into the main bundle.
  const imports = [...src.matchAll(/from ["']([^"']+)["']/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, []);
  assert.ok(!src.includes("typescript"), "rename.js must not reference typescript at runtime");
});
