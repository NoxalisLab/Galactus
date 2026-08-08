// Galactus, the TypeScript LanguageServiceHost, over a Map instead of a disk.
//
// `ts.LanguageServiceHost.readFile` is synchronous. Tauri's `invoke` is not,
// and inside a WKWebView there is nothing that bridges the two: a synchronous
// XHR needs an HTTP origin the app's CSP does not grant, and `Atomics.wait` on
// the main thread freezes the window. That single fact decides the whole
// design. The service never touches a filesystem. It reads this Map, which is
// filled once by the `code_snapshot` command and then kept current by the
// editor's own buffer, and everything else follows from there.
//
// The default libraries are not in the snapshot. They are 2.4 MB of text that
// never changes, so they ship as a bundled asset under `public/tslib/` and are
// fetched from the app's own origin at init. `connect-src 'self'` permits that;
// it is a read of a file inside the bundle, not a network fetch, and the app
// stays fully offline.

import type * as TS from "typescript";
import tsModule from "typescript";

/**
 * The runtime TypeScript module. `lib/typescript.js` guards every filesystem
 * access behind `isNodeLikeSystem()`, which is false in a WKWebView worker, so
 * the browser path is the one that runs. Imported once here and shared, so the
 * 9 MB parse happens exactly once per worker.
 */
export const ts: typeof import("typescript") = tsModule as unknown as typeof import("typescript");

/** Where the bundled `lib.*.d.ts` closure is served from. */
export const LIB_DIR = "/tslib/";
/**
 * The one default library the app ships. `ts.getDefaultLibFileName` would ask
 * for `lib.es2022.full.d.ts` under an ES2022 target, and shipping every target
 * level would waste about 100 kB of dmg on near duplicates, so the es2023
 * closure answers for all of them. It is a superset: a program targeting ES2022
 * will not be told that `Array.prototype.findLast` is unavailable. That is the
 * price of one closure instead of six, and it errs towards silence rather than
 * towards a false error.
 */
export const DEFAULT_LIB = LIB_DIR + "lib.es2023.full.d.ts";

const SOURCE_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export interface SnapshotStats {
  /** Files in the Map, including node_modules typings. */
  files: number;
  /** Files the program takes as roots: workspace sources only. */
  sourceFiles: number;
  bytes: number;
  truncated: boolean;
}

interface Doc {
  text: string;
  version: number;
  snapshot: TS.IScriptSnapshot;
}

/** A file name as the language service knows it: absolute over a virtual root. */
export function toPath(rel: string): string {
  let r = rel.replace(/\\/g, "/");
  while (r.startsWith("./")) r = r.slice(2);
  return r.startsWith("/") ? r : "/" + r;
}

/** The inverse, for anything the user sees or the app opens. */
export function toRel(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}

function isSourceName(p: string): boolean {
  if (p.endsWith(".d.ts")) return false;
  return SOURCE_EXT.some((e) => p.endsWith(e));
}

/** 1-based line and column for a character offset. */
export function lineColOf(text: string, offset: number): { line: number; col: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let last = 0;
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      last = i + 1;
    }
  }
  return { line, col: clamped - last + 1 };
}

/** The whole line an offset falls on, trimmed of its newline. */
export function lineTextOf(text: string, offset: number): string {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let from = text.lastIndexOf("\n", clamped - 1) + 1;
  let to = text.indexOf("\n", clamped);
  if (to < 0) to = text.length;
  if (to > from && text.charCodeAt(to - 1) === 13) to--;
  return text.slice(from, to);
}

export class WorkspaceHost implements TS.LanguageServiceHost {
  private docs = new Map<string, Doc>();
  private libs = new Map<string, string>();
  /** Cached root list, invalidated whenever the set of files changes. */
  private roots: string[] | null = null;
  private options: TS.CompilerOptions | null = null;
  private dirs: Set<string> | null = null;
  private snapshotBytes = 0;
  private snapshotTruncated = false;
  /**
   * Library files a synchronous read asked for and did not find. The worker
   * drains this after a request and fetches them, so a config that reaches for
   * a lib outside the shipped closure degrades into one extra round trip
   * instead of into a wrong answer.
   */
  readonly missedLibs = new Set<string>();

  root = "";

  // ------------------------------------------------------------ contents

  setRoot(root: string): void {
    this.root = root;
  }

  /** Replace everything the snapshot owns. Editor buffers are replaced too:
   *  a fresh snapshot IS the new truth, and keeping a stale buffer over it is
   *  how a language service starts lying. */
  setSnapshot(files: Array<[string, string]>, truncated: boolean, totalBytes: number): void {
    this.docs.clear();
    for (const [rel, text] of files) this.write(toPath(rel), text);
    this.snapshotBytes = totalBytes;
    this.snapshotTruncated = truncated;
    this.invalidate();
  }

  /** The editor's buffer for one file, which outranks the snapshot until the
   *  next refresh. Bumps that file's version and nothing else. */
  updateBuffer(rel: string, text: string): number {
    const p = toPath(rel);
    const had = this.docs.has(p);
    const v = this.write(p, text);
    if (!had) this.invalidate();
    return v;
  }

  private write(p: string, text: string): number {
    const prev = this.docs.get(p);
    if (prev && prev.text === text) return prev.version;
    const version = (prev?.version ?? 0) + 1;
    this.docs.set(p, { text, version, snapshot: ts.ScriptSnapshot.fromString(text) });
    return version;
  }

  private invalidate(): void {
    this.roots = null;
    this.dirs = null;
    this.options = null;
  }

  has(rel: string): boolean {
    return this.docs.has(toPath(rel));
  }

  text(rel: string): string | undefined {
    return this.docs.get(toPath(rel))?.text ?? this.libs.get(toPath(rel));
  }

  stats(): SnapshotStats {
    let bytes = 0;
    for (const d of this.docs.values()) bytes += d.text.length;
    return {
      files: this.docs.size,
      sourceFiles: this.getScriptFileNames().length,
      bytes: bytes || this.snapshotBytes,
      truncated: this.snapshotTruncated,
    };
  }

  libStats(): { files: number; bytes: number } {
    let bytes = 0;
    for (const t of this.libs.values()) bytes += t.length;
    return { files: this.libs.size, bytes };
  }

  // ------------------------------------------------------------ libraries

  addLib(name: string, text: string): void {
    this.libs.set(name.startsWith(LIB_DIR) ? name : LIB_DIR + name, text);
    this.missedLibs.delete(name);
  }

  hasLibs(): boolean {
    return this.libs.has(DEFAULT_LIB);
  }

  /**
   * Pull the default library closure in. Transitive: it starts at one file and
   * follows `/// <reference lib="..." />`, so only what the shipped closure
   * actually references is fetched, and a target that needs less costs less.
   */
  async loadLibs(read: (name: string) => Promise<string>, from = DEFAULT_LIB): Promise<void> {
    const queue = [from.startsWith(LIB_DIR) ? from : LIB_DIR + from];
    const seen = new Set<string>();
    while (queue.length) {
      const path = queue.shift()!;
      if (seen.has(path)) continue;
      seen.add(path);
      let text = this.libs.get(path);
      if (text === undefined) {
        try {
          text = await read(path.slice(LIB_DIR.length));
        } catch {
          // A library that will not load is a real gap, and the caller sees it
          // through `missedLibs` rather than through a wall of phantom errors.
          this.missedLibs.add(path);
          continue;
        }
        this.libs.set(path, text);
      }
      const re = /\/\/\/\s*<reference\s+lib\s*=\s*"([^"]+)"\s*\/>/g;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        queue.push(LIB_DIR + "lib." + m[1] + ".d.ts");
      }
    }
    this.invalidate();
  }

  // ------------------------------------------------------------ ts host

  getScriptFileNames(): string[] {
    if (this.roots) return this.roots;
    const out: string[] = [];
    for (const p of this.docs.keys()) {
      // node_modules is reachable through module resolution but is never a
      // program root: rooting 112 third party typings turns a 300 ms program
      // into a 30 s one and changes not a single answer.
      if (p.includes("/node_modules/")) continue;
      if (isSourceName(p)) out.push(p);
    }
    out.sort();
    this.roots = out;
    return out;
  }

  getScriptVersion(fileName: string): string {
    return String(this.docs.get(fileName)?.version ?? 0);
  }

  getScriptSnapshot(fileName: string): TS.IScriptSnapshot | undefined {
    const d = this.docs.get(fileName);
    if (d) return d.snapshot;
    const lib = this.libs.get(fileName);
    if (lib !== undefined) return ts.ScriptSnapshot.fromString(lib);
    if (fileName.startsWith(LIB_DIR)) this.missedLibs.add(fileName);
    return undefined;
  }

  getCurrentDirectory(): string {
    return "/";
  }

  getDefaultLibFileName(): string {
    return DEFAULT_LIB;
  }

  getNewLine(): string {
    return "\n";
  }

  useCaseSensitiveFileNames(): boolean {
    // The Map is exact-keyed. Folding case here would let `./Foo` resolve to
    // `./foo` in the editor and fail in the build, which is the worst of both.
    return true;
  }

  fileExists(fileName: string): boolean {
    if (this.docs.has(fileName) || this.libs.has(fileName)) return true;
    if (fileName.startsWith(LIB_DIR)) this.missedLibs.add(fileName);
    return false;
  }

  readFile(fileName: string): string | undefined {
    const d = this.docs.get(fileName);
    if (d) return d.text;
    const lib = this.libs.get(fileName);
    if (lib !== undefined) return lib;
    if (fileName.startsWith(LIB_DIR)) this.missedLibs.add(fileName);
    return undefined;
  }

  realpath(p: string): string {
    return p;
  }

  private dirSet(): Set<string> {
    if (this.dirs) return this.dirs;
    const s = new Set<string>(["/"]);
    for (const p of [...this.docs.keys(), ...this.libs.keys()]) {
      let i = p.lastIndexOf("/");
      while (i > 0) {
        s.add(p.slice(0, i));
        i = p.lastIndexOf("/", i - 1);
      }
    }
    this.dirs = s;
    return s;
  }

  directoryExists(directoryName: string): boolean {
    const d = directoryName.replace(/\/+$/, "") || "/";
    return this.dirSet().has(d);
  }

  getDirectories(directoryName: string): string[] {
    const base = (directoryName.replace(/\/+$/, "") || "") + "/";
    const out = new Set<string>();
    for (const d of this.dirSet()) {
      if (d !== "/" && d.startsWith(base)) {
        const rest = d.slice(base.length);
        const cut = rest.indexOf("/");
        out.add(cut < 0 ? rest : rest.slice(0, cut));
      }
    }
    return [...out].sort();
  }

  /**
   * Only `parseJsonConfigFileContent` reaches this, to expand `include`. The
   * program's own roots come from `getScriptFileNames`, so an approximate
   * answer here costs nothing: glob semantics are not reimplemented.
   */
  readDirectory(
    path: string,
    extensions?: readonly string[],
    _exclude?: readonly string[],
    _include?: readonly string[],
    depth?: number
  ): string[] {
    const base = (path.replace(/\/+$/, "") || "") + "/";
    const out: string[] = [];
    for (const p of this.docs.keys()) {
      if (!p.startsWith(base)) continue;
      if (depth !== undefined) {
        const rest = p.slice(base.length);
        if (rest.split("/").length - 1 > depth) continue;
      }
      if (extensions && extensions.length && !extensions.some((e) => p.endsWith(e))) continue;
      out.push(p);
    }
    return out.sort();
  }

  // ------------------------------------------------------------ options

  getCompilationSettings(): TS.CompilerOptions {
    if (this.options) return this.options;
    this.options = this.readOptions();
    return this.options;
  }

  private configFile: string | null = null;

  /** Which tsconfig, if any, the settings came from. Surfaced to the UI so a
   *  workspace that silently fell back to the defaults says so. Reading it
   *  forces the parse, because "no config" and "not parsed yet" are the same
   *  null and telling them apart is the whole point of showing it. */
  get configPath(): string | null {
    this.getCompilationSettings();
    return this.configFile;
  }

  private readOptions(): TS.CompilerOptions {
    // A workspace with no tsconfig is not an error: plenty of repositories are
    // plain JavaScript, and a modern strict default answers better than
    // refusing to answer.
    const fallback: TS.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      jsx: ts.JsxEmit.ReactJSX,
      allowJs: true,
      resolveJsonModule: true,
      esModuleInterop: true,
      skipLibCheck: true,
    };
    const forced: TS.CompilerOptions = {
      // Nothing is ever emitted from here, and leaving emit paths in place only
      // invites "not under rootDir" diagnostics about files that exist purely
      // in memory.
      noEmit: true,
      declaration: false,
      declarationMap: false,
      sourceMap: false,
      composite: false,
      incremental: false,
      outDir: undefined,
      rootDir: undefined,
      declarationDir: undefined,
      tsBuildInfoFile: undefined,
      allowNonTsExtensions: true,
    };
    for (const name of ["/tsconfig.json", "/jsconfig.json"]) {
      const raw = this.docs.get(name)?.text;
      if (raw === undefined) continue;
      const parsed = ts.parseConfigFileTextToJson(name, raw);
      if (parsed.error || !parsed.config) continue;
      const cfg = ts.parseJsonConfigFileContent(
        parsed.config,
        {
          useCaseSensitiveFileNames: true,
          readDirectory: (p, ext, ex, inc, depth) => this.readDirectory(p, ext, ex, inc, depth),
          fileExists: (f) => this.fileExists(f),
          readFile: (f) => this.readFile(f),
        },
        "/",
        undefined,
        name
      );
      this.configFile = toRel(name);
      return { ...cfg.options, ...forced };
    }
    this.configFile = null;
    return { ...fallback, ...forced };
  }
}
