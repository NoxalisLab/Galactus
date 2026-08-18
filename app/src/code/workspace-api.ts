// Galactus, the workspace navigation contract.
//
// The whole navigation surface (file palette, symbol palette, project search,
// project-wide replace) talks to exactly this interface and to nothing else.
// It is deliberately free of any import: it can be compiled and exercised
// without Tauri, without a DOM and without the app, which is what lets the
// tests in `tools/nav` run the real UI code against `FakeWorkspaceApi`.
//
// The backend half implements the same six methods over the real workspace.
// The adapter that binds them lives in the app, not here, so that this module
// stays the single place where the shape of the contract is stated.
//
// OFFSET CONVENTIONS, frozen. Every producer and every consumer obeys them:
//   * `path` is relative to the workspace root, POSIX separators, no leading
//     "./" and no leading "/".
//   * `line` is 1-based.
//   * `col` is a 1-based CHARACTER column into `text`, so an editor can place
//     a caret with it directly. This matches `search.rs` as it is written.
//   * `len` is the BYTE length of the match, which is NOT the byte length of
//     the query once a case-insensitive search runs over non-ASCII text. The
//     end of a highlight is therefore computed by converting the character
//     start to a byte offset, adding `len`, and converting back through
//     `byteToCharIndex()`. That is the whole reason the byte helpers below
//     exist, and why a highlight can never cut a character in half.
//   * `text` is the matched line WITHOUT its terminator. It may be truncated
//     by the backend for very long lines; the UI never assumes it is whole.
//
// `offset` and `len` are optional in the type because the four fields the
// contract was frozen on are the four that must always be there. When the
// backend sends them, the UI is more precise; when it does not, it falls back
// to the byte length of the query.

// ---------------------------------------------------------------- contract

export interface SearchHit {
  path: string;
  line: number;
  col: number;
  text: string;
  /** Byte offset of the match from the start of the FILE. Never required. */
  offset?: number;
  /** Byte length of the match. Never required. */
  len?: number;
}

export interface SymbolHit {
  name: string;
  kind: string;
  path: string;
  line: number;
  container: string;
}

export interface SearchOpts {
  caseSensitive: boolean;
  wholeWord: boolean;
  /** Read the query as a regular expression rather than as literal text. */
  regex: boolean;
  /** Glob patterns a path must match to be searched. Empty means "all". */
  include: string[];
  /** Glob patterns that remove a path from the search. */
  exclude: string[];
}

/** One streamed batch of results for the search generation `gen`. */
export interface SearchProgress {
  gen: number;
  hits: SearchHit[];
  /** True on the last event of this generation, and only then. */
  done: boolean;
  /** True when the backend hit its match ceiling. */
  capped: boolean;
  /** True when the backend hit its time budget. Distinct from `capped`. */
  timedOut?: boolean;
  /** Set when the generation failed outright. */
  error?: string;
}

export interface WorkspaceApi {
  /** Every file under the root, relative, POSIX. `refresh` rebuilds the index. */
  files(root: string, refresh?: boolean): Promise<string[]>;
  /** Start a literal (never regex) search. Returns its generation number. */
  searchStart(root: string, query: string, opts: SearchOpts): Promise<number>;
  /** Stop a running generation. Late events for it must still be ignored. */
  searchCancel(gen: number): Promise<void>;
  /** Subscribe to streamed results. Returns the unsubscribe function. */
  onSearch(cb: (p: SearchProgress) => void): () => void;
  symbolsQuery(root: string, q: string, limit: number): Promise<SymbolHit[]>;
  read(root: string, rel: string): Promise<string>;
}

// ------------------------------------------------------------ byte offsets

/** Length of `s` once encoded as UTF-8, without encoding it. */
export function utf8Len(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/**
 * UTF-8 byte offset to JavaScript string index. An offset that falls inside a
 * character snaps FORWARD to the next character boundary: a highlight is then
 * never able to cut a surrogate pair in half, which is the whole point.
 */
export function byteToCharIndex(text: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  let b = 0;
  let i = 0;
  while (i < text.length) {
    if (b >= byteOffset) return i;
    const c = text.charCodeAt(i);
    if (c < 0x80) {
      b += 1;
      i += 1;
    } else if (c < 0x800) {
      b += 2;
      i += 1;
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      b += 4;
      i += 2;
    } else {
      b += 3;
      i += 1;
    }
  }
  return text.length;
}

/** JavaScript string index to UTF-8 byte offset. The exact inverse. */
export function charToByteIndex(text: string, charIndex: number): number {
  return utf8Len(text.slice(0, Math.max(0, Math.min(charIndex, text.length))));
}

/**
 * The character span of a hit inside its line: a 1-based CHARACTER column in,
 * a pair of JavaScript string indices out. `byteLen` is the match length in
 * BYTES, which is why the end goes through the two conversions rather than
 * being `start + something`. Both edges are clamped to the line, which matters
 * because the backend truncates very long lines.
 */
export function hitCharSpan(text: string, col: number, byteLen: number): { start: number; end: number } {
  const start = Math.max(0, Math.min(text.length, col - 1));
  const bytes = Math.max(1, byteLen);
  const end = Math.min(text.length, byteToCharIndex(text, charToByteIndex(text, start) + bytes));
  return { start, end: Math.max(start, end) };
}

// ------------------------------------------------------------------ globs

/**
 * The glob dialect the include/exclude boxes accept, kept small on purpose:
 * `*` (no separator), `**` (any depth), `?`, and a bare `name` or `.ext`
 * shorthand. It is duplicated on the backend; this copy exists so the fake and
 * the UI agree on what the user typed before any IPC happens.
 */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim();
  if (!g) return /^$/;
  // "*.ts" and "src" both mean "anywhere in the tree" unless anchored.
  if (!g.includes("/")) g = "**/" + g;
  else if (g.startsWith("./")) g = g.slice(2);
  if (g.endsWith("/")) g += "**";
  let out = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        // "**/" swallows the separator so that "**/x" also matches "x".
        if (g[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if ("\\^$.|+()[]{}".includes(c)) out += "\\" + c;
    else out += c;
  }
  return new RegExp("^" + out + "$");
}

/** True when `rel` passes the include/exclude filter of `opts`. */
export function pathAllowed(rel: string, opts: Pick<SearchOpts, "include" | "exclude">): boolean {
  const inc = opts.include.filter((g) => g.trim());
  const exc = opts.exclude.filter((g) => g.trim());
  if (inc.length && !inc.some((g) => globToRegExp(g).test(rel))) return false;
  if (exc.some((g) => globToRegExp(g).test(rel))) return false;
  return true;
}

// ------------------------------------------------------------------- fake

/**
 * A complete in-memory WorkspaceApi. Every test of this module runs against
 * it, so it is not a stub: it streams in batches, honours cancellation, caps
 * its output, applies the same case / whole-word / glob semantics as the
 * backend, and reports byte columns the same way. It also counts its reads,
 * which is how the "batch the base reads" guarantee of `planReplace` is
 * proven rather than asserted.
 */
export class FakeWorkspaceApi implements WorkspaceApi {
  readonly filesMap: Map<string, string>;
  symbols: SymbolHit[] = [];
  /** How many times `read()` was called, per path, since the last reset. */
  readonly readCounts = new Map<string, number>();
  /** Hits emitted per batch. Small on purpose: streaming must be exercised. */
  batchSize = 3;
  /** Hard ceiling; reaching it ends the generation with `capped: true`. */
  hitCap = Infinity;
  /** Set to end every generation with `timedOut: true`, as the deadline does. */
  timeOut = false;
  /** Set to make `files()` reject, to exercise the error state. */
  filesError: string | null = null;

  private subs = new Set<(p: SearchProgress) => void>();
  private gen = 0;
  private cancelled = new Set<number>();
  private pending: Promise<void> = Promise.resolve();

  constructor(files: Record<string, string> = {}, symbols: SymbolHit[] = []) {
    this.filesMap = new Map(Object.entries(files));
    this.symbols = symbols;
  }

  get readTotal(): number {
    let n = 0;
    for (const v of this.readCounts.values()) n += v;
    return n;
  }

  resetCounts(): void {
    this.readCounts.clear();
  }

  async files(_root: string, _refresh?: boolean): Promise<string[]> {
    if (this.filesError) throw new Error(this.filesError);
    return [...this.filesMap.keys()].sort();
  }

  async read(_root: string, rel: string): Promise<string> {
    this.readCounts.set(rel, (this.readCounts.get(rel) ?? 0) + 1);
    const v = this.filesMap.get(rel);
    if (v === undefined) throw new Error(`no such file: ${rel}`);
    return v;
  }

  async symbolsQuery(_root: string, q: string, limit: number): Promise<SymbolHit[]> {
    const needle = q.toLowerCase();
    return this.symbols
      .filter((s) => !needle || s.name.toLowerCase().includes(needle))
      .slice(0, limit);
  }

  onSearch(cb: (p: SearchProgress) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  async searchCancel(gen: number): Promise<void> {
    this.cancelled.add(gen);
  }

  async searchStart(_root: string, query: string, opts: SearchOpts): Promise<number> {
    const gen = ++this.gen;
    const all = this.collect(query, opts);
    const capped = all.length > this.hitCap;
    const hits = capped ? all.slice(0, this.hitCap) : all;
    this.pending = this.pending.then(() => this.stream(gen, hits, capped));
    return gen;
  }

  /** Resolves once every batch of every started generation has been emitted. */
  async idle(): Promise<void> {
    await this.pending;
  }

  private async stream(gen: number, hits: SearchHit[], capped: boolean): Promise<void> {
    for (let i = 0; i < hits.length; i += this.batchSize) {
      await Promise.resolve();
      if (this.cancelled.has(gen)) return;
      const batch = hits.slice(i, i + this.batchSize);
      // A capped generation is still DONE: it stopped, it just did not finish
      // the workspace. The flags are independent and all of them are reported.
      const last = i + this.batchSize >= hits.length;
      this.emit({
        gen,
        hits: batch,
        done: last,
        capped: last ? capped : false,
        timedOut: last ? this.timeOut : false,
      });
    }
    if (hits.length === 0) {
      await Promise.resolve();
      if (this.cancelled.has(gen)) return;
      this.emit({ gen, hits: [], done: true, capped, timedOut: this.timeOut });
    }
  }

  private emit(p: SearchProgress): void {
    for (const cb of [...this.subs]) cb(p);
  }

  private collect(query: string, opts: SearchOpts): SearchHit[] {
    const out: SearchHit[] = [];
    if (!query) return out;
    const needle = opts.caseSensitive ? query : query.toLowerCase();
    for (const rel of [...this.filesMap.keys()].sort()) {
      if (!pathAllowed(rel, opts)) continue;
      const content = this.filesMap.get(rel)!;
      const lines = content.split("\n");
      // Byte offset of the current line from the start of the file, kept as we
      // go so every hit can carry the same `offset` the backend reports.
      let lineByte = 0;
      for (let li = 0; li < lines.length; li++) {
        const withCr = lines[li];
        const raw = withCr.replace(/\r$/, "");
        const hay = opts.caseSensitive ? raw : raw.toLowerCase();
        let from = 0;
        for (;;) {
          const at = hay.indexOf(needle, from);
          if (at < 0) break;
          from = at + Math.max(1, needle.length);
          if (opts.wholeWord && !wordBounded(raw, at, at + query.length)) continue;
          // Exactly what search.rs reports: a 1-based CHARACTER column, the
          // byte offset in the file, and the byte length of the match.
          out.push({
            path: rel,
            line: li + 1,
            col: at + 1,
            text: raw,
            offset: lineByte + charToByteIndex(raw, at),
            len: utf8Len(raw.slice(at, at + query.length)),
          });
        }
        lineByte += utf8Len(withCr) + 1;
      }
    }
    return out;
  }
}

/** True when [start, end) in `text` is not glued to another word character. */
export function wordBounded(text: string, start: number, end: number): boolean {
  const word = /[\p{L}\p{N}_]/u;
  const before = start > 0 ? text[start - 1] : "";
  const after = end < text.length ? text[end] : "";
  return !(before && word.test(before)) && !(after && word.test(after));
}
