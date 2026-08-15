// The rules that decide what a model's thoughts look like on screen.
//
// Every case below is a stream, not a string: reasoning arrives one chunk at a
// time, so the interesting failures are the ones that only exist mid-flight (a
// delimiter split across two chunks, a block that is still empty, a block that
// has run away). Asserting on finished text would miss all of them.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import {
  REASONING_CAP,
  REASONING_TRUNCATED,
  appendReasoning,
  hasReasoning,
  reasoningGist,
  visibleReasoning,
  withheldSuffix,
} from "../../src/reasoning.js";

/** Feed chunks the way the stream does, returning what the screen holds. */
function stream(...chunks: string[]): string {
  let text = "";
  for (const c of chunks) text = appendReasoning(text, c);
  return visibleReasoning(text);
}

// ------------------------------------------------- the no-reasoning case

test("a model that emits nothing on the channel has no block", () => {
  assert.equal(hasReasoning(""), false);
});

test("whitespace alone is not reasoning", () => {
  // A server that flushes a newline before deciding there is nothing to say
  // must not open a block: an empty bordered box under every answer is the
  // stray element this feature is forbidden to produce.
  assert.equal(hasReasoning("\n"), false);
  assert.equal(hasReasoning("   \n\t  "), false);
});

test("delimiters alone are not reasoning", () => {
  // A template that emits its open and close tags around an empty thought is
  // still a model that did not reason.
  assert.equal(hasReasoning("<think></think>"), false);
  assert.equal(hasReasoning("<thinking>\n</thinking>"), false);
});

test("one real word is reasoning", () => {
  assert.equal(hasReasoning("ok"), true);
  assert.equal(hasReasoning("<think>ok</think>"), true);
});

// ------------------------------------------------- delimiters on the channel

test("a replayed opening tag never reaches the screen", () => {
  // Some builds hand back the reasoning channel with its own opening tag. It
  // is noise on a channel that is reasoning by definition, and shown raw it
  // would read as markup the model wrote on purpose.
  assert.equal(stream("<think>", "the user wants a diff"), "the user wants a diff");
});

test("a replayed closing tag never reaches the screen", () => {
  assert.equal(stream("weighing two options", "</think>"), "weighing two options");
});

test("the blank line a tag leaves behind goes with it", () => {
  // Without the leading trim the block opens on an empty first line and the
  // text appears to start one row too low, which reads as a rendering bug.
  assert.equal(stream("<think>\n\n", "first thought"), "first thought");
});

test("a delimiter split across two chunks never flashes a fragment", () => {
  // THE REGRESSION THIS PINS. "</think>" arrives as "</t" then "hink>". The
  // first chunk rendered on its own puts "</t" on screen for one frame and
  // then takes it back. Holding the ambiguous tail back costs one frame and
  // shows nothing that is not text.
  assert.equal(stream("done thinking", "</t"), "done thinking");
  assert.equal(stream("done thinking", "</t", "hink>"), "done thinking");
});

test("the withheld tail is the longest one that could still become a marker", () => {
  assert.equal(withheldSuffix("abc</think"), "</think");
  assert.equal(withheldSuffix("abc<thin"), "<thin");
  assert.equal(withheldSuffix("abc<"), "<");
  // A COMPLETE marker is removed, not withheld: withholding it would leave it
  // on the screen forever once the stream ends on it.
  assert.equal(withheldSuffix("abc</think>"), "");
  // Ordinary text that merely ends in a comparison keeps its character.
  assert.equal(withheldSuffix("if x > y"), "");
});

test("text that merely resembles a tag is left alone", () => {
  // "<thought>" is not a delimiter this app knows, so it is text the model
  // wrote and it stays. Stripping anything angle-bracketed would silently eat
  // reasoning about markup, which reasoning about this very app would be.
  assert.equal(stream("emitting <thought> nodes"), "emitting <thought> nodes");
});

test("trailing whitespace is kept while the block streams", () => {
  // The block is live: the last newline the model wrote is where the next word
  // lands, and trimming it would make the text jump on every chunk.
  assert.equal(stream("line one\n"), "line one\n");
});

// ------------------------------------------------- the cap

test("a runaway thought keeps its end and says the beginning is gone", () => {
  // Which end is kept is the whole point. Keeping the first characters froze
  // the block on a model's opening lines and never showed another word, which
  // on a five minute reasoning turn is a still image with a note under it.
  const long = "abcdefghij".repeat(REASONING_CAP);
  const capped = appendReasoning("", long + "THE-LAST-WORDS");
  assert.ok(capped.startsWith(REASONING_TRUNCATED), "the block states that it was cut");
  assert.ok(capped.endsWith("THE-LAST-WORDS"), "and what it kept is what was written last");
  assert.equal(
    capped.length,
    REASONING_CAP + REASONING_TRUNCATED.length,
    "and holds the cap plus that one marker",
  );
});

test("a capped block that keeps growing still follows the newest words", () => {
  // The case the first version could not do at all: once capped it was frozen,
  // so a model thinking for another four minutes wrote into a void.
  let text = appendReasoning("", "z".repeat(REASONING_CAP + 100));
  text = appendReasoning(text, "NEWEST");
  assert.ok(text.endsWith("NEWEST"), "the latest chunk is on screen");
  assert.equal(text.length, REASONING_CAP + REASONING_TRUNCATED.length, "and the cap holds");
});

test("the truncation marker is added exactly once", () => {
  // Appending it per chunk would repeat it for as long as the model keeps
  // thinking, which on a long reasoning turn is thousands of times.
  let text = appendReasoning("", "y".repeat(REASONING_CAP + 10));
  for (let i = 0; i < 5; i++) text = appendReasoning(text, "more");
  assert.equal(text.split(REASONING_TRUNCATED).length - 1, 1, "one marker, not six");
});

test("a normal thought is not capped", () => {
  assert.equal(appendReasoning("a", "b"), "ab");
});

// ------------------------------------------------- the settled header

test("the gist is the opening of the thought, flattened to one line", () => {
  const gist = reasoningGist("The user wants\n\na diff of the two\tconfigs.");
  assert.equal(gist, "The user wants a diff of the two configs.");
});

test("a long gist is cut with an ellipsis rather than wrapped", () => {
  const gist = reasoningGist("z".repeat(300), 40);
  assert.equal(gist.length, 41, "forty characters and the ellipsis");
  assert.ok(gist.endsWith("…"));
});

test("the gist of nothing is nothing", () => {
  // The header of a block that never existed is never drawn, but the function
  // must not invent an ellipsis for an empty string on the way there.
  assert.equal(reasoningGist(""), "");
  assert.equal(reasoningGist("<think></think>"), "");
});

test("the gist carries no delimiters", () => {
  assert.equal(reasoningGist("<think>weighing options</think>"), "weighing options");
});
