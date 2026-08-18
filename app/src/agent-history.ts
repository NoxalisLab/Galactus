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
