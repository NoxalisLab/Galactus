import { ReviewGate, reviewInstruction } from "../../src/code/review-gate.js";

const NODE_TEST = "node:test";
const NODE_ASSERT = "node:assert/strict";
const { test } = (await import(NODE_TEST)) as {
  test: (name: string, fn: () => unknown) => void;
};
const assert = ((await import(NODE_ASSERT)) as { default: any }).default;

test("a proposed edit stays pending until the user resolves its review", async () => {
  const gate = new ReviewGate();
  let settled = false;
  const pending = gate.wait("src/calc.ts").then((outcome) => {
    settled = true;
    return outcome;
  });

  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(gate.has("src/calc.ts"), true);

  assert.equal(gate.resolve("src/calc.ts", "accepted"), true);
  assert.deepEqual(await pending, { rel: "src/calc.ts", decision: "accepted" });
  assert.equal(gate.has("src/calc.ts"), false);
});

test("a rejected review explicitly tells the agent to ask why before rewriting", () => {
  const message = reviewInstruction({ rel: "src/calc.ts", decision: "rejected" });

  assert.match(message, /rejected by the user/i);
  assert.match(message, /ask why/i);
  assert.match(message, /do not propose another edit/i);
});

test("partial acceptance is distinct from approval and requires clarification", () => {
  const message = reviewInstruction({ rel: "src/calc.ts", decision: "partial" });

  assert.match(message, /partially accepted/i);
  assert.match(message, /ask which remaining changes/i);
});

test("discarding a workspace unblocks every waiting proposal", async () => {
  const gate = new ReviewGate();
  const first = gate.wait("a.ts");
  const second = gate.wait("b.ts");

  assert.deepEqual(gate.resolveAll("discarded"), ["a.ts", "b.ts"]);
  assert.deepEqual(await first, { rel: "a.ts", decision: "discarded" });
  assert.deepEqual(await second, { rel: "b.ts", decision: "discarded" });
});
