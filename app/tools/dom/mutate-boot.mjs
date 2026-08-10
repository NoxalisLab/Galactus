// Prove the boot tests can fail.
//
// Same experiment and the same rules as mutate.mjs: break the thing a test
// covers, watch it go red, put it back. A mutation that no longer applies is
// reported as a failure rather than skipped, because a mutation that quietly
// stopped matching would turn this file into theatre.
//
// WHY THIS IS A SECOND FILE. Each boot case is its own process with its own
// GALACTUS_MODE_CASE, so the "run the test and see if it goes red" step is a
// different shape from mutate.mjs, which pattern-matches test names inside one
// process. Folding them together would mean one of the two runners pretending
// to be the other.
//
// It mutates tools/dom/out/src/main.js, which is generated and gitignored, so
// nothing here can leave a mark on the repository even if the process is
// killed halfway. tsc's emit for main.ts is a near one to one transpile, so a
// mutation applied there is a mutation of the behaviour under test.
//
// THE FIRST MUTATION IS THE INTERESTING ONE. It restores the defect this
// feature was written to fix: keying the screen on app_mode, which pre-exists
// on installs, rather than on app_mode_chosen, which records that the question
// was actually put. Under it the screen still appears for a fresh install and
// still hides for a chosen one, so four of the five cases stay green. Only
// "leftover" catches it, which is exactly why that case exists.
//
// Usage: node tools/dom/mutate-boot.mjs   (after: npx tsc -p tools/dom/tsconfig.json)

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const MAIN = "tools/dom/out/src/main.js";

const CASES = ["never", "leftover", "chosen", "server", "always", "click"];

const MUTATIONS = [
  {
    group: "the screen is keyed on app_mode_chosen, not on app_mode",
    from: 'modePending = modeAskAlways || s["app_mode_chosen"] !== "1";',
    to: 'modePending = modeAskAlways || s["app_mode"] === undefined;',
    cases: ["leftover"],
  },
  {
    group: "ask-every-launch overrides a recorded choice",
    from: 'modePending = modeAskAlways || s["app_mode_chosen"] !== "1";',
    to: 'modePending = s["app_mode_chosen"] !== "1";',
    cases: ["always"],
  },
  {
    group: "render() actually gates on modePending",
    from: "    if (modePending) {",
    to: "    if (false) {",
    cases: ["never", "leftover", "always"],
  },
  {
    group: "picking a door records that the question was put",
    from: '            void api.settingsSet("app_mode_chosen", "1");',
    to: "            void 0;",
    cases: ["click"],
  },
  {
    group: "picking a door records which door",
    from: '            void api.settingsSet("app_mode", appMode);',
    to: '            void api.settingsSet("app_mode", "app");',
    cases: ["click"],
  },
  {
    group: "server mode asks for a tray item and assistant mode does not",
    from: '    api.traySet(appMode === "server").catch(() => { });',
    to: "    api.traySet(false).catch(() => { });",
    cases: ["server"],
  },
  {
    group: "the tray is synced at boot rather than only on a change",
    from: "        loadStartMs = Date.now();\n    render();\n    syncTray();",
    to: "        loadStartMs = Date.now();\n    render();",
    cases: ["chosen", "server"],
  },
  {
    group: "server mode drops the assistant surfaces",
    from: '        ${appMode === "server" ? "" : nav("chat", I.chat, t("nav.chat"))}',
    to: '        ${nav("chat", I.chat, t("nav.chat"))}',
    cases: ["server"],
  },
  {
    group: "the sidebar shows the version the binary reports",
    from: "appVersion ? `${t(\"brand.by\")} \u00b7 v${appVersion}` : t(\"brand.by\")",
    to: "`${t(\"brand.by\")} \u00b7 v0.1.7`",
    cases: ["chosen"],
  },
  {
    group: "picking a door dismisses the screen",
    from: "            modePending = false;",
    to: "            modePending = true;",
    cases: ["click"],
  },
];

/** Run one case. "green" when its single test passed, "RED" otherwise. */
function run(name) {
  const result = spawnSync(
    process.execPath,
    ["--import", "./tools/dom/loader.mjs", "--test", "tools/dom/out/tools/dom/mainmode.test.js"],
    { env: { ...process.env, GALACTUS_MODE_CASE: name }, encoding: "utf8" },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return result.status === 0 && /^ℹ pass 1$/m.test(output) ? "green" : "RED";
}

console.log("baseline");
let broken = 0;
for (const name of CASES) {
  const verdict = run(name);
  if (verdict !== "green") {
    console.log(`  ${name}: ${verdict} BEFORE any mutation, the run is not clean`);
    broken += 1;
  }
}
if (broken > 0) process.exit(1);
console.log("  every case is green\n");

console.log("mutations");
let survivors = 0;
for (const m of MUTATIONS) {
  const original = readFileSync(MAIN, "utf8");
  const parts = original.split(m.from);
  if (parts.length !== 2) {
    console.log(`  ${m.group}: MUTATION NO LONGER APPLIES (${parts.length - 1} matches)`);
    survivors += 1;
    continue;
  }
  writeFileSync(MAIN, parts.join(m.to));
  let reds = [];
  try {
    reds = m.cases.filter((name) => run(name) === "RED");
  } finally {
    writeFileSync(MAIN, original);
  }
  const caught = reds.length === m.cases.length;
  if (!caught) survivors += 1;
  const missed = m.cases.filter((c) => !reds.includes(c));
  console.log(
    `  ${caught ? "RED  " : "alive"} ${m.group}` +
      (caught ? ` (${reds.join(", ")})` : ` (survived in: ${missed.join(", ")})`),
  );
}

console.log(`\n${MUTATIONS.length - survivors}/${MUTATIONS.length} mutations went red`);
if (survivors > 0) {
  console.log("a surviving mutation means a test that cannot fail: delete it or fix it");
  process.exit(1);
}
