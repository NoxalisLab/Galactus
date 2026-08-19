/**
 * Masking secrets on their way out of the app.
 *
 * WHY. Exporting a conversation writes every tool result verbatim into a
 * markdown file the user then mails, pastes into a ticket, or drops in a chat.
 * Those results routinely contain what the agent read: an .env file, the output
 * of `env`, a connector's authenticated response. The permission dialog asked
 * whether the agent could READ that; nobody agreed to publish it.
 *
 * WHAT THIS IS NOT. Not a guarantee. A secret with no recognisable shape gets
 * through, and it is meant to: the alternative is a filter so eager that the
 * export becomes unreadable and people stop using it. It catches the shapes
 * that are actually leaked, which are the ones with a name attached.
 */

/** What replaces a secret, so the reader can see something was removed. */
export const REDACTED = "[removed by Galactus]";

/**
 * Values that carry a secret's NAME but cannot be the secret.
 *
 * A declaration (`password: string`), a flag (`const secret = false;`), an
 * empty field, or the word people write when there is nothing to write yet.
 * Masking these loses information and gains nothing.
 */
const NOT_A_SECRET = new Set([
  "true", "false", "null", "undefined", "none", "nil", "nan", "0", "1", "",
  "string", "str", "number", "int", "bool", "boolean", "any", "object", "bytes",
  "changeme", "todo", "xxx", "placeholder", "your_key_here", "...",
]);

function isNotASecret(raw: string): boolean {
  const bare = raw.replace(/^["']|["'],?;?$/g, "").replace(/[,;]$/, "").trim();
  return NOT_A_SECRET.has(bare.toLowerCase());
}

const RULES: Array<{ re: RegExp; keep: (m: RegExpMatchArray) => string }> = [
  // KEY=value in an env file or in the output of `env`. The name is kept: it
  // is what makes the export useful, and it is not the secret.
  {
    re: /^([ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?|AUTH)[A-Z0-9_]*)[ \t]*=[ \t]*(\S.*)$/gim,
    keep: (m) => (isNotASecret(m[2]) ? m[0] : `${m[1]}=${REDACTED}`),
  },
  // "api_key": "…" and api_key: … in JSON and YAML.
  //
  // The value is skipped when it cannot be a secret. `const secret = false;`
  // and `password: string` are a boolean and a type annotation, and masking
  // them turned readable code into noise for no gain. NOT_A_SECRET holds the
  // literals and type names that make the match a false positive.
  {
    re: /("?\b\w*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)\b"?)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    keep: (m) => (isNotASecret(m[3]) ? m[0] : `${m[1]}${m[2]}${REDACTED}`),
  },
  // Authorization headers, however they are written.
  {
    re: /\b(authorization|proxy-authorization)(\s*:\s*)(bearer\s+)?\S+/gi,
    keep: (m) => `${m[1]}${m[2]}${m[3] ?? ""}${REDACTED}`,
  },
  // Private key blocks: everything between the markers goes.
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    keep: () => REDACTED,
  },
  // A credential sitting in a URL, which is how a git remote or a database
  // connection string carries one. The user survives, since it is often the
  // only thing identifying which service this was.
  {
    re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi,
    keep: (m) => `${m[1]}${m[2]}:${REDACTED}@`,
  },
  // Tokens with a recognisable prefix, which is how most services issue them.
  { re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, keep: () => REDACTED },
  // Stripe and the others that separate with an underscore rather than a dash.
  { re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, keep: () => REDACTED },
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, keep: () => REDACTED },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, keep: () => REDACTED },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, keep: () => REDACTED },
  // GitLab, which is this user's main forge, so its token is the likely one.
  { re: /\bglpat-[A-Za-z0-9_-]{16,}/g, keep: () => REDACTED },
  { re: /\bgl(?:dt|rt|soat|cbt)-[A-Za-z0-9_-]{16,}/g, keep: () => REDACTED },
  // Google, npm, Hugging Face. The last one matters here: this app downloads
  // models, so a Hub token is a credential the agent plausibly reads.
  { re: /\bAIza[0-9A-Za-z_-]{30,}/g, keep: () => REDACTED },
  { re: /\bnpm_[A-Za-z0-9]{30,}/g, keep: () => REDACTED },
  { re: /\bhf_[A-Za-z0-9]{20,}/g, keep: () => REDACTED },
  // A JSON Web Token, which carries claims in the clear and a signature.
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, keep: () => REDACTED },
];

/**
 * Replace what looks like a credential. Returns the text and a count.
 *
 * Each rule runs on the pieces BETWEEN the marks already placed, never across
 * one. Without that, rules ate each other's output: rule 1 turned
 * `OPENAI_API_KEY=sk-…` into `OPENAI_API_KEY=[removed by Galactus]`, then rule 2
 * recognised the name again, matched `[removed` as the value, and replaced only
 * that, leaving `OPENAI_API_KEY=[removed by Galactus] by Galactus]` in every
 * exported .env. Splitting on the mark makes the result independent of the
 * order the rules happen to be written in, which is the property that keeps
 * holding when the next rule is added.
 */
export function redact(text: string): { text: string; removed: number } {
  let out = text;
  let removed = 0;
  for (const rule of RULES) {
    out = out
      .split(REDACTED)
      .map((piece) =>
        piece.replace(rule.re, (...args) => {
          const m = args.slice(0, -2) as unknown as RegExpMatchArray;
          const replaced = rule.keep(m);
          // A rule can decline: isNotASecret returns the match untouched, and
          // that is not a removal.
          if (replaced !== m[0]) removed += 1;
          return replaced;
        }),
      )
      .join(REDACTED);
  }
  return { text: out, removed };
}
