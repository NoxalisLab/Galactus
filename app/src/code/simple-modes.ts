/**
 * Grammars for the file types a real repository is full of and the editor was
 * not colouring: YAML, TOML, shell, and the .env / .ini family.
 *
 * WHY BY HAND. Opening .github/workflows/ci.yml or Cargo.toml showed plain
 * grey text, which reads as an editor that does not understand the file. The
 * usual answer is @codemirror/legacy-modes, a dependency carrying fifty modes
 * to get three. StreamLanguage is already in @codemirror/language, which is
 * already installed, and a line-oriented tokeniser for these three formats is
 * short enough to read in one sitting.
 *
 * WHAT THEY ARE NOT. These are highlighters, not parsers. They colour what the
 * eye uses to navigate: keys, strings, numbers, comments, booleans. They do not
 * build a tree, so there is no folding and no structural selection for these
 * types, and that is the honest trade for not carrying a parser per format.
 */

import { StreamLanguage, type StreamParser } from "@codemirror/language";

/** Shared: consume a quoted string, tolerating escapes and unterminated lines. */
function eatString(stream: { next(): string | void; eol(): boolean }, quote: string): void {
  let escaped = false;
  for (;;) {
    const ch = stream.next();
    if (ch === undefined || stream.eol()) return;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") escaped = true;
    else if (ch === quote) return;
  }
}

/**
 * YAML.
 *
 * Line-oriented on purpose. A key is what precedes a colon at the start of a
 * line's content; everything after it is a value. Block scalars (| and >) are
 * tracked, because otherwise their contents get coloured as if they were YAML,
 * which is exactly wrong for the embedded shell scripts a CI file is made of.
 */
export const yamlMode: StreamParser<{ blockIndent: number | null }> = {
  name: "yaml",
  startState: () => ({ blockIndent: null }),
  token(stream, state) {
    if (stream.sol()) {
      const indent = stream.indentation();
      if (state.blockIndent !== null && indent <= state.blockIndent && !stream.eol()) {
        state.blockIndent = null;
      }
    }
    if (state.blockIndent !== null) {
      stream.skipToEnd();
      return "string";
    }
    if (stream.eatSpace()) return null;
    if (stream.peek() === "#") {
      stream.skipToEnd();
      return "comment";
    }
    // Document markers and list bullets read as structure, not as content.
    if (stream.sol() && (stream.match("---") || stream.match("..."))) return "meta";
    if (stream.peek() === "-" && stream.match(/^-\s/)) return "punctuation";
    const quote = stream.peek();
    if (quote === '"' || quote === "'") {
      stream.next();
      eatString(stream, quote);
      return "string";
    }
    // A key: anything up to a colon that is followed by space or end of line.
    const key = stream.match(/^[\w.-]+(?=\s*:(\s|$))/);
    if (key) return "propertyName";
    if (stream.match(/^:\s*$/)) return "punctuation";
    if (stream.eat(":")) return "punctuation";
    if (stream.match(/^[|>][-+]?\s*$/)) {
      state.blockIndent = stream.indentation();
      return "meta";
    }
    if (stream.match(/^(true|false|null|yes|no|on|off|~)\b/i)) return "atom";
    if (stream.match(/^-?\d+(\.\d+)?([eE][-+]?\d+)?\b/)) return "number";
    if (stream.match(/^[&*][\w-]+/)) return "labelName";
    stream.next();
    return null;
  },
};

/**
 * TOML.
 *
 * Simpler than YAML because it has no significant indentation: a line is a
 * table header, a key/value pair, or a comment.
 */
export const tomlMode: StreamParser<Record<string, never>> = {
  name: "toml",
  startState: () => ({}),
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.peek() === "#") {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.sol() && stream.match(/^\[\[?[^\]]*\]\]?/)) return "heading";
    const quote = stream.peek();
    if (quote === '"' || quote === "'") {
      stream.next();
      eatString(stream, quote);
      return "string";
    }
    if (stream.sol() && stream.match(/^[\w.-]+(?=\s*=)/)) return "propertyName";
    if (stream.eat("=")) return "operator";
    if (stream.match(/^(true|false)\b/)) return "atom";
    // Dates before numbers: 2026-08-15 is not three numbers and two operators.
    if (stream.match(/^\d{4}-\d{2}-\d{2}([Tt ][\d:.+-]+)?/)) return "atom";
    if (stream.match(/^[-+]?(\d[\d_]*)(\.\d+)?([eE][-+]?\d+)?\b/)) return "number";
    stream.next();
    return null;
  },
};

/** The words that carry the shape of a shell script. */
const SHELL_KEYWORDS =
  /^(if|then|else|elif|fi|for|while|until|do|done|case|esac|in|function|select|time|return|break|continue|local|export|readonly|declare|set|shift|trap|source)\b/;

/**
 * Shell.
 *
 * Single quotes do not interpolate and double quotes do, which is the one
 * distinction worth carrying: a $VAR inside single quotes is literal text and
 * colouring it as a variable would teach the reader something false.
 */
export const shellMode: StreamParser<Record<string, never>> = {
  name: "shell",
  startState: () => ({}),
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.peek() === "#") {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.peek() === "'") {
      stream.next();
      // No escapes inside single quotes: the shell has no way to put one there.
      for (;;) {
        const ch = stream.next();
        if (ch === undefined || ch === "'") break;
      }
      return "string";
    }
    if (stream.peek() === '"') {
      stream.next();
      eatString(stream, '"');
      return "string";
    }
    if (stream.match(/^\$\{[^}]*\}/) || stream.match(/^\$[\w@*#?$!-]+/)) return "variableName";
    if (stream.match(SHELL_KEYWORDS)) return "keyword";
    if (stream.match(/^[\w.-]+(?==)/)) return "propertyName";
    if (stream.match(/^(\|\||&&|[|&;<>()]|\d*>>?|<<-?)/)) return "operator";
    if (stream.match(/^-{1,2}[\w-]+/)) return "attributeName";
    if (stream.match(/^\d+\b/)) return "number";
    stream.next();
    return null;
  },
};

/** .env, .ini, .conf, .properties: KEY=value with comments. */
export const iniMode: StreamParser<Record<string, never>> = {
  name: "ini",
  startState: () => ({}),
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.peek() === "#" || stream.peek() === ";") {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.sol() && stream.match(/^\[[^\]]*\]/)) return "heading";
    if (stream.sol() && stream.match(/^(export\s+)?[\w.-]+(?=\s*=)/)) return "propertyName";
    if (stream.eat("=")) return "operator";
    const quote = stream.peek();
    if (quote === '"' || quote === "'") {
      stream.next();
      eatString(stream, quote);
      return "string";
    }
    stream.skipToEnd();
    return null;
  },
};

/**
 * The extensions and bare filenames these modes cover.
 *
 * Bare names matter more than extensions here: Dockerfile, Makefile and .env
 * have no extension at all, and they are three of the files most likely to be
 * open in a repository.
 */
export function simpleModeFor(pathOrName: string): StreamParser<never> | null {
  const name = pathOrName.slice(pathOrName.lastIndexOf("/") + 1).toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  if (name === "dockerfile" || name.startsWith("dockerfile.")) {
    return shellMode as StreamParser<never>;
  }
  // Announced in langFor's comment and never handled: a Makefile opened grey.
  // The shell mode is an approximation (a recipe line IS shell, a rule line is
  // not), and an approximation reads far better than no colour at all.
  if (name === "makefile" || name === "gnumakefile" || name.endsWith(".mk")) {
    return shellMode as StreamParser<never>;
  }
  if (name === ".env" || name.startsWith(".env.")) return iniMode as StreamParser<never>;
  switch (ext) {
    case "yml":
    case "yaml":
      return yamlMode as unknown as StreamParser<never>;
    case "toml":
    case "lock":
      return tomlMode as StreamParser<never>;
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
    case "ksh":
    case "profile":
    case "bashrc":
    case "zshrc":
      return shellMode as StreamParser<never>;
    case "ini":
    case "cfg":
    case "conf":
    case "properties":
    case "env":
      return iniMode as StreamParser<never>;
    default:
      return null;
  }
}

/** The CodeMirror extension for a path, or null when nothing here covers it. */
export function simpleLanguageFor(pathOrName: string) {
  const mode = simpleModeFor(pathOrName);
  return mode ? StreamLanguage.define(mode) : null;
}
