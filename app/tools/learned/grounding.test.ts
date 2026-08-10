// A skill must be written from the transcript, not from the model's account
// of itself.
//
// This is the difference between "here is what happened" and "here is what I
// meant to do". A model asked to summarize its own work will add the step it
// wishes it had taken, and that step is precisely the one that was never run,
// never gated and never verified. Once it is in a skill file it is re-proposed
// forever, and it looks exactly as authoritative as the four steps that are
// real.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { commandsAreGrounded, ranCommands, renderTranscript } from "../../src/learned.js";

const RAN = ["npm test", "git diff --stat", "npx tsc --noEmit -p tsconfig.json"];

function body(...cmds: string[]): string {
  return cmds.map((c) => "```\n" + c + "\n```\n").join("\n");
}

test("commands that were really run are grounded", () => {
  const g = commandsAreGrounded(body("npm test", "git diff --stat"), RAN);
  assert.equal(g.ok, true);
});

test("a command the agent never ran is refused", () => {
  const g = commandsAreGrounded(body("npm test", "npm publish"), RAN);
  assert.equal(g.ok, false);
  assert.deepEqual(g.ungrounded, ["npm publish"]);
});

test("a placeholder generalizes a path without ungrounding the line", () => {
  // Replacing this task's file with <file> is the whole point of a reusable
  // procedure, so a hole must not read as an invention.
  const g = commandsAreGrounded(body("npx tsc --noEmit -p <tsconfig>"), RAN);
  assert.equal(g.ok, true);
});

test("pieces of two real commands cannot be stitched into a third", () => {
  // The subtle case. Every token below appears somewhere in RAN, but not in
  // one single command, and "npm publish --stat" is not something that ran.
  // Grounding is per command for exactly this reason.
  const g = commandsAreGrounded(body("npm --noEmit --stat"), RAN);
  assert.equal(g.ok, false);
});

test("a line of pure placeholders proves nothing and is ignored", () => {
  const g = commandsAreGrounded(body("<your build command>"), RAN);
  assert.equal(g.ok, true);
});

test("only the shell steps that succeeded are offered as grounding", () => {
  // A failed command is part of the story, not part of the recipe. Letting it
  // ground a skill line would put a command that did not work into the
  // procedure with the same confidence as one that did.
  const cmds = ranCommands([
    { tool: "run_command", detail: "npm test", ok: true, denied: false },
    { tool: "run_command", detail: "npm run buidl", ok: false, denied: false },
    { tool: "read_file", detail: "/p/a", ok: true, denied: false },
  ]);
  assert.deepEqual(cmds, ["npm test"]);
});

test("the transcript handed to the authoring call is the steps, not the prose", () => {
  const text = renderTranscript([
    { tool: "update_plan", detail: "{}", ok: true, denied: false },
    { tool: "run_command", detail: "npm test", ok: true, denied: false },
    { tool: "run_command", detail: "npm run buidl", ok: false, denied: false },
  ]);
  assert.equal(text.includes("update_plan"), false);
  assert.equal(text.includes("1. run_command: npm test"), true);
  assert.equal(text.includes("(FAILED)"), true);
});
