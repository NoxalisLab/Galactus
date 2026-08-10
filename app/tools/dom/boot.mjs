// Run the boot tests, one process per case.
//
// WHY A RUNNER RATHER THAN ONE `node --test` INVOCATION. main.ts calls boot()
// at module scope, and an ES module body runs once per process however many
// times it is imported. Each case here is a DIFFERENT settings map fed to that
// one boot, so each case needs its own process. node:test isolates by file, not
// by test, so the alternative would be five near-identical files.
//
// Each case is selected by GALACTUS_MODE_CASE and every other test in the file
// skips itself, which is why the totals below count one run per case rather
// than one run of five tests.
//
// Usage: node tools/dom/boot.mjs   (after: npx tsc -p tools/dom/tsconfig.json)

import { spawnSync } from "node:child_process";

const CASES = ["never", "leftover", "chosen", "server", "always", "click"];

let failed = 0;
for (const name of CASES) {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "./tools/dom/loader.mjs",
      "--test",
      "tools/dom/out/tools/dom/mainmode.test.js",
    ],
    { env: { ...process.env, GALACTUS_MODE_CASE: name }, encoding: "utf8" },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  // A case whose only test skipped itself would exit 0 and prove nothing, so
  // the pass count is checked rather than the exit code alone.
  // Stripped as well as suppressed: NO_COLOR is a convention, not a
  // guarantee, and the belt costs one regex.
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "");
  const passed = /^ℹ pass 1$/m.test(plain);
  if (result.status === 0 && passed) {
    console.log(`  ok    ${name}`);
    continue;
  }
  failed += 1;
  console.log(`  FAIL  ${name}`);
  process.stdout.write(output.replace(/^/gm, "        "));
}

console.log(`\n${CASES.length - failed}/${CASES.length} boot cases passed`);
if (failed > 0) process.exit(1);
