// Which tool calls overlap, and in what order their results come back.
//
// WHAT THIS COVERS THAT NOTHING ELSE DID. Every tool call was awaited in turn,
// including delegations. A turn that recruited three teammates therefore ran
// them one after another, each a whole model turn long, to produce work that
// never interacted: the user watched three sequential threads and was told they
// were a team. Nothing in the transcript showed it, because the transcript is
// correct either way, and that is exactly why it went unnoticed.
//
// Overlap is not observable from a result. It is observable from a runner that
// records when it was entered and left, which is what these tests use.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { runToolCalls } from "../../src/toolsched.js";

// @ts-ignore The one Node global these tests need, declared rather than pulling
// in @types/node for a single timer.
declare const setTimeout: (fn: () => void, ms: number) => unknown;

interface Call {
  name: string;
}
const delegation = (c: Call) => c.name === "spawn_agent" || c.name === "ask_agent";

/** A runner that records overlap, and can be made slow per call. */
function recorder(delays: Record<string, number> = {}) {
  let live = 0;
  let peak = 0;
  const order: string[] = [];
  const run = async (c: Call): Promise<string> => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise<void>((r) => setTimeout(() => r(), delays[c.name] ?? 1));
    live -= 1;
    order.push(c.name);
    return `did ${c.name}`;
  };
  return { run, peak: () => peak, order };
}

test("consecutive delegations run at the same time", async () => {
  const rec = recorder();
  const calls: Call[] = [{ name: "spawn_agent" }, { name: "spawn_agent" }, { name: "ask_agent" }];
  await runToolCalls(calls, delegation, rec.run);
  assert.equal(rec.peak(), 3, "three teammates must be in flight together, not one after another");
});

test("anything touching the workspace stays strictly sequential", async () => {
  // The asymmetry is the point. Two writes, or a write and a read of one path,
  // racing each other would be a real bug in a shared folder.
  const rec = recorder();
  const calls: Call[] = [{ name: "write_file" }, { name: "read_file" }, { name: "run_command" }];
  await runToolCalls(calls, delegation, rec.run);
  assert.equal(rec.peak(), 1, "never two at once");
});

test("a delegation between two writes does not let the writes overlap", async () => {
  // Only CONSECUTIVE parallelisable calls form a group: a naive filter would
  // hoist every delegation to the front and run the writes together behind it.
  const rec = recorder();
  const calls: Call[] = [
    { name: "write_file" },
    { name: "spawn_agent" },
    { name: "write_file" },
  ];
  await runToolCalls(calls, delegation, rec.run);
  assert.equal(rec.peak(), 1);
  assert.deepEqual(rec.order, ["write_file", "spawn_agent", "write_file"], "and in order");
});

test("results are in call order, not in finishing order", async () => {
  // The API matches tool results to tool calls by position. A fast teammate
  // answering before a slow one must not move, or the next request is a body
  // the server rejects.
  const rec = recorder({ ask_agent: 30 });
  const calls: Call[] = [{ name: "ask_agent" }, { name: "spawn_agent" }];
  const { results } = await runToolCalls(calls, delegation, rec.run);
  assert.deepEqual(rec.order, ["spawn_agent", "ask_agent"], "the quick one finished first");
  assert.deepEqual(results, ["did ask_agent", "did spawn_agent"], "the results did not");
});

test("a stop leaves the remaining calls unrun and says so", async () => {
  // The caller fills those slots with a placeholder. Without `done` it could
  // not tell an unrun call from one that returned an empty string.
  const rec = recorder();
  let ticks = 0;
  const calls: Call[] = [{ name: "write_file" }, { name: "write_file" }, { name: "write_file" }];
  const { results, done } = await runToolCalls(calls, delegation, rec.run, () => ticks++ >= 1);
  assert.equal(done[0], true, "the first one ran");
  assert.equal(done[2], false, "the last one did not");
  assert.equal(results[2], "", "and left nothing behind");
});

test("a batch already in flight is allowed to finish", async () => {
  // Abandoning it would leave teammates running with nobody to receive them.
  const rec = recorder();
  const calls: Call[] = [{ name: "spawn_agent" }, { name: "spawn_agent" }];
  const { done } = await runToolCalls(calls, delegation, rec.run, () => true);
  assert.deepEqual(done, [false, false], "stopped before the group even started");
});
