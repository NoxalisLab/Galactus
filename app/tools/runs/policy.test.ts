// What an unattended run may and may not grant itself.
// @ts-ignore Node's built-in runner is used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";
// @ts-ignore Node types are deliberately not added to the app dependency graph.
import fs from "node:fs";

import {
  RUN_PERMISSION_KINDS,
  RUN_POLICIES,
  Run,
  type RunPermissionKind,
  type RunPolicy,
  decideGate,
  policyGrants,
} from "../../src/runs.js";

const clock = (t = 0) => () => t;

function newRun(policy: RunPolicy): Run {
  return Run.create({
    id: "r1",
    name: "audit",
    limits: { maxTurns: 10, maxWallClockMs: 60_000, policy },
    now: clock(0),
  });
}

/**
 * A run with a turn actually open.
 *
 * gate() refuses outside a running turn, and that guard is a security property
 * rather than a convenience: a finished, cancelled, exhausted or blocked run
 * used to answer allow. Tests that want to exercise the POLICY must therefore
 * put the run where a policy decision is legitimate, exactly as the driver
 * does, instead of asking the gate a question it should never be asked.
 */
function runInTurn(policy: RunPolicy): Run {
  const run = newRun(policy);
  // beginTurn moves queued -> running on its own; there is no separate start.
  run.beginTurn();
  return run;
}

test("an elevated request is refused under EVERY policy, including autonomous", () => {
  for (const policy of RUN_POLICIES) {
    for (const kind of RUN_PERMISSION_KINDS) {
      const outcome = decideGate(policy, { kind, detail: "sudo rm -rf /", elevated: true });
      assert.deepEqual(
        outcome,
        { decision: "refuse", reason: "elevated" },
        `${policy}/${kind} must refuse an elevated request outright`,
      );
    }
  }
});

test("elevated is refused and never merely blocked, so no resume can turn it into a grant", () => {
  const run = newRun("autonomous");
  const outcome = run.gate({ kind: "fs_write", detail: "/etc/hosts", elevated: true });
  assert.equal(outcome.decision, "refuse");
  // A block is resumable, a refusal is not. Confusing the two is exactly how an
  // unattended run would end up being handed what it may not have.
  assert.notEqual(outcome.decision, "block");
  assert.equal(run.getState(), "queued", "a refusal does not stop the run");
});

test("read_only grants nothing that changes anything", () => {
  const grants = policyGrants("read_only");
  for (const kind of ["fs_write", "shell", "git", "mcp", "agent", "memory", "obsidian", "code", "web"] as const) {
    assert.ok(!grants.includes(kind), `read_only must not grant ${kind}`);
    assert.deepEqual(decideGate("read_only", { kind, detail: "x", elevated: false }), {
      decision: "block",
      reason: "policy",
    });
  }
  assert.deepEqual(decideGate("read_only", { kind: "fs_read", detail: "/tmp/a", elevated: false }), {
    decision: "allow",
  });
});

// The grant tables, written out rather than read from the module.
//
// The tests here used to name a handful of kinds each: code allowed under
// propose, fs_write blocked, shell blocked. Widening propose to grant `mcp`
// passed all of them, because no test said anything about mcp under propose. A
// policy is defined as much by what it withholds as by what it grants, so the
// table is stated in full and both halves are checked. Adding a kind to
// RUN_PERMISSION_KINDS fails here until someone decides, per policy, which side
// it falls on. That is the point.
const EXPECTED_GRANTS: Record<RunPolicy, readonly RunPermissionKind[]> = {
  read_only: ["fs_read", "fs_list", "conversations"],
  propose: ["fs_read", "fs_list", "conversations", "web", "code"],
  autonomous: [
    "fs_read", "fs_list", "conversations", "web", "code",
    "fs_write", "shell", "obsidian", "memory", "mcp", "agent", "git",
  ],
};

test("each policy grants exactly its table, and withholds everything else", () => {
  for (const policy of RUN_POLICIES) {
    const expected = EXPECTED_GRANTS[policy];
    for (const kind of RUN_PERMISSION_KINDS) {
      const shouldAllow = expected.includes(kind);
      assert.deepEqual(
        decideGate(policy, { kind, detail: "x", elevated: false }),
        shouldAllow ? { decision: "allow" } : { decision: "block", reason: "policy" },
        shouldAllow ? `${policy} must grant ${kind}` : `${policy} must NOT grant ${kind}`,
      );
    }
    assert.deepEqual(
      policyGrants(policy).slice().sort(),
      expected.slice().sort(),
      `the grants ${policy} reports must be the grants it applies`,
    );
  }
});

test("every declared kind appears in the table above", () => {
  // Otherwise a new kind could be added to the enum, be granted by autonomous,
  // and never be looked at by anyone.
  for (const kind of RUN_PERMISSION_KINDS) {
    const seen = RUN_POLICIES.some((p) => EXPECTED_GRANTS[p].includes(kind));
    assert.ok(seen, `${kind} is declared but no policy decides on it`);
  }
});

test("propose grants code proposals but never a real write or a shell", () => {
  // Kept next to the table because it is the distinction the policy exists for:
  // a proposal lands in the editor and a human accepts a hunk, which is what
  // makes it grantable to a run nobody is watching.
  assert.deepEqual(decideGate("propose", { kind: "code", detail: "/w/src/a.ts", elevated: false }), {
    decision: "allow",
  });
  assert.deepEqual(decideGate("propose", { kind: "fs_write", detail: "/w/src/a.ts", elevated: false }), {
    decision: "block",
    reason: "policy",
  });
  assert.deepEqual(decideGate("propose", { kind: "shell", detail: "ls", elevated: false }), {
    decision: "block",
    reason: "policy",
  });
});

test("autonomous covers every ordinary kind and stops at what the gate shows every time", () => {
  for (const kind of RUN_PERMISSION_KINDS) {
    assert.deepEqual(
      decideGate("autonomous", { kind, detail: "x", elevated: false }),
      { decision: "allow" },
      `autonomous must cover the ordinary ${kind}`,
    );
  }
  // git push carries noAlways in agent.ts because the user must see the branch
  // and the count EVERY time. An unattended run cannot show it to anyone.
  assert.deepEqual(
    decideGate("autonomous", { kind: "git", detail: "push origin main (3)", elevated: false, noAlways: true }),
    { decision: "block", reason: "every_time" },
  );
});

test("a policy block is what a human could still answer, so it names policy and not the request", () => {
  const run = runInTurn("read_only");
  const outcome = run.gate({ kind: "shell", detail: "npm test", elevated: false });
  assert.deepEqual(outcome, { decision: "block", reason: "policy" });
});

test("every gate call is recorded, allowed ones included", () => {
  const run = runInTurn("propose");
  run.gate({ kind: "fs_read", detail: "/a", elevated: false });
  run.gate({ kind: "shell", detail: "rm -rf /", elevated: true });
  const gates = run.transcript().filter((e) => e.type === "gate");
  assert.equal(gates.length, 2, "an audit that only kept denials proves nothing");
  assert.deepEqual(
    gates.map((e) => (e.type === "gate" ? e.decision : "")),
    ["allow", "refuse"],
  );
});

test("the permission kinds mirror agent.ts exactly", () => {
  // runs.ts cannot import agent.ts (api.ts and the DOM come with it), so the
  // union is restated there. A kind added to the gate and forgotten here would
  // fall through the policy tables as an unknown string; this reads the real
  // source and fails the moment the two drift.
  const agentSrc = fs.readFileSync(new URL("../../../../../src/agent.ts", import.meta.url), "utf8");
  const start = agentSrc.indexOf("export type PermissionKind =");
  assert.ok(start >= 0, "PermissionKind declaration not found in agent.ts");
  const end = agentSrc.indexOf(";", start);
  assert.ok(end > start, "PermissionKind declaration is not terminated");
  const declared = [...agentSrc.slice(start, end).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(declared.length > 0, "no kinds parsed out of agent.ts");
  assert.deepEqual(
    [...declared].sort(),
    [...RUN_PERMISSION_KINDS].sort(),
    "RUN_PERMISSION_KINDS has drifted from agent.ts PermissionKind",
  );
});

test("every declared kind is decided by every policy, none falls through", () => {
  for (const policy of RUN_POLICIES) {
    for (const kind of RUN_PERMISSION_KINDS as readonly RunPermissionKind[]) {
      const outcome = decideGate(policy, { kind, detail: "x", elevated: false });
      assert.ok(
        outcome.decision === "allow" || outcome.decision === "block",
        `${policy}/${kind} produced no decision`,
      );
    }
  }
});
