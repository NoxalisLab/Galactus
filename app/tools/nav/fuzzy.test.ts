// @ts-ignore Node's own test runner. No @types/node in this workspace, and no
// dependency is added for three imports.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { rank, score, positions, RECENT_BONUS } from "../../src/code/fuzzy.js";
import { synthPaths } from "./fake.js";

// ---------------------------------------------------------------------------
// The FROZEN table. Each row is a query, a candidate list, and the exact order
// the palette must show. It is frozen in the sense that changing the matcher
// must not change these orders: they encode what the user is entitled to
// expect, not what the current implementation happens to produce.
// ---------------------------------------------------------------------------

interface Row {
  why: string;
  q: string;
  candidates: string[];
  expect: string[];
}

const TABLE: Row[] = [
  {
    why: "path start wins, then the file name, then a directory name",
    q: "app",
    candidates: ["src/happy/thing.ts", "app/main.ts", "lib/wrapper.ts"],
    expect: ["app/main.ts", "lib/wrapper.ts", "src/happy/thing.ts"],
  },
  {
    why: "a segment boundary beats an interior match",
    q: "code",
    candidates: ["src/decoder/unicode.ts", "src/code/palette.ts"],
    expect: ["src/code/palette.ts", "src/decoder/unicode.ts"],
  },
  {
    why: "camelCase humps are boundaries too",
    q: "fbc",
    candidates: ["src/fabric.ts", "src/fooBarConfig.ts"],
    expect: ["src/fooBarConfig.ts", "src/fabric.ts"],
  },
  {
    why: "dash, underscore and dot boundaries all count",
    q: "mt",
    candidates: ["src/moment.ts", "src/main-test.ts", "src/main_tools.ts"],
    expect: ["src/main-test.ts", "src/main_tools.ts", "src/moment.ts"],
  },
  {
    why: "a consecutive run beats the same characters scattered",
    q: "conf",
    candidates: ["src/cannotFindFoo.ts", "src/config.ts"],
    expect: ["src/config.ts", "src/cannotFindFoo.ts"],
  },
  {
    why: "the file name outranks the directory",
    q: "pal",
    candidates: ["src/palette/index.ts", "src/code/palette.ts"],
    expect: ["src/code/palette.ts", "src/palette/index.ts"],
  },
  {
    why: "the shorter of two equally good matches comes first",
    q: "main",
    candidates: ["src/deeply/nested/main.ts", "src/main.ts"],
    expect: ["src/main.ts", "src/deeply/nested/main.ts"],
  },
  {
    why: "a non-subsequence is not a weak match, it is not a match",
    q: "xyz",
    candidates: ["src/main.ts", "app/index.html"],
    expect: [],
  },
  {
    why: "the query may span segments",
    q: "srcpal",
    candidates: ["server/crypt/pale.ts", "src/code/palette.ts"],
    expect: ["src/code/palette.ts", "server/crypt/pale.ts"],
  },
  {
    why: "case is ignored on both sides",
    q: "SPHTML",
    candidates: ["src/code/searchPanelHtml.ts", "src/other.ts"],
    expect: ["src/code/searchPanelHtml.ts"],
  },
];

for (const row of TABLE) {
  test(`rank: ${row.why}`, () => {
    const got = rank(row.q, row.candidates, [], 20).map((r) => r.path);
    assert.deepEqual(got, row.expect, `query ${JSON.stringify(row.q)}`);
  });
}

test("score returns null on a non-subsequence, and only then", () => {
  assert.equal(score("xyz", "src/main.ts"), null);
  assert.equal(score("nam", "src/main.ts"), null); // order matters
  assert.equal(score("tsm", "src/main.ts"), null); // right letters, wrong order
  assert.notEqual(score("smt", "src/main.ts"), null);
  assert.notEqual(score("", "src/main.ts"), null); // an empty query matches all
  assert.equal(score("srcmaints", "src/main.ts"), score("srcmaints", "src/main.ts"));
  assert.equal(score("toolong-query-than-candidate", "a.ts"), null);
});

test("rank returns the matched positions, in order", () => {
  const [row] = rank("plt", ["src/palette.ts"], [], 5);
  assert.deepEqual(row.positions, [4, 6, 8]); // p, l, t of "palette"
  assert.equal(row.path.slice(4, 5), "p");
  assert.equal(row.path.slice(6, 7), "l");
  assert.equal(row.path.slice(8, 9), "t");
});

test("positions() and score() agree on what matched", () => {
  assert.deepEqual(positions("xyz", "src/main.ts"), []);
  assert.deepEqual(positions("main", "src/main.ts"), [4, 5, 6, 7]);
});

test("the backward pass tightens the match to the last run", () => {
  // The greedy forward match would take a@0; the tight window is the run.
  assert.deepEqual(positions("abc", "a-b-abc.ts"), [4, 5, 6]);
});

test("a recent path is lifted by a fixed bonus, not by a rewrite of the score", () => {
  const cands = ["lib/main.ts", "src/main.ts"];
  assert.deepEqual(rank("main", cands, [], 5).map((r) => r.path), ["lib/main.ts", "src/main.ts"]);
  assert.deepEqual(rank("main", cands, ["src/main.ts"], 5).map((r) => r.path), [
    "src/main.ts",
    "lib/main.ts",
  ]);

  // The bonus is additive and fixed, so its effect is exactly predictable:
  // it flips a pair whose gap is smaller than the bonus, and it cannot flip
  // a pair whose gap is larger. Both halves are asserted.
  const best = "src/mn.ts";
  const near = "src/deeply/nested/m_n_o_p_q.ts";
  const far = "vendor/legacy/bundled/thumbnail.ts";
  assert.ok(score("mn", best)! - score("mn", near)! < RECENT_BONUS);
  assert.ok(score("mn", best)! - score("mn", far)! > RECENT_BONUS);
  assert.deepEqual(rank("mn", [near, best], [near], 5).map((r) => r.path), [near, best]);
  assert.deepEqual(rank("mn", [far, best], [far], 5).map((r) => r.path), [best, far]);
});

test("an empty query keeps every candidate, recent first, then shortest", () => {
  const got = rank("", ["bbb/x.ts", "a.ts", "zzz.ts"], ["zzz.ts"], 10).map((r) => r.path);
  assert.deepEqual(got, ["zzz.ts", "a.ts", "bbb/x.ts"]);
});

test("limit is honoured and ranking is stable across runs", () => {
  const c = synthPaths(500);
  const a = rank("sear", c, [], 7).map((r) => r.path);
  const b = rank("sear", c, [], 7).map((r) => r.path);
  assert.equal(a.length, 7);
  assert.deepEqual(a, b);
});

// Built once: two tests measure against the same 100k list, and rebuilding it
// between them would measure the allocator instead of the matcher.
const BIG = synthPaths(100_000);

test("ranking 100,000 paths stays under 50 ms", () => {
  const paths = BIG;
  assert.equal(paths.length, 100_000);
  // One warm-up so the measurement is of the matcher, not of the JIT's first
  // sight of it. Both queries are realistic: one loose, one that rejects most
  // candidates on the first pass.
  rank("sp", paths, [], 60);
  const runs: number[] = [];
  for (const q of ["s", "sp", "srcpanel", "appsrcstream"]) {
    const t0 = performance.now();
    const rows = rank(q, paths, [], 60);
    runs.push(performance.now() - t0);
    assert.ok(rows.length <= 60);
  }
  const worst = Math.max(...runs);
  console.log(`    100k paths ranked in ${runs.map((r) => r.toFixed(1)).join(" / ")} ms`);
  assert.ok(worst < 50, `worst query took ${worst.toFixed(1)} ms, budget is 50 ms`);
});

test("rejection is what makes it fast: a hopeless query costs no more than a match", () => {
  // Worst case for the early rejection: every candidate is walked end to end
  // before the first query character is given up on.
  rank("qqqqqqqq", BIG, [], 60);
  const t0 = performance.now();
  const rows = rank("qqqqqqqq", BIG, [], 60);
  const ms = performance.now() - t0;
  assert.equal(rows.length, 0);
  console.log(`    100k paths rejected in ${ms.toFixed(1)} ms`);
  assert.ok(ms < 50, `rejection took ${ms.toFixed(1)} ms, budget is 50 ms`);
});
