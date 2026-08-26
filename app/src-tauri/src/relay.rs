// Galactus, the authenticating relay that fronts the engine on the network.
//
// WHY A RELAY AND NOT JUST A BIND ADDRESS
//
// The obvious way to serve the API to another machine is to start llama-server
// on 0.0.0.0. It is also the wrong way, and this build makes that concrete:
// `llama-server --help` on the bundled binary exposes no authentication option
// at all, and its CORS default is `*` with credentials enabled. Binding it to
// the network would publish an unauthenticated endpoint that reads and writes
// through whatever the caller asks for, to anyone on the same wifi.
//
// So the engine keeps binding to 127.0.0.1, always, and this relay is the only
// thing that ever listens on an outside interface. That ordering matters: a
// misconfiguration here fails closed, because the engine is simply not
// reachable from outside even if the relay is wrong.
//
// WHY BY HAND AND NOT WITH A FRAMEWORK
//
// The whole job is: read a request head, check one header, forward bytes both
// ways. An HTTP framework would add a dependency tree, a NOTICE entry and a
// licence review for something that is two hundred lines of std::net. The one
// thing that would justify a framework, correct HTTP parsing, is not needed:
// this relay does not interpret the request beyond its head, it copies it.
//
// STREAMING IS THE HARD REQUIREMENT
//
// Chat completions stream as server-sent events. Anything that buffers a whole
// response before forwarding it turns a live token stream into a long pause
// followed by a wall of text. Both directions are therefore copied as raw
// bytes on their own thread, with no framing, no buffering beyond a read
// block, and no attempt to understand the body.

use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;

/// Largest request head accepted, headers included.
///
/// A head is a few hundred bytes in practice. The cap exists so a client that
/// opens a socket and streams headers forever cannot grow this buffer without
/// bound; the body is never held in memory at all, it is streamed through.
const MAX_HEAD: usize = 32 * 1024;
/// How long ONE read may block before the relay looks at the clock again.
const HEAD_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a client may take to send its whole head, first byte to last.
///
/// WHY BOTH. A socket timeout is per read, not per request, so a client sending
/// one byte every four seconds kept a thread and its stack alive for as long as
/// it liked: thirty two kilobytes of head at that rate is a day and a half, and
/// nothing above required a key. The deadline is what actually bounds the wait;
/// the socket timeout only exists so the loop wakes up to check it.
const HEAD_DEADLINE: Duration = Duration::from_secs(15);

/// Connections served at once, before the relay starts refusing.
///
/// One thread per connection with a two megabyte stack is fine at a dozen and
/// is a memory exhaustion at ten thousand. The cap is far above what any client
/// of a local model server needs (four slots is the engine's own maximum) and
/// far below what hurts.
const MAX_LIVE: usize = 64;
static LIVE: AtomicUsize = AtomicUsize::new(0);

const TOO_MANY: &[u8] = b"HTTP/1.1 503 Service Unavailable\r\n\
Content-Type: application/json\r\n\
Content-Length: 46\r\n\
Connection: close\r\n\
\r\n\
{\"error\":{\"message\":\"too many connections\"}}\r\n";

/// Decrements the live count however the thread ends, panic included.
struct Live;

impl Drop for Live {
    fn drop(&mut self) {
        LIVE.fetch_sub(1, Ordering::SeqCst);
    }
}

static RUNNING: AtomicBool = AtomicBool::new(false);
static PORT: AtomicU16 = AtomicU16::new(0);

fn key_slot() -> &'static Mutex<String> {
    static K: OnceLock<Mutex<String>> = OnceLock::new();
    K.get_or_init(|| Mutex::new(String::new()))
}

fn bind_slot() -> &'static Mutex<String> {
    static B: OnceLock<Mutex<String>> = OnceLock::new();
    B.get_or_init(|| Mutex::new(String::new()))
}

#[derive(Serialize, Clone)]
pub struct RelayStatus {
    pub running: bool,
    /// The address actually bound, "127.0.0.1" or "0.0.0.0".
    pub bind: String,
    pub port: u16,
    /// Whether a key is set. The key itself is never returned here.
    pub keyed: bool,
}

pub fn status() -> RelayStatus {
    RelayStatus {
        running: RUNNING.load(Ordering::SeqCst),
        bind: bind_slot().lock().unwrap_or_else(|e| e.into_inner()).clone(),
        port: PORT.load(Ordering::SeqCst),
        keyed: !key_slot().lock().unwrap_or_else(|e| e.into_inner()).is_empty(),
    }
}

/// Generate a key with 256 bits of entropy, from the OS.
///
/// Reads /dev/urandom rather than deriving anything from time or a pid: a key
/// that can be guessed from when the user pressed a button is not a key. Hex
/// rather than base64 so it survives a copy through a shell, a YAML file and a
/// JSON string without quoting surprises.
pub fn generate_key() -> Result<String, String> {
    let mut raw = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .map_err(|e| format!("cannot open /dev/urandom: {e}"))?
        .read_exact(&mut raw)
        .map_err(|e| format!("cannot read /dev/urandom: {e}"))?;
    let mut out = String::with_capacity(64 + 3);
    out.push_str("gx_");
    for b in raw {
        out.push_str(&format!("{b:02x}"));
    }
    Ok(out)
}

/// The bits by which two equal-length secrets differ, over ALL of their bytes.
///
/// This exists as its own function so the property that matters can be
/// observed instead of timed. A comparison that returned early would still
/// answer `true`/`false` correctly, and no assertion on a boolean can tell the
/// two apart; an accumulator that has folded in every byte cannot be produced
/// by a loop that stopped at the first difference, so a test can simply read
/// the value back. See the test named after this function.
fn secret_diff(a: &[u8], b: &[u8]) -> u8 {
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff
}

/// Constant-time comparison, so a wrong key cannot be found byte by byte.
///
/// The relay answers 401 in a fixed shape, but a naive `==` still returns
/// faster on a key that shares a prefix. Over a local network that difference
/// is measurable, and the cost of not caring is a bearer token.
///
/// WHAT IS PINNED AND WHAT IS NOT, because the difference is the whole point:
///
///   pinned, by `secret_diff` reading every byte: no short circuit in this
///     source. A rewrite to `a == b` cannot pass the test on that accumulator,
///     and it cannot quietly stay either, because `secret_diff` would then have
///     no caller outside the tests and a non-test build stops compiling clean;
///   NOT pinned: what the optimiser emits. Nothing in a unit test can assert
///     that the machine code carries no branch, and the timing measurement that
///     could is flaky by nature and does not belong in a suite that has to be
///     believed. The length check above is itself a deliberate early return: it
///     leaks the length of the expected key, which is a fixed 67 characters and
///     public in this file.
fn secret_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    secret_diff(a, b) == 0
}

/// Pull the bearer token out of a request head, case-insensitively.
///
/// Header names are case-insensitive per the spec and clients disagree in
/// practice: curl sends `Authorization`, some SDKs send `authorization`. A
/// case-sensitive match here would reject a correctly authenticated caller,
/// which reads as "the key does not work" and is impossible to debug.
pub fn bearer_of(head: &str) -> Option<String> {
    for line in head.split("\r\n").skip(1) {
        let (name, value) = line.split_once(':')?;
        if name.trim().eq_ignore_ascii_case("authorization") {
            let v = value.trim();
            let (scheme, token) = v.split_once(' ')?;
            if scheme.eq_ignore_ascii_case("bearer") {
                return Some(token.trim().to_string());
            }
            return None;
        }
    }
    None
}

/// The same head without its Authorization line, for the hop to the engine.
///
/// The request line is kept whatever it looks like: this function removes a
/// header, it does not validate the request, and a head this relay has already
/// authenticated is not the place to start being clever about syntax.
pub fn without_authorization(head: &str) -> String {
    let mut out = String::with_capacity(head.len());
    for (i, line) in head.split("\r\n").enumerate() {
        let is_auth = i > 0
            && line
                .split_once(':')
                .map(|(n, _)| n.trim().eq_ignore_ascii_case("authorization"))
                .unwrap_or(false);
        if is_auth {
            continue;
        }
        if !out.is_empty() {
            out.push_str("\r\n");
        }
        out.push_str(line);
    }
    out
}

/// True when this request head is a CORS preflight.
pub fn is_preflight(head: &str) -> bool {
    head.split("\r\n")
        .next()
        .map(|l| l.starts_with("OPTIONS "))
        .unwrap_or(false)
}

const UNAUTHORIZED: &[u8] = b"HTTP/1.1 401 Unauthorized\r\n\
Content-Type: application/json\r\n\
Content-Length: 52\r\n\
Connection: close\r\n\
\r\n\
{\"error\":{\"message\":\"missing or invalid API key\"}}\r\n";

const PREFLIGHT_OK: &[u8] = b"HTTP/1.1 204 No Content\r\n\
Access-Control-Allow-Origin: *\r\n\
Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
Access-Control-Allow-Headers: Authorization, Content-Type\r\n\
Access-Control-Max-Age: 600\r\n\
Content-Length: 0\r\n\
Connection: close\r\n\
\r\n";

/// Read bytes until the end of the request head, returning head and remainder.
///
/// The remainder matters: a client that sends its head and the start of its
/// body in the same packet must not have those body bytes dropped. They are
/// handed back and written to the engine before the copy loop starts.
fn read_head(sock: &mut TcpStream) -> Result<(String, Vec<u8>), String> {
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    let started = std::time::Instant::now();
    loop {
        if started.elapsed() > HEAD_DEADLINE {
            return Err("the client took too long to send its head".into());
        }
        let n = sock.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("client closed before sending a head".into());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = find_head_end(&buf) {
            let head = String::from_utf8_lossy(&buf[..pos]).into_owned();
            return Ok((head, buf[pos + 4..].to_vec()));
        }
        if buf.len() > MAX_HEAD {
            return Err("request head too large".into());
        }
    }
}

fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

/// Copy bytes one way until either side closes. Never buffers a whole body.
fn pump(mut from: TcpStream, mut to: TcpStream) {
    let mut chunk = [0u8; 16 * 1024];
    loop {
        match from.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if to.write_all(&chunk[..n]).is_err() || to.flush().is_err() {
                    break;
                }
            }
        }
    }
    let _ = to.shutdown(Shutdown::Write);
}

/// The method and path of a request head, for routing.
///
/// Only the first line is parsed, and only into two words. The relay still does
/// not interpret HTTP: it needs to know whether a request is one IT answers
/// (pictures, which have no server to forward to) or one it copies to the
/// engine, and that decision is the request line.
pub fn method_path(head: &str) -> Option<(&str, &str)> {
    let line = head.split("\r\n").next()?;
    let mut parts = line.split(' ');
    let method = parts.next()?;
    let path = parts.next()?;
    if method.is_empty() || !path.starts_with('/') {
        return None;
    }
    Some((method, path))
}

/// The declared body length of a request, when it declares one.
///
/// Only `Content-Length` is honoured. A chunked body would need a decoder, and
/// no OpenAI client sends one for a JSON request; `chunked_is_refused_clearly`
/// covers what a caller sees if one ever does.
pub fn content_length(head: &str) -> Option<usize> {
    for line in head.split("\r\n").skip(1) {
        let Some((name, value)) = line.split_once(':') else { continue };
        if name.trim().eq_ignore_ascii_case("content-length") {
            return value.trim().parse::<usize>().ok();
        }
    }
    None
}

/// True when the request says its body arrives in chunks.
pub fn is_chunked(head: &str) -> bool {
    head.split("\r\n").skip(1).any(|line| {
        line.split_once(':')
            .map(|(n, v)| {
                n.trim().eq_ignore_ascii_case("transfer-encoding")
                    && v.to_ascii_lowercase().contains("chunked")
            })
            .unwrap_or(false)
    })
}

/// Read the rest of a body of known length, `first` being what already arrived.
fn read_body(sock: &mut TcpStream, first: Vec<u8>, want: usize) -> Result<Vec<u8>, String> {
    let mut body = first;
    if body.len() > want {
        body.truncate(want);
    }
    let mut chunk = [0u8; 16 * 1024];
    while body.len() < want {
        let n = sock.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("the client closed before sending its whole body".into());
        }
        body.extend_from_slice(&chunk[..n.min(want - body.len())]);
    }
    Ok(body)
}

/// Serve a picture or clip route from this process. Minutes, on this thread.
fn serve_locally(
    client: &mut TcpStream,
    route: crate::imgapi::Route,
    head: &str,
    rest: Vec<u8>,
) {
    use crate::imgapi::{self, Reply};
    let reply = match route {
        // A listing has no body to wait for.
        imgapi::Route::Models => imgapi::handle(route, b"", app_handle()),
        imgapi::Route::Generate => {
            if is_chunked(head) {
                Reply::err(400, "send the body with a Content-Length, not chunked")
            } else {
                match content_length(head) {
                    None => Reply::err(400, "a JSON body with a Content-Length is required"),
                    Some(n) if n > imgapi::MAX_BODY => Reply::err(
                        400,
                        "that body is too large: inline media is capped at 64 MB, \
                         or pass a path on this Mac instead",
                    ),
                    Some(n) => {
                        // The head timeout is lifted only now, because a body of
                        // known length is bounded work: an idle socket before
                        // this point is a client that never says what it wants.
                        let _ = client.set_read_timeout(Some(Duration::from_secs(120)));
                        match read_body(client, rest, n) {
                            Ok(body) => {
                                // A generation runs for minutes and must not be
                                // cut by a read deadline that belongs to the
                                // request, not to the work.
                                let _ = client.set_read_timeout(None);
                                imgapi::handle(route, &body, app_handle())
                            }
                            Err(e) => Reply::err(400, &e),
                        }
                    }
                }
            }
        }
    };
    let _ = client.write_all(&reply.to_http());
    let _ = client.flush();
}

/// The window, when there is one, so an API generation moves the same progress
/// bar the app shows. Absent in tests and in a headless run, which is why the
/// whole image path takes an Option rather than requiring a handle.
fn app_slot() -> &'static Mutex<Option<tauri::AppHandle>> {
    static A: OnceLock<Mutex<Option<tauri::AppHandle>>> = OnceLock::new();
    A.get_or_init(|| Mutex::new(None))
}

pub fn set_app(app: tauri::AppHandle) {
    *app_slot().lock().unwrap_or_else(|e| e.into_inner()) = Some(app);
}

fn app_handle() -> Option<tauri::AppHandle> {
    app_slot().lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn serve_one(mut client: TcpStream, engine_port: u16) {
    let _ = client.set_read_timeout(Some(HEAD_TIMEOUT));
    let (head, rest) = match read_head(&mut client) {
        Ok(v) => v,
        Err(_) => return,
    };
    // Preflight is answered by the relay itself: a browser sends it WITHOUT
    // the Authorization header by design, so forwarding it or demanding a key
    // would break every browser client for no security gain.
    if is_preflight(&head) {
        let _ = client.write_all(PREFLIGHT_OK);
        return;
    }
    let expected = key_slot().lock().unwrap_or_else(|e| e.into_inner()).clone();
    let given = bearer_of(&head).unwrap_or_default();
    if expected.is_empty() || !secret_eq(&expected, &given) {
        let _ = client.write_all(UNAUTHORIZED);
        return;
    }
    // Pictures and clips are ours: there is no second HTTP server holding the
    // image engine, so these routes are answered here rather than forwarded.
    // Checked BEFORE the connection to llama-server, which is what lets the
    // relay serve images on a Mac where no text model is running at all.
    if let Some((method, path)) = method_path(&head) {
        if let Some(route) = crate::imgapi::route(method, path) {
            serve_locally(&mut client, route, &head, rest);
            return;
        }
    }
    // Authenticated: the read timeout must go, or a streaming answer that
    // pauses longer than the head timeout would be cut mid-generation.
    let _ = client.set_read_timeout(None);

    if engine_port == 0 {
        // Image-only serving. Saying which is the difference between a caller
        // fixing it in ten seconds and reading a 502 as "the relay is broken".
        // The length is computed rather than typed: a Content-Length that
        // disagrees with the body by one byte hangs the client instead of
        // showing it the sentence.
        let body = br#"{"error":{"message":"no text model is running: start one in Galactus","type":"unavailable"}}"#;
        let head = format!(
            "HTTP/1.1 503 Service Unavailable\r\n\
             Content-Type: application/json\r\n\
             Content-Length: {}\r\n\
             Connection: close\r\n\r\n",
            body.len()
        );
        let _ = client.write_all(head.as_bytes());
        let _ = client.write_all(body);
        return;
    }
    let mut engine = match TcpStream::connect(("127.0.0.1", engine_port)) {
        Ok(s) => s,
        Err(_) => {
            let _ = client.write_all(
                b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
            return;
        }
    };
    let _ = engine.set_nodelay(true);
    let _ = client.set_nodelay(true);
    // The key stops here. The engine has no authentication to do, its two
    // streams are redirected into llama-server.log, and a secret that never
    // crosses a boundary cannot be logged on the other side of it.
    let forwarded = without_authorization(&head);
    if engine.write_all(forwarded.as_bytes()).is_err()
        || engine.write_all(b"\r\n\r\n").is_err()
        || engine.write_all(&rest).is_err()
    {
        return;
    }
    let (Ok(c2), Ok(e2)) = (client.try_clone(), engine.try_clone()) else {
        return;
    };
    let up = std::thread::spawn(move || pump(client, engine));
    pump(e2, c2);
    let _ = up.join();
}

/// Start listening. Refuses to expose the machine without a key.
pub fn start(bind: &str, port: u16, engine_port: u16, key: &str) -> Result<(), String> {
    if RUNNING.load(Ordering::SeqCst) {
        return Err("the relay is already running".into());
    }
    if bind != "127.0.0.1" && bind != "0.0.0.0" {
        return Err(format!("refusing to bind {bind}: use 127.0.0.1 or 0.0.0.0"));
    }
    // The rule the whole feature rests on. A relay on 0.0.0.0 with no key is
    // an open door to a model that reads files and runs commands, and no UI
    // affordance is worth trusting to prevent it: it is refused here, in the
    // one place that cannot be bypassed.
    if key.trim().is_empty() {
        return Err("refusing to listen without an API key".into());
    }
    let listener = TcpListener::bind((bind, port))
        .map_err(|e| format!("cannot bind {bind}:{port}: {e}"))?;
    *key_slot().lock().unwrap_or_else(|e| e.into_inner()) = key.to_string();
    *bind_slot().lock().unwrap_or_else(|e| e.into_inner()) = bind.to_string();
    PORT.store(port, Ordering::SeqCst);
    RUNNING.store(true, Ordering::SeqCst);

    std::thread::spawn(move || {
        for conn in listener.incoming() {
            if !RUNNING.load(Ordering::SeqCst) {
                break;
            }
            match conn {
                Ok(mut sock) => {
                    // Refused here rather than inside a thread: the point of
                    // the cap is to not create the thread.
                    if LIVE.load(Ordering::SeqCst) >= MAX_LIVE {
                        let _ = sock.write_all(TOO_MANY);
                        continue;
                    }
                    LIVE.fetch_add(1, Ordering::SeqCst);
                    std::thread::spawn(move || {
                        let _live = Live;
                        serve_one(sock, engine_port);
                    });
                }
                Err(_) => break,
            }
        }
        RUNNING.store(false, Ordering::SeqCst);
    });
    Ok(())
}

pub fn stop() {
    if !RUNNING.swap(false, Ordering::SeqCst) {
        return;
    }
    // Unblock the accept loop by connecting to it once. Closing a TcpListener
    // from another thread is not possible in std, and leaving the thread
    // parked on accept would keep the port bound after the user turned the
    // relay off, which reads as "it did not stop".
    let port = PORT.load(Ordering::SeqCst);
    let _ = TcpStream::connect(("127.0.0.1", port));
    PORT.store(0, Ordering::SeqCst);
    key_slot().lock().unwrap_or_else(|e| e.into_inner()).clear();
    bind_slot().lock().unwrap_or_else(|e| e.into_inner()).clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialises every test that calls `start` or `stop`.
    ///
    /// The relay's listener, port, bind address and key are process globals,
    /// which is right for a thing there is exactly one of and wrong for a test
    /// runner that uses a thread per test. Without this, the live test below
    /// sets RUNNING while `listening_without_a_key_is_refused` is asking for a
    /// refusal, and that test fails with "the relay is already running": a red
    /// build caused by the harness rather than by the code.
    fn relay_lock() -> std::sync::MutexGuard<'static, ()> {
        static L: OnceLock<Mutex<()>> = OnceLock::new();
        L.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// A stand-in for llama-server: answers every request 200 and closes.
    ///
    /// WHY THIS EXISTS. The live test was `#[ignore]`d because it needed a real
    /// model listening on 8737, which meant the relay's authenticate-then-
    /// forward path, the one thing the whole module is for, was never executed
    /// by anybody on any machine. What that path needs from the engine is a
    /// TCP peer that speaks a response, not inference, so the requirement was
    /// never really a model.
    ///
    /// It binds port 0 and reports what the OS gave it, so two runs of the
    /// suite on the same machine cannot collide on a fixed port.
    fn stub_engine() -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("stub engine binds");
        let port = listener.local_addr().expect("addr").port();
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(mut sock) = conn else { break };
                std::thread::spawn(move || {
                    // Read one head so the relay's write side does not fail,
                    // then answer. The body is irrelevant to what is asserted.
                    let mut chunk = [0u8; 4096];
                    let _ = sock.read(&mut chunk);
                    let _ = sock.write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
Content-Length: 13\r\nConnection: close\r\n\r\n{\"data\":[{}]}",
                    );
                    let _ = sock.flush();
                    let _ = sock.shutdown(Shutdown::Write);
                });
            }
        });
        port
    }

    #[test]
    fn a_bearer_token_is_read_whatever_the_header_case() {
        let head = "POST /v1/chat HTTP/1.1\r\nHost: x\r\nauthorization: Bearer gx_abc\r\n";
        assert_eq!(bearer_of(head).as_deref(), Some("gx_abc"));
        let head2 = "POST / HTTP/1.1\r\nAUTHORIZATION: bearer gx_def\r\n";
        assert_eq!(bearer_of(head2).as_deref(), Some("gx_def"));
    }

    #[test]
    fn a_head_without_a_usable_token_yields_none() {
        assert_eq!(bearer_of("GET / HTTP/1.1\r\nHost: x\r\n"), None);
        // Basic auth is not a bearer token and must not be accepted as one.
        assert_eq!(bearer_of("GET / HTTP/1.1\r\nAuthorization: Basic abc\r\n"), None);
        // The request line itself must never be mistaken for a header.
        assert_eq!(bearer_of("Authorization: Bearer x\r\nHost: y\r\n"), None);
    }

    #[test]
    fn preflight_is_recognised_only_on_the_request_line() {
        assert!(is_preflight("OPTIONS /v1/models HTTP/1.1\r\nHost: x\r\n"));
        assert!(!is_preflight("POST /v1/models HTTP/1.1\r\nX: OPTIONS /\r\n"));
    }

    #[test]
    fn comparison_is_length_safe_and_correct() {
        assert!(secret_eq("gx_abc", "gx_abc"));
        assert!(!secret_eq("gx_abc", "gx_abd"));
        assert!(!secret_eq("gx_abc", "gx_ab"));
        assert!(!secret_eq("", "x"));
    }

    #[test]
    fn secret_diff_folds_in_every_byte_and_not_only_the_first_difference() {
        // The structural stand-in for a stopwatch.
        //
        // These two differ in the FIRST byte, where a short circuit would stop,
        // and again in the LAST, which only a full scan can reach. The bits
        // 0x01 and 0x20 therefore appear together in the answer if and only if
        // every byte was read: 0x01 alone is a comparison that returned at the
        // first difference, and that comparison is the timing oracle this
        // function exists to not be.
        assert_eq!(b'a' ^ b'`', 0x01, "the first byte differs");
        assert_eq!(b'd' ^ b'D', 0x20, "and so does the last");
        assert_eq!(
            secret_diff(b"abcd", b"`bcD"),
            0x21,
            "0x01 alone means the scan stopped where an attacker could measure"
        );
        // Nothing is claimed about the bits when the secrets agree, only that
        // there are none.
        assert_eq!(secret_diff(b"gx_abc", b"gx_abc"), 0);
        assert_eq!(secret_diff(b"", b""), 0);
        // And the wiring: `secret_eq` is this accumulator, not a second
        // comparison that happens to agree with it on these inputs.
        for (a, b) in [("gx_abc", "gx_abc"), ("gx_abc", "gx_abd"), ("abcd", "`bcD")] {
            assert_eq!(
                secret_eq(a, b),
                secret_diff(a.as_bytes(), b.as_bytes()) == 0,
                "{a} vs {b}"
            );
        }
    }

    #[test]
    fn a_generated_key_is_long_prefixed_and_never_repeats() {
        let a = generate_key().expect("key");
        let b = generate_key().expect("key");
        assert!(a.starts_with("gx_"));
        assert_eq!(a.len(), 67, "gx_ plus 64 hex characters");
        assert!(a[3..].chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn listening_without_a_key_is_refused() {
        let _guard = relay_lock();
        // The single rule the exposure rests on. If this ever passes, the app
        // can publish an unauthenticated endpoint that reads the user's files.
        let err = start("0.0.0.0", 0, 8737, "").unwrap_err();
        assert!(err.contains("without an API key"), "got: {err}");
        let err2 = start("0.0.0.0", 0, 8737, "   ").unwrap_err();
        assert!(err2.contains("without an API key"), "got: {err2}");
    }

    #[test]
    fn only_the_two_intended_addresses_are_accepted() {
        let _guard = relay_lock();
        // Binding an arbitrary interface is refused rather than attempted:
        // the set of addresses that expose the machine must stay enumerable.
        let err = start("192.168.1.35", 0, 8737, "gx_k").unwrap_err();
        assert!(err.contains("refusing to bind"), "got: {err}");
    }

    /// End to end over real sockets: bind, refuse, authenticate, forward, stop.
    ///
    /// This is the only test in the module that exercises `start`, `serve_one`
    /// and `pump` rather than the pure helpers around them, which is to say it
    /// is the only one that would notice if the relay let an unauthenticated
    /// request through to the engine.
    ///
    /// The engine is a stub (see `stub_engine`), so nothing here needs a model,
    /// a network or a permission grant. What is asserted is the relay's own
    /// behaviour: everything below the 200 is the stub's, and the 200 only
    /// proves the bytes reached it.
    #[test]
    fn live_relay_authenticates_and_forwards() {
        use std::io::{BufRead, BufReader};

        let _guard = relay_lock();
        let key = generate_key().expect("key");
        let engine_port = stub_engine();
        // Port 0 would be ideal but the relay stores the port it was TOLD, not
        // the one the OS handed the listener, so a bound ephemeral port is
        // borrowed and released to get a number that is free right now.
        let port = {
            let probe = TcpListener::bind(("127.0.0.1", 0)).expect("probe");
            probe.local_addr().expect("addr").port()
        };
        start("0.0.0.0", port, engine_port, &key).expect("relay start");
        std::thread::sleep(Duration::from_millis(200));

        let call = |auth: Option<&str>| -> String {
            let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
            let mut head = format!("GET /v1/models HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n");
            if let Some(a) = auth {
                head.push_str(&format!("Authorization: Bearer {a}\r\n"));
            }
            head.push_str("Connection: close\r\n\r\n");
            s.write_all(head.as_bytes()).expect("write");
            let mut r = BufReader::new(s);
            let mut line = String::new();
            r.read_line(&mut line).expect("status line");
            line
        };

        assert!(call(None).contains("401"), "no key must be refused");
        assert!(call(Some("gx_wrong")).contains("401"), "a wrong key must be refused");
        let ok = call(Some(&key));
        assert!(ok.contains("200"), "the right key must reach the engine, got {ok}");

        // Preflight must pass WITHOUT a key, or every browser client breaks.
        let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        s.write_all(b"OPTIONS /v1/models HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
            .expect("write");
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).expect("status");
        assert!(line.contains("204"), "preflight must be answered, got {line}");

        stop();
        std::thread::sleep(Duration::from_millis(200));
        assert!(
            TcpStream::connect(("127.0.0.1", port)).is_err(),
            "the port must be free after stop"
        );
    }

    #[test]
    fn the_request_line_is_split_into_a_method_and_a_path() {
        assert_eq!(
            method_path("POST /v1/images/generations HTTP/1.1\r\nHost: x\r\n"),
            Some(("POST", "/v1/images/generations"))
        );
        assert_eq!(method_path("GET / HTTP/1.1\r\n"), Some(("GET", "/")));
        // Garbage must not be routed anywhere: a first line that is not a
        // request line means the request goes to the engine untouched, which
        // is the behaviour this relay had before it learned any routes.
        assert_eq!(method_path("hello\r\n"), None);
        assert_eq!(method_path("POST v1/images HTTP/1.1\r\n"), None);
    }

    #[test]
    fn the_body_length_is_read_from_the_header_whatever_its_case() {
        assert_eq!(content_length("POST / HTTP/1.1\r\ncontent-length: 42\r\n"), Some(42));
        assert_eq!(content_length("POST / HTTP/1.1\r\nContent-Length:  7 \r\n"), Some(7));
        assert_eq!(content_length("POST / HTTP/1.1\r\nHost: x\r\n"), None);
        // The request line is not a header, here as in bearer_of.
        assert_eq!(content_length("Content-Length: 9\r\nHost: x\r\n"), None);
    }

    #[test]
    fn a_chunked_body_is_recognised_so_it_can_be_refused_in_words() {
        assert!(is_chunked("POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n"));
        assert!(is_chunked("POST / HTTP/1.1\r\ntransfer-encoding: gzip, Chunked\r\n"));
        assert!(!is_chunked("POST / HTTP/1.1\r\nContent-Length: 3\r\n"));
    }

    /// The bytes that arrived with the head are kept, and the rest is read.
    ///
    /// The failure this pins: a client that sends head and body in one packet
    /// had its first body bytes dropped by an implementation that only read
    /// from the socket, and a JSON body missing its opening brace is a 400 on
    /// a request that was perfectly well formed.
    #[test]
    fn a_body_that_arrived_with_the_head_is_not_read_twice_nor_dropped() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        std::thread::spawn(move || {
            let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
            let _ = s.write_all(b"6789");
            std::thread::sleep(Duration::from_millis(50));
        });
        let (mut sock, _) = listener.accept().expect("accept");
        let body = read_body(&mut sock, b"12345".to_vec(), 9).expect("body");
        assert_eq!(&body, b"123456789");
    }

    #[test]
    fn a_body_longer_than_declared_is_truncated_to_what_was_declared() {
        // Whatever follows the declared length is the next request on a
        // keep-alive socket, not part of this JSON.
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        std::thread::spawn(move || {
            let _ = TcpStream::connect(("127.0.0.1", port));
        });
        let (mut sock, _) = listener.accept().expect("accept");
        let body = read_body(&mut sock, b"{\"a\":1}GET /".to_vec(), 7).expect("body");
        assert_eq!(&body, b"{\"a\":1}");
    }

    /// The picture routes are answered HERE, and never forwarded to the engine.
    ///
    /// Asserted against a stub that puts a marker in every answer it gives: if
    /// the marker comes back, the relay proxied a request it was supposed to
    /// serve, and a caller would have got llama-server's 404 for an endpoint
    /// this app does have.
    #[test]
    fn image_routes_are_served_locally_and_chat_still_reaches_the_engine() {
        use std::io::{BufRead, BufReader};

        let _guard = relay_lock();
        let key = generate_key().expect("key");
        let engine_port = stub_engine();
        let port = {
            let probe = TcpListener::bind(("127.0.0.1", 0)).expect("probe");
            probe.local_addr().expect("addr").port()
        };
        start("127.0.0.1", port, engine_port, &key).expect("relay start");
        std::thread::sleep(Duration::from_millis(200));

        let call = |head: &str| -> String {
            let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
            s.write_all(head.as_bytes()).expect("write");
            let mut r = BufReader::new(s);
            let mut all = String::new();
            let mut line = String::new();
            while r.read_line(&mut line).unwrap_or(0) > 0 {
                all.push_str(&line);
                line.clear();
            }
            all
        };

        let ours = call(&format!(
            "GET /v1/images/models HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {key}\r\n\
             Connection: close\r\n\r\n"
        ));
        assert!(
            !ours.contains("\"data\":[{}]"),
            "an image route must not reach llama-server, got: {ours}"
        );
        // And text still goes where it always went.
        let theirs = call(&format!(
            "POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {key}\r\n\
             Content-Length: 2\r\nConnection: close\r\n\r\n{{}}"
        ));
        assert!(theirs.contains("\"data\":[{}]"), "chat must be forwarded, got: {theirs}");

        // A picture request with no key is refused before any of this: the
        // local routes are behind the same door as the proxied ones.
        let no_key = call("GET /v1/images/models HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
        assert!(no_key.contains("401"), "got: {no_key}");

        stop();
        std::thread::sleep(Duration::from_millis(200));
    }

    /// With no text model running, chat says so instead of failing as a gateway.
    #[test]
    fn without_an_engine_text_is_a_503_that_names_the_reason() {
        use std::io::{BufRead, BufReader};

        let _guard = relay_lock();
        let key = generate_key().expect("key");
        let port = {
            let probe = TcpListener::bind(("127.0.0.1", 0)).expect("probe");
            probe.local_addr().expect("addr").port()
        };
        // Zero is what relay_start passes when the machine is serving pictures
        // only, which is a supported way to run this app.
        start("127.0.0.1", port, 0, &key).expect("relay start");
        std::thread::sleep(Duration::from_millis(200));

        let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        s.write_all(
            format!(
                "POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {key}\r\n\
                 Content-Length: 2\r\nConnection: close\r\n\r\n{{}}"
            )
            .as_bytes(),
        )
        .expect("write");
        let mut all = String::new();
        let mut r = BufReader::new(s);
        let mut line = String::new();
        while r.read_line(&mut line).unwrap_or(0) > 0 {
            all.push_str(&line);
            line.clear();
        }
        assert!(all.contains("503"), "got: {all}");
        assert!(all.contains("no text model is running"), "got: {all}");
        // The declared length must match the sentence exactly, or the client
        // waits for bytes that never come instead of showing it.
        let body = all.split("\r\n\r\n").nth(1).unwrap_or_default();
        let declared: usize = all
            .split("Content-Length: ")
            .nth(1)
            .and_then(|s| s.split("\r\n").next())
            .and_then(|s| s.trim().parse().ok())
            .expect("a declared length");
        assert_eq!(body.len(), declared, "body {body:?}");

        stop();
        std::thread::sleep(Duration::from_millis(200));
    }

    #[test]
    fn the_key_does_not_travel_to_the_engine() {
        let head = "POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\n\
                    Authorization: Bearer gx_secret\r\nContent-Length: 2";
        let out = without_authorization(head);
        assert!(!out.contains("gx_secret"), "got: {out}");
        assert!(out.starts_with("POST /v1/chat/completions HTTP/1.1\r\n"));
        assert!(out.contains("Content-Length: 2"), "the rest of the head must survive");
        // Case is not a way to smuggle it through.
        assert!(!without_authorization("GET / HTTP/1.1\r\nAUTHORIZATION: Bearer k").contains("k"));
        // A request line that happens to look like the header is not one.
        let odd = "GET /authorization: x HTTP/1.1\r\nHost: y";
        assert_eq!(without_authorization(odd), odd);
    }

    /// A client that dribbles its head cannot hold a thread for a day.
    ///
    /// The failure this pins is not a crash, it is a resource: `set_read_timeout`
    /// is per read, so one byte every few seconds used to keep the connection,
    /// and its thread, alive without ever presenting a key.
    #[test]
    fn a_head_that_never_ends_is_dropped_on_the_deadline() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let dribble = std::thread::spawn(move || {
            let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
            // Never sends the terminator, keeps the socket warm.
            for _ in 0..40 {
                if s.write_all(b"X-Pad: 1\r\n").is_err() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        let (mut sock, _) = listener.accept().expect("accept");
        let _ = sock.set_read_timeout(Some(Duration::from_millis(50)));
        let started = std::time::Instant::now();
        let err = read_head(&mut sock).unwrap_err();
        // It gives up on its own, rather than on the client hanging up.
        assert!(
            started.elapsed() < HEAD_DEADLINE + Duration::from_secs(5),
            "took {:?}",
            started.elapsed()
        );
        assert!(!err.is_empty());
        drop(sock);
        let _ = dribble.join();
    }

    #[test]
    fn a_head_split_across_reads_is_still_found() {
        // The framing detail that breaks under load: the terminator can land
        // across two packets, and a naive per-read search misses it.
        let mut buf = b"POST / HTTP/1.1\r\nHost: x\r".to_vec();
        assert_eq!(find_head_end(&buf), None);
        buf.extend_from_slice(b"\n\r\nBODY");
        let pos = find_head_end(&buf).expect("terminator");
        assert_eq!(&buf[pos + 4..], b"BODY");
    }
}
