//! Defensive security audit: looking at your own machines, never attacking them.
//!
//! WHAT THIS IS. Two read-only checks the owner runs against assets they
//! control: a TCP-connect port scan that says what is listening, and an HTTP
//! audit that reports the security headers, TLS and cookie flags a site does or
//! does not set. The point is to find the door left open before someone else
//! does, on your own house.
//!
//! WHAT IT DELIBERATELY IS NOT. It does not exploit, brute-force, fuzz, or send
//! a single crafted payload. The port scan is an ordinary TcpStream::connect,
//! the same thing a browser does, and it reads only what a service volunteers
//! on connect (an SSH or SMTP banner), never writing to it. The web audit is
//! one GET whose body is thrown away, plus a TLS handshake read for its
//! certificate. Nothing here changes state on the far side, and nothing here is
//! a technique a defender would not run against their own surface.
//!
//! WHY IT MAY REACH LOOPBACK AND THE LAN, unlike tool_web_fetch. The web fetch
//! the model uses refuses private and loopback addresses on purpose: it follows
//! links from pages the model read, and an SSRF there would reach the metadata
//! service or an internal admin panel. This is the opposite situation. The
//! whole job is to audit the app running on 127.0.0.1 and the box on the LAN,
//! so a filter that blocked those would block the only targets that matter. The
//! safety here is the owner naming the target, not a network-range rule.

use serde::Serialize;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// How long a single connect is given before it counts as closed/filtered.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(800);
/// How long to wait for a service that speaks first (SSH, SMTP, FTP banners).
const BANNER_TIMEOUT: Duration = Duration::from_millis(400);
/// Most a banner read keeps, so one chatty service cannot flood the report.
const BANNER_MAX: usize = 256;
/// Connections in flight at once. Bounded so a wide scan does not open a
/// thousand sockets and get the host throttled or the app rate-limited.
const MAX_INFLIGHT: usize = 64;
/// Most ports one call may probe. A scan is an inventory of a known host, not a
/// sweep, and a cap keeps a typo (0..=65535) from becoming a minute of work.
const MAX_PORTS: usize = 1024;

#[derive(Serialize, Clone)]
pub struct PortResult {
    pub port: u16,
    pub open: bool,
    /// The well-known service for this port, when there is one.
    pub service: Option<String>,
    /// What the service said on connect, cleaned and truncated. None when it
    /// stayed silent (which HTTP does) or the port was closed.
    pub banner: Option<String>,
}

/// One observation about a web endpoint, with how much it matters.
#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct Finding {
    /// "ok" | "warn" | "risk". A string, because it crosses to TypeScript and
    /// the frontend colours on it.
    pub level: String,
    /// What was checked, short enough for a row: "Content-Security-Policy".
    pub title: String,
    /// What it means for this site, in one sentence.
    pub detail: String,
}

#[derive(Serialize, Clone)]
pub struct WebAudit {
    pub url: String,
    /// The HTTP status line's code, for context.
    pub status: Option<u16>,
    pub findings: Vec<Finding>,
}

// ----------------------------------------------------------------- ports

/// The service usually found on a port. A small, deliberately common table:
/// the point is to label the everyday ones on sight, not to be a registry.
pub fn service_for_port(port: u16) -> Option<&'static str> {
    Some(match port {
        21 => "ftp",
        22 => "ssh",
        23 => "telnet",
        25 => "smtp",
        53 => "dns",
        80 => "http",
        110 => "pop3",
        143 => "imap",
        443 => "https",
        445 => "smb",
        587 => "smtp-submission",
        3000 => "node-dev",
        3306 => "mysql",
        3389 => "rdp",
        5432 => "postgres",
        5900 => "vnc",
        6379 => "redis",
        8080 => "http-alt",
        8443 => "https-alt",
        9000 => "http-admin",
        11211 => "memcached",
        27017 => "mongodb",
        _ => return None,
    })
}

/// Whether a host string is one worth handing to a resolver.
///
/// Strict for the same reason ssh.rs is strict about its target: a value with a
/// shell metacharacter or whitespace in it is not a hostname, it is a mistake
/// or an injection, and it has no business reaching a Command later. An IP or a
/// dotted name is what a host looks like.
pub fn is_plausible_host(host: &str) -> bool {
    let h = host.trim();
    if h.is_empty() || h.len() > 255 || h.starts_with('-') {
        return false;
    }
    !h.chars()
        .any(|c| c.is_whitespace() || "\"'`$;|&<>()[]{}\\*?!#/@".contains(c))
}

/// Clean a banner: printable, single line, bounded. A service can return
/// anything, including control bytes that would wreck the display or, worse,
/// terminal escapes; only readable text survives.
fn clean_banner(raw: &[u8]) -> Option<String> {
    let text: String = raw
        .iter()
        .take(BANNER_MAX)
        .map(|&b| b as char)
        .map(|c| if c.is_ascii_graphic() || c == ' ' { c } else { ' ' })
        .collect();
    let trimmed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// Connect to one port and, if it opens, read whatever the service volunteers.
///
/// Nothing is ever written to the socket. Some services (SSH, SMTP, FTP) greet
/// on connect and that greeting is read; the ones that wait for the client
/// (HTTP) simply time out on the read and report no banner, which is correct.
fn probe_port(host: &str, port: u16) -> PortResult {
    let mut result = PortResult {
        port,
        open: false,
        service: service_for_port(port).map(str::to_string),
        banner: None,
    };
    // Resolve per attempt: cheap next to the connect, and it keeps this
    // function total (no shared resolved-address state to thread through).
    let Ok(mut addrs) = (host, port).to_socket_addrs() else {
        return result;
    };
    let Some(addr) = addrs.next() else {
        return result;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) else {
        return result;
    };
    result.open = true;
    let _ = stream.set_read_timeout(Some(BANNER_TIMEOUT));
    let mut buf = [0u8; BANNER_MAX];
    if let Ok(n) = stream.read(&mut buf) {
        if n > 0 {
            result.banner = clean_banner(&buf[..n]);
        }
    }
    // Be a good citizen: close the write half at once, we sent nothing anyway.
    let _ = stream.flush();
    result
}

/// Scan a host's ports, TCP-connect only, bounded concurrency.
#[tauri::command]
pub async fn sec_scan_ports(host: String, ports: Vec<u16>) -> Result<Vec<PortResult>, String> {
    if !is_plausible_host(&host) {
        return Err("that host does not look like a machine name or address".into());
    }
    if ports.is_empty() {
        return Err("no ports to scan".into());
    }
    if ports.len() > MAX_PORTS {
        return Err(format!("too many ports at once (max {MAX_PORTS})"));
    }
    tauri::async_runtime::spawn_blocking(move || Ok(scan_blocking(&host, ports)))
        .await
        .map_err(|e| format!("the scan thread died: {e}"))?
}

/// The scan itself, off the async runtime. A shared cursor over the port list
/// feeds a fixed set of workers, so at most MAX_INFLIGHT sockets exist at once
/// however long the list is.
fn scan_blocking(host: &str, ports: Vec<u16>) -> Vec<PortResult> {
    let n = ports.len();
    let ports = Arc::new(ports);
    let cursor = Arc::new(AtomicUsize::new(0));
    let out: Arc<Mutex<Vec<PortResult>>> = Arc::new(Mutex::new(Vec::with_capacity(n)));
    let worker_count = MAX_INFLIGHT.min(n);

    std::thread::scope(|scope| {
        for _ in 0..worker_count {
            let ports = Arc::clone(&ports);
            let cursor = Arc::clone(&cursor);
            let out = Arc::clone(&out);
            let host = host.to_string();
            scope.spawn(move || loop {
                let i = cursor.fetch_add(1, Ordering::Relaxed);
                if i >= ports.len() {
                    break;
                }
                let r = probe_port(&host, ports[i]);
                // Only the open ones are worth a row; a closed port is the
                // normal case and would drown the result.
                if r.open {
                    out.lock().unwrap_or_else(|e| e.into_inner()).push(r);
                }
            });
        }
    });

    let mut v = Arc::try_unwrap(out)
        .map(|m| m.into_inner().unwrap_or_else(|e| e.into_inner()))
        .unwrap_or_default();
    v.sort_by_key(|r| r.port);
    v
}

// ------------------------------------------------------------------- web

/// The security response headers a site is judged on, and what their absence
/// exposes. Kept as data so the check and the explanation stay together.
const SECURITY_HEADERS: &[(&str, &str)] = &[
    (
        "strict-transport-security",
        "Without HSTS a first visit over http can be downgraded before https ever takes hold.",
    ),
    (
        "content-security-policy",
        "Without a CSP a single injected script runs with the page's full authority.",
    ),
    (
        "x-frame-options",
        "Without it the page can be framed by another site and clickjacked.",
    ),
    (
        "x-content-type-options",
        "Without nosniff the browser may execute a response as a type it was not meant to be.",
    ),
    (
        "referrer-policy",
        "Without it the full URL, tokens and all, can leak to third parties in the Referer.",
    ),
    (
        "permissions-policy",
        "Without it there is no stated limit on the camera, microphone and geolocation the page may use.",
    ),
];

/// Parse a block of raw HTTP response headers into lowercased name/value pairs.
/// The status code is pulled from the first line when it is a status line.
pub fn parse_headers(raw: &str) -> (Option<u16>, Vec<(String, String)>) {
    let mut status = None;
    let mut headers = Vec::new();
    for (i, line) in raw.lines().enumerate() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        if i == 0 && line.starts_with("HTTP/") {
            status = line.split_whitespace().nth(1).and_then(|c| c.parse().ok());
            continue;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
        }
    }
    (status, headers)
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, v)| v.as_str())
}

/// The flags on one Set-Cookie value. Missing Secure or HttpOnly is the finding
/// that matters; SameSite absent is a weaker warning.
pub fn cookie_flags(set_cookie: &str) -> (bool, bool, bool) {
    let lower = set_cookie.to_ascii_lowercase();
    let secure = lower.split(';').any(|p| p.trim() == "secure");
    let http_only = lower.split(';').any(|p| p.trim() == "httponly");
    let same_site = lower.split(';').any(|p| p.trim().starts_with("samesite"));
    (secure, http_only, same_site)
}

/// Judge a set of response headers. Pure, so the whole verdict is testable
/// without a socket.
pub fn classify_headers(is_https: bool, headers: &[(String, String)]) -> Vec<Finding> {
    let mut out = Vec::new();

    for (name, why) in SECURITY_HEADERS {
        // HSTS over plain http is meaningless, so its absence is not charged
        // there: the finding to make on http is that the site is on http.
        if *name == "strict-transport-security" && !is_https {
            continue;
        }
        let present = header(headers, name).is_some();
        out.push(Finding {
            level: if present { "ok" } else { "warn" }.into(),
            title: canonical_header_name(name),
            detail: if present {
                "Set.".into()
            } else {
                (*why).into()
            },
        });
    }

    // Cookies: each Set-Cookie judged on its own flags.
    for (n, v) in headers.iter().filter(|(n, _)| n == "set-cookie") {
        let _ = n;
        let name = v.split('=').next().unwrap_or("cookie").trim();
        let (secure, http_only, same_site) = cookie_flags(v);
        let mut missing = Vec::new();
        if is_https && !secure {
            missing.push("Secure");
        }
        if !http_only {
            missing.push("HttpOnly");
        }
        if !same_site {
            missing.push("SameSite");
        }
        out.push(Finding {
            level: if missing.is_empty() { "ok" } else { "warn" }.into(),
            title: format!("Cookie {name}"),
            detail: if missing.is_empty() {
                "Secure, HttpOnly and SameSite all set.".into()
            } else {
                format!("Missing: {}.", missing.join(", "))
            },
        });
    }

    // Version disclosure: not a hole by itself, but it hands an attacker the
    // exact software to look up a CVE for.
    for disclosing in ["server", "x-powered-by"] {
        if let Some(v) = header(headers, disclosing) {
            if v.chars().any(|c| c.is_ascii_digit()) {
                out.push(Finding {
                    level: "warn".into(),
                    title: canonical_header_name(disclosing),
                    detail: format!("Reveals a version ({v}), which points straight at known CVEs."),
                });
            }
        }
    }

    out
}

/// Turn a lowercased header key back into its usual capitalisation for display.
fn canonical_header_name(lower: &str) -> String {
    lower
        .split('-')
        .map(|part| {
            let mut c = part.chars();
            match c.next() {
                Some(first) => first.to_ascii_uppercase().to_string() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join("-")
}

/// Audit one web endpoint: headers, cookies, and (over https) the TLS handshake.
#[tauri::command]
pub async fn sec_audit_web(url: String) -> Result<WebAudit, String> {
    let url = url.trim().to_string();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("give a full http:// or https:// URL".into());
    }
    tauri::async_runtime::spawn_blocking(move || audit_web_blocking(url))
        .await
        .map_err(|e| format!("the audit thread died: {e}"))?
}

fn audit_web_blocking(url: String) -> Result<WebAudit, String> {
    let is_https = url.starts_with("https://");

    // One GET, headers kept, body discarded. No -L: a redirect is itself worth
    // seeing rather than silently following to somewhere else's headers.
    let out = Command::new("curl")
        .args([
            "-sS",
            "-m",
            "12",
            "-D",
            "-",
            "-o",
            "/dev/null",
            "-A",
            "Galactus-SecAudit",
            &url,
        ])
        .output()
        .map_err(|e| format!("curl: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "could not reach {url}: {}",
            err.lines().next().unwrap_or("no response").trim()
        ));
    }
    let raw = String::from_utf8_lossy(&out.stdout);
    let (status, headers) = parse_headers(&raw);

    let mut findings = Vec::new();
    if !is_https {
        findings.push(Finding {
            level: "risk".into(),
            title: "Transport".into(),
            detail: "Served over http, so everything including any cookie travels in clear.".into(),
        });
    } else if let Some(host) = url_host(&url) {
        findings.extend(tls_findings(&host));
    }
    findings.extend(classify_headers(is_https, &headers));

    Ok(WebAudit {
        url,
        status,
        findings,
    })
}

/// The host[:port] out of an http(s) URL, for the TLS probe.
fn url_host(url: &str) -> Option<String> {
    let after = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let authority = after.split(['/', '?', '#']).next().unwrap_or(after);
    // Strip any userinfo, keep host and optional port.
    let hostport = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);
    if hostport.is_empty() {
        None
    } else {
        Some(hostport.to_string())
    }
}

/// The TLS half of the audit, via openssl s_client (LibreSSL ships on macOS).
/// Two facts: the negotiated protocol version, and the certificate's expiry.
fn tls_findings(host: &str) -> Vec<Finding> {
    let connect = if host.contains(':') {
        host.to_string()
    } else {
        format!("{host}:443")
    };
    let servername = host.split(':').next().unwrap_or(host);

    let mut child = match Command::new("openssl")
        .args(["s_client", "-connect", &connect, "-servername", servername])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        // No openssl is not a failure of the audit, just a gap in it.
        Err(_) => return Vec::new(),
    };
    // s_client waits for input; an empty stdin makes it hand back the handshake
    // and exit rather than hang.
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"\n");
    }
    let out = match child.wait_with_output() {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut findings = Vec::new();

    if let Some(proto) = text
        .lines()
        .find(|l| l.trim_start().starts_with("Protocol"))
        .and_then(|l| l.split(':').nth(1))
        .map(str::trim)
    {
        // TLS 1.0 and 1.1 are deprecated and removed from modern browsers.
        let weak = proto.contains("1.0") || proto.contains("1.1") || proto.contains("SSLv");
        findings.push(Finding {
            level: if weak { "risk" } else { "ok" }.into(),
            title: "TLS version".into(),
            detail: if weak {
                format!("{proto} is deprecated and rejected by current browsers.")
            } else {
                format!("{proto}.")
            },
        });
    }

    // Certificate expiry, read from the same handshake's PEM if present.
    if let Some(days) = cert_days_remaining(&text) {
        let level = if days < 0 {
            "risk"
        } else if days < 15 {
            "warn"
        } else {
            "ok"
        };
        findings.push(Finding {
            level: level.into(),
            title: "Certificate".into(),
            detail: if days < 0 {
                "Expired.".into()
            } else {
                format!("Valid for {days} more day(s).")
            },
        });
    }

    findings
}

/// Days until the certificate in an s_client dump expires, via openssl x509.
/// Negative when already expired. None when there is no cert or no openssl.
fn cert_days_remaining(s_client_output: &str) -> Option<i64> {
    let begin = s_client_output.find("-----BEGIN CERTIFICATE-----")?;
    let end = s_client_output.find("-----END CERTIFICATE-----")?;
    let pem = &s_client_output[begin..end + "-----END CERTIFICATE-----".len()];

    let mut child = Command::new("openssl")
        .args(["x509", "-noout", "-enddate"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(pem.as_bytes());
    }
    let out = child.wait_with_output().ok()?;
    let line = String::from_utf8_lossy(&out.stdout);
    // "notAfter=Aug 18 12:00:00 2027 GMT"
    let after = line.trim().strip_prefix("notAfter=")?;
    let expiry = parse_openssl_date(after)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs() as i64;
    Some((expiry - now) / 86_400)
}

/// A "Mon DD HH:MM:SS YYYY GMT" openssl date to a unix timestamp.
///
/// A tiny date parser rather than a crate, since this is the only date the
/// whole module reads and the format is fixed. Days-from-civil is the standard
/// algorithm (Howard Hinnant's), which is exact and has no leap-year edge left.
pub fn parse_openssl_date(s: &str) -> Option<i64> {
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() < 4 {
        return None;
    }
    let month = match parts[0] {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    };
    let day: i64 = parts[1].parse().ok()?;
    let year: i64 = parts[3].parse().ok()?;
    let time: Vec<&str> = parts[2].split(':').collect();
    if time.len() != 3 {
        return None;
    }
    let (h, m, sec): (i64, i64, i64) = (
        time[0].parse().ok()?,
        time[1].parse().ok()?,
        time[2].parse().ok()?,
    );

    // days_from_civil: days since 1970-01-01 for a proleptic Gregorian date.
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + h * 3600 + m * 60 + sec)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn well_known_ports_are_labelled_and_the_rest_are_not() {
        assert_eq!(service_for_port(22), Some("ssh"));
        assert_eq!(service_for_port(5432), Some("postgres"));
        assert_eq!(service_for_port(6379), Some("redis"));
        assert_eq!(service_for_port(49512), None);
    }

    #[test]
    fn a_host_with_a_shell_metacharacter_is_refused() {
        assert!(is_plausible_host("192.168.1.10"));
        assert!(is_plausible_host("build.local"));
        assert!(!is_plausible_host("localhost; rm -rf /"));
        assert!(!is_plausible_host("-oProxyCommand=evil"));
        assert!(!is_plausible_host(""));
    }

    #[test]
    fn a_banner_keeps_only_readable_text_and_is_bounded() {
        assert_eq!(clean_banner(b"SSH-2.0-OpenSSH_9.6\r\n"), Some("SSH-2.0-OpenSSH_9.6".into()));
        assert_eq!(clean_banner(&[0u8, 0, 0]), None);
        let long = vec![b'a'; 1000];
        assert_eq!(clean_banner(&long).unwrap().len(), BANNER_MAX);
    }

    #[test]
    fn a_missing_security_header_is_a_warning_and_a_present_one_is_ok() {
        let headers = vec![
            ("content-security-policy".into(), "default-src 'self'".into()),
        ];
        let f = classify_headers(true, &headers);
        let csp = f.iter().find(|f| f.title == "Content-Security-Policy").unwrap();
        assert_eq!(csp.level, "ok");
        let xfo = f.iter().find(|f| f.title == "X-Frame-Options").unwrap();
        assert_eq!(xfo.level, "warn");
    }

    #[test]
    fn hsts_is_not_charged_over_plain_http() {
        // Its absence on http is not the finding; being on http is.
        let f = classify_headers(false, &[]);
        assert!(!f.iter().any(|f| f.title == "Strict-Transport-Security"));
    }

    #[test]
    fn a_cookie_without_secure_or_httponly_is_flagged() {
        let (secure, http_only, same_site) = cookie_flags("session=abc; Path=/; SameSite=Lax");
        assert!(!secure);
        assert!(!http_only);
        assert!(same_site);

        let headers = vec![("set-cookie".into(), "session=abc; Path=/".into())];
        let f = classify_headers(true, &headers);
        let cookie = f.iter().find(|f| f.title.starts_with("Cookie")).unwrap();
        assert_eq!(cookie.level, "warn");
        assert!(cookie.detail.contains("Secure"));
        assert!(cookie.detail.contains("HttpOnly"));
    }

    #[test]
    fn a_server_header_with_a_version_is_a_disclosure() {
        let headers = vec![("server".into(), "nginx/1.18.0".into())];
        let f = classify_headers(true, &headers);
        assert!(f.iter().any(|f| f.title == "Server" && f.level == "warn"));
        // A version-less Server header is not worth a finding.
        let bare = vec![("server".into(), "cloudflare".into())];
        assert!(!classify_headers(true, &bare).iter().any(|f| f.title == "Server"));
    }

    #[test]
    fn the_status_line_and_headers_parse() {
        let raw = "HTTP/2 200\r\nContent-Type: text/html\r\nSet-Cookie: a=1; Secure\r\n\r\n";
        let (status, headers) = parse_headers(raw);
        assert_eq!(status, Some(200));
        assert_eq!(header(&headers, "content-type"), Some("text/html"));
    }

    #[test]
    fn the_openssl_date_parser_matches_a_known_instant() {
        // 1970-01-01 00:00:00 GMT is the epoch.
        assert_eq!(parse_openssl_date("Jan 1 00:00:00 1970 GMT"), Some(0));
        // 2000-01-01 00:00:00 GMT is 946684800.
        assert_eq!(parse_openssl_date("Jan 1 00:00:00 2000 GMT"), Some(946_684_800));
        assert_eq!(parse_openssl_date("nonsense"), None);
    }
}
