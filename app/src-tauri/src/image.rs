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
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Emitter;

/// The role a file plays in a model. Flux needs four; SD needs one.
///
/// Named rather than positional because sd-cli takes each on its own flag, and
/// a list of paths in the wrong order would load a text encoder as a VAE and
/// fail somewhere deep with a shape error.
pub const ROLE_FLAGS: &[(&str, &str)] = &[
    ("model", "-m"),
    ("diffusion", "--diffusion-model"),
    // Wan 2.2's A14B pair: two experts, one for the noisy half of the schedule
    // and one for the clean half, both loaded at once. A model with this role
    // is useless without it, so it rides in the same table as the rest.
    ("high_noise_diffusion", "--high-noise-diffusion-model"),
    ("t5xxl", "--t5xxl"),
    ("clip_l", "--clip_l"),
    ("clip_g", "--clip_g"),
    // Qwen-Image's text encoder is a full vision-language model rather than a
    // CLIP/T5 pair. Without this role its --llm flag is never emitted and the
    // model loads with no encoder at all.
    ("llm", "--llm"),
    // The wav2vec2 speech encoder of Wan S2V. Without it the engine refuses
    // the render outright, which beats the silent zero it gives a missing
    // t5xxl - but the flag still has to exist to be passed at all.
    ("audio_encoder", "--audio-encoder"),
    // The vision tower of that encoder, when it ships as its own file. Baked
    // into the checkpoint for both models here, so nothing sets it today; it
    // exists because a model that stores it apart loads with no vision at all
    // and fails deep, and the flag is one line.
    ("llm_vision", "--llm_vision"),
    ("vae", "--vae"),
    // MiniMax-H3 decodes picture and sound in the same pass and wants a second
    // VAE for the sound. Without it the engine still runs the joint model and
    // simply writes a silent clip, which is a quiet way to lose half of what
    // this model does.
    ("audio_vae", "--audio-vae"),
];

/// What a video model needs that an image model does not.
///
/// WHY THE GRID IS WRITTEN DOWN. Neither engine takes a free-form frame count:
/// MiniMax-H3 rounds up to `17k + 5` and Wan to `4k + 1`, silently, inside the
/// engine. A user who asks for two seconds and is handed 2.4 has no way to know
/// where the extra came from, and the measured time in the registry would be
/// for a clip nobody asked for. The grid lives here so the rounding happens
/// where the number is still on screen.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct VideoSpec {
    /// The frame count this model opens with.
    pub frames: u32,
    /// Accepted counts are `frame_step * k + frame_base`.
    pub frame_step: u32,
    pub frame_base: u32,
    /// Frames per second the model was trained at. Wan's A14B is 16 and H3 is
    /// 24; passing the wrong one gives a clip that plays at the wrong speed,
    /// and H3 overrides anything else anyway.
    pub fps: u32,
    /// Flow shift, when the model wants one the engine would not pick itself.
    /// None leaves the engine on auto, which is right for H3 (it picks 12).
    #[serde(default)]
    pub flow_shift: Option<f32>,
    #[serde(default)]
    pub sampling_method: Option<String>,
    /// The engine's noise source. H3's published invocations all pass `cpu`,
    /// which also makes a seed mean the same thing whatever the backend.
    #[serde(default)]
    pub rng: Option<String>,
    /// Steps for the noisy half of the schedule, for the models that split it
    /// across two weight files. None for the single-model ones.
    #[serde(default)]
    pub high_noise_steps: Option<u32>,
    /// Weights in RAM, copied to the GPU as they are needed.
    ///
    /// A property of the model rather than of the machine: both video models
    /// here are tens of gigabytes and neither is meant to sit in the graph
    /// budget whole. Layer streaming, which rides on top of this, is NOT here
    /// for the opposite reason: it costs throughput and only pays on a machine
    /// that needs the room, so `image_plan` decides it per Mac.
    #[serde(default)]
    pub offload_to_cpu: bool,
    /// This model cannot start from text alone: Wan's I2V was trained to
    /// animate a picture and diverges into noise without one.
    #[serde(default)]
    pub needs_init_image: bool,
    /// This model can take a starting picture but does not require one.
    #[serde(default)]
    pub accepts_init_image: bool,
    /// This model is driven by a voice: it needs a WAV to speak. S2V's whole
    /// point, so refusing without one happens before the model loads.
    #[serde(default)]
    pub needs_ref_audio: bool,
    /// A tiny-VAE fast mode exists for this model (a `taesd` role is on
    /// disk). The card offers the checkbox only when this is true.
    #[serde(default)]
    pub fast_decode: bool,
    /// Diffusion cache the engine should run for this model ("easycache").
    /// Set per model, and only after a measured run showed the output holds:
    /// a cache threshold that works for one architecture can smear another.
    #[serde(default)]
    pub cache_mode: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ImageModel {
    pub id: String,
    pub name: String,
    /// "image" or "video". Absent means image, so every entry that predates
    /// video keeps parsing unchanged.
    #[serde(default = "kind_image")]
    pub kind: String,
    /// Present exactly when `kind` is video.
    #[serde(default)]
    pub video: Option<VideoSpec>,
    /// What the licence restricts, when it restricts something worth showing
    /// before forty gigabytes are fetched. An `{en, fr}` object, like `note`:
    /// both travel to the card verbatim, so a bare string would reach half
    /// the users in the wrong language. Empty/absent for the permissive ones.
    #[serde(default)]
    pub licence: Value,
    /// Total bytes on disk, for the install dialog.
    pub bytes: u64,
    /// What each file is for: role -> filename.
    pub roles: std::collections::BTreeMap<String, String>,
    pub download: Value,
    pub defaults: Value,
    pub min_ram_gb: u64,
    /// Decode the VAE on the CPU rather than the GPU. Flux needs this on Metal:
    /// its VAE saturates to a white image on the GPU (measured), and only the
    /// CPU path produces a real picture. Off by default, since it is slower and
    /// every other model decodes fine on the GPU.
    #[serde(default)]
    pub vae_on_cpu: bool,
    /// Times measured on real machines. Empty until someone runs it.
    #[serde(default)]
    pub measured: Vec<Value>,
    /// `{en, fr}` object, displayed verbatim on the card in the user's language.
    #[serde(default)]
    pub note: Value,
    /// Filled in by `image_models`, never stored.
    #[serde(default)]
    pub installed: bool,
    /// The verdict for THIS machine, filled by `image_models` exactly like
    /// `installed`: computed from the RAM at answer time, never stored in the
    /// registry, so the same registry file serves every Mac it is read on.
    #[serde(default)]
    pub usable: bool,
    /// One English sentence saying why, kept for logs and as the fallback the
    /// view shows when it cannot build a translated one.
    #[serde(default)]
    pub reason: String,
    /// The largest square side this machine can decode, 0 when none can.
    #[serde(default)]
    pub max_side: u32,
    /// A shorter first run for a machine near its memory, None when the
    /// model's own default is fine.
    #[serde(default)]
    pub recommended_steps: Option<u32>,
    /// Installed GB a Mac needs for this model at all, for the "needs X,
    /// this machine has Y" sentence.
    #[serde(default)]
    pub need_gb: u64,
    /// The longest clip this machine can decode, in frames. Zero for an image
    /// model and for a video model that does not fit at all.
    #[serde(default)]
    pub max_frames: u32,
}

fn kind_image() -> String {
    "image".to_string()
}

impl ImageModel {
    pub fn is_video(&self) -> bool {
        self.kind == "video"
    }
}

/// A registry entry as `image_models` would hand it over: installed, and fine
/// on this machine. For the API tests in imgapi.rs, which need a catalogue and
/// must not need a disk, a download or a Mac of a particular size.
#[cfg(test)]
pub fn test_model(id: &str) -> ImageModel {
    ImageModel {
        id: id.into(),
        name: id.into(),
        kind: "image".into(),
        video: None,
        licence: json!(""),
        bytes: 6_900_000_000,
        roles: std::collections::BTreeMap::new(),
        download: json!({}),
        defaults: json!({"steps": 20, "cfg": 7.0, "width": 1024, "height": 1024}),
        min_ram_gb: 8,
        measured: vec![],
        note: json!(""),
        installed: true,
        vae_on_cpu: false,
        usable: true,
        reason: String::new(),
        max_side: 1024,
        recommended_steps: None,
        need_gb: 8,
        max_frames: 0,
    }
}

/// Wan's 16 fps grid of 4k + 1, for the same tests.
#[cfg(test)]
pub fn test_video_spec() -> VideoSpec {
    VideoSpec {
        frames: 17,
        frame_step: 4,
        frame_base: 1,
        fps: 16,
        flow_shift: Some(3.0),
        sampling_method: Some("euler".into()),
        rng: None,
        high_noise_steps: None,
        offload_to_cpu: true,
        needs_init_image: false,
        accepts_init_image: true,
        needs_ref_audio: false,
        fast_decode: true,
        cache_mode: None,
    }
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
    // A checkout build wins while developing the engine, and only then. In a
    // release build the bundled binary is the only one considered: the root is
    // a folder the user (or a clone) can point anywhere, and "a path from the
    // settings decides which executable runs" is not a sentence that belongs in
    // a shipped app.
    #[cfg(debug_assertions)]
    {
        let checkout = root.join("third_party/stable-diffusion.cpp/build/bin/sd-cli");
        if checkout.is_file() {
            return Some(checkout);
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = root;
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

/// The file written once every byte of a model is on disk.
///
/// Its content is the total size the install ended with, so the marker cannot
/// outlive the files it vouches for: delete one and the sizes stop agreeing.
fn install_marker(dir: &Path, m: &ImageModel) -> PathBuf {
    dir.join(format!(".{}.installed", m.id))
}

fn installed_size(dir: &Path, m: &ImageModel) -> Option<u64> {
    let mut total = 0u64;
    for f in m.roles.values() {
        let meta = std::fs::metadata(dir.join(f)).ok()?;
        if !meta.is_file() || meta.len() == 0 {
            return None;
        }
        total += meta.len();
    }
    Some(total)
}

/// Every file of a model is on disk, whole.
///
/// WHOLE is the hard part. The first version asked only that each file be
/// non-empty, which an interrupted download satisfies from its first second:
/// curl writes as it goes, so three gigabytes of a five gigabyte model is a
/// large non-empty file, and the model was reported installed. sd-cli then
/// failed to load it, which reads as a broken app rather than as a download
/// that needs finishing.
///
/// Two ways to be sure, because the second has to work for models that were
/// already on disk before the marker existed:
///
///   * the marker, written after the last byte and holding the total size it
///     ended with. Exact, and the only one that can catch a download stopped
///     at 99 per cent;
///   * failing that, the total size against the figure in the registry. That
///     figure is rounded (measured at 0.04 and 0.36 per cent off for the two
///     shipped models), so the threshold is generous. It is there to catch the
///     interrupted download, not to verify the bytes.
pub fn model_installed(dir: &Path, m: &ImageModel) -> bool {
    if !m.roles.values().all(|f| is_plain_name(f)) {
        return false;
    }
    let Some(size) = installed_size(dir, m) else { return false };
    if let Ok(text) = std::fs::read_to_string(install_marker(dir, m)) {
        if text.trim().parse::<u64>() == Ok(size) {
            return true;
        }
    }
    // No marker, or one that no longer matches: fall back on the declared size.
    m.bytes == 0 || size as f64 >= m.bytes as f64 * 0.95
}

/// The argv for one generation.
///
/// Separated from the spawn so the flags are visible in one place and testable
/// without a model on disk, exactly like ssh_argv.
/// `stream_layers` comes from the plan, not from the registry and not from the
/// view: it buys room on a Mac that needs it and costs throughput on one that
/// does not, which makes it a fact about the machine.
pub fn generate_argv(
    dir: &Path,
    m: &ImageModel,
    req: &GenerateRequest,
    out: &Path,
    stream_layers: bool,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    // The mode goes first, where a person reading a failing command line looks.
    if m.is_video() {
        args.push("-M".into());
        args.push("vid_gen".into());
    }
    for (role, flag) in ROLE_FLAGS {
        if let Some(file) = m.roles.get(*role).filter(|f| is_plain_name(f)) {
            args.push((*flag).to_string());
            args.push(dir.join(file).to_string_lossy().to_string());
        }
    }
    if let Some(v) = m.video.as_ref() {
        args.push("--video-frames".into());
        args.push(align_frames(req.frames, v).to_string());
        args.push("--fps".into());
        args.push(v.fps.max(1).to_string());
        // Flash attention in the diffusion model only, which is what every
        // published invocation of both models uses. Not offered as a choice:
        // it is how these two are meant to be run.
        args.push("--diffusion-fa".into());
        if let Some(shift) = v.flow_shift {
            args.push("--flow-shift".into());
            args.push(format!("{shift:.2}"));
        }
        if let Some(sampler) = v.sampling_method.as_deref().filter(|s| !s.is_empty()) {
            args.push("--sampling-method".into());
            args.push(sampler.to_string());
        }
        if let Some(rng) = v.rng.as_deref().filter(|s| !s.is_empty()) {
            args.push("--rng".into());
            args.push(rng.to_string());
        }
        if let Some(cache) = v.cache_mode.as_deref().filter(|s| !s.is_empty()) {
            args.push("--cache-mode".into());
            args.push(cache.to_string());
        }
        // The noisy half of the schedule, for a model that splits it over two
        // weight files. Its cfg and sampler follow the clean half's rather
        // than being invented: the published Wan invocations set both halves
        // to the same values and differ only in the step count.
        if let Some(steps) = v.high_noise_steps.filter(|_| m.roles.contains_key("high_noise_diffusion")) {
            args.push("--high-noise-steps".into());
            args.push(steps.clamp(1, 100).to_string());
            args.push("--high-noise-cfg-scale".into());
            args.push(format!("{:.2}", req.cfg));
            if let Some(sampler) = v.sampling_method.as_deref().filter(|s| !s.is_empty()) {
                args.push("--high-noise-sampling-method".into());
                args.push(sampler.to_string());
            }
        }
        if v.offload_to_cpu {
            args.push("--offload-to-cpu".into());
        }
        // The starting picture. Presence was already enforced by the caller
        // for the models that need one; here an empty string simply emits
        // nothing, which is the text-to-video case.
        if !req.init_image.is_empty() {
            args.push("-i".into());
            args.push(req.init_image.clone());
        }
        if !req.ref_audio.is_empty() {
            args.push("--ref-audio".into());
            args.push(req.ref_audio.clone());
        }
        // The fast decode. NOT in ROLE_FLAGS: a taesd on disk must not be
        // wired in unconditionally, it is a per-request trade of colour
        // fidelity for a 9x faster decode, chosen with a checkbox.
        if req.fast {
            if let Some(file) = m.roles.get("taesd").filter(|f| is_plain_name(f)) {
                args.push("--taesd".into());
                args.push(dir.join(file).to_string_lossy().to_string());
            }
        }
        // Residency streaming, and the budget it rides on. --stream-layers is
        // documented as having no effect without --max-vram, so the two are
        // emitted together or not at all. -1 means "most of the free VRAM,
        // keeping about a gigabyte spare", which is the pairing the engine's
        // own performance guide gives.
        if stream_layers && v.offload_to_cpu {
            args.push("--max-vram".into());
            args.push("-1".into());
            args.push("--stream-layers".into());
        }
    }
    // The CPU VAE path, for the models that need it (Flux on Metal). A flag on
    // the model, not the request: the user does not choose this, the model
    // does, and every other model leaves it off and decodes on the GPU.
    if m.vae_on_cpu {
        args.push("--vae-on-cpu".into());
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
    /// Frames for a video model, ignored by an image one. Zero means "the
    /// model's own default", which is what a caller that does not know the
    /// model sends.
    #[serde(default)]
    pub frames: u32,
    /// The starting picture for the models that animate one. A path the USER
    /// picked, so unlike everything else it may point anywhere readable: it is
    /// validated as an existing file, not confined to our folder.
    #[serde(default)]
    pub init_image: String,
    /// Driving voice for the speech-to-video models, same trust model as the
    /// picture: a user-picked path, validated as existing, not confined.
    #[serde(default)]
    pub ref_audio: String,
    /// Decode through the tiny VAE instead of the full one. Only meaningful
    /// on models whose registry carries a taesd role; measured at 9x faster
    /// on TI2V-5B, with visibly cheaper colour.
    #[serde(default)]
    pub fast: bool,
}

/// The nearest frame count at or above `want` that this model accepts.
///
/// Rounded UP rather than to the nearest, and deliberately: the engine itself
/// rounds up, so rounding down here would hand the engine a number it silently
/// raises again, and the count shown to the user would be neither what was
/// asked nor what was rendered.
pub fn align_frames(want: u32, v: &VideoSpec) -> u32 {
    let step = v.frame_step.max(1);
    let base = v.frame_base;
    let want = if want == 0 { v.frames } else { want }.max(base).min(MAX_FRAMES);
    // k such that step * k + base is the first value at or above want.
    let k = (want.saturating_sub(base)).div_ceil(step);
    (step * k + base).min(MAX_FRAMES)
}

/// The longest clip this app will ask for, whatever the machine.
///
/// Not a memory bound (that is `video_plan`'s job) but a patience one: at the
/// measured seconds-per-frame of these models, a four hundred frame clip is a
/// machine busy overnight for something nobody watches to the end.
const MAX_FRAMES: u32 = 241;

/// Clamp a request to what the engine and the machine can actually do.
///
/// Not validation for its own sake: a width of 20000 is minutes of swapping
/// before an out-of-memory kill, and a step count of 500 is twenty minutes for
/// an image indistinguishable from the one at 30.
///
/// `max_side` is the ceiling `image_plan` computed for this machine, applied
/// here as well as in the view for the same reason ctx_within_model bounds
/// the context even though the slider already does: this command is callable
/// without the view, and a bound that lives only in the UI is not a bound.
/// Zero means no plan was consulted (tests, callers refused upstream) and
/// keeps the engine-wide 2048.
pub fn clamp_request(
    mut r: GenerateRequest,
    max_side: u32,
    video: Option<&VideoSpec>,
) -> GenerateRequest {
    r.steps = r.steps.clamp(1, 100);
    r.cfg = if r.cfg.is_finite() { r.cfg.clamp(0.0, 30.0) } else { 7.0 };
    if let Some(v) = video {
        r.frames = align_frames(r.frames, v);
        // Thirty-two, not sixty-four, and this is load-bearing rather than a
        // detail: both video models are trained at 864 x 480 and 832 x 480,
        // and neither side is a multiple of 64. Rounding these the way images
        // are rounded turns 864 x 480 into 896 x 512, which is no longer the
        // shape the model was measured at, on every single run.
        let cap = if max_side == 0 { 2048 } else { (max_side.clamp(64, 2048) / 32) * 32 };
        r.width = round32(r.width).min(cap);
        r.height = round32(r.height).min(cap);
        if r.seed < -1 || r.seed > 4_294_967_295 {
            r.seed = -1;
        }
        return r;
    }
    // Multiples of 64: the latent space is the image divided by eight, and a
    // size that does not divide cleanly comes back subtly stretched. Rounded to
    // the NEAREST multiple rather than truncated, because 700 meant "about
    // seven hundred" and 640 is further from it than 704.
    //
    // The plan's ceiling is floored to a multiple of 64 too, so applying it
    // after the rounding cannot undo the rounding: every SIDE_LADDER rung
    // already divides, and a caller-supplied oddity is made to.
    let cap = if max_side == 0 { 2048 } else { (max_side.clamp(64, 2048) / 64) * 64 };
    r.width = round64(r.width).min(cap);
    r.height = round64(r.height).min(cap);
    // The engine parses this with stoll and dies on anything outside i64. A
    // negative value means "pick one", which it understands, so everything out
    // of range becomes that rather than an error nobody can read.
    if r.seed < -1 || r.seed > 4_294_967_295 {
        r.seed = -1;
    }
    r
}

fn round64(v: u32) -> u32 {
    let v = v.clamp(64, 2048);
    (((v + 32) / 64) * 64).clamp(64, 2048)
}

fn round32(v: u32) -> u32 {
    let v = v.clamp(32, 2048);
    (((v + 16) / 32) * 32).clamp(32, 2048)
}

// ------------------------------------------------ will it run on THIS Mac
//
// The text models get a per-machine verdict (plan_cache in lib.rs): weights
// and caches against what the Mac can give, and a model that cannot fit is
// blocked before it wastes anyone's afternoon. The image models had only the
// static `min_ram_gb`, which answers "can it run somewhere" and says nothing
// about what THIS machine can do with it. This is the same idea sized for
// diffusion, where the variable cost is not a KV cache but activations that
// grow with the pixel count: the verdict is therefore not just yes or no, it
// is the largest square this machine can decode without swapping.

const GB: u64 = 1_000_000_000;

/// Bytes one generation needs on top of the weights, at a given square side.
///
/// Two terms, both from what the engine actually allocates:
///
///   * a flat gigabyte for everything that does not scale with the image:
///     the runtime, the text encoder activations, the sampler's scratch and
///     the latent itself, which at side/8 squared is small change;
///   * the VAE decode, which is the peak. Its widest feature maps are 256
///     channels at FULL resolution in f32: 256 * 1024 * 1024 * 4 bytes is
///     1 GiB per map at a 1024 square, and a convolution keeps about three
///     alive at once (input, output, scratch). So 3 GB at 1024, scaling
///     with the pixel count.
///
/// Calibrated against the machines this app has really run on: with these
/// numbers every shipped model reaches 1024 on the 128 GB Mac each was
/// measured on, SD 1.5 reaches 1024 on an 8 GB Mac, and Qwen-Image's
/// 21.4 GB of weights alone overrun a 16 GB Mac. All three match what those
/// machines actually do.
fn activation_bytes(side: u32) -> u64 {
    GB + 3 * GB * (side as u64 * side as u64) / (1024 * 1024)
}

/// The square sides a plan can answer with, largest first.
///
/// The ladder stops where round64 stops, and every rung is a multiple of 64,
/// so a request clamped to a rung never comes back subtly stretched.
const SIDE_LADDER: [u32; 5] = [2048, 1536, 1024, 768, 512];

/// What this machine can do with one image model. See `image_plan`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImagePlan {
    /// This model can decode at least a 512 square here without swapping.
    pub usable: bool,
    /// One short English sentence saying why, for a log or a refusal.
    pub reason: String,
    /// The largest square side that fits, 0 when nothing does.
    pub max_side: u32,
    /// A shorter first run when the machine sits close to its memory: a
    /// tight fit means macOS is already compressing pages around the engine,
    /// every step costs more than it would on a roomy Mac, and the first
    /// image a user waits ten minutes for reads as a hang. None when the
    /// model's own default is fine.
    pub recommended_steps: Option<u32>,
    /// Installed GB a Mac needs to run this model at all.
    pub need_gb: u64,
    /// The longest clip that fits, on the model's own frame grid. Zero for
    /// an image model.
    pub max_frames: u32,
    /// Stream the transformer blocks rather than keeping them resident. The
    /// plan's call, not the registry's: it buys room a small Mac needs and
    /// costs a roomy one a few percent of throughput for nothing.
    pub stream_layers: bool,
}

/// Bytes one video generation needs on top of the weights.
///
/// The same two ideas as `activation_bytes`, with time as a third axis:
///
///   * a flat 2 GB for the runtime, the text encoder pass and the sampler.
///     Twice the image figure, because the packed latent of a clip and the
///     conditioning of a second diffusion model (Wan's high-noise expert)
///     are not small change the way one image's latent is;
///   * the VAE decode, per frame: the same 3 GB of feature maps a 1024
///     square costs, scaled by the pixel count, with about one frame in
///     eight's worth alive at once. The video VAEs decode through time in
///     chunks rather than holding every frame's maps simultaneously, and
///     one-in-eight reproduces the engine's behaviour at the shipped
///     resolutions without flattering it.
///
/// AN ESTIMATE TO BE CALIBRATED, exactly as `activation_bytes` was: with
/// these numbers H3's 42.8 GB of weights plus an 864 x 480 x 56-frame clip
/// lands at 53 GB, which fits the 64 GB gate its registry entry carries, and
/// TI2V-5B at 81 frames lands under a 32 GB Mac's budget. The first measured
/// run on each model replaces trust in this formula with a number.
fn video_activation_bytes(w: u32, h: u32, frames: u32) -> u64 {
    let px = w as u64 * h as u64;
    2 * GB + 3 * GB * px * (frames as u64).div_ceil(8) / (1024 * 1024)
}

/// The per-machine verdict for a video model, pure like `image_plan`.
///
/// The resolution is not a ladder here: video models are trained at one
/// shape and diverge away from it, so the plan holds the registry's default
/// resolution fixed and answers with the longest clip instead.
pub fn video_plan(
    bytes: u64,
    min_ram_gb: u64,
    ram_gb: u64,
    w: u32,
    h: u32,
    v: &VideoSpec,
) -> ImagePlan {
    let installed = ram_gb * GB;
    let budget = installed.saturating_sub(crate::system_reserve_bytes(installed));
    let shortest = v.frame_step.max(1) + v.frame_base;
    let floor = bytes.saturating_add(video_activation_bytes(w, h, shortest));
    let need_gb = min_ram_gb.max((floor + 2 * GB).div_ceil(GB));
    if ram_gb < min_ram_gb || floor > budget {
        return ImagePlan {
            usable: false,
            reason: format!("needs about {need_gb} GB of memory and this Mac has {ram_gb} GB"),
            max_side: 0,
            recommended_steps: None,
            need_gb,
            max_frames: 0,
            stream_layers: false,
        };
    }
    // Walk the model's own grid downward from the longest clip this app
    // offers: every candidate is a count the engine will not silently change.
    let mut max_frames = shortest;
    let mut f = align_frames(MAX_FRAMES, v);
    while f >= shortest {
        if bytes.saturating_add(video_activation_bytes(w, h, f)) <= budget {
            max_frames = f;
            break;
        }
        f = f.saturating_sub(v.frame_step.max(1));
    }
    // Streaming buys room and costs throughput, so it is on exactly when the
    // room is needed: a machine whose budget holds the weights twice over
    // gains nothing from evicting blocks it could have kept.
    let stream_layers = v.offload_to_cpu && bytes * 2 > budget;
    ImagePlan {
        usable: true,
        reason: format!("runs here up to {max_frames} frames at {w} x {h}"),
        max_side: w.max(h),
        recommended_steps: None,
        need_gb,
        max_frames,
        stream_layers,
    }
}

/// The per-machine verdict, pure so a test can hold any Mac in one integer.
///
/// The memory model is deliberately simple: a diffusion model must hold its
/// weights plus `activation_bytes` of the side it decodes, inside the RAM
/// left after the same `system_reserve_bytes` the text engine honours,
/// because macOS does not care which engine is asking. `installed` is
/// `ram_gb * 1e9`, the text planner's own convention: it understates a Mac
/// sold in GiB by about 7 percent, and a bound that errs toward leaving
/// memory free is the one to keep.
///
/// The registry `min_ram_gb` stays a floor rather than being replaced: that
/// number can carry knowledge this arithmetic does not have, like an engine
/// that allocates worse for one architecture than the model's size says.
pub fn image_plan(bytes: u64, min_ram_gb: u64, ram_gb: u64, default_steps: u32) -> ImagePlan {
    let installed = ram_gb * GB;
    let budget = installed.saturating_sub(crate::system_reserve_bytes(installed));
    let floor = bytes.saturating_add(activation_bytes(SIDE_LADDER[SIDE_LADDER.len() - 1]));
    // What a Mac must have INSTALLED for the smallest side: the peak, plus
    // the 2 GB reserve a Mac of that size would keep, rounded up. The
    // registry minimum stays a floor under it.
    let need_gb = min_ram_gb.max((floor + 2 * GB).div_ceil(GB));
    if ram_gb < min_ram_gb || floor > budget {
        return ImagePlan {
            usable: false,
            reason: format!("needs about {need_gb} GB of memory and this Mac has {ram_gb} GB"),
            max_side: 0,
            recommended_steps: None,
            need_gb,
            max_frames: 0,
            stream_layers: false,
        };
    }
    let max_side = SIDE_LADDER
        .iter()
        .copied()
        .find(|side| bytes.saturating_add(activation_bytes(*side)) <= budget)
        // Unreachable: the floor gate above already proved the 512 rung fits.
        .unwrap_or(SIDE_LADDER[SIDE_LADDER.len() - 1]);
    // Tight means the room left after the weights would not hold a second
    // decode: the engine will run, but at the edge, where every extra step
    // is paid in compressed pages. Twenty steps is where the shipped
    // defaults cluster and where quality stops moving for most samplers.
    let recommended_steps = if budget - bytes < 2 * activation_bytes(max_side) {
        Some(default_steps.clamp(1, 100).min(20))
    } else {
        None
    };
    ImagePlan {
        usable: true,
        reason: format!("runs here up to {max_side} x {max_side}"),
        max_side,
        recommended_steps,
        need_gb,
        max_frames: 0,
        stream_layers: false,
    }
}

/// The step count a model opens with, from its registry defaults.
fn default_steps(m: &ImageModel) -> u32 {
    m.defaults["steps"].as_u64().unwrap_or(20) as u32
}

/// The one place that decides which arithmetic a model gets.
///
/// Everything the callers know about a model goes in, one plan comes out:
/// `image_generate` and `image_models` were already calling `image_plan` from
/// two places, and a video model dispatched in one but not the other would be
/// gated on the wrong numbers in whichever forgot.
pub fn plan_for(m: &ImageModel, ram_gb: u64) -> ImagePlan {
    match m.video.as_ref() {
        Some(v) => {
            let w = m.defaults["width"].as_u64().unwrap_or(832) as u32;
            let h = m.defaults["height"].as_u64().unwrap_or(480) as u32;
            video_plan(m.bytes, m.min_ram_gb, ram_gb, w, h, v)
        }
        None => image_plan(m.bytes, m.min_ram_gb, ram_gb, default_steps(m)),
    }
}

/// Installed GiB, read the way every `min_ram_gb` gate in lib.rs reads it:
/// hw.memsize is a power of two, so shift rather than divide by 1e9, which
/// would report 137 on a 128 GB Mac and defeat every gate written in GB.
fn machine_ram_gb() -> u64 {
    crate::hardware::static_profile().ram_bytes >> 30
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
/// A file name this app will write or read inside its own model folder.
///
/// Applied to BOTH halves of a registry entry. The download names were checked
/// and the roles were not, which is the asymmetry that matters: roles reach
/// `dir.join(file)` and become an argument to the engine, so "/etc/passwd" or
/// "../../elsewhere" there was a path out of the folder by way of a text file.
pub fn is_plain_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.starts_with('.')
        && !name.contains('\0')
}

pub fn download_files(download: &Value) -> Result<Vec<(String, String)>, String> {
    let list = download["files"].as_array().ok_or("that model has no verified download")?;
    let mut out = Vec::new();
    for f in list {
        let url = f["url"].as_str().unwrap_or_default();
        let name = f["as"].as_str().unwrap_or_default();
        if !url.starts_with("https://") {
            return Err("that model has a download that is not https".into());
        }
        if !is_plain_name(name) {
            return Err(format!("that model asks to write a file called {name:?}"));
        }
        out.push((url.to_string(), name.to_string()));
    }
    if out.is_empty() {
        return Err("that model has no verified download".into());
    }
    Ok(out)
}

/// Two flags, not one.
///
/// They were the same flag, on the stated reasoning that only one of a download
/// and a generation runs at a time. Nothing enforced that: busy_flag guards two
/// GENERATIONS against each other and says nothing about a download, which runs
/// on its own blocking thread. So starting a generation during a download reset
/// the shared flag and threw away a cancellation already asked for, and
/// cancelling either one stopped whichever of the two was running.
fn install_cancel_flag() -> &'static AtomicBool {
    static FLAG: OnceLock<AtomicBool> = OnceLock::new();
    FLAG.get_or_init(|| AtomicBool::new(false))
}

fn generate_cancel_flag() -> &'static AtomicBool {
    static FLAG: OnceLock<AtomicBool> = OnceLock::new();
    FLAG.get_or_init(|| AtomicBool::new(false))
}

#[tauri::command]
pub async fn image_models() -> Result<Vec<ImageModel>, String> {
    models_now()
}

/// The catalogue with this Mac's verdict on it, on the calling thread.
///
/// The command above is `async` because Tauri wants it so; the work is a
/// registry read and some arithmetic. The API path in imgapi.rs runs on a plain
/// socket thread with no runtime to await on, so the body lives here and both
/// callers get the same answer rather than a second implementation of it.
pub fn models_now() -> Result<Vec<ImageModel>, String> {
    let dir = model_root();
    let mut list = load_registry(&crate::galactus_root()?)?;
    let ram_gb = machine_ram_gb();
    for m in list.iter_mut() {
        m.installed = model_installed(&dir, m);
        // The per-machine verdict rides on the same answer as `installed`,
        // for the same reason: the view needs one call to paint a card, and
        // both facts are properties of this Mac rather than of the registry.
        let plan = plan_for(m, ram_gb);
        m.usable = plan.usable;
        m.reason = plan.reason;
        m.max_side = plan.max_side;
        m.recommended_steps = plan.recommended_steps;
        m.need_gb = plan.need_gb;
        m.max_frames = plan.max_frames;
    }
    Ok(list)
}

/// Download every file of a model, reporting progress as it goes.
/// Download every file of a model, reporting progress as it goes.
///
/// Rewritten after an audit found three ways it hurt someone: it skipped any
/// file that already had bytes in it, so an interrupted download of seven
/// gigabytes came back as an installed and unusable model; it emitted a
/// progress event nothing consumed, so the user watched a frozen "Downloading"
/// for twenty minutes; and it ran curl on the async runtime, holding a worker
/// for the whole download.
#[tauri::command]
pub async fn image_install(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let list = load_registry(&crate::galactus_root()?)?;
    let m = list.into_iter().find(|m| m.id == id).ok_or("no such image model")?;
    let dir = model_root();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let files = download_files(&m.download)?;
    // Before a single byte: a download that fills the disk takes the machine
    // down with it, and the size is known in advance.
    let have: u64 = files
        .iter()
        .map(|(_, name)| std::fs::metadata(dir.join(name)).map(|f| f.len()).unwrap_or(0))
        .sum();
    crate::require_free_space(&dir, m.bytes.saturating_sub(have))?;
    tauri::async_runtime::spawn_blocking(move || install_blocking(app, m, files, dir))
        .await
        .map_err(|e| format!("the download thread died: {e}"))?
}

fn install_blocking(
    app: tauri::AppHandle,
    m: ImageModel,
    files: Vec<(String, String)>,
    dir: PathBuf,
) -> Result<(), String> {
    let total = files.len();
    install_cancel_flag().store(false, Ordering::SeqCst);
    for (i, (url, name)) in files.iter().enumerate() {
        let dest = dir.join(name);
        let _ = app.emit(
            "galactus://image",
            json!({"kind": "install", "id": m.id, "file": name, "index": i + 1, "total": total}),
        );
        let mut child = std::process::Command::new("curl")
            // -C - resumes where an interrupted download stopped. The old code
            // skipped any non-empty file outright, which turned "resume" into
            // "pretend it is finished".
            .args(["-L", "-C", "-", "--fail", "--retry", "6", "--retry-delay", "4", "-s", "-o"])
            .arg(&dest)
            .arg(url)
            .spawn()
            .map_err(|e| format!("curl: {e}"))?;
        remember_child(Work::Install, child.id());
        loop {
            if install_cancel_flag().load(Ordering::SeqCst) {
                let _ = child.kill();
                let _ = child.wait();
                forget_child(Work::Install);
                return Err("cancelled".into());
            }
            match child.try_wait().map_err(|e| e.to_string())? {
                Some(status) => {
                    forget_child(Work::Install);
                    if !status.success() {
                        // 33 is curl's "this server cannot resume": the partial
                        // file is unusable and every later attempt would fail
                        // the same way, so it goes rather than staying forever.
                        if status.code() == Some(33) {
                            let _ = std::fs::remove_file(&dest);
                            return Err(format!(
                                "{name} could not be resumed: press download again to start it over"
                            ));
                        }
                        return Err(format!("download failed for {name}"));
                    }
                    break;
                }
                None => {
                    // Bytes on disk against bytes expected: the only honest
                    // progress available, since curl is silent in -s mode.
                    let done: u64 = files
                        .iter()
                        .map(|(_, n)| std::fs::metadata(dir.join(n)).map(|f| f.len()).unwrap_or(0))
                        .sum();
                    let pct = if m.bytes > 0 {
                        ((done as f64 / m.bytes as f64) * 100.0).min(99.0)
                    } else {
                        0.0
                    };
                    let _ = app.emit(
                        "galactus://image",
                        json!({"kind": "install", "id": m.id, "file": name, "index": i + 1,
                               "total": total, "pct": pct, "done": done, "bytes": m.bytes}),
                    );
                    std::thread::sleep(std::time::Duration::from_millis(700));
                }
            }
        }
    }
    // Only now, with every file downloaded, is this model installed. Written
    // last on purpose: a marker written any earlier would vouch for a download
    // that had not finished, which is the whole failure this exists to stop.
    match installed_size(&dir, &m) {
        Some(size) => {
            let _ = std::fs::write(install_marker(&dir, &m), size.to_string());
        }
        None => return Err(format!("{} finished with a file missing or empty", m.name)),
    }
    let _ = app.emit("galactus://image", json!({"kind": "installed", "id": m.id}));
    Ok(())
}

/// Cancel a download in progress. Same flag as a generation: only one of the
/// two can be running at a time.
#[tauri::command]
pub fn image_install_cancel() {
    install_cancel_flag().store(true, Ordering::SeqCst);
    kill_one(Work::Install);
}

/// Whether this build carries the image engine at all.
///
/// The view is offered on the strength of this: without it, someone downloads
/// seven gigabytes and only then learns that nothing can use them.
#[tauri::command]
pub fn image_engine_present() -> bool {
    crate::galactus_root().ok().and_then(|r| image_engine(&r)).is_some()
}

#[tauri::command]
pub fn image_cancel() {
    generate_cancel_flag().store(true, Ordering::SeqCst);
}

/// Generate one image. Returns the path it was written to.
#[tauri::command]
pub async fn image_generate(
    app: tauri::AppHandle,
    req: GenerateRequest,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || generate_sync(req, Some(app)))
        .await
        .map_err(|e| format!("the image thread died: {e}"))?
}

/// One picture or one clip, start to finish, on the calling thread.
///
/// WHY THIS IS SEPARATE from the command above: the relay serves
/// `/v1/images/generations` from a plain std::net thread that has no window and
/// no `AppHandle`, and the checks below are exactly the ones an API caller
/// needs most, because there is no disabled button on the other end of a curl.
/// Passing `None` costs only the progress events, which have nowhere to go.
pub fn generate_sync(
    req: GenerateRequest,
    app: Option<tauri::AppHandle>,
) -> Result<String, String> {
    if req.prompt.trim().is_empty() {
        return Err("write what you want to see first".into());
    }
    let root = crate::galactus_root()?;
    let list = load_registry(&root)?;
    let m = list.into_iter().find(|m| m.id == req.model).ok_or("no such image model")?;
    // The same gate the text models pass through, here rather than only in
    // the view: the agent side of the app reaches this command directly and
    // never sees a disabled button, so a model too big for this Mac has to be
    // refused at the door instead of being discovered as a swap spiral.
    let plan = plan_for(&m, machine_ram_gb());
    if !plan.usable {
        return Err(format!("{} {}", m.name, plan.reason));
    }
    let mut req = clamp_request(req, plan.max_side, m.video.as_ref());
    if let Some(v) = m.video.as_ref() {
        req.frames = req.frames.min(plan.max_frames.max(v.frame_step + v.frame_base));
        // The starting picture, for the models that take one. Checked as a
        // real file here, where the sentence can still name it: the engine's
        // own failure is a stat error deep in a log.
        if !req.init_image.is_empty() && !Path::new(&req.init_image).is_file() {
            return Err(format!("there is no picture at {}", req.init_image));
        }
        if v.needs_init_image && req.init_image.is_empty() {
            return Err(format!("{} needs a starting picture", m.name));
        }
        if !req.ref_audio.is_empty() && !Path::new(&req.ref_audio).is_file() {
            return Err(format!("there is no audio file at {}", req.ref_audio));
        }
        if v.needs_ref_audio && req.ref_audio.is_empty() {
            return Err(format!("{} needs a voice: pick a WAV file first", m.name));
        }
        if !v.needs_ref_audio {
            req.ref_audio.clear();
        }
        if !v.needs_init_image && !v.accepts_init_image {
            // A model that was not trained to start from a picture ignores or
            // mangles one; dropping it silently would be worse than saying so.
            req.init_image.clear();
        }
    } else {
        req.init_image.clear();
    }
    let dir = model_root();
    if !model_installed(&dir, &m) {
        return Err(format!("{} is not installed yet", m.name));
    }
    let bin = image_engine(&root).ok_or(
        "the image engine is missing from this build",
    )?;
    let out_dir = image_root();
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // WebM for video, and this choice is why the engine was rebuilt with
    // SD_WEBM: its default container is MJPEG in AVI, which WKWebView cannot
    // play, so the gallery would have shown tiles the app cannot open.
    let ext = if m.is_video() { "webm" } else { "png" };
    let out = out_dir.join(format!("galactus-{stamp}.{ext}"));
    let args = generate_argv(&dir, &m, &req, &out, plan.stream_layers);
    // One at a time, decided in Rust. The view has a `busy` flag, but the model
    // calls the same command through generate_image and cannot see it: two SDXL
    // runs at ten gigabytes each is a machine that stops responding.
    if busy_flag().swap(true, Ordering::SeqCst) {
        return Err("an image is already being made: wait for it, or stop it first".into());
    }
    generate_cancel_flag().store(false, Ordering::SeqCst);
    let done = run_generation(app, bin, args, out);
    busy_flag().store(false, Ordering::SeqCst);
    done
}

fn busy_flag() -> &'static AtomicBool {
    static FLAG: OnceLock<AtomicBool> = OnceLock::new();
    FLAG.get_or_init(|| AtomicBool::new(false))
}

fn run_generation(
    app: Option<tauri::AppHandle>,
    bin: PathBuf,
    args: Vec<String>,
    out: PathBuf,
) -> Result<String, String> {
    /// The view's progress and result events, when there is a view.
    fn say(app: &Option<tauri::AppHandle>, payload: Value) {
        if let Some(a) = app {
            let _ = a.emit("galactus://image", payload);
        }
    }
    // The pipe readers moved into read_engine_stream, which brings its own
    // imports: these two were left behind by that move.
    use std::process::{Command, Stdio};

    let mut child = Command::new(&bin)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("image engine: {e}"))?;
    remember_child(Work::Generate, child.id());

    // BOTH pipes are read by threads, and the wait loop waits for nothing else.
    //
    // Reading stdout inline was two bugs in one line. It blocks until the pipe
    // closes, which is when the engine exits, so the cancel check below only ran
    // after the work was done: Stop did nothing for thirty seconds and then
    // deleted the image that had just been written. And it collected the wrong
    // stream: the engine prints its INFO lines to stdout and its errors to
    // stderr, so a failure was reported to the user as the tail of the chatter
    // while the actual reason was thrown away.
    let lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    if let Some(err) = child.stderr.take() {
        let app2 = app.clone();
        let sink = lines.clone();
        std::thread::spawn(move || {
            read_engine_stream(err, sink, app2);
        });
    }
    if let Some(outp) = child.stdout.take() {
        let sink = lines.clone();
        let app3 = app.clone();
        std::thread::spawn(move || {
            // The step counter goes to STDOUT, which this passed None for, so
            // the progress bar it feeds never moved: the user waited the whole
            // twenty to thirty seconds of a generation with nothing on screen.
            // Measured by running sd-cli directly, five progress lines on
            // stdout and none on stderr. Both are given the handle rather than
            // just the one that happens to carry it today: parse_progress only
            // fires on a progress line, so a stream that has none costs
            // nothing.
            read_engine_stream(outp, sink, app3);
        });
    }

    let mut cancelled_first = false;
    loop {
        if !cancelled_first && generate_cancel_flag().load(Ordering::SeqCst) {
            cancelled_first = true;
            let _ = child.kill();
        }
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => {
                forget_child(Work::Generate);
                if cancelled_first {
                    // Only when the user asked BEFORE it finished: an image that
                    // completed on its own is theirs, whatever was pressed after.
                    let _ = std::fs::remove_file(&out);
                    say(&app, json!({"kind": "cancelled"}));
                    return Err("cancelled".into());
                }
                if !status.success() {
                    let tail = tail_of(&lines);
                    say(&app, json!({"kind": "failed", "log": tail}));
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
        return Err(format!(
            "the engine finished but wrote no image{}",
            with_reason(&lines)
        ));
    }
    // H3's clips carry PCM audio the WebM spec forbids, and WKWebView refuses
    // the whole file for it (MEDIA_ERR_SRC_NOT_SUPPORTED, measured). The clip
    // is split here, while it is still ours: a spec-clean video-only WebM
    // back onto the same path, the sound as a WAV beside it. A file the
    // splitter cannot parse is left exactly as the engine wrote it.
    if out.extension().map(|e| e == "webm").unwrap_or(false) {
        if let Some(split) = crate::webm::split_audio(&written) {
            if let Some(wav) = split.wav {
                if std::fs::write(&out, &split.webm).is_ok() {
                    let _ = std::fs::write(out.with_extension("wav"), &wav);
                }
            }
        }
    }
    if looks_blank(&written) {
        // A flat square, which is what a decode that failed on this backend
        // leaves behind. Handing it over as a result would read as the app
        // being broken, so the failure is named rather than shown.
        //
        // KEPT, not deleted. The test is a size heuristic with wide margins,
        // and a wide margin is not a certainty: ask for a white square on a
        // white background and a real, correct PNG compresses down into the
        // same range. Deleting it threw away a minute of the machine's work
        // with no way to look at what was actually produced. It is set aside
        // under a name that says what happened, and the path is in the error.
        let kept = out.with_extension("suspect.png");
        let where_ = match std::fs::rename(&out, &kept) {
            Ok(()) => kept.to_string_lossy().to_string(),
            Err(_) => out.to_string_lossy().to_string(),
        };
        say(&app, json!({"kind": "failed", "log": "blank"}));
        return Err(format!(
            "the engine produced what looks like an empty image: this model may not run \
             correctly here. It was kept at {where_} in case it is not{}",
            with_reason(&lines)
        ));
    }
    let path = out.to_string_lossy().to_string();
    say(&app, json!({"kind": "done", "path": path.clone()}));
    Ok(path)
}

/// How many engine lines are kept for a failure message.
const LOG_TAIL: usize = 40;

/// Read one engine pipe, emitting progress and keeping the rest.
///
/// Split on carriage returns as well as newlines: the progress bar is one line
/// rewritten in place, so a reader that waited for '\n' would see nothing until
/// the end.
fn read_engine_stream(
    pipe: impl std::io::Read,
    sink: Arc<Mutex<Vec<String>>>,
    progress_to: Option<tauri::AppHandle>,
) {
    use std::io::{BufReader, Read};
    let mut reader = BufReader::new(pipe);
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    while reader.read(&mut byte).map(|n| n == 1).unwrap_or(false) {
        if byte[0] == b'\r' || byte[0] == b'\n' {
            let line = String::from_utf8_lossy(&buf).trim().to_string();
            buf.clear();
            if line.is_empty() {
                continue;
            }
            match (parse_progress(&line), &progress_to) {
                (Some((done, total)), Some(app)) => {
                    let _ = app.emit(
                        "galactus://image",
                        json!({"kind": "step", "done": done, "total": total}),
                    );
                }
                _ => {
                    // Everything that is not the bar is kept, both streams
                    // together, because the useful sentence can be on either.
                    if let Ok(mut v) = sink.lock() {
                        if v.len() >= LOG_TAIL {
                            v.remove(0);
                        }
                        v.push(line);
                    }
                }
            }
        } else {
            buf.push(byte[0]);
        }
    }
}

/// The last engine lines, for a failure message.
fn tail_of(lines: &Arc<Mutex<Vec<String>>>) -> String {
    lines
        .lock()
        .map(|v| v.iter().rev().take(8).rev().cloned().collect::<Vec<_>>().join("\n"))
        .unwrap_or_default()
}

/// An engine error appended to our own sentence, when there is one worth having.
fn with_reason(lines: &Arc<Mutex<Vec<String>>>) -> String {
    let said = lines
        .lock()
        .map(|v| {
            v.iter()
                .rev()
                .find(|l| l.contains("ERROR") || l.contains("error"))
                .cloned()
                .unwrap_or_default()
        })
        .unwrap_or_default();
    if said.is_empty() { String::new() } else { format!(": {said}") }
}

/// The pid of the child working right now, so shutdown can end it.
///
/// The app already kills llama-server, the PTYs and the connectors on exit, for
/// the reason stated there: an abandoned engine keeps gigabytes pinned. An image
/// process is the same thing for ten of them, and a curl left running writes
/// seven more to the disk after the window has gone.
/// One slot per KIND of work, for the same reason there are two cancel flags:
/// a download and a generation can be running at once, and a single slot meant
/// whichever started second erased the first. Cancelling the download then
/// killed the generation, or nothing at all.
static INSTALL_CHILD: OnceLock<Mutex<Option<u32>>> = OnceLock::new();
static GENERATE_CHILD: OnceLock<Mutex<Option<u32>>> = OnceLock::new();

#[derive(Clone, Copy)]
pub(crate) enum Work {
    Install,
    Generate,
}

fn child_slot(which: Work) -> &'static Mutex<Option<u32>> {
    match which {
        Work::Install => INSTALL_CHILD.get_or_init(|| Mutex::new(None)),
        Work::Generate => GENERATE_CHILD.get_or_init(|| Mutex::new(None)),
    }
}

pub(crate) fn remember_child(which: Work, pid: u32) {
    if let Ok(mut slot) = child_slot(which).lock() {
        *slot = Some(pid);
    }
}

pub(crate) fn forget_child(which: Work) {
    if let Ok(mut slot) = child_slot(which).lock() {
        *slot = None;
    }
}

fn kill_one(which: Work) {
    let pid = child_slot(which).lock().ok().and_then(|s| *s);
    if let Some(pid) = pid {
        // SAFETY: a plain kill(2) on a pid this process spawned; ESRCH on an
        // already-dead child is not an error here.
        unsafe { crate::kill(pid as i32, 9) };
    }
}

/// Kill every image process. Called from the app's exit handler, where both
/// have to go: an abandoned curl keeps writing gigabytes after the window is
/// gone, and an abandoned sd-cli keeps ten of them pinned.
pub(crate) fn kill_child() {
    kill_one(Work::Install);
    kill_one(Work::Generate);
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
///
/// `async` on purpose: a 3 MB png read and base64'd is tens of milliseconds,
/// and a synchronous Tauri command runs on the main thread. Twelve of them in a
/// row is a visibly stuttering gallery.
#[tauri::command(async)]
pub fn image_read(path: String) -> Result<String, String> {
    let full = ours(&path)?;
    let bytes = std::fs::read(&full).map_err(|e| e.to_string())?;
    // A clip is minutes of work and tens of megabytes; base64 through a
    // command is the same policy decision as for a PNG, only bigger. The
    // webview's data: allowance already covers video elements.
    let mime = match full.extension().and_then(|e| e.to_str()) {
        Some("webm") => "video/webm",
        // The soundtrack a clip's PCM was carried off into; WebKit decodes
        // WAV natively, which is the whole reason it exists.
        Some("wav") => "audio/wav",
        _ => "image/png",
    };
    Ok(format!("data:{mime};base64,{}", b64(&bytes)))
}

/// Copy a generated picture or clip into ~/Downloads, and say where it landed.
///
/// WHY A COPY AND NOT A SAVE PANEL. The file already exists, in a folder inside
/// Application Support that nobody can be expected to navigate to: what is
/// missing is a way OUT of the app, in one click, to the one place every Mac
/// user knows how to find. A panel would be a second dialog on top of a
/// decision that has no options worth making.
///
/// A clip's soundtrack travels with it. The pair is what the app produced (see
/// webm.rs on why the PCM had to leave the container), and a WebM exported
/// alone is a silent clip the user will believe is broken.
#[tauri::command(async)]
pub fn image_export(path: String) -> Result<String, String> {
    let full = ours(&path)?;
    let home = std::env::var("HOME").map_err(|_| "no home folder".to_string())?;
    let downloads = PathBuf::from(home).join("Downloads");
    std::fs::create_dir_all(&downloads).map_err(|e| e.to_string())?;
    let name = full
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "galactus.png".to_string());
    let dest = free_name(&downloads, &name);
    std::fs::copy(&full, &dest).map_err(|e| format!("cannot save it: {e}"))?;
    let wav = full.with_extension("wav");
    if wav.is_file() {
        let stem = dest.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let _ = std::fs::copy(&wav, downloads.join(format!("{stem}.wav")));
    }
    Ok(dest.to_string_lossy().to_string())
}

/// `name` in `dir`, or `name-2`, `name-3`... so an export never silently
/// replaces a file the user already had there.
fn free_name(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (name.to_string(), String::new()),
    };
    for n in 2..1000 {
        let candidate = dir.join(format!("{stem}-{n}{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    first
}

/// A path inside the images folder, canonicalised, or an error.
fn ours(path: &str) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(image_root()).map_err(|e| e.to_string())?;
    let full = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    // starts_with on a Path compares components, so a sibling folder called
    // "imagesEvil" cannot pass by sharing a prefix.
    if !full.starts_with(&root) {
        return Err("that image is not one of ours".into());
    }
    let ok = full
        .extension()
        .map(|e| e == "png" || e == "webm" || e == "wav")
        .unwrap_or(false);
    if !ok {
        return Err("that is not one of our images or clips".into());
    }
    Ok(full)
}

/// Base64, by hand: one small function against one more dependency.
pub fn b64(bytes: &[u8]) -> String {
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

/// Delete one generated image, and a clip's soundtrack with it: a WAV whose
/// WebM is gone is noise on disk nobody can reach from the gallery.
#[tauri::command(async)]
pub fn image_forget(path: String) -> Result<(), String> {
    let full = ours(&path)?;
    if full.extension().map(|e| e == "webm").unwrap_or(false) {
        let _ = std::fs::remove_file(full.with_extension("wav"));
    }
    std::fs::remove_file(full).map_err(|e| e.to_string())
}

/// Everything generated so far, newest first.
#[tauri::command(async)]
pub fn image_gallery() -> Vec<String> {
    let mut files: Vec<(std::time::SystemTime, String)> = std::fs::read_dir(image_root())
        .map(|rd| {
            rd.flatten()
                .filter(|e| {
                    e.path()
                        .extension()
                        .map(|x| x == "png" || x == "webm")
                        .unwrap_or(false)
                })
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
            kind: "image".into(),
            video: None,
            licence: json!(""),
            bytes: 1,
            roles: map,
            download: json!({}),
            defaults: json!({}),
            min_ram_gb: 8,
            measured: vec![],
            note: json!(""),
            installed: false,
            vae_on_cpu: false,
            usable: false,
            reason: String::new(),
            max_side: 0,
            recommended_steps: None,
            need_gb: 0,
            max_frames: 0,
        }
    }

    /// A video model shaped like Wan 2.2 TI2V: one diffusion file, a frame
    /// grid of 4k + 1, and a starting picture accepted but not required.
    fn video_model() -> ImageModel {
        let mut m = model(&[("diffusion", "wan.gguf"), ("t5xxl", "t5.gguf"), ("vae", "vae.st")]);
        m.kind = "video".into();
        m.defaults = json!({"steps": 20, "cfg": 6.0, "width": 832, "height": 480});
        m.video = Some(spec());
        m
    }

    fn spec() -> super::VideoSpec {
        super::VideoSpec {
            frames: 81,
            frame_step: 4,
            frame_base: 1,
            fps: 24,
            flow_shift: Some(3.0),
            sampling_method: Some("euler".into()),
            rng: None,
            high_noise_steps: None,
            offload_to_cpu: true,
            needs_init_image: false,
            accepts_init_image: true,
            needs_ref_audio: false,
            fast_decode: false,
            cache_mode: None,
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
            frames: 0,
            init_image: String::new(),
            ref_audio: String::new(),
            fast: false,
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
        let argv = generate_argv(Path::new("/models"), &m, &req("a cat"), Path::new("/out/x.png"), false);
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
    fn the_cpu_vae_flag_is_emitted_only_when_the_model_asks_for_it() {
        // Flux on Metal saturates its VAE to a white image on the GPU, measured,
        // and only the CPU path produces a real picture. The flag is a property
        // of the model, so it appears for a model that sets it and for no other.
        let mut flux = model(&[("diffusion", "flux.gguf"), ("vae", "ae.gguf")]);
        flux.vae_on_cpu = true;
        let argv = generate_argv(Path::new("/models"), &flux, &req("a cat"), Path::new("/out/x.png"), false);
        assert!(argv.iter().any(|a| a == "--vae-on-cpu"), "Flux must decode its VAE on the CPU");

        let sdxl = model(&[("model", "sdxl.gguf")]);
        let argv = generate_argv(Path::new("/models"), &sdxl, &req("a cat"), Path::new("/out/x.png"), false);
        assert!(!argv.iter().any(|a| a == "--vae-on-cpu"), "every other model decodes on the GPU");
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
            false,
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
        let c = clamp_request(r, 0, None);
        assert_eq!(c.width, 2048);
        assert_eq!(c.height, 704);
        assert_eq!(c.steps, 100);
        assert_eq!(c.cfg, 7.0, "a non-finite guidance falls back, it does not propagate");
    }

    #[test]
    fn the_plans_ceiling_binds_the_request_even_past_the_view() {
        // Defense in depth, like ctx_within_model: the view already offers
        // nothing above max_side, but this command is callable without it.
        let mut r = req("x");
        r.width = 2048;
        r.height = 1536;
        let c = clamp_request(r, 1024, None);
        assert_eq!(c.width, 1024);
        assert_eq!(c.height, 1024);
        // A ceiling that is not a multiple of 64 is floored to one, so the
        // latent still divides cleanly.
        let mut odd = req("x");
        odd.width = 2048;
        let c = clamp_request(odd, 1000, None);
        assert_eq!(c.width, 960);
        // Zero means no plan was consulted and keeps the engine-wide bound.
        let mut free = req("x");
        free.width = 2048;
        assert_eq!(clamp_request(free, 0, None).width, 2048);
    }

    #[test]
    fn a_model_too_big_for_the_machine_is_blocked_with_a_reason() {
        use super::image_plan;
        // Qwen-Image's real figures against a 16 GB Mac: 21.4 GB of weights
        // cannot fit under any budget that machine has.
        let p = image_plan(21_418_077_382, 32, 16, 20);
        assert!(!p.usable, "21 GB of weights on a 16 GB Mac must be refused");
        assert_eq!(p.max_side, 0);
        assert!(p.need_gb >= 32, "the registry minimum stays a floor: {}", p.need_gb);
        assert!(p.reason.contains("16"), "the reason names this machine: {}", p.reason);
        assert!(
            p.reason.contains(&p.need_gb.to_string()),
            "and what it would take: {}",
            p.reason
        );
    }

    #[test]
    fn the_same_models_run_at_a_full_square_on_a_big_mac() {
        use super::image_plan;
        // Measured, not hoped: every shipped model has produced a 1024 image
        // on a 128 GB Mac, so the plan must allow at least that there. The
        // bytes are the real registry figures.
        for bytes in [7_270_000_000u64, 20_537_837_720, 21_418_077_382, 23_171_010_812] {
            let p = image_plan(bytes, 32, 128, 20);
            assert!(p.usable);
            assert!(p.max_side >= 1024, "{bytes} bytes must reach 1024 on 128 GB, got {}", p.max_side);
        }
        // And the small model runs on a small Mac: SD 1.5 on 8 GB, at 1024.
        let sd15 = image_plan(1_770_000_000, 8, 8, 20);
        assert!(sd15.usable, "SD 1.5 fits on an 8 GB Mac");
        assert!(sd15.max_side >= 1024, "got {}", sd15.max_side);
    }

    #[test]
    fn max_side_never_grows_when_ram_shrinks() {
        use super::image_plan;
        // SDXL's real size across the machines that exist. The ceiling may
        // only fall as the memory does, and it must actually fall: a constant
        // would mean the plan is not reading the machine at all.
        let sides: Vec<u32> = [128u64, 64, 32, 24, 16]
            .iter()
            .map(|ram| image_plan(7_270_000_000, 16, *ram, 20).max_side)
            .collect();
        for w in sides.windows(2) {
            assert!(w[0] >= w[1], "the ceiling rose as RAM fell: {sides:?}");
        }
        assert!(sides[0] > sides[sides.len() - 1], "the ceiling never moved: {sides:?}");
    }

    #[test]
    fn the_system_reserve_is_never_given_to_the_model() {
        use super::image_plan;
        // 13 GB of weights on a 16 GB Mac: the bytes fit in RAM, but only by
        // eating the 2 GB macOS keeps for itself, so the plan refuses.
        let p = image_plan(13_000_000_000, 8, 16, 20);
        assert!(!p.usable, "weights that fit only inside the reserve are refused");
        // 12 GB leaves room for the reserve and the smallest decode, and for
        // nothing more: the ceiling lands on the bottom rung.
        let q = image_plan(12_000_000_000, 8, 16, 20);
        assert!(q.usable);
        assert_eq!(q.max_side, 512, "one rung is all the room there is");
    }

    #[test]
    fn a_tight_machine_gets_a_shorter_first_run() {
        use super::image_plan;
        // SD 3.5 Large on the smallest Mac its registry minimum allows: it
        // runs, but at the edge, so the plan trims its 28 step default.
        let tight = image_plan(20_537_837_720, 32, 32, 28);
        assert!(tight.usable);
        assert_eq!(tight.recommended_steps, Some(20));
        // The same model with room to spare keeps its own default.
        let roomy = image_plan(20_537_837_720, 32, 128, 28);
        assert_eq!(roomy.recommended_steps, None);
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
    fn a_download_stopped_half_way_does_not_count_as_installed() {
        // The case the non-empty test could not see. curl writes as it goes, so
        // an interrupted download is a large NON-EMPTY file: three gigabytes of
        // a five gigabyte model passed every check, and sd-cli then failed to
        // load it, which reads as a broken app rather than as a download that
        // needs finishing.
        let dir = std::env::temp_dir().join(format!("galactus-img-half-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut m = model(&[("model", "a.gguf")]);
        m.bytes = 1000;

        std::fs::write(dir.join("a.gguf"), vec![0u8; 600]).unwrap();
        assert!(!model_installed(&dir, &m), "600 of 1000 bytes is not an installed model");

        // The declared size is rounded, so what is nearly all there passes.
        std::fs::write(dir.join("a.gguf"), vec![0u8; 970]).unwrap();
        assert!(model_installed(&dir, &m), "within the rounding of the registry figure");

        // And the marker is exact: it vouches for the size the install ended
        // with, so it cannot outlive the file it was written for.
        std::fs::write(dir.join("a.gguf"), vec![0u8; 600]).unwrap();
        std::fs::write(dir.join(".m.installed"), "600").unwrap();
        assert!(model_installed(&dir, &m), "the marker agrees with what is there");
        std::fs::write(dir.join("a.gguf"), vec![0u8; 601]).unwrap();
        assert!(!model_installed(&dir, &m), "a marker that no longer matches is not trusted");

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
    fn the_lines_sd_cli_actually_prints_are_the_ones_that_parse() {
        // Captured from a real run of the bundled sd-cli (4 steps, 256 square),
        // bytes as they came, rather than a format written from memory. All
        // four were on STDOUT, which the reader was passing None for, so the
        // progress bar never moved during a generation.
        let real = [
            "  |============>                                     | 1/4 - 1.41s/it\u{1b}[K",
            "  |=========================>                        | 2/4 - 6.88it/s\u{1b}[K",
            "  |=====================================>            | 3/4 - 6.92it/s\u{1b}[K",
            "  |==================================================| 4/4 - 6.90it/s\u{1b}[K",
        ];
        let got: Vec<_> = real.iter().filter_map(|l| parse_progress(l)).collect();
        assert_eq!(got, vec![(1, 4), (2, 4), (3, 4), (4, 4)], "every step is read");

        // The model LOADING bar has the same shape and is not a step count.
        // It parses to a pair, which is harmless: the view shows a fraction
        // that reaches 1/1 and then restarts for the steps.
        assert_eq!(parse_progress("| 196/196 - 605.31MB/s\u{1b}[K"), Some((196, 196)));
        // And ordinary chatter is not a fraction at all.
        assert_eq!(parse_progress("loading model from ..."), None);
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
            false,
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
        let argv = generate_argv(Path::new("/m"), &model(&[("model", "s.gguf")]), &req("x"), &out, false);
        assert_eq!(argv.iter().filter(|a| a.ends_with(".png")).count(), 1);
    }

    // ------------------------------------------------------------- video

    #[test]
    fn a_video_model_switches_the_engine_into_vid_gen() {
        let m = video_model();
        let argv = generate_argv(Path::new("/m"), &m, &req("a cat"), Path::new("/out/x.webm"), false);
        assert_eq!(argv[0], "-M", "the mode is the first thing a reader sees");
        assert_eq!(argv[1], "vid_gen");
        for flag in ["--video-frames", "--fps", "--diffusion-fa", "--flow-shift", "--sampling-method"] {
            assert!(argv.iter().any(|a| a == flag), "{flag} missing");
        }
        assert!(argv.iter().any(|a| a == "--offload-to-cpu"));
        // An image model emits none of it.
        let argv = generate_argv(
            Path::new("/m"),
            &model(&[("model", "s.gguf")]),
            &req("a cat"),
            Path::new("/out/x.png"),
            false,
        );
        assert!(!argv.iter().any(|a| a == "-M" || a == "--video-frames"));
    }

    #[test]
    fn streaming_rides_on_its_budget_or_not_at_all() {
        // --stream-layers is documented as a no-op without --max-vram, so the
        // pair travels together. A plan that says no emits neither.
        let m = video_model();
        let on = generate_argv(Path::new("/m"), &m, &req("x"), Path::new("/o/x.webm"), true);
        let at = on.iter().position(|a| a == "--max-vram").expect("--max-vram");
        assert_eq!(on[at + 1], "-1");
        assert!(on.iter().any(|a| a == "--stream-layers"));
        let off = generate_argv(Path::new("/m"), &m, &req("x"), Path::new("/o/x.webm"), false);
        assert!(!off.iter().any(|a| a == "--max-vram" || a == "--stream-layers"));
    }

    #[test]
    fn frame_counts_land_on_the_models_grid() {
        use super::align_frames;
        let v = spec(); // 4k + 1
        assert_eq!(align_frames(0, &v), 81, "zero means the model's default");
        assert_eq!(align_frames(81, &v), 81, "a count already on the grid stays");
        assert_eq!(align_frames(82, &v), 85, "rounded UP, the way the engine rounds");
        assert_eq!(align_frames(1, &v), 1, "the shortest legal clip");
        // H3's grid: 17k + 5.
        let h3 = super::VideoSpec { frames: 56, frame_step: 17, frame_base: 5, ..spec() };
        assert_eq!(align_frames(56, &h3), 56);
        assert_eq!(align_frames(57, &h3), 73);
        assert_eq!(align_frames(2, &h3), 5, "never below the base");
    }

    #[test]
    fn video_sizes_round_to_32_because_the_trained_shapes_demand_it() {
        // 864 x 480 and 832 x 480 are the shapes these models were trained
        // at, and neither side divides by 64: the image rounding would move
        // every single run off the trained shape.
        let mut r = req("x");
        r.width = 864;
        r.height = 480;
        let v = spec();
        let c = clamp_request(r, 0, Some(&v));
        assert_eq!((c.width, c.height), (864, 480), "the trained shape survives");
        let mut odd = req("x");
        odd.width = 850;
        odd.height = 470;
        let c = clamp_request(odd, 0, Some(&v));
        assert_eq!((c.width, c.height), (864, 480), "nearby oddities land on it");
    }

    #[test]
    fn the_machine_verdict_scales_with_the_clip_not_the_square() {
        use super::video_plan;
        let v = spec();
        // TI2V-5B's real figures: 12.9 GB of files, 832 x 480. A 16 GB Mac
        // is refused by its registry floor; 32 GB runs a real clip; 128 GB
        // reaches this app's longest offer.
        let small = video_plan(12_852_648_256, 24, 16, 832, 480, &v);
        assert!(!small.usable);
        assert_eq!(small.max_frames, 0);
        let mid = video_plan(12_852_648_256, 24, 32, 832, 480, &v);
        assert!(mid.usable, "{}", mid.reason);
        assert!(mid.max_frames >= 33, "a real clip, not a slideshow: {}", mid.max_frames);
        assert_eq!(mid.max_frames % 4, 1, "the answer sits on the model's grid");
        let big = video_plan(12_852_648_256, 24, 128, 832, 480, &v);
        assert_eq!(big.max_frames, 241, "the cap is patience, not memory");
        // H3 against the machines that matter: refused at 32, runs at 64.
        let h3 = super::VideoSpec { frames: 56, frame_step: 17, frame_base: 5, ..spec() };
        assert!(!video_plan(42_810_976_776, 64, 32, 864, 480, &h3).usable);
        let h3_plan = video_plan(42_810_976_776, 64, 64, 864, 480, &h3);
        assert!(h3_plan.usable, "{}", h3_plan.reason);
        assert!(h3_plan.max_frames >= 22, "at least a second of clip: {}", h3_plan.max_frames);
    }

    #[test]
    fn streaming_is_decided_by_the_room_not_the_registry() {
        use super::video_plan;
        let v = spec();
        // H3 on a 64 GB Mac: the weights are more than half the budget, so
        // the plan buys room with streaming. On 128 GB they are not, and the
        // few percent of throughput are kept.
        assert!(video_plan(42_810_976_776, 64, 64, 864, 480, &v).stream_layers);
        assert!(!video_plan(42_810_976_776, 64, 128, 864, 480, &v).stream_layers);
    }

    #[test]
    fn the_starting_picture_travels_only_where_it_can_mean_something() {
        let m = video_model();
        let mut r = req("x");
        r.init_image = "/tmp/start.png".into();
        let argv = generate_argv(Path::new("/m"), &m, &r, Path::new("/o/x.webm"), false);
        let at = argv.iter().position(|a| a == "-i").expect("-i present");
        assert_eq!(argv[at + 1], "/tmp/start.png");
        // And an empty one emits nothing rather than an empty argument.
        let argv = generate_argv(Path::new("/m"), &m, &req("x"), Path::new("/o/x.webm"), false);
        assert!(!argv.iter().any(|a| a == "-i"));
    }

    #[test]
    fn the_speech_model_gets_its_voice_and_its_encoder() {
        // The S2V shape: audio encoder as a role, WAV as a request field.
        // A missing --audio-encoder refuses loudly in the engine; a missing
        // --t5xxl renders zeros silently, which is why the role table must
        // carry t5xxl for this model and the registry entry lists it.
        let mut m = video_model();
        m.roles.insert("audio_encoder".into(), "w2v.gguf".into());
        m.roles.insert("t5xxl".into(), "umt5.gguf".into());
        if let Some(v) = m.video.as_mut() {
            v.needs_ref_audio = true;
        }
        let mut r = req("a person speaking");
        r.ref_audio = "/tmp/voice.wav".into();
        r.init_image = "/tmp/face.png".into();
        let argv = generate_argv(Path::new("/m"), &m, &r, Path::new("/o/x.webm"), false);
        for (flag, val) in [
            ("--audio-encoder", "/m/w2v.gguf"),
            ("--t5xxl", "/m/umt5.gguf"),
            ("--ref-audio", "/tmp/voice.wav"),
            ("-i", "/tmp/face.png"),
        ] {
            let at = argv.iter().position(|a| a == flag).unwrap_or_else(|| panic!("{flag} missing"));
            assert_eq!(argv[at + 1], val);
        }
    }

    #[test]
    fn the_two_wan_experts_share_their_settings_and_split_their_steps() {
        let mut m = video_model();
        m.roles.insert("high_noise_diffusion".into(), "high.gguf".into());
        if let Some(v) = m.video.as_mut() {
            v.high_noise_steps = Some(8);
        }
        let argv = generate_argv(Path::new("/m"), &m, &req("x"), Path::new("/o/x.webm"), false);
        let flag = argv.iter().position(|a| a == "--high-noise-diffusion-model").expect("expert file");
        assert_eq!(argv[flag + 1], "/m/high.gguf");
        let steps = argv.iter().position(|a| a == "--high-noise-steps").expect("expert steps");
        assert_eq!(argv[steps + 1], "8");
        // The cfg follows the request, as the published invocations do.
        let cfg = argv.iter().position(|a| a == "--high-noise-cfg-scale").expect("expert cfg");
        assert_eq!(argv[cfg + 1], "7.00");
        // A model without the second file gets none of these flags, even if a
        // registry entry carries the step count by mistake.
        let mut single = video_model();
        if let Some(v) = single.video.as_mut() {
            v.high_noise_steps = Some(8);
        }
        let argv = generate_argv(Path::new("/m"), &single, &req("x"), Path::new("/o/x.webm"), false);
        assert!(!argv.iter().any(|a| a.starts_with("--high-noise")));
    }
}
