// The deferred start of the Rust language server, as a state machine.
//
// The behaviour lives in code.ts, which imports the Tauri bridge and the DOM
// and therefore cannot be loaded by the Node runner. What CAN be pinned, and
// is the whole substance of the fix, is the arm-then-fire rule itself: a Rust
// workspace must not start a server at launch, the first Rust file opened must
// start exactly one, and every later open must be free.
//
// Written as a faithful copy of the two flags and the guard in code.ts. That
// is a real limitation and it is stated rather than hidden: if someone changes
// the guard in code.ts without changing this, the test keeps passing. It still
// earns its place, because the rule it encodes is the part a refactor is most
// likely to "simplify" back into a launch-time start, and a failing test here
// is a conversation about why.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { shouldStartRustLsp } from "../../src/code/rust-lsp.js";

/** The exact shape code.ts holds, and the guard it applies. */
function makeRunner() {
  const lsp = { armed: false, fired: false };
  let starts = 0;
  return {
    /** startWorkspaceServices: decides, never starts. */
    openWorkspace(topLevel: readonly string[]) {
      lsp.armed = shouldStartRustLsp(topLevel);
      lsp.fired = false;
    },
    /** openFile: starts, once. */
    openFile(rel: string, hasRoot = true) {
      if (!rel.endsWith(".rs")) return;
      if (!lsp.armed || lsp.fired || !hasRoot) return;
      lsp.fired = true;
      starts++;
    },
    get starts() {
      return starts;
    },
  };
}

test("opening a Rust workspace starts nothing on its own", () => {
  // The defect this replaces: a cold rust-analyzer indexing for minutes at
  // launch, for a user who came back to write a paragraph in Chat.
  const r = makeRunner();
  r.openWorkspace(["Cargo.toml", "src", "README.md"]);
  assert.equal(r.starts, 0);
});

test("the first Rust file opened starts it, and only the first", () => {
  const r = makeRunner();
  r.openWorkspace(["Cargo.toml", "src"]);
  r.openFile("src/main.rs");
  assert.equal(r.starts, 1);
  r.openFile("src/lib.rs");
  r.openFile("src/main.rs");
  assert.equal(r.starts, 1, "moving between Rust files must not spawn a second server");
});

test("a non-Rust file never starts it, whatever the workspace", () => {
  const r = makeRunner();
  r.openWorkspace(["Cargo.toml"]);
  r.openFile("README.md");
  r.openFile("package.json");
  r.openFile("src/main.rss");
  assert.equal(r.starts, 0);
});

test("a workspace with no Rust marker never starts it, even on a .rs file", () => {
  // A stray .rs in a JavaScript project is not a reason to index a crate that
  // does not exist.
  const r = makeRunner();
  r.openWorkspace(["package.json", "src"]);
  r.openFile("vendor/thing.rs");
  assert.equal(r.starts, 0);
});

test("switching workspace re-arms, so the next project gets its own server", () => {
  const r = makeRunner();
  r.openWorkspace(["Cargo.toml"]);
  r.openFile("src/main.rs");
  assert.equal(r.starts, 1);
  r.openWorkspace(["Cargo.toml"]); // another Rust project
  r.openFile("src/main.rs");
  assert.equal(r.starts, 2, "a new workspace must be able to start its own server");
});

test("no root means no start, whatever else is true", () => {
  const r = makeRunner();
  r.openWorkspace(["Cargo.toml"]);
  r.openFile("src/main.rs", false);
  assert.equal(r.starts, 0);
});

test("every marker the predicate accepts arms the runner", () => {
  for (const marker of ["Cargo.toml", "rust-toolchain.toml", "rust-toolchain"]) {
    const r = makeRunner();
    r.openWorkspace([marker]);
    r.openFile("a.rs");
    assert.equal(r.starts, 1, `${marker} must arm the deferred start`);
  }
});
