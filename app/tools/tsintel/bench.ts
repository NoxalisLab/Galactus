// What Tier A actually costs, measured.
//
//   node tools/tsintel/out/tools/tsintel/bench.js <root> [--roots src/]
//   node tools/tsintel/out/tools/tsintel/bench.js --snapshot snap.json [--roots src/]
//
// The tier gate in client.ts refuses Tier A when the first program takes more
// than four seconds. That number needs evidence, and this is where it comes
// from: the same host, the same 67 default libraries, the same workspace, timed
// end to end.
//
// READ THIS BEFORE QUOTING THE NUMBER. It is a Node number. WKWebView is a
// different JavaScript engine on the same silicon, the worker pays a cold start
// Node does not, and the 9 MB parse of typescript.js lands in a different JIT.
// Nothing here measures that, and nothing here can: the boot cost inside the
// packaged app has to be read off the app's own log line, which client.ts emits
// on every init. What this proves is the SHAPE of the cost, which files
// dominate it, and whether a given workspace is anywhere near the ceiling.
//
// `--snapshot` reads the output of `cargo run --bin gx-snapshot -- <root> --json`,
// which means the benchmark can run over the exact bytes the Rust walk produces
// rather than over a second implementation of the same rules.

import { WorkspaceHost, ts } from "../../src/tsintel/host.js";

const builtin = (name: string): Promise<any> => import(name);
const fs = await builtin("node:fs");
const path = await builtin("node:path");
const { fileURLToPath } = await builtin("node:url");
const proc = (globalThis as unknown as { process: any }).process;

// ---------------------------------------------------------------- the walk

// Mirrors app/src-tauri/src/snapshot.rs. The Rust walk is authoritative; this
// exists so the benchmark runs without a cargo build, and `--snapshot` is there
// for when the two must be proved identical.
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  ".turbo",
]);
const EXTS = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json"];
const MAX_FILE_BYTES = 4 * 1024 * 1024;

function isBundledDefaultLib(rel: string, name: string): boolean {
  if (!(name.startsWith("lib.") && name.endsWith(".d.ts"))) return false;
  const parts = rel.split("/");
  return parts.length >= 3 && parts[parts.length - 2] === "lib" && parts[parts.length - 3] === "typescript";
}

function walk(dir: string, rel: string, inModules: boolean, out: Array<[string, string]>): void {
  let entries: any[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const files: any[] = [];
  const dirs: any[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) dirs.push(e);
    else if (e.isFile()) files.push(e);
  }
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  dirs.sort((a, b) => {
    const ka = a.name === "node_modules" ? 1 : 0;
    const kb = b.name === "node_modules" ? 1 : 0;
    return ka - kb || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const e of files) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    const keep = inModules
      ? e.name === "package.json" || (e.name.endsWith(".d.ts") && !isBundledDefaultLib(childRel, e.name))
      : EXTS.some((x) => e.name.endsWith("." + x));
    if (!keep) continue;
    const full = path.join(dir, e.name);
    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch {
      continue;
    }
    if (size > MAX_FILE_BYTES) continue;
    let text: string;
    try {
      const raw = new Uint8Array(fs.readFileSync(full));
      if (raw.includes(0)) continue;
      text = decoder.decode(raw);
    } catch {
      continue;
    }
    out.push([childRel, text]);
  }
  for (const e of dirs) {
    const entering = e.name === "node_modules";
    if (!inModules && SKIP_DIRS.has(e.name) && !entering) continue;
    walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, inModules || entering, out);
  }
}

// ---------------------------------------------------------------- harness

function appDir(): string {
  let d = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(d, "src", "tsintel", "host.ts"))) return d;
    d = path.dirname(d);
  }
  throw new Error("cannot locate the app directory");
}

function pad(label: string): string {
  return (label + " ".repeat(18)).slice(0, 18);
}

async function main(): Promise<void> {
  const argv: string[] = proc.argv.slice(2);
  let root = "";
  let snapshotFile = "";
  let rootsPrefix = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--snapshot") snapshotFile = argv[++i];
    else if (argv[i] === "--roots") rootsPrefix = argv[++i];
    else if (!root) root = argv[i];
  }
  if (!root && !snapshotFile) {
    console.error("usage: bench.js <root> [--roots src/] | --snapshot snap.json [--roots src/]");
    proc.exit(1);
  }

  let files: Array<[string, string]> = [];
  let truncated = false;
  let source = "";
  const tWalk = Date.now();
  if (snapshotFile) {
    const payload = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
    files = payload.files;
    truncated = !!payload.truncated;
    source = `gx-snapshot json (${snapshotFile})`;
  } else {
    walk(path.resolve(root), "", false, files);
    source = `node walk (${path.resolve(root)})`;
  }
  const walkMs = Date.now() - tWalk;

  // `--roots` keeps every node_modules typing and every config file, and drops
  // workspace sources outside the prefix. That is how "the program over
  // app/src" is expressed: the resolution surface is unchanged, only the roots
  // shrink.
  if (rootsPrefix) {
    files = files.filter(
      ([p]) => p.startsWith(rootsPrefix) || p.includes("node_modules/") || !p.includes("/")
    );
  }

  let bytes = 0;
  for (const [, text] of files) bytes += text.length;

  const host = new WorkspaceHost();
  host.setSnapshot(files, truncated, bytes);

  const tslib = path.join(appDir(), "public", "tslib");
  const tLibs = Date.now();
  await host.loadLibs(async (name: string) => fs.readFileSync(path.join(tslib, name), "utf8"));
  const libMs = Date.now() - tLibs;

  const tCreate = Date.now();
  const svc = ts.createLanguageService(host, ts.createDocumentRegistry());
  const program = svc.getProgram();
  const programMs = Date.now() - tCreate;

  const roots = host.getScriptFileNames();
  const tFirst = Date.now();
  let firstCount = 0;
  if (roots.length) {
    firstCount =
      svc.getSyntacticDiagnostics(roots[0]).length + svc.getSemanticDiagnostics(roots[0]).length;
  }
  const firstMs = Date.now() - tFirst;

  const tAll = Date.now();
  let allCount = 0;
  for (const f of roots) allCount += svc.getSemanticDiagnostics(f).length;
  const allMs = Date.now() - tAll;

  const heap = proc.memoryUsage().heapUsed;

  console.log(`${pad("source")}${source}`);
  console.log(`${pad("walk")}${files.length} files, ${bytes} bytes, truncated=${truncated}, ${walkMs} ms`);
  console.log(`${pad("program roots")}${roots.length} files${rootsPrefix ? ` (--roots ${rootsPrefix})` : ""}`);
  console.log(
    `${pad("libs")}${host.libStats().files} files, ${host.libStats().bytes} bytes, ${libMs} ms`
  );
  console.log(`${pad("source files seen")}${program ? program.getSourceFiles().length : 0} (roots + resolved)`);
  console.log(`${pad("program creation")}${programMs} ms`);
  console.log(`${pad("first diagnostics")}${firstMs} ms on ${roots[0] ?? "(none)"}, ${firstCount} reported`);
  console.log(`${pad("all diagnostics")}${allMs} ms over ${roots.length} files, ${allCount} reported`);
  console.log(`${pad("heapUsed")}${heap} bytes (${(heap / 1e6).toFixed(1)} MB)`);
  console.log(`${pad("engine")}node ${proc.versions.node} - NOT WKWebView, see the header of this file`);
}

await main();
