// Galactus desktop, exact Python analysis through the bundled CPython.
//
// The app already ships a private CPython 3.12 for the install pipeline. That
// interpreter knows Python's grammar exactly, so the Code view uses it instead
// of guessing: `packaged/scripts/galactus_pylang.py` reads the EDITOR BUFFER
// on stdin and prints one JSON object with the exact SyntaxError and an exact
// outline from `ast` + `symtable`. Nothing is imported and nothing is run:
// the script only parses.
//
// THE TRAP, documented at lib.rs:133 and repeated here because getting it
// wrong breaks the whole plug-and-play promise: on a virgin macOS
// /usr/bin/python3 is a Command Line Tools shim that pops an install dialog.
// This module must go through the bundled interpreter. A developer checkout
// that has not run prepare-python falls back to the machine's own python3,
// and that fallback goes through `toolchain::resolve`, never through a bare
// `Command::new("python3")`: the bare form is a PATH lookup that finds the
// shim, and finding the shim means spawning Apple's installer at a user who
// only opened a .py file. No interpreter at all is the better answer, and it
// is the one this module gives.
//
// Concurrency contract, because an editor types faster than a process starts:
//   * one in-flight child per path;
//   * a newer request for the same path KILLS the older child, and the older
//     call returns SUPERSEDED rather than a bogus parse of a stale buffer;
//   * a child that has not answered within DEADLINE is killed too.
//
// This file is deliberately self-contained (it does not reach into lib.rs) so
// that `src/bin/gx-pylang.rs` can include it with #[path] and prove it from a
// terminal, with no Tauri app and no window. Its one sibling dependency is
// `toolchain.rs`, which the binary pulls in the same way; that module has no
// Tauri surface either.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Mirrors MAX_FILE_BYTES in code.rs: the workspace refuses to read a bigger
/// file, so a bigger buffer cannot have come from the editor.
pub const MAX_SOURCE_BYTES: usize = 4 * 1024 * 1024;

/// How long a single analysis may take before the child is killed. Parsing a
/// 4 MB Python file takes well under a second; five seconds means something
/// is wrong, not something is slow.
pub const DEADLINE: Duration = Duration::from_secs(5);

/// Error returned when a newer request for the same path took over. Callers
/// must treat it as "no answer yet", never as a failure to show the user.
pub const SUPERSEDED: &str = "galactus:pylang:superseded";

// ---------------------------------------------------------------- payload

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PyError {
    /// "syntax", "value" (NUL bytes and friends), "encoding", "limit",
    /// "internal".
    pub kind: String,
    /// CPython's own wording, not ours.
    pub message: String,
    /// 1-based.
    pub line: u32,
    /// CPython's 1-based offset, when it gave one.
    pub offset: Option<u32>,
    /// 0-based column, ready for the editor.
    pub col: u32,
    pub end_line: u32,
    pub end_col: Option<u32>,
    /// The offending source line, as CPython echoed it.
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PySymbol {
    pub name: String,
    /// "function", "async function", "method", "async method", "class",
    /// "import", "variable".
    pub kind: String,
    pub line: u32,
    pub col: u32,
    pub end_line: u32,
    pub depth: u32,
    /// Signature for a def, bases for a class, dotted module for an import.
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PyScope {
    pub name: String,
    #[serde(rename = "type")]
    pub scope_type: String,
    pub line: u32,
    pub depth: u32,
    pub nested: bool,
    pub params: Vec<String>,
    pub globals: Vec<String>,
}

/// What this tier cannot do, carried in the payload so no UI can promise more.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PyLimits {
    pub types: bool,
    pub hover_types: bool,
    pub member_completion: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PyAnalysis {
    pub schema: u32,
    pub ok: bool,
    pub path: String,
    /// Interpreter that produced this, e.g. "3.12.11".
    pub python: String,
    pub error: Option<PyError>,
    pub symbols: Vec<PySymbol>,
    pub scopes: Vec<PyScope>,
    /// The outline hit MAX_SYMBOLS and was cut. Declared, never hidden.
    #[serde(default)]
    pub truncated: bool,
    pub limits: PyLimits,
    /// Filled in by this module, not by the script.
    #[serde(default)]
    pub elapsed_ms: u64,
}

// ---------------------------------------------------------------- resolution

/// Bundle Resources dir (packaged app), the src-tauri dir (dev run), or the
/// crate dir (cargo test). A deliberate twin of lib.rs::resource_dir: this
/// module must stay linkable on its own, and the two are ten lines each.
fn resource_dir() -> Option<PathBuf> {
    let has = |p: &PathBuf| p.join("packaged").exists() || p.join("python").exists();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(res) = exe.parent().and_then(|p| p.parent()).map(|p| p.join("Resources")) {
            if has(&res) {
                return Some(res);
            }
        }
    }
    let cwd = std::env::current_dir().unwrap_or_default();
    if has(&cwd) {
        return Some(cwd);
    }
    let dev = cwd.join("src-tauri");
    if has(&dev) {
        return Some(dev);
    }
    // Debug only: `cargo test` runs with the crate dir as cwd on some setups
    // and not on others. Kept out of release builds so no build-machine path
    // is ever baked into a shipped binary.
    #[cfg(debug_assertions)]
    {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        if has(&manifest) {
            return Some(manifest);
        }
    }
    None
}

/// The analysis script inside the bundle. `GALACTUS_PYLANG_SCRIPT` overrides
/// it, which is how the tests point at the checkout copy.
pub fn script_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("GALACTUS_PYLANG_SCRIPT") {
        if !p.is_empty() {
            let p = PathBuf::from(p);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let p = resource_dir()?.join("packaged/scripts/galactus_pylang.py");
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

/// Absolute path of the interpreter to run, or None when this machine has no
/// Python that can be spawned safely.
///
/// The order is: the explicit override, the interpreter bundled in the app,
/// then a developer checkout's own python3 RESOLVED THROUGH toolchain.rs.
/// The last step is the fix: `Command::new("python3")` is a bare PATH lookup,
/// and on a Mac without the Command Line Tools it lands on /usr/bin/python3,
/// which is the Xcode shim. Spawning that pops Apple's installer dialog at a
/// user who only opened a .py file, which is the exact trap toolchain.rs was
/// written for and which lib.rs documents at its `bundled_python()`.
/// `toolchain::resolve` searches PATH the way a terminal would, extends it
/// with the usual install prefixes, and never hands back the shim. When it
/// finds nothing, the answer is None and the caller reports a missing
/// interpreter: no Python is a far better outcome than a modal nobody asked
/// for.
pub fn python_interpreter() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("GALACTUS_PYTHON") {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    if let Some(res) = resource_dir() {
        let bin = res.join("python/bin/python3");
        if bin.is_file() {
            return Some(bin);
        }
    }
    crate::toolchain::resolve("python3").or_else(|| crate::toolchain::resolve("python"))
}

/// The interpreter as a ready command, in isolated mode (-I: no PYTHON* env
/// vars, no user site-packages).
pub fn python_command() -> Option<Command> {
    let mut c = Command::new(python_interpreter()?);
    c.arg("-I");
    Some(c)
}

/// The message shown when no interpreter could be resolved. One wording, so
/// the editor panel and the CLI say the same thing.
pub const NO_PYTHON: &str =
    "no Python interpreter: the app bundle carries none and this Mac has no real python3 \
     outside the Xcode Command Line Tools shim";

// ---------------------------------------------------------------- in flight

struct Slot {
    seq: u64,
    child: Arc<Mutex<Option<Child>>>,
}

fn inflight() -> &'static Mutex<HashMap<String, Slot>> {
    static MAP: OnceLock<Mutex<HashMap<String, Slot>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

static NEXT_SEQ: AtomicU64 = AtomicU64::new(1);

fn kill_child(shared: &Arc<Mutex<Option<Child>>>) {
    let mut guard = shared.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(child) = guard.as_mut() {
        let _ = child.kill();
    }
}

// ---------------------------------------------------------------- analysis

/// Analyse `source` (the editor buffer, never the file on disk) as if it were
/// at `path`. Blocking; call it off the UI thread.
pub fn analyze(source: &str, path: &str) -> Result<PyAnalysis, String> {
    analyze_with(source, path, None, DEADLINE)
}

/// The same, with the script and the deadline supplied. Exists so the tests
/// can drive the deadline and the kill-the-older-child paths deterministically
/// with a deliberately slow script, without touching process-wide environment
/// variables that every other test would then race against.
pub fn analyze_with(
    source: &str,
    path: &str,
    script_override: Option<&std::path::Path>,
    deadline: Duration,
) -> Result<PyAnalysis, String> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err(format!(
            "buffer is {} bytes, over the {} byte limit for Python analysis",
            source.len(),
            MAX_SOURCE_BYTES
        ));
    }
    let script = match script_override {
        Some(p) => p.to_path_buf(),
        None => script_path().ok_or(
            "galactus_pylang.py is missing: the app bundle is incomplete, reinstall Galactus",
        )?,
    };

    let started = Instant::now();
    let seq = NEXT_SEQ.fetch_add(1, Ordering::SeqCst);

    let mut cmd = python_command().ok_or(NO_PYTHON)?;
    cmd.arg(&script)
        .arg("--path")
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("cannot start the bundled Python ({}): {e}", script.display()))?;

    let mut stdin = child.stdin.take().ok_or("no stdin pipe")?;
    let mut stdout = child.stdout.take().ok_or("no stdout pipe")?;
    let mut stderr = child.stderr.take().ok_or("no stderr pipe")?;
    let shared: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(Some(child)));

    // Take over the slot for this path and stop whatever was still running
    // for it. Killed outside the map lock: the watchdog holds the child lock,
    // never the map lock, and this keeps the two orders from ever meeting.
    let previous = {
        let mut map = inflight().lock().unwrap_or_else(|e| e.into_inner());
        map.insert(
            path.to_string(),
            Slot {
                seq,
                child: shared.clone(),
            },
        )
    };
    if let Some(prev) = previous {
        kill_child(&prev.child);
    }

    // stdin on its own thread: a 4 MB buffer is far bigger than a pipe, and
    // writing it inline would deadlock against our own stdout read.
    let payload = source.to_string();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(payload.as_bytes());
        // Dropping closes the pipe, which is the child's EOF.
    });
    let reader_err = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });

    // Watchdog: wakes on the condvar the moment we are done, so a fast
    // analysis does not leave a thread sleeping for five seconds.
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let timed_out = Arc::new(Mutex::new(false));
    {
        let gate = gate.clone();
        let flag = timed_out.clone();
        let watched = shared.clone();
        std::thread::spawn(move || {
            let (lock, cv) = &*gate;
            let guard = lock.lock().unwrap_or_else(|e| e.into_inner());
            let (_guard, res) = cv
                .wait_timeout_while(guard, deadline, |done| !*done)
                .unwrap_or_else(|e| e.into_inner());
            if res.timed_out() {
                *flag.lock().unwrap_or_else(|e| e.into_inner()) = true;
                kill_child(&watched);
            }
        });
    }

    let mut out = String::new();
    let read_result = stdout.read_to_string(&mut out);
    let _ = writer.join();
    {
        let (lock, cv) = &*gate;
        let mut done = lock.lock().unwrap_or_else(|e| e.into_inner());
        *done = true;
        cv.notify_all();
    }
    {
        let mut guard = shared.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut child) = guard.take() {
            let _ = child.wait();
        }
    }
    let stderr_text = reader_err.join().unwrap_or_default();

    // Free the slot, unless a newer request already claimed it.
    let superseded = {
        let mut map = inflight().lock().unwrap_or_else(|e| e.into_inner());
        match map.get(path) {
            Some(slot) if slot.seq == seq => {
                map.remove(path);
                false
            }
            Some(_) => true,
            None => false,
        }
    };
    if superseded {
        return Err(SUPERSEDED.into());
    }
    if *timed_out.lock().unwrap_or_else(|e| e.into_inner()) {
        return Err(format!(
            "the Python analysis did not answer within {deadline:?} and was stopped"
        ));
    }
    read_result.map_err(|e| format!("cannot read the analysis output: {e}"))?;

    let mut parsed: PyAnalysis = serde_json::from_str(out.trim()).map_err(|e| {
        let hint = stderr_text.trim();
        if hint.is_empty() {
            format!("unreadable analysis output: {e}")
        } else {
            format!("the Python analysis failed: {}", last_line(hint))
        }
    })?;
    parsed.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(parsed)
}

fn last_line(s: &str) -> &str {
    s.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or(s)
}

/// Run the script's own assertions under the bundled interpreter. Used by the
/// CLI and by the tests to prove the interpreter and the script agree.
#[allow(dead_code)] // driven by the gx-pylang CLI, not by the app.
pub fn selftest() -> Result<String, String> {
    let script = script_path().ok_or("galactus_pylang.py is missing from the app bundle")?;
    let out = python_command()
        .ok_or(NO_PYTHON)?
        .arg(&script)
        .arg("--selftest")
        .output()
        .map_err(|e| format!("cannot start the bundled Python: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "selftest failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// ---------------------------------------------------------------- command

/// Tauri command. Async so Tauri keeps it off the UI thread; the blocking work
/// runs on the blocking pool because it waits on a child process.
#[tauri::command]
pub async fn py_analyze(source: String, path: String) -> Result<PyAnalysis, String> {
    tauri::async_runtime::spawn_blocking(move || analyze(&source, &path))
        .await
        .map_err(|e| format!("the Python analysis thread died: {e}"))?
}
