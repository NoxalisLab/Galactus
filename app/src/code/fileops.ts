/**
 * Where a created or renamed entry lands, as plain path arithmetic.
 *
 * Pure on purpose: the interesting cases are all about the workspace root, and
 * a leading slash there is the difference between "notes.md at the top of the
 * project" and an absolute path the backend will refuse.
 */

/** The folder a new entry belongs in, given what was right-clicked. */
export function targetDir(rel: string | null, isDir: boolean): string {
  if (!rel) return "";
  if (isDir) return rel;
  const cut = rel.lastIndexOf("/");
  return cut < 0 ? "" : rel.slice(0, cut);
}

/** Join a folder and a name without producing a leading slash at the root. */
export function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** The folder a path sits in: "" for a top-level entry. */
export function dirOf(rel: string): string {
  const cut = rel.lastIndexOf("/");
  return cut < 0 ? "" : rel.slice(0, cut);
}

/** The last segment of a path. */
export function nameOf(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1);
}

/** Where a rename puts the entry: same folder, new name. */
export function renameTarget(rel: string, newName: string): string {
  return joinRel(dirOf(rel), newName);
}
