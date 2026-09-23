// Compaction must never swallow the question being answered.
//
// Found in a real run: a server at --ctx-size 16384 --parallel 2 gives each
// slot 8192 tokens, the system prompt and tool schemas already sit near the
// 75% line, so the second turn of a conversation was digested. The cut took
// 60% of [user, assistant, USER, assistant(tool_calls), tool] and landed on
// the assistant, which put the user's live question inside the carrier that
// says "do not reply to this message". The model answered with a summary.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import {
  type ChatMessage,
  MIN_FOLD_TOKENS,
  charsOf,
  compactionDecision,
  digestCut,
  lastUserIndex,
  placeSummary,
} from "../../src/agent-history.js";

const sys = (c: string): ChatMessage => ({ role: "system", content: c });
const user = (c: string): ChatMessage => ({ role: "user", content: c });
const bot = (c: string): ChatMessage => ({ role: "assistant", content: c });
const call = (id: string): ChatMessage => ({
  role: "assistant",
  content: "",
  tool_calls: [{ id, function: { name: "list_directory", arguments: '{"path":"docs"}' } }],
});
const result = (id: string, c = "a.md\nb.md"): ChatMessage => ({ role: "tool", tool_call_id: id, content: c });

/** The kept part, as the agent rebuilds it: everything from the cut on. */
const kept = (msgs: ChatMessage[], cut: number) => msgs.slice(cut);

test("the reproduced case: the live question stays out of the summary", () => {
  const msgs = [
    sys("S"),
    user("Réponds juste: bonjour"),
    bot("bonjour"),
    user("Liste les fichiers du dossier docs avec un outil"),
    call("c1"),
    result("c1"),
  ];
  const cut = digestCut(msgs);
  assert.equal(cut, 3);
  assert.equal(kept(msgs, cut!)[0].content, "Liste les fichiers du dossier docs avec un outil");
  // The tool round of the turn in flight is kept whole, in order.
  assert.deepEqual(kept(msgs, cut!).map((m) => m.role), ["user", "assistant", "tool"]);
});

test("the invariant holds on every prefix of a long tool-heavy thread", () => {
  const msgs: ChatMessage[] = [sys("S")];
  for (let turn = 0; turn < 6; turn++) {
    msgs.push(user(`question ${turn}`));
    for (let r = 0; r < turn % 3; r++) {
      msgs.push(call(`c${turn}${r}`), result(`c${turn}${r}`));
    }
    msgs.push(bot(`answer ${turn}`));
  }
  for (let n = 2; n <= msgs.length; n++) {
    const prefix = msgs.slice(0, n);
    const cut = digestCut(prefix);
    if (cut === null) continue;
    const last = lastUserIndex(prefix);
    assert.ok(cut <= last, `prefix ${n}: cut ${cut} passed the last user message ${last}`);
    assert.notEqual(prefix[cut].role, "tool", `prefix ${n}: kept part starts on an orphan tool result`);
  }
});

test("a thread whose only user message is the live one has nothing to fold", () => {
  const msgs = [sys("S"), user("fais-le"), call("a"), result("a"), call("b"), result("b"), call("c"), result("c")];
  assert.equal(digestCut(msgs), null);
});

test("the carrier is neither folded again nor mistaken for the live question", () => {
  const msgs = [sys("S"), user("q1"), bot("a1"), user("q2"), bot("a2"), user("q3"), call("x"), result("x")];
  placeSummary(msgs, "- earlier facts");
  assert.equal(lastUserIndex(msgs), 6);
  const cut = digestCut(msgs);
  assert.ok(cut !== null && cut > 2 && cut <= 6);
});

test("a thread with no user message at all keeps the old 60% rule", () => {
  const msgs = [sys("S"), bot("a"), bot("b"), bot("c"), bot("d"), bot("e")];
  assert.equal(digestCut(msgs), 1 + 3);
});

test("tool calls count toward the character budget", () => {
  const plain = charsOf([bot("")]);
  assert.ok(charsOf([call("c")]) > plain);
});

// ---------------------------------------------------------------- decision

test("a fixed prompt near the threshold is reported, not digested every turn", () => {
  // 8192-token slot, ~5400 tokens of prompt and schemas: 6144 - 5400 = 744
  // tokens left, under a quarter of the window.
  const d = compactionDecision({ ctx: 8192, fixedTokens: 5400, historyTokens: 900, foldableTokens: 400 });
  assert.equal(d, "window-too-small");
});

test("the same prompt on a 16384 slot compacts normally", () => {
  const b = { ctx: 16384, fixedTokens: 5400, foldableTokens: 3000 };
  assert.equal(compactionDecision({ ...b, historyTokens: 2000 }), "fits");
  assert.equal(compactionDecision({ ...b, historyTokens: 7000 }), "digest");
});

test("the threshold is measured on history, not on the whole request", () => {
  // Total 3000 + 1300 = 4300, under the old trigger too; the case that
  // matters is the next one, where the total is over it but history is not.
  assert.equal(compactionDecision({ ctx: 8192, fixedTokens: 3000, historyTokens: 1300, foldableTokens: 800 }), "fits");
  // 4000 + 2100 = 6100 is under 6144, fits; 4000 + 2200 is over, and there is
  // earlier history worth folding.
  assert.equal(compactionDecision({ ctx: 8192, fixedTokens: 4000, historyTokens: 2100, foldableTokens: 800 }), "fits");
  assert.equal(compactionDecision({ ctx: 8192, fixedTokens: 4000, historyTokens: 2200, foldableTokens: 800 }), "digest");
});

test("when what overflows is the turn in flight, nothing is folded", () => {
  const d = compactionDecision({
    ctx: 16384,
    fixedTokens: 5000,
    historyTokens: 9000,
    foldableTokens: MIN_FOLD_TOKENS - 1,
  });
  assert.equal(d, "nothing-to-fold");
});
