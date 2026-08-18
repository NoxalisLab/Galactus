// Whether a streaming box drags the reader to the bottom.
//
// WHAT THIS COVERS THAT NOTHING ELSE DID. paintChat runs once per token and
// ended with an unconditional scrollTop = scrollHeight. Nothing about the text
// was wrong, so nothing about the text could catch it: the defect is only
// visible as a reader who scrolled up and did not stay there.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { FOLLOW_SLACK, isFollowing } from "../../src/follow.js";

const box = (top: number, height = 1000, view = 400) => ({
  scrollTop: top,
  scrollHeight: height,
  clientHeight: view,
});

test("a reader at the end is following", () => {
  assert.equal(isFollowing(box(600)), true);
});

test("a reader who scrolled up is left alone", () => {
  // The whole point. At 200 of 600 they are reading something older, and a
  // token arriving must not move them.
  assert.equal(isFollowing(box(200)), false);
});

test("a few pixels of slack still counts as following", () => {
  // Fractional scroll positions and sub-pixel layout mean "exactly at the end"
  // is almost never exactly true, and a strict test would stop following after
  // the first token.
  assert.equal(isFollowing(box(600 - FOLLOW_SLACK + 1)), true);
  assert.equal(isFollowing(box(600 - FOLLOW_SLACK - 1)), false);
});

test("a box with nothing to scroll is following", () => {
  // It has no "up" to have scrolled to. Treating it as not-following would
  // freeze the opening lines of every short answer.
  assert.equal(isFollowing(box(0, 300, 400)), true);
});
