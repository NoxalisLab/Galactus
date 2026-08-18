// The permission gate's two lists, pinned by the exact cases that got past
// them. Both findings below were reproduced on a real machine before the fix,
// so these are regressions, not hypotheses.
// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";
import { isElevatedWrite, isElevatedRead, isNetworkGitCommand } from "../../src/sensitive.js";

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

test("a command that reaches a remote is recognised, wherever it sits", () => {
  // THE POINT. The Code view's Push button asked with kind "git" and noAlways,
  // which is what makes an unattended run stop and ask a human. The model never
  // pressed that button: it ran `git push` through run_command, kind "shell",
  // which an autonomous run grants in silence. The runs form meanwhile told the
  // reader that push and pull were the last two things that would still stop a
  // run. They stopped nothing.
  for (const c of [
    "git push",
    "git push origin main",
    "git -C /tmp/x push",
    "cd repo && git push --force",
    "sudo git pull",
    "git fetch --all",
    "git clone https://example.invalid/x",
    "npm test; git push",
  ]) {
    assert.equal(isNetworkGitCommand(c), true, c);
  }
});

test("local git is left alone, and so is a mention of it", () => {
  // A run that has to ask before `git status` is a run nobody will use, and a
  // string containing the words is not a command running them.
  for (const c of [
    "git status",
    "git add -A",
    "git commit -m 'x'",
    "git log --oneline",
    "git diff",
    'echo "git push"',
    "grep -r 'git push' .",
    "cat notes-about-git-push.md",
  ]) {
    assert.equal(isNetworkGitCommand(c), false, c);
  }
});
