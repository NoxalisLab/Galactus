// The dialog that stands between a click and something that cannot be undone.
//
// It guards three buttons that used to delete on the first click: everything
// the app has learned, a run with its transcript, and a scheduled job. So the
// claims that matter are about REFUSING, not about confirming: every way out
// of this dialog other than the confirm button has to mean no, and each of
// them has to settle the promise, because a dialog that resolves nothing
// leaves the caller waiting forever with the screen already back to normal.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { installDom } from "./env";

installDom();

const { confirmDestructive } = await import("../../src/confirm.js");

function open(): { answer: Promise<boolean>; dialog: HTMLElement } {
  const answer = confirmDestructive({
    title: "Delete this?",
    detail: "It does not come back.",
    confirmLabel: "Delete",
  });
  const dialog = document.querySelector<HTMLElement>(".modal-bd")!;
  assert.ok(dialog, "the dialog is on screen");
  return { answer, dialog };
}

function click(root: HTMLElement, which: "0" | "1"): void {
  root.querySelector<HTMLElement>(`[data-x="${which}"]`)!.dispatchEvent(
    new Event("click", { bubbles: true }),
  );
}

test("the confirm button is the only thing that answers yes", async () => {
  const { answer, dialog } = open();
  click(dialog, "1");
  assert.equal(await answer, true);
  assert.equal(document.querySelector(".modal-bd"), null, "and it closes");
});

test("cancel answers no", async () => {
  const { answer, dialog } = open();
  click(dialog, "0");
  assert.equal(await answer, false);
});

test("escape answers no instead of leaving the caller waiting", async () => {
  // The failure this pins is not a wrong answer, it is NO answer: the dialog
  // disappears and the promise stays pending, so the delete never happens and
  // neither does anything after it.
  const { answer } = open();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(await answer, false);
  assert.equal(document.querySelector(".modal-bd"), null);
});

test("a click on the backdrop answers no, and never yes", async () => {
  const { answer, dialog } = open();
  dialog.dispatchEvent(new Event("click", { bubbles: true }));
  assert.equal(await answer, false);
});

test("it announces itself as a dialog and describes what it is asking", async () => {
  const { answer, dialog } = open();
  const box = dialog.querySelector<HTMLElement>(".modal")!;
  assert.equal(box.getAttribute("role"), "dialog");
  assert.equal(box.getAttribute("aria-modal"), "true");
  // Labelled and described by real elements, not by a string nobody can read.
  const labelled = box.getAttribute("aria-labelledby")!;
  const described = box.getAttribute("aria-describedby")!;
  assert.equal(box.querySelector(`#${labelled}`)!.textContent, "Delete this?");
  assert.equal(box.querySelector(`#${described}`)!.textContent, "It does not come back.");
  click(dialog, "0");
  await answer;
});

test("the destructive button is not the one given focus", async () => {
  // A stray Return key must not delete anything.
  //
  // linkedom has no focus model, so activeElement would answer nothing here.
  // What IS observable is which element the dialog calls focus() on, and that
  // is the decision being tested.
  const asked: Array<string | undefined> = [];
  const proto = (globalThis as any).HTMLElement.prototype;
  const before = proto.focus;
  proto.focus = function (this: HTMLElement) {
    asked.push(this.dataset?.x);
  };
  try {
    const { answer, dialog } = open();
    assert.deepEqual(asked, ["0"], "cancel is focused, and confirm never is");
    click(dialog, "0");
    await answer;
  } finally {
    proto.focus = before;
  }
});

test("the prompt returns what was typed, and null for every refusal", async () => {
  const { promptModal } = await import("../../src/confirm.js");

  const typed = promptModal("New file", "Name it", "name.ts");
  let box = document.querySelector<HTMLElement>(".modal-bd")!;
  box.querySelector<HTMLInputElement>("input")!.value = "  hello.ts  ";
  click(box, "1");
  assert.equal(await typed, "hello.ts", "trimmed, since a trailing space is not a name");

  const cancelled = promptModal("New file", "Name it", "name.ts");
  box = document.querySelector<HTMLElement>(".modal-bd")!;
  click(box, "0");
  assert.equal(await cancelled, null);

  // Escape used to be handled by the input's own listener, so it only worked
  // while the field held the focus. It is the shell's job now.
  const escaped = promptModal("New file", "Name it", "name.ts");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(await escaped, null);

  // An empty field is not an answer either.
  const blank = promptModal("New file", "Name it", "name.ts");
  box = document.querySelector<HTMLElement>(".modal-bd")!;
  box.querySelector<HTMLInputElement>("input")!.value = "   ";
  click(box, "1");
  assert.equal(await blank, null);
});

test("the confirmation the Code view uses can now be dismissed with a key", async () => {
  // confirmModal had no keydown listener at all: once it was up, a keyboard
  // could not get rid of it.
  const { confirmModal } = await import("../../src/confirm.js");
  const answer = confirmModal("Drop them?", "Three pending diffs", "<ul><li>a.ts</li></ul>", "Drop");
  const box = document.querySelector<HTMLElement>(".modal .acts")!;
  assert.ok(box, "the dialog is up");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(await answer, false, "and escaping means no, not an unsettled promise");
});
