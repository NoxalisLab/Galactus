// Telecharger, profiler, planifier et empaqueter un modele.
//
// Sorti de lib.rs avec sa banniere. La section est un pipeline: elle telecharge
// le GGUF, mesure la geometrie reelle des experts, derive le plan de cache,
// ecrit le ou les packs, et sait annuler proprement a chaque etape.

use crate::*;

static INSTALL_CANCEL: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

/// The pids of the processes an installation is running right now.
///
/// WHY A PID AND NOT THE CANCEL FLAG. The flag is polled every two seconds by
/// the loop that owns the child, which is the right design while the app is
/// alive and useless at the moment it dies: `RunEvent::Exit` sets the flag and
/// the process is gone long before anybody reads it, so `curl` was reparented
/// to launchd and carried on writing two hundred gigabytes with no window and
/// no icon to stop it. A pid can be killed from the exit handler in one call,
/// which is what the engine, the connectors and the image engine already do.
pub(crate) fn install_pids() -> &'static Mutex<Vec<u32>> {
    static P: OnceLock<Mutex<Vec<u32>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(Vec::new()))
}

/// Remembers a live install child and forgets it however the scope ends.
struct InstallChild(u32);

impl InstallChild {
    fn new(pid: u32) -> InstallChild {
        install_pids().lock().unwrap_or_else(|e| e.into_inner()).push(pid);
        InstallChild(pid)
    }
}

impl Drop for InstallChild {
    fn drop(&mut self) {
        let mut live = install_pids().lock().unwrap_or_else(|e| e.into_inner());
        live.retain(|p| *p != self.0);
    }
}

/// Kill whatever an installation is running. Called from the exit handler.
pub(crate) fn kill_install_children() {
    let live: Vec<u32> = install_pids().lock().unwrap_or_else(|e| e.into_inner()).clone();
    for pid in live {
        // SIGKILL rather than SIGTERM: curl catches nothing useful here, the
        // partial file is resumed by `-C -` on the next attempt, and the window
        // is already closing.
        // SAFETY: a plain kill(2) on a pid this process spawned, exactly as
        // mcp_kill_children does. ESRCH on an already dead pid is not an error.
        unsafe { kill(pid as i32, SIG_KILL) };
    }
}

pub(crate) fn install_cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
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
pub async fn delete_model(model_id: String) -> Result<String, String> {
    delete_model_impl(&model_id)
}

pub(crate) fn delete_model_impl(model_id: &str) -> Result<String, String> {
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
pub fn cancel_install(model_id: String) {
    if let Some(flag) = install_cancels().lock().unwrap_or_else(|e| e.into_inner()).get(&model_id) {
        flag.store(true, Ordering::SeqCst);
    }
}

/// Where the user asked the pack(s) to live: one directory for a mono pack,
/// two for the dual (two-SSD) split. `None` keeps the classic default under
/// artifacts/h4/packs/<id>/.
#[derive(Clone)]
pub(crate) struct InstallVolumes {
    internal_dir: PathBuf,
    external_dir: Option<PathBuf>,
}

#[tauri::command]
pub async fn install_model(app: AppHandle, model_id: String, volumes: Option<Value>) -> Result<(), String> {
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

/// Removes a half-written pack when the install does not reach the end.
///
/// A Drop guard rather than cleanup at each exit: the pipeline returns from
/// eight places and a ninth would be added without this. `keep` is set once the
/// pack writer has succeeded, which is the only moment the bytes on disk are
/// worth anything.
struct PackCleanup {
    paths: Vec<PathBuf>,
    keep: bool,
}

impl Drop for PackCleanup {
    fn drop(&mut self) {
        if self.keep {
            return;
        }
        for p in &self.paths {
            // The pack FILE only. Never its folder: with custom placement that
            // folder is somewhere the user picked and may hold other packs.
            let _ = std::fs::remove_file(p);
        }
    }
}

// Eight arguments, one over clippy's threshold, and allowed rather than
// bundled into a struct. The eight are genuinely independent: five say what to
// install and three say how to run it, and the only grouping that would satisfy
// the lint is a struct invented for the lint, built at the single call site and
// destructured here. That is more code and one more place for a field to go
// stale, in exchange for nothing a reader gains.
#[allow(clippy::too_many_arguments)]
pub(crate) fn install_pipeline_with(
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
        let _live = InstallChild::new(child.id());
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

    // A dense model stops here, with the weights on disk and nothing else to do.
    //
    // Everything below exists to take a Mixture-of-Experts checkpoint apart: the
    // volume probe decides which SSD each expert record lands on, moe-profile.py
    // reads the expert tensors, and the writer lays them out. A model with no
    // experts has none of that, and moe-profile.py says so in as many words
    // ("dense model, engine not applicable") rather than producing an empty
    // profile. Running it anyway would fail the install of a model that is, in
    // fact, perfectly installed.
    //
    // This return sits ABOVE the probe on purpose. The probe reads gigabytes off
    // both volumes to time them, which is a minute of disk on a machine that has
    // just downloaded tens of gigabytes, and it answers a question a dense model
    // never asks.
    if registry_entry(root, id).map(|e| is_dense(&e)).unwrap_or(false) {
        progress("done", 100.0, "ready");
        return Ok(());
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

    // Anything the writer leaves behind if this does not finish.
    //
    // A pack is tens of gigabytes and, with custom placement, it is written to
    // a volume the user chose. Cancelling during the write returned an error
    // and left the partial file exactly where a finished one would be, with
    // nothing pointing at it: the Models view shows the model as not installed,
    // so the only way to find those bytes again was to remember where they were
    // put. Removed on ANY failure, not only on cancel, since a pack writer that
    // died half way leaves the same thing.
    let partial = PackCleanup {
        paths: {
            let mut v = vec![pack_internal.clone()];
            if let Some(ext) = &pack_external {
                v.push(ext.clone());
            }
            v
        },
        keep: false,
    };

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
    let err_h = crate::tools::drain_pipe(child.stderr.take());
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

    // The writer succeeded, so what is on disk is a whole pack: the cleanup
    // stands down. Anything after this point failing is a settings write, which
    // leaves a usable pack behind rather than a partial one.
    let mut partial = partial;
    partial.keep = true;

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

#[cfg(test)]
mod pack_cleanup_tests {
    use super::PackCleanup;

    #[test]
    fn a_pack_that_never_finished_does_not_stay_on_the_disk() {
        // Cancelling during the pack write returned an error and left tens of
        // gigabytes exactly where a finished pack would be, with nothing
        // pointing at it: the Models view reports the model as not installed,
        // so the only way to find those bytes again was to remember where the
        // custom placement had put them.
        let dir = std::env::temp_dir().join(format!("galactus-packclean-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.h4pack");
        let b = dir.join("b.h4pack");
        std::fs::write(&a, b"half a pack").unwrap();
        std::fs::write(&b, b"half a pack").unwrap();

        drop(PackCleanup { paths: vec![a.clone(), b.clone()], keep: false });
        assert!(!a.exists(), "the partial internal pack goes");
        assert!(!b.exists(), "and so does the external one");
        assert!(dir.exists(), "the folder stays: with custom placement it is the user's");

        // A finished pack is kept, which is what `keep` is set for.
        std::fs::write(&a, b"a whole pack").unwrap();
        drop(PackCleanup { paths: vec![a.clone()], keep: true });
        assert!(a.exists(), "a pack the writer finished is never removed");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
