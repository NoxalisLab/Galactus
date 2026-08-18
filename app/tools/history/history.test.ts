// A conversation written mid-turn must still open.
//
// The app saves on a timer, on a conversation switch and on quit, so the file
// regularly ends on an assistant message whose tool results are not there yet.
// The engine's chat template rejects that outright: the conversation reopens
// and refuses to answer, with nothing explaining why.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { wholeTurnsOnly } from "../../src/agent-history.js";

const user = (text: string) => ({ role: "user" as const, content: text });
const assistant = (content: string) => ({ role: "assistant" as const, content });
const calling = (...ids: string[]) => ({
  role: "assistant" as const,
  content: "",
  tool_calls: ids.map((id) => ({ id, type: "function", function: { name: "x", arguments: "{}" } })),
});
const answer = (id: string) => ({ role: "tool" as const, content: "ok", tool_call_id: id });

test("a complete tool round survives untouched", () => {
  const thread = [user("hi"), calling("a", "b"), answer("a"), answer("b"), assistant("done")];
  assert.deepEqual(wholeTurnsOnly(thread), thread);
});

test("an announcement whose answers never arrived is dropped", () => {
  // Exactly what a save 1500 ms into a tool call writes.
  const kept = wholeTurnsOnly([user("hi"), calling("a")]);
  assert.deepEqual(kept, [user("hi")]);
});

test("a partial round is dropped whole, not half kept", () => {
  const kept = wholeTurnsOnly([user("hi"), calling("a", "b"), answer("a")]);
  assert.deepEqual(kept, [user("hi")], "keeping answer(a) alone is just as invalid");
});

test("an orphan tool result is dropped", () => {
  // What an older digest leaves when it trims the announcement away.
  const kept = wholeTurnsOnly([user("hi"), answer("gone"), assistant("hello")]);
  assert.deepEqual(kept, [user("hi"), assistant("hello")]);
});

test("ordinary conversations are not touched", () => {
  const thread = [user("a"), assistant("b"), user("c"), assistant("d")];
  assert.deepEqual(wholeTurnsOnly(thread), thread);
  assert.deepEqual(wholeTurnsOnly([]), []);
});

test("an orphan sitting behind a complete round is still dropped", () => {
  // The loop absorbed every consecutive tool message as an "answer": once the
  // announced ids were covered it pushed the whole run, orphans included, and
  // the engine rejected the thread on the first reply.
  const kept = wholeTurnsOnly([user("hi"), calling("a"), answer("a"), answer("stray"), assistant("done")]);
  assert.deepEqual(kept, [user("hi"), calling("a"), answer("a"), assistant("done")]);
});

test("an announcement with no ids cannot be proved complete, so it goes", () => {
  // Nothing can be paired with it. Keeping it means keeping an assistant
  // message whose tool_calls will never be answered.
  const noId = { role: "assistant" as const, content: "", tool_calls: [{ type: "function" }] };
  assert.deepEqual(wholeTurnsOnly([user("hi"), noId as never, answer("x")]), [user("hi")]);
});

test("two complete rounds in a row both survive", () => {
  const thread = [user("hi"), calling("a"), answer("a"), calling("b"), answer("b"), assistant("done")];
  assert.deepEqual(wholeTurnsOnly(thread), thread);
});
