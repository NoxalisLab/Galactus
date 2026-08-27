// The condensed-history carrier, and the one property it exists for: the
// system prompt must stop changing when a conversation is compacted.
//
// Before this, the summary was appended to the system prompt. Every compaction
// therefore rewrote token zero, so the engine threw away its cache of the
// prompt AND of the 25 tool schemas behind it — eight to nine thousand tokens
// re-read on every later turn at the 171 tokens a second this machine measures.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import {
  type ChatMessage,
  SUMMARY_MARK,
  isSummaryMessage,
  liveFrom,
  placeSummary,
  stripSummary,
  summaryIndex,
  summaryMessage,
} from "../../src/agent-history.js";

const sys = (c: string): ChatMessage => ({ role: "system", content: c });
const user = (c: string): ChatMessage => ({ role: "user", content: c });
const bot = (c: string): ChatMessage => ({ role: "assistant", content: c });

test("a thread with no summary starts live at 1", () => {
  const msgs = [sys("S"), user("bonjour"), bot("salut")];
  assert.equal(summaryIndex(msgs), -1);
  assert.equal(liveFrom(msgs), 1);
});

test("the carrier goes right after the system prompt", () => {
  const msgs = [sys("S"), user("bonjour"), bot("salut")];
  placeSummary(msgs, "the user asked about invoices");
  assert.equal(summaryIndex(msgs), 1);
  assert.equal(liveFrom(msgs), 2);
  assert.equal(msgs[0].content, "S", "the system prompt is untouched");
  assert.equal(msgs[2].content, "bonjour", "the conversation follows, in order");
  assert.equal(msgs.length, 4);
});

test("compacting twice REFRESHES the carrier, it does not stack them", () => {
  const msgs = [sys("S"), user("un"), bot("deux")];
  placeSummary(msgs, "first");
  const afterOne = msgs.length;
  placeSummary(msgs, "first\nsecond");
  assert.equal(msgs.length, afterOne, "still one carrier");
  assert.equal(msgs.filter(isSummaryMessage).length, 1);
  assert.match(msgs[1].content!, /first\nsecond$/);
});

test("the system prompt is never rewritten by a summary", () => {
  // The whole point. Whatever the summary says, message zero is the same bytes.
  const prompt = "You are Galactus. …8000 tokens of tools…";
  const msgs = [sys(prompt), user("un")];
  placeSummary(msgs, "a");
  placeSummary(msgs, "a\nb");
  placeSummary(msgs, "a\nb\nc");
  assert.equal(msgs[0].content, prompt);
});

test("an empty summary places nothing", () => {
  const msgs = [sys("S"), user("un")];
  placeSummary(msgs, "   ");
  assert.equal(summaryIndex(msgs), -1);
  assert.equal(msgs.length, 2);
});

test("the same summary always produces the same bytes", () => {
  // A carrier that varied — a timestamp, a counter — would move the cache
  // divergence point on every turn instead of only on a compaction.
  assert.equal(summaryMessage("x").content, summaryMessage("x").content);
  assert.notEqual(summaryMessage("x").content, summaryMessage("y").content);
});

test("a carrier is recognisable and an ordinary user turn is not", () => {
  assert.equal(isSummaryMessage(summaryMessage("x")), true);
  assert.equal(isSummaryMessage(user("bonjour")), false);
  assert.equal(isSummaryMessage(user(`je cite ${SUMMARY_MARK} au milieu`)), false);
  assert.equal(isSummaryMessage(bot(SUMMARY_MARK + " …")), false, "role matters");
  assert.equal(isSummaryMessage(undefined), false);
});

test("reloading a saved thread does not duplicate the earlier history", () => {
  // history() returns the messages as they stand, carrier included. Replaying
  // that AND placing a fresh one would state the earlier conversation twice.
  const saved = [sys("S"), summaryMessage<ChatMessage>("older facts"), user("un"), bot("deux")];
  const body = stripSummary(saved.filter((m) => m.role !== "system"));
  const reloaded: ChatMessage[] = [sys("S rebuilt"), ...body];
  placeSummary(reloaded, "older facts");
  assert.equal(reloaded.filter(isSummaryMessage).length, 1);
  assert.deepEqual(
    reloaded.map((m) => m.role),
    ["system", "user", "user", "assistant"]
  );
  assert.equal(reloaded[2].content, "un", "the real conversation is intact");
});

test("a carrier found anywhere in a saved thread is stripped", () => {
  const odd = [user("un"), summaryMessage<ChatMessage>("s"), bot("deux")];
  assert.deepEqual(stripSummary(odd).map((m) => m.content), ["un", "deux"]);
});
