// Learned decisions (Laya), phase 2: Galactus collects its own task-detection
// decisions, labels them with its local model, trains a student and switches to
// it ONLY when it beats the heuristic on real traces.
//
// Everything here is off until the user turns it on in Settings > Apprentissage:
// nothing is downloaded, collected or trained before that.
//
//   <app support>/learning/
//     venv/            the toolkit, a venv created FROM the bundled Python
//     base/            the Laya multilingual checkpoint, pinned by revision + sha256
//     traces.jsonl     one redacted row per turn (redacted by the webview BEFORE it
//                      reaches this file), capped at 10 000 rows or 90 days
//     checkpoints/<id> every trained student, accepted or rejected
//     jobs/<id>/       the inputs and outputs of one training run
//     state.json       which checkpoint is active, the rollback history, the numbers
//     sidecar.log      the decision service's log
//
// THE RULES THIS FILE KEEPS, the same ones engines.rs keeps:
//   - Nothing that blocks runs on an async worker: every command that touches the
//     disk, a process or a socket goes through spawn_blocking.
//   - Every child dies with the app, in every death mode: killed on RunEvent::Exit
//     (shutdown), and watched by a detached shell for the crash / kill -9 cases.
//   - The sidecar listens on loopback only, on a port of its own range.
//   - The heuristic stays the answer whenever the student is absent, slow (over
//     50 ms), not ready, or not active. decide() returns an error then, and the
//     webview falls back to detectTask().
//
// The contract with the Python side (app/tools/decisions/learn.py):
//   serve    --port P --checkpoint DIR           GET /health, POST /decide
//   label    --traces F --out F --teacher-url U   U = http://127.0.0.1:<primary>/v1
//   train    --data F --out DIR --base DIR
//   evaluate --checkpoint DIR --test F --heuristic-json F
// Progress is JSON lines {phase, pct, message} on stdout, exit 0 is success. The
// evaluation's numbers are read from its last JSON line carrying "student" and
// "heuristic", and the GATE IS DECIDED HERE (gate(), a pure function), not in
// Python, so the rule the UI states is the rule the code applies.

use crate::*;
use serde::Deserialize;
use std::io::Read;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::AtomicU32;
use std::sync::mpsc;

/// The five task ids of app/src/autotask.ts. A student answer outside them is
/// not an answer.
pub(crate) const TASKS: [&str; 5] = ["general", "code", "scripting", "writing", "reasoning"];

const TRACE_CAP_ROWS: usize = 10_000;
const TRACE_MAX_AGE_SECS: u64 = 90 * 86_400;
/// A trace row is a redacted message and a few fields. Anything larger is a
/// pasted file that redaction let through, and it is refused rather than kept.
const TRACE_ROW_MAX_BYTES: usize = 64 * 1024;
/// The floor the UI states: learn.py holds out about a quarter of the traces
/// for the test, and the gate wants 60 there, so about 4 x 60. The real check
/// is on the split itself (check_splits), before any labelling.
pub(crate) const MIN_TRACES_TO_TRAIN: usize = 240;

const DECIDE_BUDGET: Duration = Duration::from_millis(50);
/// Loading the checkpoint (644 MB) and warming MPS takes seconds, rarely more
/// than a minute; past this the service is declared failed and killed.
const SIDECAR_READY_DEADLINE: Duration = Duration::from_secs(180);
/// A service that failed is not restarted by every keystroke: one attempt per
/// this interval.
const SIDECAR_RETRY_AFTER: Duration = Duration::from_secs(60);
/// Right after the engines' range, so the two never hand out the same port.
const SIDECAR_PORT_BASE: u16 = SERVER_PORT_BASE + SERVER_PORT_SPAN;
const SIDECAR_PORT_SPAN: u16 = 10;

/// What `learn.py splits` says, checked before the teacher is asked anything:
/// labelling hundreds of traces for a test split the gate must refuse is
/// minutes of the user's machine for nothing.
pub(crate) fn check_splits(lines: &[Value]) -> Result<(), String> {
    let splits = lines
        .iter()
        .rev()
        .find_map(|v| v.get("splits").filter(|s| s.is_object()))
        .ok_or("learn.py splits returned no split sizes")?;
    let test = splits.get("test").and_then(Value::as_u64).ok_or("learn.py splits returned no test size")?;
    if test < GATE_MIN_N {
        return Err(format!(
            "{test} traces de test, {GATE_MIN_N} nécessaires (environ 4× plus de traces)"
        ));
    }
    Ok(())
}

// Gate, all three required, on the held-out split of REAL traces.
const GATE_MIN_N: u64 = 60;
const GATE_MIN_GAIN: f64 = 0.03;
const GATE_MAX_ECE: f64 = 0.10;

/// Used when requirements-learning.txt does not declare its download size in a
/// `# download-bytes: N` comment. torch for macOS arm64 dominates.
const TOOLKIT_BYTES_FALLBACK: u64 = 250_000_000;

// ------------------------------------------------------ base checkpoint pin

const BASE_REPO: &str = "convaiinnovations/laya";
/// Commit of the Hugging Face repo, read on 2026-09-23. A moving "main" would
/// let the repo owner change the model under every installed app.
const BASE_REVISION: &str = "5e7b2b1b8ca2ecdd3f2322d94069c9b6ce7e844b";
const BASE_SUBFOLDER: &str = "multilingual";

struct PinnedFile {
    path: &'static str,
    size: u64,
    sha256: &'static str,
}

/// Every file of `multilingual/` at BASE_REVISION. LFS hashes are the ones the
/// Hub publishes; the small files were downloaded and hashed.
const BASE_FILES: [PinnedFile; 5] = [
    PinnedFile {
        path: "rl_agent_config.json",
        size: 472,
        sha256: "25061739243b617ad88d1219ba6f8a9c86c5881ca28df024fa2d9b3b2fcc30c6",
    },
    PinnedFile {
        path: "encoder/config.json",
        size: 1938,
        sha256: "83f6916d13ef0f556ac461f28308dc2bffa7ebeadee8ec9e2db5812020ea5bb4",
    },
    PinnedFile {
        path: "tokenizer/tokenizer_config.json",
        size: 524,
        sha256: "6c6b2d8e3c84ce0e671c129cd6b374b235d6f9863042a5836358d00a89bbb5a1",
    },
    PinnedFile {
        path: "tokenizer/tokenizer.json",
        size: 34_363_188,
        sha256: "609d8f4c067cd3950f88594c5a802616cea245823836ef5848ee4fc40aab5b6f",
    },
    PinnedFile {
        path: "model.safetensors",
        size: 643_835_514,
        sha256: "9d628fd971b700382ac6f65920a86f149777b2e748e0c955fb3b19695aa8f204",
    },
];

fn base_bytes() -> u64 {
    BASE_FILES.iter().map(|f| f.size).sum()
}

// ------------------------------------------------------------------ layout

/// Where everything lives. A struct rather than free functions so the tests
/// run against a temporary folder and never touch the user's data.
#[derive(Clone, Debug)]
pub(crate) struct Layout {
    pub(crate) root: PathBuf,
}

impl Layout {
    fn app() -> Self {
        Layout { root: app_support().join("learning") }
    }
    fn venv(&self) -> PathBuf {
        self.root.join("venv")
    }
    fn python(&self) -> PathBuf {
        self.venv().join("bin/python")
    }
    fn venv_marker(&self) -> PathBuf {
        self.venv().join(".galactus-ready")
    }
    fn base(&self) -> PathBuf {
        self.root.join("base")
    }
    fn base_marker(&self) -> PathBuf {
        self.base().join(".galactus-ready")
    }
    fn traces(&self) -> PathBuf {
        self.root.join("traces.jsonl")
    }
    fn state(&self) -> PathBuf {
        self.root.join("state.json")
    }
    fn checkpoints(&self) -> PathBuf {
        self.root.join("checkpoints")
    }
    fn jobs(&self) -> PathBuf {
        self.root.join("jobs")
    }
    fn sidecar_log(&self) -> PathBuf {
        self.root.join("sidecar.log")
    }
    fn ensure(&self) -> Result<(), String> {
        std::fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        set_private_mode(&self.root, 0o700)
    }
}

/// A checkpoint id is a name this code gave (a timestamp); anything else
/// could walk out of the folder through state.json.
pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('.')
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The folder of checkpoint `id`, refused when the id is not one of ours or
/// when the folder resolves outside `checkpoints/` (a symlink planted there).
pub(crate) fn checkpoint_path(layout: &Layout, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err(format!("invalid checkpoint id {id:?}"));
    }
    let dir = layout.checkpoints().join(id);
    if dir.exists() {
        let root = layout.checkpoints().canonicalize().map_err(|e| e.to_string())?;
        let real = dir.canonicalize().map_err(|e| e.to_string())?;
        if !real.starts_with(&root) {
            return Err(format!("checkpoint {id} resolves outside the learning folder"));
        }
    }
    Ok(dir)
}

/// The folder holding learn.py and requirements-learning.txt: the bundle's
/// packaged copy, else the checkout's app/tools/decisions for a dev run.
fn toolkit_dir() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(res) = resource_dir() {
        candidates.push(res.join("packaged/decisions"));
    }
    if let Ok(root) = galactus_root() {
        candidates.push(root.join("app/tools/decisions"));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("tools/decisions"));
        candidates.push(cwd.join("../tools/decisions"));
    }
    candidates.into_iter().find(|d| d.join("learn.py").is_file())
}

fn requirements(toolkit: &Path) -> PathBuf {
    toolkit.join("requirements-learning.txt")
}

/// FNV-1a 64: stable across Rust versions (DefaultHasher is not), so an app
/// upgrade reinstalls the toolkit only when its pins really changed.
fn fingerprint(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// `# download-bytes: N` from the requirements file, when declared.
pub(crate) fn declared_download_bytes(requirements: &str) -> Option<u64> {
    requirements.lines().find_map(|l| {
        let rest = l.trim().strip_prefix('#')?.trim();
        let value = rest.strip_prefix("download-bytes:")?;
        value.trim().replace(['_', ' '], "").parse().ok()
    })
}

fn venv_ready(layout: &Layout, toolkit: Option<&Path>) -> bool {
    let Some(toolkit) = toolkit else { return false };
    let Ok(req) = std::fs::read(requirements(toolkit)) else { return false };
    layout.python().is_file()
        && std::fs::read_to_string(layout.venv_marker()).map(|m| m.trim() == fingerprint(&req)).unwrap_or(false)
}

fn base_ready(layout: &Layout) -> bool {
    std::fs::read_to_string(layout.base_marker()).map(|m| m.trim() == BASE_REVISION).unwrap_or(false)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn iso_utc(secs: u64) -> String {
    let c = crate::cron::civil_from_unix_utc(secs as i64);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        c.year, c.month, c.day, c.hour, c.minute, c.second
    )
}

fn write_atomic(path: &Path, payload: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("no parent directory")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("f");
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    std::fs::write(&tmp, payload).map_err(|e| e.to_string())?;
    let _ = set_private_mode(&tmp, 0o600);
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

/// What decide() needs on every message, read once and kept until something
/// changes it: the switch and the active checkpoint. Every writer of either
/// (save_state, decisions_set_active, settings_set on a learning_ key) drops
/// it AFTER writing, so the next decide() reads the new value.
#[derive(Clone, Debug, PartialEq)]
struct Switches {
    on: bool,
    active: Option<String>,
}

static SWITCHES: Mutex<Option<Switches>> = Mutex::new(None);
/// Bumped by every invalidation. A reader that loaded the files while a writer
/// invalidated does not store what it read: it may be the old value.
static SWITCHES_GEN: AtomicU64 = AtomicU64::new(0);

pub(crate) fn invalidate_cache() {
    let mut cached = SWITCHES.lock().unwrap_or_else(|e| e.into_inner());
    SWITCHES_GEN.fetch_add(1, Ordering::SeqCst);
    *cached = None;
}

fn switches(layout: &Layout) -> Switches {
    if let Some(s) = SWITCHES.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        return s;
    }
    let generation = SWITCHES_GEN.load(Ordering::SeqCst);
    let fresh = Switches { on: setting_on("learning_active"), active: load_state(layout).active };
    let mut cached = SWITCHES.lock().unwrap_or_else(|e| e.into_inner());
    if SWITCHES_GEN.load(Ordering::SeqCst) == generation {
        *cached = Some(fresh.clone());
    }
    fresh
}

/// learning_threshold as the webview uses it: 0.6 unless a probability is set.
pub(crate) fn user_threshold(settings: &HashMap<String, String>) -> f64 {
    settings
        .get("learning_threshold")
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|t| t.is_finite() && (0.0..=1.0).contains(t))
        .unwrap_or(0.6)
}

fn setting_on(key: &str) -> bool {
    settings_load().get(key).map(|v| v == "1").unwrap_or(false)
}

// ------------------------------------------------------------------- state

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub(crate) struct LearnState {
    /// The checkpoint the student answers from; None means the heuristic.
    #[serde(default)]
    pub(crate) active: Option<String>,
    /// Previously active checkpoints, oldest first. A rollback pops the last.
    #[serde(default)]
    pub(crate) history: Vec<String>,
    /// The last training result, accepted or not, as sent to the UI.
    #[serde(default)]
    pub(crate) last: Option<Value>,
    /// Rejected runs with their numbers, newest last, capped.
    #[serde(default)]
    pub(crate) rejected: Vec<Value>,
}

/// Numbers of rejected runs kept in state.json (a few hundred bytes each).
const REJECTED_KEPT: usize = 20;
/// Checkpoint FOLDERS kept (644 MB each): the two newest rejected runs, for a
/// look at what failed, and two steps of rollback history. Never the active one.
const REJECTED_DIRS_KEPT: usize = 2;
const HISTORY_KEPT: usize = 2;

fn state_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn load_state(layout: &Layout) -> LearnState {
    std::fs::read_to_string(layout.state())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_state(layout: &Layout, state: &LearnState) -> Result<(), String> {
    layout.ensure()?;
    let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    let written = write_atomic(&layout.state(), text.as_bytes());
    invalidate_cache();
    written
}

/// The state after a gated run: an accepted checkpoint becomes active and the
/// one it replaces goes on the rollback history; a rejected one changes nothing
/// but the record.
pub(crate) fn apply_result(mut state: LearnState, id: &str, result: &Value) -> LearnState {
    if result.get("accepted").and_then(Value::as_bool) == Some(true) {
        if let Some(previous) = state.active.take() {
            state.history.push(previous);
        }
        state.active = Some(id.to_string());
    } else {
        state.rejected.push(result.clone());
        let over = state.rejected.len().saturating_sub(REJECTED_KEPT);
        state.rejected.drain(..over);
    }
    state.last = Some(result.clone());
    state
}

/// The history trimmed to its newest HISTORY_KEPT entries.
pub(crate) fn trim_history(mut state: LearnState) -> LearnState {
    let over = state.history.len().saturating_sub(HISTORY_KEPT);
    state.history.drain(..over);
    state
}

/// Checkpoint folders nothing refers to any more: not active, not in the
/// (trimmed) history, not one of the newest rejected runs. `existing` is what
/// `checkpoints/` holds.
pub(crate) fn doomed_checkpoints(state: &LearnState, existing: &[String]) -> Vec<String> {
    let mut keep: Vec<&str> = Vec::new();
    keep.extend(state.active.as_deref());
    keep.extend(state.history.iter().map(String::as_str));
    keep.extend(
        state
            .rejected
            .iter()
            .rev()
            .filter_map(|r| r.get("checkpoint").and_then(Value::as_str))
            .take(REJECTED_DIRS_KEPT),
    );
    existing.iter().filter(|id| !keep.contains(&id.as_str())).cloned().collect()
}

/// Delete the doomed folders. Only while no training run is writing one.
fn sweep_checkpoints(layout: &Layout, state: &LearnState) {
    let existing: Vec<String> = std::fs::read_dir(layout.checkpoints())
        .map(|d| d.flatten().filter_map(|e| e.file_name().to_str().map(str::to_string)).collect())
        .unwrap_or_default();
    for id in doomed_checkpoints(state, &existing) {
        if let Ok(dir) = checkpoint_path(layout, &id) {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

/// What a finished job folder keeps: its numbers. The traces snapshot, the
/// labels, the heuristic answers and the log hold user text, and they go
/// whatever the outcome (accepted, rejected, failed, cancelled).
pub(crate) fn scrub_job(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name == "eval.json" || name == "result.json" {
            continue;
        }
        let path = e.path();
        if path.is_dir() {
            let _ = std::fs::remove_dir_all(&path);
        } else {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// One step back: the previous active checkpoint, or the heuristic alone when
/// there is none. The checkpoint rolled back from is swept by the caller.
pub(crate) fn rolled_back(mut state: LearnState) -> Result<LearnState, String> {
    if state.active.is_none() {
        return Err("no student is active: the heuristic is already in use".into());
    }
    state.active = state.history.pop();
    Ok(state)
}

// -------------------------------------------------------------------- gate

#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct Verdict {
    pub(crate) accepted: bool,
    pub(crate) student: Value,
    pub(crate) heuristic: Value,
    /// The student at the user's threshold with the heuristic behind it, as
    /// evaluate reported it; Null when absent.
    pub(crate) policy: Value,
    /// Why it was rejected, one sentence per failed condition.
    pub(crate) reasons: Vec<String>,
}

fn num(v: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|k| v.get(*k).and_then(Value::as_f64))
}

/// The object carrying "student" and "heuristic", at the root or under "result".
fn eval_body(eval: &Value) -> Option<&Value> {
    if eval.get("student").is_some() && eval.get("heuristic").is_some() {
        return Some(eval);
    }
    eval.get("result").filter(|r| r.get("student").is_some() && r.get("heuristic").is_some())
}

/// The gate, over evaluate's JSON:
///   - student.n >= 60 held-out real traces,
///   - policy.acc >= heuristic.acc + 3 points, where the policy is what the app
///     would really do (the student above the user's threshold, the heuristic
///     below it and on short messages),
///   - student.ece <= 0.10.
///
/// A missing number fails its condition: a checkpoint is never activated on
/// numbers nobody measured.
pub(crate) fn gate(eval: &Value) -> Verdict {
    let Some(body) = eval_body(eval) else {
        return Verdict {
            accepted: false,
            student: Value::Null,
            heuristic: Value::Null,
            policy: Value::Null,
            reasons: vec!["the evaluation returned no student and heuristic numbers".into()],
        };
    };
    let s = &body["student"];
    let h = &body["heuristic"];
    let p = &body["policy"];
    let s_acc = num(s, &["acc", "accuracy"]);
    let s_ece = num(s, &["ece"]);
    let s_n = num(s, &["n"]).map(|n| n as u64);
    let h_acc = num(h, &["acc", "accuracy"]);
    let h_n = num(h, &["n"]).map(|n| n as u64).or(s_n);
    let p_acc = num(p, &["acc", "accuracy"]);
    let mut reasons = Vec::new();
    match s_n {
        Some(n) if n >= GATE_MIN_N => {}
        Some(n) => reasons.push(format!("only {n} held-out traces, {GATE_MIN_N} needed")),
        None => reasons.push("the held-out size is missing".into()),
    }
    match (p_acc, h_acc) {
        // A small epsilon: 0.70 + 0.03 must pass at 0.73 despite binary floats.
        (Some(a), Some(b)) if a + 1e-9 >= b + GATE_MIN_GAIN => {}
        (Some(a), Some(b)) => reasons.push(format!(
            "with the student at your threshold, accuracy is {:.1} %, not {:.0} points above the heuristic's {:.1} %",
            a * 100.0,
            GATE_MIN_GAIN * 100.0,
            b * 100.0
        )),
        (None, _) => reasons.push("the accuracy at your threshold (policy) is missing".into()),
        (_, None) => reasons.push("the heuristic's accuracy is missing".into()),
    }
    match s_ece {
        Some(e) if e <= GATE_MAX_ECE + 1e-9 => {}
        Some(e) => reasons.push(format!("calibration error {e:.3} is above {GATE_MAX_ECE:.2}")),
        None => reasons.push("the calibration error is missing".into()),
    }
    let policy = if p.is_object() { p.clone() } else { Value::Null };
    Verdict {
        accepted: reasons.is_empty(),
        student: json!({"acc": s_acc, "ece": s_ece, "n": s_n}),
        heuristic: json!({"acc": h_acc, "n": h_n}),
        policy,
        reasons,
    }
}

// ------------------------------------------------------------------ traces

fn trace_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Seconds since the epoch of a row's "ts". The webview writes Date.now()
/// (milliseconds): anything past year 33658 in seconds is read as milliseconds.
fn row_ts(line: &str) -> Option<u64> {
    let v: Value = serde_json::from_str(line).ok()?;
    let t = v.get("ts")?.as_f64()?;
    if !t.is_finite() || t < 0.0 {
        return None;
    }
    Some(if t > 1e12 { (t / 1000.0) as u64 } else { t as u64 })
}

/// One row per trace id, the LAST written winning, at the place of that last
/// write. The webview appends a row again when its outcome becomes known
/// (swap undone two turns later), so the file holds several versions of one
/// turn; learn.py keeps the last, and so does every count made here. Rows
/// without an id are kept as they are.
pub(crate) fn dedupe_rows(lines: Vec<String>) -> Vec<String> {
    let ids: Vec<Option<String>> = lines
        .iter()
        .map(|l| {
            serde_json::from_str::<Value>(l)
                .ok()
                .and_then(|v| v.get("id").and_then(Value::as_str).map(str::to_string))
        })
        .collect();
    let mut last: HashMap<&str, usize> = HashMap::new();
    for (i, id) in ids.iter().enumerate() {
        if let Some(id) = id {
            last.insert(id.as_str(), i);
        }
    }
    let keep: Vec<bool> = ids
        .iter()
        .enumerate()
        .map(|(i, id)| id.as_deref().is_none_or(|id| last.get(id) == Some(&i)))
        .collect();
    lines.into_iter().zip(keep).filter(|(_, k)| *k).map(|(l, _)| l).collect()
}

/// The traces as learn.py will read them: one row per id.
fn read_traces(path: &Path) -> Vec<String> {
    dedupe_rows(read_lines(path))
}

/// The cap: duplicates collapse to their last version, rows older than 90 days
/// go, then the oldest beyond 10 000. A row that does not parse, or carries no
/// time, cannot be aged and goes too.
pub(crate) fn cap_rows(lines: Vec<String>, now: u64) -> Vec<String> {
    let oldest = now.saturating_sub(TRACE_MAX_AGE_SECS);
    let mut kept: Vec<String> = dedupe_rows(lines)
        .into_iter()
        .filter(|l| row_ts(l).is_some_and(|t| t >= oldest))
        .collect();
    let over = kept.len().saturating_sub(TRACE_CAP_ROWS);
    kept.drain(..over);
    kept
}

fn read_lines(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .map(|t| t.lines().filter(|l| !l.trim().is_empty()).map(str::to_string).collect())
        .unwrap_or_default()
}

/// Append one row, then apply the cap. The file is rewritten (atomically) only
/// when the cap removed something; otherwise the row is appended.
/// What this process knows of a traces file without reading it: its row
/// count, and when its rows were last aged. An append is then a plain append,
/// and the whole file (up to 10 000 rows) is read and parsed only when the
/// count passes the cap or once a day for the 90-day rule.
#[derive(Clone, Copy, Debug)]
struct TraceMeta {
    rows: usize,
    aged_at: u64,
}

static TRACE_META: OnceLock<Mutex<HashMap<PathBuf, TraceMeta>>> = OnceLock::new();

fn trace_meta() -> std::sync::MutexGuard<'static, HashMap<PathBuf, TraceMeta>> {
    TRACE_META.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|e| e.into_inner())
}

/// Forget what is known of `path`: after a clear, a forget or any rewrite not
/// made by trace_append_at.
fn forget_trace_meta(path: &Path) {
    trace_meta().remove(path);
}

pub(crate) fn trace_append_at(path: &Path, row: Value, now: u64) -> Result<(), String> {
    let Value::Object(mut map) = row else {
        return Err("a trace row must be a JSON object".into());
    };
    map.entry("ts").or_insert(json!(now));
    let line = serde_json::to_string(&Value::Object(map)).map_err(|e| e.to_string())?;
    if line.len() > TRACE_ROW_MAX_BYTES {
        return Err(format!("trace row too large ({} bytes, {TRACE_ROW_MAX_BYTES} max)", line.len()));
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let known = trace_meta().get(path).copied();
    let cheap = known.is_some_and(|m| m.rows < TRACE_CAP_ROWS && now.saturating_sub(m.aged_at) < 86_400);
    if cheap {
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| e.to_string())?;
        let _ = set_private_mode(path, 0o600);
        f.write_all(format!("{line}\n").as_bytes()).map_err(|e| e.to_string())?;
        if let Some(m) = trace_meta().get_mut(path) {
            m.rows += 1;
        }
        return Ok(());
    }
    let mut all = read_lines(path);
    all.push(line);
    let capped = cap_rows(all, now);
    let mut text = capped.join("\n");
    if !text.is_empty() {
        text.push('\n');
    }
    write_atomic(path, text.as_bytes())?;
    trace_meta().insert(path.to_path_buf(), TraceMeta { rows: capped.len(), aged_at: now });
    Ok(())
}

/// {trace id: heuristic task}, for evaluate: the heuristic is the app's
/// detectTask(), recorded in the row when the turn happened, never re-run in
/// Python.
pub(crate) fn heuristic_answers(lines: &[String]) -> Value {
    let mut out = serde_json::Map::new();
    for l in lines {
        let Ok(v) = serde_json::from_str::<Value>(l) else { continue };
        let Some(id) = v.get("id").and_then(Value::as_str) else { continue };
        let task = v
            .get("heuristic")
            .and_then(|h| h.get("task").or(Some(h)))
            .and_then(Value::as_str);
        if let Some(task) = task.filter(|t| TASKS.contains(t)) {
            out.insert(id.to_string(), json!(task));
        }
    }
    Value::Object(out)
}

/// Where an export may be written: an absolute path to a file (not a folder)
/// whose folder exists.
pub(crate) fn export_target(dest: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(dest.trim());
    if !p.is_absolute() {
        return Err("the export destination must be an absolute path".into());
    }
    if p.is_dir() {
        return Err("the export destination is a folder".into());
    }
    if p.file_name().is_none() || p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err("invalid export destination".into());
    }
    match p.parent() {
        Some(dir) if dir.is_dir() => Ok(p),
        _ => Err("the export destination's folder does not exist".into()),
    }
}

// --------------------------------------------------------------- processes

/// The one training or install job that may run, and its cancel flag.
static JOB: Mutex<Option<(&'static str, Arc<AtomicBool>)>> = Mutex::new(None);
/// Process-group id of the step running now (0 when none), for cancel and exit.
static STEP_PGID: AtomicU32 = AtomicU32::new(0);

struct JobGuard;
impl Drop for JobGuard {
    fn drop(&mut self) {
        *JOB.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

fn begin_job(kind: &'static str) -> Result<(Arc<AtomicBool>, JobGuard), String> {
    let mut job = JOB.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((running, _)) = job.as_ref() {
        return Err(format!("a {running} is already running"));
    }
    let flag = Arc::new(AtomicBool::new(false));
    *job = Some((kind, flag.clone()));
    Ok((flag, JobGuard))
}

fn running_job() -> Option<&'static str> {
    JOB.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|(k, _)| *k)
}

fn cancel_job() {
    if let Some((_, flag)) = JOB.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        flag.store(true, Ordering::SeqCst);
    }
    kill_group(STEP_PGID.load(Ordering::SeqCst));
}

/// TERM the whole process group: pip, a training run and curl all start
/// children of their own, and killing the leader alone orphans them.
fn kill_group(pgid: u32) {
    if pgid == 0 {
        return;
    }
    let _ = Command::new("/bin/kill").args(["-TERM", &format!("-{pgid}")]).status();
}

/// Its own process group, so kill_group reaches everything it starts.
fn own_group(cmd: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let _ = cmd;
}

/// Kill `pid`'s group when the app dies without saying so (crash, kill -9).
/// Like engine.rs's watchdog: it leaves when either process is gone, and it
/// checks the command name so a reused pid is never killed.
fn spawn_watchdog(pid: u32, comm: &str) {
    let app_pid = std::process::id();
    let _ = Command::new("/bin/zsh")
        .arg("-c")
        .arg(format!(
            "while kill -0 {app_pid} 2>/dev/null && kill -0 {pid} 2>/dev/null; do sleep 3; done; \
             if kill -0 {app_pid} 2>/dev/null; then exit 0; fi; \
             if ps -p {pid} -o comm= 2>/dev/null | grep -q {comm}; then \
               kill -TERM -{pid} 2>/dev/null; sleep 2; kill -9 -{pid} 2>/dev/null; fi"
        ))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

type Emit<'a> = &'a (dyn Fn(Value) + Sync);

fn tail(path: &Path, lines: usize) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

/// Run one step to its end, forwarding its progress. JSON lines with a "pct"
/// are rescaled into `span` of the whole job; every JSON line is returned.
/// stderr goes to `log`, whose tail is the error when the step fails.
fn run_step(
    mut cmd: Command,
    emit: Emit,
    cancel: &AtomicBool,
    phase: &str,
    span: (f64, f64),
    log: &Path,
    watch: &str,
) -> Result<Vec<Value>, String> {
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
        .map_err(|e| format!("open {}: {e}", log.display()))?;
    own_group(&mut cmd);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::from(log_file));
    let mut child = cmd.spawn().map_err(|e| format!("{phase}: cannot start: {e}"))?;
    STEP_PGID.store(child.id(), Ordering::SeqCst);
    spawn_watchdog(child.id(), watch);
    struct Clear;
    impl Drop for Clear {
        fn drop(&mut self) {
            STEP_PGID.store(0, Ordering::SeqCst);
        }
    }
    let _clear = Clear;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let mut objects = Vec::new();
    let mut plain = 0u32;
    loop {
        if cancel.load(Ordering::SeqCst) {
            kill_group(child.id());
            let _ = child.kill();
            let _ = child.wait();
            return Err("cancelled".into());
        }
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => {
                let trimmed = line.trim();
                if let Ok(v @ Value::Object(_)) = serde_json::from_str::<Value>(trimmed) {
                    if let Some(p) = v.get("pct").and_then(Value::as_f64) {
                        let pct = span.0 + (span.1 - span.0) * p.clamp(0.0, 100.0) / 100.0;
                        let message = v.get("message").and_then(Value::as_str).unwrap_or("");
                        emit(json!({"phase": phase, "pct": pct.round(), "message": message}));
                    }
                    objects.push(v);
                } else if !trimmed.is_empty() {
                    // pip and friends speak plain text: shown as a message, the
                    // bar creeping toward the end of the span without reaching it.
                    plain += 1;
                    let frac = 1.0 - 1.0 / (1.0 + plain as f64 / 8.0);
                    let pct = span.0 + (span.1 - span.0) * frac * 0.95;
                    let message: String = trimmed.chars().take(160).collect();
                    emit(json!({"phase": phase, "pct": pct.round(), "message": message}));
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if cancel.load(Ordering::SeqCst) {
        return Err("cancelled".into());
    }
    if !status.success() {
        let said = objects
            .iter()
            .rev()
            .find(|v| v.get("event").and_then(Value::as_str) == Some("error"))
            .and_then(|v| v.get("message").and_then(Value::as_str))
            .map(str::to_string);
        return Err(step_failure(phase, status.code(), said, &tail(log, 8)));
    }
    Ok(objects)
}

/// The sentence the UI shows for a failed learn.py step, from its exit code
/// (learn.py's documented codes), its own error line, and its log's tail.
pub(crate) fn step_failure(phase: &str, code: Option<i32>, said: Option<String>, log_tail: &str) -> String {
    let what = match code {
        Some(2) => "was called with arguments it does not accept (app and toolkit out of step)",
        Some(3) => "found the learning toolkit incomplete: reinstall it from Settings",
        Some(4) => "was given input it cannot use",
        Some(5) => "could not reach the local model that labels the traces",
        Some(130) => "was interrupted",
        Some(1) => "failed on an internal error",
        _ => "failed",
    };
    let mut out = format!("{phase} {what}");
    match (said, log_tail.trim()) {
        (Some(m), _) if !m.trim().is_empty() => out.push_str(&format!(": {}", m.trim())),
        (_, t) if !t.is_empty() => out.push_str(&format!(": {t}")),
        _ => {}
    }
    out
}

fn learn_cmd(layout: &Layout, toolkit: &Path, sub: &str) -> Command {
    let mut c = Command::new(layout.python());
    // -E: no PYTHON* variables; -s: no user site-packages; -B: no .pyc written
    // next to the scripts, which inside the bundle would break its signature.
    // Not -I: it would drop the script's folder from sys.path.
    c.args(["-E", "-s", "-B"]).arg(toolkit.join("learn.py")).arg(sub);
    c.current_dir(toolkit)
        .env("HF_HUB_OFFLINE", "1")
        .env("HF_HOME", layout.root.join("hf"))
        .env("GALACTUS_LAYA_BASE", layout.base())
        .env("TOKENIZERS_PARALLELISM", "false")
        .env("PYTORCH_ENABLE_MPS_FALLBACK", "1");
    c
}

// ----------------------------------------------------------------- install

fn sha256_of(path: &Path) -> Result<String, String> {
    let out = Command::new("/usr/bin/shasum")
        .args(["-a", "256"])
        .arg(path)
        .output()
        .map_err(|e| format!("shasum: {e}"))?;
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .next()
        .map(str::to_string)
        .ok_or_else(|| "shasum gave no digest".into())
}

fn download_base(layout: &Layout, emit: Emit, cancel: &AtomicBool, span: (f64, f64)) -> Result<(), String> {
    let partial = layout.root.join("base.partial");
    std::fs::create_dir_all(&partial).map_err(|e| e.to_string())?;
    let total = base_bytes() as f64;
    let mut done = 0u64;
    for f in &BASE_FILES {
        let dest = partial.join(f.path);
        if let Some(dir) = dest.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        // A file already complete and correct (an earlier, interrupted install)
        // is not downloaded again.
        let whole = std::fs::metadata(&dest).map(|m| m.len() == f.size).unwrap_or(false)
            && sha256_of(&dest).map(|h| h == f.sha256).unwrap_or(false);
        if !whole {
            let url = format!(
                "https://huggingface.co/{BASE_REPO}/resolve/{BASE_REVISION}/{BASE_SUBFOLDER}/{}",
                f.path
            );
            let mut cmd = Command::new("/usr/bin/curl");
            cmd.args(["-fsSL", "--proto", "=https", "--retry", "3", "-C", "-", "-o"])
                .arg(&dest)
                .arg(&url);
            own_group(&mut cmd);
            let mut child = cmd
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("curl: {e}"))?;
            STEP_PGID.store(child.id(), Ordering::SeqCst);
            spawn_watchdog(child.id(), "curl");
            let status = loop {
                if cancel.load(Ordering::SeqCst) {
                    kill_group(child.id());
                    let _ = child.kill();
                    let _ = child.wait();
                    STEP_PGID.store(0, Ordering::SeqCst);
                    return Err("cancelled".into());
                }
                if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
                    break s;
                }
                let have = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
                let pct = span.0 + (span.1 - span.0) * (done + have.min(f.size)) as f64 / total;
                emit(json!({"phase": "install", "pct": pct.round(), "message": format!("model: {}", f.path)}));
                std::thread::sleep(Duration::from_millis(500));
            };
            STEP_PGID.store(0, Ordering::SeqCst);
            if !status.success() {
                let mut err = String::new();
                if let Some(mut e) = child.stderr.take() {
                    let _ = e.read_to_string(&mut err);
                }
                return Err(format!("download of {} failed: {}", f.path, err.trim()));
            }
            let got = sha256_of(&dest)?;
            if got != f.sha256 {
                let _ = std::fs::remove_file(&dest);
                return Err(format!("{}: sha256 {got} does not match the pinned {}", f.path, f.sha256));
            }
        }
        done += f.size;
    }
    std::fs::write(partial.join(".galactus-ready"), BASE_REVISION).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(layout.base());
    std::fs::rename(&partial, layout.base()).map_err(|e| e.to_string())
}

/// The bundled interpreter is signed with the hardened runtime, and the
/// hardened runtime's library validation refuses every extension module not
/// signed by the same team: torch's would not load. The venv holds COPIES of
/// the interpreter (--copies), in the user's own folder, and those copies are
/// re-signed ad hoc without the runtime flag. The bundle itself is untouched.
fn unharden_venv_python(layout: &Layout) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Ok(());
    }
    let bin = layout.venv().join("bin");
    let entries = std::fs::read_dir(&bin).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let real_file = std::fs::symlink_metadata(&path).map(|m| m.file_type().is_file()).unwrap_or(false);
        if !name.starts_with("python") || !real_file {
            continue;
        }
        let out = Command::new("/usr/bin/codesign")
            .args(["--force", "--sign", "-"])
            .arg(&path)
            .output()
            .map_err(|e| format!("codesign: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "cannot prepare {name} for the toolkit: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
    }
    Ok(())
}

fn install_blocking(layout: &Layout, toolkit: &Path, emit: Emit, cancel: &AtomicBool) -> Result<(), String> {
    layout.ensure()?;
    let log = layout.root.join("install.log");
    let _ = std::fs::remove_file(&log);
    let req_path = requirements(toolkit);
    let req = std::fs::read(&req_path).map_err(|e| format!("{}: {e}", req_path.display()))?;
    if !venv_ready(layout, Some(toolkit)) {
        emit(json!({"phase": "install", "pct": 1, "message": "creating the Python environment"}));
        // FROM the bundled interpreter, never into it. --clear: a half-made
        // venv from an interrupted install is started over.
        let mut venv = python3_cmd();
        venv.args(["-m", "venv", "--clear", "--copies"]).arg(layout.venv());
        run_step(venv, emit, cancel, "install", (1.0, 5.0), &log, "python")?;
        unharden_venv_python(layout)?;
        let mut pip = Command::new(layout.python());
        pip.args(["-E", "-s", "-m", "pip", "install", "--disable-pip-version-check", "--no-input"])
            .args(["--require-hashes", "--prefer-binary", "-r"])
            .arg(&req_path)
            .env("PIP_NO_CACHE_DIR", "1");
        run_step(pip, emit, cancel, "install", (5.0, 60.0), &log, "python")?;
        std::fs::write(layout.venv_marker(), fingerprint(&req)).map_err(|e| e.to_string())?;
    }
    if !base_ready(layout) {
        download_base(layout, emit, cancel, (60.0, 99.0))?;
    }
    emit(json!({"phase": "install", "pct": 100, "message": "installed", "done": true}));
    Ok(())
}

// ------------------------------------------------------------------- train

/// The primary engine's port while it is ready: the teacher.
fn teacher_port() -> Result<u16, String> {
    let s = server_state().lock().unwrap_or_else(|e| e.into_inner());
    if s.phase == "ready" && s.port != 0 && s.model_id.is_some() {
        Ok(s.port)
    } else {
        Err("no primary model is ready: start one first, it labels the traces".into())
    }
}

/// Counts of label sources, from the last JSON line that reported them, else
/// from the labels file's "source" field.
fn label_counts(lines: &[Value], labels_file: &Path) -> Value {
    if let Some(l) = lines.iter().rev().find_map(|v| v.get("labels").filter(|l| l.is_object())) {
        return json!({
            "teacher": l.get("teacher").and_then(Value::as_u64).unwrap_or(0),
            "outcome": l.get("outcome").and_then(Value::as_u64).unwrap_or(0),
            "hand": l.get("hand").and_then(Value::as_u64).unwrap_or(0),
        });
    }
    let (mut teacher, mut outcome, mut hand) = (0u64, 0u64, 0u64);
    for l in read_lines(labels_file) {
        let Ok(v) = serde_json::from_str::<Value>(&l) else { continue };
        match v.get("source").and_then(Value::as_str) {
            Some("teacher") => teacher += 1,
            Some("outcome") => outcome += 1,
            Some("hand") => hand += 1,
            _ => {}
        }
    }
    json!({"teacher": teacher, "outcome": outcome, "hand": hand})
}

fn fresh_id(layout: &Layout) -> String {
    let base = now_secs().to_string();
    let mut id = base.clone();
    let mut n = 1;
    while layout.checkpoints().join(&id).exists() || layout.jobs().join(&id).exists() {
        n += 1;
        id = format!("{base}-{n}");
    }
    id
}

fn train_blocking(
    layout: &Layout,
    toolkit: &Path,
    port: u16,
    threshold: f64,
    emit: Emit,
    cancel: &AtomicBool,
) -> Result<Value, String> {
    let id = fresh_id(layout);
    let job = layout.jobs().join(&id);
    std::fs::create_dir_all(&job).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(layout.checkpoints()).map_err(|e| e.to_string())?;
    let log = job.join("train.log");
    // A snapshot: rows appended while the job runs do not move under it.
    let lines = {
        let _t = trace_lock();
        read_traces(&layout.traces())
    };
    let traces = job.join("traces.jsonl");
    write_atomic(&traces, format!("{}\n", lines.join("\n")).as_bytes())?;
    let heuristic = job.join("heuristic.json");
    write_atomic(&heuristic, heuristic_answers(&lines).to_string().as_bytes())?;
    let labels = job.join("labels.jsonl");
    let ckpt = layout.checkpoints().join(&id);
    struct Scrub(PathBuf);
    impl Drop for Scrub {
        fn drop(&mut self) {
            scrub_job(&self.0);
        }
    }
    let _scrub = Scrub(job.clone());

    let result = (|| -> Result<Value, String> {
        emit(json!({"phase": "label", "pct": 0, "message": "checking the held-out split"}));
        let mut c = learn_cmd(layout, toolkit, "splits");
        c.arg("--traces").arg(&traces);
        check_splits(&run_step(c, emit, cancel, "label", (0.0, 1.0), &log, "python")?)?;
        emit(json!({"phase": "label", "pct": 1, "message": "labelling traces with the local model"}));
        let mut c = learn_cmd(layout, toolkit, "label");
        c.arg("--traces").arg(&traces).arg("--out").arg(&labels);
        c.arg("--teacher-url").arg(format!("http://127.0.0.1:{port}/v1"));
        let mut seen = run_step(c, emit, cancel, "label", (1.0, 40.0), &log, "python")?;

        emit(json!({"phase": "train", "pct": 40, "message": "training the student"}));
        let mut c = learn_cmd(layout, toolkit, "train");
        c.arg("--data").arg(&labels).arg("--out").arg(&ckpt).arg("--base").arg(layout.base());
        seen.extend(run_step(c, emit, cancel, "train", (40.0, 85.0), &log, "python")?);

        emit(json!({"phase": "evaluate", "pct": 85, "message": "student against the heuristic"}));
        let mut c = learn_cmd(layout, toolkit, "evaluate");
        c.arg("--checkpoint").arg(&ckpt).arg("--test").arg(&labels);
        c.arg("--heuristic-json").arg(&heuristic);
        c.arg("--threshold").arg(format!("{threshold}")).args(["--min-chars", "8"]);
        let evaluated = run_step(c, emit, cancel, "evaluate", (85.0, 98.0), &log, "python")?;
        let eval = evaluated
            .iter()
            .rev()
            .find(|v| eval_body(v).is_some())
            .cloned()
            .ok_or("the evaluation printed no numbers")?;
        let _ = write_atomic(&job.join("eval.json"), eval.to_string().as_bytes());
        let verdict = gate(&eval);
        Ok(json!({
            "accepted": verdict.accepted,
            "student": verdict.student,
            "heuristic": verdict.heuristic,
            "policy": verdict.policy,
            "labels": label_counts(&seen, &labels),
            "reasons": verdict.reasons,
            "checkpoint": id,
            "date": iso_utc(now_secs()),
        }))
    })();

    let result = match result {
        Ok(r) => r,
        Err(e) => {
            // An unfinished checkpoint is not a rejected one: it goes.
            let _ = std::fs::remove_dir_all(&ckpt);
            return Err(e);
        }
    };
    let _ = write_atomic(&job.join("result.json"), result.to_string().as_bytes());
    {
        let _s = state_lock();
        let next = trim_history(apply_result(load_state(layout), &id, &result));
        save_state(layout, &next)?;
        sweep_checkpoints(layout, &next);
    }
    if result["accepted"] == json!(true) {
        // The next decide starts the service on the new checkpoint.
        stop_sidecar();
    }
    Ok(result)
}

// ---------------------------------------------------------------- sidecar

struct Sidecar {
    child: Child,
    port: u16,
    checkpoint: PathBuf,
    ready: Arc<AtomicBool>,
    generation: u64,
}

static SIDECAR: Mutex<Option<Sidecar>> = Mutex::new(None);
static SIDECAR_GEN: AtomicU64 = AtomicU64::new(0);
static SIDECAR_FAILED_AT: Mutex<Option<Instant>> = Mutex::new(None);

fn sidecar_lock() -> std::sync::MutexGuard<'static, Option<Sidecar>> {
    SIDECAR.lock().unwrap_or_else(|e| e.into_inner())
}

fn reap(mut s: Sidecar) {
    // Off the caller's thread: a process tearing down 644 MB of MPS buffers
    // takes a moment, and decide() has 50 ms.
    std::thread::spawn(move || {
        kill_group(s.child.id());
        let _ = s.child.kill();
        let _ = s.child.wait();
    });
}

/// Out of the table, in a statement of its own: an `if let` on
/// `sidecar_lock().take()` keeps the guard alive through its whole block, and
/// a wait() in there would hold every decide() behind a dying process.
// The binding is the point: as a tail expression the guard would live to the
// end of the caller's statement in edition 2021.
#[allow(clippy::let_and_return)]
fn take_sidecar() -> Option<Sidecar> {
    let taken = sidecar_lock().take();
    taken
}

pub(crate) fn stop_sidecar() {
    if let Some(s) = take_sidecar() {
        reap(s);
    }
}

/// Stop and WAIT for the service, with the table unlocked while it dies.
fn stop_sidecar_and_wait() {
    if let Some(mut s) = take_sidecar() {
        kill_group(s.child.id());
        let _ = s.child.kill();
        let _ = s.child.wait();
    }
}

fn pick_sidecar_port() -> Result<u16, String> {
    let taken = crate::engines::assigned_ports();
    (SIDECAR_PORT_BASE..SIDECAR_PORT_BASE + SIDECAR_PORT_SPAN)
        .filter(|p| !taken.contains(p))
        .find(|p| TcpListener::bind(("127.0.0.1", *p)).is_ok())
        .ok_or_else(|| {
            format!("no free port in {}..{}", SIDECAR_PORT_BASE, SIDECAR_PORT_BASE + SIDECAR_PORT_SPAN)
        })
}

enum Serving {
    Ready(u16),
    Starting,
    Absent,
}

fn sidecar_for(checkpoint: &Path) -> Serving {
    let mut guard = sidecar_lock();
    let Some(s) = guard.as_mut() else { return Serving::Absent };
    let exited = !matches!(s.child.try_wait(), Ok(None));
    if exited || s.checkpoint != checkpoint {
        if exited {
            *SIDECAR_FAILED_AT.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
        }
        if let Some(old) = guard.take() {
            reap(old);
        }
        return Serving::Absent;
    }
    if s.ready.load(Ordering::SeqCst) {
        Serving::Ready(s.port)
    } else {
        Serving::Starting
    }
}

/// Start the service in the background. The call that triggers it is not
/// kept waiting: it gets the heuristic, and a later one gets the student.
fn start_sidecar(layout: &Layout, toolkit: &Path, checkpoint: &Path) -> Result<(), String> {
    let mut guard = sidecar_lock();
    if guard.is_some() {
        return Ok(());
    }
    if let Some(at) = *SIDECAR_FAILED_AT.lock().unwrap_or_else(|e| e.into_inner()) {
        if at.elapsed() < SIDECAR_RETRY_AFTER {
            return Err("the student service failed recently; the heuristic is used meanwhile".into());
        }
    }
    let port = pick_sidecar_port()?;
    let log = std::fs::File::create(layout.sidecar_log()).map_err(|e| e.to_string())?;
    let err = log.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = learn_cmd(layout, toolkit, "serve");
    cmd.arg("--port").arg(port.to_string()).arg("--checkpoint").arg(checkpoint);
    own_group(&mut cmd);
    let child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err))
        .spawn()
        .map_err(|e| format!("start the student service: {e}"))?;
    spawn_watchdog(child.id(), "python");
    let ready = Arc::new(AtomicBool::new(false));
    let generation = SIDECAR_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    *guard = Some(Sidecar {
        child,
        port,
        checkpoint: checkpoint.to_path_buf(),
        ready: ready.clone(),
        generation,
    });
    drop(guard);
    std::thread::spawn(move || {
        let started = Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let mut guard = sidecar_lock();
            let alive = match guard.as_mut() {
                Some(s) if s.generation == generation => matches!(s.child.try_wait(), Ok(None)),
                // Stopped or replaced: this poller has nothing left to watch.
                _ => return,
            };
            if !alive || started.elapsed() > SIDECAR_READY_DEADLINE {
                *SIDECAR_FAILED_AT.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
                if let Some(s) = guard.take() {
                    reap(s);
                }
                return;
            }
            drop(guard);
            if matches!(http_request(port, "GET", "/health", None, Duration::from_secs(1)), Ok((200, _))) {
                ready.store(true, Ordering::SeqCst);
                return;
            }
        }
    });
    Ok(())
}

/// A minimal HTTP/1.1 exchange with the loopback service, bounded by
/// `budget` end to end. No keep-alive: one request, one connection.
fn http_request(
    port: u16,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    budget: Duration,
) -> Result<(u16, Vec<u8>), String> {
    let deadline = Instant::now() + budget;
    let left = || deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(1));
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut sock = TcpStream::connect_timeout(&addr, left()).map_err(|e| e.to_string())?;
    let _ = sock.set_nodelay(true);
    sock.set_write_timeout(Some(left())).map_err(|e| e.to_string())?;
    let body = body.unwrap_or(&[]);
    let head = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    sock.write_all(head.as_bytes()).map_err(|e| e.to_string())?;
    sock.write_all(body).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        if Instant::now() >= deadline {
            return Err("timed out".into());
        }
        sock.set_read_timeout(Some(left())).map_err(|e| e.to_string())?;
        match sock.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => raw.extend_from_slice(&buf[..n]),
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                return Err("timed out".into())
            }
            Err(e) => return Err(e.to_string()),
        }
        // A server that keeps the connection open despite "Connection: close"
        // is not waited on past its declared body.
        if complete(&raw) {
            break;
        }
    }
    parse_response(&raw)
}

/// True once the head and the Content-Length bytes of the body are in.
fn complete(raw: &[u8]) -> bool {
    let Some(split) = raw.windows(4).position(|w| w == b"\r\n\r\n") else { return false };
    let head = String::from_utf8_lossy(&raw[..split]).to_ascii_lowercase();
    head.lines()
        .find_map(|l| l.strip_prefix("content-length:").and_then(|v| v.trim().parse::<usize>().ok()))
        .is_some_and(|len| raw.len() >= split + 4 + len)
}

pub(crate) fn parse_response(raw: &[u8]) -> Result<(u16, Vec<u8>), String> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("malformed response")?;
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let status: u16 = head
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or("malformed status line")?;
    let body = &raw[split + 4..];
    let chunked = head
        .lines()
        .any(|l| l.to_ascii_lowercase().starts_with("transfer-encoding:") && l.to_ascii_lowercase().contains("chunked"));
    if !chunked {
        return Ok((status, body.to_vec()));
    }
    let mut out = Vec::new();
    let mut rest = body;
    loop {
        let eol = rest.windows(2).position(|w| w == b"\r\n").ok_or("malformed chunk")?;
        let size_hex = String::from_utf8_lossy(&rest[..eol]);
        let size = usize::from_str_radix(size_hex.split(';').next().unwrap_or("").trim(), 16)
            .map_err(|_| "malformed chunk size")?;
        rest = &rest[eol + 2..];
        if size == 0 {
            break;
        }
        if rest.len() < size {
            return Err("truncated chunk".into());
        }
        out.extend_from_slice(&rest[..size]);
        rest = rest.get(size + 2..).unwrap_or(&[]);
    }
    Ok((status, out))
}

/// {task, confidence} from the service's answer, refused unless the task is
/// one of the five and the confidence a probability.
pub(crate) fn parse_answer(body: &Value) -> Result<(String, f64), String> {
    let a = &body["answers"]["task"];
    let task = a.get("choice").and_then(Value::as_str).ok_or("the student gave no choice")?;
    if !TASKS.contains(&task) {
        return Err(format!("the student answered an unknown task {task:?}"));
    }
    let confidence = a.get("confidence").and_then(Value::as_f64).ok_or("the student gave no confidence")?;
    if !(0.0..=1.0).contains(&confidence) {
        return Err(format!("confidence {confidence} is not a probability"));
    }
    Ok((task.to_string(), confidence))
}

/// The state the student reads: the message, and the task in force before it
/// (detectTask's continuity bonus, which the student can now learn).
pub(crate) fn decide_state(state: Value, previous_task: Option<String>) -> Value {
    let mut obj = match state {
        Value::Object(m) => m,
        Value::String(s) => {
            let mut m = serde_json::Map::new();
            m.insert("message".into(), json!(s));
            m
        }
        other => {
            let mut m = serde_json::Map::new();
            m.insert("message".into(), json!(other.to_string()));
            m
        }
    };
    let prev = previous_task.filter(|p| TASKS.contains(&p.as_str()));
    obj.insert("previous_task".into(), json!(prev));
    Value::Object(obj)
}

fn decide_blocking(state: Value, previous_task: Option<String>) -> Result<Value, String> {
    let started = Instant::now();
    let layout = Layout::app();
    let sw = switches(&layout);
    if !sw.on {
        stop_sidecar();
        return Err("learned decisions are off".into());
    }
    let active = sw.active.ok_or("no student is active")?;
    let checkpoint = checkpoint_path(&layout, &active)?;
    let port = match sidecar_for(&checkpoint) {
        Serving::Ready(port) => port,
        Serving::Starting => return Err("the student is loading".into()),
        Serving::Absent => {
            if !layout.python().is_file() || !checkpoint.is_dir() {
                return Err("the learning toolkit or the student checkpoint is missing".into());
            }
            let toolkit = toolkit_dir().ok_or("learn.py is not shipped with this build")?;
            start_sidecar(&layout, &toolkit, &checkpoint)?;
            return Err("the student is starting".into());
        }
    };
    let body = json!({"state": decide_state(state, previous_task), "questions": "task-detection"});
    let budget = DECIDE_BUDGET.saturating_sub(started.elapsed());
    let (status, bytes) = http_request(port, "POST", "/decide", Some(body.to_string().as_bytes()), budget)
        .map_err(|e| format!("student: {e}"))?;
    if status != 200 {
        return Err(format!("student answered HTTP {status}"));
    }
    let answer: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let (task, confidence) = parse_answer(&answer)?;
    let elapsed = started.elapsed();
    if elapsed > DECIDE_BUDGET {
        return Err(format!("the student took {} ms", elapsed.as_millis()));
    }
    Ok(json!({"task": task, "confidence": confidence, "latency_ms": elapsed.as_secs_f64() * 1000.0}))
}

// --------------------------------------------------------------- commands

fn emitter(app: AppHandle) -> impl Fn(Value) + Sync {
    move |v: Value| {
        let _ = app.emit("galactus://learning", v);
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("the learning thread died: {e}"))?
}

fn status_blocking() -> Value {
    let layout = Layout::app();
    let toolkit = toolkit_dir();
    let venv = venv_ready(&layout, toolkit.as_deref());
    let base = base_ready(&layout);
    let toolkit_bytes = toolkit
        .as_deref()
        .and_then(|t| std::fs::read_to_string(requirements(t)).ok())
        .and_then(|r| declared_download_bytes(&r))
        .unwrap_or(TOOLKIT_BYTES_FALLBACK);
    let download_bytes = if venv { 0 } else { toolkit_bytes } + if base { 0 } else { base_bytes() };
    let traces = {
        let _t = trace_lock();
        read_traces(&layout.traces()).len()
    };
    let state = load_state(&layout);
    let job = running_job();
    let sidecar = match sidecar_lock().as_ref() {
        Some(s) if s.ready.load(Ordering::SeqCst) => "ready",
        Some(_) => "starting",
        None => "stopped",
    };
    json!({
        "installed": venv && base,
        "installing": job == Some("install"),
        "training": job == Some("training"),
        "download_bytes": download_bytes,
        "traces": traces,
        "active": state.active,
        "previous": state.history.last(),
        "last": state.last,
        "rejected": state.rejected.len(),
        "min_traces": MIN_TRACES_TO_TRAIN,
        "toolkit_shipped": toolkit.is_some(),
        "sidecar": sidecar,
    })
}

#[tauri::command]
pub async fn decisions_status() -> Result<Value, String> {
    blocking(|| Ok(status_blocking())).await
}

#[tauri::command]
pub async fn decisions_install(app: AppHandle) -> Result<(), String> {
    let toolkit = blocking(|| toolkit_dir().ok_or_else(|| "learn.py is not shipped with this build".to_string())).await?;
    let (cancel, guard) = begin_job("install")?;
    std::thread::spawn(move || {
        let _guard = guard;
        let emit = emitter(app);
        let layout = Layout::app();
        match install_blocking(&layout, &toolkit, &emit, &cancel) {
            Ok(()) => {}
            Err(e) if e == "cancelled" => emit(json!({"phase": "cancelled", "pct": 0, "message": "install cancelled", "job": "install"})),
            Err(e) => emit(json!({"phase": "error", "pct": 0, "message": e, "job": "install"})),
        }
    });
    Ok(())
}

/// Cancels the running job, install or training: only one runs at a time.
#[tauri::command]
pub async fn decisions_install_cancel() -> Result<(), String> {
    blocking(|| {
        cancel_job();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn decisions_train_cancel() -> Result<(), String> {
    decisions_install_cancel().await
}

#[tauri::command]
pub async fn decisions_decide(state: Value, previous_task: Option<String>) -> Result<Value, String> {
    blocking(move || decide_blocking(state, previous_task)).await
}

/// Returns false, and writes nothing, while collecting is off.
#[tauri::command]
pub async fn decisions_trace_append(row: Value) -> Result<bool, String> {
    blocking(move || {
        if !setting_on("learning_collect") {
            return Ok(false);
        }
        let layout = Layout::app();
        layout.ensure()?;
        let _t = trace_lock();
        trace_append_at(&layout.traces(), row, now_secs())?;
        Ok(true)
    })
    .await
}

#[tauri::command]
pub async fn decisions_traces_export(dest: String) -> Result<usize, String> {
    blocking(move || {
        let target = export_target(&dest)?;
        let layout = Layout::app();
        let lines = {
            let _t = trace_lock();
            read_traces(&layout.traces())
        };
        let mut text = lines.join("\n");
        if !text.is_empty() {
            text.push('\n');
        }
        write_atomic(&target, text.as_bytes())?;
        Ok(lines.len())
    })
    .await
}

/// Deletes the traces and every job folder holding a copy of them (snapshots,
/// labels). Trained checkpoints and their numbers stay.
#[tauri::command]
pub async fn decisions_traces_clear() -> Result<(), String> {
    blocking(|| {
        if running_job() == Some("training") {
            return Err("a training run is reading the traces: cancel it first".into());
        }
        let layout = Layout::app();
        let _t = trace_lock();
        forget_trace_meta(&layout.traces());
        match std::fs::remove_file(layout.traces()) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
        if layout.jobs().exists() {
            std::fs::remove_dir_all(layout.jobs()).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn decisions_train(app: AppHandle) -> Result<(), String> {
    let (toolkit, port, threshold) = blocking(|| {
        let layout = Layout::app();
        let toolkit = toolkit_dir().ok_or("learn.py is not shipped with this build")?;
        if !(venv_ready(&layout, Some(&toolkit)) && base_ready(&layout)) {
            return Err("install the learning toolkit first".into());
        }
        let n = {
            let _t = trace_lock();
            read_traces(&layout.traces()).len()
        };
        if n < MIN_TRACES_TO_TRAIN {
            return Err(format!(
                "{n} traces collected, at least {MIN_TRACES_TO_TRAIN} are needed for a held-out test to mean anything"
            ));
        }
        Ok((toolkit, teacher_port()?, user_threshold(&settings_load())))
    })
    .await?;
    let (cancel, guard) = begin_job("training")?;
    std::thread::spawn(move || {
        let _guard = guard;
        let emit = emitter(app);
        let layout = Layout::app();
        match train_blocking(&layout, &toolkit, port, threshold, &emit, &cancel) {
            Ok(result) => emit(json!({"phase": "done", "pct": 100, "result": result})),
            Err(e) if e == "cancelled" => emit(json!({"phase": "cancelled", "pct": 0, "message": "training cancelled", "job": "training"})),
            Err(e) => emit(json!({"phase": "error", "pct": 0, "message": e, "job": "training"})),
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn decisions_rollback() -> Result<Value, String> {
    blocking(|| {
        let layout = Layout::app();
        let _s = state_lock();
        let next = rolled_back(load_state(&layout))?;
        if let Some(id) = next.active.as_deref() {
            if !checkpoint_path(&layout, id)?.is_dir() {
                return Err(format!("checkpoint {id} is no longer on disk"));
            }
        }
        save_state(&layout, &next)?;
        stop_sidecar();
        // The checkpoint rolled back from is referenced by nothing now. Not
        // while a run is writing its own folder, which is referenced by nothing
        // YET.
        if running_job() != Some("training") {
            sweep_checkpoints(&layout, &next);
        }
        Ok(json!({"active": next.active, "previous": next.history.last()}))
    })
    .await
}

/// Everything learned from this user: traces, job folders (snapshots, labels),
/// every checkpoint (active, history, rejected), the sidecar log and the state,
/// which starts over as "heuristic only". The toolkit (venv) and the base
/// checkpoint stay: public code and public weights, not user data.
pub(crate) fn forget_all_at(layout: &Layout) -> Result<(), String> {
    forget_trace_meta(&layout.traces());
    for dir in [layout.jobs(), layout.checkpoints()] {
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("{}: {e}", dir.display())),
        }
    }
    for file in [layout.traces(), layout.sidecar_log(), layout.state()] {
        match std::fs::remove_file(&file) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("{}: {e}", file.display())),
        }
    }
    save_state(layout, &LearnState::default())
}

#[tauri::command]
pub async fn decisions_forget_all() -> Result<(), String> {
    blocking(|| {
        if running_job() == Some("training") {
            return Err("a training run is in progress: cancel it first".into());
        }
        // The service holds the active checkpoint open: it goes first, and is
        // waited for, so nothing is still reading what is deleted next.
        stop_sidecar_and_wait();
        let layout = Layout::app();
        let _t = trace_lock();
        let _s = state_lock();
        forget_all_at(&layout)
    })
    .await
}

/// Write the learning_active switch. Turning it off stops the service at once
/// rather than at the next message, so the 644 MB go when the user says so.
pub(crate) fn set_active(active: bool) -> Result<(), String> {
    let written = settings_update(|map| {
        map.insert("learning_active".into(), if active { "1" } else { "0" }.into());
    });
    invalidate_cache();
    written?;
    if !active {
        stop_sidecar();
    }
    Ok(())
}

#[tauri::command]
pub async fn decisions_set_active(active: bool) -> Result<(), String> {
    blocking(move || set_active(active)).await
}

/// On app exit: the job stops, and the service goes with the window.
pub(crate) fn shutdown() {
    cancel_job();
    stop_sidecar_and_wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_layout(tag: &str) -> Layout {
        static N: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "gx-learning-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Layout { root: dir }
    }

    /// Tests that write state.json or settings invalidate the shared switch
    /// cache; the cache test must not see them do it mid-assertion.
    fn switch_test_lock() -> std::sync::MutexGuard<'static, ()> {
        static L: Mutex<()> = Mutex::new(());
        L.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn row(ts: u64, i: usize) -> String {
        json!({"id": format!("t{i}"), "ts": ts}).to_string()
    }

    // ---- cap

    #[test]
    fn the_cap_keeps_the_newest_ten_thousand() {
        let now = 1_800_000_000;
        let lines: Vec<String> = (0..10_050).map(|i| row(now - 10, i)).collect();
        let kept = cap_rows(lines, now);
        assert_eq!(kept.len(), TRACE_CAP_ROWS);
        assert!(kept[0].contains("\"t50\""), "the oldest fifty go first");
        assert!(kept.last().unwrap().contains("\"t10049\""));
    }

    #[test]
    fn rows_older_than_ninety_days_go() {
        let now = 1_800_000_000;
        let lines = vec![
            row(now - TRACE_MAX_AGE_SECS - 1, 0),
            row(now - TRACE_MAX_AGE_SECS, 1),
            row(now, 2),
        ];
        let kept = cap_rows(lines, now);
        assert_eq!(kept.len(), 2);
        assert!(kept[0].contains("\"t1\""));
    }

    #[test]
    fn a_millisecond_timestamp_is_aged_like_seconds() {
        let now = 1_800_000_000;
        let fresh = json!({"id": "a", "ts": (now - 5) * 1000}).to_string();
        let stale = json!({"id": "b", "ts": (now - TRACE_MAX_AGE_SECS - 5) * 1000}).to_string();
        assert_eq!(cap_rows(vec![stale, fresh.clone()], now), vec![fresh]);
    }

    #[test]
    fn unreadable_or_undated_rows_are_dropped() {
        let now = 1_800_000_000;
        let kept = cap_rows(vec!["{not json".into(), json!({"id": "x"}).to_string(), row(now, 1)], now);
        assert_eq!(kept.len(), 1);
    }

    #[test]
    fn append_stamps_the_row_and_caps_the_file() {
        let layout = temp_layout("append");
        let path = layout.traces();
        let now = 1_800_000_000;
        let old: Vec<String> = (0..3).map(|i| row(now - TRACE_MAX_AGE_SECS - 100, i)).collect();
        std::fs::write(&path, format!("{}\n", old.join("\n"))).unwrap();
        trace_append_at(&path, json!({"id": "new"}), now).unwrap();
        let lines = read_lines(&path);
        assert_eq!(lines.len(), 1, "the expired rows were dropped on append");
        assert_eq!(row_ts(&lines[0]), Some(now));
        trace_append_at(&path, json!({"id": "next", "ts": now}), now).unwrap();
        assert_eq!(read_lines(&path).len(), 2);
        assert!(trace_append_at(&path, json!("text"), now).is_err());
        let huge = "x".repeat(TRACE_ROW_MAX_BYTES + 1);
        assert!(trace_append_at(&path, json!({"id": "big", "state": huge}), now).is_err());
        assert_eq!(read_lines(&path).len(), 2);
        let _ = std::fs::remove_dir_all(&layout.root);
    }

    #[test]
    fn heuristic_answers_come_from_the_rows() {
        let lines = vec![
            json!({"id": "a", "heuristic": {"task": "code", "confidence": 0.7}}).to_string(),
            json!({"id": "b", "heuristic": "writing"}).to_string(),
            json!({"id": "c", "heuristic": {"task": "nonsense"}}).to_string(),
            json!({"heuristic": {"task": "code"}}).to_string(),
        ];
        assert_eq!(heuristic_answers(&lines), json!({"a": "code", "b": "writing"}));
    }

    // ---- gate

    fn eval(s_acc: f64, ece: f64, n: u64, p_acc: f64, h_acc: f64) -> Value {
        json!({
            "student": {"acc": s_acc, "ece": ece, "n": n},
            "heuristic": {"acc": h_acc, "n": n},
            "policy": {"acc": p_acc, "ece_on_student_rows": ece, "n": n, "student_share": 0.8, "threshold": 0.6, "min_chars": 8},
        })
    }

    #[test]
    fn the_gate_accepts_only_when_all_three_hold() {
        let v = gate(&eval(0.80, 0.05, 80, 0.80, 0.70));
        assert!(v.accepted, "{:?}", v.reasons);
        assert_eq!(v.student["n"], json!(80));
        assert_eq!(v.policy["threshold"], json!(0.6));
    }

    #[test]
    fn exactly_three_points_is_enough() {
        let v = gate(&eval(0.60, 0.10, 60, 0.73, 0.70));
        assert!(v.accepted, "{:?}", v.reasons);
    }

    #[test]
    fn the_policy_not_the_raw_student_is_compared_to_the_heuristic() {
        // A student that beats the heuristic alone, but not at the user's
        // threshold, where the heuristic answers most rows: refused.
        let v = gate(&eval(0.95, 0.05, 100, 0.72, 0.70));
        assert!(!v.accepted);
        assert_eq!(v.reasons.len(), 1);
        assert!(v.reasons[0].contains("threshold"), "{:?}", v.reasons);
    }

    #[test]
    fn each_failed_condition_is_named() {
        let v = gate(&eval(0.9, 0.05, 59, 0.9, 0.5));
        assert!(!v.accepted);
        assert!(v.reasons[0].contains("59"));
        let v = gate(&eval(0.95, 0.11, 100, 0.95, 0.70));
        assert!(!v.accepted);
        assert_eq!(v.reasons.len(), 1);
        assert!(v.reasons[0].contains("calibration"));
    }

    #[test]
    fn missing_numbers_never_pass() {
        assert!(!gate(&json!({})).accepted);
        let mut no_policy = eval(0.99, 0.01, 500, 0.99, 0.1);
        no_policy.as_object_mut().unwrap().remove("policy");
        let v = gate(&no_policy);
        assert!(!v.accepted);
        assert!(v.reasons[0].contains("policy"));
        assert!(!gate(&json!({"student": {"acc": 0.99, "n": 500}, "heuristic": {"acc": 0.1}, "policy": {"acc": 0.99}})).accepted);
    }

    #[test]
    fn the_gate_reads_under_result_and_long_key_names() {
        let nested = json!({"event": "result", "result": {
            "student": {"accuracy": 0.9, "ece": 0.04, "n": 70},
            "heuristic": {"accuracy": 0.6, "n": 70},
            "policy": {"accuracy": 0.88}}});
        assert!(gate(&nested).accepted);
    }

    #[test]
    fn the_threshold_passed_to_evaluate_is_the_users() {
        let mut m = HashMap::new();
        assert_eq!(user_threshold(&m), 0.6);
        m.insert("learning_threshold".to_string(), "0.75".to_string());
        assert_eq!(user_threshold(&m), 0.75);
        m.insert("learning_threshold".to_string(), "7".to_string());
        assert_eq!(user_threshold(&m), 0.6);
    }

    // ---- splits

    #[test]
    fn a_test_split_under_sixty_is_refused_before_labelling() {
        let small = vec![json!({"event": "result", "phase": "splits", "traces": 200,
                                "splits": {"train": 130, "calib": 20, "test": 50}})];
        let err = check_splits(&small).unwrap_err();
        assert!(err.contains("50 traces de test") && err.contains("60"), "{err}");
        let ok = vec![json!({"event": "result", "splits": {"train": 180, "calib": 30, "test": 60}})];
        assert!(check_splits(&ok).is_ok());
        assert!(check_splits(&[json!({"event": "progress", "pct": 10})]).is_err());
        assert_eq!(MIN_TRACES_TO_TRAIN as u64, GATE_MIN_N * 4);
    }

    // ---- retention

    #[test]
    fn only_two_rejected_and_two_history_folders_are_kept() {
        let mut s = LearnState::default();
        for id in ["1", "2", "3", "4"] {
            s = trim_history(apply_result(s, id, &json!({"accepted": true, "checkpoint": id})));
        }
        assert_eq!(s.active.as_deref(), Some("4"));
        assert_eq!(s.history, vec!["2".to_string(), "3".to_string()]);
        for id in ["5", "6", "7"] {
            s = trim_history(apply_result(s, id, &json!({"accepted": false, "checkpoint": id})));
        }
        let existing: Vec<String> = (1..=7).map(|i| i.to_string()).collect();
        let doomed = doomed_checkpoints(&s, &existing);
        assert_eq!(doomed, vec!["1".to_string(), "5".to_string()]);
        assert!(!doomed.contains(&"4".to_string()), "never the active one");
        assert_eq!(s.rejected.len(), 3, "the numbers of rejected runs stay");
    }

    #[test]
    fn the_sweep_deletes_only_the_doomed_folders() {
        let _l = switch_test_lock();
        let layout = temp_layout("sweep");
        for id in ["1", "2", "3"] {
            std::fs::create_dir_all(layout.checkpoints().join(id)).unwrap();
        }
        let s = LearnState { active: Some("3".into()), history: vec!["2".into()], ..Default::default() };
        sweep_checkpoints(&layout, &s);
        assert!(!layout.checkpoints().join("1").exists());
        assert!(layout.checkpoints().join("2").is_dir() && layout.checkpoints().join("3").is_dir());
        let _ = std::fs::remove_dir_all(&layout.root);
    }

    #[test]
    fn a_finished_job_keeps_only_its_numbers() {
        let layout = temp_layout("scrub");
        let job = layout.jobs().join("1");
        std::fs::create_dir_all(job.join("tmp")).unwrap();
        for f in ["traces.jsonl", "labels.jsonl", "heuristic.json", "train.log", "eval.json", "result.json"] {
            std::fs::write(job.join(f), "x").unwrap();
        }
        scrub_job(&job);
        let mut left: Vec<String> = std::fs::read_dir(&job)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        left.sort();
        assert_eq!(left, vec!["eval.json".to_string(), "result.json".to_string()]);
        let _ = std::fs::remove_dir_all(&layout.root);
    }

    // ---- state

    #[test]
    fn an_accepted_run_becomes_active_and_the_old_one_is_kept_for_rollback() {
        let s = LearnState { active: Some("100".into()), ..Default::default() };
        let s = apply_result(s, "200", &json!({"accepted": true}));
        assert_eq!(s.active.as_deref(), Some("200"));
        assert_eq!(s.history, vec!["100".to_string()]);
        let s = rolled_back(s).unwrap();
        assert_eq!(s.active.as_deref(), Some("100"));
        let s = rolled_back(s).unwrap();
        assert_eq!(s.active, None, "the step before the first student is the heuristic");
        assert!(rolled_back(s).is_err());
    }

    #[test]
    fn a_rejected_run_changes_nothing_but_the_record() {
        let s = LearnState { active: Some("100".into()), ..Default::default() };
        let r = json!({"accepted": false, "checkpoint": "200"});
        let s = apply_result(s, "200", &r);
        assert_eq!(s.active.as_deref(), Some("100"));
        assert!(s.history.is_empty());
        assert_eq!(s.rejected, vec![r.clone()]);
        assert_eq!(s.last, Some(r));
        let mut s = s;
        for i in 0..30 {
            s = apply_result(s, "x", &json!({"accepted": false, "i": i}));
        }
        assert_eq!(s.rejected.len(), REJECTED_KEPT);
        assert_eq!(s.rejected.last().unwrap()["i"], json!(29));
    }

    #[test]
    fn the_state_round_trips_through_its_file() {
        let _l = switch_test_lock();
        let layout = temp_layout("state");
        assert_eq!(load_state(&layout), LearnState::default());
        let s = LearnState { active: Some("1".into()), history: vec!["0".into()], ..Default::default() };
        save_state(&layout, &s).unwrap();
        assert_eq!(load_state(&layout), s);
        let _ = std::fs::remove_dir_all(&layout.root);
    }

    #[test]
    fn forgetting_removes_user_data_and_keeps_the_toolkit() {
        let _l = switch_test_lock();
        let layout = temp_layout("forget");
        std::fs::create_dir_all(layout.venv().join("bin")).unwrap();
        std::fs::write(layout.venv_marker(), "x").unwrap();
        std::fs::create_dir_all(layout.base()).unwrap();
        std::fs::write(layout.base_marker(), BASE_REVISION).unwrap();
        for id in ["1", "2", "3"] {
            std::fs::create_dir_all(layout.checkpoints().join(id)).unwrap();
        }
        std::fs::create_dir_all(layout.jobs().join("3")).unwrap();
        std::fs::write(layout.jobs().join("3/labels.jsonl"), "{}").unwrap();
        std::fs::write(layout.traces(), "{}\n").unwrap();
        std::fs::write(layout.sidecar_log(), "log").unwrap();
        let s = LearnState {
            active: Some("2".into()),
            history: vec!["1".into()],
            last: Some(json!({"accepted": false})),
            rejected: vec![json!({"checkpoint": "3"})],
        };
        save_state(&layout, &s).unwrap();
        forget_all_at(&layout).unwrap();
        assert!(!layout.checkpoints().exists());
        assert!(!layout.jobs().exists());
        assert!(!layout.traces().exists());
        assert!(!layout.sidecar_log().exists());
        assert_eq!(load_state(&layout), LearnState::default());
        assert!(layout.venv_marker().is_file() && base_ready(&layout), "toolkit and base stay");
        forget_all_at(&layout).unwrap();
        let _ = std::fs::remove_dir_all(&layout.root);
    }

    // ---- switches

    #[test]
    fn the_switches_are_cached_until_a_writer_invalidates_them() {
        let _l = switch_test_lock();
        let _s = crate::settings::settings_read_tests::settings_lock();
        let dir = temp_layout("switch-settings").root;
        *crate::settings::settings_root_override().lock().unwrap() = Some(dir.clone());
        let layout = temp_layout("switch");
        set_active(true).unwrap();
        save_state(&layout, &LearnState { active: Some("7".into()), ..Default::default() }).unwrap();
        assert_eq!(switches(&layout), Switches { on: true, active: Some("7".into()) });
        // Written behind its back: the cache answers, nothing is re-read.
        std::fs::write(dir.join("settings.json"), r#"{"learning_active":"0"}"#).unwrap();
        std::fs::write(layout.state(), r#"{"active":"8"}"#).unwrap();
        assert_eq!(switches(&layout), Switches { on: true, active: Some("7".into()) });
        // Through the writers: seen at once.
        set_active(false).unwrap();
        assert_eq!(switches(&layout), Switches { on: false, active: Some("8".into()) });
        set_active(true).unwrap();
        save_state(&layout, &LearnState::default()).unwrap();
        assert_eq!(switches(&layout), Switches { on: true, active: None });
        crate::settings::settings_set("learning_active".into(), "0".into()).unwrap();
        assert!(!switches(&layout).on, "settings_set on a learning_ key invalidates too");
        *crate::settings::settings_root_override().lock().unwrap() = None;
        invalidate_cache();
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&layout.root);
    }

    #[test]
    fn switching_off_stops_the_service() {
        let _l = switch_test_lock();
        let _s = crate::settings::settings_read_tests::settings_lock();
        let dir = temp_layout("off-settings").root;
        *crate::settings::settings_root_override().lock().unwrap() = Some(dir.clone());
        let child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        *sidecar_lock() = Some(Sidecar {
            child,
            port: 1,
            checkpoint: PathBuf::from("/nonexistent"),
            ready: Arc::new(AtomicBool::new(true)),
            generation: 0,
        });
        set_active(false).unwrap();
        assert!(sidecar_lock().is_none());
        let text = std::fs::read_to_string(dir.join("settings.json")).unwrap();
        assert!(text.contains("\"learning_active\"") && text.contains("\"0\""), "{text}");
        *crate::settings::settings_root_override().lock().unwrap() = None;
        invalidate_cache();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_service_table_is_not_locked_while_the_process_dies() {
        let _l = switch_test_lock();
        // The table must be free as soon as the entry is taken, whatever the
        // stop then waits for.
        let child = Command::new("/bin/sh")
            .args(["-c", "trap '' TERM; sleep 0.6"])
            .spawn()
            .unwrap();
        *sidecar_lock() = Some(Sidecar {
            child,
            port: 1,
            checkpoint: PathBuf::new(),
            ready: Arc::new(AtomicBool::new(false)),
            generation: 0,
        });
        let stopper = std::thread::spawn(stop_sidecar_and_wait);
        std::thread::sleep(Duration::from_millis(50));
        // The table is free while the stop is under way.
        let t = Instant::now();
        let free = SIDECAR.try_lock().is_ok() || {
            std::thread::sleep(Duration::from_millis(20));
            SIDECAR.try_lock().is_ok()
        };
        assert!(free && t.elapsed() < Duration::from_millis(200));
        stopper.join().unwrap();
        assert!(sidecar_lock().is_none());
    }

    #[test]
    fn a_rewritten_turn_counts_once_and_its_last_version_wins() {
        let now = 1_800_000_000;
        let lines = vec![
            json!({"id": "a", "ts": now, "outcome": null}).to_string(),
            json!({"id": "b", "ts": now}).to_string(),
            json!({"id": "a", "ts": now, "outcome": "undone"}).to_string(),
        ];
        let kept = cap_rows(lines, now);
        assert_eq!(kept.len(), 2);
        assert!(kept[0].contains("\"b\""));
        assert!(kept[1].contains("undone"));
        let layout = temp_layout("dedupe");
        let path = layout.traces();
        for outcome in ["none", "accepted", "undone"] {
            trace_append_at(&path, json!({"id": "t1", "ts": now, "outcome": outcome}), now).unwrap();
        }
        let rows = read_traces(&path);
        assert_eq!(rows.len(), 1, "counted by distinct id");
        assert!(rows[0].contains("undone"));
        forget_trace_meta(&path);
        let _ = std::fs::remove_dir_all(&layout.root);
    }

    #[test]
    fn appends_do_not_reread_the_file_until_a_day_has_passed() {
        let layout = temp_layout("meta");
        let path = layout.traces();
        let now = 1_800_000_000;
        trace_append_at(&path, json!({"id": "a"}), now).unwrap();
        // A stale row slipped in behind the counter's back.
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(f, "{}", row(now - TRACE_MAX_AGE_SECS - 10, 9)).unwrap();
        trace_append_at(&path, json!({"id": "b"}), now + 60).unwrap();
        assert_eq!(read_lines(&path).len(), 3, "a plain append: the file was not re-read");
        trace_append_at(&path, json!({"id": "c"}), now + 86_400).unwrap();
        let lines = read_lines(&path);
        assert_eq!(lines.len(), 3, "the daily pass aged the stale row out");
        assert!(!lines.iter().any(|l| l.contains("\"t9\"")));
        forget_trace_meta(&path);
        let _ = std::fs::remove_dir_all(&layout.root);
    }

    #[test]
    fn appends_past_the_cap_trigger_a_full_pass() {
        let layout = temp_layout("meta-cap");
        let path = layout.traces();
        let now = 1_800_000_000;
        let lines: Vec<String> = (0..TRACE_CAP_ROWS).map(|i| row(now, i)).collect();
        std::fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
        trace_append_at(&path, json!({"id": "x"}), now).unwrap();
        assert_eq!(read_lines(&path).len(), TRACE_CAP_ROWS);
        for i in 0..3 {
            trace_append_at(&path, json!({"id": format!("y{i}")}), now).unwrap();
        }
        let lines = read_lines(&path);
        assert_eq!(lines.len(), TRACE_CAP_ROWS, "every append at the cap drops the oldest");
        assert!(lines.last().unwrap().contains("y2"));
        forget_trace_meta(&path);
        let _ = std::fs::remove_dir_all(&layout.root);
    }

    // ---- confinement

    #[test]
    fn checkpoint_ids_cannot_leave_the_folder() {
        let layout = temp_layout("confine");
        for bad in ["", "..", "../x", "a/b", ".hidden", "/etc", "a\\b", "x y"] {
            assert!(checkpoint_path(&layout, bad).is_err(), "{bad:?} must be refused");
        }
        assert_eq!(checkpoint_path(&layout, "1790000000-2").unwrap(), layout.checkpoints().join("1790000000-2"));
        let _ = std::fs::remove_dir_all(&layout.root);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_checkpoint_pointing_outside_is_refused() {
        let layout = temp_layout("symlink");
        let outside = layout.root.join("elsewhere");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::create_dir_all(layout.checkpoints()).unwrap();
        std::os::unix::fs::symlink(&outside, layout.checkpoints().join("evil")).unwrap();
        assert!(checkpoint_path(&layout, "evil").is_err());
        std::fs::create_dir_all(layout.checkpoints().join("good")).unwrap();
        assert!(checkpoint_path(&layout, "good").is_ok());
        let _ = std::fs::remove_dir_all(&layout.root);
    }

    #[test]
    fn exports_go_to_an_absolute_file_in_an_existing_folder() {
        let layout = temp_layout("export");
        let dest = layout.root.join("out.jsonl");
        assert_eq!(export_target(dest.to_str().unwrap()).unwrap(), dest);
        assert!(export_target("relative.jsonl").is_err());
        assert!(export_target(layout.root.to_str().unwrap()).is_err());
        assert!(export_target(layout.root.join("missing/out.jsonl").to_str().unwrap()).is_err());
        assert!(export_target(layout.root.join("../out.jsonl").to_str().unwrap()).is_err());
        let _ = std::fs::remove_dir_all(&layout.root);
    }

    // ---- wire

    #[test]
    fn the_student_answer_is_validated() {
        let ok = json!({"answers": {"task": {"choice": "code", "confidence": 0.91}}});
        assert_eq!(parse_answer(&ok).unwrap(), ("code".to_string(), 0.91));
        assert!(parse_answer(&json!({"answers": {"task": {"choice": "poetry", "confidence": 0.9}}})).is_err());
        assert!(parse_answer(&json!({"answers": {"task": {"choice": "code", "confidence": 1.5}}})).is_err());
        assert!(parse_answer(&json!({})).is_err());
    }

    #[test]
    fn the_decide_state_carries_the_previous_task() {
        assert_eq!(
            decide_state(json!("Écris un script"), Some("code".into())),
            json!({"message": "Écris un script", "previous_task": "code"})
        );
        assert_eq!(
            decide_state(json!({"message": "x"}), Some("../etc".into())),
            json!({"message": "x", "previous_task": null})
        );
    }

    #[test]
    fn responses_parse_plain_and_chunked() {
        let plain = b"HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\n{}";
        assert_eq!(parse_response(plain).unwrap(), (200, b"{}".to_vec()));
        let chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\n{\"a\r\n4\r\n\":1}\r\n0\r\n\r\n";
        assert_eq!(parse_response(chunked).unwrap(), (200, b"{\"a\":1}".to_vec()));
        assert!(parse_response(b"garbage").is_err());
    }

    #[test]
    fn a_loopback_exchange_respects_its_budget() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf);
            let body = r#"{"answers":{"task":{"choice":"writing","confidence":0.8}}}"#;
            let _ = write!(s, "HTTP/1.0 200 OK\r\nContent-Length: {}\r\n\r\n{body}", body.len());
            // A second connection that never answers.
            let (_hang, _) = listener.accept().unwrap();
            std::thread::sleep(Duration::from_millis(500));
        });
        let (status, body) = http_request(port, "POST", "/decide", Some(b"{}"), Duration::from_millis(500)).unwrap();
        assert_eq!(status, 200);
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parse_answer(&v).unwrap().0, "writing");
        let t = Instant::now();
        assert!(http_request(port, "GET", "/health", None, Duration::from_millis(50)).is_err());
        assert!(t.elapsed() < Duration::from_millis(250), "the budget bounds a silent service");
    }

    #[test]
    fn the_sidecar_range_does_not_overlap_the_engines() {
        assert!(SIDECAR_PORT_BASE >= SERVER_PORT_BASE + SERVER_PORT_SPAN);
    }

    #[test]
    fn the_download_size_is_read_from_the_requirements() {
        let req = "# pinned\n# download-bytes: 123_456_789\ntorch==2.5.1 \\\n  --hash=sha256:abc\n";
        assert_eq!(declared_download_bytes(req), Some(123_456_789));
        assert_eq!(declared_download_bytes("torch==1\n"), None);
        assert_eq!(base_bytes(), 678_201_636);
    }

    #[test]
    fn the_toolkit_fingerprint_is_stable() {
        assert_eq!(fingerprint(b""), "cbf29ce484222325");
        assert_ne!(fingerprint(b"torch==2.5.1"), fingerprint(b"torch==2.5.2"));
    }

    #[test]
    fn a_step_reports_progress_and_fails_with_its_log() {
        let layout = temp_layout("step");
        let log = layout.root.join("step.log");
        let seen = Mutex::new(Vec::new());
        let emit = |v: Value| seen.lock().unwrap().push(v);
        let cancel = AtomicBool::new(false);
        let mut ok = Command::new("/bin/sh");
        ok.args(["-c", r#"echo '{"phase":"train","pct":50,"message":"half"}'; echo plain; echo '{"student":{"acc":1}}'"#]);
        let objs = run_step(ok, &emit, &cancel, "train", (40.0, 80.0), &log, "sh").unwrap();
        assert_eq!(objs.len(), 2);
        assert_eq!(seen.lock().unwrap()[0]["pct"], json!(60.0));
        let mut bad = Command::new("/bin/sh");
        bad.args(["-c", "echo boom >&2; exit 3"]);
        let err = run_step(bad, &emit, &cancel, "label", (0.0, 40.0), &log, "sh").unwrap_err();
        assert!(err.contains("boom"), "{err}");
        let mut said = Command::new("/bin/sh");
        said.args(["-c", r#"echo '{"event":"error","code":5,"message":"teacher down"}'; exit 5"#]);
        let err = run_step(said, &emit, &cancel, "label", (0.0, 40.0), &log, "sh").unwrap_err();
        assert!(err.contains("could not reach the local model") && err.contains("teacher down"), "{err}");
        let _ = std::fs::remove_dir_all(&layout.root);
    }

    #[test]
    fn a_cancelled_step_is_killed() {
        let layout = temp_layout("cancel");
        let log = layout.root.join("step.log");
        let emit = |_v: Value| {};
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            flag.store(true, Ordering::SeqCst);
        });
        let mut slow = Command::new("/bin/sh");
        slow.args(["-c", "sleep 30"]);
        let t = Instant::now();
        assert_eq!(run_step(slow, &emit, &cancel, "train", (0.0, 1.0), &log, "sh").unwrap_err(), "cancelled");
        assert!(t.elapsed() < Duration::from_secs(5));
        let _ = std::fs::remove_dir_all(&layout.root);
    }
}
