// Les reglages: un JSON dans Application Support, ecrit par renommage.
//
// Sorti de lib.rs avec sa banniere. Deux choses meritent d'etre lues avant d'y
// toucher. Le fichier contient les commandes des connecteurs MCP et les
// permissions permanentes, donc il est ecrit en 0600 dans un dossier en 0700.
// Et il est ecrit par write-then-rename, parce qu'une ecriture interrompue au
// milieu laisse un fichier tronque et une application qui ne sait plus ou est
// la racine de l'utilisateur.
//
// PROTECTED_SETTINGS nomme les clefs qu'un agent ne peut pas changer seul.

use crate::*;

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
pub(crate) fn settings_root_override() -> &'static Mutex<Option<PathBuf>> {
    static R: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(None))
}

pub(crate) fn settings_path() -> PathBuf {
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

/// settings.json contains connector credentials and standing permissions.
/// Protect the existing installation too, not only files created by this build.
pub(crate) fn harden_settings_permissions() -> Result<(), String> {
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
pub(crate) fn settings_read() -> Result<HashMap<String, String>, String> {
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
pub(crate) fn settings_load() -> HashMap<String, String> {
    settings_read().unwrap_or_default()
}

pub(crate) fn settings_store(map: &HashMap<String, String>) -> Result<(), String> {
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

#[tauri::command]
pub fn settings_get() -> HashMap<String, String> {
    settings_load()
}

/// Settings the webview may not write.
///
/// `mcp` is a list of programs the app spawns, and `root` decides which
/// registry is read and which folder the app trusts. Either one written from
/// the page is arbitrary code execution with no dialog in front of it. The
/// content security policy makes that hard to reach, and this is the layer that
/// makes it pointless: they have their own commands, which validate.
pub(crate) const PROTECTED_SETTINGS: &[&str] = &["mcp", "root"];

#[tauri::command]
pub fn settings_set(key: String, value: String) -> Result<(), String> {
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
pub fn mcp_config_set(config: String) -> Result<(), String> {
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
pub fn root_set(path: String) -> Result<(), String> {
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
