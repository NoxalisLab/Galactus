// Where the bar sits for "worth a reusable procedure".
//
// The catalogue is pasted into every request, so a skill that should not exist
// is a cost paid on every turn of every conversation for as long as the app is
// installed. These tests are the record of what was decided to be noise, case
// by case. Each one names the rule it pins, so a future relaxation is a
// deliberate act with a failing test attached rather than a quiet drift.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import {
  MAX_BANK,
  MIN_SIGHTINGS,
  assessTurn,
  commandVerb,
  recordSighting,
  turnSignature,
  type TurnObservation,
  type TurnStep,
} from "../../src/learned.js";

function step(tool: string, detail = "", ok = true, denied = false): TurnStep {
  return { tool, detail, ok, denied };
}

/** A turn that clears every rule, so each test can break exactly one thing. */
function goodTurn(): TurnObservation {
  return {
    steps: [
      step("read_file", "/p/pkg.json"),
      step("run_command", "npm test"),
      step("read_file", "/p/src/a.ts"),
      step("write_file", "/p/src/a.ts"),
      step("run_command", "npm test"),
      step("run_command", "git diff --stat"),
    ],
    answered: true,
    underSkill: false,
    sightings: MIN_SIGHTINGS,
    bankSignatures: [],
    bankSize: 0,
  };
}

test("the reference turn is accepted, so every refusal below is the rule under test", () => {
  const v = assessTurn(goodTurn());
  assert.equal(v.worth, true);
  assert.equal(v.reason, "accepted");
});

test("R1 four tool calls is an answer, not a procedure", () => {
  const obs = goodTurn();
  const v = assessTurn({ ...obs, steps: obs.steps.slice(0, 4) });
  assert.equal(v.worth, false);
  assert.equal(v.reason, "too_few_steps");
});

test("R1 bookkeeping calls do not pad the count", () => {
  // update_plan is how a model announces itself, not something it did. Five
  // plan updates and two reads must not read as a seven-step procedure.
  const v = assessTurn({
    ...goodTurn(),
    steps: [
      step("update_plan"),
      step("update_plan"),
      step("update_plan"),
      step("update_plan"),
      step("read_file", "/p/a"),
      step("read_file", "/p/b"),
    ],
  });
  assert.equal(v.reason, "too_few_steps");
});

test("R2 a turn the user stopped teaches the abandonment", () => {
  assert.equal(assessTurn({ ...goodTurn(), answered: false }).reason, "unfinished");
});

test("R3 one denied step disqualifies the whole turn", () => {
  // Encoding a sequence that contains a refused step means re-proposing that
  // exact step forever, to the person who already said no to it once.
  const obs = goodTurn();
  const steps = [...obs.steps];
  steps[3] = step("write_file", "/p/src/a.ts", false, true);
  assert.equal(assessTurn({ ...obs, steps }).reason, "refused_step");
});

test("R4 a turn that mostly failed is a procedure for flailing", () => {
  const obs = goodTurn();
  const steps = obs.steps.map((s, i) => (i % 2 === 0 ? { ...s, ok: false } : s));
  assert.equal(assessTurn({ ...obs, steps }).reason, "failed_steps");
});

test("R4 one failure in six is a real step of a real procedure", () => {
  // A procedure whose second step legitimately fails and is recovered from is
  // exactly the kind worth writing down. The rule is a ratio, not a flag.
  const obs = goodTurn();
  const steps = [...obs.steps];
  steps[1] = { ...steps[1], ok: false };
  assert.equal(assessTurn({ ...obs, steps }).worth, true);
});

test("R5 read a file then answer is refused, however many files", () => {
  // The case the brief names. Six reads, a search and an answer: this is what
  // the agent does by default and it needs no instructions to do it again.
  const v = assessTurn({
    ...goodTurn(),
    steps: [
      step("read_file", "/p/a"),
      step("read_file", "/p/b"),
      step("list_directory", "/p"),
      step("search_knowledge", "budget"),
      step("read_file", "/p/c"),
      step("read_document", "/p/d.pdf"),
    ],
  });
  assert.equal(v.worth, false);
  assert.equal(v.reason, "no_effect");
});

test("R5 an MCP connector call counts as acting on the world", () => {
  const v = assessTurn({
    ...goodTurn(),
    steps: [
      step("read_file", "/p/a"),
      step("mcp__github__create_issue", "{}"),
      step("read_file", "/p/b"),
      step("mcp__github__add_label", "{}"),
      step("list_directory", "/p"),
    ],
  });
  assert.equal(v.worth, true);
});

test("R6 five calls to two tools is one habit, not a method", () => {
  const v = assessTurn({
    ...goodTurn(),
    steps: [
      step("run_command", "git add -A"),
      step("run_command", "git commit -m x"),
      step("run_command", "git log -1"),
      step("write_file", "/p/a"),
      step("run_command", "git status"),
    ],
  });
  assert.equal(v.reason, "too_uniform");
});

test("R7 a turn a shipped skill already drove needs no second procedure", () => {
  assert.equal(assessTurn({ ...goodTurn(), underSkill: true }).reason, "already_covered");
});

test("R8 a turn that read the open web can never become a skill", () => {
  // The laundering path: text an attacker controls enters the transcript, the
  // procedure is distilled from it, and a one-shot injection becomes a
  // permanent instruction. Cut upstream of the content filter, not by it.
  const obs = goodTurn();
  const steps = [...obs.steps, step("fetch_url", "https://example.test/readme")];
  const v = assessTurn({ ...obs, steps });
  assert.equal(v.worth, false);
  assert.equal(v.reason, "untrusted_input");
});

test("R9 the first time a shape is seen, nothing is written", () => {
  assert.equal(assessTurn({ ...goodTurn(), sightings: 1 }).reason, "first_sighting");
  assert.equal(assessTurn({ ...goodTurn(), sightings: MIN_SIGHTINGS }).worth, true);
});

test("R10 the same shape is never banked twice", () => {
  const obs = goodTurn();
  const sig = turnSignature(obs.steps);
  assert.equal(assessTurn({ ...obs, bankSignatures: [sig] }).reason, "duplicate");
});

test("R11 the bank has a hard ceiling", () => {
  assert.equal(assessTurn({ ...goodTurn(), bankSize: MAX_BANK }).reason, "bank_full");
});

// ---------------------------------------------------------------- signature

test("the signature ignores arguments, so the same work in two projects matches", () => {
  const a = turnSignature([
    step("run_command", "npm test"),
    step("write_file", "/one/src/a.ts"),
    step("read_file", "/one/src/a.ts"),
  ]);
  const b = turnSignature([
    step("read_file", "/two/lib/z.ts"),
    step("run_command", "npm test -- --watch=false"),
    step("write_file", "/two/lib/z.ts"),
  ]);
  assert.equal(a, b);
});

test("the signature separates different work", () => {
  const a = turnSignature([step("run_command", "npm test"), step("write_file", "/a")]);
  const b = turnSignature([step("run_command", "terraform apply"), step("write_file", "/a")]);
  assert.notEqual(a, b);
});

test("the signature never carries a path off the user's machine", () => {
  const sig = turnSignature([
    step("run_command", "/Users/someone/secret-tool/run.sh --key=abc"),
    step("write_file", "/Users/someone/notes.md"),
    step("read_file", "/Users/someone/notes.md"),
  ]);
  assert.equal(sig.includes("someone"), false);
  assert.equal(sig.includes("abc"), false);
});

test("the command verb skips a leading environment assignment", () => {
  assert.equal(commandVerb("CI=1 npm test"), "npm");
  assert.equal(commandVerb("/opt/homebrew/bin/rg foo"), "rg");
  assert.equal(commandVerb(""), "?");
});

// ---------------------------------------------------------------- ledger

test("a shape has to come back before it counts as recurring", () => {
  let ledger: Record<string, number> = {};
  let r = recordSighting(ledger, "a+b");
  assert.equal(r.count, 1);
  ledger = r.ledger;
  r = recordSighting(ledger, "a+b");
  assert.equal(r.count, MIN_SIGHTINGS);
});

test("the ledger stays bounded and never drops the shape just seen", () => {
  let ledger: Record<string, number> = {};
  for (let i = 0; i < 400; i++) ledger = recordSighting(ledger, `shape-${i}`).ledger;
  const r = recordSighting(ledger, "shape-399");
  assert.ok(Object.keys(r.ledger).length <= 200);
  assert.equal(r.ledger["shape-399"], 2);
});

test("an empty signature is never recorded", () => {
  const r = recordSighting({}, "");
  assert.equal(Object.keys(r.ledger).length, 0);
  assert.equal(r.count, 0);
});
