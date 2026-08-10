// The thirty, read from disk, against the collision rule.
//
// docs/skills-sources.md records the licence and the source commit of every
// skill that ships with the app. If a model-written file could ever take one
// of those names, that document becomes a false statement about a file it
// never described. The list is therefore not hard-coded here: it is read from
// app/skills, so adding a thirty-first shipped skill cannot silently open a
// hole in the rule.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";
// @ts-ignore
import { existsSync, readdirSync } from "node:fs";
// @ts-ignore
import { fileURLToPath } from "node:url";
// @ts-ignore
import path from "node:path";

import { collidesWithShipped, slugify } from "../../src/learned.js";

/**
 * Walk up to the app root rather than counting "..".
 *
 * The compiled test sits at tools/learned/out/tools/learned, which is two
 * levels deeper than the source, so a hard-coded relative path is right for
 * exactly one of the two and silently wrong for the other.
 */
function appRootFrom(start: string): string {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, "skills"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return start;
}

const appRoot = appRootFrom(path.dirname(fileURLToPath(import.meta.url)));
const shipped: string[] = readdirSync(path.join(appRoot, "skills"), { withFileTypes: true })
  .filter((e: { isDirectory(): boolean }) => e.isDirectory())
  .map((e: { name: string }) => e.name);

test("the shipped catalogue was actually found", () => {
  // A test that silently reads an empty directory would pass forever while
  // proving nothing. This is the guard on the guard.
  assert.ok(shipped.length >= 25, `expected the shipped skills, found ${shipped.length}`);
});

test("no skill the agent writes can take the name of a shipped one", () => {
  for (const name of shipped) {
    assert.equal(collidesWithShipped(name, shipped), true, name);
    // And through the slug path the authoring pipeline actually uses: a title
    // the model produces goes through slugify before it is compared.
    assert.equal(collidesWithShipped(slugify(name.toUpperCase()), shipped), true, name);
  }
});

test("a name of its own is allowed", () => {
  assert.equal(collidesWithShipped("npm-test-then-fix", shipped), false);
});
