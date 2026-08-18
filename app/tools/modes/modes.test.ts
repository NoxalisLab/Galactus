// Which file gets which grammar.
//
// The tokenisers themselves need a CodeMirror document to exercise; this covers
// the dispatch, which is where the interesting mistakes are. A repository is
// full of files with no extension at all, and those are exactly the ones a
// switch on the extension gets wrong.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { iniMode, shellMode, simpleModeFor, tomlMode, yamlMode } from "../../src/code/simple-modes.js";

test("the CI file a repository always has is YAML", () => {
  assert.equal(simpleModeFor(".github/workflows/ci.yml")?.name, yamlMode.name);
  assert.equal(simpleModeFor("docker-compose.yaml")?.name, yamlMode.name);
});

test("Cargo.toml and a lockfile are TOML", () => {
  assert.equal(simpleModeFor("Cargo.toml")?.name, tomlMode.name);
  assert.equal(simpleModeFor("Cargo.lock")?.name, tomlMode.name);
});

test("shells are shells, whatever the extension says", () => {
  for (const f of ["build.sh", "setup.bash", "x.zsh", ".zshrc"]) {
    assert.equal(simpleModeFor(f)?.name, shellMode.name, f);
  }
});

test("a file with no extension is matched by its name", () => {
  // The case a switch on the extension cannot see, and the files are common:
  // Dockerfile and .env are in most repositories.
  assert.equal(simpleModeFor("Dockerfile")?.name, shellMode.name);
  assert.equal(simpleModeFor("deploy/Dockerfile.prod")?.name, shellMode.name);
  assert.equal(simpleModeFor(".env")?.name, iniMode.name);
  assert.equal(simpleModeFor(".env.local")?.name, iniMode.name);
});

test("a path is matched on its last segment, not on the folder", () => {
  // "src/toml/main.rs" is Rust, and a naive substring match calls it TOML.
  assert.equal(simpleModeFor("src/toml/main.rs"), null);
  assert.equal(simpleModeFor("yaml/notes.md"), null);
});

test("anything else is left to the real grammars, or to none", () => {
  for (const f of ["main.rs", "app.ts", "index.html", "README.md", "photo.png"]) {
    assert.equal(simpleModeFor(f), null, f);
  }
});
