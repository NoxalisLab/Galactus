// Les outils que l'agent utilise, derriere le portail de permissions.
//
// Lire et ecrire un fichier, lister un dossier, previsualiser et annuler une
// ecriture, chercher sur le web, lancer une commande avec une echeance. Le
// portail lui-meme est cote frontend: ce module suppose la permission accordee
// et se charge de ce qui doit rester hors du navigateur.
//
// Plusieurs de ses utilitaires servent ailleurs (floor_char_boundary,
// run_with_deadline, normalize_user_path) et sont donc pub(crate).

use crate::*;

pub(crate) const TOOL_MAX_OUTPUT: usize = 200_000;

/// Drain a child pipe on a background thread. A pipe left undrained blocks the
/// child as soon as the ~64 KB kernel buffer fills, which turns any chatty
/// process into a fake "timeout".
pub(crate) fn drain_pipe<R: std::io::Read + Send + 'static>(r: Option<R>) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut r) = r {
            let _ = r.read_to_end(&mut buf);
        }
        buf
    })
}

pub(crate) struct ChildOutput {
    /// None means the deadline passed: the child was killed and reaped.
    pub(crate) status: Option<std::process::ExitStatus>,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

/// Wait for a child until `deadline`, draining both pipes concurrently.
pub(crate) fn run_with_deadline(mut child: Child, deadline: Instant) -> Result<ChildOutput, String> {
    let out_h = drain_pipe(child.stdout.take());
    let err_h = drain_pipe(child.stderr.take());
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(s) => break Some(s),
            None => {
                if Instant::now() > deadline {
                    // The GROUP, not the child. Killing the direct process
                    // alone leaves grandchildren holding the pipe, and the
                    // joins below then never return.
                    pty::kill_group(child.id() as i32);
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(120));
            }
        }
    };
    let stdout = String::from_utf8_lossy(&out_h.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&err_h.join().unwrap_or_default()).into_owned();
    Ok(ChildOutput { status, stdout, stderr })
}

/// Largest index <= `max` that falls on a UTF-8 char boundary of `s`.
/// Slicing/truncating at an arbitrary byte offset panics on multi-byte
/// characters (French output makes that a near-certainty).
pub(crate) fn floor_char_boundary(s: &str, max: usize) -> usize {
    if max >= s.len() {
        return s.len();
    }
    let mut i = max;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

// Async and streamed: reading a 200 GB GGUF whole would allocate it all and
// freeze the main thread. Only the requested window ever touches RAM.
#[tauri::command]
pub async fn tool_fs_read(path: String, max_bytes: usize, offset: Option<u64>) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};
    let real = normalize_user_path(&path)?;
    let mut f = std::fs::File::open(&real).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let start = offset.unwrap_or(0).min(len);
    let cap = max_bytes.min(TOOL_MAX_OUTPUT) as u64;
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut data = Vec::new();
    f.take(cap).read_to_end(&mut data).map_err(|e| e.to_string())?;
    let end = start + data.len() as u64;
    let mut text = String::from_utf8_lossy(&data).into_owned();
    if start > 0 {
        text = format!("…(from byte {start})\n{text}");
    }
    if end < len {
        text.push_str(&format!(
            "\n…(truncated at byte {end} of {len}, read further with offset={end})"
        ));
    }
    Ok(text)
}

/// Fetch a URL for the agent (curl under the hood: TLS and redirects handled
/// by the system tool, nothing new to bundle). Output is capped like every
/// tool; the permission gate on the frontend shows the exact URL.
#[cfg(test)]
mod web_fetch_tests {
    use super::{is_private_host, url_host};

    #[test]
    fn the_host_is_read_out_of_a_real_url() {
        assert_eq!(url_host("https://example.com/a/b?c=d").as_deref(), Some("example.com"));
        assert_eq!(url_host("http://user:pw@example.com:8080/x").as_deref(), Some("example.com"));
        assert_eq!(url_host("http://[::1]:9000/x").as_deref(), Some("::1"));
        assert_eq!(url_host("https://EXAMPLE.com").as_deref(), Some("example.com"));
        assert_eq!(url_host("not a url"), None);
    }

    #[test]
    fn this_machine_and_this_network_are_not_the_web() {
        // Everything a model reaches for when a page tells it to look around:
        // the engine's own port, the router, the printer, the metadata address.
        for h in [
            "127.0.0.1", "localhost", "::1", "0.0.0.0", "10.0.0.5", "192.168.1.1",
            "172.16.0.1", "172.31.255.255", "169.254.169.254", "printer.local", "fd00::1",
        ] {
            assert!(is_private_host(h), "{h} must be refused");
        }
    }

    #[test]
    fn loopback_written_the_way_somebody_hides_it() {
        // Every one of these reaches 127.0.0.1 through curl, and every one was
        // ALLOWED by the first version of this check, which parsed strict
        // dotted-decimal and returned "not an address, therefore public".
        for h in [
            "2130706433",     // the whole address as one integer
            "0x7f000001",     // hexadecimal
            "127.1",          // two parts: the last absorbs three bytes
            "0177.0.0.1",     // octal first byte
            "::ffff:127.0.0.1", // IPv4-mapped IPv6
        ] {
            assert!(super::is_private_host(h), "{h} reaches loopback and must be refused");
        }
        // And the same forms for the metadata address and a LAN host.
        assert!(super::is_private_host("0xa9fea9fe"), "169.254.169.254 in hex");
        assert!(super::is_private_host("0xc0a80101"), "192.168.1.1 in hex");
    }

    #[test]
    fn the_actual_web_still_works() {
        for h in [
            "example.com", "huggingface.co", "8.8.8.8", "172.32.0.1", "11.0.0.1", "2606:4700::1",
        ] {
            assert!(!is_private_host(h), "{h} must be allowed");
        }
    }
}

/// The host of an http(s) URL, lowercased, without port or credentials.
pub(crate) fn url_host(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit('@').next()?;
    // IPv6 literals are bracketed, and a bracketed host has no bare colon.
    let host = if let Some(inner) = authority.strip_prefix('[') {
        inner.split(']').next()?.to_string()
    } else {
        authority.split(':').next()?.to_string()
    };
    if host.is_empty() { None } else { Some(host.to_lowercase()) }
}

/// An IPv4 address in any form `inet_aton` accepts, as a u32.
///
/// One to four parts, each decimal, octal (leading zero) or hexadecimal
/// (leading 0x). A single part is the whole address; two parts are a.b where b
/// takes 24 bits, and so on. This is not a curiosity: it is how a loopback
/// address is written when someone does not want it recognised.
pub(crate) fn parse_ipv4_any(host: &str) -> Option<u32> {
    // An IPv4-mapped IPv6 literal carries a dotted QUAD at its end
    // (::ffff:127.0.0.1). Only then: taking the tail of any colon-separated
    // host turned 2606:4700::1 into "1", which parses as 0.0.0.1 and lands in
    // the 0.0.0.0/8 range, so an ordinary public IPv6 address was refused.
    let host = match host.rsplit_once(':') {
        Some((_, tail)) if tail.contains('.') => tail,
        Some(_) => return None,
        None => host,
    };
    let parts: Vec<&str> = host.split('.').collect();
    if parts.is_empty() || parts.len() > 4 {
        return None;
    }
    let mut values = Vec::with_capacity(parts.len());
    for part in &parts {
        let value = if let Some(hex) = part.strip_prefix("0x").or_else(|| part.strip_prefix("0X")) {
            u32::from_str_radix(hex, 16).ok()?
        } else if part.len() > 1 && part.starts_with('0') {
            u32::from_str_radix(&part[1..], 8).ok()?
        } else {
            part.parse::<u32>().ok()?
        };
        values.push(value);
    }
    // The last part absorbs the remaining bytes; the earlier ones are one byte.
    let last = *values.last()?;
    let leading = &values[..values.len() - 1];
    if leading.iter().any(|v| *v > 255) {
        return None;
    }
    let remaining_bits = 32 - 8 * leading.len() as u32;
    if remaining_bits < 32 && last >= (1u64 << remaining_bits) as u32 {
        return None;
    }
    let mut addr = 0u32;
    for (i, v) in leading.iter().enumerate() {
        addr |= v << (24 - 8 * i as u32);
    }
    Some(addr | last)
}

/// Whether a host names this machine or the local network.
///
/// Literals only. A name that RESOLVES to a private address is not caught here
/// and cannot be without doing the lookup ourselves; this closes the direct
/// cases, which are the ones a model reaches for.
pub(crate) fn is_private_host(host: &str) -> bool {
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return true;
    }
    if host == "::1" || host == "0:0:0:0:0:0:0:1" {
        return true;
    }
    // Unique local addresses (fc00::/7) and IPv6 link-local (fe80::/10).
    let low = host.to_lowercase();
    if low.starts_with("fc") || low.starts_with("fd") || low.starts_with("fe8") {
        if low.contains(':') {
            return true;
        }
    }
    // An IPv4 address does not have to be four decimal parts, and curl accepts
    // every other form: 2130706433, 0x7f000001, 127.1 and 0177.0.0.1 all reach
    // 127.0.0.1. The first version of this check parsed strict dotted-decimal
    // and therefore ALLOWED all four, which is the whole address space it
    // exists to refuse. Anything that parses as an address in any of inet_aton's
    // forms is normalised before the ranges are consulted.
    let Some(addr) = parse_ipv4_any(host) else {
        // Not an address at all: a DNS name, which is judged by name above.
        return false;
    };
    let octets = [
        (addr >> 24) & 0xff,
        (addr >> 16) & 0xff,
        (addr >> 8) & 0xff,
        addr & 0xff,
    ];
    match (octets[0], octets[1]) {
        (127, _) => true,
        (10, _) => true,
        (0, _) => true,
        (192, 168) => true,
        (169, 254) => true, // link-local, and the cloud metadata address
        (172, b) if (16..=31).contains(&b) => true,
        _ => false,
    }
}

#[tauri::command]
pub async fn tool_web_fetch(url: String, max_bytes: Option<usize>) -> Result<String, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) URLs are allowed".into());
    }
    // The machine's own network is not the web.
    //
    // Only the scheme was checked, so a model could reach 127.0.0.1, the
    // engine's own port, a router's admin page, a printer, or the cloud
    // metadata address, from an app that presents itself as local and offline.
    // Combined with a page telling it to, that is a scan of the user's network
    // dressed as a web fetch.
    if let Some(host) = url_host(&url) {
        if is_private_host(&host) {
            return Err(format!(
                "{host} is on this machine or this network, not the web: refusing"
            ));
        }
    }
    let child = Command::new("curl")
        .args([
            // NOT -L. A public host that answers 302 to 169.254.169.254 or to
            // 127.0.0.1 was followed without a second look, because the host
            // check ran once, on the URL the model supplied. Redirects are
            // reported to the model instead, which can decide to fetch the
            // target and have it checked like any other address.
            "-s",
            "--max-redirs",
            "0",
            "--max-time",
            "45",
            "--max-filesize",
            "5000000",
            "-A",
            "Galactus/0.1 (macOS; local assistant)",
        ])
        .arg(&url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let out = run_with_deadline(child, Instant::now() + Duration::from_secs(50))?;
    let Some(status) = out.status else {
        return Err("fetch timed out".into());
    };
    if !status.success() {
        let err = out.stderr.trim().to_string();
        return Err(if err.is_empty() { format!("fetch failed (curl exit {})", status.code().unwrap_or(-1)) } else { err });
    }
    let cap = max_bytes.unwrap_or(TOOL_MAX_OUTPUT).min(TOOL_MAX_OUTPUT);
    let mut text = out.stdout;
    if text.len() > cap {
        text.truncate(floor_char_boundary(&text, cap));
        text.push_str("\n…(truncated)");
    }
    Ok(text)
}

/// Internal spill area for oversized tool outputs and sub-agent transcripts.
/// The agent can READ these (tool_fs_read) but cannot overwrite them: the
/// whole Application Support folder is refused by tool_fs_write.
#[tauri::command]
pub fn scratch_write(name: String, content: String) -> Result<String, String> {
    if name.is_empty() || name.contains("..") || name.contains('/') || name.starts_with('.') {
        return Err("invalid scratch name".into());
    }
    let dir = app_support().join("scratch");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = dir.join(name);
    std::fs::write(&p, content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(p.display().to_string())
}

#[derive(Serialize, Clone)]
pub(crate) struct DiffResult {
    path: String,
    before: String,
    after: String,
    added: usize,
    removed: usize,
    existed: bool,
}

/// Unified-ish diff summary between two texts: counts of added/removed lines.
pub(crate) fn diff_counts(before: &str, after: &str) -> (usize, usize) {
    let b: Vec<&str> = before.lines().collect();
    let a: Vec<&str> = after.lines().collect();
    // Longest common subsequence on lines (bounded to keep it cheap).
    if b.len() * a.len() > 4_000_000 {
        return (a.len(), b.len());
    }
    let mut dp = vec![vec![0usize; a.len() + 1]; b.len() + 1];
    for i in (0..b.len()).rev() {
        for j in (0..a.len()).rev() {
            dp[i][j] = if b[i] == a[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }
    let common = dp[0][0];
    (a.len() - common, b.len() - common)
}

/// Preview a write without touching the disk: returns before/after and the
/// line deltas so the UI can show a Cursor-style diff before approval.
#[tauri::command]
pub fn tool_fs_preview(path: String, content: String) -> Result<DiffResult, String> {
    // Same normalization as tool_fs_write: the previewed path must be the
    // exact file the approved write will touch, and `..` is refused here too.
    let real = normalize_user_path(&path)?;
    let existed = real.is_file();
    let before = if existed {
        std::fs::read_to_string(&real).unwrap_or_default()
    } else {
        String::new()
    };
    let (added, removed) = diff_counts(&before, &content);
    Ok(DiffResult {
        path: real.display().to_string(),
        before,
        after: content,
        added,
        removed,
        existed,
    })
}

/// Backup file name for a path: FNV-1a hash prefix (collision-proof between
/// `/a/b` and `/a_b`) plus a readable tail, capped well under NAME_MAX.
pub(crate) fn backup_name(path: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in path.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    let stamp = path.replace('/', "_");
    let tail: String = stamp
        .chars()
        .rev()
        .take(120)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("{h:016x}-{tail}.bak")
}

/// Normalize a tool-supplied path so guards compare real locations, not the
/// spelling the caller chose. Any `..` component is rejected outright (a
/// lexical prefix check is defeated by traversal, and no legitimate tool call
/// needs one); the deepest EXISTING ancestor is then canonicalized (symlinks
/// resolved) and the not-yet-existing remainder re-attached.
pub(crate) fn normalize_user_path(path: &str) -> Result<PathBuf, String> {
    use std::path::Component;
    let p = Path::new(path);
    if p.as_os_str().is_empty() {
        return Err("empty path".into());
    }
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("path contains '..', refusing: {path}"));
    }
    let mut anchor = p.to_path_buf();
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    while !anchor.as_os_str().is_empty() && !anchor.exists() {
        let Some(name) = anchor.file_name().map(|n| n.to_os_string()) else { break };
        rest.push(name);
        if !anchor.pop() {
            break;
        }
    }
    // A relative path with no existing ancestor anchors on the current dir.
    let base = if anchor.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        anchor
    };
    let mut out = base
        .canonicalize()
        .map_err(|e| format!("{}: {e}", base.display()))?;
    for name in rest.iter().rev() {
        out.push(name);
    }
    Ok(out)
}

/// The agent must not be able to rewrite the app's own configuration
/// (settings.json holds the MCP server commands and standing permissions:
/// writing it grants arbitrary command execution on the next reload).
/// Callers pass a path already through normalize_user_path; the comparison
/// covers both the lexical and the canonical spelling of the config folder.
pub(crate) fn is_protected_write(path: &Path) -> bool {
    let support = app_support();
    let canon = support.canonicalize().unwrap_or_else(|_| support.clone());
    path.starts_with(&support) || path.starts_with(&canon)
}

#[tauri::command]
pub fn tool_fs_write(path: String, content: String) -> Result<String, String> {
    let real = normalize_user_path(&path)?;
    if is_protected_write(&real) {
        return Err("refusing to write inside the Galactus configuration folder".into());
    }
    if let Some(dir) = real.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Keep a one-step backup so a bad edit can be reverted from the UI, and
    // REFUSE when it cannot be taken. The result was ignored, so on a full disk
    // the copy failed silently, the write below truncated the file (a metadata
    // operation, which succeeds), and the write itself then failed: the user's
    // file was empty, there was no backup, and revert answered "no backup for
    // this file".
    if real.is_file() {
        let backups = app_support().join("backups");
        std::fs::create_dir_all(&backups).map_err(|e| format!("backup folder: {e}"))?;
        std::fs::copy(&real, backups.join(backup_name(&real.to_string_lossy())))
            .map_err(|e| format!("refusing to write {}: its backup could not be taken ({e})", real.display()))?;
    }
    // Write-then-rename, like every other write in this app. A plain write
    // truncates first, and the window between the truncate and the last byte is
    // where a file is lost.
    let tmp = real.with_extension(format!(
        "{}.galactus-tmp",
        real.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default()
    ));
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    if let Ok(meta) = std::fs::metadata(&real) {
        // A new file takes the umask, not the original's mode: an executable
        // script stopped being executable the first time it was written.
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    std::fs::rename(&tmp, &real).map_err(|e| e.to_string())?;
    Ok(format!("wrote {} bytes to {}", content.len(), real.display()))
}

/// Restore the last backup taken for a path (the "undo" of an edit).
#[tauri::command]
pub fn tool_fs_revert(path: String) -> Result<String, String> {
    let real = normalize_user_path(&path)?;
    if is_protected_write(&real) {
        return Err("refusing to write inside the Galactus configuration folder".into());
    }
    let bak = app_support().join("backups").join(backup_name(&real.to_string_lossy()));
    if !bak.is_file() {
        return Err("no backup for this file".into());
    }
    std::fs::copy(&bak, &real).map_err(|e| e.to_string())?;
    Ok(format!("reverted {}", real.display()))
}

#[tauri::command]
pub fn tool_fs_list(path: String) -> Result<String, String> {
    let mut lines = Vec::new();
    let entries = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut sorted: Vec<_> = entries.flatten().collect();
    sorted.sort_by_key(|e| e.file_name());
    for e in sorted.iter().take(500) {
        let meta = e.metadata().ok();
        let kind = if meta.as_ref().map(|m| m.is_dir()).unwrap_or(false) { "dir " } else { "file" };
        let size = meta.map(|m| m.len()).unwrap_or(0);
        lines.push(format!("{kind} {size:>12}  {}", e.file_name().to_string_lossy()));
    }
    if sorted.len() > 500 {
        lines.push(format!("…({} entries total)", sorted.len()));
    }
    Ok(lines.join("\n"))
}

#[tauri::command]
pub async fn tool_shell_run(command: String, timeout_secs: u64) -> Result<String, String> {
    let mut cmd = Command::new("/bin/zsh");
    cmd.arg("-lc").arg(&command);
    // The model's shell commands must find python3 even on a Mac without the
    // Command Line Tools: the bundled runtime's bin dir leads the PATH.
    if let Some(py) = bundled_python() {
        if let Some(dir) = py.parent() {
            let path = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into());
            cmd.env("PATH", format!("{}:{}", dir.display(), path));
        }
    }
    // Its own process group, so the deadline can kill the whole tree. Without
    // it, `npm run dev` survives its zsh: the grandchild keeps the stdout pipe
    // open, the drain thread blocks in read(2) forever, and the tool never
    // returns rather than timing out. Reproduced with a two-level sleep.
    pty::own_session(&mut cmd);
    let child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Nothing may wait on input. The app has no terminal, so a command that
        // reads stdin (a package manager asking to confirm, a `read`, an ssh
        // host-key question) would sit there until the deadline killed it, and
        // the model would be told only that it timed out. Closed stdin turns
        // that into an immediate, readable EOF.
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(timeout_secs.clamp(1, 600));
    let out = run_with_deadline(child, deadline)?;
    let Some(status) = out.status else {
        // A deadline is not a failure and the output is not worthless. This
        // returned the bare words "(timed out)" and threw away everything the
        // command had printed, so `uvicorn main:app`, which had already said
        // "Uvicorn running on http://127.0.0.1:8000", read as having produced
        // nothing at all: the model concluded it had failed and ran it again,
        // and again. Say what happened, and hand back what was said.
        return Ok(timeout_report(&out.stdout, &out.stderr, timeout_secs.clamp(1, 600)));
    };
    let mut text = out.stdout;
    if !out.stderr.trim().is_empty() {
        text.push_str("\n[stderr]\n");
        text.push_str(&out.stderr);
    }
    if text.len() > TOOL_MAX_OUTPUT {
        text.truncate(floor_char_boundary(&text, TOOL_MAX_OUTPUT));
        text.push_str("\n…(truncated)");
    }
    if text.trim().is_empty() {
        text = format!("(exit {})", status.code().unwrap_or(-1));
    }
    Ok(text)
}

/// What a command that outlived its deadline reports back.
///
/// Written for a reader that will decide what to do next from these words
/// alone. It has to carry three things: that the process was alive and was
/// stopped (not that it crashed), everything it managed to print, and the one
/// piece of advice that makes the next attempt different from this one. Without
/// the last part a model retries the identical command, which is how a demo
/// turns into a loop.
pub(crate) fn timeout_report(stdout: &str, stderr: &str, secs: u64) -> String {
    let mut text = format!(
        "(still running after {secs}s, so it was stopped. A command that does not \
         exit on its own, a server for instance, must be started in the background \
         instead: append ` >/tmp/out.log 2>&1 &` and then read that log.)"
    );
    let printed = format!("{stdout}\n{stderr}");
    if !printed.trim().is_empty() {
        text.push_str("\n\nWhat it printed before it was stopped:\n");
        text.push_str(printed.trim());
        if text.len() > TOOL_MAX_OUTPUT {
            text.truncate(floor_char_boundary(&text, TOOL_MAX_OUTPUT));
            text.push_str("\n…(truncated)");
        }
    }
    text
}

#[cfg(test)]
mod shell_timeout_tests {
    use super::timeout_report;

    #[test]
    fn a_server_that_announced_itself_is_not_reported_as_silent() {
        // The exact line uvicorn prints, and the reason the old "(timed out)"
        // was so costly: this sentence IS the proof the command worked.
        let r = timeout_report("INFO: Uvicorn running on http://127.0.0.1:8000\n", "", 120);
        assert!(r.contains("Uvicorn running on http://127.0.0.1:8000"));
    }

    #[test]
    fn the_report_says_what_to_do_differently() {
        // Without this the next attempt is the same attempt.
        let r = timeout_report("", "", 120);
        assert!(r.contains("background"), "a retry needs to differ from the try");
        assert!(r.contains("120s"));
    }

    #[test]
    fn stderr_is_carried_too() {
        let r = timeout_report("", "Traceback (most recent call last):", 5);
        assert!(r.contains("Traceback"));
    }
}
