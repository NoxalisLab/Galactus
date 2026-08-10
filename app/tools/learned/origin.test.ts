// Attended and unattended did not produce the same thing, and the rule differs.
//
// A skill distilled from an app-mode conversation was produced under someone's
// eyes: a person saw each tool card go by and answered the gate, or chose the
// autonomy level that answered for them. A skill distilled from an unattended
// run was watched by nobody. runs.ts kept that run safe, but nothing in it put
// a human in front of the resulting TEXT before it starts steering later
// conversations.
//
// So: attended enters the catalogue, unattended waits for a human. The
// asymmetry is deliberate, and so is the direction of the default.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import {
  initialState,
  isUsable,
  parseSkillFile,
  renderSkillFile,
  type AuthoredSkill,
} from "../../src/learned.js";

function skill(over: Partial<AuthoredSkill> = {}): AuthoredSkill {
  return {
    slug: "npm-test-then-fix",
    description: "Run the suite, fix the first failure, re-run",
    origin: "conversation",
    state: "active",
    created: "2026-08-10",
    signature: "read_file+run:npm+write_file",
    body: "## 1. Run\n\n```\nnpm test\n```\n\n## Verification\n\n```\nnpm test\n```\n",
    ...over,
  };
}

test("nothing the agent writes is callable before a human reads it", () => {
  // An earlier version let a conversation-born skill in on its own, on the
  // grounds that someone had watched the task. Watching steps go by one at a
  // time is not the same act as reading the generalisation distilled from them:
  // every gate answer in that conversation was about one command on one path,
  // and none of them was about a text that will steer the model months later in
  // a project that did not exist yet. Same review for both.
  for (const origin of ["conversation", "run"] as const) {
    assert.equal(initialState(origin), "pending", `${origin} must wait for a human`);
    assert.equal(
      isUsable(skill({ origin, state: initialState(origin) })),
      false,
      `${origin} must not be callable on its own`,
    );
  }
});

test("the origin is still recorded, because the reviewer needs it", () => {
  // Dropping the distinction would be the other wrong answer: someone deciding
  // whether to approve a procedure needs to know whether anyone was there when
  // it was produced.
  const watched = skill({ origin: "conversation", state: initialState("conversation") });
  const unwatched = skill({ origin: "run", state: initialState("run") });
  assert.equal(watched.origin, "conversation");
  assert.equal(unwatched.origin, "run");
  assert.notEqual(watched.origin, unwatched.origin);
});

test("approval is a state change on the same file, so the provenance survives it", () => {
  // Approving must not launder the origin. A user who comes back in six months
  // has to still be able to see that this one came out of a machine nobody was
  // sitting at.
  const pending = skill({ origin: "run", state: "pending" });
  const approved = parseSkillFile(pending.slug, renderSkillFile({ ...pending, state: "active" }));
  assert.ok(approved);
  assert.equal(approved!.state, "active");
  assert.equal(approved!.origin, "run");
  assert.equal(isUsable(approved!), true);
});

test("a file that never declared an origin counts as unattended", () => {
  // The default that matters. agent.ts cannot tell whose hand answers the
  // permission dialog, so the construction site declares it and omission means
  // the strict path: a caller that forgets gets a review, not a silent entry.
  const md = renderSkillFile(skill()).replace(/^origin:.*$/m, "").replace(/^state:.*$/m, "");
  const back = parseSkillFile("npm-test-then-fix", md);
  assert.ok(back);
  assert.equal(back!.origin, "run");
  assert.equal(back!.state, "pending");
});
