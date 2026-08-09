// @ts-ignore Node's own test runner.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { resolveMentions, tokensFor, symbolLine, queryTerms, findMentions } from "../../src/mentions.js";
import { FakeReader, ThrowingReader, numberedLines, SMALL } from "./fake.js";

// ---------------------------------------------------------------------------
// The happy path.
// ---------------------------------------------------------------------------

test("no mention leaves the message untouched", async () => {
  const r = new FakeReader({ "src/a.ts": SMALL });
  const out = await resolveMentions("just a question", r, 4000);
  assert.equal(out.text, "just a question");
  assert.equal(out.block, "");
  assert.deepEqual(out.entries, []);
  assert.deepEqual(r.reads, []);
});

test("a small file is attached whole, with line numbers, below the untouched message", async () => {
  const r = new FakeReader({ "src/a.ts": SMALL });
  const out = await resolveMentions("explain @src/a.ts", r, 4000);
  assert.ok(out.text.startsWith("explain @src/a.ts\n\n"), "the user's sentence must survive verbatim");
  assert.equal(out.entries.length, 1);
  assert.equal(out.entries[0].mode, "whole");
  assert.ok(out.entries[0].attached);
  assert.match(out.block, /whole file, 5 lines/);
  assert.match(out.block, /1 \| const a = 1;/);
  assert.match(out.block, /5 \| \}/);
  // Nothing was cut, so no body may carry a gap marker and no mention may be
  // named in the footer. The preamble's own sentence about omissions is not
  // evidence of one, which is why the assertion targets the markers.
  assert.ok(!/\[\.\.\. lines/.test(out.block));
  assert.ok(!out.block.includes("Not attached"));
});

test("the same file mentioned twice is read once and attached once", async () => {
  const r = new FakeReader({ "src/a.ts": SMALL });
  const out = await resolveMentions("@src/a.ts versus @src/a.ts", r, 4000);
  assert.equal(out.entries.length, 1);
  assert.deepEqual(r.reads, ["src/a.ts"]);
});

test("a file and a symbol in it are two asks about one file, read once", async () => {
  const r = new FakeReader({ "src/a.ts": SMALL });
  const out = await resolveMentions("@src/a.ts and @src/a.ts#tiny", r, 4000);
  assert.equal(out.entries.length, 2);
  assert.deepEqual(r.reads, ["src/a.ts"]);
});

// ---------------------------------------------------------------------------
// Path confinement. The reader must never even be asked.
// ---------------------------------------------------------------------------

test("a mention that escapes the root is refused, and the reader is not called", async () => {
  const r = new FakeReader({ "src/a.ts": SMALL });
  const out = await resolveMentions("read @../../etc/passwd now", r, 4000);
  assert.deepEqual(r.reads, [], "a refused path must not reach the filesystem at all");
  assert.equal(out.entries.length, 1);
  assert.equal(out.entries[0].attached, false);
  assert.match(out.entries[0].note!, /escapes the workspace root/);
  assert.match(out.block, /Attached context: nothing/);
  // The refusal is stated in the message the model receives, not swallowed.
  assert.ok(out.text.includes(out.block));
});

test("an absolute path is refused rather than rebased onto the root", async () => {
  const r = new FakeReader({ "etc/passwd": "root:x:0:0" });
  const out = await resolveMentions("@/etc/passwd", r, 4000);
  assert.deepEqual(r.reads, []);
  assert.ok(!out.block.includes("root:x:0:0"));
});

test("a missing file and a failing reader both report honestly", async () => {
  const missing = await resolveMentions("@src/nope.ts", new FakeReader({}), 4000);
  assert.match(missing.entries[0].note!, /not found/);
  const broken = await resolveMentions("@src/a.ts", new ThrowingReader(), 4000);
  assert.equal(broken.entries[0].attached, false);
  assert.match(broken.entries[0].note!, /not found/);
});

test("a mention written inside a code fence is not resolved", async () => {
  const r = new FakeReader({ "src/a.ts": SMALL });
  const out = await resolveMentions("```\n@src/a.ts\n```", r, 4000);
  assert.deepEqual(r.reads, []);
  assert.equal(out.block, "");
  assert.equal(out.text, "```\n@src/a.ts\n```");
});

// ---------------------------------------------------------------------------
// The budget. This is the part that matters.
// ---------------------------------------------------------------------------

const BIG = numberedLines(600);

test("whenever content is attached, the block fits the budget exactly", async () => {
  const r = new FakeReader({ "src/big.ts": BIG, "src/a.ts": SMALL });
  let sawAttached = false;
  let sawRefused = false;
  for (const budget of [0, 1, 40, 80, 120, 200, 400, 800, 1600, 3200, 12000]) {
    const out = await resolveMentions("look at @src/big.ts and @src/a.ts", r, budget);
    assert.equal(out.tokens, tokensFor(out.block));
    if (out.entries.some((e) => e.attached)) {
      sawAttached = true;
      assert.ok(
        tokensFor(out.block) <= budget,
        `budget ${budget} overrun: block cost ${tokensFor(out.block)}`
      );
    } else {
      sawRefused = true;
      // The single documented exception: the fail-closed notice is emitted
      // whatever the budget, but it never carries workspace content.
      assert.ok(!out.block.includes("line 1 filler"));
      assert.ok(!out.block.includes("const a = 1;"));
    }
  }
  assert.ok(sawAttached && sawRefused, "the sweep must cover both outcomes to mean anything");
});

test("a file too large for the budget becomes an excerpt, never a silent head cut", async () => {
  const r = new FakeReader({ "src/big.ts": BIG });
  const out = await resolveMentions("what does @src/big.ts do", r, 800);
  assert.equal(out.entries[0].mode, "excerpt");
  assert.ok(out.entries[0].attached);
  assert.match(out.block, /excerpt/);
  // The omission is stated in the body, with the exact line ranges.
  assert.match(out.block, /\[\.\.\. lines \d+ to \d+ omitted \.\.\.\]/);
  assert.match(out.entries[0].note!, /of 600 lines omitted/);
  assert.ok(tokensFor(out.block) <= 800);
});

test("the excerpt is ranked against the message, so a needle far down still arrives", async () => {
  // The answering line sits at 500, far past where any head cut would stop.
  const lines = numberedLines(600).split("\n");
  lines[499] = "the expert cache is sized from the measured resident footprint";
  const doc = lines.join("\n");
  const r = new FakeReader({ "src/big.ts": doc });
  const out = await resolveMentions(
    "in @src/big.ts how is the expert cache resident footprint measured",
    r,
    900
  );
  assert.ok(out.block.includes("expert cache"), "the answering line did not survive the excerpt");
  // A budget of the same size spent on the head of the file would have missed
  // it, which is the whole reason ranking beats truncation.
  assert.ok(!doc.slice(0, 900 * 3).includes("expert cache"));
});

test("a tight budget is spent on the relevant lines, not on whatever block happened to fit", async () => {
  // The regression this pins: selecting whole fixed-size blocks meant that on
  // a budget smaller than one block, the ONLY block that fitted was the short
  // remainder at the end of the file. The excerpt was then the tail, every
  // token of it irrelevant, and nothing said so.
  const lines: string[] = [];
  for (let i = 1; i <= 200; i++) lines.push(`function step${i}() { return ${i}; } // filler filler`);
  lines[149] = "export function expertCache() { /* sized from the measured resident footprint */ }";
  const r = new FakeReader({ "src/big.ts": lines.join("\n") });
  const out = await resolveMentions(
    "how does the expert cache measure its resident footprint in @src/big.ts",
    r,
    500
  );
  assert.ok(out.block.includes("expertCache"), "the one relevant line must be in the excerpt");
  assert.ok(out.block.includes("150 | export function expertCache"), "with its real line number");
  assert.ok(!out.block.includes("step200"), "the tail of the file is not what was asked about");
  assert.ok(out.block.includes("149 | ") && out.block.includes("151 | "), "with its surrounding context");
  assert.ok(tokensFor(out.block) <= 500);
});

test("with no terms to rank by the excerpt says so instead of pretending", async () => {
  const r = new FakeReader({ "src/big.ts": BIG });
  const out = await resolveMentions("@src/big.ts", r, 700);
  assert.match(out.block, /head of the file: the message had no terms to rank by/);
});

test("a large first mention does not starve the small ones behind it", async () => {
  const r = new FakeReader({ "src/big.ts": BIG, "src/a.ts": SMALL, "src/b.ts": SMALL });
  const out = await resolveMentions("compare @src/big.ts @src/a.ts @src/b.ts", r, 1200);
  const byPath = new Map(out.entries.map((e) => [e.path, e]));
  assert.equal(byPath.get("src/a.ts")!.mode, "whole", "the small file must still arrive whole");
  assert.equal(byPath.get("src/b.ts")!.mode, "whole");
  assert.ok(byPath.get("src/big.ts")!.attached, "the large file should get the leftover room");
  assert.ok(tokensFor(out.block) <= 1200);
});

test("room the small mentions did not spend flows to the large one", async () => {
  const r = new FakeReader({ "src/a.ts": SMALL, "src/big.ts": BIG });
  const tight = await resolveMentions("@src/a.ts @src/big.ts", r, 700);
  const roomy = await resolveMentions("@src/a.ts @src/big.ts", r, 2400);
  const tightBig = tight.entries.find((e) => e.path === "src/big.ts")!;
  const roomyBig = roomy.entries.find((e) => e.path === "src/big.ts")!;
  assert.ok(roomyBig.tokens > tightBig.tokens, "a bigger budget must buy a bigger excerpt");
});

test("a budget too small for anything fails closed and names what was dropped", async () => {
  const r = new FakeReader({ "src/big.ts": BIG });
  const out = await resolveMentions("@src/big.ts", r, 60);
  assert.equal(out.entries[0].attached, false);
  assert.match(out.block, /Attached context: nothing/);
  assert.match(out.block, /@src\/big\.ts/);
  assert.match(out.block, /60 token budget/);
  // Failing closed still tells the model what to do next.
  assert.match(out.block, /read_file/);
});

test("a mixed outcome names the losers in the footer of the block", async () => {
  const r = new FakeReader({ "src/a.ts": SMALL });
  const out = await resolveMentions("@src/a.ts and @src/gone.ts", r, 4000);
  assert.match(out.block, /Not attached: @src\/gone\.ts \(not found in the workspace\)\./);
  assert.match(out.block, /whole file, 5 lines/);
});

test("a file far larger than any budget is still excerpted, and only its excerpt is built", async () => {
  // 50k lines, roughly 1.4 MB. The whole-file body is never rendered, and the
  // needle is found by ranking rather than by luck.
  const r = new FakeReader({ "src/huge.ts": numberedLines(50000) });
  const out = await resolveMentions("what happens at line 41234 in @src/huge.ts", r, 1000);
  assert.equal(out.entries[0].mode, "excerpt");
  assert.ok(out.block.includes("line 41234"));
  assert.ok(tokensFor(out.block) <= 1000);
  assert.match(out.entries[0].note!, /of 50000 lines omitted/);
});

test("entries come back in order of first appearance, whatever their outcome", async () => {
  const r = new FakeReader({ "src/a.ts": SMALL, "src/b.ts": SMALL });
  const out = await resolveMentions("@src/gone.ts then @src/b.ts then @../x then @src/a.ts", r, 4000);
  assert.deepEqual(
    out.entries.map((e) => e.path),
    ["src/gone.ts", "src/b.ts", "../x", "src/a.ts"]
  );
});

// ---------------------------------------------------------------------------
// Symbols.
// ---------------------------------------------------------------------------

test("a symbol mention excerpts around its declaration, not around the head", async () => {
  const lines = numberedLines(600).split("\n");
  lines[399] = "export function deepDown(x: number): number {";
  lines[400] = "  return x * 2;";
  lines[401] = "}";
  const r = new FakeReader({ "src/big.ts": lines.join("\n") });
  const out = await resolveMentions("@src/big.ts#deepDown please", r, 700);
  assert.equal(out.entries[0].mode, "excerpt");
  assert.match(out.block, /excerpt around line 400/);
  assert.ok(out.block.includes("export function deepDown"));
  assert.ok(out.block.includes("400 | export function deepDown"), "the gutter must carry the real line number");
});

test("a symbol excerpt is one contiguous window around the declaration", async () => {
  const lines = numberedLines(400).split("\n");
  lines[199] = "export function middle(x: number) {";
  const r = new FakeReader({ "src/big.ts": lines.join("\n") });
  const out = await resolveMentions("@src/big.ts#middle", r, 400);
  const shown = out.block
    .split("\n")
    .filter((l) => /^\s*\d+ \| /.test(l))
    .map((l) => Number(l.trim().split(" | ")[0]));
  assert.ok(shown.length > 1);
  assert.ok(shown.includes(200), "the declaration itself must be there");
  for (let i = 1; i < shown.length; i++) {
    assert.equal(shown[i], shown[i - 1] + 1, "the window around a symbol must not be perforated");
  }
});

test("a declaration wins over an earlier mere use of the name", () => {
  const lines = ["  rank(a, b);", "// talks about rank", "export function rank(q: string) {", "}"];
  assert.equal(symbolLine(lines, "rank"), 3);
});

test("a name that only ever appears as a use still resolves to its first use", () => {
  assert.equal(symbolLine(["nothing", "  callSite(rank);", "  rank();"], "rank"), 2);
});

test("a name that is only a substring of another does not match", () => {
  assert.equal(symbolLine(["export function ranked() {}", "const prerank = 1;"], "rank"), 0);
});

test("a symbol that is nowhere in the file is reported, not silently ignored", async () => {
  const r = new FakeReader({ "src/a.ts": SMALL });
  const out = await resolveMentions("@src/a.ts#noSuchThing", r, 4000);
  assert.equal(out.entries[0].attached, false);
  assert.match(out.entries[0].note!, /no symbol named "noSuchThing" in src\/a\.ts/);
  assert.ok(!out.block.includes("const a = 1;"), "nothing must be attached for a symbol that is not there");
});

// ---------------------------------------------------------------------------
// Supporting arithmetic.
// ---------------------------------------------------------------------------

test("tokens are counted on UTF-8 bytes, so accents are not undercounted", () => {
  // Six characters, twelve bytes: an estimate built on .length would claim two
  // tokens for something that costs four.
  assert.equal(tokensFor("éééééé"), Math.ceil(12 / 3));
  assert.equal(tokensFor(""), 0);
});

test("the ranking terms are the user's words, with the mention tokens removed", () => {
  const text = "why is @src/code/fuzzy.ts slow on windows";
  const terms = queryTerms(text, findMentions(text));
  assert.ok(terms.includes("slow"));
  assert.ok(terms.includes("windows"));
  assert.ok(!terms.includes("fuzzy"), "the mention itself must not become a ranking term");
  assert.ok(!terms.includes("src"));
});

test("an empty file is reported rather than attached as an empty body", async () => {
  const r = new FakeReader({ "src/empty.ts": "\n" });
  const out = await resolveMentions("@src/empty.ts", r, 4000);
  assert.equal(out.entries[0].attached, false);
  assert.match(out.entries[0].note!, /empty/);
});

test("a file without a trailing newline keeps its last line and its count", async () => {
  const r = new FakeReader({ "src/a.ts": "one\ntwo" });
  const out = await resolveMentions("@src/a.ts", r, 4000);
  assert.match(out.block, /whole file, 2 lines/);
  assert.match(out.block, /2 \| two/);
});
