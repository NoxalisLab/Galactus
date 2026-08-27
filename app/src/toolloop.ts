// The two rules that keep a tool loop from eating an afternoon.
//
// Both were written after the same run. An agent was asked to apply a table of
// 414 translations to a Word document. The batch SUCCEEDED, 323 rows written
// to disk, but the report was 37 KB, which overflowed the context window, so
// it was spilled to a scratch file. The model read that file back; the re-read
// was oversized in its own right, so it was spilled to a SECOND scratch file
// under a fresh timestamped name and digested into the same words. Same answer,
// new path, nothing anywhere counting that this had already happened. The run
// ended ninety minutes later on the tool-depth limit, and the user was told
// nothing at all about the file sitting finished on their desk.
//
// They live here, apart from agent.ts, because agent.ts imports the Tauri
// bridge and the DOM and cannot be loaded by the Node test runner. These are
// pure functions over strings and counters, so the tests below them exercise
// the real code rather than a copy of it.

/**
 * Is this path one of the scratch files an oversized tool output spills into?
 *
 * Used as a fallback when the agent's own record of what it spilled does not
 * cover the path: a scratch file from an earlier turn, or one a teammate
 * produced, which the model may still be holding.
 */
export function isSpillPath(path: string): boolean {
  return /\/scratch\/tool-[^/]+$/.test(path);
}

/**
 * A short, stable tag for a piece of text: the same content always gets the
 * same one.
 *
 * WHY A HASH AND NOT A TIMESTAMP. Spill files used to be named from Date.now(),
 * so re-running a tool that produced identical output wrote a SECOND file under
 * a different name, and the history now held a different path, which is a
 * different prefix, which throws away the engine's KV cache from that point on.
 * On a 20 000-token thread that is two minutes of re-ingestion bought with
 * nothing. Naming by content instead means the same output is the same path,
 * the history says the same bytes, and the cache holds.
 *
 * FNV-1a, 32 bits. This names scratch files; it is not a security boundary and
 * a collision costs one stale re-read, not correctness.
 */
export function contentTag(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= text.charCodeAt(i) >>> 8;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Length joins the tag: two different texts that collide in the hash almost
  // never share a length as well, and it costs four characters.
  return hash.toString(36) + text.length.toString(36);
}

/**
 * How many BYTES this string occupies once encoded as UTF-8.
 *
 * Counted rather than measured with TextEncoder so this module stays free of
 * both the DOM and Node: it is the one piece of agent.ts the test runner can
 * load, and that is only true while it depends on nothing.
 */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4; // a surrogate pair is one character in four bytes
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * One slice of a file, and the exact call that gets the next one.
 *
 * This is what a re-read of a spilled file gets instead of being spilled again.
 * The offset is in BYTES because that is what read_file counts, and a French
 * document is not ASCII: handing back a character count would send the next
 * read to the wrong place and cut a word in half.
 */
export function spillWindow(result: string, allowance: number, path: string, offset: number): string {
  const room = Math.max(1000, allowance - 500);
  let body = result.slice(0, room);
  if (body.length < result.length) {
    // Never end on the first half of a surrogate pair: the next window would
    // start on the second half and neither would be a character.
    const last = body.charCodeAt(body.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) body = body.slice(0, -1);
    // Prefer to stop at a line boundary, as long as one is near the cut.
    const nl = body.lastIndexOf("\n");
    if (nl > room * 0.5) body = body.slice(0, nl);
  }
  const next = offset + utf8Length(body);
  const rest = result.length - body.length;
  const head = `${body}\n\n[WINDOW: bytes ${offset} to ${next} of ${path}.`;
  if (rest <= 0) return `${head} This is the end of the file.]`;
  return (
    `${head} ${rest} characters follow.\n` +
    `To go further call read_file("${path}", offset: ${next}). Calling it again WITHOUT an offset ` +
    `returns this same window and gets you nowhere.\n` +
    `To jump straight to what you need instead of paging, call retrieve("${path}", "<what you are looking for>").]`
  );
}

/** Does this error say the path simply is not there? */
export function looksMissing(message: string): boolean {
  return /no such file|not found|cannot find|does not exist|os error 2|enoent/i.test(message);
}

/**
 * The one sentence that turns a wrong path into a corrected path.
 *
 * WHY IT EARNS ITS LINE. An agent invented a filename, got "not found", and
 * spent five tool rounds guessing variations of it before finally listing the
 * folder. On this machine each of those rounds cost about two minutes of prompt
 * ingestion, so ten minutes went to a question one call answers. The recovery
 * was always available; nothing had said what it was.
 *
 * Returns "" when there is no parent worth naming, so the caller can append it
 * unconditionally.
 */
export function missingPathHint(path: string): string {
  const cut = path.lastIndexOf("/");
  if (cut < 1) return "";
  const parent = path.slice(0, cut);
  return (
    `\n\nThat path does not exist. Do NOT guess another spelling of it: call ` +
    `list_directory("${parent}") once and use a name from the answer. Names with spaces, ` +
    `accents or a different extension are exactly what guessing gets wrong.`
  );
}

/** What to do about a call that has been made before. */
export interface RepeatVerdict {
  /** Refuse the call and return this instead. */
  stop?: string;
  /** Let it run, but append this to the result. */
  note?: string;
}

/**
 * Counts identical calls within one user turn and says when to stop.
 *
 * The second identical call still RUNS: a command can legitimately be run twice
 * because something changed in between, and refusing early would break honest
 * work. It comes back with a note. The third does not run at all, because by
 * then the pattern is not a coincidence: a model repeating itself is not
 * gathering information, it is out of ideas, and the useful thing to do is say
 * so and ask it for a report instead of a thirtieth round trip.
 *
 * Per turn, not per conversation: asking the same question again tomorrow is a
 * new question.
 */
export class RepeatGuard {
  private counts = new Map<string, number>();

  /** Forget everything. Called at the start of each user turn. */
  clear(): void {
    this.counts.clear();
  }

  /** How many times this exact call has been seen, this one included. */
  seen(name: string, args: unknown): number {
    let key: string;
    try {
      key = `${name}:${JSON.stringify(args)}`;
    } catch {
      return 1; // unserialisable arguments: nothing we can compare
    }
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return n;
  }

  /** `seen`, turned into what the caller should do. */
  verdict(name: string, args: unknown): RepeatVerdict {
    const n = this.seen(name, args);
    if (n === 2) {
      return {
        note:
          `\n\n[You have now called ${name} with these exact arguments twice this turn. ` +
          `The answer above is what it gives. If it is not what you need, change the arguments ` +
          `or the approach: repeating the call cannot change the result.]`,
      };
    }
    if (n >= 3) {
      return {
        stop:
          `error: not run. This is call number ${n} to ${name} with these exact arguments in ` +
          `this turn, and the ones before it returned the same thing. Repeating it cannot produce ` +
          `anything new.\n\nDo one of these instead: call it with different arguments, use a ` +
          `different tool, or stop and tell the user what you have established so far and what is ` +
          `blocking you. A partial result reported honestly is worth more than another identical call.`,
      };
    }
    return {};
  }
}
