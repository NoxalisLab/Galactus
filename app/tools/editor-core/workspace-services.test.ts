import { shouldLoadTsIntel } from "../../src/tsintel/eligibility.js";

const NODE_TEST = "node:test";
const NODE_ASSERT = "node:assert/strict";
const { test } = (await import(NODE_TEST)) as {
  test: (name: string, fn: () => unknown) => void;
};
const assert = ((await import(NODE_ASSERT)) as { default: any }).default;

test("a restored non-JS workspace stays off the TypeScript cold-start path", () => {
  assert.equal(shouldLoadTsIntel(["Cargo.toml", "README.md", "src"]), false);
  assert.equal(shouldLoadTsIntel([]), false);
});

test("a package or TypeScript config admits the language service", () => {
  assert.equal(shouldLoadTsIntel(["package.json", "src"]), true);
  assert.equal(shouldLoadTsIntel(["tsconfig.json"]), true);
});
