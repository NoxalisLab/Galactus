// Where a created, renamed or deleted entry lands. The backend owns confinement
// and the trash; this is the path arithmetic around them, and the interesting
// cases are all at the workspace root.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { dirOf, joinRel, nameOf, renameTarget, targetDir } from "../../src/code/fileops.js";

test("a new entry lands beside a file, and inside a folder", () => {
  assert.equal(targetDir("src/main.ts", false), "src");
  assert.equal(targetDir("src", true), "src");
  // Right-click on a top-level file: the root, not "/".
  assert.equal(targetDir("README.md", false), "");
  // Right-click on nothing: the root too.
  assert.equal(targetDir(null, false), "");
});

test("joining at the root produces no leading slash", () => {
  // A leading slash is an absolute path, which the backend refuses, so this is
  // the difference between a new file and an error message.
  assert.equal(joinRel("", "notes.md"), "notes.md");
  assert.equal(joinRel("src", "notes.md"), "src/notes.md");
});

test("a rename stays in its folder", () => {
  assert.equal(renameTarget("src/deep/a.ts", "b.ts"), "src/deep/b.ts");
  assert.equal(renameTarget("a.ts", "b.ts"), "b.ts");
});

test("dirOf and nameOf split a path the same way everywhere", () => {
  assert.equal(dirOf("a/b/c.txt"), "a/b");
  assert.equal(dirOf("c.txt"), "");
  assert.equal(nameOf("a/b/c.txt"), "c.txt");
  assert.equal(nameOf("c.txt"), "c.txt");
  // A dotfile is a name, not an extension.
  assert.equal(nameOf("a/.env"), ".env");
});
