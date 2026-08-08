// Proof for app/src/code/docs.ts.
//
// Two documents, real EditorStates, no DOM and no EditorView. The view is a
// plain `{ state }` object, which is all `capture` and `byView` ever read, and
// the "user" is a transaction.
//
// The second test is the regression test for the bug that exists in code.ts
// today: `savedContent` is a module-level singleton, so recording a save for
// one document rewrites the other document's idea of what is on disk.

import { EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { history, redo, undo } from "@codemirror/commands";
import { Docs } from "../../src/code/docs.js";

// @types/node is deliberately absent from the app (it ships no Node runtime
// dependency), so the built-in test modules are loaded through a variable
// specifier: TypeScript then types them as any instead of failing to resolve.
const NODE_TEST = "node:test";
const NODE_ASSERT = "node:assert/strict";
const { test } = (await import(NODE_TEST)) as {
  test: (name: string, fn: () => unknown) => void;
};
const assert = ((await import(NODE_ASSERT)) as { default: any }).default;

/** The injected state builder. Same shape the Code view will pass, minus the
 *  theme, the languages and the merge view, which need none of this proof. */
function createState(_rel: string, doc: string, extra: Extension[]): EditorState {
  return EditorState.create({ doc, extensions: [history(), extra] });
}

/** A stand-in for the single mounted EditorView. */
interface FakeView {
  state: EditorState;
}

/** Run a CodeMirror command against the fake view, the way a keymap would. */
function run(view: FakeView, command: (target: any) => boolean): boolean {
  return command({
    get state() {
      return view.state;
    },
    dispatch: (tr: any) => {
      view.state = tr.state;
    },
  });
}

function typeAt(view: FakeView, from: number, insert: string): void {
  view.state = view.state.update({
    changes: { from, insert },
    selection: { anchor: from + insert.length },
  }).state;
}

test("switching tabs preserves text, cursor and undo history", () => {
  const docs = new Docs(createState);

  const a = docs.open("src/a.ts", "alpha\n");
  const view: FakeView = { state: a.state };

  typeAt(view, 0, "X");
  typeAt(view, 6, "!");
  assert.equal(view.state.doc.toString(), "Xalpha!\n");
  assert.equal(view.state.selection.main.head, 7);
  docs.capture(view);

  // Open a second file and work in it.
  const b = docs.open("src/b.ts", "beta\n");
  view.state = b.state;
  typeAt(view, 0, "YY");
  docs.capture(view);
  assert.equal(docs.get("src/b.ts")!.state.doc.toString(), "YYbeta\n");

  // Back to the first tab.
  const again = docs.activate("src/a.ts");
  assert.ok(again);
  view.state = again!.state;

  assert.equal(view.state.doc.toString(), "Xalpha!\n");
  assert.equal(view.state.selection.main.head, 7);

  // Undo history survived the round trip: the two edits come back one by one,
  // which no `EditorState.create({doc: buffer})` rebuild could do.
  assert.equal(run(view, undo), true);
  assert.equal(view.state.doc.toString(), "Xalpha\n");
  assert.equal(run(view, undo), true);
  assert.equal(view.state.doc.toString(), "alpha\n");
  run(view, redo);
  run(view, redo);
  assert.equal(view.state.doc.toString(), "Xalpha!\n");

  // The other document was not disturbed by any of it.
  assert.equal(docs.get("src/b.ts")!.state.doc.toString(), "YYbeta\n");
  assert.deepEqual(docs.tabs, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(
    docs.list().map((d) => d.rel),
    ["src/a.ts", "src/b.ts"]
  );
});

test("setSaved on one document leaves the other one alone (regression)", () => {
  const docs = new Docs(createState);

  const a = docs.open("src/a.ts", "alpha\n");
  const view: FakeView = { state: a.state };
  typeAt(view, 0, "X");
  docs.capture(view);

  const b = docs.open("src/b.ts", "beta\n");
  view.state = b.state;
  typeAt(view, 0, "Y");
  docs.capture(view);

  assert.equal(docs.isDirty("src/a.ts"), true);
  assert.equal(docs.isDirty("src/b.ts"), true);

  // A is written to disk. In code.ts today this assignment lands on the shared
  // `savedContent` and silently clears B's dirty flag with A's content.
  docs.setSaved("src/a.ts", "Xalpha\n");

  assert.equal(docs.isDirty("src/a.ts"), false);
  assert.equal(docs.get("src/a.ts")!.saved, "Xalpha\n");
  assert.equal(docs.get("src/b.ts")!.saved, "beta\n");
  assert.equal(docs.isDirty("src/b.ts"), true);
});

test("byView and capture route to the document the state belongs to", () => {
  const docs = new Docs(createState);
  const a = docs.open("a.txt", "one");
  const b = docs.open("b.txt", "two");

  assert.equal(docs.byView({ state: a.state })!.rel, "a.txt");
  assert.equal(docs.byView({ state: b.state })!.rel, "b.txt");

  // Capture while B is active but the view still shows A: the edit must land
  // on A, not on whatever happens to be focused.
  const view: FakeView = { state: a.state };
  typeAt(view, 3, "!");
  docs.activate("b.txt");
  docs.capture(view);
  assert.equal(docs.get("a.txt")!.state.doc.toString(), "one!");
  assert.equal(docs.get("b.txt")!.state.doc.toString(), "two");

  // A state built outside the registry belongs to nobody.
  assert.equal(docs.byView({ state: EditorState.create({ doc: "x" }) }), null);
});

test("review mode carries the proposal and its own merge base", () => {
  const seen: Extension[][] = [];
  const docs = new Docs(
    (rel, doc, extra) => {
      seen.push(extra);
      return createState(rel, doc, extra);
    },
    (base) => [EditorState.readOnly.of(base.length > 1000)]
  );

  const d = docs.open("src/a.ts", "old\n", "new\n");
  assert.equal(d.state.doc.toString(), "new\n");
  assert.equal(d.saved, "old\n");
  assert.equal(d.mergeBase, "old\n");
  // The merge extension was handed to the state builder.
  assert.equal(seen[0].length, 2);

  // A proposal identical to the disk content is not a review.
  const same = docs.open("src/b.ts", "same\n", "same\n");
  assert.equal(same.mergeBase, null);
  assert.equal(seen[1].length, 1);

  // Leaving review mode is a field, not a rebuild.
  docs.setMergeBase("src/a.ts", null);
  assert.equal(docs.get("src/a.ts")!.mergeBase, null);
});

test("reopening a file keeps its unsaved work", () => {
  const docs = new Docs(createState);
  const a = docs.open("a.txt", "one");
  const view: FakeView = { state: a.state };
  typeAt(view, 3, " edited");
  docs.capture(view);

  const reopened = docs.open("a.txt", "one");
  assert.equal(reopened.state.doc.toString(), "one edited");
  assert.equal(docs.tabs.length, 1);
});

test("closing a tab focuses the neighbour on the left", () => {
  const docs = new Docs(createState);
  docs.open("a.txt", "a");
  docs.open("b.txt", "b");
  docs.open("c.txt", "c");
  docs.activate("b.txt");

  docs.close("b.txt");
  assert.deepEqual(docs.tabs, ["a.txt", "c.txt"]);
  assert.equal(docs.activeRel(), "a.txt");

  docs.close("a.txt");
  assert.equal(docs.activeRel(), "c.txt");
  docs.close("c.txt");
  assert.equal(docs.activeRel(), null);
  assert.equal(docs.active(), null);
  assert.equal(docs.size, 0);
});

test("closeAll empties the registry, for a change of workspace", () => {
  const docs = new Docs(createState);
  docs.open("a.txt", "a");
  docs.open("b.txt", "b");
  docs.closeAll();
  assert.equal(docs.size, 0);
  assert.deepEqual(docs.tabs, []);
  assert.equal(docs.activeRel(), null);
  assert.equal(docs.list().length, 0);
});

test("each document has its own write chain", async () => {
  const docs = new Docs(createState);
  docs.open("a.txt", "a");
  docs.open("b.txt", "b");

  const order: string[] = [];
  let releaseA: () => void = () => {};
  const blocked = new Promise<void>((r) => (releaseA = r));

  const a1 = docs.queueWrite("a.txt", async () => {
    await blocked;
    order.push("a1");
  });
  const a2 = docs.queueWrite("a.txt", async () => {
    order.push("a2");
  });
  const b1 = docs.queueWrite("b.txt", async () => {
    order.push("b1");
  });

  // B does not wait for A: the chains are independent.
  await b1;
  assert.deepEqual(order, ["b1"]);
  releaseA();
  await Promise.all([a1, a2]);
  assert.deepEqual(order, ["b1", "a1", "a2"]);

  // A failing write does not wedge the chain behind it.
  const failed = docs.queueWrite("a.txt", async () => {
    throw new Error("disk full");
  });
  await failed.catch(() => {});
  await docs.queueWrite("a.txt", async () => {
    order.push("a3");
  });
  assert.deepEqual(order, ["b1", "a1", "a2", "a3"]);
});

test("a file the backend refused still gets a tab and is never dirty", () => {
  const docs = new Docs(createState);
  docs.openError("bin/blob", "binary file");
  assert.deepEqual(docs.tabs, ["bin/blob"]);
  assert.equal(docs.get("bin/blob")!.error, "binary file");
  assert.equal(docs.isDirty("bin/blob"), false);
});

test("capture carries the scroll position, which lives in the view", () => {
  const docs = new Docs(createState);
  const a = docs.open("a.txt", "one");
  docs.open("b.txt", "two");
  assert.equal(a.scroll, null);

  // What EditorView.scrollSnapshot() hands back is an opaque StateEffect; the
  // registry only has to store it and give it back on the way in.
  const snapshot = { effect: "scrollTarget" } as any;
  docs.capture({ state: a.state }, snapshot);
  assert.equal(docs.get("a.txt")!.scroll, snapshot);
  assert.equal(docs.get("b.txt")!.scroll, null);

  // A capture without a snapshot leaves the stored one alone.
  docs.capture({ state: docs.get("a.txt")!.state });
  assert.equal(docs.get("a.txt")!.scroll, snapshot);
});
