/**
 * The order tool calls are run in, and which of them may overlap.
 *
 * Every call used to be awaited in turn. That is right for almost all of them:
 * two writes, or a write and a read of one path, racing each other would be a
 * real bug, and the workspace is shared by everything the agent does.
 *
 * It is wrong for exactly one kind of call. A teammate works on its own thread,
 * on its own files, and says nothing to the others until it returns: three of
 * them asked one after another take three times as long to produce work that
 * never interacted. Delegation is also where the wait is most visible, because
 * a teammate's turn is a whole model turn of its own.
 *
 * Extracted here, away from the Agent, because the interesting property is a
 * scheduling one and can be stated without a model, a port or a workspace: given
 * a list and a runner, which calls overlap and in what order do the results come
 * back. That is what the tests assert.
 */

/**
 * Run every call, letting consecutive parallelisable ones overlap.
 *
 * Results come back in the ORDER OF THE CALLS, never the order they finished
 * in. The API requires one tool message per tool call, matched by position, so
 * a fast teammate answering before a slow one must not move.
 *
 * `stopped` is consulted between groups, never inside one: a batch already in
 * flight is allowed to finish, because abandoning it would leave teammates
 * running with nobody to receive them.
 */
export async function runToolCalls<T>(
  calls: readonly T[],
  parallel: (call: T) => boolean,
  run: (call: T) => Promise<string>,
  stopped: () => boolean = () => false,
): Promise<{ results: string[]; done: boolean[] }> {
  const results: string[] = new Array(calls.length).fill("");
  const done: boolean[] = new Array(calls.length).fill(false);
  let i = 0;
  while (i < calls.length && !stopped()) {
    if (parallel(calls[i])) {
      let j = i;
      while (j < calls.length && parallel(calls[j])) j += 1;
      const batch = await Promise.all(calls.slice(i, j).map(run));
      batch.forEach((r, k) => {
        results[i + k] = r;
        done[i + k] = true;
      });
      i = j;
    } else {
      results[i] = await run(calls[i]);
      done[i] = true;
      i += 1;
    }
  }
  return { results, done };
}
