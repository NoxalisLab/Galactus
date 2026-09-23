/**
 * Keeping a saved thread replayable.
 *
 * Its own module so the Node test runner can reach it: agent.ts pulls in the
 * Tauri bridge and the DOM. Same reason sensitive.ts lives apart.
 */

/**
 * The shape this module needs, structurally compatible with the wire type.
 *
 * Declared here rather than imported so the Node test runner can load this
 * file: api.ts pulls in the Tauri bridge. `content` is nullable because that is
 * what the wire says, and an assistant message that only calls tools carries no
 * text at all, which is exactly the message this pairs with its answers.
 */
export interface ToolCallLike {
  id?: string;
  /** Optional here so a test can build a call without it; the wire always has it. */
  function?: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCallLike[];
  tool_call_id?: string;
}

/**
 * Marks the message that carries the condensed earlier history.
 *
 * WHY THE SUMMARY IS A MESSAGE AND NOT PART OF THE SYSTEM PROMPT. It used to be
 * appended to the prompt, and the prompt is the first thing the engine
 * tokenises: changing it moves the point where the KV cache diverges back to
 * token zero, so every turn after the first compaction re-read the system
 * prompt and all 25 tool schemas, eight to nine thousand tokens, at the 171
 * tokens a second measured on this machine, about a minute of nothing. As its
 * own message right after the prompt, the cached block survives and only what
 * genuinely changed is re-read.
 *
 * A `user` message rather than a second `system` one: many chat templates only
 * render a system role in first position and quietly drop or mis-render one in
 * the middle, and a summary that silently disappears is worse than none.
 */
export const SUMMARY_MARK = "[Earlier in this conversation]";

/** The carrier for a given summary. Always the same bytes for the same text. */
export function summaryMessage<T extends ChatMessage>(summary: string): T {
  return {
    role: "user",
    content:
      SUMMARY_MARK +
      " Faithful summary of the EARLIER part of this conversation (auto-condensed to keep " +
      "the context clean; treat as established facts, do not re-derive or embellish them, " +
      "and do not reply to this message):\n" +
      summary.trim(),
  } as T;
}

/** True for the carrier and nothing else. */
export function isSummaryMessage(m: ChatMessage | undefined): boolean {
  return (
    !!m && m.role === "user" && typeof m.content === "string" && m.content.startsWith(SUMMARY_MARK)
  );
}

/** Where the carrier sits, or -1. It is always index 1 when present. */
export function summaryIndex(messages: ChatMessage[]): number {
  return isSummaryMessage(messages[1]) ? 1 : -1;
}

/**
 * First index that is actual conversation: past the system prompt, and past the
 * carrier when there is one. Compaction counts from here so it never folds the
 * summary back into itself, which would lose a little more of the original on
 * every pass.
 */
export function liveFrom(messages: ChatMessage[]): number {
  return summaryIndex(messages) >= 0 ? 2 : 1;
}

/**
 * Put the carrier at index 1, or refresh the one already there. Mutates.
 *
 * Refreshing rather than inserting is what keeps a long conversation from
 * stacking one carrier per compaction.
 */
export function placeSummary<T extends ChatMessage>(messages: T[], summary: string): void {
  if (!summary.trim()) return;
  const msg = summaryMessage<T>(summary);
  if (summaryIndex(messages) >= 0) messages[1] = msg;
  else messages.splice(1, 0, msg);
}

/**
 * The thread without any carrier, for a reload that will place a fresh one.
 *
 * A saved thread already holds the carrier, because `history()` returns the
 * messages as they stand. Replaying it AND placing a new one would put the
 * earlier part of the conversation in twice; the stored summary is the source
 * of truth, so the old carrier goes.
 */
export function stripSummary<T extends ChatMessage>(messages: T[]): T[] {
  return messages.filter((m) => !isSummaryMessage(m));
}

/**
 * A thread with no half-finished tool round in it.
 *
 * A conversation can be written to disk mid-turn: the app saves on a timer, on
 * a conversation switch and on quit. What lands is then an assistant message
 * announcing tool calls whose results are not there yet, or a tool result whose
 * announcement was trimmed by an older digest. Both are rejected by the
 * engine's chat template, so the conversation reopens and refuses to answer.
 *
 * digestHistory already applies this rule when it trims; it was missing at the
 * one place where the messages come from a file somebody may have edited, or
 * from a version that wrote them differently.
 */
export function wholeTurnsOnly<T extends ChatMessage>(messages: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const calls = m.tool_calls;
    if (m.role === "assistant" && calls?.length) {
      // An announcement with no usable id cannot be paired with anything, so
      // it cannot be proved complete. It goes, with whatever follows it.
      const ids = new Set(calls.map((c) => c.id).filter((id): id is string => !!id));
      let j = i + 1;
      const answers: T[] = [];
      // Only the answers that belong to THIS announcement. Absorbing every
      // consecutive tool message kept the orphans sitting behind a complete
      // round: the ids were covered, so the whole run was pushed, orphans
      // included, and the engine rejected the thread on the first reply.
      while (j < messages.length && messages[j].role === "tool") {
        const id = messages[j].tool_call_id;
        if (!id || !ids.has(id)) break;
        ids.delete(id);
        answers.push(messages[j]);
        j++;
      }
      if (ids.size > 0 || calls.length !== answers.length) {
        // Incomplete, or announced without ids: drop the announcement and the
        // partial answers with it, then carry on from the same place so a
        // following orphan is judged on its own.
        i = j - 1;
        continue;
      }
      out.push(m, ...answers);
      i = j - 1;
      continue;
    }
    // A tool result with nothing that asked for it.
    if (m.role === "tool") continue;
    out.push(m);
  }
  return out;
}

// ---------------------------------------------------------------- compaction

/**
 * Index of the message that opened the turn in flight: the last user message
 * that is not the condensed-history carrier. -1 when there is none.
 */
export function lastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && !isSummaryMessage(m)) return i;
  }
  return -1;
}

/**
 * Where to cut the thread for a digest: `messages[live, cut)` is folded into
 * the summary and `messages[cut..]` is kept verbatim. Null when there is
 * nothing that may be folded.
 *
 * THE INVARIANT. The turn in flight (the user's last message and every tool
 * call and result that followed it) is never folded. The carrier tells the
 * model "do not reply to this message", so a question that lands in it is a
 * question the model is told to ignore: it answered with a summary instead of
 * an answer, reproduced on the second turn of a conversation that used one
 * tool on an 8192-token slot. The cut is therefore capped at that message.
 *
 * Within that cap it still takes the oldest ~60%, and never leaves the kept
 * part starting on a tool result whose announcing assistant was folded away:
 * the engine rejects an orphaned tool result. A user message is always a clean
 * boundary, which is why walking forward stops at the cap at the latest.
 */
export function digestCut(messages: ChatMessage[]): number | null {
  const live = liveFrom(messages);
  const last = lastUserIndex(messages);
  const cap = last >= live ? last : messages.length;
  let cut = Math.min(live + Math.floor((messages.length - live) * 0.6), cap);
  while (cut < cap && messages[cut].role === "tool") cut++;
  return cut > live ? cut : null;
}

/** Characters a message costs on the wire, with the per-message overhead the budget uses. */
export function messageChars(m: ChatMessage): number {
  let chars = (typeof m.content === "string" ? m.content.length : 0) + 20;
  if (m.tool_calls) {
    for (const tc of m.tool_calls) {
      chars += (tc.function?.name.length ?? 0) + (tc.function?.arguments.length ?? 0) + 30;
    }
  }
  return chars;
}

/** Sum of `messageChars` over a slice. */
export function charsOf(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) n += messageChars(m);
  return n;
}

/** Share of the window at which the thread is proactively digested. */
export const DIGEST_AT = 0.75;

/**
 * Below this share of the window left to the conversation itself, once the
 * fixed prompt is paid, compaction cannot help and is not attempted.
 *
 * A quarter of the window: the carried summary alone may take 12% of it (see
 * digestHistory), and one exchange with a tool result needs the rest. Under
 * that, every turn would trigger a digest that frees nothing durable, a model
 * call per turn spent on summarising two lines.
 */
export const MIN_ROOM_SHARE = 0.25;

/** Foldable history under this many tokens is not worth a summarisation call. */
export const MIN_FOLD_TOKENS = 200;

export interface ContextBudget {
  /** Window of one slot, in tokens. */
  ctx: number;
  /** System prompt plus tool schemas: what no compaction can shrink. */
  fixedTokens: number;
  /** Everything else: carrier, earlier turns, the turn in flight. */
  historyTokens: number;
  /** The part of history a digest may fold (before the turn in flight). */
  foldableTokens: number;
}

export type CompactionDecision =
  /** Under the threshold: nothing to do. */
  | "fits"
  /** Over it, and there is enough earlier history to be worth folding. */
  | "digest"
  /** Over it, but what is over is the turn in flight, which is never folded. */
  | "nothing-to-fold"
  /** The fixed prompt leaves the conversation too little room for any summary to help. */
  | "window-too-small";

/**
 * Whether to digest before sending, judged on the part of the request that a
 * digest can actually shrink.
 *
 * The old test was `total > 75% of the window`. With the system prompt and the
 * tool schemas already near that line on an 8192-token slot, it fired from the
 * second turn on, whatever the conversation held, and kept firing every turn.
 */
export function compactionDecision(b: ContextBudget): CompactionDecision {
  const trigger = Math.floor(b.ctx * DIGEST_AT);
  const room = trigger - b.fixedTokens;
  if (room < b.ctx * MIN_ROOM_SHARE) return "window-too-small";
  if (b.historyTokens <= room) return "fits";
  if (b.foldableTokens < MIN_FOLD_TOKENS) return "nothing-to-fold";
  return "digest";
}
