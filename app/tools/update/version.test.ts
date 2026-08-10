// The compare that decides whether a machine downloads a new binary.
//
// This project ships a version a day, so it will reach 0.1.10 within a week of
// the updater existing, and 0.1.10 against 0.1.9 is the exact pair a string
// compare gets backwards. That is the first test.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import {
  compareVersions,
  isNewer,
  parseVersion,
  versionRelation,
} from "../../src/update.js";

test("the double digit patch is newer, which a string compare denies", () => {
  assert.equal(isNewer("0.1.9", "0.1.10"), true);
  assert.equal(isNewer("0.1.10", "0.1.9"), false);
  assert.equal("0.1.10" > "0.1.9", false, "the trap this test exists for");
});

test("each field outranks the ones to its right", () => {
  assert.equal(isNewer("0.9.9", "1.0.0"), true);
  assert.equal(isNewer("1.0.0", "1.1.0"), true);
  assert.equal(isNewer("1.1.0", "1.1.1"), true);
  assert.equal(isNewer("2.0.0", "1.9.9"), false);
});

test("the same version is not an update", () => {
  assert.equal(isNewer("0.1.9", "0.1.9"), false);
  assert.equal(versionRelation("0.1.9", "0.1.9"), "same");
});

test("a leading v and a build suffix are noise, not a difference", () => {
  assert.equal(isNewer("0.1.9", "v0.1.10"), true);
  assert.equal(versionRelation("1.2.3", "1.2.3+build.7"), "same");
});

test("a prerelease precedes the release it leads to", () => {
  assert.equal(isNewer("1.0.0-rc.1", "1.0.0"), true);
  assert.equal(isNewer("1.0.0", "1.0.0-rc.1"), false);
  assert.equal(isNewer("1.0.0-alpha.1", "1.0.0-alpha.2"), true);
  assert.equal(isNewer("1.0.0-alpha.9", "1.0.0-alpha.10"), true);
  // Numeric identifiers rank below alphanumeric ones.
  assert.equal(isNewer("1.0.0-1", "1.0.0-alpha"), true);
});

test("an unreadable version is never an update", () => {
  for (const bad of ["", "latest", "0.1", "0.1.x", "1.0.0-", "1.0.0-alpha..1", "nightly"]) {
    assert.equal(isNewer("0.1.9", bad), false, `candidate ${JSON.stringify(bad)}`);
    assert.equal(isNewer(bad, "0.1.9"), false, `current ${JSON.stringify(bad)}`);
    assert.equal(versionRelation("0.1.9", bad), "unreadable");
  }
});

test("an unparsable version is null and not a zeroed one", () => {
  // A zeroed fallback would be older than every real release, which would turn
  // every malformed manifest into an offer to install.
  assert.equal(parseVersion("garbage"), null);
  assert.deepEqual(parseVersion("0.1.9"), { major: 0, minor: 1, patch: 9, prerelease: [] });
  assert.deepEqual(parseVersion("2.0.0-beta.3"), {
    major: 2,
    minor: 0,
    patch: 0,
    prerelease: ["beta", "3"],
  });
});

test("compare is a total order over the versions this app has shipped", () => {
  const shipped = [
    "0.1.0", "0.1.1", "0.1.2", "0.1.3", "0.1.4",
    "0.1.5", "0.1.6", "0.1.7", "0.1.8", "0.1.9",
    "0.1.10", "0.2.0", "0.10.0", "1.0.0",
  ];
  const parsed = shipped.map((v) => parseVersion(v)!);
  for (let i = 0; i < parsed.length; i++) {
    assert.notEqual(parsed[i], null, shipped[i]);
    for (let j = 0; j < parsed.length; j++) {
      const d = compareVersions(parsed[i], parsed[j]);
      const want = i === j ? 0 : i < j ? -1 : 1;
      assert.equal(Math.sign(d), want, `${shipped[i]} vs ${shipped[j]}`);
    }
  }
});
