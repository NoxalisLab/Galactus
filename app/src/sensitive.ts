// Galactus, what the permission gate treats as sensitive.
//
// A module of its own, with no import, for one reason: agent.ts pulls in the
// Tauri bridge and the DOM, so it cannot be loaded by the Node test runner,
// and these two lists are exactly the part that must never drift untested.
// Both were wrong in a shipped build, both were exploited in a reproduction,
// and both are now pinned by tools/gate.

export const SENSITIVE_WRITE_PREFIXES = ["/System", "/Library", "/usr", "/bin", "/sbin", "/etc", "/private"];

// Persistence / credential paths under $HOME are just as system-modifying as
// /System: writing them silently would allow login hooks or key injection.
// The bin directories are the ones the backend prepends to PATH when it
// resolves MCP connector commands: a file dropped there is executed by the
// app itself on the next connector reload.
// `.zlogin` is on this list for the sharpest reason of the lot: run_command
// spawns `/bin/zsh -lc`, a LOGIN shell, which sources `.zprofile` and
// `.zlogin` and does NOT source `.zshrc`. Measured on macOS against a scratch
// ZDOTDIR: only ZPROFILE and ZLOGIN echoed. The one startup file the app
// itself executes on every shell tool was therefore the one file missing
// here, and in autonomous mode a write to it took no dialog at all: the
// payload ran on the next command and on every login shell the user opened
// afterwards, outliving the app.
export const SENSITIVE_WRITE_PATTERNS = [
  /\/Library\/(LaunchAgents|LaunchDaemons)\//,
  /\/\.ssh\//,
  /\/\.(zshrc|zshenv|zprofile|zlogin|zlogout|bashrc|bash_profile|bash_login|bash_logout|profile)$/,
  /\/\.gitconfig$/,
  /^\/opt\/homebrew\/s?bin\//,
  /\/\.(local|bun|cargo|volta)\/bin\//,
];

/**
 * Paths whose CONTENTS are a credential, so reading them is elevated.
 *
 * There was no such list: every read was ordinary. An elevated request never
 * auto-approves and never becomes a standing rule, so these ask every time,
 * whatever the autonomy level.
 *
 * The app's own settings file is here on purpose: it carries each MCP
 * connector's environment block, which is where the user's API tokens live.
 */
const SENSITIVE_READ_PATTERNS = [
  /\/\.ssh\//,
  /\/\.aws\//,
  /\/\.gnupg\//,
  /\/\.docker\/config\.json$/,
  /\/\.netrc$/,
  /\/\.npmrc$/,
  /\/\.pypirc$/,
  /\/\.git-credentials$/,
  /\/Library\/Keychains\//,
  /\/Library\/Application Support\/Galactus\/settings\.json$/,
  /\/\.env(\.[\w.-]+)?$/,
];

/** True when reading this path hands over a secret. */
export function isElevatedRead(path: string): boolean {
  return SENSITIVE_READ_PATTERNS.some((re) => re.test(path));
}

/** True when writing this path changes how the machine behaves. */
export function isElevatedWrite(path: string): boolean {
  return (
    SENSITIVE_WRITE_PREFIXES.some((p) => path.startsWith(p)) ||
    SENSITIVE_WRITE_PATTERNS.some((re) => re.test(path))
  );
}
