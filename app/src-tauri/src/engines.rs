// Teammate engines: more than one model loaded on the same Mac.
//
// The primary engine (engine.rs, SERVER) is the one the chat, the relay and
// every existing surface talk to, and it is unchanged. A team preset asks for
// more: a planner and a coder, each its own model, each answering on its own
// port. Those extra engines live here, keyed by model id.
//
// THE RULE THAT HOLDS THIS TOGETHER: every engine is planned against what the
// others leave, never against the whole Mac. Two engines each sized as if
// alone would together oversubscribe the Metal working set, and past that
// bound nothing refuses: the allocation succeeds and the machine swaps, or a
// buffer fails mid-graph and the user reads "Compute error.". So an engine
// that does not fit beside the others is refused BEFORE it is spawned, with
// the missing gigabytes and the engine holding them named.
//
// An extra engine has everything the primary has: its own port, its own child,
// its own log, its own watchdog, and it dies with the app.

use crate::*;

/// What another engine already holds, for planning the next one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HeldEngine {
    pub(crate) model_id: String,
    pub(crate) role: String,
    /// Resident bytes: weights, arena and KV together. The larger of the
    /// planned footprint and the measured RSS, so a plan that was optimistic
    /// is corrected by what the process actually took.
    pub(crate) bytes: u64,
    /// What the process measurably holds already (RSS), 0 when unknown. While
    /// an engine loads this grows toward `bytes`.
    pub(crate) resident: u64,
    /// False while the engine is still loading. What it has not yet allocated
    /// is still counted as free by vm_stat.
    pub(crate) allocated: bool,
}

/// One engine, as the UI and the orchestrator see it.
///
/// Serialized snake_case like ServerStatus, which carries no rename: the two
/// are read by the same TypeScript and must not disagree on a field name.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub(crate) struct EngineInfo {
    pub(crate) model_id: String,
    /// The team role it was started for; "primary" for the primary engine.
    pub(crate) role: String,
    pub(crate) port: u16,
    /// starting | ready | failed
    pub(crate) phase: String,
    pub(crate) primary: bool,
    pub(crate) slots: u32,
    pub(crate) ctx_per_slot: u32,
    pub(crate) tools_ok: Option<bool>,
    pub(crate) footprint_bytes: u64,
    /// "local" (a llama-server on this Mac) or "cloud" (a proxy to a provider,
    /// see cloud.rs). A cloud engine holds no memory and its tasks leave the Mac.
    pub(crate) kind: String,
}

pub(crate) struct ExtraEngine {
    pub(crate) child: Option<Child>,
    pub(crate) role: String,
    /// 0 until the engine is spawned: a reservation holds no port yet.
    pub(crate) port: u16,
    pub(crate) phase: String,
    /// Identifies ONE start of this model. A stop, or a new start after a
    /// failure, replaces it, and every thread of the older start notices.
    pub(crate) generation: u64,
    pub(crate) slots: u32,
    pub(crate) ctx_per_slot: u32,
    pub(crate) tools_ok: Option<bool>,
    pub(crate) footprint_bytes: u64,
    pub(crate) log_name: String,
    pub(crate) kind: String,
    /// Set for a cloud proxy: raising it stops its listener.
    pub(crate) proxy_stop: Option<Arc<AtomicBool>>,
}

impl ExtraEngine {
    fn reserved(role: &str, generation: u64) -> Self {
        ExtraEngine {
            child: None,
            role: role.to_string(),
            port: 0,
            phase: "starting".into(),
            generation,
            slots: 0,
            ctx_per_slot: 0,
            tools_ok: None,
            footprint_bytes: 0,
            log_name: String::new(),
            kind: "local".into(),
            proxy_stop: None,
        }
    }

    fn info(&self, model_id: &str) -> EngineInfo {
        EngineInfo {
            model_id: model_id.to_string(),
            role: self.role.clone(),
            port: self.port,
            phase: self.phase.clone(),
            primary: false,
            slots: self.slots,
            ctx_per_slot: self.ctx_per_slot,
            tools_ok: self.tools_ok,
            footprint_bytes: self.footprint_bytes,
            kind: self.kind.clone(),
        }
    }
}

static EXTRAS: OnceLock<Mutex<HashMap<String, ExtraEngine>>> = OnceLock::new();
static EXTRA_GEN: AtomicU64 = AtomicU64::new(0);

pub(crate) fn extras() -> &'static Mutex<HashMap<String, ExtraEngine>> {
    EXTRAS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Held by every engine start, primary or teammate, from its plan to the
/// moment its footprint is recorded. Two starts planned concurrently would each
/// see the memory the other is about to take as free.
///
/// Lock order: this one first, then server_state or extras, never the reverse.
pub(crate) fn planning_lock() -> std::sync::MutexGuard<'static, ()> {
    static PLANNING: Mutex<()> = Mutex::new(());
    PLANNING.lock().unwrap_or_else(|e| e.into_inner())
}

/// The machine as the next engine sees it: what the running engines hold is
/// taken off the bounds a plan answers to.
///
/// The HARDWARE bound (70 percent of the Mac, the system reserve, the Metal
/// working set) is shared by every engine, so the held bytes come off it, and
/// they come off it through `gpu_working_set` because that is the one field
/// engine_budget_bytes takes as a ceiling as is. Folding the installed-RAM
/// bound in first keeps the sum of every engine under BOTH bounds, which is
/// the guarantee that the Metal working set is never oversubscribed.
///
/// The LIVE reading (vm_stat) already excludes whatever an engine has
/// allocated, so what comes off it is only what the engines still loading have
/// NOT yet taken: their plan minus their measured RSS. Subtracting their whole
/// plan counted the resident part twice and refused a teammate that fits.
///
/// `ram_gb` is left alone: it is what `min_ram_gb` gates are written against,
/// a property of the Mac and not of the moment.
pub(crate) fn limits_after(machine: MachineLimits, held: &[HeldEngine]) -> MachineLimits {
    if held.is_empty() {
        return machine;
    }
    let total: u64 = held.iter().map(|h| h.bytes).sum();
    let pending: u64 = held
        .iter()
        .filter(|h| !h.allocated)
        .map(|h| h.bytes.saturating_sub(h.resident))
        .sum();
    let installed = machine.ram_gb * 1_000_000_000;
    let hardware = engine_budget_bytes(installed, MachineLimits { available: None, ..machine });
    MachineLimits {
        ram_gb: machine.ram_gb,
        available: machine.available.map(|a| a.saturating_sub(pending)),
        gpu_working_set: Some(hardware.saturating_sub(total)),
    }
}

/// The refusal a user reads when a teammate does not fit beside the others.
///
/// Names the gigabytes missing and the engines holding memory, the largest
/// first, because "not enough memory" alone leaves a user guessing which of
/// two models to stop.
pub(crate) fn shortfall_message(model_id: &str, needs: u64, left: u64, held: &[HeldEngine]) -> String {
    let mut holders: Vec<&HeldEngine> = held.iter().collect();
    holders.sort_by_key(|h| std::cmp::Reverse(h.bytes));
    let named = holders
        .iter()
        .map(|h| format!("{} ({}) holds {:.1} GB", h.model_id, h.role, h.bytes as f64 / 1e9))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "{model_id} does not fit beside the engines already running: it needs at least {:.1} GB, \
         {:.1} GB are left, short by {:.1} GB. {named}. Stop one of them, or choose a team whose \
         models fit together on this Mac.",
        needs as f64 / 1e9,
        left as f64 / 1e9,
        needs.saturating_sub(left) as f64 / 1e9,
    )
}

/// Plan one engine against what the others leave.
///
/// With nothing else running this IS plan_cache, byte for byte, so the primary
/// alone behaves exactly as it did before teams existed.
///
/// When the plan is refused and other engines are running, the question worth
/// answering is whether the model would have fitted ALONE. If not, plan_cache's
/// own sentence is the right one (the Mac is too small, or too busy). If so,
/// the teammates are the reason, and the refusal says how much they hold.
#[allow(clippy::too_many_arguments)]
pub(crate) fn plan_beside(
    model_id: &str,
    entry: &Value,
    machine: MachineLimits,
    held: &[HeldEngine],
    override_gb: Option<u64>,
    ram_mode: &str,
    cpu_moe: bool,
    slots: u32,
    ctx_per_slot: u32,
) -> Result<CachePlan, String> {
    let left = limits_after(machine, held);
    let refused = match plan_cache(entry, left, override_gb, ram_mode, cpu_moe, slots, ctx_per_slot) {
        Ok(plan) => return Ok(plan),
        Err(e) => e,
    };
    if held.is_empty() {
        return Err(refused);
    }
    // Its smallest footprint on this Mac with nothing else loaded. The live
    // reading is left out: whether the model fits alone is a property of the
    // hardware, and the live shortfall is reported below against `left`.
    let alone = MachineLimits { available: None, ..machine };
    let Ok(smallest) = plan_cache(entry, alone, None, "eco", cpu_moe, slots, ctx_per_slot) else {
        return Err(refused);
    };
    let needs = smallest.decision.resident_bytes;
    let budget_left = engine_budget_bytes(machine.ram_gb * 1_000_000_000, left);
    if needs <= budget_left {
        // Refused for another reason (a cache override too large, say): that
        // reason is the true one.
        return Err(refused);
    }
    Err(shortfall_message(model_id, needs, budget_left, held))
}

/// Resident bytes of a process, from ps. None when it cannot be read.
fn rss_bytes(pid: u32) -> Option<u64> {
    run_capture("ps", &["-o", "rss=", "-p", &pid.to_string()])
        .trim()
        .parse::<u64>()
        .ok()
        .map(|kb| kb * 1024)
}

/// What every running engine holds, except the ones named.
///
/// `skip_primary` is for a primary restart (its memory comes back with the
/// stop); `skip_model` for a teammate start (it is not running yet).
pub(crate) fn held_engines(skip_primary: bool, skip_model: Option<&str>) -> Vec<HeldEngine> {
    // (model, role, planned bytes, pid, allocated), collected under the locks;
    // ps runs outside them, since a UI tick wants the same locks.
    let mut found: Vec<(String, String, u64, Option<u32>, bool)> = Vec::new();
    if !skip_primary {
        let s = server_state().lock().unwrap_or_else(|e| e.into_inner());
        if let (Some(child), Some(id)) = (s.child.as_ref(), s.model_id.as_ref()) {
            let planned = s.footprint.as_ref().map(|f| f.resident_bytes).unwrap_or(0);
            found.push((id.clone(), "primary".into(), planned, Some(child.id()), s.phase == "ready"));
        }
    }
    {
        let map = extras().lock().unwrap_or_else(|e| e.into_inner());
        for (id, e) in map.iter() {
            // A cloud engine holds no memory on this Mac.
            if Some(id.as_str()) == skip_model || e.phase == "failed" || e.kind == "cloud" {
                continue;
            }
            let pid = e.child.as_ref().map(|c| c.id());
            found.push((id.clone(), e.role.clone(), e.footprint_bytes, pid, e.phase == "ready"));
        }
    }
    found
        .into_iter()
        .map(|(model_id, role, planned, pid, allocated)| {
            let resident = pid.and_then(rss_bytes).unwrap_or(0);
            HeldEngine { model_id, role, bytes: planned.max(resident), resident, allocated }
        })
        .collect()
}

/// Every llama-server pid this process started and still owns.
pub(crate) fn live_engine_pids() -> Vec<u32> {
    let mut pids = Vec::new();
    if let Some(s) = SERVER.get() {
        let s = s.lock().unwrap_or_else(|e| e.into_inner());
        pids.extend(s.child.as_ref().map(|c| c.id()));
    }
    if let Some(m) = EXTRAS.get() {
        let m = m.lock().unwrap_or_else(|e| e.into_inner());
        pids.extend(m.values().filter_map(|e| e.child.as_ref().map(|c| c.id())));
    }
    pids
}

/// Every port this process has handed to an engine, bound yet or not.
pub(crate) fn assigned_ports() -> Vec<u16> {
    let mut ports = Vec::new();
    if let Some(s) = SERVER.get() {
        let s = s.lock().unwrap_or_else(|e| e.into_inner());
        if s.port != 0 {
            ports.push(s.port);
        }
    }
    if let Some(m) = EXTRAS.get() {
        let m = m.lock().unwrap_or_else(|e| e.into_inner());
        ports.extend(m.values().map(|e| e.port).filter(|p| *p != 0));
    }
    ports
}

/// The primary, when it is the engine serving `model_id`.
///
/// Read from the phase and not from the child, so a start still in its
/// preflight counts too: asking for a teammate on the model the primary is
/// loading must not load it a second time.
pub(crate) fn primary_info_for(s: &ServerState, model_id: &str) -> Option<EngineInfo> {
    if s.model_id.as_deref() != Some(model_id) || !matches!(s.phase.as_str(), "starting" | "ready") {
        return None;
    }
    Some(primary_info(s))
}

fn primary_info(s: &ServerState) -> EngineInfo {
    EngineInfo {
        model_id: s.model_id.clone().unwrap_or_default(),
        role: "primary".into(),
        port: s.port,
        phase: s.phase.clone(),
        primary: true,
        slots: s.slots,
        ctx_per_slot: s.ctx_per_slot,
        tools_ok: s.tools_ok,
        footprint_bytes: s.footprint.as_ref().map(|f| f.resident_bytes).unwrap_or(0),
        kind: "local".into(),
    }
}

/// What engine_start found, or took.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Claim {
    /// The model is already starting or serving: this is it.
    Existing(EngineInfo),
    /// Nothing was running; a reservation was placed under this generation.
    Reserved,
}

/// Take the slot for `model_id`, or return the engine already in it.
///
/// This is what makes engine_start idempotent. The reservation is placed
/// BEFORE the slow part, so a second call during the minutes a model takes to
/// load finds it and returns it instead of loading the same weights twice. A
/// failed engine is not an answer, so it is replaced.
pub(crate) fn claim(
    map: &mut HashMap<String, ExtraEngine>,
    model_id: &str,
    role: &str,
    generation: u64,
) -> Claim {
    if let Some(e) = map.get(model_id) {
        if matches!(e.phase.as_str(), "starting" | "ready") {
            // The role it was first started for stays: one engine serves every
            // role mapped to its model, and renaming it on each call would make
            // the list flicker between them.
            return Claim::Existing(e.info(model_id));
        }
    }
    map.insert(model_id.to_string(), ExtraEngine::reserved(role, generation));
    Claim::Reserved
}

/// A log file name for one model's engine. Model ids come from the registry,
/// but a file name is built from them, so anything outside a safe charset is
/// flattened rather than trusted.
pub(crate) fn engine_log_name(model_id: &str) -> String {
    let safe: String = model_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect();
    format!("llama-server-{}.log", safe.trim_start_matches('.'))
}

fn emit_engine(app: &AppHandle, model_id: &str, phase: &str, extra: Value) {
    let mut body = json!({"model_id": model_id, "phase": phase});
    if let (Some(b), Some(x)) = (body.as_object_mut(), extra.as_object()) {
        for (k, v) in x {
            b.insert(k.clone(), v.clone());
        }
    }
    let _ = app.emit("galactus://engine", body);
}

/// Start a teammate engine for `model_id`, or return the one already running.
///
/// Returns as soon as the process is spawned, in phase "starting": loading a
/// model takes minutes. The caller polls engines_status (or listens on
/// `galactus://engine`) for "ready" before sending it anything.
#[tauri::command]
pub async fn engine_start(app: AppHandle, model_id: String, role: String) -> Result<EngineInfo, String> {
    // A blocking thread: the start holds the planning lock (a std Mutex)
    // through seconds of preflight, and a cloud start may fetch a price list.
    tauri::async_runtime::spawn_blocking(move || engine_start_blocking(app, model_id, role))
        .await
        .map_err(|e| format!("the engine start thread died: {e}"))?
}

fn engine_start_blocking(app: AppHandle, model_id: String, role: String) -> Result<EngineInfo, String> {
    let model_id = model_id.trim().to_string();
    if model_id.is_empty() {
        return Err("engine_start: no model id".into());
    }
    let role = if role.trim().is_empty() { "teammate".to_string() } else { role.trim().to_string() };
    if model_id.starts_with("cloud:") {
        return start_cloud(app, model_id, role);
    }
    {
        let s = server_state().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(info) = primary_info_for(&s, &model_id) {
            return Ok(info);
        }
    }
    let generation = EXTRA_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let mut map = extras().lock().unwrap_or_else(|e| e.into_inner());
        if let Claim::Existing(info) = claim(&mut map, &model_id, &role, generation) {
            return Ok(info);
        }
    }
    // Every early return below leaves a reservation nobody will ever fill. It
    // is removed on the way out, unless a newer start already replaced it.
    struct Release<'a> {
        model_id: &'a str,
        generation: u64,
        armed: bool,
    }
    impl Drop for Release<'_> {
        fn drop(&mut self) {
            if !self.armed {
                return;
            }
            let mut map = extras().lock().unwrap_or_else(|e| e.into_inner());
            if map.get(self.model_id).is_some_and(|e| e.generation == self.generation) {
                map.remove(self.model_id);
            }
        }
    }
    let mut release = Release { model_id: &model_id, generation, armed: true };

    let root = galactus_root()?;
    let planning = planning_lock();
    let held = held_engines(false, Some(&model_id));
    let launch = prepare_launch(&root, &model_id, None, false, &held)?;
    let port = pick_free_port()?;
    let log_name = engine_log_name(&model_id);
    let log = fresh_engine_log(&log_name)?;
    let mut child = launch
        .command(port, log)?
        .spawn()
        .map_err(|e| format!("spawn llama-server for {model_id}: {e}"))?;
    let info = {
        let mut map = extras().lock().unwrap_or_else(|e| e.into_inner());
        match map.get_mut(&model_id) {
            // Stopped, or superseded, while the preflight ran.
            Some(e) if e.generation == generation => {
                e.port = port;
                e.slots = launch.slots;
                e.ctx_per_slot = launch.ctx_per_slot;
                e.footprint_bytes = launch.plan.decision.resident_bytes;
                e.log_name = log_name.clone();
                e.child = Some(child);
                e.info(&model_id)
            }
            _ => {
                drop(map);
                let _ = child.kill();
                let _ = child.wait();
                return Err("cancelled".into());
            }
        }
    };
    release.armed = false;
    drop(release);
    drop(planning);
    if let Some(pid) = live_pid(&model_id, generation) {
        spawn_engine_watchdog(pid);
    }
    emit_engine(
        &app,
        &model_id,
        "starting",
        json!({"role": role, "port": port, "footprint": launch.plan.decision}),
    );
    watch_extra(app, model_id, generation, port, log_name);
    Ok(info)
}

/// A cloud role: a local OpenAI-compatible proxy instead of a llama-server,
/// in the same table so the orchestrator addresses it like any teammate.
///
/// Refused, with the sentence the user needs, while cloud is off or no key is
/// stored. It is ready at once: there is nothing to load.
fn start_cloud(app: AppHandle, model_id: String, role: String) -> Result<EngineInfo, String> {
    let generation = EXTRA_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let mut map = extras().lock().unwrap_or_else(|e| e.into_inner());
        if let Claim::Existing(info) = claim(&mut map, &model_id, &role, generation) {
            return Ok(info);
        }
        if let Some(e) = map.get_mut(&model_id) {
            e.kind = "cloud".into();
        }
    }
    let unclaim = || {
        let mut map = extras().lock().unwrap_or_else(|e| e.into_inner());
        if map.get(&model_id).is_some_and(|e| e.generation == generation) {
            map.remove(&model_id);
        }
    };
    let (provider, slug, price) = match crate::cloud::preflight(&model_id) {
        Ok(p) => p,
        Err(e) => {
            unclaim();
            return Err(e);
        }
    };
    let stop = Arc::new(AtomicBool::new(false));
    let port = match crate::cloud::spawn_proxy(crate::cloud::app_ctx(app.clone(), &provider, &slug, price), stop.clone()) {
        Ok(p) => p,
        Err(e) => {
            unclaim();
            return Err(e);
        }
    };
    let info = {
        let mut map = extras().lock().unwrap_or_else(|e| e.into_inner());
        match map.get_mut(&model_id) {
            Some(e) if e.generation == generation => {
                e.port = port;
                e.phase = "ready".into();
                e.proxy_stop = Some(stop.clone());
                e.info(&model_id)
            }
            _ => {
                drop(map);
                crate::cloud::stop_proxy(&stop, port);
                return Err("cancelled".into());
            }
        }
    };
    emit_engine(&app, &model_id, "ready", json!({"role": role, "port": port, "kind": "cloud"}));
    Ok(info)
}

fn live_pid(model_id: &str, generation: u64) -> Option<u32> {
    let map = extras().lock().unwrap_or_else(|e| e.into_inner());
    map.get(model_id)
        .filter(|e| e.generation == generation)
        .and_then(|e| e.child.as_ref().map(|c| c.id()))
}

/// Is this start still the current one, and is its process alive?
enum Liveness {
    /// Stopped or superseded: its threads leave without a word.
    Gone,
    /// The process exited on its own: a failed load.
    Died(Option<i32>),
    Alive,
}

fn liveness(model_id: &str, generation: u64) -> Liveness {
    let mut map = extras().lock().unwrap_or_else(|e| e.into_inner());
    let Some(e) = map.get_mut(model_id).filter(|e| e.generation == generation) else {
        return Liveness::Gone;
    };
    let Some(child) = e.child.as_mut() else {
        return Liveness::Gone;
    };
    match child.try_wait() {
        Ok(Some(status)) => {
            e.child = None;
            e.phase = "failed".into();
            Liveness::Died(status.code())
        }
        _ => Liveness::Alive,
    }
}

fn report_death(app: &AppHandle, model_id: &str, code: Option<i32>, log_name: &str) {
    let log = read_log_tail(log_name);
    let tail = log.lines().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
    let kind = classify_engine_failure("", &log);
    emit_engine(app, model_id, "failed", json!({"code": code, "kind": kind, "log": tail}));
}

fn health_ok(port: u16) -> bool {
    Command::new("curl")
        .args(["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "2"])
        .arg(format!("http://127.0.0.1:{port}/health"))
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "200")
        .unwrap_or(false)
}

/// /health goes 200 once the non-expert weights are up, but the real load
/// only happens on the first inference: forced here, so "ready" means ready.
fn warm_up(port: u16) {
    let _ = Command::new("curl")
        .args(["-s", "-o", "/dev/null", "--max-time", "600", "-H", "Content-Type: application/json", "-d"])
        .arg(r#"{"model":"galactus-local","messages":[{"role":"user","content":"ok"}],"max_tokens":4,"stream":false}"#)
        .arg(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .output();
}

/// The teammate's health poller: the primary's, keyed by model and generation.
fn watch_extra(app: AppHandle, model_id: String, generation: u64, port: u16, log_name: String) {
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(900);
        while Instant::now() <= deadline {
            std::thread::sleep(Duration::from_millis(1000));
            match liveness(&model_id, generation) {
                Liveness::Gone => return,
                Liveness::Died(code) => return report_death(&app, &model_id, code, &log_name),
                Liveness::Alive => {}
            }
            if !health_ok(port) {
                continue;
            }
            warm_up(port);
            // A crash during the warmup leaves the child unreaped: asked again.
            match liveness(&model_id, generation) {
                Liveness::Gone => return,
                Liveness::Died(code) => return report_death(&app, &model_id, code, &log_name),
                Liveness::Alive => {}
            }
            {
                let mut map = extras().lock().unwrap_or_else(|e| e.into_inner());
                match map.get_mut(&model_id).filter(|e| e.generation == generation) {
                    Some(e) => e.phase = "ready".into(),
                    None => return,
                }
            }
            emit_engine(&app, &model_id, "ready", json!({"port": port}));
            // After ready, never before: see the primary's poller.
            let verdict = probe_tool_calling(port);
            {
                let mut map = extras().lock().unwrap_or_else(|e| e.into_inner());
                match map.get_mut(&model_id).filter(|e| e.generation == generation) {
                    Some(e) if e.child.is_some() => e.tools_ok = verdict,
                    _ => return,
                }
            }
            emit_engine(&app, &model_id, "ready", json!({"port": port, "tools_ok": verdict}));
            return;
        }
        // Deadline passed: kill the stuck server so the state cannot claim
        // "starting" forever with a process nobody can reach.
        let stuck = {
            let mut map = extras().lock().unwrap_or_else(|e| e.into_inner());
            match map.get_mut(&model_id).filter(|e| e.generation == generation) {
                Some(e) => {
                    e.phase = "failed".into();
                    e.child.take()
                }
                None => return,
            }
        };
        if let Some(mut child) = stuck {
            let _ = child.kill();
            let _ = child.wait();
        }
        emit_engine(&app, &model_id, "timeout", json!({}));
    });
}

/// Stop a teammate engine. Stopping one that is not running is not an error.
///
/// The primary is refused: it is stopped by server_stop, which the rest of the
/// app (the relay, the status poller) is built around.
#[tauri::command]
pub async fn engine_stop(model_id: String) -> Result<(), String> {
    // child.wait() lasts as long as the engine's teardown.
    tauri::async_runtime::spawn_blocking(move || engine_stop_blocking(model_id))
        .await
        .map_err(|e| format!("the engine stop thread died: {e}"))?
}

fn engine_stop_blocking(model_id: String) -> Result<(), String> {
    let taken = {
        let mut map = extras().lock().unwrap_or_else(|e| e.into_inner());
        map.remove(model_id.trim())
    };
    match taken {
        // Out of the lock before the kill: tearing down a large engine is not
        // instant, and engines_status wants the same lock on every UI tick.
        Some(mut e) => {
            if let Some(stop) = e.proxy_stop.take() {
                crate::cloud::stop_proxy(&stop, e.port);
            }
            if let Some(mut child) = e.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            Ok(())
        }
        None => {
            let s = server_state().lock().unwrap_or_else(|e| e.into_inner());
            if primary_info_for(&s, model_id.trim()).is_some() {
                return Err(format!(
                    "{} is the primary engine: it is stopped with server_stop",
                    model_id.trim()
                ));
            }
            Ok(())
        }
    }
}

/// Every engine, the primary first (when there is one), teammates by model id.
#[tauri::command(async)]
pub fn engines_status() -> Vec<EngineInfo> {
    let mut out = Vec::new();
    {
        let s = server_state().lock().unwrap_or_else(|e| e.into_inner());
        if s.model_id.is_some() {
            out.push(primary_info(&s));
        }
    }
    let map = extras().lock().unwrap_or_else(|e| e.into_inner());
    let mut teammates: Vec<EngineInfo> = map.iter().map(|(id, e)| e.info(id)).collect();
    teammates.sort_by(|a, b| a.model_id.cmp(&b.model_id));
    out.extend(teammates);
    out
}

/// Stop every teammate engine and cloud proxy, leaving the primary running.
#[tauri::command]
pub async fn engines_stop_all_extras() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(stop_all)
        .await
        .map_err(|e| format!("the engine stop thread died: {e}"))
}

/// Remove the LOCAL teammate engine for `model_id` from the table, if any.
/// A cloud proxy is left alone: it holds no memory and loads no weights.
pub(crate) fn take_local_extra(map: &mut HashMap<String, ExtraEngine>, model_id: &str) -> Option<ExtraEngine> {
    if map.get(model_id).is_some_and(|e| e.kind == "local") {
        map.remove(model_id)
    } else {
        None
    }
}

/// Stop the teammate engine running `model_id`, before the primary loads the
/// same model. Blocking: waits for the process to go.
pub(crate) fn stop_extra_serving(model_id: &str) {
    let taken = {
        let mut map = extras().lock().unwrap_or_else(|e| e.into_inner());
        take_local_extra(&mut map, model_id)
    };
    if let Some(mut child) = taken.and_then(|mut e| e.child.take()) {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Kill every teammate engine. Called on app exit, beside the primary.
pub(crate) fn stop_all() {
    let children: Vec<Child> = {
        let mut map = extras().lock().unwrap_or_else(|e| e.into_inner());
        map.drain()
            .filter_map(|(_, mut e)| {
                if let Some(stop) = e.proxy_stop.take() {
                    crate::cloud::stop_proxy(&stop, e.port);
                }
                e.child.take()
            })
            .collect()
    };
    for mut child in children {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(test)]
mod budget_tests {
    use super::*;
    use serde_json::json;

    const GB: u64 = 1_000_000_000;

    /// A dense model: the planner's arithmetic is then weights plus a fixed
    /// overhead plus KV, so every figure below can be checked by hand.
    fn dense(gguf_gb: u64) -> Value {
        json!({"id": "coder", "dense": true, "gguf_bytes": gguf_gb * GB})
    }

    fn holder(id: &str, role: &str, gb: u64) -> HeldEngine {
        HeldEngine { model_id: id.into(), role: role.into(), bytes: gb * GB, resident: gb * GB, allocated: true }
    }

    fn plan(entry: &Value, machine: MachineLimits, held: &[HeldEngine]) -> Result<CachePlan, String> {
        plan_beside("coder", entry, machine, held, None, "balanced", false, 1, CTX_PER_SLOT)
    }

    #[test]
    fn with_nothing_else_running_the_plan_is_the_single_engine_plan() {
        // The primary alone must behave exactly as before teams existed.
        let m = MachineLimits::mac(64, None);
        let alone = plan_cache(&dense(20), m, None, "balanced", false, 1, CTX_PER_SLOT).unwrap();
        let beside = plan(&dense(20), m, &[]).unwrap();
        assert_eq!(alone.decision, beside.decision);
        assert_eq!(limits_after(m, &[]), m);
    }

    #[test]
    fn a_second_engine_that_fits_beside_the_first_is_planned() {
        // 64 GB Mac: 44.8 GB of hardware budget. 20 GB held, 24.8 left, and a
        // 10 GB model needs 10 + 2.5 + 0.8 = 13.3.
        let m = MachineLimits::mac(64, None);
        let p = plan(&dense(10), m, &[holder("planner", "primary", 20)]).unwrap();
        assert!(p.decision.budget_bytes <= 25 * GB, "the held bytes came off the budget");
        assert!(p.decision.resident_bytes + 20 * GB <= 45 * GB);
    }

    #[test]
    fn a_second_engine_that_does_not_fit_is_refused_with_the_shortfall_and_the_holder() {
        // Same Mac, 35 GB held: 9.8 GB left for a model that needs 13.3.
        let m = MachineLimits::mac(64, None);
        let err = plan(&dense(10), m, &[holder("qwen38-27b", "primary", 35)]).unwrap_err();
        assert!(err.contains("short by 3.5 GB"), "{err}");
        assert!(err.contains("qwen38-27b (primary) holds 35.0 GB"), "{err}");
        assert!(err.contains("coder does not fit beside"), "{err}");
    }

    #[test]
    fn a_model_too_large_for_the_mac_alone_keeps_the_planner_sentence() {
        // Blaming the teammate would send the user to stop an engine whose
        // absence would change nothing.
        let m = MachineLimits::mac(32, None);
        let err = plan(&dense(40), m, &[holder("planner", "primary", 5)]).unwrap_err();
        assert!(err.starts_with("not enough free memory"), "{err}");
        assert!(!err.contains("planner"), "{err}");
    }

    #[test]
    fn the_metal_working_set_is_shared_not_granted_twice() {
        // 128 GB Mac whose GPU may hold 60 GB. 50 held: 10 left, whatever the
        // 70 percent of installed RAM would allow.
        let m = MachineLimits { ram_gb: 128, available: None, gpu_working_set: Some(60 * GB) };
        let left = limits_after(m, &[holder("a", "planner", 30), holder("b", "coder", 20)]);
        assert_eq!(engine_budget_bytes(128 * GB, left), 10 * GB);
        assert!(plan(&dense(10), m, &[holder("a", "planner", 30), holder("b", "coder", 20)]).is_err());
    }

    #[test]
    fn only_an_engine_still_loading_comes_off_the_live_reading() {
        // A loaded engine is already out of vm_stat's free pages; counting it
        // again would refuse a teammate that fits.
        let m = MachineLimits { ram_gb: 64, available: Some(40 * GB), gpu_working_set: None };
        let loaded = limits_after(m, &[holder("a", "primary", 10)]);
        assert_eq!(loaded.available, Some(40 * GB));
        // Loading, nothing resident yet: its whole plan is still to come out.
        let loading = HeldEngine { allocated: false, resident: 0, ..holder("a", "primary", 10) };
        assert_eq!(limits_after(m, &[loading.clone()]).available, Some(30 * GB));
        // Loading, 6 of its 10 GB already resident: those 6 are already out of
        // vm_stat, so only the 4 still to come are taken off.
        let halfway = HeldEngine { resident: 6 * GB, ..loading };
        assert_eq!(limits_after(m, &[halfway.clone()]).available, Some(36 * GB));
        // The hardware bound still counts the whole plan.
        assert_eq!(limits_after(m, &[halfway]).gpu_working_set, Some(44_800_000_000 - 10 * GB));
    }

    #[test]
    fn the_message_names_the_largest_holder_first() {
        let msg = shortfall_message(
            "x",
            30 * GB,
            10 * GB,
            &[holder("small", "coder", 5), holder("big", "primary", 40)],
        );
        assert!(msg.contains("short by 20.0 GB"), "{msg}");
        let (big, small) = (msg.find("big (primary)").unwrap(), msg.find("small (coder)").unwrap());
        assert!(big < small, "{msg}");
    }
}

#[cfg(test)]
mod idempotence_tests {
    use super::*;

    #[test]
    fn a_second_start_of_the_same_model_returns_the_first() {
        let mut map = HashMap::new();
        assert_eq!(claim(&mut map, "qwen3-coder-next", "coder", 1), Claim::Reserved);
        let Claim::Existing(info) = claim(&mut map, "qwen3-coder-next", "reviewer", 2) else {
            panic!("the model is already starting: it must not be loaded twice");
        };
        assert_eq!(info.phase, "starting");
        assert_eq!(info.role, "coder", "the engine keeps the role it was started for");
        assert!(!info.primary);
        assert_eq!(map.len(), 1);
        assert_eq!(map["qwen3-coder-next"].generation, 1, "the first start stays current");
    }

    #[test]
    fn a_ready_engine_is_returned_with_its_port() {
        let mut map = HashMap::new();
        claim(&mut map, "m", "coder", 1);
        let e = map.get_mut("m").unwrap();
        e.phase = "ready".into();
        e.port = 8741;
        let Claim::Existing(info) = claim(&mut map, "m", "coder", 2) else { panic!() };
        assert_eq!((info.port, info.phase.as_str()), (8741, "ready"));
    }

    #[test]
    fn the_primary_takes_over_a_local_teammate_but_not_a_cloud_one() {
        let mut map = HashMap::new();
        claim(&mut map, "qwen38-27b", "planner", 1);
        claim(&mut map, "cloud:openrouter/x", "expert", 2);
        map.get_mut("cloud:openrouter/x").unwrap().kind = "cloud".into();
        let taken = take_local_extra(&mut map, "qwen38-27b").expect("the teammate is handed over");
        assert_eq!(taken.role, "planner");
        assert!(!map.contains_key("qwen38-27b"), "no longer counted, no longer listed");
        assert!(take_local_extra(&mut map, "cloud:openrouter/x").is_none());
        assert!(take_local_extra(&mut map, "absent").is_none());
        assert_eq!(map.len(), 1);
    }

    #[test]
    fn a_failed_engine_is_replaced_rather_than_returned() {
        let mut map = HashMap::new();
        claim(&mut map, "m", "coder", 1);
        map.get_mut("m").unwrap().phase = "failed".into();
        assert_eq!(claim(&mut map, "m", "coder", 2), Claim::Reserved);
        assert_eq!(map["m"].generation, 2);
        assert_eq!(map["m"].phase, "starting");
    }

    fn primary(model: Option<&str>, phase: &str) -> ServerState {
        ServerState {
            child: None,
            model_id: model.map(str::to_string),
            phase: phase.into(),
            generation: 0,
            port: 8737,
            mode: String::new(),
            slots: 2,
            ctx_per_slot: 8192,
            tools_ok: Some(true),
            footprint: None,
        }
    }

    #[test]
    fn asking_for_the_model_the_primary_serves_returns_the_primary() {
        let info = primary_info_for(&primary(Some("qwen38-27b"), "ready"), "qwen38-27b").unwrap();
        assert!(info.primary);
        assert_eq!((info.port, info.role.as_str()), (8737, "primary"));
        // Still loading counts: it must not be loaded a second time.
        assert!(primary_info_for(&primary(Some("qwen38-27b"), "starting"), "qwen38-27b").is_some());
        // Another model, a failed primary, or none at all: a teammate is due.
        assert!(primary_info_for(&primary(Some("qwen38-27b"), "ready"), "other").is_none());
        assert!(primary_info_for(&primary(Some("qwen38-27b"), "failed"), "qwen38-27b").is_none());
        assert!(primary_info_for(&primary(None, "stopped"), "qwen38-27b").is_none());
    }

    #[test]
    fn engine_logs_do_not_collide_and_cannot_leave_the_folder() {
        assert_eq!(engine_log_name("qwen38-27b"), "llama-server-qwen38-27b.log");
        assert_ne!(engine_log_name("a"), engine_log_name("b"));
        assert!(!engine_log_name("../../etc/x").contains('/'));
        assert_ne!(engine_log_name("x"), "llama-server.log", "the primary's log is its own");
    }

    #[test]
    fn engine_info_serializes_like_server_status() {
        let info = primary_info(&primary(Some("m"), "ready"));
        let v = serde_json::to_value(&info).unwrap();
        for key in ["model_id", "role", "port", "phase", "primary", "slots", "ctx_per_slot", "tools_ok", "footprint_bytes", "kind"] {
            assert!(v.get(key).is_some(), "missing {key}: {v}");
        }
    }
}
