// @ts-ignore Node's own test runner.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { rankCandidates, matchText, confinementError } from "../../src/mentions.js";
import type { MentionCandidate } from "../../src/mentions.js";
import { score as fuzzyScore } from "../../src/code/fuzzy.js";
import { CANDIDATES } from "./fake.js";

// ---------------------------------------------------------------------------
// rankCandidates. The scorer itself is fuzzy.ts and is already frozen by
// tools/nav/fuzzy.test.ts, so what is tested here is what this module adds:
// the match text it builds, the tie break, the limit and the positions.
// ---------------------------------------------------------------------------

test("a symbol is matched on path#name, so its name still dominates", () => {
  const sym: MentionCandidate = { kind: "symbol", path: "src/code/fuzzy.ts", symbol: "rank" };
  assert.equal(matchText(sym), "src/code/fuzzy.ts#rank");
  assert.equal(matchText({ kind: "file", path: "src/code/fuzzy.ts" }), "src/code/fuzzy.ts");
});

test("a bare symbol name finds the symbol", () => {
  const rows = rankCandidates(CANDIDATES, "rank");
  assert.ok(rows.length > 0);
  const first = rows[0].candidate;
  assert.equal(first.kind, "symbol");
  assert.equal(first.symbol, "rank");
});

test("file.symbol reaches the symbol without a second query syntax", () => {
  const rows = rankCandidates(CANDIDATES, "fuzzy.rank");
  assert.equal(rows[0].candidate.symbol, "rank");
  assert.equal(rows[0].candidate.path, "src/code/fuzzy.ts");
});

test("a path query prefers the file over a symbol declared in it", () => {
  const rows = rankCandidates(CANDIDATES, "src/code/fuzzy.ts");
  assert.equal(rows[0].candidate.kind, "file");
  assert.equal(rows[0].candidate.path, "src/code/fuzzy.ts");
});

test("a non-subsequence is not a weak match, it is absent", () => {
  assert.deepEqual(rankCandidates(CANDIDATES, "zzzqqq"), []);
  // And the exclusion really comes from the shared scorer, not from a filter
  // reimplemented here.
  assert.equal(fuzzyScore("zzzqqq", "src/code/fuzzy.ts"), null);
});

test("an empty query lists everything, shortest first, deterministically", () => {
  const a = rankCandidates(CANDIDATES, "");
  const b = rankCandidates([...CANDIDATES].reverse(), "");
  assert.equal(a.length, CANDIDATES.length);
  assert.deepEqual(a.map((r) => r.text), b.map((r) => r.text));
  for (let i = 1; i < a.length; i++) {
    assert.ok(
      a[i - 1].text.length <= a[i].text.length,
      `${a[i - 1].text} should not be longer than ${a[i].text}`
    );
  }
});

test("two candidates with the same match text both survive the ranking", () => {
  // A file and a symbol can collide on their match text only if the symbol has
  // no name, but duplicates of any kind must not be collapsed: the picker
  // shows rows, not strings. This is the reason rank() from fuzzy.ts, which
  // takes and returns bare strings, is deliberately not reused.
  const dup: MentionCandidate[] = [
    { kind: "file", path: "src/a.ts" },
    { kind: "file", path: "src/a.ts" },
  ];
  assert.equal(rankCandidates(dup, "a.ts").length, 2);
});

test("the limit is honoured and positions are only paid for on kept rows", () => {
  const rows = rankCandidates(CANDIDATES, "s", 2);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.ok(r.positions.length > 0, `${r.text} should carry its matched offsets`);
    for (const p of r.positions) assert.equal(r.text[p].toLowerCase(), "s");
  }
  assert.deepEqual(rankCandidates(CANDIDATES, "s", 0), []);
});

test("ranking is stable across two identical calls", () => {
  const a = rankCandidates(CANDIDATES, "ma").map((r) => r.text);
  const b = rankCandidates(CANDIDATES, "ma").map((r) => r.text);
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// confinementError. Rejection, never normalization.
// ---------------------------------------------------------------------------

const ESCAPES = [
  "../secrets.txt",
  "src/../../etc/passwd",
  "a/b/../../../../etc/passwd",
  "..",
  "../",
  "src/..",
];

for (const path of ESCAPES) {
  test(`confinement rejects and does not rewrite: ${path}`, () => {
    const err = confinementError(path);
    assert.ok(err, `${path} must be refused`);
    assert.match(err!, /escapes the workspace root|empty path segment/);
  });
}

const OTHER_REFUSALS: Array<[string, RegExp]> = [
  ["", /empty path/],
  ["/etc/passwd", /absolute/],
  ["~/.ssh/id_rsa", /home relative/],
  ["C:/Windows/system32", /drive letter/],
  ["src\\code\\fuzzy.ts", /backslashes/],
  ["./src/a.ts", /"\." segment/],
  ["src//a.ts", /empty path segment/],
  ["src/a\u0000.ts", /control character/],
  ["src/a\n.ts", /control character/],
];

for (const [path, why] of OTHER_REFUSALS) {
  test(`confinement rejects ${JSON.stringify(path)}`, () => {
    const err = confinementError(path);
    assert.ok(err, `${path} must be refused`);
    assert.match(err!, why);
  });
}

const ACCEPTED = ["a.ts", "src/a.ts", "src/code/fuzzy.ts", "my notes/plan b.md", "a..b/c.ts", "src/c++/x.h"];

for (const path of ACCEPTED) {
  test(`confinement accepts ${JSON.stringify(path)}`, () => {
    assert.equal(confinementError(path), null);
  });
}
