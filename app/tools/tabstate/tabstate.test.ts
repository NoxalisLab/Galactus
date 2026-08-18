// What survives a relaunch: the open files, both panes, and which side had the
// focus. The failures here are all quiet ones, which is why they are pinned.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { encodeTabs, parseTabs } from "../../src/code/tabstate.js";

test("a split session comes back as a split session", () => {
  const state = {
    rels: ["a.ts", "b.ts"],
    active: "b.ts",
    right: ["c.ts"],
    rightActive: "c.ts",
    pane: 1 as const,
  };
  assert.deepEqual(parseTabs(encodeTabs(state)), state);
});

test("a value written by an older build still opens its files", () => {
  // No `right`, no `pane`: the shape before the split existed.
  const old = JSON.stringify({ rels: ["a.ts"], active: "a.ts" });
  assert.deepEqual(parseTabs(old), {
    rels: ["a.ts"],
    active: "a.ts",
    right: [],
    rightActive: null,
    pane: 0,
  });
});

test("nothing usable returns null instead of throwing", () => {
  assert.equal(parseTabs(undefined), null);
  assert.equal(parseTabs("   "), null);
  assert.equal(parseTabs("{not json"), null);
  assert.equal(parseTabs("42"), null);
});

test("a focus on an empty pane is corrected, not restored", () => {
  // Otherwise the user comes back typing into a column that is not on screen.
  const s = parseTabs(JSON.stringify({ rels: ["a.ts"], active: "a.ts", right: [], pane: 1 }));
  assert.equal(s?.pane, 0);
});

test("an active file that is no longer in its list is dropped", () => {
  const s = parseTabs(JSON.stringify({ rels: ["a.ts"], active: "gone.ts", right: [] }));
  assert.equal(s?.active, null);
});

test("junk inside the lists is filtered, not trusted", () => {
  const s = parseTabs(JSON.stringify({ rels: ["a.ts", 7, null, "b.ts"], right: "nope" }));
  assert.deepEqual(s?.rels, ["a.ts", "b.ts"]);
  assert.deepEqual(s?.right, []);
});

test("a file listed on both sides is kept once, on the left", () => {
  // Restoring it twice made openFile move the focus mid-loop, and every
  // remaining right-hand file opened on the left instead: the split collapsed
  // on reopening, silently.
  const s = parseTabs(
    JSON.stringify({ rels: ["a.ts", "b.ts"], right: ["b.ts", "c.ts"], pane: 1 }),
  );
  assert.deepEqual(s?.rels, ["a.ts", "b.ts"]);
  assert.deepEqual(s?.right, ["c.ts"]);
});
