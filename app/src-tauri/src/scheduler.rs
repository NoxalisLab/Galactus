// Galactus, the scheduler: what a job IS, what survives, and who decides it is
// due.
//
// cron.rs owns the calendar. This module owns everything around it: the job
// definitions, the runtime state, the thread that waits on the clock, the
// catch-up rule and the two ways a job's output can leave the machine.
//
// THE SPLIT ON DISK, AND WHY IT IS TWO FILES
//
//   schedule/jobs.json         what a human declared
//   schedule/jobs-state.json   what has happened since
//
// One file would be simpler and worse. The definitions are edited by a person
// and are worth reading, diffing and restoring by hand; the state is written
// by the app several times a day and is worth nothing to a human. Keeping them
// apart means a state file lost to a bad write costs a "last fired" reading,
// not the jobs themselves, and a user who wants to move their jobs to another
// Mac copies one file and does not carry a stale clock with them.
//
// A CORRUPT FILE IS REFUSED, NOT REPAIRED
//
// The same rule runrecord.ts applies to a run. A jobs.json that does not parse
// is not "an empty set of jobs": it is a file whose contents nobody can vouch
// for, and starting from empty would quietly delete a user's schedule the next
// time anything is saved. So the scheduler enters a refused state: nothing
// fires, every write is rejected, and the error is returned to the UI with the
// path in it. The file is left exactly as it is, for a human to look at.
//
// THE CATCH-UP RULE, DECIDED ON PURPOSE
//
// A job whose time passed while the app was closed has three possible answers
// and only one of them is safe:
//
//   fire every missed occurrence   a per-minute job and a night asleep is 400
//                                  runs, 400 model loads and one very surprised
//                                  user. Refused outright.
//   skip everything                a daily 03:00 digest never runs on a laptop
//                                  that sleeps at night, which is most laptops.
//   fire ONCE, late, if it is still worth doing
//
// The third is what this does. On every pass, for every enabled job, the
// scheduler asks how many fires fell due since the last one it honoured. If
// the answer is more than zero it fires exactly ONE, for the most recent of
// them, and records the rest as missed. If even the most recent is older than
// CATCHUP_GRACE_SECS it fires nothing at all and records the whole batch as
// missed: a 03:00 report delivered at 16:00 is not late, it is wrong.
//
// The rule is the same on the first pass after launch and on every pass after
// that, which is what makes a Mac waking from a week of sleep behave exactly
// like a Mac that was merely closed for an hour. There is no separate startup
// path to get wrong.
//
// THE IDLE COST IS ZERO, AND THAT IS A DESIGN CONSTRAINT
//
// This process stays open all day. The clock thread therefore does not poll:
// it computes the earliest instant anything can come due and parks on a
// condition variable until then, waking early only when a command moves a
// deadline. With no enabled job it does not wake at all; with one job or with
// ten it wakes twice an hour, from the sleep cap alone, and finds a cached
// horizon it does not recompute. Nothing is written to disk by a pass that
// concluded nothing was due. The numbers are asserted in the tests, not
// claimed here.
//
// NOTHING LEAVES THE MACHINE BY DEFAULT
//
// Delivery is `none` unless a human chose otherwise, per job. Webhook and file
// are both validated before they are stored, and a delivery that fails is
// recorded on the job rather than swallowed.

use std::collections::HashMap;
use std::io::Write as IoWrite;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::cron::{self, Local, Schedule, Zone};

/// The event the frontend listens for. It carries the whole job, because the
/// frontend has to build a Run from it and a second round trip to fetch the
/// definition would be one more thing that can fail between "due" and "ran".
pub const JOB_DUE_EVENT: &str = "galactus://job-due";

/// The longest the clock thread will sleep even when the next fire is further
/// away than that.
///
/// THE IDLE COST IS THE POINT. This process stays open all day, so the
/// scheduler must not poll: it sleeps until the earliest instant anything can
/// come due, and a command that changes a schedule wakes it immediately
/// through a condition variable rather than being noticed at the next wake.
/// With no enabled job it does not wake AT ALL.
///
/// The cap exists for the one thing a computed deadline cannot survive: a wall
/// clock that moves under it. An NTP correction, a timezone change on a
/// laptop that travelled, a user setting the date by hand. Thirty minutes
/// bounds how wrong the sleep can be, and costs two wakeups an hour, each of
/// which is a lock and one integer comparison: the horizon is CACHED against a
/// generation counter, so a wake that finds nothing changed recomputes
/// nothing.
const MAX_SLEEP: Duration = Duration::from_secs(30 * 60);

/// How late a missed fire may be and still be worth doing. Six hours covers a
/// night asleep and a morning of meetings; past that, the next scheduled fire
/// is closer than the answer is fresh.
pub const CATCHUP_GRACE_SECS: i64 = 6 * 3600;

/// Counting stops being exact past this. The count is a number on a screen;
/// the DECISION never depends on it, only on the instant of the last fire,
/// which stays exact however many were missed.
const MISS_CAP: u32 = 1000;

/// How far behind its slot a fire has to be before it is called late. The
/// clock wakes ON the deadline, so an on-time fire is within a second or two
/// of it; a minute of slack means only a real delay says so to the model.
const LATE_SECS: i64 = 60;

/// A job that said nothing for this long after being dispatched is assumed to
/// have died with its window. Without it, one destroyed webview would park a
/// job as "running" forever and it would never fire again.
const FLIGHT_SLACK_SECS: i64 = 5 * 60;

const JOBS_FILE: &str = "jobs.json";
const STATE_FILE: &str = "jobs-state.json";
const FORMAT_VERSION: u32 = 1;

pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------- the job

/// Where a job's output goes when it finishes. `None` is the default and the
/// only one that needs no configuration, which is deliberate: an automation
/// that posts somewhere by accident is worse than one that posts nowhere.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum Delivery {
    None,
    Webhook { url: String },
    File { path: String },
}

impl Default for Delivery {
    fn default() -> Self {
        Delivery::None
    }
}

/// A job is a run template plus a schedule, and nothing else. Every field
/// below except the schedule and the delivery has a counterpart in RunLimits:
/// declaring a job is declaring the run it will produce, once, in advance.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Job {
    pub id: String,
    pub name: String,
    /// The task, exactly as a human wrote it. Turn 1 is driven from this.
    pub task: String,
    /// The schedule as TYPED, not as parsed. Storing the parse would make the
    /// file unreadable and would lose what the user meant when the parser
    /// changes.
    pub schedule: String,
    pub enabled: bool,
    pub policy: String,
    pub max_turns: u32,
    pub max_minutes: u32,
    pub preauthorize_every_time: bool,
    #[serde(default)]
    pub delivery: Delivery,
    pub created_at: i64,
    pub updated_at: i64,
    /// When the job was last switched on. An interval schedule counts from
    /// here until it has fired once; without it, enabling a "every 2h" job
    /// would fire it immediately because its anchor would be the epoch.
    pub enabled_at: i64,
}

/// What has happened to a job. Written far more often than the definitions,
/// and worth nothing to a human, which is why it lives in its own file.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct JobState {
    /// The instant the last honoured fire was DUE for, not the instant the run
    /// started. Using the scheduled instant is what keeps a late catch-up from
    /// shifting every subsequent fire.
    pub last_fired_at: Option<i64>,
    pub last_finished_at: Option<i64>,
    /// A RunState name, or "interrupted", or "".
    pub last_outcome: String,
    pub last_detail: String,
    pub last_run_id: String,
    pub consecutive_failures: u32,
    /// Cumulative, across the life of the job.
    pub missed: u32,
    pub last_missed_at: Option<i64>,
    /// "" while nothing has been sent, "ok", or the reason it failed.
    pub last_delivery: String,
}

#[derive(Serialize, Deserialize)]
struct JobsFile {
    version: u32,
    jobs: Vec<Job>,
}

#[derive(Serialize, Deserialize)]
struct StateFile {
    version: u32,
    states: HashMap<String, JobState>,
}

// ---------------------------------------------------------------- the decision

/// What a pass concluded about one job.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Nothing fell due.
    Idle,
    /// Fire once, for `scheduled`. `dropped` is how many other fires are being
    /// deliberately not run.
    Fire {
        scheduled: i64,
        dropped: u32,
        saturated: bool,
        catchup: bool,
    },
    /// Fires fell due, all of them too stale to be worth doing.
    Drop {
        missed: u32,
        saturated: bool,
        last: i64,
    },
}

/// The catch-up rule, as one pure function so it can be argued with in a test
/// rather than in production at 3am.
pub fn decide(
    schedule: &Schedule,
    state: &JobState,
    enabled_at: i64,
    now: i64,
    zone: &dyn Zone,
) -> Decision {
    let anchor = state.last_fired_at.unwrap_or(enabled_at);
    let missed = cron::missed_since(schedule, anchor, now, zone, MISS_CAP);
    let Some(last) = missed.last else {
        return Decision::Idle;
    };
    if now - last > CATCHUP_GRACE_SECS {
        return Decision::Drop {
            missed: missed.count,
            saturated: missed.saturated,
            last,
        };
    }
    Decision::Fire {
        scheduled: last,
        dropped: missed.count.saturating_sub(1),
        saturated: missed.saturated,
        // Late by more than a minute, or standing in for others: either way the
        // UI and the model should know this is not the appointed minute.
        catchup: missed.count > 1 || now - last > LATE_SECS,
    }
}

// ---------------------------------------------------------------- persistence

fn schedule_dir() -> PathBuf {
    crate::app_support().join("schedule")
}

/// Write-then-rename, the same way conv_save does it. A plain overwrite has a
/// truncate window, and a scheduler killed inside it comes back with a jobs
/// file that parses into half a schedule, which the refusal rule above would
/// then correctly but uselessly reject.
fn write_atomic(path: &Path, payload: &str) -> Result<(), String> {
    let dir = path.parent().ok_or("no parent directory")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("f");
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    std::fs::write(&tmp, payload.as_bytes()).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

/// Read the definitions. A MISSING file is an empty schedule, which is the
/// honest reading of "this user has never made a job". A file that exists and
/// does not parse is an error, and the caller must not treat the two alike.
pub fn read_jobs(dir: &Path) -> Result<Vec<Job>, String> {
    let path = dir.join(JOBS_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("{} cannot be read: {e}", path.display())),
    };
    let parsed: JobsFile = serde_json::from_str(&text)
        .map_err(|e| format!("{} is not a readable job file ({e}). It has been left alone; fix it or move it aside.", path.display()))?;
    if parsed.version != FORMAT_VERSION {
        return Err(format!(
            "{} is version {}, this build reads version {FORMAT_VERSION}",
            path.display(),
            parsed.version
        ));
    }
    Ok(parsed.jobs)
}

pub fn write_jobs(dir: &Path, jobs: &[Job]) -> Result<(), String> {
    let payload = serde_json::to_string_pretty(&JobsFile {
        version: FORMAT_VERSION,
        jobs: jobs.to_vec(),
    })
    .map_err(|e| e.to_string())?;
    write_atomic(&dir.join(JOBS_FILE), &payload)
}

pub fn read_states(dir: &Path) -> Result<HashMap<String, JobState>, String> {
    let path = dir.join(STATE_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(e) => return Err(format!("{} cannot be read: {e}", path.display())),
    };
    let parsed: StateFile = serde_json::from_str(&text)
        .map_err(|e| format!("{} is not a readable state file ({e}). It has been left alone; fix it or move it aside.", path.display()))?;
    if parsed.version != FORMAT_VERSION {
        return Err(format!(
            "{} is version {}, this build reads version {FORMAT_VERSION}",
            path.display(),
            parsed.version
        ));
    }
    Ok(parsed.states)
}

pub fn write_states(dir: &Path, states: &HashMap<String, JobState>) -> Result<(), String> {
    let payload = serde_json::to_string_pretty(&StateFile {
        version: FORMAT_VERSION,
        states: states.clone(),
    })
    .map_err(|e| e.to_string())?;
    write_atomic(&dir.join(STATE_FILE), &payload)
}

// ---------------------------------------------------------------- validation

pub const POLICIES: [&str; 3] = ["read_only", "propose", "autonomous"];
pub const MAX_TURNS: u32 = 200;
pub const MAX_MINUTES: u32 = 24 * 60;

/// A delivery target, checked before it is ever stored.
///
/// Checked here rather than at send time so a typo is a red field in the form
/// instead of a silent nightly failure nobody reads. The two rules are the
/// same ones the rest of the app applies: http(s) only, as tool_web_fetch
/// does, and an absolute path with no traversal, as the file tools do.
pub fn check_delivery(delivery: &Delivery) -> Result<(), String> {
    match delivery {
        Delivery::None => Ok(()),
        Delivery::Webhook { url } => {
            let url = url.trim();
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                return Err("a webhook URL must start with http:// or https://".into());
            }
            if url.len() < 12 || url.contains(char::is_whitespace) {
                return Err("that does not look like a URL".into());
            }
            Ok(())
        }
        Delivery::File { path } => {
            let path = path.trim();
            if !path.starts_with('/') {
                return Err("a delivery file needs an absolute path".into());
            }
            if path.contains("..") {
                return Err("a delivery path may not contain ..".into());
            }
            let parent = Path::new(path).parent().ok_or("that path has no folder")?;
            if !parent.is_dir() {
                return Err(format!("{} does not exist", parent.display()));
            }
            Ok(())
        }
    }
}

/// What the frontend sends. Deliberately NOT `Job`: the client has no business
/// setting the timestamps, and accepting them would let a form field decide
/// when an interval schedule thinks it was switched on.
#[derive(Deserialize)]
pub struct JobInput {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub task: String,
    pub schedule: String,
    pub enabled: bool,
    pub policy: String,
    pub max_turns: u32,
    pub max_minutes: u32,
    #[serde(default)]
    pub preauthorize_every_time: bool,
    #[serde(default)]
    pub delivery: Delivery,
}

fn clamp(v: u32, min: u32, max: u32) -> u32 {
    v.max(min).min(max)
}

/// Turn what the form sent into what is stored, or say why not.
pub fn validate(input: JobInput, existing: Option<&Job>, now: i64) -> Result<Job, String> {
    let task = input.task.trim().to_string();
    if task.is_empty() {
        return Err("a job needs a task".into());
    }
    cron::parse_schedule(&input.schedule)?;
    if !POLICIES.contains(&input.policy.as_str()) {
        return Err(format!("unknown policy \"{}\"", input.policy));
    }
    check_delivery(&input.delivery)?;
    let name = {
        let n = input.name.trim();
        if n.is_empty() {
            task.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(48).collect()
        } else {
            n.chars().take(80).collect()
        }
    };
    // Only ever true for the policy that grants git in the first place. The
    // runs view applies the same rule at declaration time; applying it again
    // here is what stops a hand-edited jobs.json from carrying a claim the
    // run's own gate will never honour.
    let preauth = input.policy == "autonomous" && input.preauthorize_every_time;
    let id = if input.id.trim().is_empty() {
        new_id(now)
    } else {
        sanitize_id(input.id.trim())
    };
    if id.is_empty() {
        return Err("that job id is not usable".into());
    }
    let created_at = existing.map(|j| j.created_at).unwrap_or(now);
    // The anchor moves only when the job goes from off to on. Re-saving an
    // enabled job must not restart its interval, or editing the name of an
    // hourly job would push its next fire an hour out.
    let enabled_at = match existing {
        Some(prev) if prev.enabled && input.enabled => prev.enabled_at,
        _ if input.enabled => now,
        _ => existing.map(|j| j.enabled_at).unwrap_or(now),
    };
    Ok(Job {
        id,
        name,
        task,
        schedule: input.schedule.trim().to_string(),
        enabled: input.enabled,
        policy: input.policy,
        max_turns: clamp(input.max_turns, 1, MAX_TURNS),
        max_minutes: clamp(input.max_minutes, 1, MAX_MINUTES),
        preauthorize_every_time: preauth,
        delivery: input.delivery,
        created_at,
        updated_at: now,
        enabled_at,
    })
}

pub fn sanitize_id(id: &str) -> String {
    id.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect()
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Same construction as store.ts's newId: a timestamp for order plus a
/// counter, so two jobs created in the same second cannot collide.
fn new_id(now: i64) -> String {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    format!("job-{:x}-{:x}{:x}", now.max(0), nanos, n)
}

// ---------------------------------------------------------------- delivery

/// The body a webhook receives. A fixed, documented shape: whatever is on the
/// other end has to parse it, and "whatever the run happened to produce" is
/// not a contract.
pub fn webhook_body(job: &Job, run_id: &str, outcome: &str, detail: &str, at: i64) -> String {
    json!({
        "source": "galactus",
        "job": { "id": job.id, "name": job.name, "schedule": job.schedule },
        "run": run_id,
        "outcome": outcome,
        "at": at,
        "output": detail,
    })
    .to_string()
}

/// The block appended to a delivery file. Plain text with a dated header, so
/// `tail -f` on it reads like a log rather than like a JSON stream.
pub fn file_block(job: &Job, run_id: &str, outcome: &str, detail: &str, at: i64) -> String {
    let c = cron::civil_at(&Local, at);
    format!(
        "\n=== {:04}-{:02}-{:02} {:02}:{:02} · {} · {} · {}\n{}\n",
        c.year,
        c.month,
        c.day,
        c.hour,
        c.minute,
        job.name,
        outcome,
        run_id,
        detail.trim_end()
    )
}

/// Send, or say why not. Never called for `Delivery::None`, and never called
/// on the clock thread: a webhook that hangs must not hold the schedule.
fn deliver(job: &Job, run_id: &str, outcome: &str, detail: &str, at: i64) -> Result<(), String> {
    match &job.delivery {
        Delivery::None => Ok(()),
        Delivery::File { path } => {
            let block = file_block(job, run_id, outcome, detail, at);
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .map_err(|e| format!("{path}: {e}"))?;
            f.write_all(block.as_bytes()).map_err(|e| e.to_string())
        }
        Delivery::Webhook { url } => {
            let body = webhook_body(job, run_id, outcome, detail, at);
            // curl rather than a HTTP client crate, for the same reason
            // tool_web_fetch uses it: TLS without a dependency is not on the
            // table, and curl ships with macOS.
            let mut child = Command::new("curl")
                .args([
                    "-sS",
                    "-X",
                    "POST",
                    "-H",
                    "Content-Type: application/json",
                    "--max-time",
                    "20",
                    "--data-binary",
                    "@-",
                    url,
                ])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("curl: {e}"))?;
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(body.as_bytes());
            }
            let out = child.wait_with_output().map_err(|e| e.to_string())?;
            if out.status.success() {
                Ok(())
            } else {
                let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
                Err(if err.is_empty() {
                    format!("curl exit {}", out.status.code().unwrap_or(-1))
                } else {
                    err.chars().take(200).collect()
                })
            }
        }
    }
}

// ---------------------------------------------------------------- the store

struct Sched {
    loaded: bool,
    /// Non-empty when a file on disk was refused. While it is set, nothing
    /// fires and nothing is written.
    error: String,
    jobs: Vec<Job>,
    states: HashMap<String, JobState>,
    /// job id -> the instant after which a silent job is presumed dead.
    flight: HashMap<String, i64>,
    /// Bumped by anything that can change WHEN something next needs doing.
    /// The clock thread compares it against `horizon_gen` and skips the whole
    /// recomputation when the two agree, which is every wake that the sleep
    /// cap produced rather than an actual deadline.
    generation: u64,
    horizon: Option<i64>,
    horizon_gen: u64,
}

fn sched() -> &'static Mutex<Sched> {
    static S: OnceLock<Mutex<Sched>> = OnceLock::new();
    S.get_or_init(|| {
        Mutex::new(Sched {
            loaded: false,
            error: String::new(),
            jobs: Vec::new(),
            states: HashMap::new(),
            flight: HashMap::new(),
            generation: 1,
            horizon: None,
            // Deliberately not equal to `generation`: the first pass must
            // compute a horizon rather than trust the zero it starts with.
            horizon_gen: 0,
        })
    })
}

/// How the clock thread is told it has something new to do. Without it, a job
/// saved at 09:00 for 09:01 would not be noticed until the sleep cap expired.
fn waker() -> &'static Condvar {
    static C: OnceLock<Condvar> = OnceLock::new();
    C.get_or_init(Condvar::new)
}

/// Invalidate the cached horizon and wake the clock. Called by every command
/// that can move a deadline.
fn bump(s: &mut Sched) {
    s.generation = s.generation.wrapping_add(1);
    waker().notify_all();
}


fn ensure_loaded(s: &mut Sched) {
    if s.loaded {
        return;
    }
    s.loaded = true;
    let dir = schedule_dir();
    match read_jobs(&dir) {
        Ok(jobs) => s.jobs = jobs,
        Err(e) => {
            s.error = e;
            return;
        }
    }
    match read_states(&dir) {
        Ok(states) => s.states = states,
        Err(e) => {
            s.error = e;
            s.jobs.clear();
        }
    }
}

fn state_of<'a>(s: &'a mut Sched, id: &str) -> &'a mut JobState {
    s.states.entry(id.to_string()).or_default()
}

fn flush_states(s: &Sched) -> Result<(), String> {
    write_states(&schedule_dir(), &s.states)
}

// ---------------------------------------------------------------- the view

/// One row as the UI reads it: the definition, the state, and the two derived
/// things a person actually looks at.
#[derive(Serialize, Clone)]
pub struct JobRow {
    #[serde(flatten)]
    pub job: Job,
    pub state: JobState,
    /// Unix SECONDS. None when the schedule is unparsable or the job is off.
    pub next_fire_at: Option<i64>,
    /// Why there is no next fire, when that is the reason.
    pub schedule_error: String,
    /// How the engine read the schedule, in words.
    pub schedule_note: String,
    pub in_flight: bool,
}

#[derive(Serialize, Clone)]
pub struct JobsView {
    pub jobs: Vec<JobRow>,
    /// Non-empty when a file was refused. The UI must say so rather than show
    /// an empty list, which would read as "you have no jobs".
    pub error: String,
    pub catchup_grace_minutes: i64,
}

fn view(s: &mut Sched) -> JobsView {
    let now = now_secs();
    let zone = Local;
    let mut rows = Vec::with_capacity(s.jobs.len());
    for job in &s.jobs {
        let state = s.states.get(&job.id).cloned().unwrap_or_default();
        let (next, err, note) = match cron::parse_schedule(&job.schedule) {
            Err(e) => (None, e, String::new()),
            Ok(sched) => {
                let note = cron::describe(&sched);
                if !job.enabled {
                    (None, String::new(), note)
                } else {
                    let anchor = state.last_fired_at.unwrap_or(job.enabled_at);
                    (
                        cron::next_fire(&sched, now, anchor, &zone),
                        String::new(),
                        note,
                    )
                }
            }
        };
        rows.push(JobRow {
            job: job.clone(),
            state,
            next_fire_at: next,
            schedule_error: err,
            schedule_note: note,
            in_flight: s.flight.contains_key(&job.id),
        });
    }
    JobsView {
        jobs: rows,
        error: s.error.clone(),
        catchup_grace_minutes: CATCHUP_GRACE_SECS / 60,
    }
}

// ---------------------------------------------------------------- the clock

/// What the frontend is handed when a job comes due.
#[derive(Serialize, Clone)]
pub struct JobDue {
    pub job: Job,
    /// The instant the fire was due for, which is not necessarily now.
    pub scheduled_at: i64,
    pub fired_at: i64,
    /// How many other fires were deliberately dropped to get here.
    pub dropped: u32,
    pub saturated: bool,
    pub catchup: bool,
}

/// The earliest instant at which anything could need doing, or None when
/// nothing ever will.
///
/// Pure, and separate from the pass below, because it is the function the idle
/// cost is made of: whatever it returns is exactly how long this process is
/// allowed to stay asleep. A flight deadline counts, because a job whose
/// window died has to become eligible again at that instant and not merely
/// whenever something else happened to wake us.
pub fn horizon_of(
    jobs: &[Job],
    states: &HashMap<String, JobState>,
    flight: &HashMap<String, i64>,
    now: i64,
    zone: &dyn Zone,
) -> Option<i64> {
    let mut earliest: Option<i64> = None;
    let mut keep = |t: i64| {
        earliest = Some(match earliest {
            Some(e) if e <= t => e,
            _ => t,
        });
    };
    for deadline in flight.values() {
        keep(*deadline);
    }
    for job in jobs {
        if !job.enabled || flight.contains_key(&job.id) {
            continue;
        }
        let Ok(schedule) = cron::parse_schedule(&job.schedule) else {
            continue;
        };
        let state = states.get(&job.id);
        let anchor = state
            .and_then(|s| s.last_fired_at)
            .unwrap_or(job.enabled_at);
        // From the ANCHOR, not from now: a fire that is already overdue must
        // put the horizon in the past so the next pass happens immediately.
        if let Some(t) = cron::next_fire(&schedule, anchor, anchor, zone) {
            keep(t);
        }
        // An interval anchored far in the past reports a future fire, which is
        // right for display and wrong here, so the overdue case is caught
        // separately: anything due at or before `now` means "wake now".
        if state.and_then(|s| s.last_fired_at).unwrap_or(job.enabled_at) < now {
            let missed = cron::missed_since(&schedule, anchor, now, zone, 1);
            if missed.last.is_some() {
                keep(now);
            }
        }
    }
    earliest
}

/// How long the clock thread may sleep. `None` means "with no timeout at all",
/// which is what an app with no enabled job does: zero wakeups.
pub fn park_for(horizon: Option<i64>, now: i64) -> Option<Duration> {
    match horizon {
        None => None,
        Some(t) if t <= now => Some(Duration::from_secs(0)),
        Some(t) => Some(Duration::from_secs((t - now) as u64).min(MAX_SLEEP)),
    }
}

/// Sleep until there is something to do, or until a command says there is.
fn park(horizon: Option<i64>) {
    let guard = sched().lock().unwrap_or_else(|e| e.into_inner());
    match park_for(horizon, now_secs()) {
        Some(d) if d.is_zero() => {}
        // The guard is bound and then dropped explicitly. `let _ =` on a lock
        // result drops it at the end of the statement, which is the same thing
        // here but is denied by the compiler because it usually is not.
        Some(d) => {
            let woken = waker().wait_timeout(guard, d);
            drop(woken);
        }
        None => {
            let woken = waker().wait(guard);
            drop(woken);
        }
    }
}

/// One pass of the clock: fire what is due, and say when the next pass has to
/// happen. Returns the events rather than emitting them, so the whole thing
/// runs with the lock released before anything touches Tauri.
fn pass() -> (Vec<JobDue>, Option<i64>) {
    let mut due: Vec<JobDue> = Vec::new();
    let mut changed = false;
    let horizon;
    {
        let mut s = sched().lock().unwrap_or_else(|e| e.into_inner());
        ensure_loaded(&mut s);
        if !s.error.is_empty() {
            // A refused file fires nothing, and there is nothing to wake for
            // until a human fixes it and the app is restarted.
            return (due, None);
        }
        // The cached horizon. A wake that the sleep cap produced finds the
        // generation unchanged and recomputes nothing at all: this is the
        // whole reason the idle cost does not grow with the number of jobs.
        let now = now_secs();
        if s.horizon_gen == s.generation && s.horizon.map(|t| t > now).unwrap_or(true) {
            return (due, s.horizon);
        }
        // A job whose window died owes us nothing more. Clearing the flight
        // here, before the decision, is what lets it fire again.
        s.flight.retain(|_, until| *until > now);
        let jobs = s.jobs.clone();
        for job in jobs {
            if !job.enabled || s.flight.contains_key(&job.id) {
                continue;
            }
            let Ok(schedule) = cron::parse_schedule(&job.schedule) else {
                continue;
            };
            let state = s.states.get(&job.id).cloned().unwrap_or_default();
            match decide(&schedule, &state, job.enabled_at, now, &Local) {
                Decision::Idle => {}
                Decision::Drop {
                    missed,
                    saturated: _,
                    last,
                } => {
                    let st = state_of(&mut s, &job.id);
                    // The anchor moves even though nothing ran. Leaving it
                    // behind would make the scheduler rediscover the same
                    // stale batch on every pass, forever.
                    st.last_fired_at = Some(last);
                    st.missed = st.missed.saturating_add(missed);
                    st.last_missed_at = Some(last);
                    changed = true;
                }
                Decision::Fire {
                    scheduled,
                    dropped,
                    saturated,
                    catchup,
                } => {
                    let st = state_of(&mut s, &job.id);
                    st.last_fired_at = Some(scheduled);
                    if dropped > 0 {
                        st.missed = st.missed.saturating_add(dropped);
                        st.last_missed_at = Some(scheduled);
                    }
                    changed = true;
                    let deadline = now + job.max_minutes as i64 * 60 + FLIGHT_SLACK_SECS;
                    s.flight.insert(job.id.clone(), deadline);
                    due.push(JobDue {
                        job: job.clone(),
                        scheduled_at: scheduled,
                        fired_at: now,
                        dropped,
                        saturated,
                        catchup,
                    });
                }
            }
        }
        // The disk is touched ONLY when something actually moved. A pass that
        // concluded "nothing is due" writes nothing at all, which is what
        // makes an idle scheduler free rather than merely cheap.
        if changed {
            // A failure here is not fatal: the job already fired, and losing
            // the state costs one duplicate at the next launch, not a run.
            if let Err(e) = flush_states(&s) {
                eprintln!("Galactus scheduler: state not saved: {e}");
            }
        }
        let now = now_secs();
        s.horizon = horizon_of(&s.jobs, &s.states, &s.flight, now, &Local);
        s.horizon_gen = s.generation;
        horizon = s.horizon;
    }
    (due, horizon)
}

/// Start the clock. One OS thread, parked for the life of the process.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || loop {
        let (due, horizon) = pass();
        for payload in due {
            let _ = app.emit(JOB_DUE_EVENT, payload);
        }
        park(horizon);
    });
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub fn jobs_list() -> JobsView {
    let mut s = sched().lock().unwrap_or_else(|e| e.into_inner());
    ensure_loaded(&mut s);
    view(&mut s)
}

#[tauri::command]
pub fn jobs_save(job: JobInput) -> Result<JobsView, String> {
    let mut s = sched().lock().unwrap_or_else(|e| e.into_inner());
    ensure_loaded(&mut s);
    if !s.error.is_empty() {
        return Err(s.error.clone());
    }
    let now = now_secs();
    let existing = if job.id.trim().is_empty() {
        None
    } else {
        let id = sanitize_id(job.id.trim());
        s.jobs.iter().find(|j| j.id == id).cloned()
    };
    let built = validate(job, existing.as_ref(), now)?;
    match s.jobs.iter_mut().find(|j| j.id == built.id) {
        Some(slot) => *slot = built,
        None => s.jobs.push(built),
    }
    write_jobs(&schedule_dir(), &s.jobs)?;
    // A job saved at 09:00 for 09:01 must be noticed now, not at the end of
    // whatever sleep the clock thread happens to be in.
    bump(&mut s);
    Ok(view(&mut s))
}

#[tauri::command]
pub fn jobs_delete(id: String) -> Result<JobsView, String> {
    let mut s = sched().lock().unwrap_or_else(|e| e.into_inner());
    ensure_loaded(&mut s);
    if !s.error.is_empty() {
        return Err(s.error.clone());
    }
    let id = sanitize_id(&id);
    s.jobs.retain(|j| j.id != id);
    s.states.remove(&id);
    s.flight.remove(&id);
    write_jobs(&schedule_dir(), &s.jobs)?;
    flush_states(&s)?;
    bump(&mut s);
    Ok(view(&mut s))
}

#[tauri::command]
pub fn jobs_enable(id: String, enabled: bool) -> Result<JobsView, String> {
    let mut s = sched().lock().unwrap_or_else(|e| e.into_inner());
    ensure_loaded(&mut s);
    if !s.error.is_empty() {
        return Err(s.error.clone());
    }
    let id = sanitize_id(&id);
    let now = now_secs();
    let found = s.jobs.iter_mut().find(|j| j.id == id);
    let Some(job) = found else {
        return Err("no such job".into());
    };
    if job.enabled != enabled {
        job.enabled = enabled;
        job.updated_at = now;
        if enabled {
            // Switching a job on must not make it instantly overdue. The
            // anchor moves to now, and the last fire is forgotten: whatever
            // was missed while it was off was missed on purpose.
            job.enabled_at = now;
            let st = s.states.entry(id.clone()).or_default();
            st.last_fired_at = None;
        }
    }
    write_jobs(&schedule_dir(), &s.jobs)?;
    flush_states(&s)?;
    bump(&mut s);
    Ok(view(&mut s))
}

/// Fire a job by hand, now. Does NOT move the schedule: a manual run is not a
/// scheduled one, and shifting the next fire because someone pressed a button
/// would make the schedule mean something different for the rest of the day.
#[tauri::command]
pub fn jobs_run_now(app: AppHandle, id: String) -> Result<JobsView, String> {
    let payload;
    {
        let mut s = sched().lock().unwrap_or_else(|e| e.into_inner());
        ensure_loaded(&mut s);
        if !s.error.is_empty() {
            return Err(s.error.clone());
        }
        let id = sanitize_id(&id);
        let now = now_secs();
        s.flight.retain(|_, until| *until > now);
        if s.flight.contains_key(&id) {
            return Err("that job is already running".into());
        }
        let Some(job) = s.jobs.iter().find(|j| j.id == id).cloned() else {
            return Err("no such job".into());
        };
        s.flight
            .insert(id.clone(), now + job.max_minutes as i64 * 60 + FLIGHT_SLACK_SECS);
        bump(&mut s);
        payload = JobDue {
            job,
            scheduled_at: now,
            fired_at: now,
            dropped: 0,
            saturated: false,
            catchup: false,
        };
    }
    let _ = app.emit(JOB_DUE_EVENT, payload);
    let mut s = sched().lock().unwrap_or_else(|e| e.into_inner());
    Ok(view(&mut s))
}

/// The frontend saying what became of a dispatched job.
///
/// This is also the only place delivery happens: the output is whatever the
/// run produced, and only the frontend has it. Delivery runs on its own thread
/// so a webhook pointing at something slow cannot make the UI wait.
#[tauri::command]
pub fn jobs_report(
    id: String,
    run_id: String,
    outcome: String,
    detail: String,
) -> Result<JobsView, String> {
    let job;
    {
        let mut s = sched().lock().unwrap_or_else(|e| e.into_inner());
        ensure_loaded(&mut s);
        if !s.error.is_empty() {
            return Err(s.error.clone());
        }
        let id = sanitize_id(&id);
        s.flight.remove(&id);
        job = s.jobs.iter().find(|j| j.id == id).cloned();
        let now = now_secs();
        let st = state_of(&mut s, &id);
        st.last_finished_at = Some(now);
        st.last_outcome = outcome.chars().take(32).collect();
        st.last_detail = detail.chars().take(2000).collect();
        st.last_run_id = run_id.chars().take(64).collect();
        if outcome == "finished" {
            st.consecutive_failures = 0;
        } else {
            st.consecutive_failures = st.consecutive_failures.saturating_add(1);
        }
        if job.as_ref().map(|j| j.delivery != Delivery::None).unwrap_or(false) {
            st.last_delivery = "sending".into();
        }
        if let Err(e) = flush_states(&s) {
            eprintln!("Galactus scheduler: state not saved: {e}");
        }
        // The flight just cleared, so this job can come due again: the horizon
        // it was excluded from has to be recomputed.
        bump(&mut s);
    }
    if let Some(job) = job {
        if job.delivery != Delivery::None {
            let at = now_secs();
            std::thread::spawn(move || {
                let result = deliver(&job, &run_id, &outcome, &detail, at);
                let mut s = sched().lock().unwrap_or_else(|e| e.into_inner());
                let st = state_of(&mut s, &job.id);
                st.last_delivery = match result {
                    Ok(()) => "ok".into(),
                    Err(e) => e,
                };
                let _ = flush_states(&s);
            });
        }
    }
    let mut s = sched().lock().unwrap_or_else(|e| e.into_inner());
    Ok(view(&mut s))
}

/// The next few fires of a schedule that has not been saved yet, so the form
/// can show what it will do before a human commits to it.
#[tauri::command]
pub fn jobs_preview(schedule: String, count: Option<usize>) -> Result<Vec<i64>, String> {
    let parsed = cron::parse_schedule(&schedule)?;
    let mut out = Vec::new();
    let anchor = now_secs();
    let mut cursor = anchor;
    for _ in 0..count.unwrap_or(3).min(10) {
        let Some(next) = cron::next_fire(&parsed, cursor, anchor, &Local) else {
            break;
        };
        out.push(next);
        cursor = next;
    }
    Ok(out)
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cron::Utc;

    fn temp_dir(tag: &str) -> PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let p = std::env::temp_dir().join(format!("galactus-sched-{tag}-{n}"));
        std::fs::create_dir_all(&p).expect("temp dir");
        p
    }

    fn a_job() -> Job {
        Job {
            id: "job-1".into(),
            name: "Nightly digest".into(),
            task: "Summarise what changed today.".into(),
            schedule: "0 3 * * *".into(),
            enabled: true,
            policy: "read_only".into(),
            max_turns: 8,
            max_minutes: 20,
            preauthorize_every_time: false,
            delivery: Delivery::None,
            created_at: 1000,
            updated_at: 1000,
            enabled_at: 1000,
        }
    }

    fn input() -> JobInput {
        JobInput {
            id: String::new(),
            name: "  ".into(),
            task: "  Summarise the inbox  ".into(),
            schedule: "0 9 * * mon-fri".into(),
            enabled: true,
            policy: "read_only".into(),
            max_turns: 8,
            max_minutes: 20,
            preauthorize_every_time: false,
            delivery: Delivery::None,
        }
    }

    // ------------------------------------------------------------ persistence

    #[test]
    fn definitions_and_state_survive_a_round_trip_in_two_separate_files() {
        let dir = temp_dir("round");
        let jobs = vec![a_job()];
        write_jobs(&dir, &jobs).expect("write jobs");
        let mut states = HashMap::new();
        states.insert(
            "job-1".to_string(),
            JobState {
                last_fired_at: Some(4242),
                last_outcome: "finished".into(),
                consecutive_failures: 0,
                ..Default::default()
            },
        );
        write_states(&dir, &states).expect("write states");
        assert_eq!(read_jobs(&dir).expect("read jobs"), jobs);
        assert_eq!(read_states(&dir).expect("read states"), states);
        // The split is the point: the two files are genuinely separate.
        assert!(dir.join(JOBS_FILE).is_file());
        assert!(dir.join(STATE_FILE).is_file());
        let raw = std::fs::read_to_string(dir.join(JOBS_FILE)).expect("raw");
        assert!(
            !raw.contains("last_fired_at"),
            "runtime state must not leak into the definitions"
        );
    }

    #[test]
    fn a_missing_file_is_an_empty_schedule_and_not_an_error() {
        let dir = temp_dir("missing");
        assert_eq!(read_jobs(&dir).expect("no file"), Vec::<Job>::new());
        assert!(read_states(&dir).expect("no file").is_empty());
    }

    #[test]
    fn a_corrupt_file_is_refused_and_left_exactly_as_it_was() {
        let dir = temp_dir("corrupt");
        let broken = "{\"version\":1,\"jobs\":[{\"id\":\"job-1\",\"na";
        std::fs::write(dir.join(JOBS_FILE), broken).expect("write");
        let err = read_jobs(&dir).expect_err("must refuse");
        assert!(err.contains("not a readable job file"), "got {err}");
        assert!(err.contains(JOBS_FILE), "the message must name the file");
        assert_eq!(
            std::fs::read_to_string(dir.join(JOBS_FILE)).expect("still there"),
            broken,
            "a refused file is not repaired, not rewritten and not deleted"
        );
    }

    #[test]
    fn a_job_missing_a_required_field_is_refused_rather_than_defaulted() {
        let dir = temp_dir("partial");
        // No policy: a job whose policy defaulted would run under whatever
        // this build happens to consider safe, which nobody agreed to.
        std::fs::write(
            dir.join(JOBS_FILE),
            "{\"version\":1,\"jobs\":[{\"id\":\"j\",\"name\":\"n\",\"task\":\"t\",\"schedule\":\"@daily\",\"enabled\":true,\"max_turns\":1,\"max_minutes\":1,\"preauthorize_every_time\":false,\"created_at\":0,\"updated_at\":0,\"enabled_at\":0}]}",
        )
        .expect("write");
        assert!(read_jobs(&dir).is_err());
    }

    #[test]
    fn a_file_from_a_future_version_is_refused_by_name() {
        let dir = temp_dir("version");
        std::fs::write(dir.join(JOBS_FILE), "{\"version\":99,\"jobs\":[]}").expect("write");
        let err = read_jobs(&dir).expect_err("must refuse");
        assert!(err.contains("version 99"), "got {err}");
    }

    #[test]
    fn delivery_defaults_to_nowhere_when_the_file_does_not_mention_it() {
        let dir = temp_dir("nodelivery");
        let mut job = a_job();
        job.delivery = Delivery::None;
        write_jobs(&dir, &[job]).expect("write");
        let text = std::fs::read_to_string(dir.join(JOBS_FILE)).expect("raw");
        let stripped = text.replace(
            "\"delivery\": {\n        \"mode\": \"none\"\n      },\n      ",
            "",
        );
        std::fs::write(dir.join(JOBS_FILE), &stripped).expect("write");
        let back = read_jobs(&dir).expect("read");
        assert_eq!(back[0].delivery, Delivery::None);
    }

    // ------------------------------------------------------------ validation

    #[test]
    fn a_saved_job_takes_its_name_from_the_task_and_trims_everything() {
        let job = validate(input(), None, 5000).expect("valid");
        assert_eq!(job.name, "Summarise the inbox");
        assert_eq!(job.task, "Summarise the inbox");
        assert!(job.id.starts_with("job-"));
        assert_eq!(job.created_at, 5000);
        assert_eq!(job.enabled_at, 5000);
    }

    #[test]
    fn an_unparsable_schedule_is_refused_at_save_time_not_at_fire_time() {
        let mut i = input();
        i.schedule = "0 9 * *".into();
        let err = validate(i, None, 0).expect_err("must refuse");
        assert!(err.contains("5 fields"), "got {err}");
    }

    #[test]
    fn preauthorize_is_dropped_for_every_policy_that_cannot_use_it() {
        let mut i = input();
        i.preauthorize_every_time = true;
        i.policy = "read_only".into();
        assert!(!validate(i, None, 0).expect("valid").preauthorize_every_time);
        let mut i = input();
        i.preauthorize_every_time = true;
        i.policy = "autonomous".into();
        assert!(validate(i, None, 0).expect("valid").preauthorize_every_time);
    }

    #[test]
    fn an_unknown_policy_is_refused_rather_than_narrowed() {
        let mut i = input();
        i.policy = "root".into();
        assert!(validate(i, None, 0).is_err());
        let mut i = input();
        i.task = "   ".into();
        assert!(validate(i, None, 0).is_err());
    }

    #[test]
    fn budgets_are_clamped_into_the_range_the_runs_view_offers() {
        let mut i = input();
        i.max_turns = 100_000;
        i.max_minutes = 0;
        let job = validate(i, None, 0).expect("valid");
        assert_eq!(job.max_turns, MAX_TURNS);
        assert_eq!(job.max_minutes, 1);
    }

    #[test]
    fn editing_an_enabled_job_does_not_restart_its_interval() {
        let mut previous = a_job();
        previous.enabled_at = 1000;
        let mut i = input();
        i.id = previous.id.clone();
        i.schedule = "every 2h".into();
        let job = validate(i, Some(&previous), 90_000).expect("valid");
        assert_eq!(
            job.enabled_at, 1000,
            "renaming an hourly job must not push its next fire an hour out"
        );
        // Switching it back on does move the anchor.
        let mut off = previous.clone();
        off.enabled = false;
        let mut i = input();
        i.id = off.id.clone();
        let job = validate(i, Some(&off), 90_000).expect("valid");
        assert_eq!(job.enabled_at, 90_000);
    }

    // ------------------------------------------------------------ catch up

    fn state_fired(at: i64) -> JobState {
        JobState {
            last_fired_at: Some(at),
            ..Default::default()
        }
    }

    #[test]
    fn nothing_due_means_nothing_happens() {
        let s = cron::parse_schedule("0 3 * * *").expect("cron");
        let now = 1_715_760_000; // 2024-05-15T08:00:00Z
        let d = decide(&s, &state_fired(now - 3600), 0, now, &Utc);
        assert_eq!(d, Decision::Idle);
    }

    #[test]
    fn a_single_missed_fire_inside_the_grace_window_runs_late() {
        let s = cron::parse_schedule("0 * * * *").expect("hourly");
        let scheduled = 1_715_760_000; // on the hour
        let now = scheduled + 600;
        let d = decide(&s, &state_fired(scheduled - 3600), 0, now, &Utc);
        assert_eq!(
            d,
            Decision::Fire {
                scheduled,
                dropped: 0,
                saturated: false,
                catchup: true
            }
        );
    }

    #[test]
    fn four_hundred_missed_fires_produce_exactly_one_run() {
        // The requirement, stated as a test. A per-minute job and an app closed
        // for seven hours is 420 due fires; it must produce ONE.
        let s = cron::parse_schedule("* * * * *").expect("per minute");
        let anchor = 1_715_731_200; // 2024-05-15T00:00:00Z
        let now = anchor + 7 * 3600;
        let d = decide(&s, &state_fired(anchor), 0, now, &Utc);
        match d {
            Decision::Fire {
                scheduled,
                dropped,
                catchup,
                ..
            } => {
                assert_eq!(scheduled, now, "the most recent one, not the oldest");
                assert!(dropped >= 400, "the rest are recorded as dropped: {dropped}");
                assert!(catchup);
            }
            other => panic!("expected one fire, got {other:?}"),
        }
    }

    #[test]
    fn a_batch_older_than_the_grace_window_fires_nothing_at_all() {
        // The 03:00 digest, a laptop opened at 16:00. Running it then is not
        // late, it is wrong, and the next one is only eleven hours away.
        let s = cron::parse_schedule("0 3 * * *").expect("daily");
        let three_am = 1_715_742_000; // 2024-05-15T03:00:00Z
        let now = three_am + 13 * 3600;
        let d = decide(&s, &state_fired(three_am - 86_400), 0, now, &Utc);
        assert_eq!(
            d,
            Decision::Drop {
                missed: 1,
                saturated: false,
                last: three_am
            }
        );
    }

    #[test]
    fn the_grace_boundary_is_where_it_says_it_is() {
        // Daily, so the last due fire stays put while `now` walks past the
        // boundary. An hourly job would keep producing fresher ones and would
        // never reach the edge being tested here.
        // The VALUE, not just the boundary. Everything below is written in
        // terms of CATCHUP_GRACE_SECS, so it moves with the constant and would
        // stay green if the window were widened to twelve hours or narrowed to
        // one. "Nothing older than six hours" is the rule that was agreed, so
        // six hours is what has to be pinned, once, here.
        assert_eq!(CATCHUP_GRACE_SECS, 6 * 3600, "the grace window is six hours");
        let s = cron::parse_schedule("0 3 * * *").expect("daily");
        let scheduled = 1_715_742_000; // 2024-05-15T03:00:00Z
        let before = state_fired(scheduled - 86_400);
        let inside = decide(&s, &before, 0, scheduled + CATCHUP_GRACE_SECS, &Utc);
        assert!(matches!(inside, Decision::Fire { .. }), "got {inside:?}");
        let outside = decide(&s, &before, 0, scheduled + CATCHUP_GRACE_SECS + 1, &Utc);
        assert!(matches!(outside, Decision::Drop { .. }), "got {outside:?}");
    }

    #[test]
    fn a_job_that_has_never_fired_counts_from_when_it_was_enabled() {
        let s = cron::parse_schedule("every 30m").expect("interval");
        let enabled = 1_715_731_200;
        // Nine minutes later: nothing is due yet, and in particular the epoch
        // is not the anchor.
        assert_eq!(
            decide(&s, &JobState::default(), enabled, enabled + 540, &Utc),
            Decision::Idle
        );
        let d = decide(&s, &JobState::default(), enabled, enabled + 1900, &Utc);
        assert!(matches!(d, Decision::Fire { .. }));
    }

    #[test]
    fn waking_more_often_than_the_schedule_still_fires_a_job_once_a_slot() {
        // The other half of the 400-runs rule, and the one that bites daily:
        // the clock can be woken more often than the finest schedule, so the
        // anchor must move to the SCHEDULED instant, not to now, or every job
        // would fire on every pass.
        let s = cron::parse_schedule("* * * * *").expect("per minute");
        let start = 1_715_731_200; // exactly on a minute
        let mut state = state_fired(start);
        let mut fires = Vec::new();
        for beat in 1..=9 {
            let now = start + beat * 20;
            if let Decision::Fire { scheduled, .. } = decide(&s, &state, 0, now, &Utc) {
                fires.push(scheduled);
                state.last_fired_at = Some(scheduled);
            }
        }
        assert_eq!(
            fires,
            vec![start + 60, start + 120, start + 180],
            "three minutes, three fires, however often the clock woke"
        );
    }

    #[test]
    fn a_dropped_batch_moves_the_anchor_so_it_is_not_rediscovered_forever() {
        // Not a property of `decide` but of what the pass does with it. The
        // arithmetic is here because getting it wrong means one drop per pass,
        // three times a minute, until someone reads the log.
        let s = cron::parse_schedule("0 3 * * *").expect("daily");
        let three_am = 1_715_742_000;
        let now = three_am + 13 * 3600;
        let Decision::Drop { last, .. } = decide(&s, &state_fired(0), 0, now, &Utc) else {
            panic!("expected a drop");
        };
        let after = decide(&s, &state_fired(last), 0, now, &Utc);
        assert_eq!(after, Decision::Idle, "the same batch must not come back");
    }

    // ------------------------------------------------------------ idle cost

    /// Replay the clock thread's own sleep arithmetic over a window and count
    /// how many times it would come out of `park`.
    ///
    /// This is the loop in `start`, minus the emitting: `horizon_of` decides
    /// how long to sleep, `park_for` caps it, and a wake that finds nothing to
    /// do simply asks again. Nothing here is an estimate; the numbers the
    /// tests below assert are the numbers that function produces.
    fn wakeups_over(jobs: &[Job], states: &HashMap<String, JobState>, from: i64, window: i64) -> u32 {
        let flight = HashMap::new();
        let mut states = states.clone();
        let mut now = from;
        let mut wakes = 0u32;
        loop {
            let horizon = horizon_of(jobs, &states, &flight, now, &Utc);
            let Some(d) = park_for(horizon, now) else {
                // No timeout at all: it sleeps past the end of the window and
                // only a command could wake it.
                return wakes;
            };
            if d.is_zero() {
                // Something is due. This is the same wake still running, so it
                // is not counted twice; the state moves exactly as the real
                // pass moves it, which is what puts the horizon back in the
                // future instead of spinning here.
                for job in jobs {
                    let Ok(schedule) = cron::parse_schedule(&job.schedule) else {
                        continue;
                    };
                    let st = states.entry(job.id.clone()).or_default();
                    match decide(&schedule, st, job.enabled_at, now, &Utc) {
                        Decision::Fire { scheduled, .. } => st.last_fired_at = Some(scheduled),
                        Decision::Drop { last, .. } => st.last_fired_at = Some(last),
                        Decision::Idle => {}
                    }
                }
                continue;
            }
            let step = d.as_secs() as i64;
            if now + step > from + window {
                return wakes;
            }
            now += step;
            wakes += 1;
        }
    }

    fn daily(id: &str) -> Job {
        Job {
            id: id.into(),
            schedule: "0 3 * * *".into(),
            ..a_job()
        }
    }

    #[test]
    fn an_idle_scheduler_with_no_enabled_job_never_wakes_at_all() {
        // Not "wakes rarely": the park has no timeout, so the thread is off
        // the run queue until a command notifies it.
        assert_eq!(horizon_of(&[], &HashMap::new(), &HashMap::new(), 0, &Utc), None);
        assert_eq!(park_for(None, 0), None);
        assert_eq!(wakeups_over(&[], &HashMap::new(), 1_715_731_200, 3600), 0);
        // A job that exists but is switched off is the same thing.
        let mut off = daily("job-1");
        off.enabled = false;
        assert_eq!(wakeups_over(&[off], &HashMap::new(), 1_715_731_200, 3600), 0);
    }

    #[test]
    fn the_measured_idle_rate_is_the_same_whatever_the_schedule_holds() {
        // The numbers this feature is allowed to cost, asserted rather than
        // claimed. They come from the loop's own arithmetic (horizon_of and
        // park_for), replayed over a window by `wakeups_over` above.
        //
        //   no job          0 wakeups an hour   the park has no timeout
        //   one daily job   2 an hour, 48 a day
        //   ten daily jobs  2 an hour, 48 a day, identical: the horizon is one
        //                   minimum, and a wake that finds the generation
        //                   unchanged recomputes nothing
        //   per minute      60 an hour, which is the schedule itself and not
        //                   overhead: every one of those wakes fires a job
        let start = 1_715_760_000; // 2024-05-15T08:00:00Z, an hour with no fire
        let mut one_state = HashMap::new();
        one_state.insert("job-1".to_string(), state_fired(start - 5 * 3600));
        let one = vec![daily("job-1")];

        let mut ten = Vec::new();
        let mut ten_state = HashMap::new();
        for i in 0..10 {
            let id = format!("job-{i}");
            ten_state.insert(id.clone(), state_fired(start - 5 * 3600));
            ten.push(daily(&id));
        }

        let minute = vec![Job {
            id: "job-m".into(),
            schedule: "* * * * *".into(),
            ..a_job()
        }];
        let mut minute_state = HashMap::new();
        minute_state.insert("job-m".to_string(), state_fired(start));

        assert_eq!(wakeups_over(&[], &HashMap::new(), start, 3600), 0, "no job");
        assert_eq!(wakeups_over(&one, &one_state, start, 3600), 2, "one job, an hour");
        assert_eq!(wakeups_over(&one, &one_state, start, 24 * 3600), 48, "one job, a day");
        assert_eq!(wakeups_over(&ten, &ten_state, start, 3600), 2, "ten jobs, an hour");
        assert_eq!(
            wakeups_over(&ten, &ten_state, start, 24 * 3600),
            48,
            "ten jobs cost exactly what one does"
        );
        assert_eq!(
            wakeups_over(&minute, &minute_state, start, 3600),
            60,
            "a per-minute job wakes once a minute, and every wake does work"
        );
    }

    #[test]
    fn the_clock_sleeps_to_the_deadline_rather_than_polling_towards_it() {
        let start = 1_715_760_000;
        let mut states = HashMap::new();
        states.insert("job-1".to_string(), state_fired(start));
        // Hourly: the next fire is 3600 seconds out, and the wait is exactly
        // that, not a series of short polls.
        let hourly = vec![Job {
            id: "job-1".into(),
            schedule: "0 * * * *".into(),
            ..a_job()
        }];
        let horizon = horizon_of(&hourly, &states, &HashMap::new(), start, &Utc);
        assert_eq!(horizon, Some(start + 3600));
        assert_eq!(park_for(horizon, start), Some(Duration::from_secs(1800)));
        // And with a nearer deadline it is the deadline, uncapped.
        assert_eq!(
            park_for(Some(start + 90), start),
            Some(Duration::from_secs(90))
        );
    }

    #[test]
    fn an_overdue_job_puts_the_horizon_in_the_past_so_the_next_pass_is_immediate() {
        let start = 1_715_760_000;
        let mut states = HashMap::new();
        states.insert("job-1".to_string(), state_fired(start - 7200));
        let hourly = vec![Job {
            id: "job-1".into(),
            schedule: "0 * * * *".into(),
            ..a_job()
        }];
        let horizon = horizon_of(&hourly, &states, &HashMap::new(), start, &Utc);
        assert!(horizon.map(|t| t <= start).unwrap_or(false), "got {horizon:?}");
        assert_eq!(park_for(horizon, start), Some(Duration::from_secs(0)));
    }

    #[test]
    fn a_job_in_flight_is_waited_on_by_its_deadline_and_not_by_its_schedule() {
        let start = 1_715_760_000;
        let mut flight = HashMap::new();
        flight.insert("job-1".to_string(), start + 400);
        let jobs = vec![Job {
            id: "job-1".into(),
            schedule: "* * * * *".into(),
            ..a_job()
        }];
        // Per minute, but it is running: the only reason to wake is the moment
        // the flight expires and it becomes eligible again.
        assert_eq!(
            horizon_of(&jobs, &HashMap::new(), &flight, start, &Utc),
            Some(start + 400)
        );
    }

    #[test]
    fn a_command_wakes_the_clock_instead_of_making_it_poll_for_the_change() {
        // Real threads and a real wall clock: the park is entered with no
        // timeout, and the notify is the only thing that can end it.
        use std::sync::mpsc;
        let (tx, rx) = mpsc::channel::<()>();
        let parked = std::thread::spawn(move || {
            park(None);
            let _ = tx.send(());
        });
        std::thread::sleep(Duration::from_millis(120));
        assert!(
            rx.try_recv().is_err(),
            "an unnotified park must still be parked"
        );
        {
            let mut s = sched().lock().unwrap_or_else(|e| e.into_inner());
            bump(&mut s);
        }
        assert!(
            rx.recv_timeout(Duration::from_secs(2)).is_ok(),
            "a command must wake the clock at once"
        );
        parked.join().expect("thread");
    }

    // ------------------------------------------------------------ delivery

    #[test]
    fn a_webhook_target_must_be_http_and_a_file_target_must_be_absolute() {
        assert!(check_delivery(&Delivery::None).is_ok());
        assert!(check_delivery(&Delivery::Webhook {
            url: "https://example.com/hook".into()
        })
        .is_ok());
        for bad in ["file:///etc/passwd", "example.com/hook", "", "ftp://x/y"] {
            assert!(
                check_delivery(&Delivery::Webhook { url: bad.into() }).is_err(),
                "{bad} must be refused"
            );
        }
        assert!(check_delivery(&Delivery::File {
            path: "notes/out.txt".into()
        })
        .is_err());
        assert!(check_delivery(&Delivery::File {
            path: "/tmp/../etc/out.txt".into()
        })
        .is_err());
        assert!(check_delivery(&Delivery::File {
            path: "/tmp/galactus-delivery-test.txt".into()
        })
        .is_ok());
    }

    #[test]
    fn a_job_delivers_nowhere_until_a_human_says_otherwise() {
        let job = validate(input(), None, 0).expect("valid");
        assert_eq!(
            job.delivery,
            Delivery::None,
            "the default must never send anything anywhere"
        );
    }

    #[test]
    fn the_webhook_body_is_a_fixed_documented_shape() {
        let job = a_job();
        let body = webhook_body(&job, "run-7", "finished", "42 files", 1000);
        let v: serde_json::Value = serde_json::from_str(&body).expect("json");
        assert_eq!(v["source"], "galactus");
        assert_eq!(v["job"]["id"], "job-1");
        assert_eq!(v["job"]["schedule"], "0 3 * * *");
        assert_eq!(v["run"], "run-7");
        assert_eq!(v["outcome"], "finished");
        assert_eq!(v["output"], "42 files");
        assert_eq!(v["at"], 1000);
    }

    #[test]
    fn a_file_delivery_appends_rather_than_replaces() {
        let dir = temp_dir("append");
        let path = dir.join("out.txt");
        let mut job = a_job();
        job.delivery = Delivery::File {
            path: path.display().to_string(),
        };
        deliver(&job, "run-1", "finished", "first", 1000).expect("first");
        deliver(&job, "run-2", "failed", "second", 2000).expect("second");
        let text = std::fs::read_to_string(&path).expect("read");
        assert!(text.contains("first"));
        assert!(text.contains("second"), "the second block must not replace the first");
        assert!(text.contains("run-1") && text.contains("run-2"));
        assert!(text.contains("Nightly digest"));
    }

    #[test]
    fn nothing_is_written_for_a_job_that_delivers_nowhere() {
        let job = a_job();
        assert_eq!(job.delivery, Delivery::None);
        // The only observable effect must be that it returns Ok having done
        // nothing at all: there is no path to write to.
        deliver(&job, "run-1", "finished", "output", 1000).expect("no delivery");
    }

    #[test]
    fn ids_are_sanitised_so_a_job_cannot_reach_outside_its_folder() {
        assert_eq!(sanitize_id("../../etc/passwd"), "etcpasswd");
        assert_eq!(sanitize_id("job-abc_123"), "job-abc_123");
        assert_eq!(sanitize_id(&"x".repeat(200)).len(), 64);
    }
}
