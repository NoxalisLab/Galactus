// Galactus, what the app does with a model's thoughts.
//
// WHY THIS MODULE EXISTS. A reasoning model spends its first ten, thirty or
// sixty seconds thinking before it writes a single word of its answer. The app
// showed none of that: llama-server separates the two channels and puts the
// thoughts in `delta.reasoning_content`, and the stream reader in api.ts read
// `delta.content` only, so every thought was parsed and thrown away. From the
// outside a model that reasons for half a minute and an application that has
// hung emit the same signal, which is nothing at all.
//
// So the thoughts have to reach the screen, and reaching the screen safely is
// what this file decides. It is import-free on purpose: every rule below is a
// pure function of text, testable without a DOM, a server or a model.
//
// THE ONE INVARIANT. Only what the SERVER put on the reasoning channel is ever
// treated as reasoning. Nothing here inspects `content` looking for `<think>`.
// A model whose template the server does not know emits its tags inside
// `content`, and content is the answer: guessing which part of an answer was
// really a thought would mean hiding text the model meant to show, on nothing
// better than a tag that a user could have typed. That text keeps rendering as
// it always has, escaped and visible, and this module never sees it.
//
// The mirror of that invariant is the reason `visibleReasoning` exists at all:
// the reasoning channel sometimes replays its own delimiters (a parser that
// keeps the opening tag, a template whose end tag is not stripped). Those are
// noise on a channel that is reasoning BY DEFINITION, so removing them cannot
// hide anything, and leaving them would put raw markup on the screen.

/**
 * The delimiters a reasoning channel is known to replay, longest first.
 *
 * Order matters for `withheldSuffix`: "<thinking>" must be tried before
 * "<think>" or a stream stopped at "<think" would be judged complete.
 */
const MARKERS = ["</thinking>", "<thinking>", "</think>", "<think>"] as const;

/**
 * How much reasoning one block keeps, in characters.
 *
 * Reasoning is unbounded by nature: a hard problem can produce tens of
 * thousands of characters of it, and a thirty step agent run multiplies that
 * by thirty. All of it is persisted with the conversation and read back by the
 * conversation search on the Rust side, so an uncapped block turns one answer
 * into a megabyte of stored thinking and buries the searchable text under it.
 *
 * 16000 characters is roughly four thousand tokens of thought, which is longer
 * than any reasoning a reader actually reads to the end. Past it the block
 * stops growing and says so, rather than truncating silently.
 */
export const REASONING_CAP = 16000;

/** Appended once, when a block stops accepting text. */
/**
 * Marks a block whose beginning was dropped.
 *
 * A sentinel rather than a sentence: the view swaps it for a localised line at
 * render time. It used to be English text sitting inside a French interface,
 * which is the sort of detail that says nobody read the screen.
 */
export const REASONING_TRUNCATED = "\u0000truncated\u0000";

/**
 * The longest tail of `text` that could still become a marker.
 *
 * A marker is streamed like everything else, so "</think>" can arrive as "</t"
 * then "hink>". Rendering the first half would flash "</t" on screen for one
 * frame and then take it back, which is exactly the kind of element-that-was-
 * never-there this feature must not produce. Holding back the ambiguous tail
 * until the next chunk decides it costs one frame of latency on at most nine
 * characters and never shows a fragment that is not text.
 *
 * Only a PROPER prefix counts: a complete marker is not withheld, it is
 * removed by `visibleReasoning`.
 */
export function withheldSuffix(text: string): string {
  for (const marker of MARKERS) {
    // Longest candidate first: "<thin" beats "<thi" when both would match.
    for (let len = marker.length - 1; len > 0; len--) {
      if (text.endsWith(marker.slice(0, len))) return marker.slice(0, len);
    }
  }
  return "";
}

/**
 * What a reasoning block puts on screen.
 *
 * Complete delimiters are removed, an incomplete trailing one is withheld, and
 * the leading blank line a `<think>` tag leaves behind goes with it. Trailing
 * whitespace is KEPT: the block is still streaming and the last newline the
 * model wrote is part of where the next word will land.
 */
export function visibleReasoning(text: string): string {
  let out = text;
  for (const marker of MARKERS) out = out.split(marker).join("");
  const held = withheldSuffix(out);
  if (held !== "") out = out.slice(0, out.length - held.length);
  return out.replace(/^\s+/, "");
}

/**
 * Whether there is a reasoning block to show at all.
 *
 * THE TRAP THIS GUARDS. Most models emit no reasoning, and a model that emits
 * it on one turn emits none on the next. Everything downstream keys on this:
 * no block is created, no heading is drawn, nothing appears and then vanishes.
 * A channel that carried only whitespace, or only its own delimiters, counts
 * as no reasoning, because that is what it is.
 */
export function hasReasoning(text: string): boolean {
  // No second trim: `visibleReasoning` already drops leading whitespace, so a
  // channel that carried only blanks has already become the empty string by
  // the time it gets here. A `.trim()` on top read like a safety net and was
  // one no input could reach, which is the kind of line that makes a mutation
  // survive and a reader believe a rule is enforced twice.
  return visibleReasoning(text) !== "";
}

/**
 * Add a streamed chunk to a block, honouring the cap.
 *
 * THE END IS KEPT, NOT THE BEGINNING. The first version kept the first
 * REASONING_CAP characters, so a model that thought for five minutes froze the
 * block on its opening lines and never showed another word: the reader watched
 * a still image with a note at the bottom saying the rest existed somewhere.
 * What is worth reading while a model thinks is the sentence it is writing now,
 * and what is worth keeping afterwards is how it got to its conclusion, which
 * is also the end. Both point the same way.
 *
 * Cutting from `next` each time, rather than holding a "already truncated"
 * flag, is what makes a block that keeps growing carry exactly one marker.
 */
export function appendReasoning(current: string, chunk: string): string {
  const next = current.startsWith(REASONING_TRUNCATED)
    ? current.slice(REASONING_TRUNCATED.length) + chunk
    : current + chunk;
  if (next.length <= REASONING_CAP) return next;
  return REASONING_TRUNCATED + next.slice(next.length - REASONING_CAP);
}

/**
 * The one line a settled block shows on its header.
 *
 * The FIRST words of the thought, not the last: it is what the reader already
 * watched stream by, so recognising the block costs no re-reading, and an
 * opening sentence survives being cut far better than a conclusion does.
 */
export function reasoningGist(text: string, max = 120): string {
  const flat = visibleReasoning(text).replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max).trimEnd() + "…";
}
