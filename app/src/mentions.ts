// Galactus, @file and @symbol mentions in the composer.
//
// The problem this removes: without mentions the agent has to GUESS which file
// the user meant. It calls find_files on a plausible folder, misses, calls it
// again on another, and three turns of a small local window are gone before
// any work starts. A mention is the user saying it outright, so the file is in
// the request before the first token is generated.
//
// Four functions, no DOM, no Tauri, no api.ts, no module state. The composer
// wires them:
//
//   scanMentions(text, caret)          what is being typed right now, if anything
//   rankCandidates(candidates, query)  the picker list
//   applyMention(text, range, chosen)  commit the pick
//   resolveMentions(text, reader, b)   at send time, attach the content
//
// THE TEXT IS THE ONLY STATE. A mention is stored as the characters
// "@src/code/fuzzy.ts" inside the draft, never as a side table keyed by
// offsets. A side table looks tidy until the user puts the caret before the
// mention and types one character: every offset shifts, the table now points
// at the wrong span, and the message sent does not match the message shown.
// The draft also survives re-renders, view switches and a restore (main.ts
// keeps it in `composerDraft`), and a side table would have to survive all
// three too. Parsing the text back is cheap and cannot desynchronize.
//
// That is also why a symbol mention carries its file: "@src/code/fuzzy.ts#rank"
// and not "@rank". A bare symbol name is not resolvable from the text alone,
// and resolvable-from-the-text-alone is the property the whole module rests on.
//
// BUDGET. resolveMentions obeys the same discipline as kb_search: whole files
// while they fit, a RANKED excerpt when they do not, never a blind cut, and
// whatever was left out is stated in the text so the model knows it is missing
// something rather than believing it has the file. The arithmetic mirrors
// knowledge.rs (fit_to_budget, 3.0 bytes per token) because the two must agree
// or the budget computed here does not describe the request that is sent.

import { score as fuzzyScore, positions as fuzzyPositions } from "./code/fuzzy.js";
import { utf8Len } from "./code/workspace-api.js";

// ---------------------------------------------------------------- constants

/**
 * Bytes per token, identical to knowledge.rs and agent.ts. The usual 4.0 is
 * measurably optimistic (the densest record in the calibration set reached
 * 1.99) and an optimistic budget is the expensive kind: it is what turns a
 * request the caller believed fitted into a 400 with the turn lost.
 */
const BYTES_PER_TOKEN = 3.0;

/**
 * Charged per attached entry for its header line, its closing line and the
 * blank lines around it. Framing is not free and knowledge.rs learned that the
 * hard way: at a median passage size a full-path header cost 28 percent of the
 * passage itself. Counting it is what keeps the budget honest on many small
 * files, which is exactly the shape a mention list has.
 */
const ENTRY_FRAMING_TOKENS = 12;

/**
 * The block preamble. A constant rather than a template because its cost is
 * subtracted from the budget before a single line of a file is attached, and
 * a preamble whose length depends on the outcome cannot be charged up front.
 */
const PREAMBLE =
  "[Attached context: what the user pointed at with @. Verbatim workspace content, " +
  "1-based line numbers in the left gutter. Where a body says lines were omitted they " +
  "really are: do not assume what is in them, read the file if you need it.]";

/**
 * Reserved per mention for the footer line that would name it if it could not
 * be attached, on top of twice the token cost of the mention itself (the raw
 * token appears once, and its longest note repeats the path).
 */
const FOOTER_NOTE_TOKENS = 16;

/**
 * Below this an excerpt is not worth its own framing: four lines of code with
 * no surrounding context teach the model less than the honest admission that
 * the file did not fit. Entries under this share are dropped and named.
 */
const MIN_ENTRY_TOKENS = 70;

/**
 * A mention query longer than this is prose that happens to contain an "@",
 * not a path being typed. Refusing keeps the picker from opening halfway
 * through a sentence and stealing the Enter key.
 */
const MAX_QUERY_LEN = 200;

/**
 * Characters allowed inside an unquoted mention token, after the "@".
 *
 * No "@" of its own: an address like "a@b.com" must end the token at the
 * second "@" rather than swallow the domain, and "@@" is not a mention.
 */
function isTokenChar(c: string): boolean {
  return /[A-Za-z0-9_./#+-]/.test(c);
}

/**
 * Characters an unescaped "@" may follow. Anything else means the "@" is
 * INSIDE a word: "user@example.com" (preceded by "r"), "foo.@bar" (preceded by
 * a "."), "a@b" (preceded by "a"). Those are addresses and syntax, not
 * mentions, and opening a picker on them is the fastest way to make the
 * feature hated.
 *
 * A backslash is in the set only so that the escape rule stays consistent:
 * `isEscaped` has already decided whether the run of backslashes before the
 * "@" is odd (escaped, refused) or even (a literal backslash, then a real
 * mention). Leaving "\\" out here would refuse the even case too and quietly
 * contradict the rule `isEscaped` states.
 */
function canPrecedeAt(c: string): boolean {
  return /[\s([{<,;:"'\\]/.test(c);
}

// -------------------------------------------------------------------- types

export type MentionKind = "file" | "symbol";

/** One row the picker can offer. Files and symbols share the shape. */
export interface MentionCandidate {
  kind: MentionKind;
  /** Workspace-relative, POSIX separators, no leading "./" and no leading "/". */
  path: string;
  /** Symbol name. Required for kind "symbol", absent for kind "file". */
  symbol?: string;
  /** Symbol kind ("function", "struct", ...), shown as a badge. Never matched. */
  detail?: string;
  /** 1-based line the symbol starts at, when the provider knows it. */
  line?: number;
}

/** A candidate with its score and the characters the query lit up. */
export interface RankedCandidate {
  candidate: MentionCandidate;
  score: number;
  /** Offsets into `text` (UTF-16 code units) that matched. */
  positions: number[];
  /** The string the match ran against: what the picker should highlight. */
  text: string;
}

/** The mention token under the caret. */
export interface ActiveMention {
  /** Offset of the "@" itself. */
  start: number;
  /** Offset just past the end of the WHOLE token, which may be after the caret. */
  end: number;
  /** Text between the "@" and the CARET: what the picker filters on. */
  query: string;
  /** Text between the "@" and `end`: the whole token, what a pick replaces. */
  token: string;
  /** True when the token is in its quoted form, @"a path with spaces.ts". */
  quoted: boolean;
}

/** A mention found in a finished message, with its parsed parts. */
export interface ParsedMention {
  /** Offset of the "@". */
  start: number;
  /** Offset just past the token. */
  end: number;
  /** The token as typed, "@" included. */
  raw: string;
  /** The part before any "#". Not yet validated. */
  path: string;
  /** The part after the first "#", when there is one. */
  symbol?: string;
}

/** What happened to one mention at resolution time. */
export interface ResolvedMention {
  raw: string;
  path: string;
  symbol?: string;
  /** True when its content reached the block. */
  attached: boolean;
  /** Whole file, ranked excerpt, or nothing. */
  mode: "whole" | "excerpt" | "none";
  /** Why it was not attached, or how it was cut. Always set when mode is not "whole". */
  note?: string;
  /** Tokens this entry actually spent. Zero when it was not attached. */
  tokens: number;
}

export interface MentionResolution {
  /** The message with the context block appended, or unchanged when there is none. */
  text: string;
  /** The block alone. Empty when no mention produced anything to say. */
  block: string;
  /** One row per distinct mention, in order of first appearance. */
  entries: ResolvedMention[];
  /** Estimated tokens the block costs, framing included. */
  tokens: number;
}

/**
 * How resolveMentions reaches the workspace. Injected so the tests run against
 * a plain object and this module never imports api.ts.
 *
 * `read` receives a path that has ALREADY passed confinement, relative to the
 * workspace root, POSIX. It returns null for "no such file"; throwing is also
 * accepted and treated the same way, because a Tauri command rejects rather
 * than resolving null.
 */
export interface MentionReader {
  read(rel: string): Promise<string | null>;
}

// --------------------------------------------------------- code block masks

/**
 * Offsets covered by a fenced code block, fence lines included.
 *
 * An "@" inside a fence is code: a Python decorator, a Java annotation, a
 * shell array. Opening a picker there is wrong every single time.
 *
 * CommonMark rules, kept deliberately: a fence opens on a run of three or more
 * backticks or tildes at the start of a line (up to three spaces of indent),
 * and closes on a run of the SAME character at least as long with nothing else
 * on its line. An unclosed fence runs to the end of the text, which is what a
 * user who has just typed the opening fence has, and is why the picker stops
 * offering itself the moment they start a code block.
 */
function fencedRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let offset = 0;
  let openAt = -1;
  let openChar = "";
  let openLen = 0;
  for (const line of text.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (m) {
      const ch = m[1][0];
      const len = m[1].length;
      if (openAt < 0) {
        // An info string may not contain a backtick when the fence is backticks.
        if (!(ch === "`" && m[2].includes("`"))) {
          openAt = offset;
          openChar = ch;
          openLen = len;
        }
      } else if (ch === openChar && len >= openLen && m[2].trim() === "") {
        out.push([openAt, offset + line.length]);
        openAt = -1;
      }
    }
    offset += line.length + 1;
  }
  if (openAt >= 0) out.push([openAt, text.length]);
  return out;
}

/**
 * Offsets covered by an inline code span.
 *
 * Restricted to a single line on purpose. CommonMark lets a span cross lines,
 * but in a composer a lone backtick typed in prose is far more common than a
 * multi-line span, and honouring the spec here would let that one backtick
 * mask the rest of the message and silently kill every mention after it.
 */
function inlineCodeRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    let i = 0;
    while (i < line.length) {
      if (line[i] !== "`") {
        i++;
        continue;
      }
      let run = 0;
      while (i + run < line.length && line[i + run] === "`") run++;
      const fence = "`".repeat(run);
      const close = line.indexOf(fence, i + run);
      // A run with no partner closes nothing and masks nothing.
      if (close < 0) {
        i += run;
        continue;
      }
      out.push([offset + i, offset + close + run]);
      i = close + run;
    }
    offset += line.length + 1;
  }
  return out;
}

/**
 * Offsets covered by an INDENTED code block: four spaces or a tab, opening
 * after a blank line or at the very start of the message.
 *
 * This is the second half of the decorator answer. A user pastes a fragment
 * into the composer without fencing it, the fragment is indented, and its
 * "@staticmethod" or "@app.route" must not open a file picker. CommonMark's
 * own rule is used unchanged, blank line before included, precisely because
 * the looser rule ("any indented line is code") would swallow every nested
 * list item and every hand-aligned continuation in ordinary prose.
 */
function indentedCodeRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const lines = text.split("\n");
  let offset = 0;
  let openAt = -1;
  let lastContentEnd = 0;
  let prevBlank = true;
  for (const line of lines) {
    const blank = line.trim() === "";
    const indented = /^(?: {4}|\t)/.test(line) && !blank;
    if (openAt < 0) {
      if (indented && prevBlank) {
        openAt = offset;
        lastContentEnd = offset + line.length;
      }
    } else if (indented) {
      lastContentEnd = offset + line.length;
    } else if (!blank) {
      out.push([openAt, lastContentEnd]);
      openAt = -1;
    }
    prevBlank = blank;
    offset += line.length + 1;
  }
  if (openAt >= 0) out.push([openAt, lastContentEnd]);
  return out;
}

/**
 * Everything an "@" may not be found in. Computed in one place so that
 * scanMentions (one caret) and findMentions (a whole message) can never
 * disagree about what counts as code.
 */
function codeRanges(text: string): Array<[number, number]> {
  return [...fencedRanges(text), ...inlineCodeRanges(text), ...indentedCodeRanges(text)];
}

function inAnyRange(ranges: Array<[number, number]>, at: number): boolean {
  for (const [a, b] of ranges) if (at >= a && at < b) return true;
  return false;
}

/**
 * True when the "@" at `at` is escaped.
 *
 * The run of backslashes immediately before it is counted rather than the
 * single previous character: "\@a" is an escaped at sign, and "\\@a" is a
 * literal backslash followed by a real mention. Looking at one character only
 * gets the second case wrong, and getting it wrong means a user who wrote a
 * Windows path cannot mention anything for the rest of the line.
 */
function isEscaped(text: string, at: number): boolean {
  let n = 0;
  let i = at - 1;
  while (i >= 0 && text[i] === "\\") {
    n++;
    i--;
  }
  return n % 2 === 1;
}

/** Where the token starting at `at` ends, and whether it was quoted. */
function tokenEnd(text: string, at: number): { end: number; quoted: boolean } | null {
  if (text[at + 1] === '"') {
    const close = text.indexOf('"', at + 2);
    // An unterminated quote is a quote the user is still typing: the token
    // runs to the end of the LINE, never past it, so an unclosed quote cannot
    // swallow the rest of the message.
    if (close < 0) {
      const nl = text.indexOf("\n", at + 2);
      return { end: nl < 0 ? text.length : nl, quoted: true };
    }
    return { end: close + 1, quoted: true };
  }
  let i = at + 1;
  while (i < text.length && isTokenChar(text[i])) i++;
  return { end: i, quoted: false };
}

/** The token body, quotes removed. */
function tokenBody(text: string, at: number, end: number, quoted: boolean): string {
  if (!quoted) return text.slice(at + 1, end);
  const inner = text.slice(at + 2, end);
  return inner.endsWith('"') ? inner.slice(0, -1) : inner;
}

// ----------------------------------------------------------------- scanning

/**
 * The mention being typed at `caret`, or null when there is none.
 *
 * Returns the WHOLE token in `end`/`token` even when the caret sits in the
 * middle of it, while `query` stops at the caret. That split is what makes
 * editing an existing mention behave: the picker filters on what has been
 * typed so far, and accepting a row replaces the entire token instead of
 * grafting the pick onto the tail of the old one.
 *
 * Refuses, in this order: an escaped "@", an "@" inside a word, an "@" inside
 * a code fence or an inline code span, a caret that has already left the
 * token, and a query long enough to be prose.
 */
export function scanMentions(text: string, caret: number): ActiveMention | null {
  const pos = Math.max(0, Math.min(caret, text.length));
  // Walk back to the nearest "@" that could open a token. Stop at a newline:
  // a mention never spans lines, so neither does the search for one.
  let at = -1;
  for (let i = pos - 1; i >= 0; i--) {
    const c = text[i];
    if (c === "@") {
      if (!isEscaped(text, i) && (i === 0 || canPrecedeAt(text[i - 1]))) {
        at = i;
        break;
      }
      // Not an opener, so keep walking BACK rather than giving up. A path may
      // legitimately contain an "@" (a scoped npm package, a node_modules
      // type stub), and the token holding it is opened by an earlier "@". The
      // first version stopped at the inner one and the picker closed halfway
      // through typing. Refusals are unaffected: in "user@example.com" there
      // is no earlier opener to find, so the walk still ends at null.
      continue;
    }
    if (c === "\n") return null;
    // A quoted token may contain spaces; an unquoted one may not. Rather than
    // guess which we are in, keep walking through spaces and let the token
    // scan below decide. Anything that cannot appear in either form ends it.
    if (!isTokenChar(c) && c !== " " && c !== '"') return null;
  }
  if (at < 0) return null;
  if (isEscaped(text, at)) return null;
  if (at > 0 && !canPrecedeAt(text[at - 1])) return null;
  if (inAnyRange(codeRanges(text), at)) return null;

  const span = tokenEnd(text, at);
  if (!span) return null;
  const { end, quoted } = span;
  if (pos > end) return null;
  // Inside the quotes, not before the opening one: with `@"ab"` and the caret
  // between the "@" and the quote there is nothing to filter on yet.
  if (quoted && pos < at + 2) return null;

  const token = tokenBody(text, at, end, quoted);
  // The closing quote is a delimiter, never part of what the picker filters
  // on: a caret parked after it must still search for "plan b.md" and not for
  // "plan b.md\"", which matches nothing and empties the list at the exact
  // moment the user finished typing.
  const bodyStart = quoted ? at + 2 : at + 1;
  const bodyEnd = quoted && text[end - 1] === '"' ? end - 1 : end;
  const query = text.slice(bodyStart, Math.max(bodyStart, Math.min(pos, bodyEnd)));
  if (query.length > MAX_QUERY_LEN) return null;
  return { start: at, end, query, token, quoted };
}

/**
 * Every mention in a finished message, in order, deliberately WITHOUT the
 * caret rules: a message is scanned in one pass rather than one probe per
 * caret position, and the refusals are applied to each "@" as it is met.
 */
export function findMentions(text: string): ParsedMention[] {
  const code = codeRanges(text);
  const out: ParsedMention[] = [];
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf("@", i);
    if (at < 0) break;
    if (isEscaped(text, at) || (at > 0 && !canPrecedeAt(text[at - 1]))) {
      i = at + 1;
      continue;
    }
    if (inAnyRange(code, at)) {
      i = at + 1;
      continue;
    }
    const span = tokenEnd(text, at);
    if (!span) {
      i = at + 1;
      continue;
    }
    let end = span.end;
    let body = tokenBody(text, at, end, span.quoted);
    // A sentence-final period is punctuation, not part of the path. "." has to
    // stay in isTokenChar (every filename has one), so it is trimmed back HERE,
    // at the only point where the token is known to be finished. Without this,
    // "please explain @src/a.ts." asks the reader for "src/a.ts.", the read
    // misses, and the user is told a file they can see in the tree does not
    // exist. The quoted form is left alone: @"weird.name." is deliberate.
    if (!span.quoted) {
      const trimmed = body.replace(/\.+$/, "");
      if (trimmed !== body) {
        end -= body.length - trimmed.length;
        body = trimmed;
      }
    }
    if (!body) {
      i = at + 1;
      continue;
    }
    const hash = body.indexOf("#");
    const path = hash < 0 ? body : body.slice(0, hash);
    const symbol = hash < 0 ? undefined : body.slice(hash + 1);
    out.push({
      start: at,
      end,
      raw: text.slice(at, end),
      path,
      symbol: symbol || undefined,
    });
    i = end;
  }
  return out;
}

// ------------------------------------------------------------------ ranking

/**
 * The qualified form of a candidate: what a pick writes into the draft, and
 * what resolveMentions parses back out of it.
 */
export function matchText(c: MentionCandidate): string {
  return c.kind === "symbol" && c.symbol ? `${c.path}#${c.symbol}` : c.path;
}

/**
 * Every string a candidate may be matched on, best-scoring one wins.
 *
 * A symbol competes twice, on its BARE NAME and on "path#name", because the
 * two queries people actually type pull in opposite directions. Typing "rank"
 * must find `rank`, and on the qualified form alone it does not: fuzzy.ts
 * charges PENALTY_LEAD per character before the match, so
 * "src/mentions.ts#rankCandidates" scores 0.8 higher than
 * "src/code/fuzzy.ts#rank" for the query "rank" purely because its "#" comes
 * two characters earlier. That is the right answer for a path query and the
 * wrong one for a name query. Typing "fuzzy.rank" must find the same symbol,
 * and on the bare name alone it cannot. Scoring both and keeping the better
 * costs one extra call per symbol and answers both.
 *
 * The winning string comes back in RankedCandidate.text, so the highlight is
 * always drawn on the text that actually matched.
 */
function matchTexts(c: MentionCandidate): string[] {
  if (c.kind === "symbol" && c.symbol) return [c.symbol, `${c.path}#${c.symbol}`];
  return [c.path];
}

/**
 * The exact characters a pick inserts after the "@".
 *
 * The quoting rule is DERIVED from isTokenChar rather than written out by
 * hand, and that is the fix for a real bug: the hand written version only
 * quoted whitespace and quotes, so a perfectly ordinary path like
 * "packages/@scope/lib/src/x.ts" or "node_modules/@types/node/index.d.ts" was
 * written unquoted, and isTokenChar stops an unquoted token at the second "@".
 * findMentions then parsed the path as "packages/", confinementError refused
 * it for an "empty path segment", and the user was told their own path was
 * malformed while the file was silently never attached.
 *
 * THE TEXT IS THE ONLY STATE, so what this function writes must be what
 * findMentions reads back. Deriving the predicate from the one that does the
 * reading is the only way to keep that true when either side changes.
 */
export function mentionText(c: MentionCandidate): string {
  const body = matchText(c);
  const needsQuotes = body === "" || [...body].some((ch) => !isTokenChar(ch));
  return needsQuotes ? `"${body.replace(/"/g, "")}"` : body;
}

/**
 * Rank files and symbols for the picker, best first.
 *
 * The scorer is fuzzy.ts, unchanged: the file palette and the mention picker
 * must agree on what "conf" means, and two scorers in one app is how they stop
 * agreeing. `rank()` itself is not reused because it takes and returns bare
 * strings, and two candidates can legitimately share a match text (a file and
 * a symbol declared at its top level), which a string list would collapse.
 *
 * Ties are broken deterministically so the list never reshuffles between two
 * identical keystrokes: shorter match text first, then lexicographic, then
 * files before symbols.
 */
export function rankCandidates(
  candidates: MentionCandidate[],
  query: string,
  limit = 50
): RankedCandidate[] {
  if (limit <= 0) return [];
  const scored: RankedCandidate[] = [];
  for (const candidate of candidates) {
    let best: { score: number; text: string } | null = null;
    for (const text of matchTexts(candidate)) {
      const s = fuzzyScore(query, text);
      if (s === null) continue;
      if (!best || s > best.score) best = { score: s, text };
    }
    if (!best) continue;
    scored.push({ candidate, score: best.score, positions: [], text: best.text });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.text.length !== b.text.length) return a.text.length - b.text.length;
    if (a.text !== b.text) return a.text < b.text ? -1 : 1;
    if (a.candidate.kind !== b.candidate.kind) return a.candidate.kind === "file" ? -1 : 1;
    return 0;
  });
  const kept = scored.slice(0, limit);
  // Positions are reconstructed only for the rows that survive the cut, the
  // same bargain rank() makes: a 100k candidate list allocates 50 arrays.
  for (const row of kept) row.positions = fuzzyPositions(query, row.text);
  return kept;
}

// ----------------------------------------------------------------- applying

export interface AppliedMention {
  text: string;
  caret: number;
}

/**
 * Replace `range` with the chosen mention and report where the caret lands.
 *
 * A single trailing space is added so the user can keep typing, and only when
 * there is not one already: accepting a pick in the middle of a sentence must
 * not push a second space into it.
 */
export function applyMention(
  text: string,
  range: { start: number; end: number },
  chosen: MentionCandidate
): AppliedMention {
  const start = Math.max(0, Math.min(range.start, text.length));
  const end = Math.max(start, Math.min(range.end, text.length));
  const inserted = `@${mentionText(chosen)}`;
  const needsSpace = text[end] !== " " && text[end] !== "\n";
  const tail = needsSpace ? " " : "";
  return {
    text: text.slice(0, start) + inserted + tail + text.slice(end),
    caret: start + inserted.length + tail.length,
  };
}

// -------------------------------------------------------- path confinement

/**
 * Reject anything that is not a plain workspace-relative POSIX path.
 *
 * Nothing is normalized. "src/../../etc/passwd" is REFUSED, not rewritten to
 * "etc/passwd", because normalizing is where confinement bugs live: every
 * escape ever shipped was a normalizer that missed one spelling ("..%2f",
 * "....//", a symlinked segment, a UTF-8 overlong). A rule that accepts only
 * what it recognizes cannot miss a spelling, it can only be annoying, and a
 * mention comes from a picker that produces contract-shaped paths anyway.
 *
 * "." segments are refused for the same reason: partial normalization is the
 * dangerous kind, so this function does none at all.
 *
 * Returns null when the path is acceptable, or the reason it is not.
 */
export function confinementError(path: string): string | null {
  if (!path) return "empty path";
  // Control characters, NUL included. A workspace path is text a human typed
  // or a picker produced; anything in this range arrived by paste or by hand,
  // and both are reasons to stop rather than to guess.
  if (/[\u0000-\u001f\u007f]/.test(path)) return "path contains a control character";
  if (path.includes("\\")) return "path uses backslashes, workspace paths are POSIX";
  if (path.startsWith("/")) return "absolute path, mentions are workspace relative";
  if (path.startsWith("~")) return "home relative path, mentions are workspace relative";
  if (/^[A-Za-z]:/.test(path)) return "drive letter, mentions are workspace relative";
  for (const seg of path.split("/")) {
    if (seg === "") return "empty path segment";
    if (seg === "..") return "path escapes the workspace root";
    if (seg === ".") return 'path contains a "." segment, write it plainly';
  }
  return null;
}

// -------------------------------------------------------------- token maths

/** Tokens a string is estimated to cost. UTF-8 bytes, as knowledge.rs counts. */
export function tokensFor(s: string): number {
  return Math.ceil(utf8Len(s) / BYTES_PER_TOKEN);
}

// ------------------------------------------------------------- excerpting

/** A half open line range, [from, to), indices into the file's line array. */
interface Range {
  from: number;
  to: number;
}

/**
 * Lines kept on each side of a selected line.
 *
 * Zero would be cheapest and useless: a matching line torn out of its function
 * is a fact with no scope attached, and the model has to call read_file anyway
 * to learn what it belongs to, which is the round trip mentions exist to save.
 */
const EXCERPT_CONTEXT = 3;

/**
 * Terms the excerpts are ranked against: the user's own words, with the
 * mention tokens removed so "@src/code/fuzzy.ts" does not make every line
 * containing "src" look relevant.
 */
export function queryTerms(message: string, mentions: ParsedMention[]): string[] {
  let stripped = message;
  // Right to left, so an earlier removal cannot shift a later offset.
  for (let i = mentions.length - 1; i >= 0; i--) {
    stripped = stripped.slice(0, mentions[i].start) + " " + stripped.slice(mentions[i].end);
  }
  const seen = new Set<string>();
  for (const w of stripped.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (w.length >= 3) seen.add(w);
  }
  return [...seen];
}

/** How many distinct query terms each line carries. */
function scoreLines(lines: string[], terms: string[]): number[] {
  const out = new Array<number>(lines.length).fill(0);
  if (terms.length === 0) return out;
  for (let i = 0; i < lines.length; i++) {
    const low = lines[i].toLowerCase();
    let n = 0;
    // Distinct terms, not occurrences: a line repeating one identifier twenty
    // times is not more relevant than a line that uses three of the words the
    // question was actually asked with.
    for (const t of terms) if (low.includes(t)) n++;
    out[i] = n;
  }
  return out;
}

function isCovered(ranges: Range[], i: number): boolean {
  for (const r of ranges) if (i >= r.from && i < r.to) return true;
  return false;
}

/** Add `add` and coalesce. Touching ranges merge, so no empty gap is printed. */
function mergeInto(ranges: Range[], add: Range): Range[] {
  const all = [...ranges, add].sort((a, b) => a.from - b.from);
  const out: Range[] = [];
  for (const r of all) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else out.push({ from: r.from, to: r.to });
  }
  return out;
}

function gutter(lines: string[], from: number, to: number, width: number): string {
  const out: string[] = [];
  for (let i = from; i < to; i++) out.push(`${String(i + 1).padStart(width)} | ${lines[i]}`);
  return out.join("\n");
}

/**
 * Render the selected ranges with the gaps SPELLED OUT.
 *
 * The omitted line ranges are named in the body itself. A model given a file
 * with a silent hole treats what it received as the whole file and reasons
 * about code it never saw; a model told "lines 40 to 300 omitted" asks for
 * them, or says it cannot answer. That difference is the entire reason this
 * function does not simply slice.
 */
function renderExcerpt(lines: string[], ranges: Range[]): string {
  const width = String(lines.length).length;
  const parts: string[] = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.from > cursor) parts.push(`[... lines ${cursor + 1} to ${r.from} omitted ...]`);
    parts.push(gutter(lines, r.from, r.to, width));
    cursor = r.to;
  }
  if (cursor < lines.length) parts.push(`[... lines ${cursor + 1} to ${lines.length} omitted ...]`);
  return parts.join("\n");
}

/**
 * The best lines that fit `budget` tokens, with their context, measured on the
 * RENDERED text.
 *
 * Selection is per LINE, not per fixed block, and that is not a detail. The
 * first version of this function scored 16 line blocks and took whole blocks
 * while they fitted, exactly as fit_to_budget takes whole passages. On a 200
 * line file at a 218 token body budget NO block fitted except the short one at
 * the end, so the excerpt of a question about line 150 was the tail of the
 * file: every word of it irrelevant, every token of it spent, and the failure
 * completely silent. A passage from a knowledge base is an indivisible unit of
 * meaning; sixteen arbitrary lines of source are not, and pretending otherwise
 * buys nothing and costs the answer.
 *
 * Each seed is tried at three widths before it is given up on, so a budget
 * that cannot afford three lines of context still buys the one line that
 * matters. Rendering and measuring at every step, rather than estimating,
 * makes "the body never exceeds its budget" a property of the returned string
 * instead of a claim about the arithmetic above it.
 */
function fitExcerpt(lines: string[], scores: number[], budget: number): { body: string; ranges: Range[] } {
  const order: number[] = [];
  for (let i = 0; i < lines.length; i++) order.push(i);
  order.sort((a, b) => (scores[b] !== scores[a] ? scores[b] - scores[a] : a - b));

  let ranges: Range[] = [];
  let body = "";
  for (const i of order) {
    if (isCovered(ranges, i)) continue;
    let placed = false;
    for (const ctx of [EXCERPT_CONTEXT, 1, 0]) {
      const cand = mergeInto(ranges, {
        from: Math.max(0, i - ctx),
        to: Math.min(lines.length, i + ctx + 1),
      });
      const text = renderExcerpt(lines, cand);
      if (tokensFor(text) <= budget) {
        ranges = cand;
        body = text;
        placed = true;
        break;
      }
    }
    // Not even one more line fits. Nothing further will either, and walking
    // the remaining lines to prove it would cost a render each.
    if (!placed) break;
  }
  return { body, ranges };
}

/**
 * The line a symbol is declared on, 1-based, or 0 when it is nowhere.
 *
 * A declaration keyword on the same line wins over a bare occurrence, so
 * mentioning `rank` lands on `export function rank(` and not on the call to it
 * eighty lines above. Both passes take the FIRST match, so the answer does not
 * depend on file size or iteration order.
 */
export function symbolLine(lines: string[], symbol: string): number {
  const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = new RegExp(`(^|[^A-Za-z0-9_$])${esc}([^A-Za-z0-9_$]|$)`);
  const decl = /\b(fn|def|class|function|interface|struct|enum|trait|impl|type|const|let|var|export|pub)\b/;
  let fallback = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!word.test(lines[i])) continue;
    if (decl.test(lines[i])) return i + 1;
    if (!fallback) fallback = i + 1;
  }
  return fallback;
}

// ----------------------------------------------------------------- resolving

interface Loaded {
  parsed: ParsedMention;
  /**
   * The row this item will report itself through. Held by reference rather
   * than looked up again by path in the budget pass: two mentions of the same
   * file with different symbols are distinct rows, and a lookup by value is
   * one refactor away from updating the wrong one.
   */
  entry: ResolvedMention;
  lines: string[];
  /**
   * Rendered whole-file body, gutter included, or null when the file cannot
   * fit whole under ANY share of this budget and rendering it would be work
   * thrown away.
   */
  whole: string | null;
  /** Tokens the whole-file entry costs, framing included. */
  wholeCost: number;
  /** Symbol line, 1-based, or 0. Always 0 for a file mention. */
  at: number;
}

function header(p: ParsedMention, what: string): string {
  const name = p.symbol ? `${p.path}#${p.symbol}` : p.path;
  return `--- ${name} (${what}) ---`;
}

/**
 * Turn every mention in a finished message into a context block appended to it.
 *
 * The message itself is left alone. The tokens stay where the user typed them,
 * because "look at @src/a.ts and tell me why it is slow" reads correctly and
 * the block below ties back to it by path. Rewriting the user's sentence to
 * strip the markers would also make the sent message differ from the shown
 * one, which is the thing this module refuses to do anywhere.
 *
 * Budget policy, in order:
 *   1. Each mention is offered an EQUAL share of what is left, recomputed as
 *      the list is walked so unspent room flows to the mentions behind it. A
 *      1 MB file mentioned first must not starve the three small ones after
 *      it, which is the failure fit_to_budget exists to prevent.
 *   2. A file that fits in its share goes in whole.
 *   3. Otherwise a ranked excerpt is built for that share, never a head cut,
 *      with every omitted line range named in the body.
 *   4. A share too small for a usable excerpt attaches nothing, and the entry
 *      is listed by name in the footer with the reason.
 *
 * Duplicates attach once: the same path mentioned three times is one entry.
 */
export async function resolveMentions(
  text: string,
  reader: MentionReader,
  budgetTokens: number
): Promise<MentionResolution> {
  const found = findMentions(text);
  if (found.length === 0) {
    return { text, block: "", entries: [], tokens: 0 };
  }
  const terms = queryTerms(text, found);

  // Deduplicate on the pair, keeping first appearance: "@a.ts" and
  // "@a.ts#foo" are different asks about the same file and both survive.
  const seen = new Set<string>();
  const wanted: ParsedMention[] = [];
  for (const m of found) {
    const key = JSON.stringify([m.path, m.symbol ?? ""]);
    if (seen.has(key)) continue;
    seen.add(key);
    wanted.push(m);
  }

  const entries: ResolvedMention[] = [];
  const loaded: Loaded[] = [];
  const bodies = new Map<ParsedMention, string>();
  const fileCache = new Map<string, string | null>();

  const row = (m: ParsedMention, note?: string): ResolvedMention => {
    const e: ResolvedMention = {
      raw: m.raw,
      path: m.path,
      symbol: m.symbol,
      attached: false,
      mode: "none",
      note,
      tokens: 0,
    };
    entries.push(e);
    return e;
  };

  for (const m of wanted) {
    const bad = confinementError(m.path);
    if (bad) {
      row(m, bad);
      continue;
    }
    let content = fileCache.get(m.path);
    if (content === undefined) {
      try {
        content = await reader.read(m.path);
      } catch {
        content = null;
      }
      fileCache.set(m.path, content);
    }
    if (content === null) {
      row(m, "not found in the workspace");
      continue;
    }
    const lines = content.split("\n");
    // A trailing newline yields a phantom empty last line; it is not content.
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length === 1 && lines[0].trim() === "") {
      row(m, "file is empty");
      continue;
    }
    let at = 0;
    if (m.symbol) {
      at = symbolLine(lines, m.symbol);
      if (at === 0) {
        row(m, `no symbol named "${m.symbol}" in ${m.path}`);
        continue;
      }
    }
    const width = String(lines.length).length;
    const head = header(m, `whole file, ${lines.length} lines`);
    // Every line gains exactly `width + 3` ASCII characters of gutter, and the
    // content already carries its own newlines, so this is an UPPER bound on
    // the rendered cost. Deciding on the bound first means a 10 MB file that
    // could never fit is never rendered at all, and because the bound can only
    // overestimate, no file that would have fitted is rejected by it.
    const bound =
      tokensFor(head) +
      Math.ceil((utf8Len(content) + lines.length * (width + 3)) / BYTES_PER_TOKEN) +
      ENTRY_FRAMING_TOKENS;
    const whole = bound <= Math.floor(budgetTokens) ? gutter(lines, 0, lines.length, width) : null;
    loaded.push({
      parsed: m,
      entry: row(m),
      lines,
      whole,
      wholeCost: whole === null ? bound : tokensFor(head) + tokensFor(whole) + ENTRY_FRAMING_TOKENS,
      at,
    });
  }

  // The block must be able to afford its own explanation. The reserve assumes
  // the WORST case, every mention ending up in the footer, because a budget
  // spent entirely on bodies is exactly how an omission goes unmentioned, and
  // an unmentioned omission is a model that believes it has the whole file.
  const footerReserve = wanted.reduce((n, m) => n + 2 * tokensFor(m.raw) + FOOTER_NOTE_TOKENS, 0);
  let remaining = Math.max(0, Math.floor(budgetTokens) - tokensFor(PREAMBLE) - footerReserve);
  let left = loaded.length;

  // Who rendered the whole of a given path, and who is riding on that.
  //
  // Deduplication is on the PAIR (path, symbol), which is right: "@a.ts" and
  // "@a.ts#foo" are two different asks. But when both end up in whole-file
  // mode they render byte for byte the same body under two headers, and the
  // budget this module exists to defend pays for the file twice. On a real ask
  // like "compare @src/agent.ts#planTurn with @src/agent.ts#runTools" that is
  // the entire file attached twice, which then starves whatever is behind it.
  // The second entry stays ATTACHED, because it is: the content it asked for
  // is in the block. It just does not carry a second copy of it.
  const wholeOwner = new Map<string, ParsedMention>();
  const ridingOn = new Map<ParsedMention, ParsedMention>();

  for (const item of loaded) {
    const entry = item.entry;
    // An EQUAL share of what is left, recomputed at every step so room the
    // earlier mentions did not spend flows to the ones behind them. Without
    // it the first mention of a 1 MB file eats the budget and the three small
    // files after it arrive empty, which is the starvation fit_to_budget was
    // written to prevent.
    const share = left > 0 ? Math.floor(remaining / left) : 0;
    left--;

    const owner = wholeOwner.get(item.parsed.path);
    if (owner) {
      // The whole file is already in the block under another mention's header.
      // Nothing to render, nothing to charge, and the footer must not claim it
      // was dropped, because it was not.
      entry.attached = true;
      entry.mode = "whole";
      entry.tokens = 0;
      entry.note = `already attached in full under ${owner.raw}`;
      ridingOn.set(item.parsed, owner);
      continue;
    }

    if (item.whole !== null && item.wholeCost <= share) {
      bodies.set(item.parsed, `${header(item.parsed, `whole file, ${item.lines.length} lines`)}\n${item.whole}`);
      entry.attached = true;
      entry.mode = "whole";
      entry.tokens = item.wholeCost;
      remaining -= item.wholeCost;
      wholeOwner.set(item.parsed.path, item.parsed);
      continue;
    }

    // Room for the body only: the header and the framing are charged first so
    // the excerpt cannot push the entry past its share. The header is measured
    // on its longest plausible form, never on the shortest.
    const headGuess = tokensFor(header(item.parsed, `excerpt around line ${item.lines.length}, ${item.lines.length} of ${item.lines.length} lines, ranked against the message`));
    const bodyBudget = share - headGuess - ENTRY_FRAMING_TOKENS;
    if (bodyBudget < MIN_ENTRY_TOKENS) {
      entry.note = `no room in a ${budgetTokens} token budget`;
      continue;
    }

    // A symbol mention is ranked by DISTANCE to its declaration, so the excerpt
    // grows outward from the symbol instead of hopping around the file. A file
    // mention is ranked by the words of the question.
    const scores = item.at
      ? item.lines.map((_, i) => -Math.abs(i - (item.at - 1)))
      : scoreLines(item.lines, terms);

    const { body, ranges } = fitExcerpt(item.lines, scores, bodyBudget);
    if (ranges.length === 0) {
      entry.note = `no room in a ${budgetTokens} token budget`;
      continue;
    }
    const shown = ranges.reduce((n, r) => n + (r.to - r.from), 0);
    const how = item.at
      ? `excerpt around line ${item.at}, ${shown} of ${item.lines.length} lines`
      : terms.length
        ? `excerpt, ${shown} of ${item.lines.length} lines, ranked against the message`
        : `excerpt, ${shown} of ${item.lines.length} lines, head of the file: the message had no terms to rank by`;
    const head = header(item.parsed, how);
    const cost = tokensFor(head) + tokensFor(body) + ENTRY_FRAMING_TOKENS;
    bodies.set(item.parsed, `${head}\n${body}`);
    entry.attached = true;
    entry.mode = "excerpt";
    entry.note = `${item.lines.length - shown} of ${item.lines.length} lines omitted, ranges named in the body`;
    entry.tokens = cost;
    remaining -= cost;
  }

  // -------------------------------------------------------------- assembly
  //
  // The arithmetic above is careful, but careful is not the same as proven.
  // The block is assembled, measured, and if it is still over budget the last
  // attached body is demoted and it is measured again. Demoting frees far more
  // than the footer line it adds, so the loop converges, and "the block never
  // exceeds the budget" stops being a claim about the arithmetic and becomes a
  // property of the returned value.
  const attachedOrder = wanted.filter((m) => bodies.has(m));
  let block = assemble(wanted, bodies, entries, budgetTokens);
  while (attachedOrder.length && tokensFor(block) > budgetTokens) {
    const drop = attachedOrder.pop()!;
    const entry = loaded.find((l) => l.parsed === drop)!.entry;
    bodies.delete(drop);
    entry.attached = false;
    entry.mode = "none";
    entry.tokens = 0;
    entry.note = `no room in a ${budgetTokens} token budget`;
    // Anything that was riding on this body loses its content with it. Leaving
    // those entries marked "already attached in full" would be the one lie the
    // whole footer exists to prevent.
    for (const [rider, owner] of ridingOn) {
      if (owner !== drop) continue;
      const riderEntry = loaded.find((l) => l.parsed === rider)!.entry;
      riderEntry.attached = false;
      riderEntry.mode = "none";
      riderEntry.tokens = 0;
      riderEntry.note = `no room in a ${budgetTokens} token budget`;
      ridingOn.delete(rider);
    }
    block = assemble(wanted, bodies, entries, budgetTokens);
  }
  if (!block) return { text, block: "", entries, tokens: 0 };
  return { text: `${text}\n\n${block}`, block, entries, tokens: tokensFor(block) };
}

/**
 * Render the block from whatever survived the budget. Separate from
 * resolveMentions so the verification loop above can call it again after a
 * demotion without duplicating the format in two places.
 */
function assemble(
  wanted: ParsedMention[],
  bodies: Map<ParsedMention, string>,
  entries: ResolvedMention[],
  budgetTokens: number
): string {
  const attached: string[] = [];
  for (const m of wanted) {
    const b = bodies.get(m);
    if (b) attached.push(b);
  }
  const missing = entries.filter((e) => !e.attached);
  if (attached.length === 0) {
    // Fail closed and SAY SO, exactly as fit_to_budget does: a caller that
    // receives nothing must be able to tell an empty mention list from a
    // budget too small to hold a single file.
    //
    // THE ONE PLACE THE BUDGET IS ALLOWED TO BE EXCEEDED, and only by this
    // notice, never by workspace content. knowledge.rs makes the same choice
    // for the same reason: a two hundred token budget cannot hold an
    // explanation either, and dropping the explanation to respect it would
    // leave the model with a mention it can see in the message and no idea
    // why nothing came with it.
    if (missing.length === 0) return "";
    const why = missing.map((e) => `${e.raw} (${e.note ?? "unavailable"})`).join(", ");
    return (
      `[Attached context: nothing. ${missing.length} mention(s) could not be attached ` +
      `within a ${budgetTokens} token budget: ${why}. ` +
      `Read what you need with read_file rather than guessing at it.]`
    );
  }
  const parts = [PREAMBLE, ...attached];
  if (missing.length) {
    const why = missing.map((e) => `${e.raw} (${e.note ?? "unavailable"})`).join(", ");
    parts.push(`[Not attached: ${why}.]`);
  }
  return parts.join("\n\n");
}

