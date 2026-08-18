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

const RULES: Array<{ re: RegExp; keep: (m: RegExpMatchArray) => string }> = [
  // KEY=value in an env file or in the output of `env`. The name is kept: it
  // is what makes the export useful, and it is not the secret.
  {
    re: /^([ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?|AUTH)[A-Z0-9_]*)[ \t]*=[ \t]*\S.*$/gim,
    keep: (m) => `${m[1]}=${REDACTED}`,
  },
  // "api_key": "…" and api_key: … in JSON and YAML.
  {
    re: /("?\b\w*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)\b"?)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    keep: (m) => `${m[1]}${m[2]}${REDACTED}`,
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
  // Tokens with a recognisable prefix, which is how most services issue them.
  { re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, keep: () => REDACTED },
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, keep: () => REDACTED },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, keep: () => REDACTED },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, keep: () => REDACTED },
  // A JSON Web Token, which carries claims in the clear and a signature.
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, keep: () => REDACTED },
];

/** Replace what looks like a credential. Returns the text and a count. */
export function redact(text: string): { text: string; removed: number } {
  let out = text;
  let removed = 0;
  for (const rule of RULES) {
    out = out.replace(rule.re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpMatchArray;
      removed += 1;
      return rule.keep(m);
    });
  }
  return { text: out, removed };
}
