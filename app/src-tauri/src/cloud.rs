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

/// The providers wired today. OpenRouter and OpenAI speak the chat-completions
/// format the agent speaks; Anthropic is translated (anthropic.rs).
pub(crate) const OPENROUTER: &str = "openrouter";
pub(crate) const ANTHROPIC: &str = "anthropic";
pub(crate) const OPENAI: &str = "openai";
const PROVIDERS: [&str; 3] = [OPENROUTER, ANTHROPIC, OPENAI];
const OPENROUTER_CHAT: &str = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODELS: &str = "https://openrouter.ai/api/v1/models";
const OPENAI_CHAT: &str = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODELS: &str = "https://api.openai.com/v1/models";
const ANTHROPIC_MESSAGES: &str = "https://api.anthropic.com/v1/messages";
/// `limit` raised from the default 20 so one click lists every model.
const ANTHROPIC_MODELS: &str = "https://api.anthropic.com/v1/models?limit=1000";
const ANTHROPIC_VERSION: &str = "2023-06-01";
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
    if PROVIDERS.contains(&provider) {
        Ok(())
    } else {
        Err(format!("unknown cloud provider {provider:?}: openrouter, anthropic or openai"))
    }
}

fn chat_url(provider: &str) -> &'static str {
    match provider {
        ANTHROPIC => ANTHROPIC_MESSAGES,
        OPENAI => OPENAI_CHAT,
        _ => OPENROUTER_CHAT,
    }
}

/// The headers that authenticate a call, key included. They only ever go into
/// the curl config on stdin (curl_config), never onto an argv.
fn auth_headers(provider: &str, key: &str) -> Vec<String> {
    match provider {
        ANTHROPIC => vec![format!("x-api-key: {key}"), format!("anthropic-version: {ANTHROPIC_VERSION}")],
        OPENAI => vec![format!("Authorization: Bearer {key}")],
        _ => vec![
            format!("Authorization: Bearer {key}"),
            format!("HTTP-Referer: {APP_REFERER}"),
            format!("X-Title: {APP_TITLE}"),
        ],
    }
}

/// Whether the provider reports what a call cost. Only OpenRouter does; the
/// others are priced here from their token counts (price_for).
fn reports_cost(provider: &str) -> bool {
    provider == OPENROUTER
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

/// Runs a blocking closure off the async workers. Every cloud command waits on
/// a child process (security, curl), and those waits must not park a runtime
/// thread that every other command shares.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("the cloud thread died: {e}"))?
}

#[tauri::command]
pub async fn cloud_key_set(provider: String, key: String) -> Result<(), String> {
    blocking(move || key_set_blocking(&provider, &key)).await
}

fn key_set_blocking(provider: &str, key: &str) -> Result<(), String> {
    let provider = provider.to_string();
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
    blocking(move || key_clear_blocking(&provider)).await
}

fn key_clear_blocking(provider: &str) -> Result<(), String> {
    provider_ok(provider)?;
    let svc = keychain_service(provider);
    // Deleting a key that is not there is what the user asked for: done.
    let _ = security(&["delete-generic-password", "-s", &svc, "-a", KEYCHAIN_ACCOUNT]);
    if keychain_read(provider).is_some() {
        return Err("the Keychain refused to delete the key".into());
    }
    Ok(())
}

/// Whether a key is stored. Never the key itself.
#[tauri::command]
pub async fn cloud_key_status(provider: String) -> Result<bool, String> {
    blocking(move || key_status_blocking(&provider)).await
}

fn key_status_blocking(provider: &str) -> Result<bool, String> {
    provider_ok(provider)?;
    let svc = keychain_service(provider);
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

/// Request fields only llama-server understands. OpenAI answers an unknown
/// field with a 400 ("Unrecognized request argument"), and the agent sends
/// these to every teammate because the local ones need them.
const LLAMA_ONLY: [&str; 12] = [
    "id_slot", "cache_prompt", "chat_template_kwargs", "top_k", "min_p", "typical_p",
    "repeat_penalty", "repeat_last_n", "n_predict", "samplers", "reasoning_format", "timings_per_token",
];

/// The body for OpenAI: the role's model, the llama.cpp extras removed, and
/// on a stream `include_usage`, without which the last chunk carries no token
/// counts and the call could not be priced.
///
/// Two more rewrites, both because the reasoning models (o-series, gpt-5)
/// answer 400 otherwise, and a role may name any OpenAI model:
///   - `max_tokens` becomes `max_completion_tokens`. The reasoning models
///     refuse the old name; every current chat model accepts the new one.
///   - `temperature` and `top_p` are dropped. The reasoning models refuse any
///     value but their default, and the agent sets them for the local models.
pub(crate) fn rewrite_openai(body: &[u8], slug: &str) -> Result<Vec<u8>, String> {
    let mut v: Value = serde_json::from_slice(body).map_err(|e| format!("request is not JSON: {e}"))?;
    let obj = v.as_object_mut().ok_or("request body must be a JSON object")?;
    obj.insert("model".into(), json!(slug));
    for k in LLAMA_ONLY {
        obj.remove(k);
    }
    if let Some(m) = obj.remove("max_tokens") {
        obj.entry("max_completion_tokens").or_insert(m);
    }
    obj.remove("temperature");
    obj.remove("top_p");
    if obj.get("stream").and_then(Value::as_bool) == Some(true) {
        obj.insert("stream_options".into(), json!({"include_usage": true}));
    }
    serde_json::to_vec(&v).map_err(|e| e.to_string())
}

/// The upstream body for a provider, and whether an Anthropic answer will
/// have to be translated back.
fn upstream_body(provider: &str, body: &[u8], slug: &str) -> Result<Vec<u8>, String> {
    match provider {
        OPENAI => rewrite_openai(body, slug),
        ANTHROPIC => {
            let v: Value = serde_json::from_slice(body).map_err(|e| format!("request is not JSON: {e}"))?;
            let (req, _) = crate::anthropic::translate_request(&v, slug)?;
            serde_json::to_vec(&req).map_err(|e| e.to_string())
        }
        _ => rewrite_body(body, slug),
    }
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
/// Without a body it is a GET.
pub(crate) fn curl_config(provider: &str, url: &str, key: &str, body: Option<&[u8]>) -> String {
    let mut lines: Vec<(&str, String)> = vec![("url", url.to_string())];
    for h in auth_headers(provider, key) {
        lines.push(("header", h));
    }
    if let Some(body) = body {
        lines.push(("header", "Content-Type: application/json".to_string()));
        // An empty Expect disables curl's 100-continue on large bodies: one
        // round trip less, and one interim response less to parse.
        lines.push(("header", "Expect:".to_string()));
        lines.push(("data-binary", String::from_utf8_lossy(body).into_owned()));
    }
    let mut c = String::new();
    for (k, v) in lines {
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
fn upstream_url(provider: &str) -> String {
    match std::env::var("GALACTUS_CLOUD_UPSTREAM") {
        Ok(u) if is_loopback_url(&u) => u,
        _ => chat_url(provider).to_string(),
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
    /// True when the provider's usage never arrived (a cut stream) and the
    /// figures above are this app's cautious estimate.
    #[serde(default)]
    pub(crate) estimated: bool,
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

/// USD per million tokens, input and output, for one model: the user's
/// override (settings "cloud_prices_user", `{"<provider>/<model>": [in, out]}`)
/// first, then the table the registry ships ("cloud_prices", same shape).
///
/// Exact ids only. A dated or renamed model has no price until someone sets
/// one, and that refusal is the point: a guessed price is a cap that does not
/// hold.
pub(crate) fn price_for(provider: &str, model: &str, shipped: &Value, user: Option<&str>) -> Option<(f64, f64)> {
    let key = format!("{provider}/{model}");
    let read = |v: &Value| {
        let a = v.as_array()?;
        let (i, o) = (a.first()?.as_f64()?, a.get(1)?.as_f64()?);
        (i.is_finite() && o.is_finite() && i >= 0.0 && o >= 0.0).then_some((i, o))
    };
    user.and_then(|u| serde_json::from_str::<Value>(u).ok())
        .and_then(|u| read(&u[&key]))
        .or_else(|| read(&shipped[&key]))
}

/// The registry's price table, or null when the registry cannot be read.
fn shipped_prices() -> Value {
    galactus_root()
        .ok()
        .and_then(|r| std::fs::read_to_string(r.join("scripts/models-registry.json")).ok())
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .map(|v| v["cloud_prices"].clone())
        .unwrap_or(Value::Null)
}

fn price_now(provider: &str, model: &str) -> Option<(f64, f64)> {
    price_for(provider, model, &shipped_prices(), settings_load().get("cloud_prices_user").map(|s| s.as_str()))
}

/// Usage read from an answer: prompt and completion tokens, and the cost when
/// the provider states one.
pub(crate) type Usage = (u64, u64, Option<f64>);

fn priced(price: (f64, f64), prompt: u64, completion: u64) -> f64 {
    (prompt as f64 * price.0 + completion as f64 * price.1) / 1_000_000.0
}

/// Bytes per token for the estimate. Real text runs nearer four; three counts
/// more tokens than there were, which is the side a cap must err on.
const BYTES_PER_TOKEN: usize = 3;

/// What one call is billed: tokens, cost, and whether that is an estimate.
///
/// With usage: the provider's stated cost (OpenRouter), else the counts at the
/// model's price. WITHOUT usage (a stream cut before its last chunk) the call
/// still happened and was still billed upstream, so zero would be a lie that
/// the cap believes: the tokens are estimated from the bytes that crossed, at
/// the model's price. With no price at all, the call is counted as the whole
/// remaining allowance, which stops the next call until tomorrow rather than
/// letting an unknown spend run on.
pub(crate) fn settle(
    provider: &str,
    price: Option<(f64, f64)>,
    usage: Option<Usage>,
    request_bytes: usize,
    response_bytes: usize,
    remaining_cap: f64,
) -> (u64, u64, f64, bool) {
    if let Some((p, c, reported)) = usage {
        if let (true, Some(cost)) = (reports_cost(provider), reported) {
            return (p, c, cost, false);
        }
        return match price {
            Some(pr) => (p, c, priced(pr, p, c), false),
            None => (p, c, remaining_cap, true),
        };
    }
    let p = request_bytes.div_ceil(BYTES_PER_TOKEN) as u64;
    let c = response_bytes.div_ceil(BYTES_PER_TOKEN) as u64;
    match price {
        Some(pr) => (p, c, priced(pr, p, c), true),
        None => (p, c, remaining_cap, true),
    }
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
pub(crate) fn extract_usage(tail: &[u8]) -> Option<Usage> {
    let text = String::from_utf8_lossy(tail);
    let read = |v: &Value| {
        let u = v.get("usage")?;
        if !u.is_object() {
            return None;
        }
        Some((
            u["prompt_tokens"].as_u64().unwrap_or(0),
            u["completion_tokens"].as_u64().unwrap_or(0),
            u["cost"].as_f64(),
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
/// the user presses the button; it sends nothing but the request itself (and,
/// for Anthropic and OpenAI, the key, which their list requires).
///
/// Each entry: id, name, context_length (OpenRouter only), the provider's own
/// per-token prices (OpenRouter only), and `price_per_mtok`, the [in, out] USD
/// per million this app would bill against the cap, or null when unknown.
#[tauri::command]
pub async fn cloud_models(provider: String) -> Result<Vec<Value>, String> {
    blocking(move || models_blocking(provider)).await
}

fn models_blocking(provider: String) -> Result<Vec<Value>, String> {
    provider_ok(&provider)?;
    let url = match provider.as_str() {
        ANTHROPIC => ANTHROPIC_MODELS,
        OPENAI => OPENAI_MODELS,
        _ => OPENROUTER_MODELS,
    };
    let mut cmd = Command::new("curl");
    cmd.args(["-sS", "--max-time", "30", "-K", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // OpenRouter's list is public; the other two want the key, which goes on
    // stdin like every other call.
    let key = if reports_cost(&provider) {
        String::new()
    } else {
        keychain_read(&provider)
            .ok_or_else(|| format!("no {provider} API key is stored: add one first to list its models"))?
    };
    let config = if key.is_empty() {
        format!("url = {}\n", curl_quote(url))
    } else {
        curl_config(&provider, url, &key, None)
    };
    let mut child = cmd.spawn().map_err(|e| format!("curl: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(config.as_bytes());
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("could not list models: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|_| "unreadable model list".to_string())?;
    if let Some(msg) = v["error"]["message"].as_str() {
        return Err(format!("{provider}: {msg}"));
    }
    let data = v["data"].as_array().ok_or("unreadable model list")?;
    let shipped = shipped_prices();
    let settings = settings_load();
    let user = settings.get("cloud_prices_user").map(|s| s.as_str());
    Ok(data
        .iter()
        .map(|m| {
            let id = m["id"].as_str().unwrap_or("");
            json!({
                "id": id,
                "name": m.get("name").or(m.get("display_name")).cloned().unwrap_or(json!(id)),
                "context_length": m["context_length"],
                "prompt_usd_per_token": m.pointer("/pricing/prompt"),
                "completion_usd_per_token": m.pointer("/pricing/completion"),
                "price_per_mtok": price_for(&provider, id, &shipped, user).map(|(i, o)| json!([i, o])),
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
    /// USD per million tokens [in, out]; required for a provider that does not
    /// report its cost, checked at engine start (preflight).
    pub(crate) price: Option<(f64, f64)>,
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
    let cap = (ctx.cap_usd)();
    if let Some(msg) = cap_refusal(spent, cap) {
        return reply_error(client, 402, &msg, "cloud_cap", origin);
    }
    let upstream_body = match upstream_body(&ctx.provider, &body, &ctx.slug) {
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
        let _ = stdin.write_all(curl_config(&ctx.provider, &ctx.upstream, &key, Some(&upstream_body)).as_bytes());
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
        // The buffer is scanned BEFORE reading again: an interim 1xx head and
        // the final head often arrive in the same read, and reading first
        // would wait on a socket that has nothing more to say.
        if let Some((status, ct, end)) = parse_upstream_head(&buf) {
            if (100..200).contains(&status) {
                buf.drain(..end);
                continue;
            }
            break (status, ct, end);
        }
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
    };
    let rest = buf[body_start..].to_vec();
    let (usage, received) = if ctx.provider == ANTHROPIC {
        relay_anthropic(client, &mut out, rest, status, &content_type, origin)
    } else {
        relay_as_is(client, &mut out, rest, status, &content_type, origin)
    };
    let _ = child.wait();
    if (200..300).contains(&status) {
        let (prompt_tokens, completion_tokens, cost_usd, estimated) = settle(
            &ctx.provider,
            ctx.price,
            usage,
            upstream_body.len(),
            received,
            (cap - spent).max(0.0),
        );
        if estimated {
            eprintln!(
                "galactus cloud: {} {} ended without usage; billed an estimate of {cost_usd:.4} USD \
                 ({prompt_tokens} + {completion_tokens} tokens) against the daily cap",
                ctx.provider, ctx.slug
            );
        }
        let call = CloudCall {
            provider: ctx.provider.clone(),
            model: ctx.slug.clone(),
            prompt_tokens,
            completion_tokens,
            cost_usd,
            estimated,
        };
        ledger_append(&ctx.ledger, &today, call.clone());
        (ctx.on_call)(&call);
    }
}

/// The first complete response head in `buf`: status, content type, and where
/// the head ends (the body, or the next head, starts there).
pub(crate) fn parse_upstream_head(buf: &[u8]) -> Option<(u16, String, usize)> {
    let end = buf.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head_text = String::from_utf8_lossy(&buf[..end]).into_owned();
    let status = head_text
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(502);
    let ct = header(&format!("{head_text}\r\n"), "content-type")
        .unwrap_or("application/json")
        .to_string();
    Some((status, ct, end + 4))
}

/// Write to the client unless it has gone. A client that went away does not
/// stop the reading: the provider bills the call anyway, and the ledger has to
/// see what it cost.
fn send(client: &mut TcpStream, gone: &mut bool, bytes: &[u8]) {
    if !*gone && (client.write_all(bytes).is_err() || client.flush().is_err()) {
        *gone = true;
    }
}

fn response_head(status: u16, content_type: &str, origin: &Option<String>) -> String {
    format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: {content_type}\r\nCache-Control: no-cache\r\n{}Connection: close\r\n\r\n",
        reason(status),
        cors(origin)
    )
}

/// OpenRouter and OpenAI: the answer is already what the agent reads, so it is
/// copied as it arrives, and its tail kept for the usage.
fn relay_as_is(
    client: &mut TcpStream,
    out: &mut impl Read,
    first: Vec<u8>,
    status: u16,
    content_type: &str,
    origin: &Option<String>,
) -> (Option<Usage>, usize) {
    let mut gone = false;
    send(client, &mut gone, response_head(status, content_type, origin).as_bytes());
    send(client, &mut gone, &first);
    let mut received = first.len();
    let mut tail = first;
    let mut chunk = [0u8; 16 * 1024];
    loop {
        let n = match out.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        send(client, &mut gone, &chunk[..n]);
        received += n;
        tail.extend_from_slice(&chunk[..n]);
        if tail.len() > 2 * TAIL_KEEP {
            tail.drain(..tail.len() - TAIL_KEEP);
        }
    }
    (extract_usage(&tail), received)
}

/// Anthropic: every answer is translated back to the OpenAI shape. A stream
/// event by event as it arrives; a whole answer or an error once complete.
fn relay_anthropic(
    client: &mut TcpStream,
    out: &mut impl Read,
    first: Vec<u8>,
    status: u16,
    content_type: &str,
    origin: &Option<String>,
) -> (Option<Usage>, usize) {
    let mut gone = false;
    let mut chunk = [0u8; 16 * 1024];
    if (200..300).contains(&status) && content_type.contains("event-stream") {
        send(client, &mut gone, response_head(200, "text/event-stream", origin).as_bytes());
        let mut t = crate::anthropic::StreamTranslator::new();
        let mut received = first.len();
        let translated = t.feed(&first);
        send(client, &mut gone, translated.as_bytes());
        loop {
            let n = match out.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            received += n;
            let translated = t.feed(&chunk[..n]);
            send(client, &mut gone, translated.as_bytes());
        }
        let last = t.finish();
        send(client, &mut gone, last.as_bytes());
        // A stream cut before message_stop has partial counts: reported as
        // unknown, so the call is estimated rather than under-billed.
        let usage = t.completed().then_some((t.prompt_tokens, t.completion_tokens, None));
        return (usage, received);
    }
    // Whole bodies are small (an answer or an error): read to the end.
    let mut body = first;
    let _ = out.read_to_end(&mut body);
    let received = body.len();
    if !(200..300).contains(&status) {
        reply_json(client, status, &crate::anthropic::translate_error(status, &body), origin);
        return (None, received);
    }
    match serde_json::from_slice::<Value>(&body) {
        Ok(v) => {
            let (answer, p, c) = crate::anthropic::translate_response(&v);
            reply_json(client, 200, &answer, origin);
            (Some((p, c, None)), received)
        }
        Err(_) => {
            reply_error(client, 502, "anthropic: unreadable answer", "upstream", origin);
            (None, received)
        }
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
pub(crate) fn app_ctx(app: AppHandle, provider: &str, slug: &str, price: Option<(f64, f64)>) -> ProxyCtx {
    let p = provider.to_string();
    ProxyCtx {
        provider: provider.to_string(),
        slug: slug.to_string(),
        upstream: upstream_url(provider),
        price,
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
                       "completion_tokens": c.completion_tokens, "cost_usd": c.cost_usd,
                       "estimated": c.estimated}),
            );
        }),
    }
}

/// The checks a cloud engine start makes before it listens.
/// (provider, model slug, price per million tokens in and out when known).
pub(crate) type Preflight = (String, String, Option<(f64, f64)>);

pub(crate) fn preflight(model_id: &str) -> Result<Preflight, String> {
    let (provider, slug) = parse_cloud_id(model_id)?;
    let settings = settings_load();
    // The setting first: with cloud off, not even the Keychain is asked.
    cloud_gate(&settings, &provider, true)?;
    // OpenRouter reports each call's cost, but a cut stream reports nothing:
    // its public price list is read once here (the user has just switched the
    // role on) so that such a call can still be estimated in dollars.
    let price = price_now(&provider, &slug).or_else(|| {
        if provider != OPENROUTER {
            return None;
        }
        let found = openrouter_price(&slug);
        if found.is_none() {
            eprintln!("galactus cloud: no OpenRouter price found for {slug}; a call without usage will count as the rest of the daily cap");
        }
        found
    });
    require_price(&provider, &slug, price)?;
    cloud_gate(&settings, &provider, keychain_read(&provider).is_some())?;
    Ok((provider, slug, price))
}

/// USD per million [in, out] for one model in OpenRouter's public model list,
/// whose prices are strings of USD per token.
pub(crate) fn openrouter_price_in(list: &Value, slug: &str) -> Option<(f64, f64)> {
    let m = list["data"].as_array()?.iter().find(|m| m["id"].as_str() == Some(slug))?;
    let num = |v: &Value| v.as_f64().or_else(|| v.as_str()?.trim().parse::<f64>().ok());
    let (i, o) = (num(&m["pricing"]["prompt"])?, num(&m["pricing"]["completion"])?);
    (i.is_finite() && o.is_finite() && i >= 0.0 && o >= 0.0).then_some((i * 1e6, o * 1e6))
}

fn openrouter_price(slug: &str) -> Option<(f64, f64)> {
    let out = Command::new("curl").args(["-sS", "--max-time", "20", OPENROUTER_MODELS]).output().ok()?;
    let v: Value = serde_json::from_slice(&out.stdout).ok()?;
    openrouter_price_in(&v, slug)
}

/// A provider that does not report its cost is only started with a price:
/// without one, every call would be billed at zero and the cap never reached.
pub(crate) fn require_price(provider: &str, model: &str, price: Option<(f64, f64)>) -> Result<(), String> {
    if reports_cost(provider) || price.is_some() {
        return Ok(());
    }
    Err(format!(
        "no price for {model}: set it in Settings > Cloud, the daily cap cannot be enforced without it."
    ))
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
        for provider in PROVIDERS {
            let config = curl_config(provider, "https://u", key, Some(b"{}"));
            assert!(config.contains(key), "{provider}: the key travels in the config");
            let (sec_argv, sec_stdin) = keychain_store_invocation(provider, key);
            assert!(sec_argv.iter().all(|a| !a.contains(key)), "{provider}");
            assert!(sec_stdin.contains(key));
        }
        // The argv of the model list call is fixed too, and carries no key.
        assert!(curl_config(ANTHROPIC, "https://u", key, None).contains(&format!("x-api-key: {key}")));
        assert!(curl_config(OPENAI, "https://u", key, None).contains(&format!("Authorization: Bearer {key}")));
        assert!(!curl_config(ANTHROPIC, "u", key, None).contains("data-binary"), "a list is a GET");
    }

    #[test]
    fn a_body_survives_the_curl_config_quoting() {
        let c = curl_config(OPENROUTER, "u", "k", Some(br#"{"a":"q\"x\\y","b":"l1\nl2"}"#));
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
        assert_eq!(extract_usage(sse), Some((12, 3, Some(0.0042))));
        let plain = br#"{"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1,"cost":0.5}}"#;
        assert_eq!(extract_usage(plain), Some((5, 1, Some(0.5))));
        let no_cost = br#"{"usage":{"prompt_tokens":5,"completion_tokens":1}}"#;
        assert_eq!(extract_usage(no_cost), Some((5, 1, None)), "an absent cost is not a zero cost");
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
        let sse = "data: {\"choices\":[{\"delta\":{\"content\":\"bonjour\"}}]}\n\n\
                   data: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":2,\"cost\":1.25}}\n\n\
                   data: [DONE]\n\n";
        fake_upstream_with(200, "text/event-stream", sse.to_string())
    }

    /// A fake provider answering one request with this status, type and body.
    fn fake_upstream_with(status: u16, content_type: &'static str, reply: String) -> (u16, std::sync::mpsc::Receiver<String>) {
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                let (head, rest) = crate::relay::read_head(&mut s).unwrap();
                let len = crate::relay::content_length(&head).unwrap_or(0);
                let body = crate::relay::read_body(&mut s, rest, len).unwrap();
                let _ = tx.send(format!("{head}\r\n\r\n{}", String::from_utf8_lossy(&body)));
                let _ = write!(
                    s,
                    "HTTP/1.1 {status} X\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\r\n{reply}",
                    reply.len()
                );
            }
        });
        (port, rx)
    }

    fn ctx(upstream: String, ledger: PathBuf, key: Result<String, String>, calls: Arc<Mutex<Vec<CloudCall>>>) -> ProxyCtx {
        ctx_for(OPENROUTER, "vendor/expert", None, upstream, ledger, key, calls)
    }

    fn ctx_for(
        provider: &str,
        slug: &str,
        price: Option<(f64, f64)>,
        upstream: String,
        ledger: PathBuf,
        key: Result<String, String>,
        calls: Arc<Mutex<Vec<CloudCall>>>,
    ) -> ProxyCtx {
        ProxyCtx {
            provider: provider.into(),
            slug: slug.into(),
            price,
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

    /// Live check against the real OpenRouter, never run by default: it costs
    /// real (tiny) money and needs a key. Run with
    ///   GALACTUS_LIVE_OPENROUTER_KEY=sk-or-... cargo test --lib live_openrouter -- --ignored --nocapture
    /// It drives the same proxy the app starts: a stream, a tool call, the
    /// tool result sent back, and the cost read from usage.cost into the ledger.
    #[test]
    #[ignore]
    fn live_openrouter_roundtrip() {
        let Ok(key) = std::env::var("GALACTUS_LIVE_OPENROUTER_KEY") else {
            panic!("set GALACTUS_LIVE_OPENROUTER_KEY");
        };
        let ledger = scratch_ledger("live-openrouter");
        let calls = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let port = spawn_proxy(
            ctx_for(OPENROUTER, "openai/gpt-oss-20b", None, OPENROUTER_CHAT.into(), ledger.clone(), Ok(key), calls.clone()),
            stop.clone(),
        )
        .unwrap();

        // 1. A stream, as the agent sends it (llama.cpp extras included, which
        //    the provider must not choke on).
        let reply = post(port, r#"{"model":"x","stream":true,"max_tokens":200,"temperature":0.6,"id_slot":0,"messages":[{"role":"user","content":"Reply with the single word: bonjour"}]}"#);
        eprintln!("--- stream ---\n{}", &reply[..reply.len().min(600)]);
        assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");
        assert!(reply.contains("[DONE]"), "{reply}");

        // 2. A tool call, non-streamed.
        let tools = r#"[{"type":"function","function":{"name":"get_time","description":"Current local time","parameters":{"type":"object","properties":{}}}}]"#;
        let body = format!(r#"{{"model":"x","max_tokens":400,"tools":{tools},"messages":[{{"role":"user","content":"What time is it? Use the tool."}}]}}"#);
        let reply = post(port, &body);
        let json_at = reply.find("\r\n\r\n").map(|i| i + 4).unwrap_or(0);
        let v: Value = serde_json::from_str(reply[json_at..].trim()).unwrap_or(Value::Null);
        eprintln!("--- tool call ---\n{}", &reply[..reply.len().min(900)]);
        let call = &v["choices"][0]["message"]["tool_calls"][0];
        assert_eq!(call["function"]["name"], "get_time", "{reply}");
        let id = call["id"].as_str().unwrap_or("call_0").to_string();

        // 3. The tool result goes back; a final answer comes out.
        let body = format!(
            r#"{{"model":"x","max_tokens":400,"tools":{tools},"messages":[{{"role":"user","content":"What time is it? Use the tool."}},{{"role":"assistant","content":"","tool_calls":[{{"id":"{id}","type":"function","function":{{"name":"get_time","arguments":"{{}}"}}}}]}},{{"role":"tool","tool_call_id":"{id}","content":"14:32"}}]}}"#
        );
        let reply = post(port, &body);
        eprintln!("--- final ---\n{}", &reply[..reply.len().min(900)]);
        assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");
        assert!(reply.contains("14"), "{reply}");

        let got = calls.lock().unwrap().clone();
        eprintln!("--- billed ---\n{got:?}");
        assert_eq!(got.len(), 3, "{got:?}");
        assert!(got.iter().all(|c| c.cost_usd > 0.0 && !c.estimated), "{got:?}");
        let l = ledger_load(&ledger, "2026-09-23");
        assert_eq!(l.calls.len(), 3);
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

    // ------------------------------------------------------------ providers

    #[test]
    fn openai_gets_its_model_no_llama_extras_and_usage_on_streams() {
        let out = rewrite_openai(
            br#"{"model":"galactus-local","stream":true,"id_slot":1,"cache_prompt":true,"chat_template_kwargs":{},"temperature":0.2,"messages":[]}"#,
            "gpt-5",
        )
        .unwrap();
        let v: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["model"], "gpt-5");
        assert_eq!(v["stream_options"]["include_usage"], true);
        for k in ["id_slot", "cache_prompt", "chat_template_kwargs"] {
            assert!(v.get(k).is_none(), "{k}");
        }
        assert!(v.get("temperature").is_none(), "the reasoning models refuse it");
        let m: Value = serde_json::from_slice(
            &rewrite_openai(br#"{"max_tokens":900,"top_p":0.9,"messages":[]}"#, "o4").unwrap(),
        )
        .unwrap();
        assert_eq!(m["max_completion_tokens"], 900);
        assert!(m.get("max_tokens").is_none() && m.get("top_p").is_none(), "{m}");
        let both: Value = serde_json::from_slice(
            &rewrite_openai(br#"{"max_tokens":900,"max_completion_tokens":50,"messages":[]}"#, "o4").unwrap(),
        )
        .unwrap();
        assert_eq!(both["max_completion_tokens"], 50, "an explicit new-style value wins");
        assert!(both.get("max_tokens").is_none());
        let whole: Value = serde_json::from_slice(&rewrite_openai(br#"{"messages":[]}"#, "gpt-5").unwrap()).unwrap();
        assert!(whole.get("stream_options").is_none(), "only a stream needs it");
    }

    #[test]
    fn prices_come_from_the_user_first_then_the_registry() {
        let shipped = json!({"anthropic/claude-opus-5": [5, 25], "anthropic/bad": ["x", 1]});
        assert_eq!(price_for(ANTHROPIC, "claude-opus-5", &shipped, None), Some((5.0, 25.0)));
        let user = r#"{"anthropic/claude-opus-5": [4, 20], "openai/gpt-5": [1.25, 10]}"#;
        assert_eq!(price_for(ANTHROPIC, "claude-opus-5", &shipped, Some(user)), Some((4.0, 20.0)));
        assert_eq!(price_for(OPENAI, "gpt-5", &shipped, Some(user)), Some((1.25, 10.0)));
        assert_eq!(price_for(ANTHROPIC, "bad", &shipped, None), None, "a malformed entry is ignored");
        assert_eq!(price_for(ANTHROPIC, "claude-opus-5-20990101", &shipped, None), None, "exact ids only");
        let bad_user = r#"{"anthropic/claude-opus-5": [-1, 2]}"#;
        assert_eq!(price_for(ANTHROPIC, "claude-opus-5", &shipped, Some(bad_user)), Some((5.0, 25.0)));
        assert_eq!(price_for(ANTHROPIC, "claude-opus-5", &shipped, Some("not json")), Some((5.0, 25.0)));
    }

    #[test]
    fn cost_is_the_providers_or_the_token_counts_at_the_price() {
        assert_eq!(settle(OPENROUTER, None, Some((1000, 1000, Some(0.42))), 0, 0, 5.0), (1000, 1000, 0.42, false));
        // 1M in at $5 plus 200k out at $25; a stated cost from Anthropic is not trusted over the table.
        let (_, _, cost, est) = settle(ANTHROPIC, Some((5.0, 25.0)), Some((1_000_000, 200_000, Some(99.0))), 0, 0, 5.0);
        assert!((cost - 10.0).abs() < 1e-9 && !est);
        let (_, _, cost, _) = settle(OPENAI, Some((1.25, 10.0)), Some((2000, 500, None)), 0, 0, 5.0);
        assert!((cost - 0.0075).abs() < 1e-12);
        // OpenRouter with usage but no stated cost falls back on its price.
        let (_, _, cost, est) = settle(OPENROUTER, Some((2.0, 8.0)), Some((1_000_000, 0, None)), 0, 0, 5.0);
        assert!((cost - 2.0).abs() < 1e-9 && !est);
    }

    #[test]
    fn a_call_without_usage_is_estimated_never_free() {
        // Cut stream, price known: bytes / 3 at the price, marked estimated.
        let (p, c, cost, est) = settle(OPENAI, Some((1.0, 10.0)), None, 3000, 30_001, 5.0);
        assert_eq!((p, c, est), (1000, 10_001, true));
        assert!((cost - (1000.0 * 1.0 + 10_001.0 * 10.0) / 1e6).abs() < 1e-12);
        assert!(cost > 0.0);
        // No price at all: the rest of the allowance, so the next call is refused.
        let (_, _, cost, est) = settle(OPENROUTER, None, None, 300, 300, 3.75);
        assert_eq!((cost, est), (3.75, true));
        assert!(cap_refusal(1.25 + cost, 5.0).is_some());
        // Tokens known, no cost and no price: same rule.
        assert_eq!(settle(OPENROUTER, None, Some((10, 10, None)), 0, 0, 2.0), (10, 10, 2.0, true));
        // An old ledger line without the flag still reads.
        let old: CloudCall = serde_json::from_str(
            r#"{"provider":"openrouter","model":"m","prompt_tokens":1,"completion_tokens":1,"cost_usd":0.1}"#,
        )
        .unwrap();
        assert!(!old.estimated);
    }

    #[test]
    fn openrouter_prices_are_read_from_its_public_list() {
        let list = json!({"data": [
            {"id": "vendor/a", "pricing": {"prompt": "0.000003", "completion": "0.000015"}},
            {"id": "vendor/b", "pricing": {"prompt": "x", "completion": "0"}}]});
        let (i, o) = openrouter_price_in(&list, "vendor/a").unwrap();
        assert!((i - 3.0).abs() < 1e-9 && (o - 15.0).abs() < 1e-9);
        assert_eq!(openrouter_price_in(&list, "vendor/b"), None);
        assert_eq!(openrouter_price_in(&list, "absent"), None);
    }

    #[test]
    fn an_interim_head_is_skipped_even_when_the_final_one_arrived_with_it() {
        let both = b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: x";
        let (status, _, end) = parse_upstream_head(both).unwrap();
        assert_eq!(status, 100);
        let rest = &both[end..];
        let (status, ct, end2) = parse_upstream_head(rest).unwrap();
        assert_eq!((status, ct.as_str()), (200, "text/event-stream"));
        assert_eq!(&rest[end2..], b"data: x");
        assert!(curl_config(OPENAI, "u", "k", Some(b"{}")).contains("header = \"Expect:\""));
    }

    #[test]
    fn blocking_commands_leave_the_async_workers() {
        // Each of these waits on a process or holds the planning lock for
        // seconds; run on an async worker, it parks a thread every other
        // command shares.
        let sources = [
            (include_str!("engine.rs"), ["server_start", "server_stop"].as_slice()),
            (include_str!("engines.rs"), ["engine_start", "engine_stop", "engines_stop_all_extras"].as_slice()),
            (include_str!("cloud.rs"), ["cloud_key_set", "cloud_key_clear", "cloud_key_status", "cloud_models"].as_slice()),
        ];
        for (src, names) in sources {
            for name in names {
                let at = src.find(&format!("pub async fn {name}(")).unwrap_or_else(|| panic!("{name}"));
                let body = &src[at..at + src[at..].find("\n}\n").unwrap()];
                assert!(body.contains("spawn_blocking") || body.contains("blocking(move"), "{name} blocks a worker");
            }
        }
    }

    #[test]
    fn a_provider_without_a_price_does_not_start() {
        let err = require_price(ANTHROPIC, "claude-new", None).unwrap_err();
        assert_eq!(
            err,
            "no price for claude-new: set it in Settings > Cloud, the daily cap cannot be enforced without it."
        );
        assert!(require_price(OPENAI, "gpt-x", None).is_err());
        assert!(require_price(OPENROUTER, "any/model", None).is_ok(), "OpenRouter reports its cost");
        assert!(require_price(ANTHROPIC, "claude-opus-5", Some((5.0, 25.0))).is_ok());
        assert!(parse_cloud_id("cloud:anthropic/claude-opus-5").is_ok());
        assert!(parse_cloud_id("cloud:openai/gpt-5.2").is_ok());
    }

    fn post_json(port: u16, body: &Value) -> String {
        post(port, &body.to_string())
    }

    #[test]
    fn anthropic_end_to_end_stream_is_translated_and_billed_at_its_price() {
        let (up, seen) = fake_upstream_with(200, "text/event-stream", crate::anthropic::tests::RECORDED.to_string());
        let ledger = scratch_ledger("anthropic-stream");
        let calls = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let port = spawn_proxy(
            ctx_for(ANTHROPIC, "claude-opus-5", Some((5.0, 25.0)), format!("http://127.0.0.1:{up}/v1/messages"),
                    ledger.clone(), Ok("sk-ant-test-0001".into()), calls.clone()),
            stop.clone(),
        )
        .unwrap();
        let reply = post_json(port, &json!({
            "model": "galactus-local", "stream": true, "temperature": 0.7,
            "messages": [{"role": "system", "content": "Be brief."}, {"role": "user", "content": "Lis a.txt"}]
        }));
        assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");
        assert!(reply.contains("text/event-stream"));
        assert!(reply.contains("\"reasoning_content\":\"Il faut lire le fichier.\""), "{reply}");
        assert!(reply.contains("\"finish_reason\":\"tool_calls\""), "{reply}");
        assert!(reply.trim_end().ends_with("data: [DONE]"), "{reply}");

        let upstream_saw = seen.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(upstream_saw.contains("x-api-key: sk-ant-test-0001"), "{upstream_saw}");
        assert!(upstream_saw.contains("anthropic-version: 2023-06-01"), "{upstream_saw}");
        assert!(!upstream_saw.contains("Authorization"), "{upstream_saw}");
        assert!(upstream_saw.contains("\"system\":\"Be brief.\""), "{upstream_saw}");
        assert!(!upstream_saw.contains("temperature"), "{upstream_saw}");

        // 1672 prompt tokens at $5/M plus 89 at $25/M.
        let c = calls.lock().unwrap()[0].clone();
        assert_eq!((c.prompt_tokens, c.completion_tokens), (1672, 89));
        assert!((c.cost_usd - (1672.0 * 5.0 + 89.0 * 25.0) / 1e6).abs() < 1e-12, "{}", c.cost_usd);
        assert_eq!(ledger_load(&ledger, "2026-09-23").calls.len(), 1);
        stop_proxy(&stop, port);
    }

    #[test]
    fn anthropic_errors_reach_the_agent_in_the_openai_shape_and_cost_nothing() {
        let body = r#"{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: too large"}}"#;
        let (up, _seen) = fake_upstream_with(400, "application/json", body.to_string());
        let ledger = scratch_ledger("anthropic-error");
        let calls = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let port = spawn_proxy(
            ctx_for(ANTHROPIC, "claude-opus-5", Some((5.0, 25.0)), format!("http://127.0.0.1:{up}/v1/messages"),
                    ledger.clone(), Ok("sk-ant-test-0001".into()), calls.clone()),
            stop.clone(),
        )
        .unwrap();
        let reply = post_json(port, &json!({"messages": [{"role": "user", "content": "hi"}]}));
        assert!(reply.starts_with("HTTP/1.1 400"), "{reply}");
        assert!(reply.contains("\"message\":\"anthropic: max_tokens: too large\""), "{reply}");
        assert!(reply.contains("\"type\":\"invalid_request_error\""), "{reply}");
        assert!(calls.lock().unwrap().is_empty());
        stop_proxy(&stop, port);
    }

    #[test]
    fn anthropic_whole_answer_end_to_end() {
        let body = json!({"id": "msg_9", "type": "message", "model": "claude-opus-5", "role": "assistant",
                          "content": [{"type": "text", "text": "Bonjour."}], "stop_reason": "end_turn",
                          "usage": {"input_tokens": 10, "output_tokens": 3}});
        let (up, _seen) = fake_upstream_with(200, "application/json", body.to_string());
        let ledger = scratch_ledger("anthropic-whole");
        let calls = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let port = spawn_proxy(
            ctx_for(ANTHROPIC, "claude-opus-5", Some((5.0, 25.0)), format!("http://127.0.0.1:{up}/v1/messages"),
                    ledger, Ok("sk-ant-test-0001".into()), calls.clone()),
            stop.clone(),
        )
        .unwrap();
        let reply = post_json(port, &json!({"messages": [{"role": "user", "content": "hi"}]}));
        let json_part = &reply[reply.find("\r\n\r\n").unwrap() + 4..];
        let v: Value = serde_json::from_str(json_part).unwrap();
        assert_eq!(v["choices"][0]["message"]["content"], "Bonjour.");
        assert_eq!(v["choices"][0]["finish_reason"], "stop");
        assert_eq!(v["usage"]["prompt_tokens"], 10);
        assert_eq!(calls.lock().unwrap()[0].completion_tokens, 3);
        stop_proxy(&stop, port);
    }

    #[test]
    fn openai_end_to_end_is_billed_at_its_price_from_the_usage_chunk() {
        let sse = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"}}]}\n\n\
                   data: {\"choices\":[],\"usage\":{\"prompt_tokens\":2000,\"completion_tokens\":500}}\n\n\
                   data: [DONE]\n\n";
        let (up, seen) = fake_upstream_with(200, "text/event-stream", sse.to_string());
        let ledger = scratch_ledger("openai");
        let calls = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let port = spawn_proxy(
            ctx_for(OPENAI, "gpt-5", Some((1.25, 10.0)), format!("http://127.0.0.1:{up}/v1/chat/completions"),
                    ledger, Ok("sk-proj-test-0001".into()), calls.clone()),
            stop.clone(),
        )
        .unwrap();
        let reply = post_json(port, &json!({"stream": true, "id_slot": 0, "messages": [{"role": "user", "content": "hi"}]}));
        assert!(reply.contains("\"content\":\"ok\""), "{reply}");
        let upstream_saw = seen.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(upstream_saw.contains("Authorization: Bearer sk-proj-test-0001"), "{upstream_saw}");
        assert!(upstream_saw.contains("\"include_usage\":true") && !upstream_saw.contains("id_slot"), "{upstream_saw}");
        assert!((calls.lock().unwrap()[0].cost_usd - 0.0075).abs() < 1e-12);
        stop_proxy(&stop, port);
    }

    #[test]
    fn a_cut_stream_is_billed_an_estimate_and_marked() {
        // No usage chunk, no [DONE]: the connection just ends.
        let sse = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"par\"}}]}\n\n";
        let (up, _seen) = fake_upstream_with(200, "text/event-stream", sse.to_string());
        let ledger = scratch_ledger("cut");
        let calls = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let port = spawn_proxy(
            ctx_for(OPENAI, "gpt-5", Some((1.25, 10.0)), format!("http://127.0.0.1:{up}/v1/chat/completions"),
                    ledger.clone(), Ok("sk-proj-test-0001".into()), calls.clone()),
            stop.clone(),
        )
        .unwrap();
        let _ = post_json(port, &json!({"stream": true, "messages": [{"role": "user", "content": "hi"}]}));
        let c = calls.lock().unwrap()[0].clone();
        assert!(c.estimated && c.cost_usd > 0.0, "{c:?}");
        assert!(ledger_load(&ledger, "2026-09-23").calls[0].estimated);
        stop_proxy(&stop, port);
    }

    #[test]
    fn an_interim_continue_from_upstream_is_passed_over() {
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let up = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                let (head, rest) = crate::relay::read_head(&mut s).unwrap();
                let len = crate::relay::content_length(&head).unwrap_or(0);
                let _ = crate::relay::read_body(&mut s, rest, len);
                let body = r#"{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0.01}}"#;
                // Both heads in one write: the proxy must not wait for more.
                let _ = write!(
                    s,
                    "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        let ledger = scratch_ledger("continue");
        let calls = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let port = spawn_proxy(
            ctx(format!("http://127.0.0.1:{up}/v1/chat/completions"), ledger, Ok("sk-test-key-123".into()), calls.clone()),
            stop.clone(),
        )
        .unwrap();
        let reply = post(port, r#"{"messages":[]}"#);
        assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");
        assert!(reply.contains("\"content\":\"ok\""), "{reply}");
        assert_eq!(calls.lock().unwrap()[0].cost_usd, 0.01);
        stop_proxy(&stop, port);
    }
}
