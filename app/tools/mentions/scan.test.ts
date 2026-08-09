// @ts-ignore Node's own test runner. No @types/node in this workspace, and no
// dependency is added for three imports.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { scanMentions, findMentions, applyMention, mentionText } from "../../src/mentions.js";
import type { MentionCandidate } from "../../src/mentions.js";

// ---------------------------------------------------------------------------
// scanMentions. The caret is written as a "|" in the fixture and stripped
// before the call, so the test reads like the composer looks and an off-by-one
// in the fixture is visible rather than hidden in an integer.
// ---------------------------------------------------------------------------

function at(fixture: string): { text: string; caret: number } {
  const caret = fixture.indexOf("|");
  assert.ok(caret >= 0, `fixture has no caret marker: ${fixture}`);
  return { text: fixture.slice(0, caret) + fixture.slice(caret + 1), caret };
}

interface Accept {
  why: string;
  fixture: string;
  query: string;
  token: string;
  quoted?: boolean;
}

const ACCEPTS: Accept[] = [
  { why: "a bare @ opens the picker with no filter", fixture: "@|", query: "", token: "" },
  { why: "the query is what has been typed so far", fixture: "@src/co|", query: "src/co", token: "src/co" },
  { why: "after a space, mid sentence", fixture: "look at @fuz|", query: "fuz", token: "fuz" },
  { why: "after an opening bracket", fixture: "(@fuz|)", query: "fuz", token: "fuz" },
  { why: "at the start of a line that is not the start of the text", fixture: "hello\n@ma|", query: "ma", token: "ma" },
  {
    why: "the caret inside the token filters on the head but the whole token is the range",
    fixture: "@src/co|de/fuzzy.ts",
    query: "src/co",
    token: "src/code/fuzzy.ts",
  },
  {
    why: "a symbol mention is one token, the hash included",
    fixture: "@src/code/fuzzy.ts#ra|",
    query: "src/code/fuzzy.ts#ra",
    token: "src/code/fuzzy.ts#ra",
  },
  {
    why: "the quoted form carries the spaces a path may contain",
    fixture: '@"my notes/plan b.md"|',
    query: "my notes/plan b.md",
    token: "my notes/plan b.md",
    quoted: true,
  },
  {
    why: "a quote still being typed runs to the end of the line and no further",
    fixture: '@"my not|\nnext line',
    query: "my not",
    token: "my not",
    quoted: true,
  },
  {
    why: "an even run of backslashes is a literal backslash, then a real mention",
    fixture: "\\\\@ma|",
    query: "ma",
    token: "ma",
  },
];

for (const row of ACCEPTS) {
  test(`scanMentions accepts: ${row.why}`, () => {
    const { text, caret } = at(row.fixture);
    const m = scanMentions(text, caret);
    assert.ok(m, `expected a mention in ${JSON.stringify(row.fixture)}`);
    assert.equal(m!.query, row.query);
    assert.equal(m!.token, row.token);
    assert.equal(m!.quoted, row.quoted ?? false);
    assert.equal(text[m!.start], "@");
    assert.ok(m!.end >= caret, "the token must reach at least to the caret");
  });
}

const REFUSALS: Array<{ why: string; fixture: string }> = [
  { why: "an email address, the @ is inside a word", fixture: "write to bob@example.com| please" },
  { why: "an email address, caret in the middle of the domain", fixture: "bob@exam|ple.com" },
  { why: "an @ glued to the end of a word", fixture: "cost 12@|" },
  { why: "an @ after a dot", fixture: "foo.@ba|r" },
  { why: "an escaped @", fixture: "\\@src/ma|" },
  { why: "an escaped @ with the caret right after it", fixture: "\\@|" },
  { why: "the caret has already left the token", fixture: "@src/main.ts and| then" },
  { why: "a space right after the @ ends the token", fixture: "@ |" },
  { why: "there is no @ on this line at all", fixture: "plain prose here|" },
  { why: "the @ is on the previous line", fixture: "@src/main.ts\nnext|" },
  { why: "inside an inline code span, a Python decorator", fixture: "use `@property|` on it" },
  { why: "inside a fenced block", fixture: "```py\n@app.route|\n```" },
  { why: "inside a fence that is still open, which is what typing one looks like", fixture: "```py\n@app.rou|" },
  { why: "inside a tilde fence", fixture: "~~~\n@decorator|\n~~~" },
  { why: "inside an indented code block pasted without fences", fixture: "look:\n\n    @staticmethod|\n    def f(): pass" },
];

for (const row of REFUSALS) {
  test(`scanMentions refuses: ${row.why}`, () => {
    const { text, caret } = at(row.fixture);
    assert.equal(scanMentions(text, caret), null, JSON.stringify(row.fixture));
  });
}

test("a decorator in prose does trigger, and that is the documented limit", () => {
  // Unfenced and unindented, "@staticmethod" is indistinguishable from a
  // mention of a file called staticmethod. The picker simply finds nothing and
  // closes. This test exists so the boundary is a decision on record rather
  // than an accident: only code CONTEXT (fence, span, indent) suppresses it.
  const { text, caret } = at("@staticmethod|");
  const m = scanMentions(text, caret);
  assert.ok(m);
  assert.equal(m!.query, "staticmethod");
});

test("a prose paragraph containing an @ never opens a picker on a long query", () => {
  const long = "@" + "a".repeat(400);
  assert.equal(scanMentions(long, long.length), null);
});

test("the caret is clamped rather than trusted", () => {
  const m = scanMentions("@ab", 999);
  assert.ok(m);
  assert.equal(m!.query, "ab");
  assert.equal(scanMentions("@ab", -5), null);
});

// ---------------------------------------------------------------------------
// findMentions, the whole message pass.
// ---------------------------------------------------------------------------

test("findMentions returns every mention in order with its parts split", () => {
  const text = 'compare @src/a.ts with @src/b.ts#doThing and @"my notes/x.md"';
  const found = findMentions(text);
  assert.deepEqual(
    found.map((m) => [m.path, m.symbol ?? null]),
    [
      ["src/a.ts", null],
      ["src/b.ts", "doThing"],
      ["my notes/x.md", null],
    ]
  );
  for (const m of found) assert.equal(text.slice(m.start, m.end), m.raw);
});

test("findMentions skips code, addresses and escapes in one pass", () => {
  const text = [
    "mail bob@example.com about @src/real.ts",
    "",
    "```py",
    "@app.route('/x')",
    "```",
    "",
    "an escaped \\@notamention and an inline `@span` one",
  ].join("\n");
  assert.deepEqual(
    findMentions(text).map((m) => m.path),
    ["src/real.ts"]
  );
});

test("findMentions does not let one mention swallow the next", () => {
  const found = findMentions("@a.ts@b.ts");
  // The second "@" ends the first token: it is not a token character.
  assert.deepEqual(
    found.map((m) => m.path),
    ["a.ts"]
  );
});

// ---------------------------------------------------------------------------
// applyMention.
// ---------------------------------------------------------------------------

const FILE: MentionCandidate = { kind: "file", path: "src/code/fuzzy.ts" };
const SYM: MentionCandidate = { kind: "symbol", path: "src/code/fuzzy.ts", symbol: "rank", detail: "function" };
const SPACED: MentionCandidate = { kind: "file", path: "my notes/plan b.md" };

test("applyMention replaces the whole token, not just the typed head", () => {
  const { text, caret } = at("look at @src/co|de/other.ts now");
  const m = scanMentions(text, caret)!;
  const out = applyMention(text, m, FILE);
  assert.equal(out.text, "look at @src/code/fuzzy.ts now");
  // The caret lands at the end of the mention: the space that follows was
  // already in the sentence, so no second one is inserted before it.
  assert.equal(out.caret, "look at @src/code/fuzzy.ts".length);
  assert.equal(out.text.slice(out.caret, out.caret + 1), " ");
});

test("applyMention does not add a second space when one is already there", () => {
  const { text, caret } = at("@fu| more");
  const out = applyMention(text, scanMentions(text, caret)!, FILE);
  assert.equal(out.text, "@src/code/fuzzy.ts more");
  assert.equal(out.caret, "@src/code/fuzzy.ts".length);
});

test("applyMention appends a trailing space at the end of the draft", () => {
  const { text, caret } = at("@fu|");
  const out = applyMention(text, scanMentions(text, caret)!, SYM);
  assert.equal(out.text, "@src/code/fuzzy.ts#rank ");
  assert.equal(out.caret, out.text.length);
});

test("a path with a space comes back quoted and re-scans as one token", () => {
  assert.equal(mentionText(SPACED), '"my notes/plan b.md"');
  const { text, caret } = at("@my|");
  const out = applyMention(text, scanMentions(text, caret)!, SPACED);
  assert.equal(out.text, '@"my notes/plan b.md" ');
  // The round trip is the point: what applyMention writes, findMentions reads.
  assert.deepEqual(
    findMentions(out.text).map((m) => m.path),
    ["my notes/plan b.md"]
  );
});

test("applyMention clamps a range the caller got wrong instead of corrupting the draft", () => {
  const out = applyMention("abc", { start: 99, end: -3 }, FILE);
  assert.equal(out.text, "abc@src/code/fuzzy.ts ");
  assert.equal(out.caret, out.text.length);
});
