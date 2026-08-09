// The open/close state machine, exercised without a browser.
//
// The box lives in a StateField and is published through the `showTooltip`
// facet, so every rule that matters (one box at a time, an edit under the box
// closes it, Escape closes it) is a property of an EditorState transaction and
// can be proved here. Only the DOM half needs a window, and that half is
// deliberately kept to event wiring.

import { EditorState } from "@codemirror/state";
import { keymap, showTooltip, type Tooltip } from "@codemirror/view";
import {
  closeInlineEditEffect,
  expandEditRange,
  inlineEditExtension,
  inlineEditOpen,
  openInlineEditEffect,
  type InlineEditDeps,
} from "../../src/code/inline-edit.js";

const NODE_TEST = "node:test";
const NODE_ASSERT = "node:assert/strict";
const { test } = (await import(NODE_TEST)) as {
  test: (name: string, fn: () => unknown) => void;
};
const assert = ((await import(NODE_ASSERT)) as { default: any }).default;

const DOC = "function f() {\n  return a - b;\n}\n";

interface Spy {
  deps: InlineEditDeps;
  asked: number;
  translated: string[];
}

function spyDeps(): Spy {
  const spy: Spy = {
    asked: 0,
    translated: [],
    deps: {
      file: () => "src/f.ts",
      enabled: () => true,
      reviewing: () => false,
      ask: async () => {
        spy.asked++;
        return null;
      },
      propose: () => {},
      t: (key) => {
        spy.translated.push(key);
        return key;
      },
    },
  };
  return spy;
}

function stateWith(spy: Spy): EditorState {
  // keys: false because a keymap needs no view to build, but binding Mod-k in
  // a headless state proves nothing; the guard being tested is the field.
  return EditorState.create({ doc: DOC, extensions: inlineEditExtension(spy.deps, { keys: false }) });
}

function tooltips(state: EditorState): Tooltip[] {
  return state.facet(showTooltip).filter((tip): tip is Tooltip => tip != null);
}

function session(state: EditorState, at: number) {
  return { rel: "src/f.ts", range: expandEditRange(state.doc.toString(), at, at) };
}

test("a fresh editor has no box", () => {
  const state = stateWith(spyDeps());
  assert.equal(inlineEditOpen(state), false);
  assert.equal(tooltips(state).length, 0);
});

test("opening publishes exactly one tooltip, anchored on the region", () => {
  const spy = spyDeps();
  const state = stateWith(spy);
  const at = DOC.indexOf("  return");
  const opened = state.update({ effects: openInlineEditEffect.of(session(state, at)) }).state;
  assert.equal(inlineEditOpen(opened), true);
  const tips = tooltips(opened);
  assert.equal(tips.length, 1);
  assert.equal(tips[0].pos, at);
  assert.equal(tips[0].above, true);
});

test("building the box is lazy: nothing is translated until it is rendered", () => {
  // If the tooltip body were built eagerly it would touch `document` here and
  // the whole state machine would become untestable outside a browser.
  const spy = spyDeps();
  const state = stateWith(spy);
  state.update({ effects: openInlineEditEffect.of(session(state, 0)) });
  assert.deepEqual(spy.translated, []);
  assert.equal(spy.asked, 0);
});

test("a second Cmd+K does not stack a second box", () => {
  const spy = spyDeps();
  const state = stateWith(spy);
  const first = DOC.indexOf("  return");
  const opened = state.update({ effects: openInlineEditEffect.of(session(state, first)) }).state;
  const again = opened.update({ effects: openInlineEditEffect.of(session(opened, 0)) }).state;
  const tips = tooltips(again);
  assert.equal(tips.length, 1);
  // Same object, so CodeMirror keeps the mounted input and its typed text
  // instead of tearing it down and rebuilding it empty.
  assert.equal(tips[0], tooltips(opened)[0]);
  assert.equal(tips[0].pos, first);
});

test("two open effects in one transaction still yield one box", () => {
  const spy = spyDeps();
  const state = stateWith(spy);
  const opened = state.update({
    effects: [
      openInlineEditEffect.of(session(state, 0)),
      openInlineEditEffect.of(session(state, DOC.indexOf("  return"))),
    ],
  }).state;
  assert.equal(tooltips(opened).length, 1);
  assert.equal(tooltips(opened)[0].pos, 0);
});

test("the close effect removes the box", () => {
  const spy = spyDeps();
  const state = stateWith(spy);
  const opened = state.update({ effects: openInlineEditEffect.of(session(state, 0)) }).state;
  const closed = opened.update({ effects: closeInlineEditEffect.of(null) }).state;
  assert.equal(inlineEditOpen(closed), false);
  assert.equal(tooltips(closed).length, 0);
});

test("closing an editor that has no box is a no-op, not a crash", () => {
  const state = stateWith(spyDeps());
  const closed = state.update({ effects: closeInlineEditEffect.of(null) }).state;
  assert.equal(inlineEditOpen(closed), false);
});

test("an edit under the box closes it, because the offsets no longer hold", () => {
  const spy = spyDeps();
  const state = stateWith(spy);
  const at = DOC.indexOf("  return");
  const opened = state.update({ effects: openInlineEditEffect.of(session(state, at)) }).state;
  const edited = opened.update({ changes: { from: 0, insert: "// header\n" } }).state;
  assert.equal(inlineEditOpen(edited), false);
});

test("an open effect arriving with the document change is still refused", () => {
  // Same transaction, so the region was measured against a document that no
  // longer exists by the time the effect is read.
  const spy = spyDeps();
  const state = stateWith(spy);
  const opened = state.update({
    changes: { from: 0, insert: "x" },
    effects: openInlineEditEffect.of(session(state, 0)),
  }).state;
  assert.equal(inlineEditOpen(opened), false);
});

test("moving the caret leaves the box alone", () => {
  const spy = spyDeps();
  const state = stateWith(spy);
  const opened = state.update({ effects: openInlineEditEffect.of(session(state, 0)) }).state;
  const moved = opened.update({ selection: { anchor: 5 } }).state;
  assert.equal(inlineEditOpen(moved), true);
});

test("an editor without the extension simply ignores the effect", () => {
  const state = EditorState.create({ doc: DOC });
  assert.equal(inlineEditOpen(state), false);
  const after = state.update({
    effects: openInlineEditEffect.of({ rel: "a.ts", range: expandEditRange(DOC, 0, 0) }),
  }).state;
  assert.equal(inlineEditOpen(after), false);
});

test("the default extension carries its own Cmd+K and Escape bindings", () => {
  // The point of a self contained module: dropped into an editor whose host
  // never touches its keymap, the gesture still exists.
  const spy = spyDeps();
  const withKeys = EditorState.create({ doc: DOC, extensions: inlineEditExtension(spy.deps) });
  const keys = withKeys.facet(keymap).flat().map((binding) => binding.key);
  assert.equal(keys.includes("Mod-k"), true);
  assert.equal(keys.includes("Escape"), true);
});

test("keys: false leaves the host's keymap untouched", () => {
  const spy = spyDeps();
  const bare = EditorState.create({
    doc: DOC,
    extensions: inlineEditExtension(spy.deps, { keys: false }),
  });
  assert.deepEqual(bare.facet(keymap).flat(), []);
});
