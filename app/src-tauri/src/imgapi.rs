// Galactus, the picture and clip half of the local API.
//
// WHY THIS EXISTS. The relay in relay.rs fronts llama-server, so everything the
// network could ask this Mac for was text. The image engine was reachable only
// from the window: a Mac Studio serving a team could answer chat completions
// and nothing else, while sitting on the diffusion models that are the reason
// the machine has that much memory in the first place.
//
// WHY IT IS NOT PROXIED. There is no second HTTP server to forward to. sd-cli
// is a process that runs once per picture and exits, so this module IS the
// endpoint: it parses the request, runs the same `image::generate_sync` the
// window calls, and answers. That is also why the relay had to learn to read a
// body, which it never did for chat: a proxied stream needs no interpretation
// and a locally served route needs all of it.
//
// THE SHAPE IS OPENAI'S, where OpenAI has one. `/v1/images/generations` with
// `prompt`, `model`, `size`, `n` and `response_format` is what an SDK already
// speaks, so `client.images.generate(...)` against this port works with no
// Galactus-specific code. What OpenAI has no shape for, because it has no such
// product, is a clip driven by a WAV; those fields are additions with names
// that say what they are, and they are refused on models that cannot use them
// rather than ignored.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::image::{self, GenerateRequest, ImageModel};

/// Largest request body accepted, base64 payloads included.
///
/// A prompt is a few hundred bytes; this ceiling exists for the media fields,
/// where a minute of 16 kHz WAV is about two megabytes before base64 and a
/// starting picture a few more. Sixty-four megabytes is far above any honest
/// request and far below anything that would matter to a machine with the
/// memory to run these models.
pub const MAX_BODY: usize = 64 * 1024 * 1024;

/// What this module answers on. Anything else is not ours and goes to the
/// engine, which is why this returns an Option rather than a 404 by itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    /// Make a picture or a clip.
    Generate,
    /// What can be asked for, and what this Mac can actually run.
    Models,
}

pub fn route(method: &str, path: &str) -> Option<Route> {
    // The query string is not part of the routing decision: a client that
    // appends `?stream=false` must not fall through to the text engine.
    let path = path.split('?').next().unwrap_or(path);
    match (method, path) {
        // `/v1/videos/generations` is the same handler under the name a caller
        // reaches for when the output is a clip. One implementation: the model
        // decides which of the two it is, and a request that names a video
        // model on the images path is not a mistake worth refusing.
        ("POST", "/v1/images/generations") | ("POST", "/v1/videos/generations") => {
            Some(Route::Generate)
        }
        ("GET", "/v1/images/models") | ("GET", "/v1/videos/models") => Some(Route::Models),
        _ => None,
    }
}

pub struct Reply {
    pub status: u16,
    pub body: Vec<u8>,
}

impl Reply {
    fn of(status: u16, v: Value) -> Reply {
        Reply { status, body: v.to_string().into_bytes() }
    }

    /// An error in the shape every OpenAI SDK already knows how to raise.
    pub fn err(status: u16, message: &str) -> Reply {
        let kind = match status {
            400 => "invalid_request_error",
            409 => "conflict",
            503 => "service_unavailable",
            _ => "server_error",
        };
        Reply::of(status, json!({"error": {"message": message, "type": kind}}))
    }

    /// The bytes of a complete HTTP/1.1 response.
    ///
    /// `Connection: close` on purpose: this module answers one request per
    /// socket, and a keep-alive promise it does not honour would leave clients
    /// waiting for a second response on a socket nobody is reading.
    pub fn to_http(&self) -> Vec<u8> {
        let reason = match self.status {
            200 => "OK",
            400 => "Bad Request",
            409 => "Conflict",
            503 => "Service Unavailable",
            _ => "Internal Server Error",
        };
        let mut out = format!(
            "HTTP/1.1 {} {reason}\r\n\
             Content-Type: application/json\r\n\
             Access-Control-Allow-Origin: *\r\n\
             Content-Length: {}\r\n\
             Connection: close\r\n\r\n",
            self.status,
            self.body.len()
        )
        .into_bytes();
        out.extend_from_slice(&self.body);
        out
    }
}

/// How the caller wants the result handed back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fmt {
    /// The file itself, base64 in the JSON. OpenAI's default and ours.
    B64,
    /// Just where it landed on this Mac. For a clip this is the difference
    /// between a 27 MB response and a 90 byte one, and the caller is on the
    /// machine that holds the file often enough to matter.
    PathOnly,
}

/// Everything a generation needs, once the JSON has been believed or refused.
#[derive(Debug)]
pub struct Ask {
    pub model: ImageModel,
    pub req: GenerateRequest,
    pub fmt: Fmt,
    /// Files this module wrote for the engine, deleted when this is dropped.
    pub temp: TempFiles,
}

/// Temporary files that go away by themselves.
///
/// WHY A DROP GUARD AND NOT A CLEANUP LINE. The cleanup used to live on the one
/// path where everything succeeded, so a request that wrote 48 MB of inline
/// audio and was then refused ("this model makes pictures, not clips") left
/// those megabytes in TMPDIR for good, and nothing in the app ever sweeps that
/// folder. Every early return is a leak unless the deletion belongs to the
/// value itself.
#[derive(Debug, Default)]
pub struct TempFiles {
    pub paths: Vec<PathBuf>,
}

impl Drop for TempFiles {
    fn drop(&mut self) {
        for p in &self.paths {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// The folders a request arriving over the network may name.
fn media_dirs() -> Vec<PathBuf> {
    vec![image::api_inbox(), image::image_root()]
}

/// Resolve a caller-supplied path, or refuse it without saying what exists.
///
/// Two checks, and the order is the point. The path is normalised WITHOUT
/// touching the disk first, so a path outside the allowed folders is refused
/// with a message that reads the same whether or not the file is there: the
/// error used to quote the path back, which turned this endpoint into an
/// existence oracle for the whole disk. Only once a path is known to be ours is
/// the disk consulted, and canonicalisation is repeated then, so a symlink
/// planted inside the folder cannot point out of it.
fn confine(raw: &str) -> Result<PathBuf, String> {
    let want = if let Some(rest) = raw.strip_prefix("~/") {
        dirs_home().join(rest)
    } else {
        PathBuf::from(raw)
    };
    let mut flat = PathBuf::new();
    for part in want.components() {
        match part {
            std::path::Component::ParentDir => {
                flat.pop();
            }
            std::path::Component::CurDir => {}
            other => flat.push(other),
        }
    }
    let dirs = media_dirs();
    let outside = format!(
        "a path from the network has to be inside {}: put the file there, or send it inline as base64",
        image::api_inbox().to_string_lossy()
    );
    if !dirs.iter().any(|d| flat.starts_with(d)) {
        return Err(outside);
    }
    // The disk, now that the answer no longer leaks anything about it.
    let real = std::fs::canonicalize(&flat).map_err(|_| format!("there is no file at {}", flat.to_string_lossy()))?;
    let ok = dirs
        .iter()
        .filter_map(|d| std::fs::canonicalize(d).ok())
        .any(|d| real.starts_with(&d));
    if !ok {
        return Err(outside);
    }
    if !real.is_file() {
        return Err(format!("there is no file at {}", flat.to_string_lossy()));
    }
    Ok(real)
}

/// One media field: a path inside the allowed folders, or inline base64.
fn media_field(
    v: &Value,
    keys: [&str; 2],
    ext: &str,
    temp: &mut TempFiles,
) -> Result<String, String> {
    let Some(raw) = keys.iter().find_map(|k| v.get(*k).and_then(|s| s.as_str())) else {
        return Ok(String::new());
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(String::new());
    }
    if raw.starts_with('/') || raw.starts_with("~/") {
        return Ok(confine(raw)?.to_string_lossy().to_string());
    }
    let bytes = decode_b64(strip_data_url(raw))
        .ok_or_else(|| format!("{} is neither a path nor base64", keys[0]))?;
    let dir = image::api_inbox();
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot write to the inbox: {e}"))?;
    let p = temp_path(&dir, ext);
    std::fs::write(&p, &bytes).map_err(|e| format!("cannot write {}: {e}", p.to_string_lossy()))?;
    temp.paths.push(p.clone());
    Ok(p.to_string_lossy().to_string())
}

/// Read `size` in either of the two spellings a caller might use.
fn size_of(v: &Value, default: (u32, u32)) -> Result<(u32, u32), String> {
    if let Some(s) = v.get("size").and_then(|s| s.as_str()) {
        let (w, h) = s
            .split_once(['x', 'X', '*'])
            .ok_or_else(|| format!("size should look like 1024x1024, not {s:?}"))?;
        let (w, h) = (w.trim().parse::<u32>(), h.trim().parse::<u32>());
        return match (w, h) {
            (Ok(w), Ok(h)) if w > 0 && h > 0 => Ok((w, h)),
            _ => Err(format!("size should look like 1024x1024, not {s:?}")),
        };
    }
    let w = v.get("width").and_then(|x| x.as_u64()).unwrap_or(default.0 as u64) as u32;
    let h = v.get("height").and_then(|x| x.as_u64()).unwrap_or(default.1 as u64) as u32;
    Ok((w, h))
}

/// Pick the model a request meant, by id or by name, else a sensible one.
///
/// The fallback is deliberately narrow: the newest installed model this Mac can
/// actually run, preferring a picture model, because a caller that omitted
/// `model` wanted a picture and would be very surprised to wait six minutes for
/// a clip. When nothing is installed the message says so rather than failing
/// later inside the engine.
pub fn pick_model(want: &str, models: &[ImageModel]) -> Result<ImageModel, String> {
    let want = want.trim();
    if !want.is_empty() {
        return models
            .iter()
            .find(|m| m.id == want)
            .or_else(|| models.iter().find(|m| m.name.eq_ignore_ascii_case(want)))
            .cloned()
            .ok_or_else(|| {
                let known: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
                format!("no such model {want:?}. Installed or not, these exist: {}", known.join(", "))
            });
    }
    let ready: Vec<&ImageModel> = models.iter().filter(|m| m.installed && m.usable).collect();
    ready
        .iter()
        .find(|m| !m.is_video())
        .or(ready.first())
        .map(|m| (*m).clone())
        .ok_or_else(|| {
            "no image model is installed on this Mac yet: open Galactus, Images & video, \
             and download one"
                .to_string()
        })
}

/// Turn a request body into something the engine can be asked for, or say why not.
///
/// Pure apart from the temp files it writes for inline media, which is what
/// lets the whole contract be tested without an engine, a model or a socket.
pub fn parse_ask(v: &Value, models: &[ImageModel]) -> Result<Ask, String> {
    let prompt = v
        .get("prompt")
        .and_then(|p| p.as_str())
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .ok_or("prompt is required: say what you want to see")?
        .to_string();
    // `n` is accepted only at its one honest value. The engine makes one
    // picture per run and this Mac makes one at a time; answering `n: 4` by
    // silently returning one image is the kind of half-compatibility that
    // costs a caller an afternoon.
    if let Some(n) = v.get("n").and_then(|n| n.as_u64()) {
        if n != 1 {
            return Err("n must be 1: this endpoint makes one picture per request".into());
        }
    }
    let want = v.get("model").and_then(|m| m.as_str()).unwrap_or_default();
    let m = pick_model(want, models)?;
    if !m.installed {
        return Err(format!("{} is not downloaded on this Mac yet", m.name));
    }
    if !m.usable {
        return Err(format!("{} {}", m.name, m.reason));
    }
    let dw = m.defaults["width"].as_u64().unwrap_or(1024) as u32;
    let dh = m.defaults["height"].as_u64().unwrap_or(1024) as u32;
    let (width, height) = size_of(v, (dw, dh))?;
    let steps = v
        .get("steps")
        .and_then(|s| s.as_u64())
        .unwrap_or_else(|| m.defaults["steps"].as_u64().unwrap_or(20)) as u32;
    // `guidance` is what the app calls it on screen; `cfg` and `cfg_scale` are
    // what every diffusion tool calls it. All three, because a caller should
    // not have to read our source to set it.
    let cfg = ["guidance", "cfg", "cfg_scale"]
        .iter()
        .find_map(|k| v.get(*k).and_then(|c| c.as_f64()))
        .unwrap_or_else(|| m.defaults["cfg"].as_f64().unwrap_or(7.0)) as f32;
    let negative = ["negative_prompt", "negative"]
        .iter()
        .find_map(|k| v.get(*k).and_then(|s| s.as_str()))
        .unwrap_or_default()
        .to_string();
    let seed = v.get("seed").and_then(|s| s.as_i64()).unwrap_or(-1);
    let fmt = match v.get("response_format").and_then(|f| f.as_str()).unwrap_or("b64_json") {
        "b64_json" => Fmt::B64,
        "path" => Fmt::PathOnly,
        // `url` is OpenAI's other value and it would be a lie here: there is no
        // server holding these files for you to fetch them from.
        other => {
            return Err(format!(
                "response_format {other:?} is not supported here: use b64_json or path"
            ))
        }
    };

    // `temp` is declared before the first write and carries its own deletion,
    // so every `?` below throws the bytes away with it.
    let mut temp = TempFiles::default();
    let init_image = media_field(v, ["image", "init_image"], "png", &mut temp)?;
    let ref_audio = media_field(v, ["audio", "ref_audio"], "wav", &mut temp)?;

    // Length, for the models that make clips. `seconds` is what a caller
    // thinks in; frames are what the engine takes, and the model's grid is
    // applied later by align_frames so the number that comes back is the one
    // that was rendered.
    let frames = match m.video.as_ref() {
        None => {
            for k in ["frames", "seconds", "audio", "ref_audio"] {
                if v.get(k).is_some() {
                    return Err(format!("{} makes pictures, not clips: {k} does not apply", m.name));
                }
            }
            0
        }
        Some(spec) => {
            if let Some(f) = v.get("frames").and_then(|f| f.as_u64()) {
                f as u32
            } else if let Some(s) = v.get("seconds").and_then(|s| s.as_f64()) {
                if s <= 0.0 {
                    return Err("seconds must be positive".into());
                }
                (s * spec.fps as f64).round() as u32
            } else {
                0
            }
        }
    };
    let fast = v
        .get("fast")
        .and_then(|f| f.as_bool())
        // The window ticks this box by default on the models that offer it, and
        // the registry's measured times are the times WITH it. Defaulting the
        // API to something else would make every published number wrong here.
        .unwrap_or(true);

    Ok(Ask {
        req: GenerateRequest {
            model: m.id.clone(),
            prompt,
            negative,
            steps,
            cfg,
            width,
            height,
            seed,
            frames,
            init_image,
            ref_audio,
            fast,
        },
        model: m,
        fmt,
        temp,
    })
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME").map(PathBuf::from).unwrap_or_default()
}

fn temp_path(dir: &Path, ext: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // Beside the files it will sit next to rather than in TMPDIR: the inbox is
    // swept by its own drop guard, and a folder the user can open is a folder
    // they can check.
    dir.join(format!("galactus-api-{stamp}.{ext}"))
}

/// The payload of a data URL, or the string unchanged when it is not one.
fn strip_data_url(s: &str) -> &str {
    match s.strip_prefix("data:") {
        Some(rest) => rest.split_once("base64,").map(|(_, b)| b).unwrap_or(s),
        None => s,
    }
}

/// Standard base64 in, bytes out. None on anything that is not base64.
///
/// Hand-rolled for the same reason the encoder next to it in image.rs is: this
/// is twenty lines against a dependency, a NOTICE entry and a licence review.
/// Whitespace is skipped because a JSON string that travelled through a YAML
/// file or a shell heredoc often carries newlines.
pub fn decode_b64(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for c in s.bytes() {
        if c.is_ascii_whitespace() || c == b'=' {
            continue;
        }
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            // Both alphabets: a picture that came through a URL parameter is
            // base64url, and refusing it would be refusing a correct file.
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return None,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// What a finished file is, for the `mime` field of the answer.
fn mime_of(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("webm") => "video/webm",
        Some("wav") => "audio/wav",
        _ => "image/png",
    }
}

/// Run one generation and shape the answer. Blocking: this is minutes of work.
pub fn generate(v: &Value, app: Option<tauri::AppHandle>) -> Reply {
    let models = match image::models_now() {
        Ok(m) => m,
        Err(e) => return Reply::err(500, &e),
    };
    let ask = match parse_ask(v, &models) {
        Ok(a) => a,
        Err(e) => return Reply::err(400, &e),
    };
    let started = std::time::Instant::now();
    let done = image::generate_sync(ask.req.clone(), app);
    let path = match done {
        Ok(p) => PathBuf::from(p),
        Err(e) => {
            // The one-at-a-time refusal is a 409 rather than a 500: it is the
            // caller's cue to retry, and an SDK that retries a 500 forever on
            // a busy machine is a machine that never finishes anything.
            let status = if e.contains("already being made") { 409 } else { 500 };
            return Reply::err(status, &e);
        }
    };
    let seconds = started.elapsed().as_secs_f64();
    let mut item = json!({
        "path": path.to_string_lossy(),
        "mime": mime_of(&path),
    });
    if ask.fmt == Fmt::B64 {
        match std::fs::read(&path) {
            Ok(bytes) => item["b64_json"] = json!(image::b64(&bytes)),
            Err(e) => return Reply::err(500, &format!("cannot read what was made: {e}")),
        }
    }
    // A clip made by a speech model has its voice beside it, because WKWebView
    // refuses PCM inside WebM and the app splits the pair on the way out (see
    // webm.rs). An API caller gets both halves or the pair is useless.
    let wav = path.with_extension("wav");
    if wav.is_file() {
        item["audio_path"] = json!(wav.to_string_lossy());
        if ask.fmt == Fmt::B64 {
            if let Ok(bytes) = std::fs::read(&wav) {
                item["audio_b64_json"] = json!(image::b64(&bytes));
            }
        }
    }
    Reply::of(
        200,
        json!({
            "created": now_secs(),
            "model": ask.model.id,
            // Measured, not promised: the same number the registry cards carry,
            // for the run that just happened on this machine.
            "seconds": (seconds * 10.0).round() / 10.0,
            "data": [item],
        }),
    )
}

/// The catalogue, with this Mac's verdict on each entry.
pub fn models() -> Reply {
    let models = match image::models_now() {
        Ok(m) => m,
        Err(e) => return Reply::err(500, &e),
    };
    let data: Vec<Value> = models
        .iter()
        .map(|m| {
            json!({
                "id": m.id,
                "object": "model",
                "owned_by": "galactus",
                "name": m.name,
                "kind": if m.is_video() { "video" } else { "image" },
                "installed": m.installed,
                // Whether THIS Mac can run it, and why not when it cannot. The
                // same verdict the card shows, so a caller can pick without
                // discovering the answer as a five minute failure.
                "usable": m.usable,
                "reason": m.reason,
                "bytes": m.bytes,
                "default_size": format!(
                    "{}x{}",
                    m.defaults["width"].as_u64().unwrap_or(1024),
                    m.defaults["height"].as_u64().unwrap_or(1024)
                ),
                "fps": m.video.as_ref().map(|v| v.fps),
                "needs_image": m.video.as_ref().map(|v| v.needs_init_image).unwrap_or(false),
                "needs_audio": m.video.as_ref().map(|v| v.needs_ref_audio).unwrap_or(false),
            })
        })
        .collect();
    Reply::of(200, json!({"object": "list", "data": data}))
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Serve one of our routes. The relay has already checked the key.
pub fn handle(r: Route, body: &[u8], app: Option<tauri::AppHandle>) -> Reply {
    match r {
        Route::Models => models(),
        Route::Generate => {
            let v: Value = match serde_json::from_slice(body) {
                Ok(v) => v,
                Err(e) => return Reply::err(400, &format!("the body is not JSON: {e}")),
            };
            generate(&v, app)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn model(id: &str, video: bool) -> ImageModel {
        let mut m = image::test_model(id);
        if video {
            m.kind = "video".into();
            m.video = Some(image::test_video_spec());
        }
        m
    }

    #[test]
    fn only_our_two_routes_are_ours() {
        assert_eq!(route("POST", "/v1/images/generations"), Some(Route::Generate));
        assert_eq!(route("POST", "/v1/videos/generations"), Some(Route::Generate));
        assert_eq!(route("GET", "/v1/images/models"), Some(Route::Models));
        // A query string must not push a request onto the text engine.
        assert_eq!(route("POST", "/v1/images/generations?x=1"), Some(Route::Generate));
        // Everything else belongs to llama-server and must be forwarded.
        assert_eq!(route("POST", "/v1/chat/completions"), None);
        assert_eq!(route("GET", "/v1/models"), None);
        // The method matters: a GET on the generation path is not a generation.
        assert_eq!(route("GET", "/v1/images/generations"), None);
    }

    #[test]
    fn a_request_without_a_prompt_is_refused_before_anything_loads() {
        let models = vec![model("sdxl-base", false)];
        let err = parse_ask(&json!({}), &models).unwrap_err();
        assert!(err.contains("prompt is required"), "got: {err}");
        let err = parse_ask(&json!({"prompt": "   "}), &models).unwrap_err();
        assert!(err.contains("prompt is required"), "got: {err}");
    }

    #[test]
    fn the_models_defaults_fill_in_what_the_caller_left_out() {
        let models = vec![model("sdxl-base", false)];
        let ask = parse_ask(&json!({"prompt": "a fox"}), &models).expect("ask");
        assert_eq!(ask.req.model, "sdxl-base");
        assert_eq!((ask.req.width, ask.req.height), (1024, 1024));
        assert_eq!(ask.req.steps, 20);
        assert_eq!(ask.req.seed, -1);
        assert_eq!(ask.fmt, Fmt::B64);
    }

    #[test]
    fn size_is_read_in_both_spellings_and_refused_when_it_is_neither() {
        let models = vec![model("sdxl-base", false)];
        let ask = parse_ask(&json!({"prompt": "x", "size": "768x512"}), &models).expect("ask");
        assert_eq!((ask.req.width, ask.req.height), (768, 512));
        let ask = parse_ask(&json!({"prompt": "x", "width": 640, "height": 384}), &models).expect("ask");
        assert_eq!((ask.req.width, ask.req.height), (640, 384));
        let err = parse_ask(&json!({"prompt": "x", "size": "big"}), &models).unwrap_err();
        assert!(err.contains("1024x1024"), "got: {err}");
    }

    #[test]
    fn guidance_is_accepted_under_every_name_it_is_known_by() {
        let models = vec![model("sdxl-base", false)];
        for key in ["guidance", "cfg", "cfg_scale"] {
            let ask = parse_ask(&json!({"prompt": "x", key: 3.5}), &models).expect("ask");
            assert_eq!(ask.req.cfg, 3.5, "{key}");
        }
    }

    #[test]
    fn asking_for_more_than_one_picture_is_refused_rather_than_half_honoured() {
        // The failure this prevents: an SDK asks for four, gets one, and the
        // caller finds out by counting a list that is never the length it asked.
        let models = vec![model("sdxl-base", false)];
        let err = parse_ask(&json!({"prompt": "x", "n": 4}), &models).unwrap_err();
        assert!(err.contains("n must be 1"), "got: {err}");
        assert!(parse_ask(&json!({"prompt": "x", "n": 1}), &models).is_ok());
    }

    #[test]
    fn clip_fields_are_refused_on_a_model_that_makes_pictures() {
        // Silently ignoring `seconds` on SDXL would answer a still image to a
        // caller who waited for a clip and has no way to see what happened.
        let models = vec![model("sdxl-base", false)];
        for key in ["frames", "seconds"] {
            let err = parse_ask(&json!({"prompt": "x", key: 2}), &models).unwrap_err();
            assert!(err.contains("does not apply"), "{key}: {err}");
        }
    }

    #[test]
    fn seconds_become_frames_at_the_models_own_rate() {
        let models = vec![model("wan-t2v", true)];
        // The stub spec runs at 16 fps, so two seconds is 32 frames asked for;
        // the engine's grid is applied later, by align_frames.
        let ask = parse_ask(&json!({"prompt": "x", "model": "wan-t2v", "seconds": 2}), &models)
            .expect("ask");
        assert_eq!(ask.req.frames, 32);
        let ask = parse_ask(&json!({"prompt": "x", "model": "wan-t2v", "frames": 49}), &models)
            .expect("ask");
        assert_eq!(ask.req.frames, 49);
    }

    #[test]
    fn an_unknown_model_names_the_ones_that_exist() {
        let models = vec![model("sdxl-base", false), model("wan-t2v", true)];
        let err = parse_ask(&json!({"prompt": "x", "model": "dall-e-3"}), &models).unwrap_err();
        assert!(err.contains("sdxl-base") && err.contains("wan-t2v"), "got: {err}");
    }

    #[test]
    fn a_model_this_mac_cannot_run_is_refused_at_the_door() {
        // The same gate the window applies, restated here because a curl never
        // sees a disabled button.
        let mut m = model("sdxl-base", false);
        m.usable = false;
        m.reason = "needs 32 GB and this Mac has 16".into();
        let err = parse_ask(&json!({"prompt": "x"}), &[m.clone()]).unwrap_err();
        assert!(err.contains("no image model is installed"), "got: {err}");
        let err = parse_ask(&json!({"prompt": "x", "model": "sdxl-base"}), &[m]).unwrap_err();
        assert!(err.contains("this Mac has 16"), "got: {err}");
    }

    #[test]
    fn a_model_that_is_not_downloaded_says_so() {
        let mut m = model("sdxl-base", false);
        m.installed = false;
        let err = parse_ask(&json!({"prompt": "x", "model": "sdxl-base"}), &[m]).unwrap_err();
        assert!(err.contains("not downloaded"), "got: {err}");
    }

    #[test]
    fn the_default_model_prefers_a_picture_over_a_six_minute_clip() {
        // A caller who omitted `model` wanted a picture. Handing them a video
        // model because it sorted first is minutes of surprise.
        let models = vec![model("wan-t2v", true), model("sdxl-base", false)];
        let ask = parse_ask(&json!({"prompt": "x"}), &models).expect("ask");
        assert_eq!(ask.req.model, "sdxl-base");
    }

    #[test]
    fn response_format_url_is_refused_because_it_would_be_a_lie() {
        let models = vec![model("sdxl-base", false)];
        let err = parse_ask(&json!({"prompt": "x", "response_format": "url"}), &models).unwrap_err();
        assert!(err.contains("b64_json or path"), "got: {err}");
        let ask = parse_ask(&json!({"prompt": "x", "response_format": "path"}), &models).expect("ask");
        assert_eq!(ask.fmt, Fmt::PathOnly);
    }

    /// A path from the network cannot reach outside the two allowed folders,
    /// and cannot be used to learn what is on the disk either.
    ///
    /// The second assertion is the one that matters and it is easy to lose in a
    /// refactor: the refusal for a file that EXISTS must be the same sentence
    /// as the refusal for one that does not. Anything else answers "is there a
    /// file at this path" to anybody holding the key, for every path on the
    /// machine.
    #[test]
    fn a_path_outside_the_allowed_folders_is_refused_and_tells_nothing() {
        let models = vec![model("wan-i2v", true)];
        let ask = |p: &str| {
            parse_ask(&json!({"prompt": "x", "model": "wan-i2v", "image": p}), &models).unwrap_err()
        };
        let missing = ask("/nope/definitely-not-here.png");
        let present = ask("/etc/hosts");
        assert!(missing.contains("has to be inside"), "got: {missing}");
        assert_eq!(missing, present, "the refusal must not reveal what exists");
        // And the classic escape, which a prefix test alone would let through.
        let climb = ask(&format!("{}/../../../../etc/hosts", image::api_inbox().to_string_lossy()));
        assert_eq!(climb, present, ".. must not walk out of the inbox");
    }

    #[test]
    fn a_missing_file_inside_the_inbox_is_named_because_that_leaks_nothing() {
        let models = vec![model("wan-i2v", true)];
        let p = image::api_inbox().join("not-there.png");
        let err = parse_ask(
            &json!({"prompt": "x", "model": "wan-i2v", "image": p.to_string_lossy()}),
            &models,
        )
        .unwrap_err();
        assert!(err.contains("no file at"), "got: {err}");
    }

    #[test]
    fn inline_media_lands_in_the_inbox_and_is_deleted_with_the_request() {
        let _guard = inbox_lock();
        let models = vec![model("wan-i2v", true)];
        let png = image::b64(b"\x89PNG\r\n\x1a\nnot really");
        let written = {
            let ask = parse_ask(
                &json!({"prompt": "x", "model": "wan-i2v", "image": format!("data:image/png;base64,{png}")}),
                &models,
            )
            .expect("ask");
            assert_eq!(ask.temp.paths.len(), 1, "the file must be tracked for cleanup");
            assert!(
                PathBuf::from(&ask.req.init_image).starts_with(image::api_inbox()),
                "inline media belongs in the inbox, not in TMPDIR: {}",
                ask.req.init_image
            );
            let on_disk = std::fs::read(&ask.req.init_image).expect("written");
            assert_eq!(&on_disk, b"\x89PNG\r\n\x1a\nnot really");
            PathBuf::from(&ask.req.init_image)
        };
        assert!(!written.exists(), "dropping the request must take its bytes with it");
    }

    /// A request refused AFTER the media was written still leaves nothing.
    ///
    /// This is the leak that was measured: 48 MB of inline audio written, then
    /// "this model makes pictures, not clips", and the megabytes stayed.
    #[test]
    fn media_written_before_a_refusal_does_not_survive_the_refusal() {
        let _guard = inbox_lock();
        let before = inbox_count();
        let wav = image::b64(b"RIFF....WAVEfmt ");
        let err = parse_ask(
            &json!({"prompt": "x", "model": "sdxl-base", "audio": wav}),
            &[model("sdxl-base", false)],
        )
        .unwrap_err();
        assert!(err.contains("does not apply"), "got: {err}");
        assert_eq!(inbox_count(), before, "the refused request left files behind");
    }

    fn inbox_count() -> usize {
        std::fs::read_dir(image::api_inbox()).map(|d| d.count()).unwrap_or(0)
    }

    /// The inbox is one folder for the whole process, and two tests writing
    /// into it at once make each other's count wrong. Same reason the relay
    /// and the scheduler serialise theirs.
    fn inbox_lock() -> std::sync::MutexGuard<'static, ()> {
        static L: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        L.get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn base64_round_trips_through_both_alphabets_and_whitespace() {
        let raw: Vec<u8> = (0u8..=255).collect();
        let encoded = image::b64(&raw);
        assert_eq!(decode_b64(&encoded).expect("decodes"), raw);
        // Wrapped at 64 columns, which is how base64 arrives out of a YAML file.
        let wrapped: String = encoded
            .as_bytes()
            .chunks(64)
            .map(|c| format!("{}\n", String::from_utf8_lossy(c)))
            .collect();
        assert_eq!(decode_b64(&wrapped).expect("decodes"), raw);
        // base64url, which is what a value that travelled through a URL looks like.
        let url_safe = encoded.replace('+', "-").replace('/', "_");
        assert_eq!(decode_b64(&url_safe).expect("decodes"), raw);
        assert_eq!(decode_b64("not base64 !!"), None);
    }

    #[test]
    fn a_data_url_prefix_is_stripped_and_a_bare_payload_is_left_alone() {
        assert_eq!(strip_data_url("data:image/png;base64,QUJD"), "QUJD");
        assert_eq!(strip_data_url("QUJD"), "QUJD");
    }

    #[test]
    fn an_error_carries_the_shape_an_sdk_knows_how_to_raise() {
        let r = Reply::err(400, "prompt is required");
        let v: Value = serde_json::from_slice(&r.body).expect("json");
        assert_eq!(v["error"]["message"], "prompt is required");
        assert_eq!(v["error"]["type"], "invalid_request_error");
        let http = String::from_utf8(r.to_http()).expect("utf8");
        assert!(http.starts_with("HTTP/1.1 400 Bad Request\r\n"), "got: {http}");
        assert!(http.contains(&format!("Content-Length: {}", r.body.len())));
    }

    #[test]
    fn a_body_that_is_not_json_is_a_400_and_not_a_crash() {
        let r = handle(Route::Generate, b"{oh no", None);
        assert_eq!(r.status, 400);
        let v: Value = serde_json::from_slice(&r.body).expect("json");
        assert!(v["error"]["message"].as_str().unwrap().contains("not JSON"));
    }
}
