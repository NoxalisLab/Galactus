import { resolveRestoredRoot } from "../../src/code/restored-root.js";

const NODE_TEST = "node:test";
const NODE_ASSERT = "node:assert/strict";
const { test } = (await import(NODE_TEST)) as {
  test: (name: string, fn: () => unknown) => void;
};
const assert = ((await import(NODE_ASSERT)) as { default: any }).default;

test("a vanished saved workspace is rejected before IDE services start", async () => {
  const result = await resolveRestoredRoot("/private/tmp/vanished-workspace", async () => false);

  assert.equal(result, null);
});

test("an existing saved workspace is restored with trailing slashes removed", async () => {
  const checked: string[] = [];
  const result = await resolveRestoredRoot("/Volumes/Work/project///", async (candidate: string) => {
    checked.push(candidate);
    return true;
  });

  assert.equal(result, "/Volumes/Work/project");
  assert.deepEqual(checked, ["/Volumes/Work/project"]);
});
