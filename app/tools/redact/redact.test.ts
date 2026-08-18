// What must not leave the app inside an exported conversation.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { REDACTED, redact } from "../../src/redact.js";

test("an env file keeps its names and loses its values", () => {
  // The name is what makes the export useful and is not the secret.
  const out = redact("OPENAI_API_KEY=sk-abcdefghijklmnopqrst\nexport DB_PASSWORD=hunter2\nPORT=3000");
  assert.match(out.text, /OPENAI_API_KEY=\[removed by Galactus\]/);
  assert.match(out.text, /DB_PASSWORD=\[removed by Galactus\]/);
  assert.match(out.text, /PORT=3000/, "an ordinary variable is not a secret");
});

test("json and yaml credentials are masked wherever they sit", () => {
  const out = redact('{"api_key": "abc123", "name": "demo", "client_secret": "zzz"}');
  assert.match(out.text, /"api_key": \[removed by Galactus\]/);
  assert.match(out.text, /"client_secret": \[removed by Galactus\]/);
  assert.match(out.text, /"name": "demo"/);
});

test("the token shapes that are actually leaked", () => {
  for (const secret of [
    "sk-proj-aaaaaaaaaaaaaaaaaaaaaaaa",
    "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "xoxb-1234567890-abcdefghij",
    "AKIAIOSFODNN7EXAMPLE",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijkl",
  ]) {
    const out = redact(`the value is ${secret} and that is all`);
    assert.ok(!out.text.includes(secret), secret);
    assert.equal(out.removed >= 1, true);
  }
});

test("an authorization header loses its value and keeps its shape", () => {
  const out = redact("Authorization: Bearer abcdef123456\nContent-Type: application/json");
  assert.match(out.text, /Authorization: Bearer \[removed by Galactus\]/);
  assert.match(out.text, /Content-Type: application\/json/);
});

test("a private key block goes whole", () => {
  const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----";
  const out = redact(`before\n${key}\nafter`);
  assert.equal(out.text, `before\n${REDACTED}\nafter`);
});

test("ordinary prose is left exactly as it was", () => {
  // Over-eager masking makes the export unreadable, and then nobody exports.
  const prose = "The function returns a key from the map, and the password field is empty in the form.";
  assert.equal(redact(prose).text, prose);
  assert.equal(redact(prose).removed, 0);
  const code = "const total = items.length * 2;\nreturn { ok: true };";
  assert.equal(redact(code).text, code);
});
