/**
 * What became of the workspace this session was supposed to reopen.
 *
 * Three outcomes, not two, and the third is the reason this file grew a type.
 * A folder that has been deleted or lives on a volume nobody plugged back in is
 * gone, and holding a pointer to it would strand the whole Code view on a
 * splash screen forever. A folder the backend merely could not READ this time
 * is not gone: macOS refuses an app the Desktop, the Documents folder and the
 * Downloads folder until someone grants it, and the answer to that is a
 * sentence and a settings pane, not the quiet destruction of a choice the user
 * made once and expected to keep.
 *
 * Treating the second as the first is what made the Code view arrive with its
 * three tabs on one launch and with the folder picker on the next, from the
 * same install, with nothing said either way.
 */
export type RootProbe = "usable" | "gone" | "unreadable";

export interface RestoredRoot {
  /** The path to reopen, or null when there is nothing to reopen. */
  root: string | null;
  /** Whether the stored pointer should be erased. Only a vanished folder is. */
  forget: boolean;
  /** Set when the folder is there but could not be read this time. */
  unreadable: boolean;
}

/**
 * Resolve a persisted Code workspace against what the backend can see of it.
 *
 * The trailing-slash trimming stays: a path chosen from a native panel arrives
 * with one and the same folder would otherwise compare unequal to itself.
 */
export async function resolveRestoredRoot(
  saved: string | undefined,
  probe: (candidate: string) => Promise<RootProbe>,
): Promise<RestoredRoot> {
  if (!saved?.trim()) return { root: null, forget: false, unreadable: false };
  const trimmed = saved.trim();
  const candidate = trimmed === "/" ? "/" : trimmed.replace(/\/+$/, "");
  const verdict = await probe(candidate);
  if (verdict === "usable") return { root: candidate, forget: false, unreadable: false };
  if (verdict === "gone") return { root: null, forget: true, unreadable: false };
  // Unreadable: keep the pointer, open nothing, and let the caller say why.
  return { root: null, forget: false, unreadable: true };
}

/**
 * Read a backend error and decide whether the folder is gone or just closed to
 * us right now.
 *
 * The distinction comes from the message because that is all there is: the
 * command returns a string. "Operation not permitted" is macOS withholding a
 * protected folder, and it is the one that used to erase the workspace.
 */
export function classifyRootError(message: string): RootProbe {
  const text = message.toLowerCase();
  if (
    text.includes("not permitted") ||
    text.includes("permission denied") ||
    text.includes("denied")
  ) {
    return "unreadable";
  }
  return "gone";
}
