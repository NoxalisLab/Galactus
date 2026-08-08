// Copy the TypeScript default library closure into public/tslib.
//
//   node tools/tsintel/copy-libs.mjs [--check]
//
// node_modules/typescript/lib holds 100 lib.*.d.ts files, about 5.5 MB, most of
// which are near duplicates: lib.es2015.full.d.ts, lib.es2016.full.d.ts and so
// on differ from each other by a handful of declarations. Shipping all of them
// would spend roughly 100 kB of compressed dmg on target levels nobody selects.
//
// So this walks the reference graph from ONE root, lib.es2023.full.d.ts, and
// copies only what it actually reaches: 67 files, 2 434 320 bytes raw and about
// 326 kB gzipped. Everything a workspace's own `lib` setting can name, from
// lib.es5.d.ts up to lib.dom.iterable.d.ts, is inside that closure, because the
// full file is defined as the union of them.
//
// `--check` verifies the destination matches without writing, which is what the
// test suite calls: a stale public/tslib is a bug that only shows up in the
// packaged app, where nobody is watching the console.

import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..", "..");
const SRC = join(APP, "node_modules", "typescript", "lib");
const DEST = join(APP, "public", "tslib");
const ROOT = "lib.es2023.full.d.ts";

const REF = /\/\/\/\s*<reference\s+lib\s*=\s*"([^"]+)"\s*\/>/g;

/** The transitive closure of `/// <reference lib=...>` from one root. */
export function closure(srcDir = SRC, root = ROOT) {
  const out = new Map();
  const queue = [root];
  const seen = new Set();
  const missing = [];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const path = join(srcDir, name);
    if (!existsSync(path)) {
      missing.push(name);
      continue;
    }
    const text = readFileSync(path, "utf8");
    out.set(name, text);
    REF.lastIndex = 0;
    for (let m = REF.exec(text); m; m = REF.exec(text)) queue.push(`lib.${m[1]}.d.ts`);
  }
  return { files: out, missing };
}

function totals(files) {
  let bytes = 0;
  for (const text of files.values()) bytes += Buffer.byteLength(text, "utf8");
  return { count: files.size, bytes };
}

function main() {
  const check = process.argv.includes("--check");
  if (!existsSync(SRC)) {
    console.error(`copy-libs: ${SRC} does not exist; run npm install first`);
    process.exit(1);
  }
  const { files, missing } = closure();
  if (missing.length) {
    console.error(`copy-libs: ${missing.length} referenced libs are missing: ${missing.join(", ")}`);
    process.exit(1);
  }
  const t = totals(files);

  if (check) {
    if (!existsSync(DEST)) {
      console.error(`copy-libs: ${DEST} does not exist; run node tools/tsintel/copy-libs.mjs`);
      process.exit(1);
    }
    const have = readdirSync(DEST).filter((f) => f.endsWith(".d.ts")).sort();
    const want = [...files.keys()].sort();
    let bad = 0;
    if (have.join("\n") !== want.join("\n")) {
      console.error(`copy-libs: public/tslib holds ${have.length} files, the closure needs ${want.length}`);
      bad++;
    }
    for (const [name, text] of files) {
      const p = join(DEST, name);
      if (!existsSync(p) || readFileSync(p, "utf8") !== text) {
        console.error(`copy-libs: ${name} differs from node_modules`);
        bad++;
      }
    }
    if (bad) process.exit(1);
    console.log(`copy-libs: public/tslib is current, ${t.count} files, ${t.bytes} bytes`);
    return;
  }

  // Rewritten whole, never merged: a lib file left behind by an older
  // TypeScript would be served instead of the one the service expects.
  if (existsSync(DEST)) rmSync(DEST, { recursive: true, force: true });
  mkdirSync(DEST, { recursive: true });
  for (const [name, text] of files) writeFileSync(join(DEST, name), text);
  const onDisk = readdirSync(DEST).reduce((n, f) => n + statSync(join(DEST, f)).size, 0);
  console.log(`copy-libs: ${t.count} files, ${t.bytes} bytes -> ${DEST} (${onDisk} bytes on disk)`);
}

// Only run when invoked directly, so the closure helper stays importable.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
