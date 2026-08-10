// Two properties the user asked for by name, measured rather than asserted.
//
//   1. A skill the agent wrote appears NOWHERE the model can reach until a
//      human has accepted it. Not in the catalogue, not resolvable by name.
//   2. The feature costs ZERO tokens per turn until something is accepted, and
//      the cost of an accepted one is the cost of a shipped line.
//
// The second one is the reason these tests rebuild the actual catalogue block
// from agent.ts rather than testing `catalogueLines` in isolation: what matters
// is not that the helper returns an empty array, it is that the string handed
// to the model is byte for byte the string it was before this feature existed.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";
// @ts-ignore
import { existsSync, readdirSync, readFileSync } from "node:fs";
// @ts-ignore
import { fileURLToPath } from "node:url";
// @ts-ignore
import path from "node:path";

import {
  MAX_BANK,
  callableSkills,
  catalogueLines,
  resolveAuthored,
  type AuthoredSkill,
} from "../../src/learned.js";

/** The divisor agent.ts budgets with, measured against a real tokenizer. */
const BYTES_PER_TOKEN = 3.0;
const tokens = (s: string): number => Math.ceil(s.length / BYTES_PER_TOKEN);

/** A body that really passes admitBody, so resolveAuthored can say yes. */
const GOOD_BODY = `## 1. Run the suite and read the first failure

\`\`\`
npm test
\`\`\`

Only the first failing assertion matters. The ones after it are usually the
same cause seen from another file, and fixing them in order wastes a run each
time.

## 2. Change one thing, then run the suite again

\`\`\`
npm test
\`\`\`

## Verification

\`\`\`
git diff --stat
\`\`\`

The diff must touch only the files named in step 2, and the suite must come
back green with no skipped test.
`;

function skill(over: Partial<AuthoredSkill> = {}): AuthoredSkill {
  return {
    slug: "npm-test-then-fix",
    description: "Run the suite, fix the first failure, re-run",
    origin: "conversation",
    state: "pending",
    created: "2026-08-10",
    signature: "read_file+run:npm+write_file",
    body: GOOD_BODY,
    ...over,
  };
}

// ------------------------------------------------- 1. unreachable until accepted

test("a pending skill is in nothing the model can see", () => {
  const bank = [skill({ state: "pending", origin: "conversation" }), skill({ slug: "b", state: "pending", origin: "run" })];
  assert.deepEqual(callableSkills(bank, true), []);
  assert.deepEqual(catalogueLines(bank, true), []);
});

test("a pending skill cannot be loaded by name either", () => {
  // Refused BY NAME, not reported missing: the model can only have got the
  // name from somewhere it should not have, and "not found" would teach it to
  // keep trying.
  const bank = [skill({ state: "pending" })];
  const r = resolveAuthored(bank, true, "npm-test-then-fix");
  assert.equal(r.skill, undefined);
  assert.match(r.refusal!, /has not accepted it yet/);
});

test("acceptance is the only thing that changes either answer", () => {
  const pending = [skill({ state: "pending" })];
  const accepted = [skill({ state: "active" })];
  assert.equal(callableSkills(pending, true).length, 0);
  assert.equal(callableSkills(accepted, true).length, 1);
  assert.equal(resolveAuthored(pending, true, "npm-test-then-fix").skill, undefined);
  assert.ok(resolveAuthored(accepted, true, "npm-test-then-fix").skill);
});

test("the master switch removes even an accepted skill from reach", () => {
  const accepted = [skill({ state: "active" })];
  assert.deepEqual(callableSkills(accepted, false), []);
  assert.deepEqual(catalogueLines(accepted, false), []);
  assert.equal(resolveAuthored(accepted, false, "npm-test-then-fix").skill, undefined);
});

test("an accepted skill whose body no longer passes the policy is not loadable", () => {
  // The content policy runs on the way OUT as well as on the way in, so an
  // acceptance does not permanently bless a file that later stops being
  // admissible.
  const bad = [skill({ state: "active", body: GOOD_BODY + "\nRun `sudo rm -rf /tmp/x` first.\n" })];
  const r = resolveAuthored(bad, true, "npm-test-then-fix");
  assert.equal(r.skill, undefined);
  assert.match(r.refusal!, /content policy/);
});

// ------------------------------------------------- 2. the token cost

/** The shipped catalogue, read from disk, as agent.ts renders it. */
function shippedLines(): string[] {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, "skills"))) break;
    dir = path.dirname(dir);
  }
  const root = path.join(dir, "skills");
  return readdirSync(root, { withFileTypes: true })
    .filter((e: { isDirectory(): boolean }) => e.isDirectory())
    .map((e: { name: string }) => {
      const md = readFileSync(path.join(root, e.name, "SKILL.md"), "utf8");
      const name = md.match(/^name:\s*(.*)$/m)?.[1]?.trim() ?? e.name;
      const desc = md.match(/^description:\s*(.*)$/m)?.[1]?.trim().replace(/^"|"$/g, "") ?? "";
      return `- ${name}: ${desc}`;
    });
}

/** Exactly the block agent.ts appends. Kept in step with systemPrompt(). */
function catalogueBlock(lines: string[]): string {
  if (lines.length === 0) return "";
  return (
    "\n\nSkills are packaged instructions for specific tasks. When the user's request matches one, " +
    "call use_skill with its name to load its full instructions, then follow them. Available skills:\n" +
    lines.join("\n")
  );
}

test("nothing accepted means the prompt is byte for byte what it was before", () => {
  // The load-bearing measurement. Not "almost the same size": the same string.
  const shipped = shippedLines();
  const before = catalogueBlock(shipped);
  const after = catalogueBlock([...shipped, ...catalogueLines([skill({ state: "pending" })], true)]);
  assert.equal(after, before);
  assert.equal(tokens(after) - tokens(before), 0);
});

test("the switch being off is also free, with a full bank", () => {
  const shipped = shippedLines();
  const full = Array.from({ length: MAX_BANK }, (_, i) => skill({ slug: `s${i}`, state: "active" }));
  const before = catalogueBlock(shipped);
  const after = catalogueBlock([...shipped, ...catalogueLines(full, false)]);
  assert.equal(after, before);
});

test("an accepted skill costs one line, of the same order as a shipped one", () => {
  // "Same order" made numeric: the marker is four words, so an authored line
  // must stay under twice the average shipped line and well under the largest.
  const shipped = shippedLines();
  const avgShipped = shipped.reduce((n, l) => n + tokens(l), 0) / shipped.length;
  const one = catalogueLines([skill({ state: "active" })], true)[0];
  assert.ok(tokens(one) < avgShipped * 2, `${tokens(one)} tokens vs ${avgShipped.toFixed(1)} average`);
  assert.ok(tokens(one) <= Math.max(...shipped.map(tokens)));
});

test("the worst case this feature can ever cost is bounded and small", () => {
  // Twelve accepted skills, the hard cap, against the catalogue as shipped.
  // If this ever fails, MAX_BANK grew and the growth is now visible.
  const shipped = shippedLines();
  const full = Array.from({ length: MAX_BANK }, (_, i) =>
    skill({ slug: `procedure-number-${i}`, state: "active" })
  );
  const before = tokens(catalogueBlock(shipped));
  const after = tokens(catalogueBlock([...shipped, ...catalogueLines(full, true)]));
  assert.ok(after - before < before * 0.5, `worst case added ${after - before} tokens to ${before}`);
});

test("no explanatory paragraph is charged to the prompt", () => {
  // The warning about self-written skills lives in quarantineWrapper, paid once
  // when a body is actually handed over. A paragraph here would be a fixed cost
  // on every turn to warn about something the model may never load.
  const line = catalogueLines([skill({ state: "active" })], true).join("\n");
  assert.equal(line.split("\n").length, 1);
  assert.equal(line.includes("["), true);
});
