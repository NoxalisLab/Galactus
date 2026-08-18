// When the "what changed" screen appears, and what it shows.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { parseNews, shouldShow } from "../../src/whatsnew.js";

test("a first install is never greeted with a changelog", () => {
  // Nothing recorded means nobody has run this app before: "what changed"
  // means nothing to them, and they have enough to read already.
  assert.equal(shouldShow("0.1.18", undefined), false);
  assert.equal(shouldShow("0.1.18", ""), false);
});

test("it shows once after an upgrade, and not again", () => {
  assert.equal(shouldShow("0.1.18", "0.1.17"), true);
  assert.equal(shouldShow("0.1.18", "0.1.18"), false);
});

test("a downgrade still shows: the app is not the one they ran", () => {
  // Rolling back is rare, and silently saying nothing would be worse than a
  // screen naming the version they are now on.
  assert.equal(shouldShow("0.1.17", "0.1.18"), true);
});

test("the sections are the ones a person wants, without the furniture", () => {
  const md = [
    "# Galactus Desktop v0.1.18",
    "",
    "A native macOS app for the engine.",
    "",
    "## Two editors, side by side",
    "",
    "Cmd+backslash sends the file across.",
    "",
    "## Fixed",
    "",
    "The gutter no longer lies.",
    "",
    "## Install",
    "",
    "Download the dmg, drag it to Applications.",
  ].join("\n");
  const news = parseNews("0.1.18", md);
  assert.deepEqual(
    news.sections.map((s) => s.title),
    ["Two editors, side by side", "Fixed"],
    "the title line and the install steps are not news",
  );
  assert.match(news.sections[0].body, /Cmd\+backslash/);
  assert.equal(news.version, "0.1.18");
});

test("notes that are missing or shapeless produce nothing rather than junk", () => {
  assert.deepEqual(parseNews("0.1.18", "").sections, []);
  assert.deepEqual(parseNews("0.1.18", "just a sentence with no headings").sections, []);
  // A heading with nothing under it is not a section.
  assert.deepEqual(parseNews("0.1.18", "## Empty\n\n## Also empty").sections, []);
});
