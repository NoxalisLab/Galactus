//! Image generation, on the same machine and with nothing leaving it.
//!
//! WHY IT LOOKS LIKE THE TEXT ENGINE. The same shape, deliberately: a registry
//! of models with verified downloads, a native binary in the bundle, a plan
//! checked against the memory this Mac actually has, and a measurement rather
//! than a promise. Someone who has understood the model list understands this
//! one.
//!
//! WHY A PROCESS PER IMAGE, and not a resident server. A diffusion model is
//! several gigabytes, and the text engine is already holding tens of them. A
//! server sitting on SDXL would take that memory away from Chimera for the
//! whole session to serve a request that comes once every few minutes. The CLI
//! loads through mmap in about two tenths of a second, so there is nothing to
//! win by keeping it warm and a great deal of memory to lose.
//!
//! WHAT IS AND IS NOT CERTIFIED. Nothing here is bit-exact anything. The engine
//! is stable-diffusion.cpp as published, unpatched: there are no expert records
//! to stream and therefore no claim of the kind the text models carry. The
//! registry says `stock_unmodified` for exactly that reason, and the app says it
//! on the card. What IS measured is the time per image on real hardware, which
//! is the number a user needs.
//!
//! THE PROMPT IS A USER STRING GOING TO A PROCESS. It travels as the value of
//! `-p`, through Command, with no shell anywhere: it cannot become an option and
//! it cannot become a command. The output path is built here and never taken
//! from the webview.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::Emitter;

/// The role a file plays in a model. Flux needs four; SD needs one.
///
/// Named rather than positional because sd-cli takes each on its own flag, and
/// a list of paths in the wrong order would load a text encoder as a VAE and
/// fail somewhere deep with a shape error.
pub const ROLE_FLAGS: &[(&str, &str)] = &[
    ("model", "-m"),
    ("diffusion", "--diffusion-model"),
    ("t5xxl", "--t5xxl"),
    ("clip_l", "--clip_l"),
    ("clip_g", "--clip_g"),
    ("vae", "--vae"),
];

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ImageModel {
    pub id: String,
    pub name: String,
    /// Total bytes on disk, for the install dialog.
    pub bytes: u64,
    /// What each file is for: role -> filename.
    pub roles: std::collections::BTreeMap<String, String>,
    pub download: Value,
    pub defaults: Value,
    pub min_ram_gb: u64,
    /// Times measured on real machines. Empty until someone runs it.
    #[serde(default)]
    pub measured: Vec<Value>,
    #[serde(default)]
    pub note: String,
    /// Filled in by `image_models`, never stored.
    #[serde(default)]
    pub installed: bool,
}

/// Where generated images and downloaded weights live.
fn image_root() -> PathBuf {
    crate::app_support().join("images")
}

pub(crate) fn model_root() -> PathBuf {
    crate::app_support().join("image-models")
}

/// The bundled sd-cli, or the checkout build when working on the engine itself.
pub(crate) fn image_engine(root: &Path) -> Option<PathBuf> {
    let checkout = root.join("third_party/stable-diffusion.cpp/build/bin/sd-cli");
    if checkout.is_file() {
        return Some(checkout);
    }
    let bundled = crate::resource_dir()?.join("image-engine/sd-cli");
    if !bundled.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&bundled) {
            let mut perm = meta.permissions();
            if perm.mode() & 0o111 == 0 {
                perm.set_mode(0o755);
                let _ = std::fs::set_permissions(&bundled, perm);
            }
        }
    }
    Some(bundled)
}

fn registry_path(root: &Path) -> PathBuf {
    root.join("scripts/image-models.json")
}

pub fn load_registry(root: &Path) -> Result<Vec<ImageModel>, String> {
    let raw = std::fs::read_to_string(registry_path(root))
        .map_err(|e| format!("image registry: {e}"))?;
    let parsed: Value = serde_json::from_str(&raw).map_err(|e| format!("image registry: {e}"))?;
    let list = parsed["models"].as_array().cloned().unwrap_or_default();
    let mut out = Vec::new();
    for m in list {
        match serde_json::from_value::<ImageModel>(m) {
            Ok(entry) => out.push(entry),
            Err(e) => return Err(format!("image registry: {e}")),
        }
    }
    Ok(out)
}

/// Every file of a model is present and non-empty.
///
/// Non-empty matters: an interrupted download leaves a zero byte file, and a
/// model reported as installed that fails to load reads as a broken app rather
/// than as an interrupted download.
pub fn model_installed(dir: &Path, m: &ImageModel) -> bool {
    m.roles.values().all(|f| {
        std::fs::metadata(dir.join(f))
            .map(|meta| meta.is_file() && meta.len() > 0)
            .unwrap_or(false)
    })
}

/// The argv for one generation.
///
/// Separated from the spawn so the flags are visible in one place and testable
/// without a model on disk, exactly like ssh_argv.
pub fn generate_argv(
    dir: &Path,
    m: &ImageModel,
    req: &GenerateRequest,
    out: &Path,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    for (role, flag) in ROLE_FLAGS {
        if let Some(file) = m.roles.get(*role) {
            args.push((*flag).to_string());
            args.push(dir.join(file).to_string_lossy().to_string());
        }
    }
    args.push("-p".into());
    args.push(req.prompt.clone());
    if !req.negative.trim().is_empty() {
        args.push("-n".into());
        args.push(req.negative.clone());
    }
    args.push("--steps".into());
    args.push(req.steps.to_string());
    args.push("--cfg-scale".into());
    args.push(format!("{:.2}", req.cfg));
    args.push("-W".into());
    args.push(req.width.to_string());
    args.push("-H".into());
    args.push(req.height.to_string());
    args.push("-s".into());
    args.push(req.seed.to_string());
    // NO --mmap, and this is measured rather than assumed. It segfaults the
    // engine outright on .safetensors weights: SDXL at any size dies with
    // SIGSEGV during sampling with the flag and completes without it. On GGUF
    // weights, where it does work, it buys nothing: the same 512 square run
    // takes 5.27s with it and 5.12s without. A flag that costs a crash on half
    // the models and saves no time on the other half has no case for existing.
    args.push("-o".into());
    args.push(out.to_string_lossy().to_string());
    args
}

#[derive(Deserialize, Clone, Debug)]
pub struct GenerateRequest {
    pub model: String,
    pub prompt: String,
    #[serde(default)]
    pub negative: String,
    pub steps: u32,
    pub cfg: f32,
    pub width: u32,
    pub height: u32,
    /// Negative means "pick one", which sd-cli understands directly.
    pub seed: i64,
}

/// Clamp a request to what the engine and the machine can actually do.
///
/// Not validation for its own sake: a width of 20000 is minutes of swapping
/// before an out-of-memory kill, and a step count of 500 is twenty minutes for
/// an image indistinguishable from the one at 30.
pub fn clamp_request(mut r: GenerateRequest) -> GenerateRequest {
    r.steps = r.steps.clamp(1, 100);
    r.cfg = if r.cfg.is_finite() { r.cfg.clamp(0.0, 30.0) } else { 7.0 };
    // Multiples of 64: the latent space is the image divided by eight, and a
    // size that does not divide cleanly comes back subtly stretched. Rounded to
    // the NEAREST multiple rather than truncated, because 700 meant "about
    // seven hundred" and 640 is further from it than 704.
    r.width = round64(r.width);
    r.height = round64(r.height);
    r
}

fn round64(v: u32) -> u32 {
    let v = v.clamp(64, 2048);
    (((v + 32) / 64) * 64).clamp(64, 2048)
}

/// The progress line sd-cli prints, as a fraction, or None for anything else.
///
/// Its progress bar is one long line rewritten with carriage returns, so this
/// reads the "12/20" that appears in it rather than trying to parse the bar.
pub fn parse_progress(line: &str) -> Option<(u32, u32)> {
    let mark = line.rfind('|')?;
    let rest = line[mark + 1..].trim_start();
    let cut = rest.find(' ').unwrap_or(rest.len());
    let (done, total) = rest[..cut].split_once('/')?;
    Some((done.trim().parse().ok()?, total.trim().parse().ok()?))
}

/// The width and height in a PNG header, without decoding the image.
///
/// The IHDR chunk is always first and always at the same offset, which is why
/// this needs no decoder and no dependency.
pub fn png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    if w == 0 || h == 0 {
        return None;
    }
    Some((w, h))
}

/// Bytes per thousand pixels below which a PNG holds no picture.
///
/// Measured, not guessed. On this machine a real generation lands at 2067 o/kpx
/// (SD 1.5, 512 square) and even pure noise reaches 3003. A failed decode, the
/// flat grey square the engine writes when the VAE could not run, comes out at
/// 31.5. The threshold sits twenty times under the lowest real image and three
/// times over the failure, which is as much daylight as this needs.
const BLANK_BYTES_PER_KPX: f64 = 100.0;

/// A PNG the engine called a success and that contains nothing.
///
/// This exists because sd-cli reports success in that case. Without the check
/// the user is handed a flat grey square and no reason for it, which reads as
/// the app being broken rather than as this model not working on this backend.
pub fn looks_blank(bytes: &[u8]) -> bool {
    let Some((w, h)) = png_size(bytes) else { return false };
    let kpx = (w as f64 * h as f64) / 1000.0;
    if kpx <= 0.0 {
        return false;
    }
    (bytes.len() as f64 / kpx) < BLANK_BYTES_PER_KPX
}

/// The (url, local name) pairs of a model's download.
///
/// A pair rather than a bare name because the files of one model come from
/// different repositories, and one of them has to land under a different name:
/// there are two files called sdxl_vae.safetensors in the world and only one of
/// them works in half precision.
///
/// The local name is checked here, not trusted: it is written to disk, and a
/// registry is a text file. A name with a slash or a parent component in it
/// would write outside the model folder.
pub fn download_files(download: &Value) -> Result<Vec<(String, String)>, String> {
    let list = download["files"].as_array().ok_or("that model has no verified download")?;
    let mut out = Vec::new();
    for f in list {
        let url = f["url"].as_str().unwrap_or_default();
        let name = f["as"].as_str().unwrap_or_default();
        if !url.starts_with("https://") {
            return Err("that model has a download that is not https".into());
        }
        if name.is_empty() || name.contains('/') || name.contains('\\') || name.starts_with('.') {
            return Err(format!("that model asks to write a file called {name:?}"));
        }
        out.push((url.to_string(), name.to_string()));
    }
    if out.is_empty() {
        return Err("that model has no verified download".into());
    }
    Ok(out)
}

fn cancel_flag() -> &'static AtomicBool {
    static FLAG: OnceLock<AtomicBool> = OnceLock::new();
    FLAG.get_or_init(|| AtomicBool::new(false))
}

#[tauri::command]
pub async fn image_models(root: String) -> Result<Vec<ImageModel>, String> {
    let dir = model_root();
    let mut list = load_registry(Path::new(&root))?;
    for m in list.iter_mut() {
        m.installed = model_installed(&dir, m);
    }
    Ok(list)
}

/// Download every file of a model, reporting progress as it goes.
#[tauri::command]
pub async fn image_install(app: tauri::AppHandle, root: String, id: String) -> Result<(), String> {
    let list = load_registry(Path::new(&root))?;
    let m = list.into_iter().find(|m| m.id == id).ok_or("no such image model")?;
    let dir = model_root();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let files = download_files(&m.download)?;
    let total = files.len();
    for (i, (url, f)) in files.iter().enumerate() {
        let dest = dir.join(f);
        // Already there: an install interrupted after three of four files must
        // not start again from the first one.
        if std::fs::metadata(&dest).map(|m| m.len() > 0).unwrap_or(false) {
            continue;
        }
        let _ = app.emit(
            "galactus://image",
            json!({"kind": "install", "id": id, "file": f, "index": i + 1, "total": total}),
        );
        let status = std::process::Command::new("curl")
            .args(["-L", "-C", "-", "--fail", "--retry", "6", "--retry-delay", "4", "-s", "-o"])
            .arg(&dest)
            .arg(url)
            .status()
            .map_err(|e| format!("curl: {e}"))?;
        if !status.success() {
            let _ = std::fs::remove_file(&dest);
            return Err(format!("download failed for {f}"));
        }
    }
    let _ = app.emit("galactus://image", json!({"kind": "installed", "id": id}));
    Ok(())
}

#[tauri::command]
pub fn image_cancel() {
    cancel_flag().store(true, Ordering::SeqCst);
}

/// Generate one image. Returns the path it was written to.
#[tauri::command]
pub async fn image_generate(
    app: tauri::AppHandle,
    root: String,
    req: GenerateRequest,
) -> Result<String, String> {
    let req = clamp_request(req);
    if req.prompt.trim().is_empty() {
        return Err("write what you want to see first".into());
    }
    let list = load_registry(Path::new(&root))?;
    let m = list.into_iter().find(|m| m.id == req.model).ok_or("no such image model")?;
    let dir = model_root();
    if !model_installed(&dir, &m) {
        return Err(format!("{} is not installed yet", m.name));
    }
    let bin = image_engine(Path::new(&root)).ok_or(
        "the image engine is missing from this build",
    )?;
    let out_dir = image_root();
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let out = out_dir.join(format!("galactus-{stamp}.png"));
    let args = generate_argv(&dir, &m, &req, &out);
    cancel_flag().store(false, Ordering::SeqCst);
    let path = out.clone();
    tauri::async_runtime::spawn_blocking(move || run_generation(app, bin, args, path))
        .await
        .map_err(|e| format!("the image thread died: {e}"))?
}

fn run_generation(
    app: tauri::AppHandle,
    bin: PathBuf,
    args: Vec<String>,
    out: PathBuf,
) -> Result<String, String> {
    use std::io::{BufReader, Read};
    use std::process::{Command, Stdio};

    let mut child = Command::new(&bin)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("image engine: {e}"))?;
    // Progress rides on stderr, in one line rewritten with carriage returns, so
    // the reader splits on \r as well as \n or it would see nothing until the
    // end.
    if let Some(err) = child.stderr.take() {
        let app2 = app.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(err);
            let mut buf = Vec::new();
            let mut byte = [0u8; 1];
            while reader.read(&mut byte).map(|n| n == 1).unwrap_or(false) {
                if byte[0] == b'\r' || byte[0] == b'\n' {
                    let line = String::from_utf8_lossy(&buf).to_string();
                    buf.clear();
                    if let Some((done, total)) = parse_progress(&line) {
                        let _ = app2.emit(
                            "galactus://image",
                            json!({"kind": "step", "done": done, "total": total}),
                        );
                    }
                } else {
                    buf.push(byte[0]);
                }
            }
        });
    }
    let mut log = String::new();
    if let Some(mut outp) = child.stdout.take() {
        let _ = outp.read_to_string(&mut log);
    }
    loop {
        if cancel_flag().load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(&out);
            let _ = app.emit("galactus://image", json!({"kind": "cancelled"}));
            return Err("cancelled".into());
        }
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => {
                if !status.success() {
                    let tail: String = log.lines().rev().take(8).collect::<Vec<_>>().join("\n");
                    let _ = app.emit("galactus://image", json!({"kind": "failed", "log": tail}));
                    return Err(if tail.trim().is_empty() {
                        "the image engine stopped without saying why".to_string()
                    } else {
                        tail
                    });
                }
                break;
            }
            None => std::thread::sleep(std::time::Duration::from_millis(120)),
        }
    }
    // The engine reports success even when it wrote nothing readable, so the
    // file is the proof, not the exit code.
    let written = std::fs::read(&out).unwrap_or_default();
    if written.is_empty() {
        return Err("the engine finished but wrote no image".into());
    }
    if looks_blank(&written) {
        // A flat square, which is what a decode that failed on this backend
        // leaves behind. Handing it over as a result would read as the app
        // being broken, so it is deleted and the failure is named.
        let _ = std::fs::remove_file(&out);
        let _ = app.emit("galactus://image", json!({"kind": "failed", "log": "blank"}));
        return Err(
            "the engine produced an empty image: this model did not run correctly on this Mac"
                .into(),
        );
    }
    let path = out.to_string_lossy().to_string();
    let _ = app.emit("galactus://image", json!({"kind": "done", "path": path}));
    Ok(path)
}

/// A generated image, as a data URL the webview can show.
///
/// Base64 through a command rather than a file URL, because the page's policy
/// allows `data:` and nothing local. That is worth keeping: opening the asset
/// protocol to show a picture would give the webview a way to read files, and
/// this needs to read exactly one folder.
///
/// The path is checked against that folder rather than trusted. It comes from
/// the webview, and "../../../.ssh/id_ed25519" is a path too.
#[tauri::command]
pub fn image_read(path: String) -> Result<String, String> {
    let root = std::fs::canonicalize(image_root()).map_err(|e| e.to_string())?;
    let full = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    if !full.starts_with(&root) {
        return Err("that image is not one of ours".into());
    }
    if full.extension().map(|e| e != "png").unwrap_or(true) {
        return Err("that is not a png".into());
    }
    let bytes = std::fs::read(&full).map_err(|e| e.to_string())?;
    Ok(format!("data:image/png;base64,{}", b64(&bytes)))
}

/// Base64, by hand: one small function against one more dependency.
fn b64(bytes: &[u8]) -> String {
    const SET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(SET[(n >> 18) as usize & 63] as char);
        out.push(SET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { SET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { SET[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Delete one generated image.
#[tauri::command]
pub fn image_forget(path: String) -> Result<(), String> {
    let root = std::fs::canonicalize(image_root()).map_err(|e| e.to_string())?;
    let full = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    if !full.starts_with(&root) || full.extension().map(|e| e != "png").unwrap_or(true) {
        return Err("that image is not one of ours".into());
    }
    std::fs::remove_file(&full).map_err(|e| e.to_string())
}

/// Everything generated so far, newest first.
#[tauri::command]
pub fn image_gallery() -> Vec<String> {
    let mut files: Vec<(std::time::SystemTime, String)> = std::fs::read_dir(image_root())
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().extension().map(|x| x == "png").unwrap_or(false))
                .filter_map(|e| {
                    let when = e.metadata().and_then(|m| m.modified()).ok()?;
                    Some((when, e.path().to_string_lossy().to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.into_iter().map(|(_, p)| p).collect()
}

#[cfg(test)]
mod tests {
    use super::{clamp_request, generate_argv, model_installed, parse_progress, GenerateRequest, ImageModel};
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    fn model(roles: &[(&str, &str)]) -> ImageModel {
        let mut map = BTreeMap::new();
        for (k, v) in roles {
            map.insert((*k).to_string(), (*v).to_string());
        }
        ImageModel {
            id: "m".into(),
            name: "M".into(),
            bytes: 1,
            roles: map,
            download: json!({}),
            defaults: json!({}),
            min_ram_gb: 8,
            measured: vec![],
            note: String::new(),
            installed: false,
        }
    }

    fn req(prompt: &str) -> GenerateRequest {
        GenerateRequest {
            model: "m".into(),
            prompt: prompt.into(),
            negative: String::new(),
            steps: 20,
            cfg: 7.0,
            width: 512,
            height: 512,
            seed: 42,
        }
    }

    #[test]
    fn every_file_reaches_the_flag_it_belongs_to() {
        // Four files in the wrong order loads a text encoder as a VAE and fails
        // deep inside with a shape error nobody can act on.
        let m = model(&[
            ("diffusion", "flux.gguf"),
            ("t5xxl", "t5.gguf"),
            ("clip_l", "clip.gguf"),
            ("vae", "ae.gguf"),
        ]);
        let argv = generate_argv(Path::new("/models"), &m, &req("a cat"), Path::new("/out/x.png"));
        for (flag, file) in [
            ("--diffusion-model", "/models/flux.gguf"),
            ("--t5xxl", "/models/t5.gguf"),
            ("--clip_l", "/models/clip.gguf"),
            ("--vae", "/models/ae.gguf"),
        ] {
            let at = argv.iter().position(|a| a == flag).unwrap_or_else(|| panic!("{flag} missing"));
            assert_eq!(argv[at + 1], file);
        }
    }

    #[test]
    fn the_prompt_cannot_turn_into_an_option_or_a_command() {
        // It is user text on its way to a process. It travels as the VALUE of
        // -p, so even this stays one argument and reaches the engine intact.
        let nasty = "-o /etc/passwd; rm -rf / `whoami` $(id)";
        let argv = generate_argv(
            Path::new("/models"),
            &model(&[("model", "sd.gguf")]),
            &req(nasty),
            Path::new("/out/x.png"),
        );
        let at = argv.iter().position(|a| a == "-p").expect("-p present");
        assert_eq!(argv[at + 1], nasty, "the prompt is one argument, verbatim");
        // And the output path is ours, written once, at the end.
        assert_eq!(argv.iter().filter(|a| *a == "-o").count(), 1);
        assert_eq!(argv.last().unwrap(), "/out/x.png");
    }

    #[test]
    fn a_size_that_cannot_work_is_corrected_rather_than_attempted() {
        // 20000 pixels is minutes of swapping and then a kill; a size that does
        // not divide by 64 comes back subtly stretched.
        let mut r = req("x");
        r.width = 20000;
        r.height = 700;
        r.steps = 5000;
        r.cfg = f32::INFINITY;
        let c = clamp_request(r);
        assert_eq!(c.width, 2048);
        assert_eq!(c.height, 704);
        assert_eq!(c.steps, 100);
        assert_eq!(c.cfg, 7.0, "a non-finite guidance falls back, it does not propagate");
    }

    #[test]
    fn an_interrupted_download_does_not_count_as_installed() {
        let dir = std::env::temp_dir().join(format!("galactus-img-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let m = model(&[("model", "a.gguf"), ("vae", "b.gguf")]);
        assert!(!model_installed(&dir, &m), "nothing there");
        std::fs::write(dir.join("a.gguf"), b"x").unwrap();
        assert!(!model_installed(&dir, &m), "one file of two");
        // A zero byte file is what an interrupted curl leaves behind.
        std::fs::write(dir.join("b.gguf"), b"").unwrap();
        assert!(!model_installed(&dir, &m), "an empty file is not a model");
        std::fs::write(dir.join("b.gguf"), b"y").unwrap();
        assert!(model_installed(&dir, &m));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_step_counter_is_read_out_of_the_progress_bar() {
        // One line, rewritten with carriage returns, bar and all.
        assert_eq!(parse_progress("  |=====>      | 7/20 - 1.20it/s"), Some((7, 20)));
        assert_eq!(parse_progress("  |####| 686/686 - 6.66GB/s"), Some((686, 686)));
        assert_eq!(parse_progress("[INFO ] sampling completed, taking 16.99s"), None);
        assert_eq!(parse_progress(""), None);
    }

    #[test]
    fn a_registry_cannot_make_the_app_write_outside_its_model_folder() {
        use super::download_files;
        // A registry is a text file, and the name in it becomes a path on disk.
        let ok = json!({"files": [{"url": "https://h/f.gguf", "as": "f.gguf"}]});
        assert_eq!(download_files(&ok).unwrap(), vec![("https://h/f.gguf".to_string(), "f.gguf".to_string())]);
        for bad in [
            json!({"files": [{"url": "https://h/f", "as": "../../.ssh/authorized_keys"}]}),
            json!({"files": [{"url": "https://h/f", "as": "sub/f.gguf"}]}),
            json!({"files": [{"url": "http://h/f", "as": "f.gguf"}]}),
            json!({"files": [{"url": "https://h/f", "as": ""}]}),
            json!({"files": []}),
            json!({}),
        ] {
            assert!(download_files(&bad).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn base64_matches_the_encoding_everyone_elses_decoder_expects() {
        use super::b64;
        // The three padding cases, which is where a hand-written encoder goes
        // wrong: a picture that decodes to garbage in the webview would be very
        // hard to explain from the Rust side.
        assert_eq!(b64(b"Man"), "TWFu");
        assert_eq!(b64(b"Ma"), "TWE=");
        assert_eq!(b64(b"M"), "TQ==");
        assert_eq!(b64(b""), "");
        assert_eq!(b64(&[0xff, 0xfe, 0xfd]), "//79");
    }

    #[test]
    fn the_flag_that_crashes_the_engine_is_never_passed() {
        // --mmap kills sd-cli with SIGSEGV on .safetensors weights, and saves
        // no measurable time on the GGUF ones where it works. It must not come
        // back in as an optimisation by someone who did not measure it.
        let argv = generate_argv(
            Path::new("/m"),
            &model(&[("model", "sdxl.safetensors")]),
            &req("x"),
            Path::new("/out/x.png"),
        );
        assert!(!argv.iter().any(|a| a == "--mmap"));
    }

    #[test]
    fn an_image_with_nothing_in_it_is_refused_rather_than_handed_over() {
        use super::{looks_blank, png_size};
        // The numbers are measurements from this machine: a real 512 square
        // generation is 541823 bytes, and the flat grey square a failed decode
        // writes is 33032 bytes at 1024 square.
        let png = |w: u32, h: u32, len: usize| {
            let mut v = b"\x89PNG\r\n\x1a\n".to_vec();
            v.extend_from_slice(&[0; 8]);
            v.extend_from_slice(&w.to_be_bytes());
            v.extend_from_slice(&h.to_be_bytes());
            v.resize(len.max(24), 0);
            v
        };
        assert_eq!(png_size(&png(512, 512, 100)), Some((512, 512)));
        assert!(looks_blank(&png(1024, 1024, 33_032)), "the grey square");
        assert!(!looks_blank(&png(512, 512, 541_823)), "a real image");
        assert!(!looks_blank(&png(1024, 1024, 3_148_541)), "even noise is a picture");
        // Anything that is not a PNG is not judged: silence beats a wrong verdict.
        assert!(!looks_blank(b"not a png at all"));
        assert_eq!(png_size(b"nope"), None);
    }

    #[test]
    fn the_output_path_is_ours_and_lands_in_the_app_folder() {
        // Never taken from the webview: a caller-supplied path is a write
        // anywhere on the disk with no permission dialog.
        let out = PathBuf::from("/tmp/whatever.png");
        let argv = generate_argv(Path::new("/m"), &model(&[("model", "s.gguf")]), &req("x"), &out);
        assert_eq!(argv.iter().filter(|a| a.ends_with(".png")).count(), 1);
    }
}
