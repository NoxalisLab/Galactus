// Galactus desktop — Rust side.
//
// Everything the frontend cannot or must not do lives here: hardware
// inspection, the model registry, the llama-server lifecycle, the
// download/profile/plan/pack install pipeline, the file/shell tools that sit
// behind the permission gate, the settings store and the MCP stdio clients.

mod knowledge;

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write as IoWrite};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const SERVER_PORT_BASE: u16 = 8737;
const SERVER_PORT_SPAN: u16 = 40;

// ---------------------------------------------------------------- settings

fn settings_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(home).join("Library/Application Support/Galactus/settings.json")
}

fn settings_load() -> HashMap<String, String> {
    std::fs::read_to_string(settings_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn settings_store(map: &HashMap<String, String>) -> Result<(), String> {
    let p = settings_path();
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, serde_json::to_string_pretty(map).unwrap()).map_err(|e| e.to_string())
}

#[tauri::command]
fn settings_get() -> HashMap<String, String> {
    settings_load()
}

#[tauri::command]
fn settings_set(key: String, value: String) -> Result<(), String> {
    let mut map = settings_load();
    map.insert(key, value);
    settings_store(&map)
}

fn galactus_root() -> Result<PathBuf, String> {
    let map = settings_load();
    if let Some(root) = map.get("root").cloned().filter(|s| !s.is_empty()) {
        let p = PathBuf::from(root);
        if p.join("scripts/models-registry.json").exists() {
            return Ok(p);
        }
    }
    // No (valid) checkout configured: run self-contained on the bundled data.
    provision_default_root()
}

/// Bundle Resources dir (packaged app) or src-tauri (dev run).
fn resource_dir() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(res) = exe
            .parent()
            .and_then(|p| p.parent())
            .map(|p| p.join("Resources"))
        {
            if res.join("engine/llama-server").exists() || res.join("packaged").exists() {
                return Some(res);
            }
        }
    }
    let dev = std::env::current_dir().unwrap_or_default().join("src-tauri");
    if dev.join("engine").exists() || dev.join("packaged").exists() {
        return Some(dev);
    }
    None
}

/// The llama-server shipped inside the app bundle (fully relocated: dylibs
/// and OpenSSL travel with it). Returns None when the app was built without
/// an engine (dev builds before prepare-engine.sh).
fn bundled_engine() -> Option<PathBuf> {
    let bin = resource_dir()?.join("engine/llama-server");
    if !bin.is_file() {
        return None;
    }
    // Resource copying does not guarantee the executable bit.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&bin) {
            let mut perm = meta.permissions();
            if perm.mode() & 0o111 == 0 {
                perm.set_mode(0o755);
                let _ = std::fs::set_permissions(&bin, perm);
            }
        }
    }
    Some(bin)
}

/// The isolated Python runtime shipped in the bundle. A virgin macOS has no
/// /usr/bin/python3 (it is a Command Line Tools shim that pops an install
/// dialog): the app must never depend on it.
fn bundled_python() -> Option<PathBuf> {
    let bin = resource_dir()?.join("python/bin/python3");
    if bin.is_file() {
        Some(bin)
    } else {
        None
    }
}

/// A ready-to-use python3 invocation: bundled interpreter in isolated mode
/// (-I: ignores PYTHON* env vars and user site-packages, a local sandbox),
/// falling back to the system python3 for developer checkouts.
fn python3_cmd() -> Command {
    match bundled_python() {
        Some(bin) => {
            let mut c = Command::new(bin);
            c.arg("-I");
            c
        }
        None => Command::new("python3"),
    }
}

/// Self-contained mode: data lives in Application Support/Galactus/data,
/// seeded from the registry and scripts bundled with the app. No checkout,
/// no third-party install: plug and play.
fn provision_default_root() -> Result<PathBuf, String> {
    let root = app_support().join("data");
    let scripts = root.join("scripts");
    std::fs::create_dir_all(&scripts).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(root.join("models")).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(root.join("artifacts/h4/packs")).map_err(|e| e.to_string())?;
    if !scripts.join("models-registry.json").exists() {
        let res = resource_dir()
            .ok_or("Galactus folder is not set and the app bundle carries no packaged data")?;
        let src = res.join("packaged/scripts");
        for f in [
            "models-registry.json",
            "moe-profile.py",
            "galactus-pack-plan.py",
            "galactus-pack-write.py",
        ] {
            std::fs::copy(src.join(f), scripts.join(f)).map_err(|e| format!("seed {f}: {e}"))?;
        }
    }
    Ok(root)
}

// ---------------------------------------------------------------- hardware

#[derive(Serialize, Clone)]
struct HwInfo {
    chip: String,
    cores: u32,
    ram_gb: u64,
    disk_free_gb: u64,
}

fn run_capture(cmd: &str, args: &[&str]) -> String {
    Command::new(cmd)
        .args(args)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

#[tauri::command]
fn hw_info() -> HwInfo {
    let ram: u64 = run_capture("sysctl", &["-n", "hw.memsize"])
        .parse()
        .unwrap_or(0);
    let cores: u32 = run_capture("sysctl", &["-n", "hw.ncpu"]).parse().unwrap_or(0);
    let chip = run_capture("sysctl", &["-n", "machdep.cpu.brand_string"]);
    let base = galactus_root()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/".into());
    let df = run_capture("df", &["-g", &base]);
    let disk_free_gb: u64 = df
        .lines()
        .nth(1)
        .and_then(|l| l.split_whitespace().nth(3))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    HwInfo {
        chip,
        cores,
        // hw.memsize is a power of two: a "128 GB" Mac is 128 GiB. Dividing by
        // 1e9 would report 137 and defeat every min_ram_gb gate.
        ram_gb: ram >> 30,
        disk_free_gb,
    }
}

// ---------------------------------------------------------------- registry

fn find_gguf(dir: &Path) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|e| e == "gguf").unwrap_or(false))
        .collect();
    candidates.sort();
    // Multi-shard models: the 00001 shard is the one llama.cpp opens.
    candidates.into_iter().next()
}

fn model_paths(root: &Path, id: &str) -> (PathBuf, PathBuf, PathBuf) {
    let model_dir = root.join("models").join(id);
    let pack = root
        .join("artifacts/h4/packs")
        .join(id)
        .join(format!("{id}.pack"));
    let profile = model_dir.join("profile.engine.txt");
    (model_dir, pack, profile)
}

#[tauri::command]
fn load_registry() -> Result<Vec<Value>, String> {
    let root = galactus_root()?;
    let raw = std::fs::read_to_string(root.join("scripts/models-registry.json"))
        .map_err(|e| e.to_string())?;
    let parsed: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let models = parsed["models"].as_array().cloned().unwrap_or_default();
    let mut out = Vec::new();
    for mut m in models {
        let id = m["id"].as_str().unwrap_or("").to_string();
        let (model_dir, pack, _profile) = model_paths(&root, &id);
        let gguf_present = find_gguf(&model_dir).is_some();
        let pack_present = pack.exists();
        m["gguf_present"] = json!(gguf_present);
        m["pack_present"] = json!(pack_present);
        m["installed"] = json!(gguf_present && pack_present);
        out.push(m);
    }
    Ok(out)
}

fn registry_entry(root: &Path, id: &str) -> Result<Value, String> {
    let raw = std::fs::read_to_string(root.join("scripts/models-registry.json"))
        .map_err(|e| e.to_string())?;
    let parsed: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    parsed["models"]
        .as_array()
        .and_then(|a| a.iter().find(|m| m["id"] == id).cloned())
        .ok_or_else(|| format!("unknown model {id}"))
}

// ---------------------------------------------------------------- server

struct ServerState {
    child: Option<Child>,
    model_id: Option<String>,
    phase: String, // stopped | starting | ready | failed
    generation: u64,
    /// Port actually bound by the running server (0 when stopped).
    port: u16,
    /// Engine regime: resident-metal | streamed-metal | cpu-bit-exact.
    mode: String,
}

static SERVER: OnceLock<Mutex<ServerState>> = OnceLock::new();
static SERVER_GEN: AtomicU64 = AtomicU64::new(0);

fn server_state() -> &'static Mutex<ServerState> {
    SERVER.get_or_init(|| {
        Mutex::new(ServerState {
            child: None,
            model_id: None,
            phase: "stopped".into(),
            generation: 0,
            port: 0,
            mode: String::new(),
        })
    })
}

#[derive(Serialize, Clone)]
struct ServerStatus {
    running: bool,
    model_id: Option<String>,
    port: u16,
    phase: String,
    mode: String,
}

#[tauri::command]
fn server_status() -> ServerStatus {
    let s = server_state().lock().unwrap_or_else(|e| e.into_inner());
    ServerStatus {
        running: s.child.is_some(),
        model_id: s.model_id.clone(),
        port: if s.port == 0 { SERVER_PORT_BASE } else { s.port },
        phase: s.phase.clone(),
        mode: s.mode.clone(),
    }
}

/// Cache sizing: RAM minus non-expert weights minus a system margin, capped at
/// 70% of RAM and at full expert residency. The SLRU protected fraction is
/// then chosen as the largest of 0.75/0.50/0.25 whose probation segment can
/// hold one token's distinct experts (micro-batch 1).
fn plan_cache(entry: &Value, ram_gb: u64, override_gb: Option<u64>) -> Result<(u64, f64, u32), String> {
    let non_expert = entry["non_expert_bytes"].as_u64().unwrap_or(5_000_000_000);
    let expert_total = entry["expert_bytes_total"].as_u64().unwrap_or(u64::MAX);
    let layers = entry["layers_moe"].as_u64().unwrap_or(1).max(1);
    let record = entry["record_bytes"].as_u64().unwrap_or(1).max(1);
    let used = entry["experts_used"].as_u64().unwrap_or(8).max(1);
    let experts = entry["experts"].as_u64().unwrap_or(256).max(1);

    let ram = ram_gb * 1_000_000_000;
    let mut cache = match override_gb {
        Some(gb) => gb * 1_000_000_000,
        None => ram
            .saturating_sub(non_expert + 4_500_000_000)
            .min(ram * 7 / 10),
    };
    cache = cache.min(expert_total);

    let quota = ((cache / (layers * record)).min(experts)) as u64;
    if quota < 2 {
        return Err("machine too small for this model (quota < 2)".into());
    }
    for f in [0.75f64, 0.50, 0.25] {
        let mut protected = (quota as f64 * f) as u64;
        protected = protected.clamp(1, quota - 1);
        let probation = quota - protected;
        if probation >= used {
            // Largest physical micro-batch whose distinct experts still fit in
            // the probation segment: probation / experts_used, capped at 8 so
            // prompt processing stays fast without risking the fail-closed
            // guard. This is what makes cold starts feel quick.
            let ubatch = ((probation / used).max(1)).min(8) as u32;
            return Ok((cache, f, ubatch));
        }
    }
    Err("machine too small for this model (probation < active experts)".into())
}

/// Pick a port we can actually bind. A crashed run can leave an orphan holding
/// the previous one, and other software may squat it too — so instead of
/// fighting for a fixed port we scan a small range and take the first free
/// slot. Orphaned llama-servers of ours are reaped along the way.
/// Reap only servers WE left behind: a llama-server whose command line points
/// at the configured Galactus folder. A llama-server the user started by hand
/// elsewhere is never touched. Purely a memory courtesy — the dynamic port
/// already removes any bind conflict.
fn reap_orphan_servers(root: &Path) {
    let root_str = root.to_string_lossy().into_owned();
    let out = Command::new("pgrep").args(["-f", "llama-server"]).output();
    let pids: Vec<i32> = out
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(|l| l.trim().parse().ok())
                .collect()
        })
        .unwrap_or_default();
    let me = std::process::id() as i32;
    for pid in pids {
        if pid == me {
            continue;
        }
        let args = run_capture("ps", &["-p", &pid.to_string(), "-o", "command="]);
        if args.contains("llama-server") && args.contains(&root_str) {
            let _ = Command::new("kill").arg("-9").arg(pid.to_string()).status();
        }
    }
}

fn pick_free_port() -> Result<u16, String> {
    use std::net::TcpListener;
    for offset in 0..SERVER_PORT_SPAN {
        let port = SERVER_PORT_BASE + offset;
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(l) => {
                drop(l); // released immediately; llama-server takes it next
                return Ok(port);
            }
            Err(_) => continue,
        }
    }
    Err(format!(
        "no free port in {}..{}",
        SERVER_PORT_BASE,
        SERVER_PORT_BASE + SERVER_PORT_SPAN
    ))
}

#[tauri::command]
fn server_start(app: AppHandle, model_id: String, cache_gb: Option<u64>) -> Result<(), String> {
    server_stop()?;
    let root = galactus_root()?;
    reap_orphan_servers(&root);
    let port = pick_free_port()?;
    let entry = registry_entry(&root, &model_id)?;
    let (model_dir, pack, profile) = model_paths(&root, &model_id);
    let gguf = find_gguf(&model_dir).ok_or("model GGUF not found")?;
    if !pack.exists() {
        return Err("pack not found — install the model first".into());
    }

    let settings = settings_load();
    let override_gb = cache_gb.or_else(|| {
        settings
            .get("cache_gb")
            .and_then(|s| s.trim().parse::<u64>().ok())
    });
    let ram_gb = hw_info().ram_gb.max(8);
    let (cache_bytes, fraction, ubatch) = plan_cache(&entry, ram_gb, override_gb)?;

    // Engine resolution: a developer checkout build wins (always freshest);
    // otherwise the fully relocated llama-server shipped INSIDE the app
    // bundle is used — no Homebrew, no checkout, plug and play.
    let checkout_bin = root.join("third_party/llama.cpp/build/bin/llama-server");
    let server_bin = if checkout_bin.exists() {
        // A checkout binary must be at least as new as the engine sources,
        // otherwise it runs without the Galactus wiring and dies on startup.
        let engine = root.join("src/h4/h4-expert-store.cpp");
        if let (Ok(bin_meta), Ok(src_meta)) = (std::fs::metadata(&checkout_bin), std::fs::metadata(&engine)) {
            if let (Ok(bin_t), Ok(src_t)) = (bin_meta.modified(), src_meta.modified()) {
                if bin_t < src_t {
                    return Err(
                        "llama-server is older than the Galactus engine. Rebuild it:\n  cmake --build third_party/llama.cpp/build --target llama-server -j"
                            .into(),
                    );
                }
            }
        }
        checkout_bin
    } else if let Some(bundled) = bundled_engine() {
        bundled
    } else {
        return Err("llama-server binary not found — build it: cmake --build third_party/llama.cpp/build --target llama-server -j".into());
    };

    // Keep the server's output so failures are visible instead of hanging.
    let log_path = app_support().join("llama-server.log");
    let _ = std::fs::create_dir_all(app_support());
    let log_out = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let log_err = log_out.try_clone().map_err(|e| e.to_string())?;

    // Engine regime — ALWAYS the H4 wiring, ALWAYS the certified numerics.
    //
    // Certification rule (product law): a certified model runs BIT-EXACT.
    // That is the CPU-experts regime the certification benches validated:
    // the upstream Metal mv_id kernels diverge from CPU truth on iq quants
    // (patch comment, probe v4: 1-2% relative per layer; ppl 8.89 vs 2.67 on
    // GLM at 1.58 bpw), so Metal experts are OPT-IN and explicitly outside
    // the certification envelope ("metal_experts": true in the registry
    // entry, or setting metal_experts=1).
    //
    // The physical micro-batch stays at the planner's guarded value: the
    // certified curves were measured in this envelope, and a different batch
    // shape changes kernel paths and accumulation order — do not trade
    // bit-exactness for prompt speed silently.
    let expert_total = entry["expert_bytes_total"].as_u64().unwrap_or(u64::MAX);
    let full_residency = cache_bytes >= expert_total;
    let metal_experts = entry["metal_experts"].as_bool().unwrap_or(false)
        || settings.get("metal_experts").map(|v| v == "1").unwrap_or(false);
    let cpu_moe = !metal_experts;
    let eff_ubatch: u32 = ubatch;

    let mut cmd = Command::new(&server_bin);
    cmd.env("GALACTUS_H4", "1")
        .env("GALACTUS_PROFILE", &profile)
        .env("GALACTUS_H4_INTERNAL", &pack)
        .env("GALACTUS_H4_EXTERNAL", &pack)
        .env("GALACTUS_H4_CACHE_BYTES", cache_bytes.to_string())
        .env("GALACTUS_H4_PROTECTED", format!("{fraction:.2}"))
        .env("GALACTUS_H4_QD", "32")
        .env("LC_ALL", "C");
    if cpu_moe {
        cmd.env("GALACTUS_H4_CPU_MOE", "1");
    } else {
        // Metal experts run through the bit-exact parity path (patches 0002 +
        // 0003): the Metal mul_mat_id replays the CPU algorithm bit for bit
        // for every expert quant type of the flagged models. Certified
        // numerics AND GPU speed, no trade-off.
        cmd.env("GALACTUS_METAL_BITEXACT", "1");
    }
    cmd.arg("--model")
        .arg(&gguf)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .arg("--ctx-size")
        .arg("8192")
        .arg("--n-gpu-layers")
        .arg("99")
        .arg("--no-repack")
        .arg("--fit")
        .arg("off")
        .arg("--no-mmap");
    if cpu_moe {
        cmd.arg("--n-cpu-moe").arg("99");
    }
    // Logical batch stays normal (the server sizes its output buffers from
    // it — a tiny value asserts in output_reserve). Only the PHYSICAL
    // micro-batch is constrained by the expert-cache probation guard.
    cmd.arg("--batch-size")
        .arg("512")
        .arg("--ubatch-size")
        .arg(eff_ubatch.to_string())
        // One slot: the arena serves a single decode stream.
        .arg("--parallel")
        .arg("1")
        .arg("--jinja")
        .stdout(Stdio::from(log_out))
        .stderr(Stdio::from(log_err));
    let child = cmd.spawn().map_err(|e| format!("spawn llama-server: {e}"))?;

    // Watchdog: the engine must die WITH the app in every death mode (crash,
    // force quit, kill -9), not only on the clean RunEvent::Exit path. A tiny
    // detached shell outlives us, watches our PID, and kills the server when
    // we are gone. It verifies the command name first so PID reuse can never
    // make it kill an unrelated process.
    {
        let app_pid = std::process::id();
        let srv_pid = child.id();
        let _ = Command::new("/bin/zsh")
            .arg("-c")
            .arg(format!(
                "while kill -0 {app_pid} 2>/dev/null; do sleep 3; done; \
                 if ps -p {srv_pid} -o comm= 2>/dev/null | grep -q llama-server; then \
                   kill {srv_pid} 2>/dev/null; sleep 2; kill -9 {srv_pid} 2>/dev/null; fi"
            ))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }

    let generation = SERVER_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let mut s = server_state().lock().unwrap_or_else(|e| e.into_inner());
        s.child = Some(child);
        s.model_id = Some(model_id.clone());
        s.mode = if metal_experts {
            "metal-bitexact".into()
        } else if full_residency {
            "resident-bit-exact".into()
        } else {
            "streamed-bit-exact".into()
        };
        s.phase = "starting".into();
        s.generation = generation;
        s.port = port;
    }
    let _ = app.emit("galactus://server", json!({"phase": "starting"}));

    // Health poller: big models can take minutes to warm the arena. It also
    // watches for the process dying, so a broken server surfaces its error
    // instead of leaving the UI on "starting" forever.
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(900);
        loop {
            if Instant::now() > deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(1000));
            {
                let mut s = server_state().lock().unwrap_or_else(|e| e.into_inner());
                if s.generation != generation || s.child.is_none() {
                    return;
                }
                // Did it exit already? Then it failed to load.
                if let Some(child) = s.child.as_mut() {
                    if let Ok(Some(status)) = child.try_wait() {
                        let tail = std::fs::read_to_string(app_support().join("llama-server.log"))
                            .map(|t| {
                                t.lines()
                                    .rev()
                                    .take(12)
                                    .collect::<Vec<_>>()
                                    .into_iter()
                                    .rev()
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            })
                            .unwrap_or_default();
                        s.child = None;
                        s.phase = "failed".into();
                        drop(s);
                        let _ = app.emit(
                            "galactus://server",
                            json!({"phase": "failed",
                                   "code": status.code(),
                                   "log": tail}),
                        );
                        return;
                    }
                }
            }
            let ok = Command::new("curl")
                .args([
                    "-s",
                    "-o",
                    "/dev/null",
                    "-w",
                    "%{http_code}",
                    "--max-time",
                    "2",
                    &format!("http://127.0.0.1:{port}/health"),
                ])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "200")
                .unwrap_or(false);
            if ok {
                let mut s = server_state().lock().unwrap_or_else(|e| e.into_inner());
                if s.generation == generation {
                    s.phase = "ready".into();
                }
                drop(s);
                let _ = app.emit("galactus://server", json!({"phase": "ready"}));
                return;
            }
        }
        // Deadline passed: kill the stuck server so the state cannot claim
        // "starting" forever with a process nobody can reach.
        {
            let mut s = server_state().lock().unwrap_or_else(|e| e.into_inner());
            if s.generation == generation {
                if let Some(mut child) = s.child.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                s.phase = "failed".into();
            }
        }
        let _ = app.emit("galactus://server", json!({"phase": "timeout"}));
    });
    Ok(())
}

#[tauri::command]
fn server_stop() -> Result<(), String> {
    let mut s = server_state().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut child) = s.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    s.model_id = None;
    s.mode = String::new();
    s.phase = "stopped".into();
    s.port = 0;
    Ok(())
}

// ---------------------------------------------------------------- install

static INSTALL_CANCEL: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn install_cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    INSTALL_CANCEL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn emit_progress(app: &AppHandle, id: &str, phase: &str, pct: f64, label: &str, done: bool) {
    let _ = app.emit(
        "galactus://install-progress",
        json!({"model_id": id, "phase": phase, "pct": pct, "label": label, "done": done}),
    );
}

#[tauri::command]
fn cancel_install(model_id: String) {
    if let Some(flag) = install_cancels().lock().unwrap_or_else(|e| e.into_inner()).get(&model_id) {
        flag.store(true, Ordering::SeqCst);
    }
}

#[tauri::command]
fn install_model(app: AppHandle, model_id: String) -> Result<(), String> {
    let root = galactus_root()?;
    let entry = registry_entry(&root, &model_id)?;
    let download = entry["download"].clone();
    let base = download["base"]
        .as_str()
        .ok_or("no download URL registered for this model")?
        .to_string();
    let files: Vec<String> = download["files"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    if files.is_empty() {
        return Err("no download files registered for this model".into());
    }
    let total_bytes = entry["gguf_bytes"].as_u64().unwrap_or(0);

    // Registry file names end up in `curl -o <models/<id>/<f>>`: refuse
    // anything that could escape the model directory.
    for f in &files {
        if f.starts_with('/') || f.split('/').any(|c| c == "..") {
            return Err(format!("invalid file name in registry: {f}"));
        }
    }

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut cancels = install_cancels().lock().unwrap_or_else(|e| e.into_inner());
        // A second click must not spawn a second curl racing on the same file.
        if cancels.contains_key(&model_id) {
            return Err("an install is already running for this model".into());
        }
        cancels.insert(model_id.clone(), cancel.clone());
    }

    std::thread::spawn(move || {
        let result = install_pipeline(&app, &root, &model_id, &base, &files, total_bytes, &cancel);
        match result {
            Ok(()) => emit_progress(&app, &model_id, "done", 100.0, "done", true),
            Err(e) => emit_progress(&app, &model_id, "error", 0.0, &e, true),
        }
        install_cancels().lock().unwrap_or_else(|e| e.into_inner()).remove(&model_id);
    });
    Ok(())
}

fn install_pipeline(
    app: &AppHandle,
    root: &Path,
    id: &str,
    base: &str,
    files: &[String],
    total_bytes: u64,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let (model_dir, pack, _profile) = model_paths(root, id);
    std::fs::create_dir_all(&model_dir).map_err(|e| e.to_string())?;

    // 1. Download with resume; progress from on-disk sizes.
    for f in files {
        if cancel.load(Ordering::SeqCst) {
            return Err("cancelled".into());
        }
        let dest = model_dir.join(f);
        let url = format!("{base}/{f}");
        let mut child = Command::new("curl")
            .args(["-L", "-C", "-", "--fail", "--retry", "8", "--retry-delay", "5", "-s", "-o"])
            .arg(&dest)
            .arg(&url)
            .spawn()
            .map_err(|e| format!("curl: {e}"))?;
        loop {
            if cancel.load(Ordering::SeqCst) {
                let _ = child.kill();
                let _ = child.wait();
                return Err("cancelled".into());
            }
            match child.try_wait().map_err(|e| e.to_string())? {
                Some(status) => {
                    if !status.success() {
                        return Err(format!("download failed for {f}"));
                    }
                    break;
                }
                None => {
                    let done: u64 = files
                        .iter()
                        .map(|g| {
                            std::fs::metadata(model_dir.join(g))
                                .map(|m| m.len())
                                .unwrap_or(0)
                        })
                        .sum();
                    let pct = if total_bytes > 0 {
                        (done as f64 / total_bytes as f64 * 60.0).min(60.0)
                    } else {
                        0.0
                    };
                    emit_progress(
                        app,
                        id,
                        "download",
                        pct,
                        &format!("download {:.1}/{:.1} GB", done as f64 / 1e9, total_bytes as f64 / 1e9),
                        false,
                    );
                    std::thread::sleep(Duration::from_secs(2));
                }
            }
        }
    }

    // 2. Profile.
    emit_progress(app, id, "profile", 62.0, "profiling", false);
    let out = python3_cmd()
        .current_dir(root)
        .args([
            "scripts/moe-profile.py",
            "--model-directory",
            &format!("models/{id}"),
            "--output",
            &format!("models/{id}/profile.json"),
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("profile: {}", String::from_utf8_lossy(&out.stderr)));
    }

    // 3. Plan.
    emit_progress(app, id, "plan", 65.0, "planning", false);
    let out = python3_cmd()
        .current_dir(root)
        .args([
            "scripts/galactus-pack-plan.py",
            "--profile",
            &format!("models/{id}/profile.json"),
            "--output",
            &format!("models/{id}/plan.json"),
            "--volumes",
            "single",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("plan: {}", String::from_utf8_lossy(&out.stderr)));
    }

    // 4. Pack (fixture check happens inside the writer for full mode via sha
    //    confirmation derived from the plan hash).
    let sha_out = Command::new("shasum")
        .current_dir(root)
        .args(["-a", "256", &format!("models/{id}/plan.json")])
        .output()
        .map_err(|e| e.to_string())?;
    let sha = String::from_utf8_lossy(&sha_out.stdout)
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string();
    if sha.len() < 12 {
        return Err("plan sha unavailable".into());
    }
    std::fs::create_dir_all(pack.parent().unwrap()).map_err(|e| e.to_string())?;

    emit_progress(app, id, "pack", 68.0, "building pack", false);
    let mut child = python3_cmd()
        .current_dir(root)
        .args([
            "scripts/galactus-pack-write.py",
            "--plan",
            &format!("models/{id}/plan.json"),
            "--expected-plan-sha256",
            &sha,
            "--model-directory",
            &format!("models/{id}"),
            "--mode",
            "full",
            "--internal-output",
        ])
        .arg(&pack)
        .arg("--manifest")
        .arg(pack.parent().unwrap().join("manifest.json"))
        .args(["--minimum-free-after-gib", "20", "--confirm"])
        .arg(format!("WRITE-{}", &sha[..12]))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    // stderr must be drained too: tqdm/warnings alone can fill the pipe and
    // freeze the writer (and this thread) forever.
    let err_h = drain_pipe(child.stderr.take());
    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        for line in reader.lines().flatten() {
            if cancel.load(Ordering::SeqCst) {
                let _ = child.kill();
                let _ = child.wait();
                return Err("cancelled".into());
            }
            // "  500/12032 enregistrements, ..." → progress 68..99
            if let Some((a, rest)) = line.trim().split_once('/') {
                if let (Ok(done), Some((total, _))) = (
                    a.trim().parse::<f64>(),
                    rest.split_once(' ').map(|(t, r)| (t.trim_end_matches(',').parse::<f64>().unwrap_or(0.0), r)),
                ) {
                    if total > 0.0 {
                        let pct = 68.0 + (done / total) * 31.0;
                        emit_progress(app, id, "pack", pct, &format!("pack {done:.0}/{total:.0}"), false);
                    }
                }
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let err_tail = String::from_utf8_lossy(&err_h.join().unwrap_or_default())
        .lines()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(" | ");
    if !status.success() {
        return Err(if err_tail.trim().is_empty() {
            "pack writer failed".into()
        } else {
            format!("pack writer failed: {err_tail}")
        });
    }
    Ok(())
}

// ---------------------------------------------------------------- tools

const TOOL_MAX_OUTPUT: usize = 200_000;

/// Drain a child pipe on a background thread. A pipe left undrained blocks the
/// child as soon as the ~64 KB kernel buffer fills, which turns any chatty
/// process into a fake "timeout".
fn drain_pipe<R: std::io::Read + Send + 'static>(r: Option<R>) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut r) = r {
            let _ = r.read_to_end(&mut buf);
        }
        buf
    })
}

struct ChildOutput {
    /// None means the deadline passed: the child was killed and reaped.
    status: Option<std::process::ExitStatus>,
    stdout: String,
    stderr: String,
}

/// Wait for a child until `deadline`, draining both pipes concurrently.
fn run_with_deadline(mut child: Child, deadline: Instant) -> Result<ChildOutput, String> {
    let out_h = drain_pipe(child.stdout.take());
    let err_h = drain_pipe(child.stderr.take());
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(s) => break Some(s),
            None => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(120));
            }
        }
    };
    let stdout = String::from_utf8_lossy(&out_h.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&err_h.join().unwrap_or_default()).into_owned();
    Ok(ChildOutput { status, stdout, stderr })
}

/// Largest index <= `max` that falls on a UTF-8 char boundary of `s`.
/// Slicing/truncating at an arbitrary byte offset panics on multi-byte
/// characters (French output makes that a near-certainty).
fn floor_char_boundary(s: &str, max: usize) -> usize {
    if max >= s.len() {
        return s.len();
    }
    let mut i = max;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

#[tauri::command]
fn tool_fs_read(path: String, max_bytes: usize, offset: Option<u64>) -> Result<String, String> {
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    let start = (offset.unwrap_or(0) as usize).min(data.len());
    let cap = max_bytes.min(TOOL_MAX_OUTPUT);
    let end = (start + cap).min(data.len());
    let mut text = String::from_utf8_lossy(&data[start..end]).into_owned();
    if start > 0 {
        text = format!("…(from byte {start})\n{text}");
    }
    if end < data.len() {
        text.push_str(&format!(
            "\n…(truncated at byte {end} of {} — read further with offset={end})",
            data.len()
        ));
    }
    Ok(text)
}

/// Fetch a URL for the agent (curl under the hood: TLS and redirects handled
/// by the system tool, nothing new to bundle). Output is capped like every
/// tool; the permission gate on the frontend shows the exact URL.
#[tauri::command]
fn tool_web_fetch(url: String, max_bytes: Option<usize>) -> Result<String, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) URLs are allowed".into());
    }
    let child = Command::new("curl")
        .args([
            "-sL",
            "--max-time",
            "45",
            "--max-filesize",
            "5000000",
            "-A",
            "Galactus/0.1 (macOS; local assistant)",
        ])
        .arg(&url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let out = run_with_deadline(child, Instant::now() + Duration::from_secs(50))?;
    let Some(status) = out.status else {
        return Err("fetch timed out".into());
    };
    if !status.success() {
        let err = out.stderr.trim().to_string();
        return Err(if err.is_empty() { format!("fetch failed (curl exit {})", status.code().unwrap_or(-1)) } else { err });
    }
    let cap = max_bytes.unwrap_or(TOOL_MAX_OUTPUT).min(TOOL_MAX_OUTPUT);
    let mut text = out.stdout;
    if text.len() > cap {
        text.truncate(floor_char_boundary(&text, cap));
        text.push_str("\n…(truncated)");
    }
    Ok(text)
}

/// Internal spill area for oversized tool outputs and sub-agent transcripts.
/// The agent can READ these (tool_fs_read) but cannot overwrite them: the
/// whole Application Support folder is refused by tool_fs_write.
#[tauri::command]
fn scratch_write(name: String, content: String) -> Result<String, String> {
    if name.is_empty() || name.contains("..") || name.contains('/') || name.starts_with('.') {
        return Err("invalid scratch name".into());
    }
    let dir = app_support().join("scratch");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = dir.join(name);
    std::fs::write(&p, content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(p.display().to_string())
}

#[derive(Serialize, Clone)]
struct DiffResult {
    path: String,
    before: String,
    after: String,
    added: usize,
    removed: usize,
    existed: bool,
}

/// Unified-ish diff summary between two texts: counts of added/removed lines.
fn diff_counts(before: &str, after: &str) -> (usize, usize) {
    let b: Vec<&str> = before.lines().collect();
    let a: Vec<&str> = after.lines().collect();
    // Longest common subsequence on lines (bounded to keep it cheap).
    if b.len() * a.len() > 4_000_000 {
        return (a.len(), b.len());
    }
    let mut dp = vec![vec![0usize; a.len() + 1]; b.len() + 1];
    for i in (0..b.len()).rev() {
        for j in (0..a.len()).rev() {
            dp[i][j] = if b[i] == a[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }
    let common = dp[0][0];
    (a.len() - common, b.len() - common)
}

/// Preview a write without touching the disk: returns before/after and the
/// line deltas so the UI can show a Cursor-style diff before approval.
#[tauri::command]
fn tool_fs_preview(path: String, content: String) -> Result<DiffResult, String> {
    let existed = Path::new(&path).is_file();
    let before = if existed {
        std::fs::read_to_string(&path).unwrap_or_default()
    } else {
        String::new()
    };
    let (added, removed) = diff_counts(&before, &content);
    Ok(DiffResult { path, before, after: content, added, removed, existed })
}

/// Backup file name for a path: FNV-1a hash prefix (collision-proof between
/// `/a/b` and `/a_b`) plus a readable tail, capped well under NAME_MAX.
fn backup_name(path: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in path.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    let stamp = path.replace('/', "_");
    let tail: String = stamp
        .chars()
        .rev()
        .take(120)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("{h:016x}-{tail}.bak")
}

/// The agent must not be able to rewrite the app's own configuration
/// (settings.json holds the MCP server commands and standing permissions:
/// writing it grants arbitrary command execution on the next reload).
fn is_protected_write(path: &str) -> bool {
    Path::new(path).starts_with(app_support())
}

#[tauri::command]
fn tool_fs_write(path: String, content: String) -> Result<String, String> {
    if is_protected_write(&path) {
        return Err("refusing to write inside the Galactus configuration folder".into());
    }
    if let Some(dir) = Path::new(&path).parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Keep a one-step backup so a bad edit can be reverted from the UI.
    if Path::new(&path).is_file() {
        let backups = app_support().join("backups");
        let _ = std::fs::create_dir_all(&backups);
        let _ = std::fs::copy(&path, backups.join(backup_name(&path)));
    }
    std::fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(format!("wrote {} bytes to {}", content.len(), path))
}

/// Restore the last backup taken for a path (the "undo" of an edit).
#[tauri::command]
fn tool_fs_revert(path: String) -> Result<String, String> {
    if is_protected_write(&path) {
        return Err("refusing to write inside the Galactus configuration folder".into());
    }
    let bak = app_support().join("backups").join(backup_name(&path));
    if !bak.is_file() {
        return Err("no backup for this file".into());
    }
    std::fs::copy(&bak, &path).map_err(|e| e.to_string())?;
    Ok(format!("reverted {path}"))
}

#[tauri::command]
fn tool_fs_list(path: String) -> Result<String, String> {
    let mut lines = Vec::new();
    let entries = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut sorted: Vec<_> = entries.flatten().collect();
    sorted.sort_by_key(|e| e.file_name());
    for e in sorted.iter().take(500) {
        let meta = e.metadata().ok();
        let kind = if meta.as_ref().map(|m| m.is_dir()).unwrap_or(false) { "dir " } else { "file" };
        let size = meta.map(|m| m.len()).unwrap_or(0);
        lines.push(format!("{kind} {size:>12}  {}", e.file_name().to_string_lossy()));
    }
    if sorted.len() > 500 {
        lines.push(format!("…({} entries total)", sorted.len()));
    }
    Ok(lines.join("\n"))
}

#[tauri::command]
fn tool_shell_run(command: String, timeout_secs: u64) -> Result<String, String> {
    let mut cmd = Command::new("/bin/zsh");
    cmd.arg("-lc").arg(&command);
    // The model's shell commands must find python3 even on a Mac without the
    // Command Line Tools: the bundled runtime's bin dir leads the PATH.
    if let Some(py) = bundled_python() {
        if let Some(dir) = py.parent() {
            let path = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into());
            cmd.env("PATH", format!("{}:{}", dir.display(), path));
        }
    }
    let child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(timeout_secs.clamp(1, 600));
    let out = run_with_deadline(child, deadline)?;
    let Some(status) = out.status else {
        return Ok("(timed out)".into());
    };
    let mut text = out.stdout;
    if !out.stderr.trim().is_empty() {
        text.push_str("\n[stderr]\n");
        text.push_str(&out.stderr);
    }
    if text.len() > TOOL_MAX_OUTPUT {
        text.truncate(floor_char_boundary(&text, TOOL_MAX_OUTPUT));
        text.push_str("\n…(truncated)");
    }
    if text.trim().is_empty() {
        text = format!("(exit {})", status.code().unwrap_or(-1));
    }
    Ok(text)
}

// ---------------------------------------------------------------- MCP

struct McpServerProc {
    child: Child,
    stdin: std::process::ChildStdin,
    pending: Arc<Mutex<HashMap<u64, std::sync::mpsc::Sender<Value>>>>,
    next_id: u64,
}

#[derive(Serialize, Clone)]
struct McpToolInfo {
    server: String,
    name: String,
    description: String,
    input_schema: Value,
}

static MCP: OnceLock<Mutex<HashMap<String, McpServerProc>>> = OnceLock::new();
static MCP_TOOLS: OnceLock<Mutex<Vec<McpToolInfo>>> = OnceLock::new();

fn mcp_state() -> &'static Mutex<HashMap<String, McpServerProc>> {
    MCP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn mcp_tools_state() -> &'static Mutex<Vec<McpToolInfo>> {
    MCP_TOOLS.get_or_init(|| Mutex::new(Vec::new()))
}

fn mcp_request(proc_: &mut McpServerProc, method: &str, params: Value) -> Result<Value, String> {
    proc_.next_id += 1;
    let id = proc_.next_id;
    let (tx, rx) = std::sync::mpsc::channel();
    proc_.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(id, tx);
    let msg = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
    writeln!(proc_.stdin, "{}", serde_json::to_string(&msg).unwrap()).map_err(|e| e.to_string())?;
    proc_.stdin.flush().map_err(|e| e.to_string())?;
    let res = rx.recv_timeout(Duration::from_secs(60));
    if res.is_err() {
        // Otherwise the sender leaks in the map, one entry per timeout.
        proc_.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    }
    res.map_err(|_| format!("MCP timeout on {method}"))
}

fn mcp_notify(proc_: &mut McpServerProc, method: &str, params: Value) -> Result<(), String> {
    let msg = json!({"jsonrpc": "2.0", "method": method, "params": params});
    writeln!(proc_.stdin, "{}", serde_json::to_string(&msg).unwrap()).map_err(|e| e.to_string())?;
    proc_.stdin.flush().map_err(|e| e.to_string())
}

#[tauri::command]
fn mcp_reload() -> Result<Vec<McpToolInfo>, String> {
    // Tear down previous servers.
    {
        let mut servers = mcp_state().lock().unwrap_or_else(|e| e.into_inner());
        for (_, mut p) in servers.drain() {
            let _ = p.child.kill();
            let _ = p.child.wait();
        }
    }
    mcp_tools_state().lock().unwrap_or_else(|e| e.into_inner()).clear();

    let settings = settings_load();
    let config: Value = serde_json::from_str(settings.get("mcp").map(|s| s.as_str()).unwrap_or("{}"))
        .map_err(|e| format!("mcp config: {e}"))?;
    let empty = serde_json::Map::new();
    let servers_cfg = config["mcpServers"].as_object().unwrap_or(&empty);

    let mut all_tools = Vec::new();
    for (name, cfg) in servers_cfg {
        let command = cfg["command"].as_str().ok_or(format!("{name}: missing command"))?;
        let args: Vec<String> = cfg["args"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let mut cmd = Command::new(command);
        cmd.args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(env) = cfg["env"].as_object() {
            for (k, v) in env {
                if let Some(val) = v.as_str() {
                    cmd.env(k, val);
                }
            }
        }
        let mut child = cmd.spawn().map_err(|e| format!("{name}: {e}"))?;
        let stdin = child.stdin.take().ok_or(format!("{name}: no stdin"))?;
        let stdout = child.stdout.take().ok_or(format!("{name}: no stdout"))?;
        let pending: Arc<Mutex<HashMap<u64, std::sync::mpsc::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let pending_reader = pending.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if let Some(id) = v["id"].as_u64() {
                        if let Some(tx) = pending_reader.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
                            let _ = tx.send(v);
                        }
                    }
                }
            }
        });

        let mut proc_ = McpServerProc { child, stdin, pending, next_id: 0 };
        let init_seq = (|| -> Result<Value, String> {
            mcp_request(
                &mut proc_,
                "initialize",
                json!({
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "galactus", "version": "0.1.0"}
                }),
            )?;
            mcp_notify(&mut proc_, "notifications/initialized", json!({}))?;
            mcp_request(&mut proc_, "tools/list", json!({}))
        })();
        let tools = match init_seq {
            Ok(t) => t,
            Err(e) => {
                // A server that failed to initialize must not linger as an
                // orphan process behind the error.
                let _ = proc_.child.kill();
                let _ = proc_.child.wait();
                return Err(format!("{name}: {e}"));
            }
        };
        if let Some(list) = tools["result"]["tools"].as_array() {
            for tl in list {
                all_tools.push(McpToolInfo {
                    server: name.clone(),
                    name: tl["name"].as_str().unwrap_or("").to_string(),
                    description: tl["description"].as_str().unwrap_or("").to_string(),
                    input_schema: tl["inputSchema"].clone(),
                });
            }
        }
        mcp_state().lock().unwrap_or_else(|e| e.into_inner()).insert(name.clone(), proc_);
    }
    *mcp_tools_state().lock().unwrap_or_else(|e| e.into_inner()) = all_tools.clone();
    Ok(all_tools)
}

#[tauri::command]
fn mcp_tools() -> Vec<McpToolInfo> {
    mcp_tools_state().lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[tauri::command]
fn mcp_call(server: String, tool: String, args: String) -> Result<String, String> {
    let parsed: Value = serde_json::from_str(&args).unwrap_or(json!({}));
    let mut servers = mcp_state().lock().unwrap_or_else(|e| e.into_inner());
    let proc_ = servers.get_mut(&server).ok_or(format!("MCP server {server} not running"))?;
    let response = mcp_request(proc_, "tools/call", json!({"name": tool, "arguments": parsed}))?;
    if let Some(err) = response.get("error") {
        return Err(err["message"].as_str().unwrap_or("MCP error").to_string());
    }
    // Concatenate text content blocks; pass through anything else as JSON.
    let content = &response["result"]["content"];
    if let Some(blocks) = content.as_array() {
        let texts: Vec<String> = blocks
            .iter()
            .filter_map(|b| b["text"].as_str().map(String::from))
            .collect();
        if !texts.is_empty() {
            return Ok(texts.join("\n"));
        }
    }
    Ok(response["result"].to_string())
}

// ---------------------------------------------------------------- folder detect + picker

fn is_root(p: &Path) -> bool {
    p.join("scripts/models-registry.json").is_file()
}

fn run_with_timeout(cmd: &str, args: &[String], secs: u64) -> String {
    let child = Command::new(cmd)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(child) = child else {
        return String::new();
    };
    // The child is killed at the deadline (a `find` over a slow NAS volume must
    // not keep hammering the disk after detection already moved on).
    match run_with_deadline(child, Instant::now() + Duration::from_secs(secs)) {
        Ok(o) => o.stdout,
        Err(_) => String::new(),
    }
}

fn find_registry(base: &str) -> Option<String> {
    let args: Vec<String> = [
        base, "-maxdepth", "6", "-type", "f", "-name", "models-registry.json", "-path",
        "*/scripts/*",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let out = run_with_timeout("find", &args, 6);
    let line = out.lines().next()?;
    let p = Path::new(line);
    let root = p.parent()?.parent()?;
    if is_root(root) {
        Some(root.display().to_string())
    } else {
        None
    }
}

#[tauri::command]
fn detect_root() -> Option<String> {
    let map = settings_load();
    if let Some(r) = map.get("root") {
        if is_root(Path::new(r)) {
            return Some(r.clone());
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let mut bases = vec![
        home.clone(),
        format!("{home}/Documents"),
        format!("{home}/Developer"),
        format!("{home}/Projects"),
        format!("{home}/Desktop"),
    ];
    if let Ok(rd) = std::fs::read_dir("/Volumes") {
        for e in rd.flatten() {
            bases.push(e.path().display().to_string());
        }
    }
    for base in bases {
        if !Path::new(&base).exists() {
            continue;
        }
        if let Some(root) = find_registry(&base) {
            return Some(root);
        }
    }
    // No checkout anywhere: self-provision from the bundled data so the app
    // works out of the box.
    provision_default_root()
        .ok()
        .map(|p| p.display().to_string())
}

/// Native macOS folder chooser via osascript. Returns None on cancel.
#[tauri::command]
fn pick_folder() -> Result<Option<String>, String> {
    let out = Command::new("osascript")
        .arg("-e")
        .arg("POSIX path of (choose folder with prompt \"Select your Galactus folder\")")
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Ok(None); // user cancelled
    }
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(if p.is_empty() { None } else { Some(p) })
}

// ---------------------------------------------------------------- memory + obsidian

fn app_support() -> PathBuf {
    settings_path().parent().unwrap().to_path_buf()
}

fn workspace_dir() -> Option<PathBuf> {
    settings_load()
        .get("workspace")
        .cloned()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// Memory lives either globally (default) or inside the current workspace at
/// <workspace>/.galactus/memory.md when memory_scope == "workspace".
fn memory_path() -> PathBuf {
    let s = settings_load();
    let workspace_scope = s.get("memory_scope").map(|v| v == "workspace").unwrap_or(false);
    if workspace_scope {
        if let Some(ws) = s.get("workspace").filter(|x| !x.is_empty()) {
            return PathBuf::from(ws).join(".galactus").join("memory.md");
        }
    }
    app_support().join("memory.md")
}

// ---------------------------------------------------------------- skills

#[derive(Serialize, Clone)]
struct SkillInfo {
    name: String,
    description: String,
    path: String,
    scope: String, // "global" | "workspace"
}

/// Copy the skills shipped in the bundle into the global skills folder, so a
/// fresh install starts with a curated set. User-modified or user-deleted
/// skills are left alone (copy only when the skill folder does not exist).
fn seed_bundled_skills() {
    let Some(res) = resource_dir() else { return };
    let src = res.join("packaged/skills");
    let Ok(rd) = std::fs::read_dir(&src) else { return };
    let dest_base = app_support().join("skills");
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let name = e.file_name();
        let dest = dest_base.join(&name);
        if dest.exists() {
            continue;
        }
        let _ = std::fs::create_dir_all(&dest);
        if let Ok(files) = std::fs::read_dir(&p) {
            for f in files.flatten() {
                let _ = std::fs::copy(f.path(), dest.join(f.file_name()));
            }
        }
    }
}

fn skill_search_dirs() -> Vec<(PathBuf, String)> {
    let mut v = vec![(app_support().join("skills"), "global".to_string())];
    if let Some(ws) = workspace_dir() {
        v.push((ws.join(".galactus/skills"), "workspace".to_string()));
        v.push((ws.join(".claude/skills"), "workspace".to_string()));
    }
    v
}

fn parse_frontmatter(md: &str) -> (String, String) {
    let mut name = String::new();
    let mut desc = String::new();
    let mut lines = md.lines();
    if lines.next().map(|l| l.trim() == "---").unwrap_or(false) {
        for l in lines {
            if l.trim() == "---" {
                break;
            }
            if let Some(v) = l.strip_prefix("name:") {
                name = v.trim().trim_matches('"').to_string();
            } else if let Some(v) = l.strip_prefix("description:") {
                desc = v.trim().trim_matches('"').to_string();
            }
        }
    }
    (name, desc)
}

#[tauri::command]
fn skills_list() -> Vec<SkillInfo> {
    let mut out = Vec::new();
    for (dir, scope) in skill_search_dirs() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for e in rd.flatten() {
            let p = e.path();
            let skill_md = if p.is_dir() {
                p.join("SKILL.md")
            } else if p.file_name().map(|n| n == "SKILL.md").unwrap_or(false) {
                p.clone()
            } else {
                continue;
            };
            if !skill_md.is_file() {
                continue;
            }
            if let Ok(md) = std::fs::read_to_string(&skill_md) {
                let (mut name, desc) = parse_frontmatter(&md);
                if name.is_empty() {
                    name = p
                        .file_stem()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_default();
                }
                out.push(SkillInfo {
                    name,
                    description: desc,
                    path: skill_md.display().to_string(),
                    scope: scope.clone(),
                });
            }
        }
    }
    out
}

#[tauri::command]
fn skill_read(name: String) -> Result<String, String> {
    for s in skills_list() {
        if s.name == name {
            return std::fs::read_to_string(&s.path).map_err(|e| e.to_string());
        }
    }
    Err(format!("skill not found: {name}"))
}

#[tauri::command]
fn memory_read() -> String {
    std::fs::read_to_string(memory_path()).unwrap_or_default()
}

#[tauri::command]
fn memory_write(text: String) -> Result<(), String> {
    let p = memory_path();
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, text.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn memory_append(text: String) -> Result<String, String> {
    let mut cur = memory_read();
    if !cur.is_empty() && !cur.ends_with('\n') {
        cur.push('\n');
    }
    cur.push_str("- ");
    cur.push_str(text.trim());
    cur.push('\n');
    memory_write(cur)?;
    Ok("remembered".into())
}

fn vault_dir() -> Result<PathBuf, String> {
    let map = settings_load();
    let v = map
        .get("obsidian_vault")
        .cloned()
        .filter(|s| !s.is_empty())
        .ok_or("no Obsidian vault set")?;
    Ok(PathBuf::from(v))
}

/// Resolve a note path STRICTLY inside the vault. Absolute paths and any
/// `..` component are rejected: accepting them would turn the obsidian tools
/// into arbitrary disk read/write (e.g. `/Users/x/.ssh/id_rsa`).
fn resolve_note(vault: &Path, note: &str) -> Result<PathBuf, String> {
    use std::path::Component;
    let rel = Path::new(note);
    if rel.is_absolute()
        || note.starts_with('~')
        || rel
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err("note path must be relative to the vault (no '..', no absolute path)".into());
    }
    let mut p = vault.join(rel);
    if p.extension().is_none() {
        p.set_extension("md");
    }
    Ok(p)
}

#[tauri::command]
fn obsidian_search(query: String) -> Result<String, String> {
    let vault = vault_dir()?;
    let args: Vec<String> = [
        "-rIn", "-i", "--include=*.md", "-m", "2", "--", &query,
    ]
    .iter()
    .map(|s| s.to_string())
    .chain(std::iter::once(vault.display().to_string()))
    .collect();
    let mut out = run_with_timeout("grep", &args, 8);
    if out.len() > 4000 {
        out.truncate(floor_char_boundary(&out, 4000));
        out.push_str("\n…(truncated)");
    }
    if out.trim().is_empty() {
        return Ok("(no matching notes)".into());
    }
    // Strip the vault prefix for readability.
    Ok(out.replace(&format!("{}/", vault.display()), ""))
}

#[tauri::command]
fn obsidian_read(note: String) -> Result<String, String> {
    let vault = vault_dir()?;
    let p = resolve_note(&vault, &note)?;
    let data = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    Ok(if data.len() > TOOL_MAX_OUTPUT {
        format!(
            "{}\n…(truncated)",
            &data[..floor_char_boundary(&data, TOOL_MAX_OUTPUT)]
        )
    } else {
        data
    })
}

#[tauri::command]
fn obsidian_append(note: String, text: String) -> Result<String, String> {
    let vault = vault_dir()?;
    let p = resolve_note(&vault, &note)?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut cur = std::fs::read_to_string(&p).unwrap_or_default();
    if !cur.is_empty() && !cur.ends_with('\n') {
        cur.push('\n');
    }
    cur.push_str(&text);
    cur.push('\n');
    std::fs::write(&p, cur.as_bytes()).map_err(|e| e.to_string())?;
    Ok(format!("appended to {}", p.display()))
}

// ---------------------------------------------------------------- conversations

fn conv_dir() -> PathBuf {
    app_support().join("conversations")
}

/// Conversations are plain JSON files, one per thread, plus a lightweight
/// index rebuilt from them on demand. Shared context across threads comes from
/// the memory file, which every conversation reads.
#[tauri::command]
fn conv_list() -> Vec<Value> {
    let dir = conv_dir();
    let mut out: Vec<Value> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().map(|x| x != "json").unwrap_or(true) {
                continue;
            }
            if let Ok(txt) = std::fs::read_to_string(&p) {
                if let Ok(v) = serde_json::from_str::<Value>(&txt) {
                    out.push(json!({
                        "id": v["id"].clone(),
                        "title": v["title"].clone(),
                        "created": v["created"].clone(),
                        "updated": v["updated"].clone(),
                        "count": v["items"].as_array().map(|a| a.len()).unwrap_or(0),
                    }));
                }
            }
        }
    }
    out.sort_by(|a, b| {
        b["updated"]
            .as_u64()
            .unwrap_or(0)
            .cmp(&a["updated"].as_u64().unwrap_or(0))
    });
    out
}

#[tauri::command]
fn conv_load(id: String) -> Result<Value, String> {
    let p = conv_dir().join(format!("{}.json", sanitize_id(&id)));
    let txt = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    serde_json::from_str(&txt).map_err(|e| e.to_string())
}

#[tauri::command]
fn conv_save(id: String, data: String) -> Result<(), String> {
    let dir = conv_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = dir.join(format!("{}.json", sanitize_id(&id)));
    std::fs::write(&p, data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn conv_delete(id: String) -> Result<(), String> {
    let p = conv_dir().join(format!("{}.json", sanitize_id(&id)));
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn sanitize_id(id: &str) -> String {
    id.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect()
}

// ---------------------------------------------------------------- documents

/// The Swift helper is compiled once, on first use, into Application Support.
/// It only needs the Command Line Tools, which any machine building llama.cpp
/// already has. Everything it does (PDFKit text, Vision OCR) is offline.
fn doc_helper() -> Result<PathBuf, String> {
    // Precompiled helper shipped in the bundle: works on Macs without the
    // Command Line Tools (no swiftc needed at runtime).
    if let Some(res) = resource_dir() {
        let prebuilt = res.join("packaged/galactus-doc");
        if prebuilt.is_file() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = std::fs::metadata(&prebuilt) {
                    let mut perm = meta.permissions();
                    if perm.mode() & 0o111 == 0 {
                        perm.set_mode(0o755);
                        let _ = std::fs::set_permissions(&prebuilt, perm);
                    }
                }
            }
            return Ok(prebuilt);
        }
    }
    let bin = app_support().join("galactus-doc");
    let src_candidates = [
        std::env::current_dir()
            .unwrap_or_default()
            .join("src-tauri/helpers/galactus-doc.swift"),
        // Packaged app: the helper ships as a bundle resource
        // (Contents/MacOS/<exe> → Contents/Resources/helpers/…).
        std::env::current_exe()
            .ok()
            .and_then(|p| {
                p.parent()
                    .and_then(|d| d.parent())
                    .map(|d| d.join("Resources/helpers/galactus-doc.swift"))
            })
            .unwrap_or_default(),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("helpers/galactus-doc.swift")))
            .unwrap_or_default(),
        galactus_root()
            .map(|r| r.join("app/src-tauri/helpers/galactus-doc.swift"))
            .unwrap_or_default(),
    ];
    let src = src_candidates
        .iter()
        .find(|p| p.is_file())
        .cloned()
        .ok_or("document helper source not found (app/src-tauri/helpers/galactus-doc.swift)")?;

    // Rebuild when the source is newer than the cached binary.
    let stale = match (std::fs::metadata(&bin), std::fs::metadata(&src)) {
        (Ok(b), Ok(s)) => match (b.modified(), s.modified()) {
            (Ok(bt), Ok(st)) => bt < st,
            _ => false,
        },
        _ => true,
    };
    if !bin.is_file() || stale {
        std::fs::create_dir_all(app_support()).map_err(|e| e.to_string())?;
        let out = Command::new("swiftc")
            .args(["-O", "-o"])
            .arg(&bin)
            .arg(&src)
            .output()
            .map_err(|e| format!("swiftc unavailable ({e}). Install Xcode Command Line Tools: xcode-select --install"))?;
        if !out.status.success() {
            return Err(format!(
                "document helper failed to build: {}",
                String::from_utf8_lossy(&out.stderr)
                    .lines()
                    .take(6)
                    .collect::<Vec<_>>()
                    .join(" | ")
            ));
        }
    }
    Ok(bin)
}

fn run_helper(bin: &Path, cmd: &str, path: &str, secs: u64) -> Result<String, String> {
    let child = Command::new(bin)
        .arg(cmd)
        .arg(path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let out = run_with_deadline(child, Instant::now() + Duration::from_secs(secs))?;
    let Some(status) = out.status else {
        return Err("document reading timed out".into());
    };
    if !status.success() {
        return Err(out.stderr.trim().to_string());
    }
    Ok(out.stdout)
}

/// Pull text out of Office files without any dependency: docx/pptx/xlsx are
/// zipped XML, and macOS ships textutil for rtf/doc/html.
fn office_text(path: &str, ext: &str) -> Result<String, String> {
    match ext {
        "rtf" | "doc" | "html" | "htm" | "webarchive" | "odt" => {
            let out = Command::new("textutil")
                .args(["-convert", "txt", "-stdout", path])
                .output()
                .map_err(|e| e.to_string())?;
            if out.status.success() {
                return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
            }
            Err("textutil could not read this file".into())
        }
        "docx" | "pptx" | "xlsx" => {
            // textutil handles docx directly; the others go through Python's
            // stdlib zip/XML reader (no third-party packages).
            if ext == "docx" {
                let out = Command::new("textutil")
                    .args(["-convert", "txt", "-stdout", path])
                    .output()
                    .map_err(|e| e.to_string())?;
                if out.status.success() {
                    let text = String::from_utf8_lossy(&out.stdout).into_owned();
                    if !text.trim().is_empty() {
                        return Ok(text);
                    }
                }
            }
            // NOTE: this is a Rust *raw* string, so `\n`/`\t` reach Python as
            // escape sequences inside its own string literals — never put a
            // literal newline inside the Python quotes (SyntaxError).
            let script = r#"
import sys, zipfile, re
p = sys.argv[1]
parts = []
with zipfile.ZipFile(p) as z:
    names = [n for n in z.namelist() if n.endswith('.xml')]
    order = [n for n in names if 'document' in n or 'slide' in n or 'sharedStrings' in n or 'sheet' in n]
    for n in (order or names):
        try:
            raw = z.read(n).decode('utf-8', 'ignore')
        except Exception:
            continue
        raw = re.sub(r'</w:p>|</a:p>|</row>', '\n', raw)
        raw = re.sub(r'<[^>]+>', ' ', raw)
        raw = re.sub(r'[ \t]+', ' ', raw)
        raw = re.sub(r'\n\s*\n+', '\n', raw)
        t = raw.strip()
        if t:
            parts.append(t)
print('\n\n'.join(parts))
"#;
            let out = python3_cmd()
                .arg("-c")
                .arg(script)
                .arg(path)
                .output()
                .map_err(|e| e.to_string())?;
            if out.status.success() {
                Ok(String::from_utf8_lossy(&out.stdout).into_owned())
            } else {
                Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
            }
        }
        _ => Err("unsupported office format".into()),
    }
}

const DOC_MAX: usize = 400_000;

/// Read any document as text. `mode` is "auto" (text layer, OCR fallback),
/// "ocr" (force OCR) or "text" (text layer only).
#[tauri::command]
fn doc_read(path: String, mode: Option<String>) -> Result<String, String> {
    if !Path::new(&path).is_file() {
        return Err(format!("file not found: {path}"));
    }
    let ext = Path::new(&path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let mode = mode.unwrap_or_else(|| "auto".into());

    let text = match ext.as_str() {
        "txt" | "md" | "markdown" | "csv" | "tsv" | "json" | "log" | "yaml" | "yml" | "xml"
        | "srt" | "vtt" | "ini" | "toml" | "conf" => {
            std::fs::read_to_string(&path).map_err(|e| e.to_string())?
        }
        "pdf" | "png" | "jpg" | "jpeg" | "heic" | "heif" | "tiff" | "tif" | "bmp" | "gif"
        | "webp" => {
            let bin = doc_helper()?;
            let cmd = match mode.as_str() {
                "ocr" => "ocr",
                "text" => "pdftext",
                _ => "auto",
            };
            run_helper(&bin, cmd, &path, 300)?
        }
        "rtf" | "doc" | "docx" | "pptx" | "xlsx" | "html" | "htm" | "odt" | "webarchive" => {
            office_text(&path, &ext)?
        }
        _ => {
            // Unknown extension: try plain text, fall back to OCR if binary.
            match std::fs::read_to_string(&path) {
                Ok(t) => t,
                Err(_) => {
                    let bin = doc_helper()?;
                    run_helper(&bin, "auto", &path, 300)?
                }
            }
        }
    };

    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok("(no text found in this document)".into());
    }
    if trimmed.len() > DOC_MAX {
        let mut cut = trimmed[..floor_char_boundary(trimmed, DOC_MAX)].to_string();
        cut.push_str("\n…(truncated)");
        return Ok(cut);
    }
    Ok(trimmed.to_string())
}

/// Quick capability probe for the UI (is the OCR helper usable?).
#[tauri::command]
fn doc_capabilities() -> Value {
    // The Xcode stub at /usr/bin/swiftc exists even without the Command Line
    // Tools — only a successful exit means the compiler is really usable.
    let swiftc = Command::new("swiftc")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let helper = doc_helper().is_ok();
    json!({ "swiftc": swiftc, "helper": helper })
}

// ---------------------------------------------------------------- voice

struct VoiceState {
    child: Option<Child>,
}

static VOICE: OnceLock<Mutex<VoiceState>> = OnceLock::new();

fn voice_state() -> &'static Mutex<VoiceState> {
    VOICE.get_or_init(|| Mutex::new(VoiceState { child: None }))
}

/// The on-device speech helper (Apple SFSpeechRecognizer): precompiled in the
/// bundle, compiled from source as a dev fallback.
fn voice_helper() -> Result<PathBuf, String> {
    if let Some(res) = resource_dir() {
        let prebuilt = res.join("packaged/galactus-voice");
        if prebuilt.is_file() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = std::fs::metadata(&prebuilt) {
                    let mut perm = meta.permissions();
                    if perm.mode() & 0o111 == 0 {
                        perm.set_mode(0o755);
                        let _ = std::fs::set_permissions(&prebuilt, perm);
                    }
                }
            }
            return Ok(prebuilt);
        }
    }
    let bin = app_support().join("galactus-voice");
    let src = std::env::current_dir()
        .unwrap_or_default()
        .join("src-tauri/helpers/galactus-voice.swift");
    if !src.is_file() {
        return Err("voice helper not available".into());
    }
    if !bin.is_file() {
        std::fs::create_dir_all(app_support()).map_err(|e| e.to_string())?;
        let out = Command::new("swiftc")
            .args(["-O", "-o"])
            .arg(&bin)
            .arg(&src)
            .output()
            .map_err(|e| format!("swiftc unavailable ({e})"))?;
        if !out.status.success() {
            return Err("voice helper failed to build".into());
        }
    }
    Ok(bin)
}

/// Start on-device dictation. Streams `galactus://voice` events:
/// {kind: "partial"|"final"|"error", text}.
#[tauri::command]
fn voice_start(app: AppHandle, locale: Option<String>) -> Result<(), String> {
    let bin = voice_helper()?;
    {
        // One dictation at a time.
        let mut v = voice_state().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut old) = v.child.take() {
            let _ = old.kill();
            let _ = old.wait();
        }
    }
    let mut child = Command::new(&bin)
        .arg("listen")
        .arg("--locale")
        .arg(locale.unwrap_or_else(|| "fr-FR".into()))
        .args(["--max-seconds", "90"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let my_pid = child.id();
    voice_state().lock().unwrap_or_else(|e| e.into_inner()).child = Some(child);

    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut terminal_sent = false;
        for line in reader.lines().flatten() {
            let (kind, text) = if let Some(t) = line.strip_prefix("PARTIAL ") {
                ("partial", t.to_string())
            } else if let Some(t) = line.strip_prefix("FINAL ") {
                ("final", t.to_string())
            } else if let Some(t) = line.strip_prefix("ERROR ") {
                ("error", t.to_string())
            } else {
                continue;
            };
            let _ = app.emit("galactus://voice", json!({"kind": kind, "text": text}));
            if kind != "partial" {
                terminal_sent = true;
                break;
            }
        }
        // The helper can die without a terminal line (killed hard, crash):
        // the UI must still get unstuck.
        if !terminal_sent {
            let _ = app.emit("galactus://voice", json!({"kind": "final", "text": ""}));
        }
        // Reap OUR child only — a fresh dictation may already have replaced
        // it; and never hold the lock across wait().
        let mine = {
            let mut v = voice_state().lock().unwrap_or_else(|e| e.into_inner());
            if v.child.as_ref().map(|c| c.id()) == Some(my_pid) {
                v.child.take()
            } else {
                None
            }
        };
        if let Some(mut c) = mine {
            let _ = c.wait();
        }
    });
    Ok(())
}

/// Graceful stop: SIGTERM lets the helper flush its FINAL line first.
#[tauri::command]
fn voice_stop() {
    let v = voice_state().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(c) = v.child.as_ref() {
        let _ = Command::new("kill").args(["-TERM", &c.id().to_string()]).output();
    }
}

// ---------------------------------------------------------------- text-to-speech

static TTS: OnceLock<Mutex<Option<Child>>> = OnceLock::new();

/// Read text aloud with the system voice (`say`, fully offline). A new call
/// replaces the previous one.
#[tauri::command]
fn tts_speak(text: String) -> Result<(), String> {
    let mut slot = TTS.get_or_init(|| Mutex::new(None)).lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut old) = slot.take() {
        let _ = old.kill();
        let _ = old.wait();
    }
    let clipped: String = text.chars().take(4000).collect();
    let child = Command::new("say")
        .arg("--")
        .arg(clipped)
        .spawn()
        .map_err(|e| e.to_string())?;
    *slot = Some(child);
    Ok(())
}

#[tauri::command]
fn tts_stop() {
    let mut slot = TTS.get_or_init(|| Mutex::new(None)).lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut old) = slot.take() {
        let _ = old.kill();
        let _ = old.wait();
    }
}

// ---------------------------------------------------------------- notifications

/// Native macOS notification. Used when a long task finishes while the window
/// is in the background, and when a model finishes loading.
#[tauri::command]
fn notify(title: String, body: String) -> Result<(), String> {
    // Newlines would break the AppleScript literal (and the failure would be
    // silent since osascript's exit code is not checked).
    let esc = |s: &str| {
        s.replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace(['\n', '\r'], " ")
    };
    let script = format!(
        "display notification \"{}\" with title \"{}\" sound name \"Ping\"",
        esc(&body),
        esc(&title)
    );
    Command::new("osascript")
        .arg("-e")
        .arg(script)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn server_log() -> String {
    std::fs::read_to_string(app_support().join("llama-server.log")).unwrap_or_default()
}

// ---------------------------------------------------------------- entry

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let _ = app.get_webview_window("main");
            seed_bundled_skills();
            Ok(())
        })
        .on_window_event(|window, event| {
            // macOS convention: the red button hides the window, the app
            // lives on in the Dock; ⌘Q is the one that really quits (and
            // takes the engine down through RunEvent::Exit below).
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            hw_info,
            load_registry,
            server_status,
            server_start,
            server_stop,
            install_model,
            cancel_install,
            tool_fs_read,
            tool_web_fetch,
            scratch_write,
            tool_fs_write,
            tool_fs_preview,
            tool_fs_revert,
            tool_fs_list,
            tool_shell_run,
            notify,
            server_log,
            settings_get,
            settings_set,
            mcp_reload,
            mcp_tools,
            mcp_call,
            detect_root,
            pick_folder,
            memory_read,
            memory_write,
            memory_append,
            obsidian_search,
            obsidian_read,
            obsidian_append,
            skills_list,
            skill_read,
            conv_list,
            conv_load,
            conv_save,
            conv_delete,
            doc_read,
            doc_capabilities,
            voice_start,
            voice_stop,
            tts_speak,
            tts_stop,
            knowledge::kb_folders,
            knowledge::kb_set_folders,
            knowledge::kb_reindex,
            knowledge::kb_stats,
            knowledge::kb_search
        ])
        .build(tauri::generate_context!())
        .expect("error while running Galactus")
        .run(|app, event| {
            // Dock click with the window closed must bring it back (macOS
            // keeps the process alive after the red button).
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            // The window closing must take the engine with it: an abandoned
            // llama-server keeps tens of GB of RAM pinned, and every MCP
            // server would linger as an orphan.
            if let tauri::RunEvent::Exit = event {
                if let Ok(mut s) = server_state().lock() {
                    if let Some(mut child) = s.child.take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                    s.phase = "stopped".into();
                    s.port = 0;
                }
                if let Ok(mut servers) = mcp_state().lock() {
                    for (_, mut p) in servers.drain() {
                        let _ = p.child.kill();
                        let _ = p.child.wait();
                    }
                }
                // Voice capture and speech must not outlive the app either.
                if let Ok(mut v) = voice_state().lock() {
                    if let Some(mut c) = v.child.take() {
                        let _ = c.kill();
                        let _ = c.wait();
                    }
                }
                if let Some(t) = TTS.get() {
                    if let Ok(mut slot) = t.lock() {
                        if let Some(mut c) = slot.take() {
                            let _ = c.kill();
                            let _ = c.wait();
                        }
                    }
                }
            }
        });
}
