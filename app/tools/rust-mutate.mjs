// Prove the Rust tests can fail.
//
// The counterpart to tools/dom/mutate.mjs, same experiment and same rules:
// break the thing a test covers, watch it go red, put it back. A mutation that
// no longer matches EXACTLY once is reported as a failure rather than skipped,
// because a mutation that quietly stopped applying would turn this file into
// theatre.
//
// WHY THIS ONE MUTATES src/ AND THE DOM ONE DOES NOT. There is no compiled
// intermediate to edit here: cargo builds from src/ and nowhere else. So the
// safety has to come from the process instead of from the target, and it does:
//
//   every original is read into memory BEFORE anything is written;
//   the restore is in a finally, so a failing cargo run still restores;
//   SIGINT and SIGTERM restore before exiting, so a killed run does not leave
//     a mutated tree behind;
//   every file is compared, byte for byte, against what this run found, and a
//     file left mutated is reported as a failure rather than left for
//     somebody else to discover.
//
// Usage: node tools/rust-mutate.mjs [filter]
//   filter matches against the group name, so `node tools/rust-mutate.mjs relay`
//   runs only the relay mutations.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const SRC = "src-tauri/src";

/**
 * Each entry: the file to break, the exact text to replace, what to put in its
 * place, and the tests that must go from green to red. Naming the tests rather
 * than "the suite" is deliberate: a mutation caught by some unrelated test
 * elsewhere proves nothing about the test that is supposed to cover it.
 */
const MUTATIONS = [
  // ------------------------------------------------------------- scheduler
  {
    group: "scheduler: a batch past the grace window fires nothing",
    file: `${SRC}/scheduler.rs`,
    from: "    if now - last > CATCHUP_GRACE_SECS {",
    to: "    if false {",
    // The first name has no module path: it lives in tests/scheduler_disk.rs,
    // which cargo compiles as its own crate.
    tests: [
      "a_batch_older_than_the_grace_window_fires_nothing_and_records_the_misses",
      "scheduler::tests::the_grace_boundary_is_where_it_says_it_is",
    ],
  },
  {
    group: "scheduler: the grace window is six hours",
    file: `${SRC}/scheduler.rs`,
    from: "pub const CATCHUP_GRACE_SECS: i64 = 6 * 3600;",
    to: "pub const CATCHUP_GRACE_SECS: i64 = 12 * 3600;",
    tests: ["scheduler::tests::the_grace_boundary_is_where_it_says_it_is"],
  },
  {
    group: "scheduler: a backlog collapses to ONE fire",
    file: `${SRC}/scheduler.rs`,
    from: "        dropped: missed.count.saturating_sub(1),",
    to: "        dropped: 0,",
    tests: ["scheduler::tests::four_hundred_missed_fires_produce_exactly_one_run"],
  },
  {
    group: "scheduler: a late fire is labelled late",
    file: `${SRC}/scheduler.rs`,
    from: "        catchup: missed.count > 1 || now - last > LATE_SECS,",
    to: "        catchup: false,",
    tests: ["scheduler::tests::a_single_missed_fire_inside_the_grace_window_runs_late"],
  },
  {
    group: "scheduler: a corrupt jobs.json is refused, not silently emptied",
    file: `${SRC}/scheduler.rs`,
    // Falling back to an empty list is the tempting reading of a parse error
    // and it is the dangerous one: every job a human declared disappears, the
    // scheduler reports a healthy empty schedule, and the next save overwrites
    // the file that still held them.
    from: "    let parsed: JobsFile = serde_json::from_str(&text)",
    to: "    let parsed: JobsFile = Ok::<JobsFile, serde_json::Error>(JobsFile { version: FORMAT_VERSION, jobs: Vec::new() })",
    tests: [
      "scheduler::tests::a_corrupt_file_is_refused_and_left_exactly_as_it_was",
      "a_corrupt_jobs_file_is_refused_by_path_and_left_byte_for_byte_alone",
    ],
  },
  {
    group: "scheduler: definitions and state stay in two separate files",
    file: `${SRC}/scheduler.rs`,
    from: 'const STATE_FILE: &str = "jobs-state.json";',
    to: 'const STATE_FILE: &str = "jobs.json";',
    tests: ["scheduler::tests::definitions_and_state_survive_a_round_trip_in_two_separate_files"],
  },
  // ------------------------------------------------------------------ cron
  {
    // Reported as an open finding for a while: `>` and `>=` agree on every
    // input the rest of the suite supplies, because next_cron_after rounds
    // `start` up to the following minute before it walks. They disagree on
    // exactly one shape of input, and the test named below constructs it: at a
    // fall back the local clock goes backwards, so the walk restarts behind the
    // reading it was asked about and the candidate for local 02:59 maps, via
    // unix_at's first-of-the-two rule, to the very instant asked about.
    group: "cron: a fall back does not hand back the fire that just happened",
    file: `${SRC}/cron.rs`,
    from: "        if t > after {",
    to: "        if t >= after {",
    tests: ["cron::tests::the_repeated_hour_never_hands_back_the_fire_that_just_happened"],
  },
  {
    group: "cron: a saturated count still carries an exact last fire",
    file: `${SRC}/cron.rs`,
    from: "            out.saturated = n > cap as i64;",
    to: "            out.saturated = false;",
    tests: ["cron::tests::an_interval_counts_its_misses_without_walking_them"],
  },
  {
    group: "cron: a night of missed minutes saturates but keeps the last exact",
    file: `${SRC}/cron.rs`,
    from: "                    out.saturated = true;",
    to: "                    out.count += 1;",
    tests: ["cron::tests::a_night_of_missed_minutes_saturates_the_count_but_not_the_last_fire"],
  },
  {
    group: "cron: nonsense is refused rather than defaulted",
    file: `${SRC}/cron.rs`,
    // The REASON, not merely the refusal. The test asserts that each bad
    // expression comes back naming what is wrong with it, because an error
    // that says only "invalid" leaves a user editing a cron line by guesswork.
    // Blanking the reason is therefore the mutation that matches the claim.
    from: '.map_err(|_| format!("\\"{text}\\" is not a number"))?;',
    to: '.map_err(|_| String::from("invalid"))?;',
    tests: ["cron::tests::nonsense_is_refused_with_a_reason_and_never_defaulted"],
  },
  // ------------------------------------------------- the learned skill bank
  {
    group: "lib: the agent's file tools cannot write the learned bank",
    file: `${SRC}/lib.rs`,
    from: "    path.starts_with(&support) || path.starts_with(&canon)",
    to: "    let _ = canon;\n    path == support",
    tests: [
      "protected_write_tests::the_learned_bank_is_not_writable_by_the_agents_file_tools",
      "protected_write_tests::the_whole_configuration_folder_is_refused_not_only_the_bank",
    ],
  },
  {
    group: "lib: the write guard does not refuse everything",
    file: `${SRC}/lib.rs`,
    from: "fn is_protected_write(path: &Path) -> bool {",
    to: "fn is_protected_write(path: &Path) -> bool {\n    if true { let _ = path; return true; }",
    tests: ["protected_write_tests::an_ordinary_user_path_is_still_writable"],
  },
  // ------------------------------------------------- the memory the Mac has
  {
    // The defect a user met as "Compute error.". The cap read "never take more
    // than 70 percent of this Mac" and bounded the ARENA, with the weights and
    // the runtime overhead added on top, so it delivered 90.
    group: "lib: the 70 percent cap bounds the whole footprint, not the arena",
    file: `${SRC}/lib.rs`,
    from: "    let ceiling_cache = hardware_budget.saturating_sub(fixed).min(expert_total);",
    to: "    let ceiling_cache = hardware_budget.min(expert_total);",
    tests: [
      "plan_cache_tests::the_seventy_percent_cap_bounds_the_whole_footprint_not_just_the_arena",
    ],
  },
  {
    // The second defect: nothing ever looked at a number that could change
    // after the Mac left the factory. Ignoring the reading is precisely the
    // old behaviour, so this mutation restores the bug.
    group: "lib: the budget comes from free memory, not from installed memory",
    file: `${SRC}/lib.rs`,
    from: "    let live_budget = engine_budget_bytes(ram, available);",
    to: "    let live_budget = engine_budget_bytes(ram, None);",
    tests: [
      "plan_cache_tests::a_mac_with_a_browser_open_starts_in_eco_instead_of_dying_mid_graph",
      "plan_cache_tests::the_step_down_stops_at_the_first_mode_that_fits",
    ],
  },
  {
    group: "lib: the safety margin on the free pool is really applied",
    file: `${SRC}/lib.rs`,
    from: "const AVAILABLE_CLAIM_NUM: u64 = 4;",
    to: "const AVAILABLE_CLAIM_NUM: u64 = 5;",
    tests: [
      "engine_budget_tests::a_busy_mac_gets_a_budget_from_what_is_free_not_from_what_it_was_sold_with",
    ],
  },
  {
    // A ladder that falls straight to eco would "work" on every machine and
    // would quietly cost a user the mode his Mac could actually afford, which
    // is the kind of regression no assertion about starting successfully sees.
    group: "lib: the step-down stops at the first mode that fits",
    file: `${SRC}/lib.rs`,
    from: "    for mode in &MODE_LADDER[start..] {",
    to: "    for mode in &MODE_LADDER[2..] {",
    tests: ["plan_cache_tests::the_step_down_stops_at_the_first_mode_that_fits"],
  },
  {
    group: "lib: a machine that fits nothing is refused before anything is spawned",
    file: `${SRC}/lib.rs`,
    from: "    let mut decision = choose_start_mode(live_budget, footprints, ram_mode);",
    to: "    let mut decision = choose_start_mode(u64::MAX, footprints, ram_mode);",
    tests: [
      "plan_cache_tests::a_machine_with_nothing_to_spare_is_told_so_before_anything_is_spawned",
      "plan_cache_tests::a_mac_with_a_browser_open_starts_in_eco_instead_of_dying_mid_graph",
    ],
  },
  {
    // The user's own two cases. Restoring the old ceiling shape is the exact
    // regression that produced "Compute error." on his 24 GB Mac, and both
    // named tests must see it.
    group: "lib: this user's 24 GB Mac, phi35-moe and gpt-oss-120b in balanced",
    file: `${SRC}/lib.rs`,
    from: "    let ceiling_cache = hardware_budget.saturating_sub(fixed).min(expert_total);",
    to: "    let ceiling_cache = ram.saturating_sub(fixed + system_reserve_bytes(ram)).min(expert_total);",
    tests: [
      "user_report_24gb_tests::phi35_moe_on_a_24gb_mac_in_balanced_no_longer_plans_twenty_gigabytes",
      "user_report_24gb_tests::phi35_moe_balanced_now_holds_what_the_user_had_to_find_by_trying_eco",
    ],
  },
  {
    // The half the ceiling fix does not cover: without the live reading,
    // gpt-oss-120b plans 14.1 GB on a machine with 9.6 to give and nothing
    // notices. His second model is the one that proves it.
    group: "lib: this user's gpt-oss-120b is refused rather than left to crash",
    file: `${SRC}/lib.rs`,
    from: "    let mut decision = choose_start_mode(live_budget, footprints, ram_mode);",
    to: "    let mut decision = choose_start_mode(hardware_budget, footprints, ram_mode);",
    tests: [
      "user_report_24gb_tests::gpt_oss_120b_is_refused_with_the_missing_figure_instead_of_crashing",
    ],
  },
  {
    // The failure mode a retry loop would have had, made impossible instead of
    // hoped for: a ladder that hands back a mode which does not fit either.
    group: "lib: the ladder never returns a mode the machine cannot hold",
    file: `${SRC}/lib.rs`,
    from: "        if resident <= budget {",
    to: "        if true {",
    tests: [
      "user_report_24gb_tests::the_ladder_always_lands_on_a_mode_that_fits_or_refuses_outright",
      "choose_start_mode_tests::a_busy_mac_steps_down_to_the_mode_that_fits_and_says_which",
    ],
  },
  {
    group: "lib: a refusal carries the figure that is missing",
    file: `${SRC}/lib.rs`,
    from: "                 (eco) needs {:.1} GB, this Mac can spare {:.1} GB, short by {:.1} GB. Quit an \\",
    to: "                 (eco) needs {:.1} GB, this Mac can spare {:.1} GB, {:.1}. Quit an \\",
    tests: [
      "user_report_24gb_tests::gpt_oss_120b_is_refused_with_the_missing_figure_instead_of_crashing",
      "plan_cache_tests::a_machine_with_nothing_to_spare_is_told_so_before_anything_is_spawned",
    ],
  },
  {
    // Third instance of the same class of defect: the overhead fit was
    // measured at one decode slot while the engine is started with two.
    group: "lib: the plan pays for the decode slots the engine is given",
    file: `${SRC}/lib.rs`,
    from: "        + u64::from(slots.saturating_sub(1)) * KV_BYTES_PER_EXTRA_SLOT;",
    to: "        + 0 * KV_BYTES_PER_EXTRA_SLOT * u64::from(slots);",
    tests: ["plan_cache_tests::every_decode_slot_past_the_first_is_paid_for_out_of_the_arena"],
  },
  {
    // The whole point of reading the log: "Compute error." is the same three
    // words whatever happened, so a classifier that answers "memory" to
    // everything would send users to free memory that was never the problem.
    group: "lib: a failure the log does not explain is not blamed on memory",
    file: `${SRC}/lib.rs`,
    from: '    if OOM_MARKERS.iter().any(|m| low.contains(m)) {\n        return "memory";\n    }\n    "unknown"',
    to: '    let _ = low;\n    "memory"',
    tests: ["engine_failure_tests::a_failure_the_log_does_not_explain_stays_unknown"],
  },
  {
    group: "lib: an exceeded context is decided before the log is read",
    file: `${SRC}/lib.rs`,
    from: '    if msg.contains("context size has been exceeded")',
    to: "    if false && msg.contains(\"context size has been exceeded\")",
    tests: ["engine_failure_tests::an_exceeded_context_is_never_reported_as_memory"],
  },
  // ------------------------------------------------------------------ relay
  {
    group: "relay: the key comparison actually compares",
    file: `${SRC}/relay.rs`,
    from: "        diff |= a[i] ^ b[i];",
    to: "        diff |= 0;",
    tests: ["relay::tests::comparison_is_length_safe_and_correct"],
  },
  {
    // Constant time, made structural. A comparison that returns at the first
    // differing byte is still CORRECT, so no assertion on a boolean can see it
    // and the only thing that could is a stopwatch, which is flaky and does not
    // belong here. secret_diff hands back the accumulated difference instead,
    // and a value that carries a bit from the last byte cannot come from a loop
    // that stopped at the first.
    group: "relay: the key comparison does not stop at the first difference",
    file: `${SRC}/relay.rs`,
    from: "        diff |= a[i] ^ b[i];\n",
    to: "        diff |= a[i] ^ b[i];\n        if diff != 0 {\n            return diff;\n        }\n",
    tests: ["relay::tests::secret_diff_folds_in_every_byte_and_not_only_the_first_difference"],
  },
  {
    group: "relay: listening without a key is refused",
    file: `${SRC}/relay.rs`,
    from: "    if key.trim().is_empty() {",
    to: "    if false {",
    tests: ["relay::tests::listening_without_a_key_is_refused"],
  },
  {
    group: "relay: an arbitrary bind address is refused",
    file: `${SRC}/relay.rs`,
    from: '    if bind != "127.0.0.1" && bind != "0.0.0.0" {',
    to: "    if false {",
    tests: ["relay::tests::only_the_two_intended_addresses_are_accepted"],
  },
  {
    group: "relay: an unauthenticated request never reaches the engine",
    file: `${SRC}/relay.rs`,
    from: "    if expected.is_empty() || !secret_eq(&expected, &given) {",
    to: "    if false {",
    tests: ["relay::tests::live_relay_authenticates_and_forwards"],
  },
  {
    group: "relay: preflight is answered without a key",
    file: `${SRC}/relay.rs`,
    from: "    if is_preflight(&head) {",
    to: "    if false {",
    tests: ["relay::tests::live_relay_authenticates_and_forwards"],
  },
  {
    group: "relay: stop frees the port",
    file: `${SRC}/relay.rs`,
    from: "    let _ = TcpStream::connect((\"127.0.0.1\", port));",
    to: "    let _ = port;",
    tests: ["relay::tests::live_relay_authenticates_and_forwards"],
  },
  // pty::kill_group is deliberately NOT mutated here. The only mutation that
  // would exercise its guard is deleting `if pgid <= 1 { return; }`, and the
  // test then calls kill_group(0), which sends SIGKILL to the whole process
  // group: the test runner, the shell that launched it, and this script. A
  // mutation that takes down the machine it is measuring is not a measurement.
];

const FILTER = process.argv[2] ?? "";
const ACTIVE = MUTATIONS.filter((m) => !m.skip && (!FILTER || m.group.includes(FILTER)));

/**
 * The bytes of every file this run may touch, read before anything is written.
 *
 * The check at the end compares against THIS, not against git. Comparing
 * against git would refuse to run on a tree with legitimate uncommitted work
 * and, worse, would call a restore successful merely because the file matched
 * HEAD, which is the wrong question: the question is whether the file is byte
 * for byte what this script found.
 */
function snapshot(files) {
  const taken = new Map();
  for (const file of files) taken.set(file, readFileSync(file, "utf8"));
  return taken;
}

/**
 * Run one named test. "green" when it passed, "RED" when it failed, "MISSING"
 * when no binary has a test by that name.
 *
 * Every target is built, not just --lib: scheduler's disk tests live in
 * tests/scheduler_disk.rs and its in-memory ones in the lib, so a --lib run
 * would report half the scheduler's names as MISSING. cargo runs the filter
 * against each binary in turn and each prints its own summary, so the counts
 * are summed rather than matched once.
 */
function run(name) {
  const result = spawnSync("cargo", ["test", "--", "--exact", name], {
    cwd: "src-tauri",
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  // A compile error is not a red test: the mutation did not typecheck, which
  // says nothing about whether the test can fail. It is reported as its own
  // verdict so it cannot be counted as a success.
  //
  // Matched narrowly, on purpose. An earlier version of this regex was
  // `^error:` and it matched cargo's own `error: test failed, to rerun pass
  // --lib`, so EVERY red mutation was classified NOBUILD and the harness
  // reported 0/14 caught on a suite that was in fact catching all fourteen.
  // A mutation harness that cannot tell a failing test from a failing build is
  // worse than none, because it reports the healthy case as the broken one.
  if (/^error\[E\d+\]:/m.test(output) || /^error: could not compile/m.test(output)) {
    return "NOBUILD";
  }
  let passed = 0;
  let failed = 0;
  for (const m of output.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed/gm)) {
    passed += Number(m[1]);
    failed += Number(m[2]);
  }
  // A filter that matched nothing exits 0 with "0 passed", which would read as
  // a pass and hide a renamed test. The counts are what is checked.
  //
  // `passed >= 1` rather than `=== 1`: tests/scheduler_disk.rs pulls the
  // scheduler module in as well as linking the lib, so some names exist in two
  // binaries and one exact filter legitimately runs twice.
  if (failed > 0) return "RED";
  if (passed === 0) return "MISSING";
  return "green";
}

const BASELINE = snapshot([...new Set(ACTIVE.map((m) => m.file))]);

/** Put every file back to the bytes the snapshot holds. */
function restoreAll() {
  for (const [file, text] of BASELINE) {
    if (readFileSync(file, "utf8") !== text) writeFileSync(file, text);
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
const targets = [...new Set(ACTIVE.flatMap((m) => m.tests))];
for (const name of targets) {
  const verdict = run(name);
  if (verdict !== "green") {
    console.log(`  ${name}: ${verdict} BEFORE any mutation, the run is not clean`);
    broken += 1;
  }
}
if (broken > 0) process.exit(1);
console.log(`  ${targets.length} targeted tests are green\n`);

console.log("mutations");
let survivors = 0;
for (const m of ACTIVE) {
  const original = readFileSync(m.file, "utf8");
  const parts = original.split(m.from);
  if (parts.length !== 2) {
    console.log(`  ${m.group}: MUTATION NO LONGER APPLIES (${parts.length - 1} matches)`);
    survivors += 1;
    continue;
  }
  writeFileSync(m.file, parts.join(m.to));
  let reds = [];
  try {
    reds = m.tests.filter((name) => run(name) === "RED");
  } finally {
    restoreAll();
  }
  const caught = reds.length === m.tests.length;
  if (!caught) survivors += 1;
  const missed = m.tests.filter((t) => !reds.includes(t));
  console.log(
    `  ${caught ? "RED  " : "alive"} ${m.group}` + (caught ? "" : ` (survived: ${missed.join(", ")})`),
  );
}

// Every file must be exactly the bytes this run found, whatever happened above.
const changed = [...BASELINE].filter(([file, text]) => readFileSync(file, "utf8") !== text);
if (changed.length > 0) {
  console.error("\nTHE TREE WAS LEFT MUTATED, restore it by hand:");
  for (const [file] of changed) console.error(`  ${file}`);
  process.exit(1);
}
console.log("\nevery mutated file is back to the bytes this run found");

console.log(`${ACTIVE.length - survivors}/${ACTIVE.length} mutations went red`);
if (survivors > 0) {
  console.log("a surviving mutation means a test that cannot fail: delete it or fix it");
  process.exit(1);
}
