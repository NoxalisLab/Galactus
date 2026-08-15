// Which saved workspace comes back, and which one is forgotten.
//
// WHAT THIS COVERS THAT NOTHING ELSE DID. The Code view arrived with its three
// tabs on one launch and with the folder picker on the next, from the same
// install, and nothing on screen explained the difference. The probe answered
// yes or no, and every no erased the stored pointer: a folder macOS was merely
// withholding, the Desktop before the app has been granted it, was destroyed as
// thoroughly as one the user had deleted. A permission is granted once; a
// workspace erased for having been unreachable during that one launch is gone
// for good.

const NODE_TEST = "node:test";
const NODE_ASSERT = "node:assert/strict";
const { test } = (await import(NODE_TEST)) as { test: any };
const assert = ((await import(NODE_ASSERT)) as { default: any }).default;

import { classifyRootError, resolveRestoredRoot } from "../../src/code/restored-root.js";

test("a vanished saved workspace is forgotten", async () => {
  const result = await resolveRestoredRoot("/private/tmp/vanished-workspace", async () => "gone");
  assert.equal(result.root, null);
  assert.equal(result.forget, true, "a folder that is gone must not strand the view forever");
});

test("an existing saved workspace is restored with trailing slashes removed", async () => {
  const checked: string[] = [];
  const result = await resolveRestoredRoot("/Volumes/Work/project///", async (c) => {
    checked.push(c);
    return "usable";
  });
  assert.equal(result.root, "/Volumes/Work/project");
  assert.equal(result.forget, false);
  assert.deepEqual(checked, ["/Volumes/Work/project"]);
});

test("a workspace macOS is withholding is kept, not erased", async () => {
  // The whole point. It opens nothing this launch, and it is still there the
  // moment the permission is granted.
  const result = await resolveRestoredRoot("/Users/x/Desktop/site", async () => "unreadable");
  assert.equal(result.root, null, "nothing can be opened right now");
  assert.equal(result.forget, false, "and the choice survives");
  assert.equal(result.unreadable, true, "so the user can be told why");
});

test("nothing saved is not a workspace to forget", async () => {
  for (const saved of [undefined, "", "   "]) {
    const result = await resolveRestoredRoot(saved, async () => "usable");
    assert.equal(result.root, null);
    assert.equal(result.forget, false, "there was nothing to erase");
  }
});

test("a refusal is read as withheld, anything else as gone", async () => {
  // Fail toward "gone" for unknown messages: an app stuck on a splash screen it
  // cannot leave is worse than one that asks for the folder again.
  assert.equal(classifyRootError("Operation not permitted (os error 1)"), "unreadable");
  assert.equal(classifyRootError("Permission denied"), "unreadable");
  assert.equal(classifyRootError("No such file or directory"), "gone");
  assert.equal(classifyRootError("/x is not a directory"), "gone");
});
