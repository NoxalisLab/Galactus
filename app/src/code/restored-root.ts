/** Resolve a persisted Code workspace only after the backend can read it. */
export async function resolveRestoredRoot(
  saved: string | undefined,
  isUsableDirectory: (candidate: string) => Promise<boolean>,
): Promise<string | null> {
  if (!saved?.trim()) return null;
  const trimmed = saved.trim();
  const candidate = trimmed === "/" ? "/" : trimmed.replace(/\/+$/, "");
  return (await isUsableDirectory(candidate)) ? candidate : null;
}
