// Prove the DOM tests can fail.
//
// A test that passes whatever the code does is worse than no test, and the
// only way to know which kind you have is to break the thing it covers and
// watch it go red. This runs that experiment, once per assertion group.
//
// WHY IT MUTATES THE COMPILED OUTPUT AND NOT src/. Two reasons, and the second
// is the decisive one:
//
//   tools/dom/out/ is generated and gitignored, so nothing here can leave a
//   mark on the repository even if the process is killed halfway;
//
//   src/runsview.ts and src/main.ts belong to another workstream that is
//   editing them right now. A backup-and-restore dance on a file somebody else
//   is writing to is a way to silently destroy their work, and no mutation
//   report is worth that risk.
//
// The output is what the tests actually execute, and tsc's emit for these
// modules is a near one to one transpile, so a mutation applied here is a
// mutation of the behaviour under test. Each edit is a literal string
// replacement that must match EXACTLY once; a mutation that no longer applies
// is reported as a failure rather than skipped, because a mutation that
// silently stopped applying would turn this whole file into theatre.
//
// Usage: node tools/dom/mutate.mjs      (after: npx tsc -p tools/dom/tsconfig.json)

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const OUT = "tools/dom/out/src";

/**
 * Each entry: the file to break, the exact text to replace, what to put in its
 * place, and the test whose name must go from green to red.
 */
const MUTATIONS = [
  {
    group: "blocked run shows both answers",
    file: `${OUT}/runsview.js`,
    from: '<button class="bd" data-act="refuse">',
    to: '<button class="bd" data-act="refuse-typo">',
    test: "a run that stopped on a question shows the question and both answers",
  },
  {
    group: "blocked run shows the question",
    file: `${OUT}/runsview.js`,
    from: '<div class="runs-question">${esc(question)}</div>',
    to: '<div class="runs-question"></div>',
    test: "a run that stopped on a question shows the question and both answers",
  },
  {
    group: "scheduled row shows the next fire time",
    file: `${OUT}/runsview.js`,
    from: "const next = row.next_fire_at !== null",
    to: "const next = row.next_fire_at === null",
    test: "the scheduled section shows the next fire time",
  },
  {
    group: "a declared run is painted",
    file: `${OUT}/runsview.js`,
    from: "    paintForm();\n    schedulePaint();\n    startRun(entry);",
    to: "    paintForm();\n    startRun(entry);",
    test: "a declared run appears on screen and is written to disk",
  },
  {
    group: "a declared run is persisted",
    file: `${OUT}/runsview.js`,
    from: "    live.set(id, entry);\n    persist(entry, true);\n    draft.name = \"\";",
    to: "    live.set(id, entry);\n    draft.name = \"\";",
    test: "a declared run appears on screen and is written to disk",
  },
  {
    group: "a refused jobs.json is surfaced",
    file: `${OUT}/runsview.js`,
    from: "jobs = decodeJobsView(await api.jobsList());",
    to: "jobs = { ...decodeJobsView(await api.jobsList()), error: \"\" };",
    test: "a scheduler that refused a corrupt jobs.json says so on screen",
  },
  {
    group: "a pending skill is not callable",
    file: `${OUT}/learned.js`,
    from: "export function isUsable(s) {\n    return s.state === \"active\";",
    to: "export function isUsable(s) {\n    return true;",
    test: "a pending authored skill is shown, marked, and NOT callable",
  },
  {
    group: "a pending skill is marked on the card",
    file: `${OUT}/learnedview.js`,
    from: 'const pending = s.state !== "active";',
    to: "const pending = false;",
    test: "a pending authored skill is shown, marked, and NOT callable",
  },
  {
    group: "an accepted skill is callable",
    file: `${OUT}/learned.js`,
    from: "export function callableSkills(bank, enabled) {\n    return enabled ? bank.filter(isUsable) : [];",
    to: "export function callableSkills(bank, enabled) {\n    return [];",
    test: "an accepted skill is callable and is not offered for approval again",
  },
  {
    group: "approval really writes back as active",
    file: `${OUT}/learnedbank.js`,
    from: 'await api.learnedWrite(slug, renderSkillFile({ ...s, state: "active" }));',
    to: 'await api.learnedWrite(slug, renderSkillFile({ ...s, state: "pending" }));',
    test: "approving writes the file back as active and only then does it become callable",
  },
  {
    group: "the learned folder is printed",
    file: `${OUT}/learnedview.js`,
    from: "wrap.querySelector(\"#lpath\").textContent = p;",
    to: "void p;",
    test: "the panel prints the folder the agent writes into",
  },
];

function run(testName) {
  try {
    execFileSync(
      process.execPath,
      [
        "--import",
        "./tools/dom/loader.mjs",
        "--test",
        "--test-name-pattern",
        testName,
        "tools/dom/out/tools/dom/runsview.test.js",
        "tools/dom/out/tools/dom/learnedview.test.js",
      ],
      { stdio: "pipe" },
    );
    return "green";
  } catch {
    return "RED";
  }
}

let broken = 0;
console.log("baseline");
for (const m of MUTATIONS) {
  const before = run(m.test);
  if (before !== "green") {
    console.log(`  ${m.test}: ${before} BEFORE any mutation, the run is not clean`);
    broken += 1;
  }
}
if (broken > 0) process.exit(1);
console.log("  every targeted test is green\n");

console.log("mutations");
let survivors = 0;
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, "utf8");
  const parts = original.split(m.from);
  if (parts.length !== 2) {
    console.log(`  ${m.group}: MUTATION NO LONGER APPLIES (${parts.length - 1} matches)`);
    survivors += 1;
    continue;
  }
  writeFileSync(m.file, parts.join(m.to));
  let verdict;
  try {
    verdict = run(m.test);
  } finally {
    writeFileSync(m.file, original);
  }
  if (verdict !== "RED") survivors += 1;
  console.log(`  ${verdict.padEnd(5)} ${m.group}`);
}

console.log(`\n${MUTATIONS.length - survivors}/${MUTATIONS.length} mutations went red`);
if (survivors > 0) {
  console.log("a surviving mutation means a test that cannot fail: delete it or fix it");
  process.exit(1);
}
