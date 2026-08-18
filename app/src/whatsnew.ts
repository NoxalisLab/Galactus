/**
 * What changed since the version the user last ran.
 *
 * WHY IT EXISTS. An update installs and the app restarts looking exactly like
 * before. Everything in this release, the things that were fixed and the things
 * that are new, is invisible unless somebody goes and reads a page on GitHub.
 * A product that improves in silence is a product that is assumed not to.
 *
 * WHEN IT SHOWS. Once, on the first launch of a version the user has not run
 * before, and never on a first install: somebody meeting the app has enough to
 * read already, and "what changed" means nothing to them.
 *
 * The notes come from the bundle, not from the network. The user may have
 * installed from a DMG and never seen a manifest, and after the restart that
 * follows an in-app update there is nothing left to query.
 */

/** One section of the notes: a heading and the lines under it. */
export interface NewsSection {
  title: string;
  body: string;
}

export interface News {
  version: string;
  sections: NewsSection[];
}

/** Whether to show anything at all, given what was last seen. */
export function shouldShow(current: string, lastSeen: string | undefined): boolean {
  if (!current) return false;
  // No record at all is a first install, not an upgrade.
  if (!lastSeen) return false;
  return lastSeen !== current;
}

/**
 * Turn the release notes into sections a person can skim.
 *
 * The file is written for humans already, so this only strips the parts that
 * are furniture: the title line, the standing description of the product, and
 * the install instructions, which the reader has by definition already done.
 */
export function parseNews(version: string, markdown: string): News {
  const sections: NewsSection[] = [];
  let title = "";
  let body: string[] = [];
  const flush = () => {
    const text = body.join("\n").trim();
    if (title && text) sections.push({ title, body: text });
    body = [];
  };
  for (const raw of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const heading = raw.match(/^##\s+(.*)$/);
    if (heading) {
      flush();
      title = heading[1].trim();
      continue;
    }
    if (/^#\s/.test(raw)) continue; // the document title
    if (title) body.push(raw);
  }
  flush();
  // "Install" tells somebody who is already running it how to start.
  const skip = /^(install|installation)$/i;
  return { version, sections: sections.filter((s) => !skip.test(s.title)) };
}
