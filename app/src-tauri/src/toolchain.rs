// Galactus desktop, external toolchain probe.
//
// WHY THIS FILE EXISTS. On macOS, /usr/bin/git is not git. It is the Xcode
// Command Line Tools shim: on this machine /usr/bin/git, /usr/bin/clang,
// /usr/bin/swiftc and /usr/bin/ctags are literally the same file (inode
// 1152921500312571585, 118928 bytes, 78 hard links). The shim looks at argv[0],
// asks xcode-select for the active developer directory and execs the real tool
// from there. When no developer directory exists it pops Apple's "install the
// command line tools?" dialog instead of returning, which means a plain
// `Command::new("git")` on a fresh Mac hangs the caller behind a modal the user
// never asked for. Galactus ships plug and play, so it must never do that.
//
// The rules this module follows:
//   1. Never invoke a shim. A candidate whose (device, inode) matches one of
//      the known stub hard links is redirected to <developer_dir>/usr/bin/<tool>
//      and only invoked if that real file exists.
//   2. Presence on disk proves nothing. A tool counts as available only after a
//      cheap version invocation exits 0, inside a 3 s deadline, with the child's
//      standard streams detached from ours. Same reasoning `doc_capabilities`
//      already applies to swiftc in lib.rs.
//   3. Resolve PATH ourselves and extend it. A Tauri app launched from Finder
//      inherits /usr/bin:/bin:/usr/sbin:/sbin, so a Homebrew git is invisible to
//      Command::new("git") even though the user's terminal finds it.
//
// std only: no new crate, so no NOTICE entry and no licence review.

use serde::Serialize;
use std::collections::HashMap;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// A version invocation that has not answered in this long is treated as
/// unavailable and killed. Generous enough for a cold NFS home, short enough
/// that the Code view never feels stuck.
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const POLL: Duration = Duration::from_millis(20);

/// Names under /usr/bin that are ALWAYS the Xcode stub and never a real tool.
/// Their (device, inode) pairs identify the stub hard-link group; anything that
/// shares one of them is the stub wearing another name.
const STUB_CANARIES: &[&str] = &[
    "/usr/bin/xcodebuild",
    "/usr/bin/xcrun",
    "/usr/bin/xed",
    "/usr/bin/clang",
    "/usr/bin/swiftc",
    "/usr/bin/ctags",
];

/// Directories searched after PATH, because a bundled app does not inherit the
/// user's shell PATH.
const EXTRA_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/opt/local/bin",
    "/usr/bin",
    "/bin",
];

/// Developer directories tried, in order, when a candidate turns out to be the
/// stub. `xcode-select -p` is consulted too, but only when xcode-select itself
/// is a real binary (it is: one hard link, its own inode) so asking it can
/// never be the thing that raises the installer dialog.
const DEVELOPER_DIRS: &[&str] = &[
    "/Library/Developer/CommandLineTools",
    "/Applications/Xcode.app/Contents/Developer",
];

/// Reported by `gx-workspace probe`, which includes this module by path. The
/// app itself only ever asks about git, through `git_available()`, so the lib
/// build legitimately never constructs one.
#[allow(dead_code)]
#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Toolchains {
    pub git: bool,
    pub node: bool,
    pub cargo: bool,
    pub make: bool,
}

// ---------------------------------------------------------------- stub detection

fn ids_of(path: &Path) -> Option<(u64, u64)> {
    std::fs::metadata(path).ok().map(|m| (m.dev(), m.ino()))
}

fn stub_ids() -> &'static Vec<(u64, u64)> {
    static IDS: OnceLock<Vec<(u64, u64)>> = OnceLock::new();
    IDS.get_or_init(|| STUB_CANARIES.iter().filter_map(|p| ids_of(Path::new(p))).collect())
}

/// True when `path` is the Command Line Tools shim rather than a real tool.
/// Identity is compared on (device, inode), not on name or size: the shim is a
/// hard link, so every name in the group is byte-for-byte the same file, and no
/// heuristic on the path can be fooled by a user's own binary living elsewhere.
pub fn is_xcode_stub(path: &Path) -> bool {
    match ids_of(path) {
        Some(id) => stub_ids().contains(&id),
        None => false,
    }
}

fn is_executable_file(path: &Path) -> bool {
    match std::fs::metadata(path) {
        Ok(m) => m.is_file() && m.permissions().mode() & 0o111 != 0,
        Err(_) => false,
    }
}

/// Active developer directories, most specific first. Never invokes a stub.
fn developer_dirs() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        if p.is_dir() && !out.contains(&p) {
            out.push(p);
        }
    };
    if let Ok(d) = std::env::var("DEVELOPER_DIR") {
        if !d.trim().is_empty() {
            push(PathBuf::from(d));
        }
    }
    let selector = Path::new("/usr/bin/xcode-select");
    if is_executable_file(selector) && !is_xcode_stub(selector) {
        if let Some(out_s) = run_capture(selector, &["--print-path"]) {
            let d = out_s.trim();
            if !d.is_empty() {
                push(PathBuf::from(d));
            }
        }
    }
    for d in DEVELOPER_DIRS {
        push(PathBuf::from(d));
    }
    out
}

// ---------------------------------------------------------------- resolution

fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(path) = std::env::var("PATH") {
        for part in path.split(':').filter(|p| !p.is_empty()) {
            let p = PathBuf::from(part);
            if !dirs.contains(&p) {
                dirs.push(p);
            }
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        for suffix in [".cargo/bin", ".local/bin", ".bun/bin", ".volta/bin"] {
            let p = PathBuf::from(&home).join(suffix);
            if !dirs.contains(&p) {
                dirs.push(p);
            }
        }
    }
    for d in EXTRA_DIRS {
        let p = PathBuf::from(d);
        if !dirs.contains(&p) {
            dirs.push(p);
        }
    }
    dirs
}

fn resolve_uncached(tool: &str) -> Option<PathBuf> {
    let mut stub_seen = false;
    for dir in search_dirs() {
        let candidate = dir.join(tool);
        if !is_executable_file(&candidate) {
            continue;
        }
        if is_xcode_stub(&candidate) {
            // Remember it, keep looking: a real Homebrew git later in PATH is
            // always the better answer than the CLT copy behind the shim.
            stub_seen = true;
            continue;
        }
        return Some(candidate);
    }
    if !stub_seen {
        return None;
    }
    // Everything we found was the shim. Reach the real tool directly inside the
    // developer directory so the shim, and its installer dialog, never runs.
    for dev in developer_dirs() {
        let real = dev.join("usr/bin").join(tool);
        if is_executable_file(&real) && !is_xcode_stub(&real) {
            return Some(real);
        }
    }
    None
}

/// Absolute path of `tool`, with the Xcode shim resolved away. `None` means the
/// tool is genuinely absent and nothing should be spawned for it.
pub fn resolve(tool: &str) -> Option<PathBuf> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<PathBuf>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(hit) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(tool) {
        return hit.clone();
    }
    let found = resolve_uncached(tool);
    cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(tool.to_string(), found.clone());
    found
}

// ---------------------------------------------------------------- invocation

/// Spawn, wait at most PROBE_TIMEOUT, kill on expiry. std has no wait-with-
/// timeout, so this polls try_wait; the loop costs a handful of microseconds
/// and the alternative (a thread plus a channel) leaks the child on timeout.
fn wait_bounded(child: &mut std::process::Child) -> Option<std::process::ExitStatus> {
    let deadline = Instant::now() + PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) => {}
            Err(_) => return None,
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(POLL);
    }
}

/// True when `program args...` exits 0 within the deadline. stdin is /dev/null
/// so a tool that would read from the terminal fails fast instead of blocking;
/// stdout and stderr are piped and drained by the caller-side reap so a chatty
/// tool cannot fill a pipe buffer and deadlock.
fn probe_ok(program: &Path, args: &[&str]) -> bool {
    let mut child = match Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    drain(child.stdout.take());
    drain(child.stderr.take());
    wait_bounded(&mut child).map(|s| s.success()).unwrap_or(false)
}

/// Same as probe_ok but hands back stdout. Used only for `xcode-select -p`.
fn run_capture(program: &Path, args: &[&str]) -> Option<String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let out = child.stdout.take();
    drain(child.stderr.take());
    let collector = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(mut o) = out {
            use std::io::Read;
            let _ = o.read_to_string(&mut buf);
        }
        buf
    });
    let ok = wait_bounded(&mut child).map(|s| s.success()).unwrap_or(false);
    let text = collector.join().unwrap_or_default();
    if ok {
        Some(text)
    } else {
        None
    }
}

/// Read a pipe to nothing on its own thread. It ends at EOF, which happens when
/// the child exits or is killed, so no thread is left behind.
fn drain<R: std::io::Read + Send + 'static>(pipe: Option<R>) {
    if let Some(mut r) = pipe {
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut r, &mut std::io::sink());
        });
    }
}

fn probe_tool(tool: &str, args: &[&str]) -> bool {
    match resolve(tool) {
        Some(p) => probe_ok(&p, args),
        None => false,
    }
}

/// `probe_tool`, memoised per tool. The answer cannot change while the app runs
/// without the user installing a toolchain underneath it, and re-probing on
/// every Code view repaint would spawn a process per keystroke.
///
/// The cache is PER TOOL rather than one snapshot of all four, which is the
/// point: asking whether git exists must spawn git and nothing else. It used
/// to go through a single all-four probe, so the first Changes tab paint ran
/// `node --version`, `cargo --version` and `make --version` too: three
/// processes the caller never asked for, three chances to block on a slow or
/// hostile binary, and three probes charged to git's latency.
fn probe_cache() -> &'static Mutex<HashMap<String, bool>> {
    static CACHE: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn probe_cached(tool: &str, args: &[&str]) -> bool {
    if let Some(hit) = probe_cache().lock().unwrap_or_else(|e| e.into_inner()).get(tool) {
        return *hit;
    }
    let found = probe_tool(tool, args);
    probe_cache().lock().unwrap_or_else(|e| e.into_inner()).insert(tool.to_string(), found);
    found
}

// ---------------------------------------------------------------- public API

/// All four, for the headless driver that reports on the machine. Each one is
/// still its own cached probe, so calling this after `git_available()` costs
/// three processes, not four. Nothing in the app calls it: that is the point
/// of the split, and why it is marked as such.
#[allow(dead_code)]
pub fn toolchains() -> Toolchains {
    Toolchains {
        git: git_available(),
        node: probe_cached("node", &["--version"]),
        cargo: probe_cached("cargo", &["--version"]),
        make: probe_cached("make", &["--version"]),
    }
}

/// True when a real git can be executed. code.rs must consult this before
/// showing Changes, History or Branches: without it, every git() call on a Mac
/// with no Command Line Tools raises Apple's installer dialog.
pub fn git_available() -> bool {
    probe_cached("git", &["--version"])
}

/// Absolute path of the git binary to spawn, shim already resolved away.
pub fn git_program() -> Option<PathBuf> {
    if git_available() {
        resolve("git")
    } else {
        None
    }
}

// There is deliberately NO `toolchain_probe` command here. One was registered
// and never called from the front end: `GitInfo.available` (code.rs) already
// tells the Code view what it needs about git, and nothing in the app reacts
// to node, cargo or make. A command wired into the handler list with no caller
// reads as live API to the next person. `toolchains()` stays for the headless
// driver, which is its only real consumer.

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stub_group_is_recognised_when_present() {
        // On a machine with the Command Line Tools layout, /usr/bin/git shares
        // its inode with the canaries. On a machine without /usr/bin/git this
        // simply has nothing to assert, so the test stays green either way.
        let git = Path::new("/usr/bin/git");
        if !git.exists() {
            return;
        }
        let clang = Path::new("/usr/bin/clang");
        if ids_of(git).is_some() && ids_of(git) == ids_of(clang) {
            assert!(is_xcode_stub(git), "/usr/bin/git shares clang's inode but was not flagged");
        }
    }

    #[test]
    fn resolution_never_returns_the_shim() {
        for tool in ["git", "make", "node", "cargo"] {
            if let Some(p) = resolve(tool) {
                assert!(!is_xcode_stub(&p), "{tool} resolved to the Xcode shim at {}", p.display());
                assert!(is_executable_file(&p), "{tool} resolved to a non-executable");
            }
        }
    }

    #[test]
    fn asking_about_git_probes_git_and_nothing_else() {
        // `git_available()` used to go through one all-four snapshot, so the
        // first Changes tab paint also spawned node, cargo and make. The probe
        // cache is the ledger: after asking about git, it must hold git only.
        // Nothing else in this crate calls `probe_cached`, and no test calls
        // `toolchains()`, so this cache has exactly one writer here.
        let _ = git_available();
        let cache = probe_cache().lock().unwrap_or_else(|e| e.into_inner());
        let mut probed: Vec<String> = cache.keys().cloned().collect();
        probed.sort();
        assert_eq!(probed, vec!["git".to_string()], "asking about git probed {probed:?}");
    }

    #[test]
    fn a_missing_tool_is_false_not_a_panic() {
        assert!(!probe_tool("galactus-tool-that-does-not-exist", &["--version"]));
    }

    #[test]
    fn probe_kills_a_hanging_child() {
        // `cat` with stdin on /dev/null exits at once; `sleep 30` does not, and
        // must be reaped by the deadline rather than blocking the test.
        let sleep = match resolve("sleep") {
            Some(p) => p,
            None => return,
        };
        let started = Instant::now();
        assert!(!probe_ok(&sleep, &["30"]));
        let waited = started.elapsed();
        assert!(waited < Duration::from_secs(10), "probe waited {waited:?}, deadline not enforced");
        assert!(waited >= PROBE_TIMEOUT, "probe returned before its own deadline");
    }

    #[test]
    fn probe_reports_exit_status_not_existence() {
        // `false` exists and is executable, and must still report unavailable.
        if let Some(f) = resolve("false") {
            assert!(!probe_ok(&f, &[]));
        }
        if let Some(t) = resolve("true") {
            assert!(probe_ok(&t, &[]));
        }
    }
}
