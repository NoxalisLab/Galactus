// The permission gate's two lists, pinned by the exact cases that got past
// them. Both findings below were reproduced on a real machine before the fix,
// so these are regressions, not hypotheses.
// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";
import { isElevatedWrite, isElevatedRead } from "../../src/sensitive.js";

test("every startup file a login shell sources is an elevated write", () => {
  // run_command spawns `/bin/zsh -lc`. Measured against a scratch ZDOTDIR on
  // macOS, that sources .zprofile and .zlogin and NOT .zshrc. .zlogin was the
  // one file missing from the list, which made it the single best place to
  // drop a payload: written with no dialog in autonomous mode, then executed
  // by the app's own next shell call and by every login shell afterwards.
  for (const f of [
    ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout",
    ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".profile",
  ]) {
    assert.equal(isElevatedWrite(`/Users/me/${f}`), true, `${f} must be elevated`);
  }
});

test("an ordinary dotfile is not swept up by that rule", () => {
  // The pattern must stay narrow: over-flagging trains the user to click
  // through, which costs more than it saves.
  for (const f of [".gitignore", ".editorconfig", ".prettierrc", ".zshrc.bak"]) {
    assert.equal(isElevatedWrite(`/Users/me/${f}`), false, `${f} must not be elevated`);
  }
});

test("reading a credential is elevated, so it can never auto-approve", () => {
  for (const p of [
    "/Users/me/.ssh/id_ed25519",
    "/Users/me/.aws/credentials",
    "/Users/me/.gnupg/secring.gpg",
    "/Users/me/.netrc",
    "/Users/me/.npmrc",
    "/Users/me/.git-credentials",
    "/Users/me/.docker/config.json",
    "/Users/me/project/.env",
    "/Users/me/project/.env.production",
    // Carries every MCP connector's environment block, tokens included.
    "/Users/me/Library/Application Support/Galactus/settings.json",
  ]) {
    assert.equal(isElevatedRead(p), true, `${p} must be an elevated read`);
  }
});

test("ordinary files stay ordinary reads", () => {
  for (const p of [
    "/Users/me/todo.txt",
    "/Users/me/project/src/main.ts",
    "/Users/me/project/environment.md",
    "/Users/me/Library/Application Support/Other/settings.json",
  ]) {
    assert.equal(isElevatedRead(p), false, `${p} must not be an elevated read`);
  }
});
