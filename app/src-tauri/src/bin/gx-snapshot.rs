// gx-snapshot: the workspace snapshot, without the app.
//
// The Tier A language service is only as good as what it can see, and what it
// can see is whatever `snapshot.rs` decided to hand it. That decision is the
// one thing in this feature that cannot be checked by looking at the window:
// a missing typing does not draw an error, it draws a confident `any`. So the
// walk gets its own binary, and the numbers it prints are the proof.
//
//   cargo test --bin gx-snapshot
//   cargo run  --bin gx-snapshot -- <root> [--prefix <p>] [--quiet]
//                                  [--cap-bytes N] [--cap-files N] [--ext ts,tsx]
//
// Each kept file prints as `path\tbytes`, then a summary line. `--prefix`
// restricts BOTH the listing and the summary to one subtree, which is how the
// two headline claims are asserted against this repository:
//
//   --prefix src           -> 14 files, 425889 bytes
//   --prefix node_modules  -> 112 files, 1551014 bytes
//
// The module is pulled in by path rather than through the library so that this
// binary stays independent of the Tauri app build.

// The module carries the app's whole surface; only part of it is reachable
// from a CLI, and an unused #[tauri::command] is not a defect.
#![allow(dead_code)]

#[path = "../snapshot.rs"]
mod snapshot;

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut root: Option<String> = None;
    let mut prefix = String::new();
    let mut quiet = false;
    let mut json = false;
    let mut cap_bytes: u64 = 512 * 1024 * 1024;
    let mut cap_files: usize = 200_000;
    let mut exts: Vec<String> = Vec::new();

    let mut i = 0usize;
    while i < args.len() {
        let a = args[i].as_str();
        let next = |i: &mut usize| -> Option<String> {
            *i += 1;
            args.get(*i).cloned()
        };
        match a {
            "--prefix" => prefix = next(&mut i).unwrap_or_default(),
            "--quiet" => quiet = true,
            "--json" => json = true,
            "--cap-bytes" => cap_bytes = next(&mut i).and_then(|v| v.parse().ok()).unwrap_or(cap_bytes),
            "--cap-files" => cap_files = next(&mut i).and_then(|v| v.parse().ok()).unwrap_or(cap_files),
            "--ext" => {
                exts = next(&mut i)
                    .unwrap_or_default()
                    .split(',')
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .collect()
            }
            "-h" | "--help" => {
                eprintln!(
                    "usage: gx-snapshot <root> [--prefix p] [--quiet] [--json] [--cap-bytes n] [--cap-files n] [--ext a,b]"
                );
                return ExitCode::SUCCESS;
            }
            other => {
                if root.is_none() {
                    root = Some(other.to_string());
                } else {
                    eprintln!("unexpected argument: {other}");
                    return ExitCode::FAILURE;
                }
            }
        }
        i += 1;
    }

    let Some(root) = root else {
        eprintln!("usage: gx-snapshot <root> [--prefix p] [--quiet]");
        return ExitCode::FAILURE;
    };

    let res = match snapshot::snapshot(&root, &exts, cap_bytes, cap_files) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("gx-snapshot: {e}");
            return ExitCode::FAILURE;
        }
    };

    // `--json` emits the snapshot itself, which is how the Node benchmark
    // measures the language service over the REAL walk rather than over a
    // reimplementation of it.
    if json {
        match serde_json::to_string(&res) {
            Ok(s) => {
                println!("{s}");
                return ExitCode::SUCCESS;
            }
            Err(e) => {
                eprintln!("gx-snapshot: {e}");
                return ExitCode::FAILURE;
            }
        }
    }

    let mut files = 0usize;
    let mut bytes = 0u64;
    for (path, text) in &res.files {
        if !prefix.is_empty() && !path.starts_with(&prefix) {
            continue;
        }
        files += 1;
        bytes += text.len() as u64;
        if !quiet {
            println!("{path}\t{}", text.len());
        }
    }
    // The whole-walk figures stay visible even under --prefix: a truncated walk
    // that a filter happens to hide would be a lie by omission.
    println!(
        "files={files} bytes={bytes} truncated={} walk_files={} walk_bytes={}",
        res.truncated,
        res.files.len(),
        res.total_bytes
    );
    ExitCode::SUCCESS
}
