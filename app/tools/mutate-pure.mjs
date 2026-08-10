// Prove the pure module tests can fail.
//
// tools/dom/mutate.mjs does this for the two view modules and
// tools/rust-mutate.mjs does it for the Rust side. This one covers the middle,
// which is where most of the app's rules actually live: runs.ts, rundrive.ts,
// update.ts, schedule.ts and learned.ts, six hundred odd tests that all run
// against import-free modules and none of which had ever been shown to be
// capable of going red.
//
// Same rules as the other two. Break the thing a test covers, watch that named
// test go red, put it back. A mutation that no longer matches EXACTLY once is
// reported as a failure rather than skipped.
//
// It mutates tools/<suite>/out/, which is generated and gitignored, so nothing
// here can leave a mark on the repository even if the process is killed
// halfway. Each suite compiles its own copy of the modules it tests, which is
// why the same source line appears under several paths below: mutating the
// copy the suite actually loads is what makes the mutation reach the test.
//
// Usage: node tools/mutate-pure.mjs [filter]
//   filter matches the group name, so `node tools/mutate-pure.mjs update` runs
//   only the updater mutations.
//
// Prerequisite: the suites must be compiled. `npm test` does it; so does
//   npx tsc -p tools/runs/tsconfig.json   (and the same for each suite below)

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * Each entry names the suite whose compiled copy is mutated, the file inside
 * it, the exact text to replace, and the test that must go from green to red.
 *
 * Naming ONE test rather than the suite is the point. A mutation that turns
 * some unrelated test red proves nothing about the test that is supposed to
 * own the rule, and "the suite went red" is how a rule ends up covered only by
 * accident.
 */
const MUTATIONS = [
  // ------------------------------------------------------- runs: the gate
  {
    group: "runs: elevated is refused before any policy table is consulted",
    suite: "runs",
    file: "out/src/runs.js",
    from: "    if (req.elevated)\n        return { decision: \"refuse\", reason: \"elevated\" };",
    to: "    if (false)\n        return { decision: \"refuse\", reason: \"elevated\" };",
    test: "an elevated request is refused under EVERY policy, including autonomous",
  },
  {
    group: "runs: a shown-every-time step blocks unless preauthorized",
    suite: "runs",
    file: "out/src/runs.js",
    from: "    if (req.noAlways && !preauthorizeEveryTime) {",
    to: "    if (false) {",
    test: "without it, an autonomous run still stops on a push",
  },
  {
    group: "runs: a permission belongs to a turn that is actually running",
    suite: "runs",
    file: "out/src/runs.js",
    from: "        const outOfTurn = isTerminal(this.state) || !this.turnInFlight",
    to: "        const outOfTurn = false",
    test: "a run that is not in a turn cannot be granted anything",
  },
  {
    group: "runs: one turn cannot outlive the wall clock it was given",
    suite: "runs",
    file: "out/src/runs.js",
    from: "        const expired = this.limits.maxWallClockMs - this.elapsedMs() <= 0",
    to: "        const expired = false",
    test: "one turn cannot outlive the wall clock it was given",
  },
  // ---------------------------------------------------- runs: the budget
  {
    group: "runs: the budget is checked BEFORE the turn is spent",
    suite: "runs",
    file: "out/src/runs.js",
    from: "        if (!budget.ok) {",
    to: "        if (false) {",
    test: "the last affordable turn runs and the next one is refused before it starts",
  },
  // ------------------------------------------- runs: restore is the audit
  {
    group: "runs: a snapshot that disagrees with its transcript is refused",
    suite: "runs",
    file: "out/src/runs.js",
    from: '                throw new Error("run limits disagree with the transcript: snapshot says " +',
    to: '                void ("run limits disagree with the transcript: snapshot says " +',
    test: "a snapshot cannot grant what the transcript says was never granted",
  },
  // ------------------------------------------------ rundrive: the grants
  {
    group: "rundrive: a grant is consulted only AFTER the gate has answered block",
    suite: "rundrive",
    file: "out/src/rundrive.js",
    // The exact defect this feature was fixed for, restored: consulting the
    // grant on any non-allow answer serves a cancelled run and a run past its
    // wall clock, because those come back as `refuse`, not as `block`.
    from: '                if (gated.decision === "block") {',
    to: '                if (gated.decision !== "allow") {',
    test: "a grant cannot serve a cancelled run",
  },
  {
    group: "rundrive: a grant does not extend the wall clock either",
    suite: "rundrive",
    file: "out/src/rundrive.js",
    from: '                if (gated.decision === "block") {',
    to: '                if (gated.decision !== "allow") {',
    test: "a grant cannot serve a run past its wall clock",
  },
  {
    group: "rundrive: a blockable step parks the run",
    suite: "rundrive",
    file: "out/src/rundrive.js",
    from: "                    if (acc.blockedOn === null)",
    to: "                    if (false)",
    test: "a blockable step parks the run instead of guessing",
  },
  {
    // This one was reported as an open finding for a while, on the grounds
    // that no test owned it. The test that owns it now asserts the
    // CONSEQUENCE rather than the call: a run that has parked has stopped
    // spending, so the tool result and the text the model produces after the
    // block reach neither the sink nor the transcript.
    //
    // It is not, and cannot be, the test named "only the first blockable step
    // is recorded": that one drives an agent built to IGNORE stop, on purpose,
    // so the recording rule is exercised instead of being hidden behind an
    // obedient fake.
    group: "rundrive: the model is cut off at the block",
    suite: "rundrive",
    file: "out/src/rundrive.js",
    from: "                    agent.stop();\n",
    to: "",
    test: "the model is cut off at the block, not left working past it",
  },
  // ------------------------------------------------------------- updater
  {
    group: "update: 0.1.10 is newer than 0.1.9",
    suite: "update",
    file: "out/src/update.js",
    // The trap in full: a string compare says "0.1.9" > "0.1.10" because "9"
    // sorts after "1". Comparing the patch as text is the shipped bug this
    // test exists to prevent.
    from: "    if (a.patch !== b.patch)\n        return a.patch < b.patch ? -1 : 1;",
    to: "    if (a.patch !== b.patch)\n        return String(a.patch) < String(b.patch) ? -1 : 1;",
    test: "the double digit patch is newer, which a string compare denies",
  },
  {
    group: "update: nothing restarts this process without a human",
    suite: "update",
    file: "out/src/update.js",
    from: "    if (!c.userInitiated)",
    to: "    if (false)",
    test: "nothing restarts this process without a human",
  },
  {
    group: "update: a human cannot restart over a running job either",
    suite: "update",
    file: "out/src/update.js",
    from: "    if (c.jobsInFlight > 0)",
    to: "    if (false)",
    test: "a human cannot restart over a running job either",
  },
  {
    group: "update: server mode never checks by itself",
    suite: "update",
    file: "out/src/update.js",
    from: '    return c.mode === "app";',
    to: "    return true;",
    test: "server mode never checks by itself",
  },
  // ------------------------------------------------------------- learned
  {
    group: "learned: a skill the agent wrote is not callable until approved",
    suite: "learned",
    file: "out/src/learned.js",
    from: 'export function isUsable(s) {\n    return s.state === "active";',
    to: "export function isUsable(s) {\n    return true;",
    test: "nothing the agent writes is callable before a human reads it",
  },
  {
    group: "learned: an elevated command anywhere in the body refuses the skill",
    suite: "learned",
    file: "out/src/learned.js",
    from: "        if (isElevatedCommand(c))",
    to: "        if (false)",
    test: "an elevated command in a fenced block refuses the whole skill",
  },
  {
    group: "learned: a command not in the transcript is not grounded",
    suite: "learned",
    file: "out/src/learned.js",
    from: "export function commandsAreGrounded(",
    to: "export function commandsAreGrounded(",
    skip: "no single-line lever; the grounding mutations below target the rule itself",
  },
  {
    group: "learned: a denied step sinks the whole turn",
    suite: "learned",
    file: "out/src/learned.js",
    from: '    if (steps.some((s) => s.denied))\n        return no("refused_step");',
    to: '    if (false)\n        return no("refused_step");',
    test: "R3 one denied step disqualifies the whole turn",
  },
  {
    group: "learned: a turn that used a shipped skill is already covered",
    suite: "learned",
    file: "out/src/learned.js",
    from: '    if (obs.underSkill)\n        return no("already_covered");',
    to: '    if (false)\n        return no("already_covered");',
    test: "R7 a turn a shipped skill already drove needs no second procedure",
  },
  {
    group: "learned: anything that touched the web is untrusted input",
    suite: "learned",
    file: "out/src/learned.js",
    from: '    if (obs.steps.some((s) => WEB_TOOLS.has(s.tool)))\n        return no("untrusted_input");',
    to: '    if (false)\n        return no("untrusted_input");',
    test: "R8 a turn that read the open web can never become a skill",
  },
  {
    group: "learned: a name may not collide with a shipped skill",
    suite: "learned",
    file: "out/src/learned.js",
    from: "export function collidesWithShipped(slug, shippedNames) {",
    to: "export function collidesWithShipped(slug, shippedNames) {\n    return false;",
    test: "no skill the agent writes can take the name of a shipped one",
  },
  // The other eight refusal rules. Three were mutated above; a claim of
  // "eleven rules" is worth exactly as much as the weakest of the eleven, so
  // each one gets its own lever and its own named test.
  {
    group: "learned R1: a turn too short to be a procedure",
    suite: "learned",
    file: "out/src/learned.js",
    from: '    if (steps.length < MIN_STEPS)\n        return no("too_few_steps");',
    to: '    if (false)\n        return no("too_few_steps");',
    test: "R1 four tool calls is an answer, not a procedure",
  },
  {
    group: "learned R2: a turn the user never let finish",
    suite: "learned",
    file: "out/src/learned.js",
    from: '    if (!obs.answered)\n        return no("unfinished");',
    to: '    if (false)\n        return no("unfinished");',
    test: "R2 a turn the user stopped teaches the abandonment",
  },
  {
    group: "learned R4: a turn that mostly failed",
    suite: "learned",
    file: "out/src/learned.js",
    from: '    if (failed * 3 > steps.length)\n        return no("failed_steps");',
    to: '    if (false)\n        return no("failed_steps");',
    test: "R4 a turn that mostly failed is a procedure for flailing",
  },
  {
    group: "learned R5: a turn that changed nothing",
    suite: "learned",
    file: "out/src/learned.js",
    from: '    if (steps.filter((s) => isEffectful(s.tool)).length < MIN_EFFECTFUL_STEPS)\n        return no("no_effect");',
    to: '    if (false)\n        return no("no_effect");',
    test: "R5 read a file then answer is refused, however many files",
  },
  {
    group: "learned R6: a turn that used too few distinct tools",
    suite: "learned",
    file: "out/src/learned.js",
    from: '    if (new Set(steps.map((s) => s.tool)).size < MIN_DISTINCT_TOOLS)\n        return no("too_uniform");',
    to: '    if (false)\n        return no("too_uniform");',
    test: "R6 five calls to two tools is one habit, not a method",
  },
  {
    group: "learned R9: a shape seen only once",
    suite: "learned",
    file: "out/src/learned.js",
    from: '    if (obs.sightings < MIN_SIGHTINGS)\n        return no("first_sighting");',
    to: '    if (false)\n        return no("first_sighting");',
    test: "R9 the first time a shape is seen, nothing is written",
  },
  {
    group: "learned R10: a shape already in the bank",
    suite: "learned",
    file: "out/src/learned.js",
    from: '    if (obs.bankSignatures.includes(signature))\n        return no("duplicate");',
    to: '    if (false)\n        return no("duplicate");',
    test: "R10 the same shape is never banked twice",
  },
  {
    group: "learned R11: the bank has a hard ceiling",
    suite: "learned",
    file: "out/src/learned.js",
    from: '    if (obs.bankSize >= MAX_BANK)\n        return no("bank_full");',
    to: '    if (false)\n        return no("bank_full");',
    test: "R11 the bank has a hard ceiling",
  },
  {
    group: "learned: a command the agent never ran is not grounded",
    suite: "learned",
    file: "out/src/learned.js",
    from: "        if (!pools.some((pool) => need.every((tk) => pool.has(tk)))) {",
    to: "        if (false) {",
    test: "a command the agent never ran is refused",
  },
  {
    group: "learned: fragments of two real commands cannot be stitched together",
    suite: "learned",
    file: "out/src/learned.js",
    from: "        if (!pools.some((pool) => need.every((tk) => pool.has(tk)))) {",
    to: "        if (!need.some((tk) => pools.some((pool) => pool.has(tk)))) {",
    test: "pieces of two real commands cannot be stitched into a third",
  },
  {
    group: "update: a manifest missing a field is refused",
    suite: "update",
    file: "out/src/update.js",
    from: "export function manifestProblems(raw) {",
    to: "export function manifestProblems(raw) {\n    if (raw && typeof raw === \"object\") return [];",
    test: "the four things a manifest must name are each required",
  },
  {
    group: "update: a plain http asset url is refused",
    suite: "update",
    file: "out/src/update.js",
    from: '!/^https:\\/\\//.test(e.url)',
    to: '!/^http/.test(e.url)',
    test: "a plain http asset url is refused",
  },
  // ------------------------------------------------------------ schedule
  {
    group: "schedule: a job cannot declare limits a run would refuse",
    suite: "schedule",
    file: "out/src/schedule.js",
    from: "export function jobLimits(",
    to: "export function jobLimits(",
    skip: "clamping is several lines; covered by the budget mutation below",
  },
  // ------------------------------------------------ engine failure messages
  {
    group: "engine-error: an out of memory decode is not left as three words",
    suite: "engine-error",
    file: "out/src/engine-error.js",
    from: '    if (v.kind !== "memory")\n        return null;',
    to: "    return null;",
    test: "an out of memory decode names memory, the mode, and the way out",
  },
  {
    group: "engine-error: a user already in eco is not told to switch to eco",
    suite: "engine-error",
    file: "out/src/engine-error.js",
    from: '    if (!v.can_step_down)\n        return { key: "engfail.memoryAtFloor", modeKey: "" };',
    to: "    if (false)\n        return { key: \"engfail.memoryAtFloor\", modeKey: \"\" };",
    test: "in eco there is no mode left, so the advice changes",
  },
  {
    group: "engine-error: an exceeded context is not a memory problem",
    suite: "engine-error",
    file: "out/src/engine-error.js",
    from: '    if (v.kind === "context")\n        return { key: "engfail.context", modeKey: "" };',
    to: "    if (false)\n        return { key: \"engfail.context\", modeKey: \"\" };",
    test: "an exceeded context is never dressed up as a memory problem",
  },
  {
    group: "engine-error: only the engine's own decode messages are rewritten",
    suite: "engine-error",
    file: "out/src/engine-error.js",
    from: "    return DECODE_MESSAGES.some((m) => low.includes(m));",
    to: "    return low.includes(\"error\");",
    test: "a failure that already explains itself is left alone",
  },
];

const FILTER = process.argv[2] ?? "";
const ACTIVE = MUTATIONS.filter((m) => !m.skip && (!FILTER || m.group.includes(FILTER)));

/** Run one named test inside one suite. "green" when it passed. */
function run(suite, testName) {
  const result = spawnSync(
    process.execPath,
    // The GLOB, spelled the way package.json spells it. Passing the directory
    // makes Node treat the path itself as a test file and report one failing
    // test called "tools/<suite>/out/tools/<suite>", which looks exactly like a
    // red test and is not one.
    ["--test", "--test-name-pattern", testName, `tools/${suite}/out/**/*.test.js`],
    { encoding: "utf8" },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  // The verdict is read off the line for THIS test, not off the totals.
  //
  // The totals are a trap and this harness fell into it: `node --test` counts
  // each FILE as a test, so a --test-name-pattern that matches nothing still
  // reports seven passed and zero failed. Six mutations were reported as
  // surviving on that basis when the truth was that the names were wrong and
  // no test had run at all. Requiring the name to appear on a result line is
  // the only reading that cannot be satisfied by an empty run.
  const escaped = testName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const line = new RegExp(`^(\u2714|\u2716) ${escaped} \\(`, "m");
  const hit = line.exec(output);
  if (!hit) return "MISSING";
  return hit[1] === "\u2716" ? "RED" : "green";
}

const BASELINE = new Map();
for (const m of ACTIVE) {
  const path = `tools/${m.suite}/${m.file}`;
  if (!BASELINE.has(path)) BASELINE.set(path, readFileSync(path, "utf8"));
}

function restoreAll() {
  for (const [path, text] of BASELINE) {
    if (readFileSync(path, "utf8") !== text) writeFileSync(path, text);
  }
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    restoreAll();
    process.exit(130);
  });
}

console.log("baseline");
let broken = 0;
for (const m of ACTIVE) {
  const verdict = run(m.suite, m.test);
  if (verdict !== "green") {
    console.log(`  ${m.suite}: "${m.test}": ${verdict} BEFORE any mutation`);
    broken += 1;
  }
}
if (broken > 0) {
  console.log("\nthe run is not clean; fix the names above before trusting anything below");
  process.exit(1);
}
console.log(`  ${ACTIVE.length} targeted tests are green\n`);

console.log("mutations");
let survivors = 0;
for (const m of ACTIVE) {
  const path = `tools/${m.suite}/${m.file}`;
  const original = readFileSync(path, "utf8");
  const parts = original.split(m.from);
  if (parts.length !== 2) {
    console.log(`  ${m.group}: MUTATION NO LONGER APPLIES (${parts.length - 1} matches)`);
    survivors += 1;
    continue;
  }
  writeFileSync(path, parts.join(m.to));
  let verdict;
  try {
    verdict = run(m.suite, m.test);
  } finally {
    restoreAll();
  }
  if (verdict !== "RED") survivors += 1;
  console.log(`  ${verdict.padEnd(7)} ${m.group}`);
}

const changed = [...BASELINE].filter(([p, text]) => readFileSync(p, "utf8") !== text);
if (changed.length > 0) {
  console.error("\nA FILE WAS LEFT MUTATED, recompile the suite:");
  for (const [p] of changed) console.error(`  ${p}`);
  process.exit(1);
}

console.log(`\n${ACTIVE.length - survivors}/${ACTIVE.length} mutations went red`);
if (survivors > 0) {
  console.log("a surviving mutation means a test that cannot fail: delete it or fix it");
  process.exit(1);
}
