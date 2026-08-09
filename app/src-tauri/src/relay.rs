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
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;

/// Largest request head accepted, headers included.
///
/// A head is a few hundred bytes in practice. The cap exists so a client that
/// opens a socket and streams headers forever cannot grow this buffer without
/// bound; the body is never held in memory at all, it is streamed through.
const MAX_HEAD: usize = 32 * 1024;
/// How long a client may take to send its head before the relay gives up.
const HEAD_TIMEOUT: Duration = Duration::from_secs(15);

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

/// Constant-time comparison, so a wrong key cannot be found byte by byte.
///
/// The relay answers 401 in a fixed shape, but a naive `==` still returns
/// faster on a key that shares a prefix. Over a local network that difference
/// is measurable, and the cost of not caring is a bearer token.
fn secret_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
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

/// True when this request head is a CORS preflight.
pub fn is_preflight(head: &str) -> bool {
    head.split("\r\n")
        .next()
        .map(|l| l.starts_with("OPTIONS "))
        .unwrap_or(false)
}

const UNAUTHORIZED: &[u8] = b"HTTP/1.1 401 Unauthorized\r\n\
Content-Type: application/json\r\n\
Content-Length: 58\r\n\
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
    loop {
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
    // Authenticated: the read timeout must go, or a streaming answer that
    // pauses longer than the head timeout would be cut mid-generation.
    let _ = client.set_read_timeout(None);

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
    if engine.write_all(head.as_bytes()).is_err()
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
                Ok(sock) => {
                    std::thread::spawn(move || serve_one(sock, engine_port));
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
        // The single rule the exposure rests on. If this ever passes, the app
        // can publish an unauthenticated endpoint that reads the user's files.
        let err = start("0.0.0.0", 0, 8737, "").unwrap_err();
        assert!(err.contains("without an API key"), "got: {err}");
        let err2 = start("0.0.0.0", 0, 8737, "   ").unwrap_err();
        assert!(err2.contains("without an API key"), "got: {err2}");
    }

    #[test]
    fn only_the_two_intended_addresses_are_accepted() {
        // Binding an arbitrary interface is refused rather than attempted:
        // the set of addresses that expose the machine must stay enumerable.
        let err = start("192.168.1.35", 0, 8737, "gx_k").unwrap_err();
        assert!(err.contains("refusing to bind"), "got: {err}");
    }

    /// End to end against a REAL engine. Ignored by default because it needs
    /// a model running on 8737; run it explicitly:
    ///   cargo test --lib -- --ignored relay::tests::live
    #[test]
    #[ignore]
    fn live_relay_authenticates_and_forwards() {
        use std::io::{BufRead, BufReader};

        let key = generate_key().expect("key");
        // Port 0 would be ideal but the relay stores the port it was told, so
        // a fixed high port keeps the assertion simple.
        let port = 8791u16;
        start("0.0.0.0", port, 8737, &key).expect("relay start");
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
        s.write_all(
            format!("OPTIONS /v1/models HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").as_bytes(),
        )
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
