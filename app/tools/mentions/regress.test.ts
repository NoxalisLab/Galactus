// Regressions for the defects found in review.
//
// All three passed the original 95 test suite while the module was wrong. The
// round trip one is the important one: mentionText's ENTIRE job is to write
// text that findMentions can read back, and it wrote text findMentions
// misparsed, then the user was blamed for a malformed path they never typed.

import {
  applyMention,
  findMentions,
  mentionText,
  resolveMentions,
  scanMentions,
  tokensFor,
} from "../../src/mentions.js";
import { FakeReader } from "./fake.js";

const NODE_TEST = "node:test";
const NODE_ASSERT = "node:assert/strict";
const { test } = (await import(NODE_TEST)) as {
  test: (name: string, fn: () => unknown) => void;
};
const assert = ((await import(NODE_ASSERT)) as { default: any }).default;

// ------------------------------------------------------------- round trip

const AT_PATHS = [
  "packages/@scope/lib/src/x.ts",
  "node_modules/@types/node/index.d.ts",
  "src/plan b.md",
  "src/normal.ts",
];

test("what mentionText writes, findMentions reads back, @ in the path included", () => {
  for (const path of AT_PATHS) {
    const draft = `look at @${mentionText({ kind: "file", path })} please`;
    const found = findMentions(draft);
    assert.equal(found.length, 1, `one mention expected in ${draft}`);
    assert.equal(found[0].path, path, `round trip broken for ${path}`);
    assert.equal(found[0].symbol, undefined);
  }
});

test("the same round trip holds for a symbol under a scoped path", () => {
  const c = { kind: "symbol", path: "packages/@scope/lib/a.ts", symbol: "run" } as const;
  const found = findMentions(`@${mentionText(c)}`);
  assert.equal(found.length, 1);
  assert.equal(found[0].path, "packages/@scope/lib/a.ts");
  assert.equal(found[0].symbol, "run");
});

test("a scoped path really reaches the reader instead of being refused", async () => {
  const path = "packages/@scope/lib/src/x.ts";
  const reader = new FakeReader({ [path]: "export const x = 1;\n" });
  const draft = applyMention("open ", { start: 5, end: 5 }, { kind: "file", path });
  const out = await resolveMentions(draft.text, reader, 4000);
  assert.deepEqual(reader.reads, [path]);
  assert.equal(out.entries.length, 1);
  assert.equal(out.entries[0].attached, true);
  assert.ok(out.block.includes("export const x = 1;"));
});

test("the picker stays open while a scoped path is being typed", () => {
  // Unquoted, the token used to die at the second "@" and the list emptied
  // halfway through. Quoted, the whole thing is one token.
  const draft = `@"packages/@sc`;
  const active = scanMentions(draft, draft.length);
  assert.ok(active);
  assert.equal(active!.query, "packages/@sc");
});

// ------------------------------------------------------- trailing punctuation

test("a sentence-final period is not part of the path", async () => {
  const reader = new FakeReader({ "src/a.ts": "const a = 1;\n" });
  const out = await resolveMentions("please explain @src/a.ts.", reader, 4000);
  assert.deepEqual(reader.reads, ["src/a.ts"]);
  assert.equal(out.entries[0].attached, true);
  assert.equal(out.entries[0].path, "src/a.ts");
});

test("an ellipsis after a mention is punctuation too, and the raw span excludes it", () => {
  const found = findMentions("see @src/a.ts... and stop");
  assert.equal(found.length, 1);
  assert.equal(found[0].path, "src/a.ts");
  assert.equal(found[0].raw, "@src/a.ts");
});

test("a quoted path is left exactly as written, trailing dot included", () => {
  const found = findMentions('see @"weird.name." here');
  assert.equal(found[0].path, "weird.name.");
});

// --------------------------------------------------------- duplicate bodies

test("a file mentioned bare and by symbol is attached once, not rendered twice", async () => {
  const content = "export function foo() {}\nexport function bar() {}\n";
  const reader = new FakeReader({ "a.ts": content });
  const out = await resolveMentions("@a.ts @a.ts#foo @a.ts#bar", reader, 4000);

  assert.deepEqual(reader.reads, ["a.ts"], "the file is read once");
  assert.equal(out.entries.length, 3, "all three asks are still answered for");
  assert.ok(out.entries.every((e) => e.attached), "none of the three is dropped");

  const copies = out.block.split("export function foo() {}").length - 1;
  assert.equal(copies, 1, `the body appears ${copies} times, expected once`);
  assert.ok(!out.block.includes("already attached in full"), "the note belongs in the entry, not the block");
  assert.equal(out.entries[1].note, "already attached in full under @a.ts");
  assert.equal(out.entries[2].note, "already attached in full under @a.ts");
});

test("deduping the body actually leaves room for the file behind it", async () => {
  // Two mentions of one 40 line file plus one small file. Without the dedupe
  // the big file is rendered twice and the small one is starved out.
  const big = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i}; // filler filler`).join("\n");
  const reader = new FakeReader({ "big.ts": big, "small.ts": "export const s = 1;\n" });
  const out = await resolveMentions("@big.ts @big.ts#v3 @small.ts", reader, 900);
  const small = out.entries.find((e) => e.path === "small.ts")!;
  assert.equal(small.attached, true, "small.ts must survive the budget");
  assert.ok(out.block.includes("export const s = 1;"));
  assert.ok(tokensFor(out.block) <= 900, "the block still fits the budget");
});
