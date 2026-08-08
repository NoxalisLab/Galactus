// gx-workspace, headless driver for the Code view's workspace engine.
//
// This binary exists so the enumeration, search, symbol and toolchain modules
// can be proved without launching the app: no window, no webview, no synthetic
// clicks. It pulls the three modules in by path, so they compile and run here
// before any `mod` line is added to lib.rs, and it is also the test host:
//
//     cargo test --bin gx-workspace
//     cargo run  --bin gx-workspace -- files .
//     cargo run  --bin gx-workspace -- search . needle --word --include '*.rs'
//     cargo run  --bin gx-workspace -- symbols . --query search
//     cargo run  --bin gx-workspace -- probe
//
// Every subcommand prints sorted, deterministic output, so two runs over an
// unchanged tree are byte for byte identical and a diff means something.
//
// Acceptance check: `gx-workspace files .` at the repository root must return
// exactly the set `git ls-files -co --exclude-standard` returns.

// The modules carry the app's whole surface; only part of it is reachable from
// a CLI, and an unused #[tauri::command] is not a defect.
#![allow(dead_code)]

#[path = "../toolchain.rs"]
mod toolchain;

#[path = "../search.rs"]
mod search;

#[path = "../symbols.rs"]
mod symbols;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

const USAGE: &str = "\
gx-workspace: Galactus workspace engine, headless

  gx-workspace files <root> [--no-git]
      Every file of the workspace, one relative path per line, sorted.
      --no-git forces the parallel walk instead of `git ls-files`.

  gx-workspace search <root> <needle> [--case] [--word]
                                      [--include GLOB]... [--exclude GLOB]...
      Literal search. Prints path:line:col<TAB>line-text, sorted.
      A summary (matches, files scanned, caps hit) goes to stderr.

  gx-workspace symbols <root> [--query Q] [--limit N]
      Declaration index. Prints kind<TAB>name<TAB>path<TAB>line, sorted.
      --query ranks instead of dumping.

  gx-workspace probe
      Toolchain availability as JSON, with the resolved paths.
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = args.first().map(|s| s.as_str()) else {
        eprint!("{USAGE}");
        return ExitCode::from(2);
    };
    let result = match cmd {
        "files" => cmd_files(&args[1..]),
        "search" => cmd_search(&args[1..]),
        "symbols" => cmd_symbols(&args[1..]),
        "probe" => cmd_probe(),
        "-h" | "--help" | "help" => {
            print!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        other => Err(format!("unknown subcommand '{other}'\n\n{USAGE}")),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("gx-workspace: {e}");
            ExitCode::FAILURE
        }
    }
}

/// Split positional arguments from flags. `multi` names the flags that take a
/// value and may repeat.
struct Args {
    positional: Vec<String>,
    flags: Vec<String>,
    values: Vec<(String, String)>,
}

fn parse_args(raw: &[String], with_value: &[&str]) -> Result<Args, String> {
    let mut out = Args { positional: Vec::new(), flags: Vec::new(), values: Vec::new() };
    let mut i = 0usize;
    while i < raw.len() {
        let a = &raw[i];
        if let Some(name) = a.strip_prefix("--") {
            if with_value.contains(&name) {
                let v = raw.get(i + 1).ok_or_else(|| format!("--{name} needs a value"))?;
                out.values.push((name.to_string(), v.clone()));
                i += 2;
                continue;
            }
            out.flags.push(name.to_string());
        } else {
            out.positional.push(a.clone());
        }
        i += 1;
    }
    Ok(out)
}

fn root_of(args: &Args, n: usize) -> Result<PathBuf, String> {
    let raw = args.positional.get(n).map(|s| s.as_str()).unwrap_or(".");
    std::fs::canonicalize(raw).map_err(|e| format!("{raw}: {e}"))
}

// ---------------------------------------------------------------- files

fn cmd_files(raw: &[String]) -> Result<(), String> {
    let args = parse_args(raw, &[])?;
    let root = root_of(&args, 0)?;
    let use_git = !args.flags.iter().any(|f| f == "no-git");
    let (files, source) = search::enumerate_sourced(&root, use_git)?;
    let mut out = String::with_capacity(files.len() * 40);
    for f in &files {
        out.push_str(f);
        out.push('\n');
    }
    print!("{out}");
    eprintln!("{} files (via {source})", files.len());
    Ok(())
}

// ---------------------------------------------------------------- search

fn cmd_search(raw: &[String]) -> Result<(), String> {
    let args = parse_args(raw, &["include", "exclude"])?;
    let root = root_of(&args, 0)?;
    let needle = args
        .positional
        .get(1)
        .cloned()
        .ok_or("search needs a needle: gx-workspace search <root> <needle>")?;
    let opts = search::SearchOpts {
        case_sensitive: args.flags.iter().any(|f| f == "case"),
        whole_word: args.flags.iter().any(|f| f == "word"),
        include_globs: args
            .values
            .iter()
            .filter(|(k, _)| k == "include")
            .map(|(_, v)| v.clone())
            .collect(),
        exclude_globs: args
            .values
            .iter()
            .filter(|(k, _)| k == "exclude")
            .map(|(_, v)| v.clone())
            .collect(),
    };
    let (hits, report) = search::search_all(&root, &needle, &opts)?;
    let mut out = String::new();
    for h in &hits {
        out.push_str(&format!("{}:{}:{}\t{}\n", h.path, h.line, h.col, h.text.trim()));
    }
    print!("{out}");
    eprintln!(
        "{} matches in {} scanned of {} files{}{}",
        report.matches,
        report.scanned,
        report.files,
        if report.capped { "  [CAPPED at 5000 matches]" } else { "" },
        if report.timed_out { "  [TIMED OUT at 30s]" } else { "" },
    );
    Ok(())
}

// ---------------------------------------------------------------- symbols

fn cmd_symbols(raw: &[String]) -> Result<(), String> {
    let args = parse_args(raw, &["query", "limit"])?;
    let root = root_of(&args, 0)?;
    let limit: usize = args
        .values
        .iter()
        .find(|(k, _)| k == "limit")
        .map(|(_, v)| v.parse().unwrap_or(50))
        .unwrap_or(50);
    let q = args.values.iter().find(|(k, _)| k == "query").map(|(_, v)| v.clone());

    if let Some(q) = q {
        let hits = symbols::query(&root, &q, limit)?;
        let mut out = String::new();
        for h in &hits {
            out.push_str(&format!(
                "{}\t{}\t{}\t{}\t{}\t{}\n",
                h.score,
                h.kind,
                h.name,
                if h.container.is_empty() { "-" } else { &h.container },
                h.path,
                h.line
            ));
        }
        print!("{out}");
        eprintln!("{} hits for '{q}'", hits.len());
        return Ok(());
    }

    let all = symbols::build(&root)?;
    let mut rows: Vec<String> = all
        .iter()
        .map(|s| format!("{}\t{}\t{}\t{}", s.kind, s.name, s.path, s.line))
        .collect();
    rows.sort();
    let mut out = String::new();
    for r in &rows {
        out.push_str(r);
        out.push('\n');
    }
    print!("{out}");
    eprintln!("{} symbols", rows.len());
    Ok(())
}

// ---------------------------------------------------------------- probe

fn cmd_probe() -> Result<(), String> {
    let t = toolchain::toolchains();
    let path_of = |tool: &str| {
        toolchain::resolve(tool)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "-".into())
    };
    let stub = |p: &str| {
        p != "-" && toolchain::is_xcode_stub(Path::new(p))
    };
    let mut lines: Vec<String> = Vec::new();
    for (name, ok) in [("git", t.git), ("node", t.node), ("cargo", t.cargo), ("make", t.make)] {
        let p = path_of(name);
        lines.push(format!(
            "  \"{name}\": {{ \"available\": {ok}, \"path\": \"{p}\", \"is_xcode_stub\": {} }}",
            stub(&p)
        ));
    }
    println!("{{\n{}\n}}", lines.join(",\n"));
    // Also state what /usr/bin/git actually is, since that is the whole point.
    let shim = Path::new("/usr/bin/git");
    if shim.exists() {
        eprintln!(
            "/usr/bin/git is {}",
            if toolchain::is_xcode_stub(shim) {
                "the Xcode Command Line Tools shim, never invoked by Galactus"
            } else {
                "a real git binary"
            }
        );
    }
    Ok(())
}
