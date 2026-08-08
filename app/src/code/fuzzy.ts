// Galactus, the fuzzy path matcher behind the file and symbol palettes.
//
// No imports, no dependency, no crate. `nucleo` is the usual answer and it is
// MPL-2.0: a file-level copyleft obligation that an Apache-2.0 project does
// not need for one page of arithmetic. This is that page.
//
// Two passes per candidate, both allocation-free:
//
//   1. A forward subsequence scan. A candidate that does not contain the query
//      as a subsequence is rejected here, in a single walk, before anything
//      else is computed. That early rejection is what keeps 100k paths under a
//      frame; it is asserted in the tests.
//   2. A backward scan from the last matched character, which tightens the
//      match to the SHORTEST window that still contains the query. Scoring the
//      tight window is what makes "conf" prefer `config.ts` over a candidate
//      whose c, o, n and f are scattered across a directory name.
//
// Scoring is then a single walk over that window. Nothing is allocated for a
// candidate that does not make the result list: `rank()` scores everything and
// only reconstructs the matched positions for the rows it returns.

/** One ranked row: the candidate and the character offsets that matched it. */
export interface RankedPath {
  path: string;
  /** Indices into `path` (UTF-16 code units) that the query matched. */
  positions: number[];
}

/** Every matched character is worth this before any bonus. */
const MATCH = 12;
/** The match starts at the very first character of the path. */
const BONUS_START = 30;
/** First character of a path segment. */
const BONUS_SLASH = 22;
/** First character after `-`, `_`, `.` or a space. */
const BONUS_SEP = 18;
/** A camelCase hump: lowercase or digit, then uppercase. */
const BONUS_CAMEL = 18;
/** Glued to the previously matched character. */
const BONUS_CONSEC = 16;
/** Inside the file name rather than inside a directory name. */
const BONUS_BASENAME = 6;
/** Per character skipped between the first and the last matched character. */
const PENALTY_SKIP = 2;
/** Per character before the first matched one, so early matches win. */
const PENALTY_LEAD = 1;
/** Long paths lose a little, so the shorter of two equal matches comes first. */
const PENALTY_LENGTH = 0.15;

/** Fixed lift given by `rank()` to a path the user opened recently. */
export const RECENT_BONUS = 45;

/** ASCII-fast lowercase of one UTF-16 code unit. */
function lower(c: number): number {
  if (c >= 65 && c <= 90) return c + 32;
  if (c < 128) return c;
  return String.fromCharCode(c).toLowerCase().charCodeAt(0);
}

function isUpper(c: number): boolean {
  if (c >= 65 && c <= 90) return true;
  if (c < 128) return false;
  const s = String.fromCharCode(c);
  return s !== s.toLowerCase() && s === s.toUpperCase();
}

function isLowerOrDigit(c: number): boolean {
  if (c >= 97 && c <= 122) return true;
  if (c >= 48 && c <= 57) return true;
  if (c < 128) return false;
  const s = String.fromCharCode(c);
  return s !== s.toUpperCase();
}

/** `/`, `-`, `_`, `.`, space: the characters a new word starts after. */
function isSep(c: number): boolean {
  return c === 47 || c === 45 || c === 95 || c === 46 || c === 32;
}

/**
 * The shared core. `out`, when given, receives the matched positions.
 * Returns null when `candidate` does not contain `query` as a subsequence.
 */
function match(query: string, candidate: string, out: number[] | null): number | null {
  const qn = query.length;
  const cn = candidate.length;
  if (qn === 0) return 0;
  if (qn > cn) return null;

  // Pass 1: forward subsequence scan. The cheap rejection.
  let qi = 0;
  let end = -1;
  for (let i = 0; i < cn; i++) {
    if (lower(candidate.charCodeAt(i)) === lower(query.charCodeAt(qi))) {
      qi++;
      if (qi === qn) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;

  // Pass 2: backward scan from `end`, giving the tightest window.
  let start = end;
  qi = qn - 1;
  for (let i = end; i >= 0; i--) {
    if (lower(candidate.charCodeAt(i)) === lower(query.charCodeAt(qi))) {
      if (qi === 0) {
        start = i;
        break;
      }
      qi--;
    }
  }

  // Pass 3: score the window.
  const baseStart = candidate.lastIndexOf("/") + 1;
  let score = 0;
  let prev = -2;
  qi = 0;
  for (let i = start; i <= end && qi < qn; i++) {
    const cc = candidate.charCodeAt(i);
    if (lower(cc) !== lower(query.charCodeAt(qi))) continue;
    score += MATCH;
    if (i === 0) score += BONUS_START;
    else {
      const pc = candidate.charCodeAt(i - 1);
      if (pc === 47) score += BONUS_SLASH;
      else if (isSep(pc)) score += BONUS_SEP;
      else if (isUpper(cc) && isLowerOrDigit(pc)) score += BONUS_CAMEL;
    }
    if (i === prev + 1) score += BONUS_CONSEC;
    if (i >= baseStart) score += BONUS_BASENAME;
    if (out) out.push(i);
    prev = i;
    qi++;
  }
  score -= start * PENALTY_LEAD;
  score -= (end - start + 1 - qn) * PENALTY_SKIP;
  score -= cn * PENALTY_LENGTH;
  return score;
}

/**
 * Score `candidate` against `query`, or null when it is not a match at all.
 * Higher is better; the absolute value has no meaning outside a comparison.
 */
export function score(query: string, candidate: string): number | null {
  return match(query, candidate, null);
}

/** The characters of `candidate` that `query` matched. Empty on a non-match. */
export function positions(query: string, candidate: string): number[] {
  const out: number[] = [];
  return match(query, candidate, out) === null ? [] : out;
}

/**
 * Equal scores are broken deterministically: the shorter path first, then
 * alphabetical order. Two runs over the same input always produce the same
 * list, which is what makes the frozen test table meaningful.
 */
function better(sa: number, a: string, sb: number, b: string): boolean {
  if (sa !== sb) return sa > sb;
  if (a.length !== b.length) return a.length < b.length;
  return a < b;
}

/**
 * Rank `candidates`, best first, at most `limit` rows. Paths in `recent` get a
 * fixed lift so the files the user just had open stay near the top of a loose
 * query without ever overriding a clearly better match.
 *
 * Only the returned rows pay for their `positions` array: selection is done on
 * scores alone, through a bounded insertion buffer, so a 100k candidate list
 * never allocates 100k anything.
 */
export function rank(
  query: string,
  candidates: string[],
  recent: string[],
  limit: number
): RankedPath[] {
  const cap = Math.max(0, limit);
  if (cap === 0) return [];
  const lift = recent.length ? new Set(recent) : null;

  const bestPaths: string[] = [];
  const bestScores: number[] = [];
  let worst = -Infinity;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const raw = match(query, c, null);
    if (raw === null) continue;
    const s = lift && lift.has(c) ? raw + RECENT_BONUS : raw;
    if (bestPaths.length === cap && !better(s, c, worst, bestPaths[bestPaths.length - 1])) continue;
    let at = bestPaths.length;
    while (at > 0 && better(s, c, bestScores[at - 1], bestPaths[at - 1])) at--;
    bestPaths.splice(at, 0, c);
    bestScores.splice(at, 0, s);
    if (bestPaths.length > cap) {
      bestPaths.pop();
      bestScores.pop();
    }
    worst = bestScores[bestScores.length - 1];
  }

  return bestPaths.map((p) => ({ path: p, positions: positions(query, p) }));
}
