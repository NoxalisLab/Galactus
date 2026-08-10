// Galactus, the scheduler's on-disk contract, exercised against a real
// filesystem rather than against a mock.
//
// WHY THIS FILE INCLUDES THE MODULE SOURCE INSTEAD OF IMPORTING IT
//
// `src/lib.rs` declares `mod scheduler;` privately and every `#[tauri::command]`
// in it is a private `fn`, so `galactus_app_lib::scheduler` does not exist as
// far as any other crate is concerned. An integration test therefore cannot
// reach the code it is supposed to hold to account. The way in, without
// touching a single line of `src/`, is to include the two modules directly
// into this test crate with `#[path]`: `src/cron.rs` is fully self-contained
// (no `use`, no `crate::`), and `src/scheduler.rs` needs exactly two things
// from its parent, `crate::cron` and `crate::app_support()`, both of which this
// file provides below.
//
// THE PRICE, MEASURED RATHER THAN GUESSED
//
// `cfg(test)` is true here, so the `#[cfg(test)] mod tests` block inside each
// included file is compiled and run again inside this binary: 32 tests from
// `cron.rs` and 32 from `scheduler.rs`, 64 in total, on top of the ones written
// here. They are duplicates of what the lib test binary already runs. The fix
// is one word in `src/lib.rs` (`pub mod scheduler;`), which is out of scope for
// this file, so the duplication is accepted and stated rather than hidden
// behind a hack.
//
// WHAT IS ACTUALLY BEING TESTED
//
// The contract that survives a restart: the two files round trip, a corrupt
// file is refused and left byte for byte alone, a write is atomic or it did not
// happen, a hostile job id cannot address a path outside the schedule folder,
// validation refuses what the runs view could not honour, and the catch-up rule
// still fires exactly once when the state it reasons about came off the disk
// instead of out of a literal.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[allow(dead_code)]
#[path = "../src/cron.rs"]
mod cron;

#[allow(dead_code)]
#[path = "../src/scheduler.rs"]
mod scheduler;

use cron::Utc;
use scheduler::{
    check_delivery, decide, read_jobs, read_states, sanitize_id, validate, write_jobs,
    write_states, Decision, Delivery, Job, JobInput, JobState, CATCHUP_GRACE_SECS, MAX_MINUTES,
    MAX_TURNS, POLICIES,
};

/// What `scheduler::schedule_dir` is built on in the real app. Here it is a
/// per-process temporary folder, so nothing this binary does can reach the
/// user's actual Application Support directory.
pub(crate) fn app_support() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("galactus-it-support-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

// ---------------------------------------------------------------- scaffolding

static SEQ: AtomicU64 = AtomicU64::new(0);

/// A fresh directory nobody else is using. No `tempfile` crate is in
/// `[dependencies]` and this file may not add one, so uniqueness is built out
/// of the pid, the clock and a counter, which is the same construction the
/// scheduler uses for its own job ids.
fn temp_dir(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = SEQ.fetch_add(1, Ordering::SeqCst);
    let p = std::env::temp_dir().join(format!(
        "galactus-it-{tag}-{}-{nanos}-{n}",
        std::process::id()
    ));
    std::fs::create_dir_all(&p).expect("temp dir");
    p
}

/// Deliberately not a `Drop` guard: a test that fails must leave its directory
/// behind to be looked at, and only a test that got to the end cleans up.
fn cleanup(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
}

/// The names in a directory, sorted, so a leftover temp sibling shows up as a
/// difference rather than being stepped over.
fn entries(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .expect("read dir")
        .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn a_job(id: &str, delivery: Delivery) -> Job {
    Job {
        id: id.into(),
        name: format!("Job {id}"),
        task: "Summarise what changed today.".into(),
        schedule: "0 3 * * *".into(),
        enabled: true,
        policy: "read_only".into(),
        max_turns: 8,
        max_minutes: 20,
        preauthorize_every_time: false,
        delivery,
        created_at: 1_715_731_200,
        updated_at: 1_715_731_300,
        enabled_at: 1_715_731_400,
    }
}

fn an_input(dir: &Path) -> JobInput {
    let json = serde_json::json!({
        "id": "",
        "name": "Nightly digest",
        "task": "Summarise the inbox",
        "schedule": "0 3 * * *",
        "enabled": true,
        "policy": "read_only",
        "max_turns": 8,
        "max_minutes": 20,
        "preauthorize_every_time": false,
        "delivery": { "mode": "file", "path": dir.join("out.txt").display().to_string() },
    });
    serde_json::from_value(json).expect("job input")
}

const JOBS_FILE: &str = "jobs.json";
const STATE_FILE: &str = "jobs-state.json";

// ------------------------------------------------- 1. jobs.json round trip

/// Every `Delivery` variant survives the trip to disk and back, unchanged.
/// The enum is `#[serde(tag = "mode")]`, so a variant that lost its payload
/// would still parse into a valid `Delivery` and would silently stop
/// delivering; comparing the whole `Job` is what catches that.
#[test]
fn every_delivery_variant_survives_the_trip_to_disk_and_back() {
    let dir = temp_dir("jobs-roundtrip");
    let jobs = vec![
        a_job("job-none", Delivery::None),
        a_job(
            "job-hook",
            Delivery::Webhook {
                url: "https://example.com/hook".into(),
            },
        ),
        a_job(
            "job-file",
            Delivery::File {
                path: "/tmp/galactus-delivery.txt".into(),
            },
        ),
    ];
    write_jobs(&dir, &jobs).expect("write jobs");

    let back = read_jobs(&dir).expect("read jobs");
    assert_eq!(back, jobs, "the definitions must come back identical");
    assert_eq!(back.len(), 3, "no job may be dropped on the way");
    assert_eq!(back[0].delivery, Delivery::None);
    assert_eq!(
        back[1].delivery,
        Delivery::Webhook {
            url: "https://example.com/hook".into()
        }
    );
    assert_eq!(
        back[2].delivery,
        Delivery::File {
            path: "/tmp/galactus-delivery.txt".into()
        }
    );

    // The two files stay apart, which is the whole reason there are two of
    // them: a lost state file must not cost a user their schedule.
    let raw = std::fs::read_to_string(dir.join(JOBS_FILE)).expect("raw");
    assert!(
        !raw.contains("last_fired_at"),
        "runtime state must not leak into the definitions"
    );
    cleanup(&dir);
}

// ------------------------------------------- 2. jobs-state.json round trip

/// The state file carries `Option<i64>` fields whose `None` is meaningful:
/// "never fired" is not "fired at 0", and a job whose anchor came back as the
/// epoch would fire on the next pass no matter what its schedule says.
#[test]
fn the_state_file_round_trips_including_the_fields_that_are_none() {
    let dir = temp_dir("state-roundtrip");
    let mut states: HashMap<String, JobState> = HashMap::new();
    states.insert(
        "job-a".into(),
        JobState {
            last_fired_at: Some(1_715_742_000),
            last_finished_at: Some(1_715_742_600),
            last_outcome: "finished".into(),
            last_detail: "42 files".into(),
            last_run_id: "run-7".into(),
            consecutive_failures: 3,
            missed: 17,
            last_missed_at: Some(1_715_700_000),
            last_delivery: "ok".into(),
        },
    );
    states.insert("job-b".into(), JobState::default());
    write_states(&dir, &states).expect("write states");

    let back = read_states(&dir).expect("read states");
    assert_eq!(back, states, "the state must come back identical");
    let b = back.get("job-b").expect("job-b");
    assert_eq!(b.last_fired_at, None, "never fired is not fired at zero");
    assert_eq!(b.last_missed_at, None);
    let a = back.get("job-a").expect("job-a");
    assert_eq!(a.last_fired_at, Some(1_715_742_000));
    assert_eq!(a.missed, 17);
    assert_eq!(a.consecutive_failures, 3);
    cleanup(&dir);
}

// ------------------------------------------------ 3. corruption is refused

/// A jobs file that does not parse is a file nobody can vouch for. Reading it
/// as "no jobs" would delete a user's schedule the next time anything saved.
/// So: an error, the path in the message, and the bytes on disk untouched.
///
/// Both kinds of corruption are exercised, because they leave through
/// different doors: text that is valid UTF-8 but not valid JSON reaches the
/// parser, while bytes that are not UTF-8 at all fail in `read_to_string`
/// before the parser is ever asked. Only checking the second would leave the
/// refusal rule itself, the one this module is built around, untested.
#[test]
fn a_corrupt_jobs_file_is_refused_by_path_and_left_byte_for_byte_alone() {
    // Truncated mid-token: what a kill during a plain overwrite produces.
    let truncated: &[u8] = b"{\"version\":1,\"jobs\":[{\"id\":\"job-1\",\"na";
    // Not even text: what a half-flushed block on a full disk produces.
    let binary: &[u8] = b"{\"version\":1,\"jobs\":[{\"id\":\"job-\xff\xfe\x00truncated";

    for (tag, garbage) in [("jobs-parse", truncated), ("jobs-bytes", binary)] {
        let dir = temp_dir(tag);
        let path = dir.join(JOBS_FILE);
        std::fs::write(&path, garbage).expect("write garbage");
        let before = std::fs::read(&path).expect("before");

        let err = read_jobs(&dir).expect_err("a corrupt file must be refused");
        assert!(
            err.contains(&path.display().to_string()),
            "the error must name the path, got: {err}"
        );

        let after = std::fs::read(&path).expect("still there");
        assert_eq!(
            before, after,
            "a refused file is not repaired, not rewritten and not deleted ({tag})"
        );
        assert_eq!(
            entries(&dir),
            vec![JOBS_FILE.to_string()],
            "a failed read must not leave anything behind either ({tag})"
        );
        cleanup(&dir);
    }
}

/// The same rule for the state file. It is the cheaper of the two to lose, but
/// silently starting from an empty state would replay every job's catch-up
/// window from the epoch, which is the 400-runs failure the design refuses.
#[test]
fn a_corrupt_state_file_is_refused_by_path_and_left_byte_for_byte_alone() {
    let truncated: &[u8] = b"{\"version\":1,\"states\":{\"job-1\":{\"last_fi";
    let binary: &[u8] = b"\x00\x01\x02 not json at all \xc3\x28";

    for (tag, garbage) in [("state-parse", truncated), ("state-bytes", binary)] {
        let dir = temp_dir(tag);
        let path = dir.join(STATE_FILE);
        std::fs::write(&path, garbage).expect("write garbage");
        let before = std::fs::read(&path).expect("before");

        let err = read_states(&dir).expect_err("a corrupt state file must be refused");
        assert!(
            err.contains(&path.display().to_string()),
            "the error must name the path, got: {err}"
        );

        let after = std::fs::read(&path).expect("still there");
        assert_eq!(
            before, after,
            "a refused state file is left exactly as it was ({tag})"
        );
        cleanup(&dir);
    }
}

// --------------------------------------------------- 4. the write is atomic

/// Write-then-rename or nothing. A successful write leaves the target and
/// nothing else: no `.jobs.json.<pid>.tmp` sitting next to it for the next
/// reader, the next backup or the next `read_dir` to trip over.
#[test]
fn a_successful_write_leaves_the_target_and_no_temporary_sibling() {
    let dir = temp_dir("atomic-clean");
    write_jobs(&dir, &[a_job("job-1", Delivery::None)]).expect("write jobs");
    assert_eq!(
        entries(&dir),
        vec![JOBS_FILE.to_string()],
        "write-then-rename must not leave the temp file behind"
    );

    write_states(&dir, &HashMap::new()).expect("write states");
    assert_eq!(
        entries(&dir),
        vec![STATE_FILE.to_string(), JOBS_FILE.to_string()],
        "and neither must the state write"
    );

    // Rewriting an existing file is the case where a plain overwrite would
    // have a truncate window; it must be just as clean the second time.
    write_jobs(&dir, &[a_job("job-1", Delivery::None), a_job("job-2", Delivery::None)])
        .expect("rewrite jobs");
    assert_eq!(
        entries(&dir),
        vec![STATE_FILE.to_string(), JOBS_FILE.to_string()]
    );
    assert_eq!(read_jobs(&dir).expect("read").len(), 2);
    cleanup(&dir);
}

/// The failure half of the same rule. With the directory read only the write
/// cannot land, and the point is what is still there afterwards: the previous
/// jobs.json, intact and readable, rather than a truncated one or none at all.
#[cfg(unix)]
#[test]
fn a_write_that_cannot_land_leaves_the_previous_file_intact_and_readable() {
    use std::os::unix::fs::PermissionsExt;

    let dir = temp_dir("atomic-fail");
    let good = vec![a_job("job-keep", Delivery::None)];
    write_jobs(&dir, &good).expect("first write");
    let before = std::fs::read(dir.join(JOBS_FILE)).expect("before");

    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).expect("chmod 555");

    let doomed = vec![a_job("job-new", Delivery::None), a_job("job-two", Delivery::None)];
    let result = write_jobs(&dir, &doomed);

    // Root ignores the mode bits, so on a root test runner there is nothing to
    // observe. Say so rather than assert something that is not true there.
    let enforced = result.is_err();
    if enforced {
        assert_eq!(
            std::fs::read(dir.join(JOBS_FILE)).expect("still there"),
            before,
            "a write that failed must not have touched the previous file"
        );
        assert_eq!(
            read_jobs(&dir).expect("still readable"),
            good,
            "the previous schedule must still parse after a failed write"
        );
        assert_eq!(
            entries(&dir),
            vec![JOBS_FILE.to_string()],
            "a failed write must not leave a temp file behind"
        );
    } else {
        eprintln!("skipped: the filesystem did not enforce 0o555 (running as root?)");
    }

    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).expect("restore mode");
    assert!(enforced, "the read only directory must have refused the write");
    cleanup(&dir);
}

// ------------------------------------------------ 5. path traversal is dead

/// A job id becomes part of a path in more than one place, so the sanitiser is
/// the only thing between a hand-edited jobs.json and a write outside the
/// schedule folder. This does not trust the character filter on its word: it
/// joins the sanitised id to a real directory and canonicalises the result.
#[test]
fn a_hostile_job_id_cannot_address_anything_outside_the_schedule_folder() {
    let dir = temp_dir("traversal");
    let root = dir.canonicalize().expect("canonicalize root");

    let hostile = [
        "../../etc/passwd",
        "..",
        "../",
        "/etc/passwd",
        "/../../../../etc/shadow",
        "job/../../../root",
        "..\\..\\windows",
        "./.ssh/authorized_keys",
        "\u{2f}etc\u{2f}passwd",
    ];
    for id in hostile {
        let clean = sanitize_id(id);
        assert!(
            !clean.contains(".."),
            "{id} sanitised to {clean}, which still traverses"
        );
        assert!(
            !clean.contains('/') && !clean.contains('\\'),
            "{id} sanitised to {clean}, which still holds a separator"
        );
        assert!(
            !clean.starts_with('/'),
            "{id} sanitised to {clean}, which is still absolute"
        );

        // The proof that matters: the sanitised id, used the way the scheduler
        // uses it, resolves inside the folder and nowhere else.
        let target = root.join(format!("{clean}.json"));
        std::fs::write(&target, b"{}").expect("write inside the folder");
        let resolved = target.canonicalize().expect("canonicalize target");
        assert!(
            resolved.starts_with(&root),
            "{id} produced {}, which is outside {}",
            resolved.display(),
            root.display()
        );
        assert_eq!(
            resolved.parent(),
            Some(root.as_path()),
            "{id} escaped one level up"
        );
        std::fs::remove_file(&target).expect("remove");
    }

    // What a legitimate id looks like, so the filter is not simply refusing
    // everything, and the length cap that stops a 4KB id becoming a filename.
    assert_eq!(sanitize_id("job-abc_123"), "job-abc_123");
    assert_eq!(sanitize_id(&"x".repeat(500)).len(), 64);
    cleanup(&dir);
}

// ---------------------------------------------------- 6. validation refuses

/// Every declaration the runs view could not honour is refused at save time,
/// which is the only moment a human is there to read the reason.
#[test]
fn validation_refuses_every_declaration_the_runs_view_could_not_honour() {
    let dir = temp_dir("validate");

    // The baseline: a valid input is accepted, so the refusals below are not
    // simply "validate always fails".
    let ok = validate(an_input(&dir), None, 5_000).expect("a valid input must be accepted");
    assert_eq!(ok.policy, "read_only");
    assert_eq!(ok.max_turns, 8);
    assert_eq!(ok.max_minutes, 20);
    assert!(POLICIES.contains(&ok.policy.as_str()));

    // An unknown policy. Narrowing it to something safe would be worse: the
    // job would run under a grant nobody chose.
    let mut bad = an_input(&dir);
    bad.policy = "root".into();
    let err = validate(bad, None, 0).expect_err("an unknown policy must be refused");
    assert!(err.contains("root"), "the error must name the policy: {err}");

    // Budgets above the cap are CLAMPED, not refused, and the clamp is the
    // assertion: a job asking for 100000 turns must come back at MAX_TURNS.
    let mut over = an_input(&dir);
    over.max_turns = MAX_TURNS + 1_000;
    over.max_minutes = MAX_MINUTES + 1_000;
    let clamped = validate(over, None, 0).expect("valid");
    assert_eq!(clamped.max_turns, MAX_TURNS, "turns must be capped");
    assert_eq!(clamped.max_minutes, MAX_MINUTES, "minutes must be capped");
    let mut under = an_input(&dir);
    under.max_turns = 0;
    under.max_minutes = 0;
    let floored = validate(under, None, 0).expect("valid");
    assert_eq!(floored.max_turns, 1, "a zero turn job would never do anything");
    assert_eq!(floored.max_minutes, 1);

    // An unparsable schedule, refused now rather than at 3am.
    for schedule in ["0 9 * *", "", "   ", "every 3s", "@never", "0 99 * * *"] {
        let mut i = an_input(&dir);
        i.schedule = schedule.into();
        assert!(
            validate(i, None, 0).is_err(),
            "schedule {schedule:?} must be refused"
        );
    }

    // An empty task, which would produce a run with nothing to do.
    let mut blank = an_input(&dir);
    blank.task = "   \n\t ".into();
    assert!(validate(blank, None, 0).is_err(), "an empty task must be refused");

    // An invalid delivery, checked here rather than at send time so a typo is
    // a red field instead of a silent nightly failure nobody reads.
    let bad_deliveries = [
        Delivery::Webhook {
            url: "ftp://example.com/hook".into(),
        },
        Delivery::Webhook {
            url: "example.com/hook".into(),
        },
        Delivery::Webhook { url: String::new() },
        Delivery::File {
            path: "notes/out.txt".into(),
        },
        Delivery::File {
            path: "/tmp/../etc/out.txt".into(),
        },
        Delivery::File {
            path: dir.join("no-such-folder").join("out.txt").display().to_string(),
        },
    ];
    for d in bad_deliveries {
        assert!(check_delivery(&d).is_err(), "{d:?} must be refused");
        let mut i = an_input(&dir);
        i.delivery = d.clone();
        assert!(
            validate(i, None, 0).is_err(),
            "validate must refuse {d:?} too, not only check_delivery"
        );
    }

    // And the ones that are fine, so the check is not refusing everything.
    assert!(check_delivery(&Delivery::None).is_ok());
    assert!(check_delivery(&Delivery::Webhook {
        url: "https://example.com/hook".into()
    })
    .is_ok());
    assert!(check_delivery(&Delivery::File {
        path: dir.join("out.txt").display().to_string()
    })
    .is_ok());
    cleanup(&dir);
}

// --------------------------------------- 7. the catch-up rule, off the disk

/// The 03:00 digest and a laptop opened at 16:00. Nothing fires, and the batch
/// is recorded as missed. The state comes back off the disk rather than out of
/// a literal, so a serialisation that lost `last_fired_at` would show up here
/// as the anchor collapsing to the epoch.
#[test]
fn a_batch_older_than_the_grace_window_fires_nothing_and_records_the_misses() {
    let dir = temp_dir("catchup-stale");
    let three_am = 1_715_742_000; // 2024-05-15T03:00:00Z
    let now = three_am + CATCHUP_GRACE_SECS + 3_600;

    let mut states = HashMap::new();
    states.insert(
        "job-digest".to_string(),
        JobState {
            last_fired_at: Some(three_am - 86_400),
            ..Default::default()
        },
    );
    write_states(&dir, &states).expect("write states");

    let from_disk = read_states(&dir).expect("read states");
    let state = from_disk.get("job-digest").expect("job-digest");
    assert_eq!(
        state.last_fired_at,
        Some(three_am - 86_400),
        "the anchor must survive the disk"
    );

    let schedule = cron::parse_schedule("0 3 * * *").expect("daily");
    let d = decide(&schedule, state, 0, now, &Utc);
    assert_eq!(
        d,
        Decision::Drop {
            missed: 1,
            saturated: false,
            last: three_am,
        },
        "a report that is seven hours late is not late, it is wrong"
    );

    // And the drop moves the anchor, so the same batch is not rediscovered on
    // every pass for the rest of the day.
    let Decision::Drop { last, .. } = d else {
        panic!("expected a drop");
    };
    let mut moved = HashMap::new();
    moved.insert(
        "job-digest".to_string(),
        JobState {
            last_fired_at: Some(last),
            missed: 1,
            last_missed_at: Some(last),
            ..Default::default()
        },
    );
    write_states(&dir, &moved).expect("write moved");
    let again = read_states(&dir).expect("read moved");
    assert_eq!(
        decide(&schedule, again.get("job-digest").expect("state"), 0, now, &Utc),
        Decision::Idle,
        "the same dropped batch must not come back"
    );
    assert_eq!(again.get("job-digest").expect("state").missed, 1);
    cleanup(&dir);
}

/// The other side of the rule. A fire missed inside the grace window runs, ONCE,
/// late, and then stops: the second pass over the same clock must be idle.
#[test]
fn a_fire_missed_inside_the_grace_window_runs_exactly_once_and_then_stops() {
    let dir = temp_dir("catchup-fresh");
    let three_am = 1_715_742_000; // 2024-05-15T03:00:00Z
    let now = three_am + CATCHUP_GRACE_SECS - 3_600;

    let mut states = HashMap::new();
    states.insert(
        "job-digest".to_string(),
        JobState {
            last_fired_at: Some(three_am - 86_400),
            ..Default::default()
        },
    );
    write_states(&dir, &states).expect("write states");

    let schedule = cron::parse_schedule("0 3 * * *").expect("daily");
    let from_disk = read_states(&dir).expect("read states");
    let d = decide(
        &schedule,
        from_disk.get("job-digest").expect("state"),
        0,
        now,
        &Utc,
    );
    assert_eq!(
        d,
        Decision::Fire {
            scheduled: three_am,
            dropped: 0,
            saturated: false,
            catchup: true,
        },
        "a five hour old digest is still worth having, once"
    );

    // Record the fire the way the pass does, at the SCHEDULED instant, put it
    // back on disk, and ask again. Exactly once means the second answer is
    // Idle: an anchor written as `now` instead of `scheduled` would drift every
    // subsequent fire, and an anchor not written at all would fire forever.
    let Decision::Fire { scheduled, .. } = d else {
        panic!("expected one fire");
    };
    let mut after = HashMap::new();
    after.insert(
        "job-digest".to_string(),
        JobState {
            last_fired_at: Some(scheduled),
            last_outcome: "finished".into(),
            ..Default::default()
        },
    );
    write_states(&dir, &after).expect("write after");
    let reread = read_states(&dir).expect("reread");
    assert_eq!(
        decide(&schedule, reread.get("job-digest").expect("state"), 0, now, &Utc),
        Decision::Idle,
        "one missed fire produces one run, not a run per pass"
    );

    // A per-minute job asleep for seven hours is 420 due fires and must still
    // be exactly one run, which is the requirement that made this rule exist.
    let per_minute = cron::parse_schedule("* * * * *").expect("per minute");
    let start = 1_715_731_200;
    let mut hammered = HashMap::new();
    hammered.insert(
        "job-minute".to_string(),
        JobState {
            last_fired_at: Some(start),
            ..Default::default()
        },
    );
    write_states(&dir, &hammered).expect("write hammered");
    let hammered = read_states(&dir).expect("read hammered");
    match decide(
        &per_minute,
        hammered.get("job-minute").expect("state"),
        0,
        start + 7 * 3_600,
        &Utc,
    ) {
        Decision::Fire {
            scheduled, dropped, ..
        } => {
            assert_eq!(scheduled, start + 7 * 3_600, "the most recent, not the oldest");
            assert!(dropped >= 400, "the other 400 are dropped, not run: {dropped}");
        }
        other => panic!("420 due fires must produce one run, got {other:?}"),
    }
    cleanup(&dir);
}
