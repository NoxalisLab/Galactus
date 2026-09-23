// Cloud roles: a teammate answered by a hosted model, on explicit request.
//
// WHY THIS EXISTS AT ALL IN A LOCAL-FIRST APP. Galactus promises local
// inference and "network only when you ask". A team may still want one role,
// the expert, answered by a model no Mac can hold. So a cloud role is OFF by
// default, turned on by a setting the user flips, capped per day in dollars,
// and visible on every call (`galactus://cloud-call`). Nothing here runs unless
// a preset names a cloud role AND the user enabled the provider AND stored a key.
//
// THE SHAPE. The orchestrator talks to every teammate the same way: an
// OpenAI-compatible endpoint on 127.0.0.1. A cloud role therefore gets a tiny
// local proxy registered in the same engines table as a llama-server, and the
// webview never learns that one teammate lives elsewhere, nor its key.
//
// THE KEY. Stored in the macOS Keychain through /usr/bin/security, read at
// request time, and never written to settings.json, to the webview, or to any
// command line: `ps` shows every argv on the machine to every user. It reaches
// `security` on stdin (`security -i`) and curl on stdin (`-K -`).
//
// THE TRANSPORT is curl, like everywhere else in this codebase, so TLS is the
// system's and no HTTP client crate enters the tree. The response is streamed
// back as it arrives (server-sent events turn into a pause and a wall of text
// otherwise, see relay.rs), while its tail is kept to read what the call cost.

use crate::*;
use serde::Deserialize;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};

/// The one provider wired today.
pub(crate) const OPENROUTER: &str = "openrouter";
const OPENROUTER_CHAT: &str = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODELS: &str = "https://openrouter.ai/api/v1/models";
/// The attribution headers OpenRouter documents for apps.
const APP_REFERER: &str = "https://noxalis-lab.io/galactus";
const APP_TITLE: &str = "Galactus";
/// A request body larger than this is refused rather than held in memory.
const MAX_BODY: usize = 32 * 1024 * 1024;
/// How much of a response is kept to read its usage: the last chunk of a stream
/// or the whole of a JSON answer, whichever is shorter.
const TAIL_KEEP: usize = 256 * 1024;
const DEFAULT_CAP_USD: f64 = 5.0;

fn provider_ok(provider: &str) -> Result<(), String> {
    if provider == OPENROUTER {
        Ok(())
    } else {
        Err(format!("unknown cloud provider {provider:?}: only openrouter is supported"))
    }
}

// ------------------------------------------------------------------ keychain

fn keychain_service(provider: &str) -> String {
    format!("galactus.cloud.{provider}")
}
const KEYCHAIN_ACCOUNT: &str = "api-key";

/// A key is typed or pasted by a person; it is refused when it could not be
/// one, and ALSO when it could break the quoting of the `security -i` line it
/// travels in. OpenRouter keys are `sk-or-v1-` and hex.
fn key_is_plausible(key: &str) -> bool {
    (8..=512).contains(&key.len())
        && key.chars().all(|c| c.is_ascii_graphic() && c != '"' && c != '\\' && c != '\'')
}

/// The `security` invocation that stores a key: argv, and the line for stdin.
///
/// `add-generic-password -w KEY` on the argv would publish the key to `ps`
/// for as long as the process lives. `security -i` reads the same command
/// from stdin instead.
pub(crate) fn keychain_store_invocation(provider: &str, key: &str) -> (Vec<String>, String) {
    (
        vec!["-i".into()],
        format!(
            "add-generic-password -U -s \"{}\" -a \"{KEYCHAIN_ACCOUNT}\" -w \"{key}\"\n",
            keychain_service(provider)
        ),
    )
}

fn security(args: &[&str]) -> std::io::Result<std::process::Output> {
    Command::new("/usr/bin/security").args(args).stdin(Stdio::null()).output()
}

/// The stored key, or None. Never leaves the backend.
fn keychain_read(provider: &str) -> Option<String> {
    let svc = keychain_service(provider);
    let out = security(&["find-generic-password", "-s", &svc, "-a", KEYCHAIN_ACCOUNT, "-w"]).ok()?;
    if !out.status.success() {
        return None;
    }
    let key = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!key.is_empty()).then_some(key)
}

#[tauri::command]
pub async fn cloud_key_set(provider: String, key: String) -> Result<(), String> {
    provider_ok(&provider)?;
    let key = key.trim();
    if !key_is_plausible(key) {
        return Err("this does not look like an API key (8 to 512 visible characters, no quotes)".into());
    }
    let (argv, line) = keychain_store_invocation(&provider, key);
    let mut child = Command::new("/usr/bin/security")
        .args(&argv)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("security: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        // Dropping stdin ends the interactive session.
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    // `security -i` exits 0 even when the command inside it failed, so the
    // result is checked by reading the item back.
    if keychain_read(&provider).as_deref() != Some(key) {
        return Err(format!(
            "the key could not be stored in the Keychain: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn cloud_key_clear(provider: String) -> Result<(), String> {
    provider_ok(&provider)?;
    let svc = keychain_service(&provider);
    // Deleting a key that is not there is what the user asked for: done.
    let _ = security(&["delete-generic-password", "-s", &svc, "-a", KEYCHAIN_ACCOUNT]);
    if keychain_read(&provider).is_some() {
        return Err("the Keychain refused to delete the key".into());
    }
    Ok(())
}

/// Whether a key is stored. Never the key itself.
#[tauri::command]
pub async fn cloud_key_status(provider: String) -> Result<bool, String> {
    provider_ok(&provider)?;
    let svc = keychain_service(&provider);
    // Without -w, find-generic-password prints the item's attributes and not
    // its secret, and asks the Keychain for nothing it would prompt over.
    Ok(security(&["find-generic-password", "-s", &svc, "-a", KEYCHAIN_ACCOUNT])
        .map(|o| o.status.success())
        .unwrap_or(false))
}

// ------------------------------------------------------------------ gate

/// Whether a cloud role may run, from the settings and the key's presence.
///
/// Asked at engine start AND at every request: turning the setting off must
/// stop the next call, not the next app launch.
pub(crate) fn cloud_gate(
    settings: &HashMap<String, String>,
    provider: &str,
    key_present: bool,
) -> Result<(), String> {
    provider_ok(provider)?;
    if settings.get(&format!("cloud_{provider}_enabled")).map(|v| v.trim()) != Some("1") {
        return Err(format!(
            "cloud roles are off: this team asks for a {provider} model, and tasks given to it \
             would leave this Mac. Enable {provider} in Settings > Teams > Cloud to allow it."
        ));
    }
    if !key_present {
        return Err(format!("no {provider} API key is stored: add one in Settings > Teams > Cloud."));
    }
    Ok(())
}

/// "cloud:openrouter/<slug>" into its provider and model slug.
pub(crate) fn parse_cloud_id(id: &str) -> Result<(String, String), String> {
    let rest = id
        .strip_prefix("cloud:")
        .ok_or_else(|| format!("{id} is not a cloud model id"))?;
    let (provider, slug) = rest
        .split_once('/')
        .ok_or_else(|| format!("{id}: expected cloud:<provider>/<model>"))?;
    provider_ok(provider)?;
    // Slugs are "vendor/model[:variant]". The charset is checked because the
    // slug is written into a request body and a log line.
    let ok = !slug.is_empty()
        && slug.len() <= 200
        && slug.chars().all(|c| c.is_ascii_alphanumeric() || "-_./:".contains(c));
    if !ok {
        return Err(format!(
            "{id}: no model chosen for this cloud role, or a malformed one (pick one in Settings)"
        ));
    }
    Ok((provider.to_string(), slug.to_string()))
}

// ------------------------------------------------------------------ request

/// The body sent upstream: the model the ROLE names, whatever the caller put,
/// and usage accounting on so the cost can be capped.
pub(crate) fn rewrite_body(body: &[u8], slug: &str) -> Result<Vec<u8>, String> {
    let mut v: Value = serde_json::from_slice(body).map_err(|e| format!("request is not JSON: {e}"))?;
    let obj = v.as_object_mut().ok_or("request body must be a JSON object")?;
    obj.insert("model".into(), json!(slug));
    obj.insert("usage".into(), json!({"include": true}));
    serde_json::to_vec(&v).map_err(|e| e.to_string())
}

/// curl's argv for one upstream call. The key is NOT in it: everything that
/// carries it is in the config read from stdin.
pub(crate) fn curl_argv() -> Vec<String> {
    [
        "-sS", "--http1.1",
        // No buffering, so a token stream stays a stream.
        "-N",
        // The response head is read to relay the status.
        "-i",
        "--max-time", "900",
        "-K", "-",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// A value for a double-quoted curl config string. curl unescapes `\\`, `\"`,
/// `\n`, `\r`, `\t`; everything else passes through.
fn curl_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The curl config for one call: URL, headers, key and body, all on stdin.
pub(crate) fn curl_config(url: &str, key: &str, body: &[u8]) -> String {
    let body = String::from_utf8_lossy(body);
    let mut c = String::new();
    for (k, v) in [
        ("url", url.to_string()),
        ("header", format!("Authorization: Bearer {key}")),
        ("header", "Content-Type: application/json".to_string()),
        ("header", format!("HTTP-Referer: {APP_REFERER}")),
        ("header", format!("X-Title: {APP_TITLE}")),
        ("data-binary", body.into_owned()),
    ] {
        c.push_str(k);
        c.push_str(" = ");
        c.push_str(&curl_quote(&v));
        c.push('\n');
    }
    c
}

/// The upstream chat URL. `GALACTUS_CLOUD_UPSTREAM` overrides it FOR TESTS
/// against a fake local server, and is honoured only on loopback, so no
/// environment can send the key anywhere but the provider or this Mac.
fn upstream_url() -> String {
    match std::env::var("GALACTUS_CLOUD_UPSTREAM") {
        Ok(u) if is_loopback_url(&u) => u,
        _ => OPENROUTER_CHAT.to_string(),
    }
}

/// `http://127.0.0.1:<port>/...` and nothing else. A prefix test is not
/// enough: `http://127.0.0.1:1@evil.example/` starts with the right bytes,
/// and curl reads everything before the `@` as credentials and sends the
/// request, key included, to evil.example.
fn is_loopback_url(u: &str) -> bool {
    let Some(rest) = u.strip_prefix("http://127.0.0.1:") else { return false };
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let port = &rest[..authority_end];
    !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit())
}

// ------------------------------------------------------------------ usage and ledger

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub(crate) struct CloudCall {
    pub(crate) provider: String,
    pub(crate) model: String,
    pub(crate) prompt_tokens: u64,
    pub(crate) completion_tokens: u64,
    pub(crate) cost_usd: f64,
}

/// One day of calls. A file from another day reads as an empty ledger for
/// today, which is the whole rollover: nothing has to run at midnight.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub(crate) struct Ledger {
    pub(crate) date: String,
    pub(crate) calls: Vec<CloudCall>,
}

impl Ledger {
    pub(crate) fn for_day(raw: Option<&str>, today: &str) -> Ledger {
        match raw.and_then(|r| serde_json::from_str::<Ledger>(r).ok()) {
            Some(l) if l.date == today => l,
            _ => Ledger { date: today.to_string(), calls: Vec::new() },
        }
    }

    pub(crate) fn total_usd(&self) -> f64 {
        self.calls.iter().map(|c| c.cost_usd).sum()
    }
}

/// The refusal when today's spend has reached the cap, or None.
pub(crate) fn cap_refusal(total: f64, cap: f64) -> Option<String> {
    (total >= cap).then(|| format!("cloud daily cap reached ({total:.2} / {cap:.2} USD)"))
}

fn cap_from(settings: &HashMap<String, String>) -> f64 {
    settings
        .get("cloud_daily_cap_usd")
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v >= 0.0)
        .unwrap_or(DEFAULT_CAP_USD)
}

/// Today in the Mac's own zone, the day the user means by "per day".
fn today() -> String {
    let unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let c = crate::cron::civil_at(&crate::cron::Local, unix);
    format!("{:04}-{:02}-{:02}", c.year, c.month, c.day)
}

fn ledger_path() -> PathBuf {
    app_support().join("cloud-ledger.json")
}

/// Serializes read-modify-write of a ledger file.
fn ledger_lock() -> std::sync::MutexGuard<'static, ()> {
    static L: Mutex<()> = Mutex::new(());
    L.lock().unwrap_or_else(|e| e.into_inner())
}

fn ledger_load(path: &Path, today: &str) -> Ledger {
    Ledger::for_day(std::fs::read_to_string(path).ok().as_deref(), today)
}

fn ledger_append(path: &Path, today: &str, call: CloudCall) {
    let _g = ledger_lock();
    let mut l = ledger_load(path, today);
    l.calls.push(call);
    if let Ok(text) = serde_json::to_string_pretty(&l) {
        let _ = std::fs::create_dir_all(path.parent().unwrap_or(Path::new(".")));
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

/// Usage from the end of a response: the whole JSON of a plain answer, or the
/// last `data:` event carrying `usage` in a stream.
pub(crate) fn extract_usage(tail: &[u8]) -> Option<(u64, u64, f64)> {
    let text = String::from_utf8_lossy(tail);
    let read = |v: &Value| {
        let u = v.get("usage")?;
        if !u.is_object() {
            return None;
        }
        Some((
            u["prompt_tokens"].as_u64().unwrap_or(0),
            u["completion_tokens"].as_u64().unwrap_or(0),
            u["cost"].as_f64().unwrap_or(0.0),
        ))
    };
    if let Ok(v) = serde_json::from_str::<Value>(text.trim()) {
        if let Some(u) = read(&v) {
            return Some(u);
        }
    }
    text.lines()
        .rev()
        .filter_map(|l| l.trim().strip_prefix("data:"))
        .filter_map(|d| serde_json::from_str::<Value>(d.trim()).ok())
        .find_map(|v| read(&v))
}

#[derive(Serialize)]
pub(crate) struct CloudUsage {
    total_usd: f64,
    cap_usd: f64,
    calls: usize,
}

#[tauri::command(async)]
pub fn cloud_usage_today() -> CloudUsage {
    let l = ledger_load(&ledger_path(), &today());
    CloudUsage { total_usd: l.total_usd(), cap_usd: cap_from(&settings_load()), calls: l.calls.len() }
}

/// The provider's model list, trimmed to what a picker needs. Called only when
/// the user presses the button; it sends nothing but the request itself.
#[tauri::command]
pub async fn cloud_models(provider: String) -> Result<Vec<Value>, String> {
    provider_ok(&provider)?;
    let out = Command::new("curl")
        .args(["-sS", "--max-time", "30", OPENROUTER_MODELS])
        .output()
        .map_err(|e| format!("curl: {e}"))?;
    if !out.status.success() {
        return Err(format!("could not list models: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|_| "unreadable model list".to_string())?;
    let data = v["data"].as_array().ok_or("unreadable model list")?;
    Ok(data
        .iter()
        .map(|m| {
            json!({
                "id": m["id"],
                "name": m["name"],
                "context_length": m["context_length"],
                "prompt_usd_per_token": m.pointer("/pricing/prompt"),
                "completion_usd_per_token": m.pointer("/pricing/completion"),
            })
        })
        .collect())
}

// ------------------------------------------------------------------ proxy

/// Everything a proxy needs, with the parts that touch the Mac (Keychain,
/// settings, events) injected so a test can run the whole path against a fake
/// upstream on loopback.
pub(crate) struct ProxyCtx {
    pub(crate) provider: String,
    pub(crate) slug: String,
    pub(crate) upstream: String,
    /// The key, after the gate: Err is the sentence the caller reads.
    pub(crate) key: Box<dyn Fn() -> Result<String, String> + Send + Sync>,
    pub(crate) cap_usd: Box<dyn Fn() -> f64 + Send + Sync>,
    pub(crate) ledger: PathBuf,
    pub(crate) today: Box<dyn Fn() -> String + Send + Sync>,
    pub(crate) on_call: Box<dyn Fn(&CloudCall) + Send + Sync>,
}

/// The webview origins allowed to call the proxy from a browser context.
///
/// A proxy on 127.0.0.1 that spends money must not answer any web page the
/// user happens to have open: a page can POST to localhost. Browsers always
/// send Origin on such a request, so a foreign Origin is refused; clients with
/// no Origin at all (curl, the app's own Rust) are local processes.
const ALLOWED_ORIGINS: [&str; 4] =
    ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1430"];

fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.split("\r\n").skip(1).find_map(|l| {
        let (n, v) = l.split_once(':')?;
        n.trim().eq_ignore_ascii_case(name).then(|| v.trim())
    })
}

/// Ok(Some(origin)) to echo, Ok(None) for no Origin, Err for a foreign one.
pub(crate) fn origin_check(head: &str) -> Result<Option<String>, ()> {
    match header(head, "origin") {
        None => Ok(None),
        Some(o) if ALLOWED_ORIGINS.contains(&o) => Ok(Some(o.to_string())),
        Some(_) => Err(()),
    }
}

fn cors(origin: &Option<String>) -> String {
    match origin {
        Some(o) => format!(
            "Access-Control-Allow-Origin: {o}\r\nVary: Origin\r\n\
             Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
             Access-Control-Allow-Headers: content-type, authorization\r\n"
        ),
        None => String::new(),
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        402 => "Payment Required",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        502 => "Bad Gateway",
        _ => "Status",
    }
}

fn reply_json(client: &mut TcpStream, status: u16, body: &Value, origin: &Option<String>) {
    let b = body.to_string();
    let _ = write!(
        client,
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{}Connection: close\r\n\r\n{b}",
        reason(status),
        b.len(),
        cors(origin)
    );
    let _ = client.flush();
}

fn reply_error(client: &mut TcpStream, status: u16, message: &str, kind: &str, origin: &Option<String>) {
    reply_json(client, status, &json!({"error": {"message": message, "type": kind, "code": status}}), origin);
}

/// Serve one connection. Every path out answers something the chat code can
/// show: an OpenAI-shaped error, never a dropped socket.
pub(crate) fn serve_conn(mut client: TcpStream, ctx: &ProxyCtx) {
    let _ = client.set_read_timeout(Some(Duration::from_secs(30)));
    let Ok((head, rest)) = crate::relay::read_head(&mut client) else { return };
    let Ok(origin) = origin_check(&head) else {
        return reply_error(&mut client, 403, "origin not allowed", "forbidden", &None);
    };
    let Some((method, path)) = crate::relay::method_path(&head) else {
        return reply_error(&mut client, 400, "malformed request line", "bad_request", &origin);
    };
    let path = path.split('?').next().unwrap_or(path);
    match (method, path) {
        ("OPTIONS", _) => {
            let _ = write!(client, "HTTP/1.1 204 No Content\r\n{}Access-Control-Max-Age: 600\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", cors(&origin));
        }
        // Health and discovery are answered here, without the network: a
        // status poll must not reach the provider.
        ("GET", "/health") => reply_json(&mut client, 200, &json!({"status": "ok"}), &origin),
        ("GET", "/v1/models") => reply_json(
            &mut client,
            200,
            &json!({"object": "list", "data": [{"id": ctx.slug, "object": "model", "owned_by": ctx.provider}]}),
            &origin,
        ),
        ("POST", "/v1/chat/completions") => chat(&mut client, &head, rest, ctx, &origin),
        _ => reply_error(&mut client, 404, "this proxy serves /v1/chat/completions only", "not_found", &origin),
    }
    let _ = client.shutdown(Shutdown::Both);
}

fn chat(client: &mut TcpStream, head: &str, rest: Vec<u8>, ctx: &ProxyCtx, origin: &Option<String>) {
    if crate::relay::is_chunked(head) {
        return reply_error(client, 400, "send the body with a Content-Length, not chunked", "bad_request", origin);
    }
    let Some(len) = crate::relay::content_length(head) else {
        return reply_error(client, 400, "a Content-Length is required", "bad_request", origin);
    };
    if len > MAX_BODY {
        return reply_error(client, 413, "request too large", "bad_request", origin);
    }
    let body = match crate::relay::read_body(client, rest, len) {
        Ok(b) => b,
        Err(e) => return reply_error(client, 400, &e, "bad_request", origin),
    };
    // The gate and the key, at request time: turning cloud off in Settings
    // stops the very next call.
    let key = match (ctx.key)() {
        Ok(k) => k,
        Err(e) => return reply_error(client, 403, &e, "cloud_disabled", origin),
    };
    // The cap, BEFORE the provider is contacted. Two calls racing past it can
    // overshoot by one call's cost; the cap bounds a day, not a cent.
    let today = (ctx.today)();
    let spent = ledger_load(&ctx.ledger, &today).total_usd();
    if let Some(msg) = cap_refusal(spent, (ctx.cap_usd)()) {
        return reply_error(client, 402, &msg, "cloud_cap", origin);
    }
    let upstream_body = match rewrite_body(&body, &ctx.slug) {
        Ok(b) => b,
        Err(e) => return reply_error(client, 400, &e, "bad_request", origin),
    };
    let mut child = match Command::new("curl")
        .args(curl_argv())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return reply_error(client, 502, &format!("curl: {e}"), "upstream", origin),
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(curl_config(&ctx.upstream, &key, &upstream_body).as_bytes());
    }
    drop(key);
    let Some(mut out) = child.stdout.take() else {
        let _ = child.kill();
        return reply_error(client, 502, "curl gave no output", "upstream", origin);
    };

    // The upstream head: the status is relayed, the framing is not (curl has
    // already undone any chunked encoding, so its headers would lie).
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    let (status, content_type, body_start) = loop {
        let n = out.read(&mut chunk).unwrap_or(0);
        if n == 0 {
            let _ = child.wait();
            let mut err = String::new();
            if let Some(mut e) = child.stderr.take() {
                let _ = e.read_to_string(&mut err);
            }
            return reply_error(client, 502, &format!("{} unreachable: {}", ctx.provider, err.trim()), "upstream", origin);
        }
        buf.extend_from_slice(&chunk[..n]);
        let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
        let head_text = String::from_utf8_lossy(&buf[..end]).into_owned();
        let status = head_text
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(502);
        if (100..200).contains(&status) {
            buf.drain(..end + 4);
            continue;
        }
        let ct = header(&format!("{head_text}\r\n"), "content-type")
            .unwrap_or("application/json")
            .to_string();
        break (status, ct, end + 4);
    };
    let mut client_gone = write!(
        client,
        "HTTP/1.1 {status} {}\r\nContent-Type: {content_type}\r\nCache-Control: no-cache\r\n{}Connection: close\r\n\r\n",
        reason(status),
        cors(origin)
    )
    .is_err();
    let mut tail: Vec<u8> = buf[body_start..].to_vec();
    if !client_gone && (client.write_all(&tail).is_err() || client.flush().is_err()) {
        client_gone = true;
    }
    loop {
        let n = match out.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        // A client that went away does not stop the reading: the provider
        // bills the call anyway, and the ledger has to see what it cost.
        if !client_gone && (client.write_all(&chunk[..n]).is_err() || client.flush().is_err()) {
            client_gone = true;
        }
        tail.extend_from_slice(&chunk[..n]);
        if tail.len() > 2 * TAIL_KEEP {
            tail.drain(..tail.len() - TAIL_KEEP);
        }
    }
    let _ = child.wait();
    if (200..300).contains(&status) {
        let (prompt_tokens, completion_tokens, cost_usd) = extract_usage(&tail).unwrap_or((0, 0, 0.0));
        let call = CloudCall {
            provider: ctx.provider.clone(),
            model: ctx.slug.clone(),
            prompt_tokens,
            completion_tokens,
            cost_usd,
        };
        ledger_append(&ctx.ledger, &today, call.clone());
        (ctx.on_call)(&call);
    }
}

/// Listen on 127.0.0.1 until `stop` is set. Returns the bound port.
pub(crate) fn spawn_proxy(ctx: ProxyCtx, stop: Arc<AtomicBool>) -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("cloud proxy: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let ctx = Arc::new(ctx);
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            let Ok(sock) = conn else { continue };
            let ctx = Arc::clone(&ctx);
            std::thread::spawn(move || serve_conn(sock, &ctx));
        }
    });
    Ok(port)
}

/// Stop a proxy: set its flag, then wake its accept loop with one connection.
pub(crate) fn stop_proxy(stop: &AtomicBool, port: u16) {
    stop.store(true, Ordering::SeqCst);
    if port != 0 {
        let _ = TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
            Duration::from_millis(300),
        );
    }
}

/// The production context: Keychain, settings and events of this app.
pub(crate) fn app_ctx(app: AppHandle, provider: &str, slug: &str) -> ProxyCtx {
    let p = provider.to_string();
    ProxyCtx {
        provider: provider.to_string(),
        slug: slug.to_string(),
        upstream: upstream_url(),
        key: Box::new(move || {
            let key = keychain_read(&p);
            cloud_gate(&settings_load(), &p, key.is_some())?;
            key.ok_or_else(|| "no API key".to_string())
        }),
        cap_usd: Box::new(|| cap_from(&settings_load())),
        ledger: ledger_path(),
        today: Box::new(today),
        on_call: Box::new(move |c: &CloudCall| {
            let _ = app.emit(
                "galactus://cloud-call",
                json!({"model": c.model, "provider": c.provider, "prompt_tokens": c.prompt_tokens,
                       "completion_tokens": c.completion_tokens, "cost_usd": c.cost_usd}),
            );
        }),
    }
}

/// The checks a cloud engine start makes before it listens.
pub(crate) fn preflight(model_id: &str) -> Result<(String, String), String> {
    let (provider, slug) = parse_cloud_id(model_id)?;
    let settings = settings_load();
    // The setting first: with cloud off, not even the Keychain is asked.
    cloud_gate(&settings, &provider, true)?;
    cloud_gate(&settings, &provider, keychain_read(&provider).is_some())?;
    Ok((provider, slug))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn on(enabled: &str) -> HashMap<String, String> {
        HashMap::from([("cloud_openrouter_enabled".to_string(), enabled.to_string())])
    }

    #[test]
    fn a_cloud_role_is_refused_while_off_or_without_a_key() {
        let off = cloud_gate(&on(""), "openrouter", true).unwrap_err();
        assert!(off.contains("cloud roles are off"), "{off}");
        assert!(cloud_gate(&HashMap::new(), "openrouter", true).is_err(), "off by default");
        let nokey = cloud_gate(&on("1"), "openrouter", false).unwrap_err();
        assert!(nokey.contains("no openrouter API key"), "{nokey}");
        assert!(cloud_gate(&on("1"), "openrouter", true).is_ok());
        assert!(cloud_gate(&on("1"), "elsewhere", true).is_err());
    }

    #[test]
    fn cloud_ids_are_parsed_and_an_unconfigured_one_is_refused() {
        assert_eq!(
            parse_cloud_id("cloud:openrouter/anthropic/claude-x:beta").unwrap(),
            ("openrouter".to_string(), "anthropic/claude-x:beta".to_string())
        );
        assert!(parse_cloud_id("cloud:openrouter/").is_err(), "empty model = not configured");
        assert!(parse_cloud_id("cloud:openrouter/a b").is_err());
        assert!(parse_cloud_id("cloud:other/x").is_err());
        assert!(parse_cloud_id("qwen38-27b").is_err());
    }

    #[test]
    fn the_model_is_rewritten_to_the_role_and_usage_is_asked_for() {
        let out = rewrite_body(br#"{"model":"galactus-local","messages":[],"stream":true}"#, "x/y").unwrap();
        let v: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["model"], "x/y");
        assert_eq!(v["usage"]["include"], true);
        assert_eq!(v["stream"], true, "the rest of the request is untouched");
        assert!(rewrite_body(b"[1]", "x").is_err());
        assert!(rewrite_body(b"nope", "x").is_err());
    }

    #[test]
    fn the_key_is_never_on_an_argv() {
        let key = "sk-or-v1-0123456789abcdef";
        let argv = curl_argv();
        assert!(argv.iter().all(|a| !a.contains(key)));
        assert!(argv.windows(2).any(|w| w[0] == "-K" && w[1] == "-"), "config comes from stdin");
        assert!(curl_config("https://u", key, b"{}").contains(&format!("Bearer {key}")));
        let (sec_argv, sec_stdin) = keychain_store_invocation("openrouter", key);
        assert!(sec_argv.iter().all(|a| !a.contains(key)));
        assert!(sec_stdin.contains(key));
    }

    #[test]
    fn a_body_survives_the_curl_config_quoting() {
        let c = curl_config("u", "k", br#"{"a":"q\"x\\y","b":"l1\nl2"}"#);
        let line = c.lines().find(|l| l.starts_with("data-binary")).unwrap();
        assert_eq!(line, r#"data-binary = "{\"a\":\"q\\\"x\\\\y\",\"b\":\"l1\\nl2\"}""#);
    }

    #[test]
    fn a_key_that_could_break_its_quoting_is_refused() {
        assert!(key_is_plausible("sk-or-v1-abcdef0123"));
        for bad in ["short", "has space here", "quote\"inside", "back\\slash", "new\nline0000"] {
            assert!(!key_is_plausible(bad), "{bad}");
        }
    }

    #[test]
    fn the_cap_refuses_at_the_cap_and_not_before() {
        assert!(cap_refusal(4.99, 5.0).is_none());
        assert_eq!(cap_refusal(5.0, 5.0).unwrap(), "cloud daily cap reached (5.00 / 5.00 USD)");
        assert!(cap_refusal(0.0, 0.0).is_some(), "a zero cap means no cloud call at all");
        assert_eq!(cap_from(&HashMap::new()), 5.0);
        assert_eq!(cap_from(&HashMap::from([("cloud_daily_cap_usd".into(), "-1".into())])), 5.0);
        assert_eq!(cap_from(&HashMap::from([("cloud_daily_cap_usd".into(), "2.5".into())])), 2.5);
    }

    #[test]
    fn the_ledger_rolls_over_when_the_date_changes() {
        let yesterday = Ledger {
            date: "2026-09-22".into(),
            calls: vec![CloudCall { cost_usd: 4.0, ..Default::default() }],
        };
        let raw = serde_json::to_string(&yesterday).unwrap();
        assert_eq!(Ledger::for_day(Some(&raw), "2026-09-22").total_usd(), 4.0);
        let today = Ledger::for_day(Some(&raw), "2026-09-23");
        assert_eq!((today.date.as_str(), today.calls.len()), ("2026-09-23", 0));
        assert_eq!(Ledger::for_day(Some("garbage"), "d").calls.len(), 0);
        assert_eq!(Ledger::for_day(None, "d").date, "d");
    }

    #[test]
    fn usage_is_read_from_a_stream_or_a_plain_answer() {
        let sse = b"data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n\
                    data: {\"choices\":[],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":3,\"cost\":0.0042}}\n\n\
                    data: [DONE]\n\n";
        assert_eq!(extract_usage(sse), Some((12, 3, 0.0042)));
        let plain = br#"{"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1,"cost":0.5}}"#;
        assert_eq!(extract_usage(plain), Some((5, 1, 0.5)));
        assert_eq!(extract_usage(b"data: [DONE]\n"), None);
    }

    #[test]
    fn a_foreign_web_page_cannot_spend_through_the_proxy() {
        assert_eq!(origin_check("POST / HTTP/1.1\r\nHost: x"), Ok(None));
        assert_eq!(
            origin_check("POST / HTTP/1.1\r\nOrigin: tauri://localhost"),
            Ok(Some("tauri://localhost".into()))
        );
        assert!(origin_check("POST / HTTP/1.1\r\norigin: https://evil.example").is_err());
    }

    // ------------------------------------------------------------ end to end, loopback only

    /// A fake provider: answers one request with an SSE stream carrying usage,
    /// and hands back the head and body it received.
    fn fake_upstream() -> (u16, std::sync::mpsc::Receiver<String>) {
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                let (head, rest) = crate::relay::read_head(&mut s).unwrap();
                let len = crate::relay::content_length(&head).unwrap_or(0);
                let body = crate::relay::read_body(&mut s, rest, len).unwrap();
                let _ = tx.send(format!("{head}\r\n\r\n{}", String::from_utf8_lossy(&body)));
                let sse = "data: {\"choices\":[{\"delta\":{\"content\":\"bonjour\"}}]}\n\n\
                           data: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":2,\"cost\":1.25}}\n\n\
                           data: [DONE]\n\n";
                let _ = write!(
                    s,
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{sse}",
                    sse.len()
                );
            }
        });
        (port, rx)
    }

    fn ctx(upstream: String, ledger: PathBuf, key: Result<String, String>, calls: Arc<Mutex<Vec<CloudCall>>>) -> ProxyCtx {
        ProxyCtx {
            provider: "openrouter".into(),
            slug: "vendor/expert".into(),
            upstream,
            key: Box::new(move || key.clone()),
            cap_usd: Box::new(|| 2.0),
            ledger,
            today: Box::new(|| "2026-09-23".into()),
            on_call: Box::new(move |c: &CloudCall| calls.lock().unwrap().push(c.clone())),
        }
    }

    fn post(port: u16, body: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(
            s,
            "POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        out
    }

    fn scratch_ledger(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("galactus-cloud-test-{}-{name}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join("ledger.json");
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn a_call_is_forwarded_with_the_key_streamed_back_and_billed_then_capped() {
        let (up, seen) = fake_upstream();
        let ledger = scratch_ledger("e2e");
        let calls = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let port = spawn_proxy(
            ctx(format!("http://127.0.0.1:{up}/v1/chat/completions"), ledger.clone(), Ok("sk-test-key-123".into()), calls.clone()),
            stop.clone(),
        )
        .unwrap();

        let reply = post(port, r#"{"model":"galactus-local","messages":[{"role":"user","content":"hi"}],"stream":true}"#);
        assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");
        assert!(reply.contains("text/event-stream"), "{reply}");
        assert!(reply.contains("bonjour") && reply.contains("[DONE]"), "{reply}");

        let upstream_saw = seen.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(upstream_saw.contains("Bearer sk-test-key-123"), "{upstream_saw}");
        assert!(upstream_saw.contains("X-Title: Galactus"), "{upstream_saw}");
        assert!(upstream_saw.contains("\"model\":\"vendor/expert\""), "{upstream_saw}");
        assert!(upstream_saw.contains("\"include\":true"), "{upstream_saw}");

        assert_eq!(calls.lock().unwrap().len(), 1);
        assert_eq!(calls.lock().unwrap()[0].cost_usd, 1.25);
        let l = ledger_load(&ledger, "2026-09-23");
        assert_eq!((l.calls.len(), l.total_usd()), (1, 1.25));

        // Push the ledger over the cap: the next call is refused without
        // contacting anyone (the fake upstream has already gone).
        ledger_append(&ledger, "2026-09-23", CloudCall { cost_usd: 1.0, ..Default::default() });
        let capped = post(port, r#"{"messages":[]}"#);
        assert!(capped.starts_with("HTTP/1.1 402"), "{capped}");
        assert!(capped.contains("cloud daily cap reached (2.25 / 2.00 USD)"), "{capped}");
        assert_eq!(calls.lock().unwrap().len(), 1, "a refused call is not a call");

        stop_proxy(&stop, port);
    }

    #[test]
    fn with_cloud_off_the_proxy_answers_without_the_network() {
        let ledger = scratch_ledger("off");
        let calls = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        // Port 9 on loopback: nothing listens, and nothing must be tried.
        let port = spawn_proxy(
            ctx("http://127.0.0.1:9/x".into(), ledger, Err("cloud roles are off".into()), calls.clone()),
            stop.clone(),
        )
        .unwrap();
        let reply = post(port, r#"{"messages":[]}"#);
        assert!(reply.starts_with("HTTP/1.1 403"), "{reply}");
        assert!(reply.contains("cloud roles are off"), "{reply}");
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "GET /v1/models HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        assert!(out.starts_with("HTTP/1.1 200") && out.contains("vendor/expert"), "{out}");
        assert!(calls.lock().unwrap().is_empty());
        stop_proxy(&stop, port);
    }

    #[test]
    fn the_test_upstream_is_loopback_or_nothing() {
        assert!(super::is_loopback_url("http://127.0.0.1:8080/v1/chat/completions"));
        assert!(super::is_loopback_url("http://127.0.0.1:9"));
        assert!(!super::is_loopback_url("http://127.0.0.1:1@evil.example/v1"));
        assert!(!super::is_loopback_url("http://127.0.0.1:80.evil.example/"));
        assert!(!super::is_loopback_url("http://127.0.0.1:/x"));
        assert!(!super::is_loopback_url("https://openrouter.ai/api/v1"));
    }
}
