import {
  inlineCompletionContext,
  normalizeInlineCompletion,
  shouldRequestInlineCompletion,
} from "../../src/code/auto-tab.js";

const NODE_TEST = "node:test";
const NODE_ASSERT = "node:assert/strict";
const { test } = (await import(NODE_TEST)) as {
  test: (name: string, fn: () => unknown) => void;
};
const assert = ((await import(NODE_ASSERT)) as { default: any }).default;

test("Auto Tab sends bounded context around the caret, never the whole repository", () => {
  const text = "a".repeat(7000) + "<CURSOR>" + "b".repeat(3000);
  const pos = text.indexOf("<CURSOR>");
  const clean = text.replace("<CURSOR>", "");
  const context = inlineCompletionContext(clean, pos);

  assert.equal(context.prefix.length, 6000);
  assert.equal(context.suffix.length, 2000);
  assert.equal(context.prefix, "a".repeat(6000));
  assert.equal(context.suffix, "b".repeat(2000));
});

test("Auto Tab keeps only an insertion and strips markdown or repeated prefix", () => {
  assert.equal(normalizeInlineCompletion("```ts\nreturn total;\n```", "function sum() {\n"), "return total;");
  assert.equal(
    normalizeInlineCompletion("function sum() {\n  return total;\n}", "function sum() {\n"),
    "  return total;\n}"
  );
  assert.equal(normalizeInlineCompletion("Here is the corrected code:\nreturn total;", ""), null);
});

test("Auto Tab discards hidden reasoning emitted by thinking models", () => {
  assert.equal(
    normalizeInlineCompletion("<think>We need a null guard.</think>\nif (value == null) return;", ""),
    "if (value == null) return;"
  );
});

test("Auto Tab is silent without a ready local model or during diff review", () => {
  const base = { docChanged: true, emptySelection: true, serverReady: true, reviewing: false, before: "const total = " };
  assert.equal(shouldRequestInlineCompletion(base), true);
  assert.equal(shouldRequestInlineCompletion({ ...base, serverReady: false }), false);
  assert.equal(shouldRequestInlineCompletion({ ...base, reviewing: true }), false);
  assert.equal(shouldRequestInlineCompletion({ ...base, emptySelection: false }), false);
  assert.equal(shouldRequestInlineCompletion({ ...base, docChanged: false }), false);
  assert.equal(shouldRequestInlineCompletion({ ...base, before: "  " }), false);
});
