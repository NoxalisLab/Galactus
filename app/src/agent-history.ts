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
