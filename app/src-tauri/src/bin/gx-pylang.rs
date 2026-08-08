// gx-pylang: prove the Python half of the Code view without the GUI.
//
//   cargo run --bin gx-pylang -- app/src/foo.py      analyse a file, print JSON
//   cargo run --bin gx-pylang -- --stdin --path x.py analyse the buffer on stdin
//   cargo run --bin gx-pylang -- --selftest          run the script's own checks
//   cargo run --bin gx-pylang -- --where             print the resolved paths
//   cargo test --bin gx-pylang                       run the checks below
//
// The module is pulled in with #[path] rather than through the library so this
// binary stands on its own: it compiles and runs before lib.rs has been wired,
// and it never needs a Tauri window.

// The module carries the app's whole surface; only part of it is reachable
// from a CLI, and an unused #[tauri::command] is not a defect.
#![allow(dead_code)]

// pylang resolves a developer checkout's python3 through toolchain.rs rather
// than through a bare PATH lookup, so the standalone binary carries it too.
#[path = "../toolchain.rs"]
mod toolchain;

#[path = "../pylang.rs"]
mod pylang;

use std::io::Read;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: gx-pylang <file.py> | --stdin --path <p> | --selftest | --where");
        std::process::exit(2);
    }

    if args[0] == "--selftest" {
        match pylang::selftest() {
            Ok(msg) => println!("{msg}"),
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        }
        return;
    }

    if args[0] == "--where" {
        println!(
            "script: {}",
            pylang::script_path()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "NOT FOUND".into())
        );
        println!(
            "python: {}",
            pylang::python_interpreter()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| format!("NOT FOUND ({})", pylang::NO_PYTHON))
        );
        return;
    }

    let (source, path) = if args[0] == "--stdin" {
        let mut path = "<buffer>".to_string();
        if args.len() >= 3 && args[1] == "--path" {
            path = args[2].clone();
        }
        let mut buf = String::new();
        if let Err(e) = std::io::stdin().read_to_string(&mut buf) {
            eprintln!("cannot read stdin: {e}");
            std::process::exit(1);
        }
        (buf, path)
    } else {
        let path = args[0].clone();
        match std::fs::read_to_string(&path) {
            Ok(s) => (s, path),
            Err(e) => {
                eprintln!("cannot read {path}: {e}");
                std::process::exit(1);
            }
        }
    };

    match pylang::analyze(&source, &path) {
        Ok(analysis) => println!("{}", serde_json::to_string_pretty(&analysis).unwrap()),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::pylang;

    const CLEAN: &str = "import os\n\n\nclass Widget:\n    def render(self):\n        return os.sep\n\n\ndef main():\n    return Widget().render()\n";

    #[test]
    fn the_script_is_found_in_the_checkout() {
        let p = pylang::script_path().expect("galactus_pylang.py must resolve from the crate dir");
        assert!(p.ends_with("packaged/scripts/galactus_pylang.py"), "{}", p.display());
    }

    #[test]
    fn the_bundled_interpreter_passes_the_script_selftest() {
        let msg = pylang::selftest().expect("selftest must run");
        assert!(msg.starts_with("selftest:"), "{msg}");
        assert!(msg.contains("checks passed"), "{msg}");
    }

    #[test]
    fn a_clean_file_yields_the_exact_symbol_list() {
        let a = pylang::analyze(CLEAN, "clean_case.py").expect("analysis runs");
        assert!(a.ok, "{:?}", a.error);
        assert!(a.error.is_none());
        assert!(a.python.starts_with("3."), "python {}", a.python);
        let got: Vec<(String, String, u32, u32)> = a
            .symbols
            .iter()
            .map(|s| (s.name.clone(), s.kind.clone(), s.line, s.depth))
            .collect();
        assert_eq!(
            got,
            vec![
                ("os".to_string(), "import".to_string(), 1, 0),
                ("Widget".to_string(), "class".to_string(), 4, 0),
                ("render".to_string(), "method".to_string(), 5, 1),
                ("main".to_string(), "function".to_string(), 9, 0),
            ]
        );
        // symtable, not a scanner: the scope tree comes from CPython itself.
        let scopes: Vec<(String, String)> = a
            .scopes
            .iter()
            .map(|s| (s.name.clone(), s.scope_type.clone()))
            .collect();
        assert!(scopes.contains(&("Widget".to_string(), "class".to_string())), "{scopes:?}");
        assert!(scopes.contains(&("render".to_string(), "function".to_string())), "{scopes:?}");
        // The tier's own limits travel with the payload.
        assert!(!a.limits.types);
        assert!(!a.limits.member_completion);
    }

    #[test]
    fn a_syntax_error_carries_line_offset_and_message() {
        let src = "def ok():\n    return 1\n\n\ndef broken(:\n    return 2\n";
        let a = pylang::analyze(src, "syntax_case.py").expect("analysis runs");
        assert!(!a.ok);
        let e = a.error.expect("an error");
        assert_eq!(e.kind, "syntax");
        assert_eq!(e.line, 5, "error line");
        let offset = e.offset.expect("CPython gives an offset");
        assert_eq!(offset, 12, "1-based offset into `def broken(:`");
        assert_eq!(e.col, 11, "0-based column for the editor");
        assert!(!e.message.is_empty(), "message");
        assert_eq!(e.text, "def broken(:");
        // No AST, so no outline. Saying nothing beats guessing.
        assert!(a.symbols.is_empty());
    }

    #[test]
    fn a_nul_byte_is_reported_not_crashed() {
        let a = pylang::analyze("x = 1\u{0}\n", "nul_case.py").expect("analysis runs");
        assert!(!a.ok);
        let e = a.error.expect("an error");
        assert!(e.kind == "value" || e.kind == "syntax", "kind {}", e.kind);
        assert!(
            e.message.to_lowercase().contains("null"),
            "message should name the null byte, got {}",
            e.message
        );
    }

    #[test]
    fn accented_identifiers_survive_the_pipe() {
        let src = "def café(thé: str) -> str:\n    return thé\n";
        let a = pylang::analyze(src, "accents_case.py").expect("analysis runs");
        assert!(a.ok, "{:?}", a.error);
        assert_eq!(a.symbols[0].name, "café");
        assert_eq!(a.symbols[0].detail, "(thé) -> str");
        let scope = a.scopes.iter().find(|s| s.name == "café").expect("scope");
        assert_eq!(scope.params, vec!["thé".to_string()]);
    }

    #[test]
    fn a_five_megabyte_buffer_hits_the_cap() {
        let src = "x = 1\n".repeat(5 * 1024 * 1024 / 6 + 1);
        assert!(src.len() > 5_000_000, "fixture is {} bytes", src.len());
        let err = pylang::analyze(&src, "huge_case.py").expect_err("must refuse");
        assert!(err.contains("over the"), "{err}");
        assert!(err.contains(&pylang::MAX_SOURCE_BYTES.to_string()), "{err}");
    }

    #[test]
    fn a_buffer_just_under_the_cap_still_parses() {
        // The cap must be a cap, not a wall a normal file runs into.
        let src = "x = 1\n".repeat(100_000);
        assert!(src.len() < pylang::MAX_SOURCE_BYTES);
        let a = pylang::analyze(&src, "big_case.py").expect("analysis runs");
        assert!(a.ok, "{:?}", a.error);
        // 100 000 bindings is not an outline: the script caps the list and
        // says so instead of shipping a second copy of the file to the UI.
        assert!(a.truncated, "an outline this long must declare it was cut");
        assert_eq!(a.symbols.len(), 5000, "MAX_SYMBOLS in galactus_pylang.py");
    }

    #[test]
    fn a_newer_request_supersedes_the_older_one_on_the_same_path() {
        // Two calls race on one path. Whatever the interleaving, each must
        // either answer correctly or say SUPERSEDED; neither may return a
        // half-read payload or panic.
        let a = std::thread::spawn(|| pylang::analyze(CLEAN, "race_case.py"));
        let b = std::thread::spawn(|| pylang::analyze(CLEAN, "race_case.py"));
        let mut ok = 0;
        for r in [a.join().unwrap(), b.join().unwrap()] {
            match r {
                Ok(v) => {
                    assert!(v.ok, "{:?}", v.error);
                    ok += 1;
                }
                Err(e) => assert_eq!(e, pylang::SUPERSEDED, "unexpected error: {e}"),
            }
        }
        assert!(ok >= 1, "at least one of the two racing calls must answer");
        // The slot must be empty again, or the next edit would kill a ghost.
        let a = pylang::analyze(CLEAN, "race_case.py").expect("a later call still works");
        assert!(a.ok);
    }

    /// A stand-in script that never answers, so the deadline and the kill can
    /// be tested without waiting five real seconds and without touching any
    /// process-wide environment variable.
    fn slow_script(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("gx-pylang-slow-{tag}.py"));
        std::fs::write(&p, "import sys, time\nsys.stdin.buffer.read()\ntime.sleep(120)\n").unwrap();
        p
    }

    #[test]
    fn a_child_that_never_answers_is_killed_at_the_deadline() {
        let script = slow_script("deadline");
        let started = std::time::Instant::now();
        let err = pylang::analyze_with(
            CLEAN,
            "deadline_case.py",
            Some(&script),
            std::time::Duration::from_millis(400),
        )
        .expect_err("a child that never answers must not hang the editor");
        assert!(err.contains("did not answer"), "{err}");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(4),
            "the deadline did not fire: {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_newer_request_kills_the_older_child_instead_of_waiting_for_it() {
        let script = slow_script("kill");
        let older = std::thread::spawn(move || {
            let t0 = std::time::Instant::now();
            let r = pylang::analyze_with(
                CLEAN,
                "kill_case.py",
                Some(&script),
                std::time::Duration::from_secs(60),
            );
            (r, t0.elapsed())
        });
        // Let the slow child actually start before superseding it.
        std::thread::sleep(std::time::Duration::from_millis(500));
        let newer = pylang::analyze(CLEAN, "kill_case.py").expect("the newer request answers");
        assert!(newer.ok);

        let (result, elapsed) = older.join().unwrap();
        let err = result.expect_err("the older request must not return a stale answer");
        assert_eq!(err, pylang::SUPERSEDED, "{err}");
        assert!(
            elapsed < std::time::Duration::from_secs(10),
            "the older child was waited out, not killed: {elapsed:?}"
        );
    }

    #[test]
    fn the_analysis_is_fast_enough_to_run_on_a_debounce() {
        let started = std::time::Instant::now();
        let a = pylang::analyze(CLEAN, "speed_case.py").expect("analysis runs");
        let elapsed = started.elapsed();
        assert!(a.ok);
        assert!(
            elapsed < pylang::DEADLINE,
            "a small file took {elapsed:?}, over the {:?} deadline",
            pylang::DEADLINE
        );
        assert!(a.elapsed_ms as u128 <= elapsed.as_millis() + 5);
    }
}
