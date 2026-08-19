// What must not leave the app inside an exported conversation.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { REDACTED, redact } from "../../src/redact.js";

test("an env file keeps its names and loses its values", () => {
  // The name is what makes the export useful and is not the secret.
  //
  // Compared whole, not with match(). The first version of this test asserted
  // the line CONTAINED the mark, which stayed true while two rules chewed on
  // each other's output and shipped
  // "OPENAI_API_KEY=[removed by Galactus] by Galactus]" for months.
  const out = redact("OPENAI_API_KEY=sk-abcdefghijklmnopqrst\nexport DB_PASSWORD=hunter2\nPORT=3000");
  assert.equal(
    out.text,
    `OPENAI_API_KEY=${REDACTED}\nexport DB_PASSWORD=${REDACTED}\nPORT=3000`,
    "an ordinary variable is not a secret, and a mark is written exactly once",
  );
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

test("a name that cannot hold a secret keeps its value", () => {
  // These read as credentials to a regex and are a flag, a type and an empty
  // field to a person. Masking them made exported code unreadable for nothing.
  for (const line of [
    "const secret = false;",
    "let password: string;",
    "api_key: null",
    'client_secret: ""',
    "ACCESS_TOKEN = undefined",
    "password: changeme",
  ]) {
    assert.equal(redact(line).text, line, line);
  }
});

test("the forges and registries this app actually talks to", () => {
  for (const secret of [
    "glpat-ABCDEFGHIJKLMNOPQRST",
    "hf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "npm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "AIzaSyAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "sk_live_aaaaaaaaaaaaaaaaaaaa",
  ]) {
    const out = redact(`the value is ${secret} and that is all`);
    assert.ok(!out.text.includes(secret), secret);
  }
});

test("a credential inside a URL loses the password and keeps the rest", () => {
  // A git remote or a database string carries one, and both get pasted whole.
  const out = redact("git clone https://someuser:s3cr3tpassword@gitlab.com/team/repo.git");
  assert.ok(!out.text.includes("s3cr3tpassword"));
  assert.match(out.text, /someuser/, "who it was is not the secret");
  assert.match(out.text, /gitlab\.com\/team\/repo\.git/);
});

test("masking twice changes nothing the second time", () => {
  // The export masks at the source and once more over the assembled file.
  const once = redact("OPENAI_API_KEY=sk-abcdefghijklmnopqrst").text;
  assert.equal(redact(once).text, once);
});
