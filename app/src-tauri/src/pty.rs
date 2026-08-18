// Galactus desktop, the integrated terminal's process side.
//
// A REAL pty, not a pipe. The difference is not cosmetic: a program that finds
// a pipe on its stdout turns colour off, drops its progress bar, buffers 4 KB
// at a time instead of line by line, and refuses to prompt at all. `git`,
// `npm`, `cargo`, `pytest`, `ssh` and every REPL behave like different
// programs depending on that one answer to isatty(3). A terminal built on
// Stdio::piped() is therefore not a terminal, it is a log viewer, and the user
// discovers the difference the first time something asks for a password.
//
// NO NEW CRATE. The usual answer here is portable-pty, and it is a good crate,
// but everything it does on macOS is four libc calls that libSystem already
// exports and that every Rust binary on this platform is already linked
// against: posix_openpt, grantpt, unlockpt, ptsname. Declaring them by hand
// costs about forty lines and keeps the dependency tree, the NOTICE file and
// the licence review exactly where they are. The rest (session leadership,
// controlling terminal, window size) is setsid(2) and two ioctls.
//
// THREE TRAPS THIS FILE EXISTS TO AVOID, all found the hard way.
//
//   1. TIOCSWINSZ on the master fails with ENOTTY until the slave side has
//      been opened at least once. Setting the size right after posix_openpt,
//      which is the order that reads naturally, silently leaves the child at
//      80x24 forever. `open_pty` opens the slave first, then sizes.
//
//   2. The parent must NOT keep a slave fd open past the spawn. If it does,
//      the master never reports EOF when the child dies, the reader thread
//      blocks in read(2) for the lifetime of the app, and every closed
//      terminal tab leaks one OS thread plus one file descriptor. The three
//      slave handles here are moved into Stdio, which closes the parent's
//      copies as part of spawning, and nothing else holds one.
//
//   3. Killing the child is not enough. The shell is a session leader with a
//      whole process group under it, and `Child::kill` signals one pid: a
//      `npm run dev` started in the terminal would survive its own terminal.
//      Every signal here goes to the process GROUP, which is exactly why the
//      child is put in its own session with setsid(2) in pre_exec.
//
// SECURITY. This module executes whatever bytes reach `pty_write`, so it is
// worth being precise about who can reach it. These commands are part of the
// app's own frontend surface; the model never sees them, because the model
// only ever calls the tools declared in agent.ts, and no pty tool is declared
// there. The permission gate for terminal input therefore lives in the
// frontend, next to the tool dispatcher that knows whether a byte came from a
// keystroke or from a model turn (see `decideTerminalWrite` in
// src/code/terminal.ts).
//
// That said, a gate that exists only in one branch of one caller is one
// refactor away from being skipped by accident, so `authorize_write` below
// enforces the same invariant a second time and closer to the syscall: a write
// whose origin is the model, into a session the user owns, is REFUSED unless
// the caller states outright that it passed the shell gate. This is not
// protection against a hostile frontend, which could pass the flag anyway; it
// is protection against a future edit that simply forgets, and it turns that
// omission from a silent hole into a visible error string.

use serde::Serialize;
use std::collections::HashMap;
use std::ffi::{c_char, c_int, c_short, c_uint, c_ulong, CStr};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

// ---------------------------------------------------------------- libc

extern "C" {
    fn posix_openpt(flags: c_int) -> c_int;
    fn grantpt(fd: c_int) -> c_int;
    fn unlockpt(fd: c_int) -> c_int;
    fn ptsname(fd: c_int) -> *mut c_char;
    fn setsid() -> c_int;
    fn killpg(pgrp: c_int, sig: c_int) -> c_int;
    fn poll(fds: *mut PollFd, nfds: c_uint, timeout: c_int) -> c_int;
    // ioctl is variadic in C. It must be declared variadic here too: on
    // aarch64-apple-darwin the variadic arguments travel on the stack while
    // fixed ones travel in registers, so a convenient non-variadic
    // declaration would put the pointer in the wrong place and the call would
    // read garbage.
    fn ioctl(fd: c_int, request: c_ulong, ...) -> c_int;
    // Also variadic in C, and for the same reason it must be declared variadic
    // here. Only ever called with F_SETFD.
    fn fcntl(fd: c_int, cmd: c_int, ...) -> c_int;
}

const O_RDWR: c_int = 0x0002;
const O_NOCTTY: c_int = 0x0002_0000;
/// How many times to reopen /dev/ptmx before giving up. Five attempts with a
/// rising backoff spans about sixty milliseconds, which is far longer than the
/// contention window and still imperceptible when opening a terminal.
const PTMX_OPEN_ATTEMPTS: i32 = 5;

/// `fcntl` command: set the file descriptor flags.
const F_SETFD: c_int = 2;
/// The only descriptor flag there is: close this fd on exec(2).
const FD_CLOEXEC: c_int = 1;
/// `_IO('t', 97)` on Darwin: make this fd the calling session's controlling tty.
const TIOCSCTTY: c_ulong = 0x2000_7461;
/// `_IOW('t', 103, struct winsize)` on Darwin, with sizeof(winsize) == 8.
const TIOCSWINSZ: c_ulong = 0x8008_7467;
const POLLIN: c_short = 0x0001;
const SIGHUP: c_int = 1;
const SIGKILL: c_int = 9;

#[repr(C)]
struct Winsize {
    ws_row: u16,
    ws_col: u16,
    ws_xpixel: u16,
    ws_ypixel: u16,
}

#[repr(C)]
struct PollFd {
    fd: c_int,
    events: c_short,
    revents: c_short,
}

// ---------------------------------------------------------------- limits

/// Terminals open faster than they are closed. Eight is more than any real
/// session needs and small enough that a runaway caller cannot exhaust the
/// process' fd table.
pub const MAX_SESSIONS: usize = 8;
/// Geometry bounds. A zero column count makes the child divide by zero when it
/// wraps, and a five-figure one makes ncurses allocate a screen buffer the size
/// of a small file, so both ends are pinned.
pub const MIN_COLS: u16 = 2;
pub const MAX_COLS: u16 = 1000;
pub const MIN_ROWS: u16 = 1;
pub const MAX_ROWS: u16 = 300;
/// One read(2) at a time. The coalescer below may stack several of these into
/// one event, up to `MAX_CHUNK`.
const READ_BUF: usize = 16 * 1024;
/// Ceiling on one emitted chunk. `yes` writes faster than any UI can paint;
/// without a ceiling the event bus, not the terminal, becomes the bottleneck.
const MAX_CHUNK: usize = 64 * 1024;
/// How long the coalescer waits for more bytes before flushing what it has.
/// Long enough to merge a burst, short enough that a prompt still feels
/// instant.
const COALESCE_MS: c_int = 8;

/// Clamp a requested geometry into something a child process can survive.
/// Nothing here trusts the caller: the numbers come from a DOM measurement
/// divided by a font metric, and a hidden pane measures zero.
pub fn clamp_dims(cols: u16, rows: u16) -> (u16, u16) {
    (cols.clamp(MIN_COLS, MAX_COLS), rows.clamp(MIN_ROWS, MAX_ROWS))
}

// ------------------------------------------------------------ utf8 framing

/// Length of the longest prefix of `buf` that is safe to decode now.
///
/// A read(2) on a pty cuts wherever the kernel buffer ended, which lands in
/// the middle of a multi-byte character often enough to matter: an accented
/// character split across two chunks and decoded eagerly becomes two
/// replacement characters, permanently, because the damage is done before the
/// second half arrives. The tail of an incomplete sequence is held back
/// instead and prepended to the next read.
///
/// Only a TRUNCATED sequence is held back. Bytes that can never start or
/// continue a valid sequence are left in the prefix so that `from_utf8_lossy`
/// turns them into one replacement character and the stream keeps moving:
/// holding back genuine garbage would stall the terminal until the process
/// happened to emit valid UTF-8 again.
pub fn utf8_safe_prefix(buf: &[u8]) -> usize {
    let n = buf.len();
    // A UTF-8 sequence is at most 4 bytes, so only the last 3 can be a partial
    // one. Walk back to the most recent lead byte within that window.
    let start = n.saturating_sub(3);
    let mut i = n;
    while i > start {
        i -= 1;
        let b = buf[i];
        if b & 0xC0 == 0x80 {
            continue; // continuation byte, keep walking back
        }
        // `i` is a lead byte (or plain ASCII). How long should its sequence be?
        let need = if b < 0x80 {
            1
        } else if b & 0xE0 == 0xC0 {
            2
        } else if b & 0xF0 == 0xE0 {
            3
        } else if b & 0xF8 == 0xF0 {
            4
        } else {
            // 0x80..=0xBF was skipped above and 0xF8..=0xFF is not a lead byte
            // at all: it is garbage, and garbage is never held back.
            return n;
        };
        return if n - i < need { i } else { n };
    }
    // The last three bytes are all continuations. Either the sequence they
    // belong to started before the window and is complete, or the data is
    // malformed; in both cases nothing is gained by waiting.
    n
}

// ------------------------------------------------------------ authorization

/// Who a session belongs to. A session the user opened by clicking "new
/// terminal" and a scratch session an agent opened for itself are not the same
/// object and must not be confused, whatever they look like on screen.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Owner {
    User,
    Model,
}

impl Owner {
    pub fn parse(s: &str) -> Option<Owner> {
        match s {
            "user" => Some(Owner::User),
            "model" => Some(Owner::Model),
            _ => None,
        }
    }
}

/// The second lock, described at the top of this file. Fails CLOSED: an origin
/// this build does not recognise is refused rather than treated as a user.
///
/// The asymmetry is deliberate and is the whole point. A human typing into a
/// terminal IS the authorization; asking them to confirm each keystroke would
/// be theatre, and worse, it would train them to click through the dialog that
/// actually matters. A model writing into that same session is a different
/// act: nothing on screen distinguishes bytes the user typed from bytes a
/// model injected, so those bytes must have passed the `shell` gate first, and
/// `gated` is the caller stating under oath that they did.
pub fn authorize_write(session_owner: Owner, origin: Option<Owner>, gated: bool) -> Result<(), String> {
    // Deliberately not consulted, and kept in the signature so that stays a
    // decision rather than an omission. Making the rule depend on who opened
    // the session would mean a model write into a model-owned session skips
    // the gate, and "the model opened this tab itself" is not a reason to let
    // it run commands unreviewed. The rule is about the ORIGIN of the bytes.
    let _ = session_owner;
    match origin {
        None => Err("unknown write origin, refusing".into()),
        Some(Owner::User) => Ok(()),
        Some(Owner::Model) => {
            if gated {
                Ok(())
            } else {
                Err("a model write into a terminal requires the shell permission gate".into())
            }
        }
    }
}

// ---------------------------------------------------------------- pty

/// The master side plus the identity of the process group behind it. The
/// `Child` itself is NOT kept here: it is moved into the reader thread, which
/// is the only place allowed to wait(2) on it. Two threads reaping the same
/// child is how a pid gets reused under you and a signal lands on a stranger.
pub struct Pty {
    pub master: Arc<File>,
    /// Process group id, equal to the child's pid because of setsid(2).
    pub pgid: i32,
    pub child: Child,
}

fn last_err(what: &str) -> String {
    format!("{what}: {}", std::io::Error::last_os_error())
}

/// Open a pty and start `program` on its slave side, in `cwd`.
///
/// Free of Tauri on purpose: the tests below drive it directly, so the parts
/// that can actually break (session leadership, geometry, EOF on child death)
/// are exercised without an app, a window or an event loop.
pub fn open_pty(
    program: &str,
    args: &[&str],
    cwd: &Path,
    cols: u16,
    rows: u16,
    extra_env: &[(&str, &str)],
) -> Result<Pty, String> {
    if !cwd.is_dir() {
        return Err(format!("{}: not a directory", cwd.display()));
    }
    let (cols, rows) = clamp_dims(cols, rows);

    // SAFETY: every call below is a plain libc call on values this function
    // owns. The fds are wrapped in owning types before any early return can
    // lose them, except between posix_openpt and the wrap, which is
    // straight-line code with no fallible call in between.
    unsafe {
        // Darwin's /dev/ptmx clone device fails transiently under concurrency:
        // several opens in the same instant return -1 with an errno that is not
        // even a valid errno (-6 observed), and the very next attempt succeeds.
        // Measured on this machine: two of three parallel test runs hit it,
        // with 17 of the 511 allowed ptys in use, so it is contention on the
        // clone and not exhaustion. A user opening several terminals quickly
        // would meet the same failure, so the retry belongs here and not in
        // the tests.
        let mut master_fd = -1;
        let mut attempt = 0;
        while attempt < PTMX_OPEN_ATTEMPTS {
            master_fd = posix_openpt(O_RDWR | O_NOCTTY);
            if master_fd >= 0 {
                break;
            }
            attempt += 1;
            std::thread::sleep(std::time::Duration::from_millis(4 * attempt as u64));
        }
        if master_fd < 0 {
            return Err(format!(
                "posix_openpt failed {PTMX_OPEN_ATTEMPTS} times: {}",
                std::io::Error::last_os_error()
            ));
        }
        // From here on the fd is owned by `master`, so every `?`-style return
        // closes it instead of leaking it.
        let master = File::from_raw_fd(master_fd);

        // CLOEXEC on the master, immediately, and this is a SECURITY fix, not
        // hygiene. posix_openpt does not set it, and fork/exec only rewires
        // fds 0, 1 and 2: every other open descriptor survives exec. So
        // without this, terminal A's master fd is inherited by terminal B's
        // shell, by every command the agent runs, by every child of any of
        // them. That fd is O_RDWR on the MASTER side, which means such a
        // process can `printf 'whoami\n' >&4` and terminal A's shell executes
        // it, having gone through neither `authorize_write` nor
        // `decideTerminalWrite`, and can read(2) back everything printed in A
        // plus every key the user types there, a sudo password included.
        //
        // The slave handles need no equivalent: std opens them O_CLOEXEC and
        // Stdio::from dups them onto 0/1/2 in the child, where the dup clears
        // the flag exactly for the three that are supposed to survive.
        if fcntl(master_fd, F_SETFD, FD_CLOEXEC) != 0 {
            return Err(last_err("fcntl FD_CLOEXEC on the pty master"));
        }
        if grantpt(master_fd) != 0 {
            return Err(last_err("grantpt"));
        }
        if unlockpt(master_fd) != 0 {
            return Err(last_err("unlockpt"));
        }
        let name_ptr = ptsname(master_fd);
        if name_ptr.is_null() {
            return Err(last_err("ptsname"));
        }
        let slave_name = CStr::from_ptr(name_ptr)
            .to_str()
            .map_err(|_| "ptsname returned a non-UTF-8 path".to_string())?
            .to_string();

        // O_NOCTTY here, deliberately: the PARENT must not acquire this pty as
        // its controlling terminal. Only the child does, and only after
        // setsid(2), inside pre_exec.
        let slave = OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(O_NOCTTY)
            .open(&slave_name)
            .map_err(|e| format!("open {slave_name}: {e}"))?;

        // Trap 1: the slave must exist before the size will take. Doing this
        // any earlier returns ENOTTY and the child silently runs at 80x24.
        let ws = Winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
        if ioctl(master_fd, TIOCSWINSZ, &ws as *const Winsize) != 0 {
            return Err(last_err("TIOCSWINSZ"));
        }

        let stdin = slave.try_clone().map_err(|e| e.to_string())?;
        let stdout = slave.try_clone().map_err(|e| e.to_string())?;
        let stderr = slave;

        let mut cmd = Command::new(program);
        cmd.args(args)
            .current_dir(cwd)
            .stdin(Stdio::from(stdin))
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        for (k, v) in extra_env {
            cmd.env(k, v);
        }

        // pre_exec runs between fork and exec, where only async-signal-safe
        // calls are legal: no allocation, no locks, no Rust machinery. setsid
        // and ioctl qualify. setsid also detaches the child from the app's own
        // controlling terminal, which is what stops a Ctrl-C in the terminal
        // pane from reaching Galactus itself.
        cmd.pre_exec(|| {
            if setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            // fd 0 is the slave at this point; claim it as the controlling tty
            // so job control, SIGINT and SIGWINCH all work in the child.
            if ioctl(0, TIOCSCTTY, 0 as c_int) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });

        let child = cmd.spawn().map_err(|e| format!("spawn {program}: {e}"))?;
        // Trap 2: `Stdio::from(File)` handed ownership of all three slave
        // handles to the spawn, which closed the parent's copies. Nothing in
        // this process holds the slave any more, so the master will report EOF
        // the moment the child and its group are gone. Do not "helpfully" keep
        // a copy around for later resizes: resizes go through the master.
        let pgid = child.id() as i32;
        Ok(Pty { master: Arc::new(master), pgid, child })
    }
}

/// Resize an open pty. The kernel raises SIGWINCH on the foreground process
/// group for us, which is how a running `vim` or `htop` redraws itself.
pub fn resize_pty(master: &File, cols: u16, rows: u16) -> Result<(u16, u16), String> {
    let (cols, rows) = clamp_dims(cols, rows);
    let ws = Winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
    // SAFETY: `master` outlives the call and `ws` is a correctly shaped
    // winsize, which is what TIOCSWINSZ reads.
    let rc = unsafe { ioctl(master.as_raw_fd(), TIOCSWINSZ, &ws as *const Winsize) };
    if rc != 0 {
        return Err(last_err("TIOCSWINSZ"));
    }
    Ok((cols, rows))
}

/// True when the fd has bytes waiting, checked without blocking longer than
/// `timeout_ms`. Used only by the coalescer.
fn readable(fd: RawFd, timeout_ms: c_int) -> bool {
    let mut pfd = PollFd { fd, events: POLLIN, revents: 0 };
    // SAFETY: one correctly initialised pollfd, count 1.
    let rc = unsafe { poll(&mut pfd as *mut PollFd, 1, timeout_ms) };
    rc > 0 && (pfd.revents & POLLIN) != 0
}

/// Signal the whole process group, escalating. SIGHUP is what a terminal
/// closing actually means, and well behaved programs save and exit on it;
/// SIGKILL is for the ones that do not.
/// Put a child in its own session, so it can later be killed as a GROUP.
///
/// Shared with the shell tool, and it is not a convenience there: without it,
/// killing the direct child leaves every grandchild alive holding the write
/// end of the inherited stdout pipe, and the reader thread blocks in read(2)
/// forever. The tool then never returns at all, which is worse than the
/// timeout it was supposed to enforce.
///
/// SAFETY: `pre_exec` runs between fork and exec, where only async-signal-safe
/// calls are allowed. setsid(2) is one of them.
pub fn own_session(cmd: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        cmd.pre_exec(|| {
            if setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

pub fn kill_group(pgid: i32) {
    if pgid <= 1 {
        return; // never signal pid 1 or the whole system (pgid 0 means "my group")
    }
    // SAFETY: killpg on a pid we spawned. A dead group returns ESRCH, ignored.
    unsafe {
        killpg(pgid, SIGHUP);
        killpg(pgid, SIGKILL);
    }
}

/// One chunk of terminal output, or the end of the session.
#[derive(Serialize, Clone, Debug)]
pub struct PtyEvent {
    pub id: String,
    /// Decoded output. Empty on the final event.
    pub data: String,
    /// True on the last event of this session, and only then.
    pub done: bool,
    /// Exit status, when the child produced one. `None` after a signal.
    pub exit_code: Option<i32>,
}

/// Drain a pty master until EOF, handing decoded chunks to `sink`, then reap
/// the child and emit the final event.
///
/// This is the whole lifetime of a session's reader thread, written as a plain
/// function so a test can run it on a real pty with a `Vec` for a sink.
pub fn pump(id: &str, master: Arc<File>, mut child: Child, mut sink: impl FnMut(PtyEvent)) {
    let fd = master.as_raw_fd();
    // Bytes held back from the previous flush because they were the start of
    // a character whose remaining bytes had not arrived yet.
    let mut carry: Vec<u8> = Vec::new();
    let mut buf = [0u8; READ_BUF];
    let mut eof = false;
    while !eof {
        let mut chunk: Vec<u8> = std::mem::take(&mut carry);
        loop {
            // `&File` implements Read, so the Arc is never unwrapped and the
            // fd stays owned by exactly one File for the whole session.
            match (&*master).read(&mut buf) {
                // Slave closed: the child and its group are gone. Fall through
                // to the flush below rather than breaking out of the function,
                // because `chunk` almost always holds the process' last words.
                // Discarding them here is exactly the bug that made `echo hi`
                // print nothing: poll(2) reports EOF as readable, so the
                // coalescer always takes one more read after the final output.
                Ok(0) => {
                    eof = true;
                    break;
                }
                Ok(n) => chunk.extend_from_slice(&buf[..n]),
                Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                // EIO on a pty master is not a failure, it is how Darwin says
                // "the last slave fd closed". Anything else ends the session
                // too: there is no recovery from a broken master.
                Err(_) => {
                    eof = true;
                    break;
                }
            }
            // Coalesce: a burst of small writes becomes one event instead of
            // hundreds. Stop as soon as the pipe goes quiet or the chunk is
            // large enough to be worth painting on its own.
            if chunk.len() >= MAX_CHUNK || !readable(fd, COALESCE_MS) {
                break;
            }
        }
        // Past EOF nothing can complete a truncated sequence, so holding a
        // tail back would lose it forever: emit the lot and let
        // `from_utf8_lossy` mark whatever is broken.
        let cut = if eof { chunk.len() } else { utf8_safe_prefix(&chunk) };
        carry = chunk[cut..].to_vec();
        let text = String::from_utf8_lossy(&chunk[..cut]).into_owned();
        if !text.is_empty() {
            sink(PtyEvent { id: id.into(), data: text, done: false, exit_code: None });
        }
    }
    let code = child.wait().ok().and_then(|s| s.code());
    sink(PtyEvent { id: id.into(), data: String::new(), done: true, exit_code: code });
}

// ---------------------------------------------------------------- registry

struct Session {
    master: Arc<File>,
    pgid: i32,
    owner: Owner,
    cols: u16,
    rows: u16,
}

static SESSIONS: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Ids are minted here, never accepted from the caller. A caller-supplied id
/// lets one terminal pane write into another one by guessing a string, and
/// there is no reason to offer that.
fn mint_id() -> String {
    format!("t{}", NEXT_ID.fetch_add(1, Ordering::SeqCst))
}

/// Live session ids, in no particular order. Exposed for the UI's own
/// bookkeeping and for the tests.
pub fn session_ids() -> Vec<String> {
    match sessions().lock() {
        Ok(map) => map.keys().cloned().collect(),
        Err(_) => Vec::new(),
    }
}

pub fn session_count() -> usize {
    sessions().lock().map(|m| m.len()).unwrap_or(0)
}

/// Remove a session from the registry and return what is needed to kill it.
/// Called both by the reader thread when the child dies on its own and by
/// `pty_kill`; whichever gets there first wins and the other finds nothing,
/// which is exactly the property that stops a double kill.
fn take_session(id: &str) -> Option<Session> {
    sessions().lock().ok().and_then(|mut m| m.remove(id))
}

/// Kill everything. Called from the app's Exit handler: an abandoned shell
/// keeps a pty and a process group alive after the window is gone, and a
/// `npm run dev` under it keeps holding a port.
pub fn kill_all() {
    let taken: Vec<Session> = match sessions().lock() {
        Ok(mut m) => m.drain().map(|(_, s)| s).collect(),
        Err(_) => return,
    };
    for s in taken {
        kill_group(s.pgid);
    }
}

// ---------------------------------------------------------------- commands

#[derive(Serialize)]
pub struct SpawnedSession {
    pub id: String,
    pub cols: u16,
    pub rows: u16,
    pub shell: String,
    pub cwd: String,
    pub owner: Owner,
}

/// The login shell, or zsh. `$SHELL` is what the user actually chose; falling
/// straight to zsh would silently ignore a fish or nushell user's setup.
fn login_shell() -> String {
    match std::env::var("SHELL") {
        Ok(s) if !s.trim().is_empty() && Path::new(&s).is_file() => s,
        _ => "/bin/zsh".to_string(),
    }
}

#[tauri::command]
pub async fn pty_spawn(
    app: tauri::AppHandle,
    cwd: String,
    cols: u16,
    rows: u16,
    owner: String,
) -> Result<SpawnedSession, String> {
    spawn_program(app, cwd, cols, rows, owner, None).await
}

/// Spawn a session running something other than the login shell.
///
/// `program` is NEVER supplied by the webview. The only caller that passes it
/// is the SSH module, which builds the argv itself from a host the user saved
/// and this file validated: an arbitrary command coming across the IPC boundary
/// would turn the terminal into a way to run anything without a permission
/// dialog, which is the one thing the gate on model writes exists to prevent.
pub(crate) async fn spawn_program(
    app: tauri::AppHandle,
    cwd: String,
    cols: u16,
    rows: u16,
    owner: String,
    program: Option<(String, Vec<String>)>,
) -> Result<SpawnedSession, String> {
    use tauri::Emitter;
    let owner = Owner::parse(&owner).ok_or_else(|| "unknown session owner".to_string())?;
    if session_count() >= MAX_SESSIONS {
        return Err(format!("too many terminals open (limit {MAX_SESSIONS})"));
    }
    // Resolve before spawning so the error names the folder the user picked
    // rather than a libc errno from deep inside Command.
    let dir = std::fs::canonicalize(&cwd).map_err(|e| format!("{cwd}: {e}"))?;
    let shell = login_shell();

    // TERM is the contract with every curses program on the machine; without
    // it they fall back to "dumb" and refuse to move the cursor. COLORTERM is
    // how a program learns it may emit 24-bit colour, which this emulator
    // renders. TERM_PROGRAM lets a user's rc file recognise the app.
    let env = [
        ("TERM", "xterm-256color"),
        ("COLORTERM", "truecolor"),
        ("TERM_PROGRAM", "Galactus"),
    ];
    // A login shell so the user's PATH, aliases and version managers are the
    // ones they see in their own terminal. Anything else produces the classic
    // "it works in my terminal but not in the app" report.
    let (exe, args): (String, Vec<String>) = match program {
        Some((p, a)) => (p, a),
        None => (shell.clone(), vec!["-l".to_string()]),
    };
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let pty = open_pty(&exe, &arg_refs, &dir, cols, rows, &env)?;
    let (cols, rows) = clamp_dims(cols, rows);

    let id = mint_id();
    let master = pty.master.clone();
    let pgid = pty.pgid;
    {
        let mut map = sessions().lock().map_err(|_| "terminal registry poisoned".to_string())?;
        map.insert(id.clone(), Session { master: master.clone(), pgid, owner, cols, rows });
    }

    let thread_id = id.clone();
    let child = pty.child;
    std::thread::spawn(move || {
        pump(&thread_id, master, child, |ev| {
            // The registry entry goes away with the child, before the "done"
            // event reaches the UI. A write racing the exit then fails with
            // "unknown terminal session" instead of writing into a fd that is
            // about to close under it.
            if ev.done {
                let _ = take_session(&ev.id);
            }
            let _ = app.emit("galactus://pty", ev);
        });
    });

    Ok(SpawnedSession {
        id,
        cols,
        rows,
        shell,
        cwd: dir.to_string_lossy().into_owned(),
        owner,
    })
}

/// Send bytes to a session's input.
///
/// `origin` and `gated` are the second lock described at the top of this file.
/// They are not optional and an unrecognised origin is refused.
#[tauri::command]
pub async fn pty_write(id: String, data: String, origin: String, gated: bool) -> Result<(), String> {
    let (master, owner) = {
        let map = sessions().lock().map_err(|_| "terminal registry poisoned".to_string())?;
        let s = map.get(&id).ok_or_else(|| "unknown terminal session".to_string())?;
        (s.master.clone(), s.owner)
    };
    authorize_write(owner, Owner::parse(&origin), gated)?;
    // `&File` is Write, so the shared master is written without unwrapping the
    // Arc or taking a lock the reader thread would contend on.
    (&*master).write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    (&*master).flush().map_err(|e| e.to_string())
}

/// Apply a new geometry. Returns the geometry that was really applied, which
/// is the clamped one: the caller must repaint against what happened, not
/// against what it asked for.
#[tauri::command]
pub async fn pty_resize(id: String, cols: u16, rows: u16) -> Result<(u16, u16), String> {
    let mut map = sessions().lock().map_err(|_| "terminal registry poisoned".to_string())?;
    let s = map.get_mut(&id).ok_or_else(|| "unknown terminal session".to_string())?;
    let applied = resize_pty(&s.master, cols, rows)?;
    s.cols = applied.0;
    s.rows = applied.1;
    Ok(applied)
}

/// End a session. Idempotent: killing an id that already died is a no-op, not
/// an error, because the UI's close button and the child's own exit race by
/// design.
#[tauri::command]
pub async fn pty_kill(id: String) -> Result<(), String> {
    if let Some(s) = take_session(&id) {
        kill_group(s.pgid);
    }
    Ok(())
}

#[tauri::command]
pub async fn pty_list() -> Result<Vec<String>, String> {
    Ok(session_ids())
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    fn tmpdir() -> std::path::PathBuf {
        std::env::temp_dir()
    }

    /// Run a command under a real pty and return everything it printed plus
    /// the final event.
    fn run(program: &str, args: &[&str], cols: u16, rows: u16) -> (String, PtyEvent) {
        let pty = open_pty(program, args, &tmpdir(), cols, rows, &[("TERM", "dumb")]).expect("open_pty");
        let (tx, rx) = mpsc::channel();
        let master = pty.master.clone();
        let child = pty.child;
        let h = std::thread::spawn(move || {
            pump("test", master, child, |ev| {
                let _ = tx.send(ev);
            });
        });
        let mut text = String::new();
        let mut last = None;
        while let Ok(ev) = rx.recv() {
            let done = ev.done;
            text.push_str(&ev.data);
            if done {
                last = Some(ev);
                break;
            }
        }
        h.join().expect("reader thread");
        (text, last.expect("a done event"))
    }

    // ---- utf8 framing

    #[test]
    fn utf8_prefix_holds_back_a_split_character() {
        // "é" is C3 A9. A chunk ending on C3 must hold that byte back.
        let buf = b"ab\xC3";
        assert_eq!(utf8_safe_prefix(buf), 2);
        // Once the continuation arrives the whole thing is safe.
        assert_eq!(utf8_safe_prefix(b"ab\xC3\xA9"), 4);
    }

    #[test]
    fn utf8_prefix_holds_back_a_split_four_byte_character() {
        // U+1F600 is F0 9F 98 80.
        assert_eq!(utf8_safe_prefix(b"x\xF0"), 1);
        assert_eq!(utf8_safe_prefix(b"x\xF0\x9F"), 1);
        assert_eq!(utf8_safe_prefix(b"x\xF0\x9F\x98"), 1);
        assert_eq!(utf8_safe_prefix(b"x\xF0\x9F\x98\x80"), 5);
    }

    #[test]
    fn utf8_prefix_never_stalls_on_garbage() {
        // 0xFF can never start a sequence. Holding it back would freeze the
        // terminal until valid UTF-8 happened to arrive.
        assert_eq!(utf8_safe_prefix(b"ok\xFF"), 3);
        // Continuation bytes with no lead in the window: also not held back.
        assert_eq!(utf8_safe_prefix(b"ok\x80\x80\x80"), 5);
        assert_eq!(utf8_safe_prefix(b""), 0);
        assert_eq!(utf8_safe_prefix(b"plain ascii"), 11);
    }

    #[test]
    fn split_multibyte_across_reads_survives_round_trip() {
        // The property the function exists for, stated end to end: feeding a
        // string one byte at a time must reconstruct it exactly.
        let src = "héllo 🎉 ünïcode ✓";
        let bytes = src.as_bytes();
        let mut pending: Vec<u8> = Vec::new();
        let mut out = String::new();
        for b in bytes {
            pending.push(*b);
            let cut = utf8_safe_prefix(&pending);
            out.push_str(&String::from_utf8_lossy(&pending[..cut]));
            pending = pending[cut..].to_vec();
        }
        out.push_str(&String::from_utf8_lossy(&pending));
        assert_eq!(out, src);
    }

    // ---- geometry

    #[test]
    fn dims_are_clamped_at_both_ends() {
        assert_eq!(clamp_dims(0, 0), (MIN_COLS, MIN_ROWS));
        assert_eq!(clamp_dims(1, 0), (MIN_COLS, MIN_ROWS));
        assert_eq!(clamp_dims(80, 24), (80, 24));
        assert_eq!(clamp_dims(u16::MAX, u16::MAX), (MAX_COLS, MAX_ROWS));
        assert_eq!(clamp_dims(MAX_COLS + 1, MAX_ROWS + 1), (MAX_COLS, MAX_ROWS));
    }

    #[test]
    fn the_child_really_sees_the_geometry_we_asked_for() {
        // The regression this pins: sizing the pty before opening the slave
        // fails with ENOTTY and the child silently runs at 80x24.
        let (out, _) = run("/bin/sh", &["-c", "stty size"], 133, 41);
        assert!(out.contains("41 133"), "stty reported {out:?}");
    }

    // ---- descriptor leakage

    #[test]
    fn the_master_fd_is_close_on_exec() {
        // Without FD_CLOEXEC the master survives every fork/exec the app does,
        // and any such child can `printf 'cmd\n' >&N` into a terminal it does
        // not own, executing a command that passed neither authorize_write nor
        // decideTerminalWrite, and read(2) back everything typed there.
        const F_GETFD: c_int = 1;
        let pty = open_pty("/bin/sh", &["-c", "sleep 0.2"], &tmpdir(), 80, 24, &[]).expect("open_pty");
        let flags = unsafe { fcntl(pty.master.as_raw_fd(), F_GETFD) };
        assert!(flags >= 0, "F_GETFD failed");
        assert_ne!(flags & FD_CLOEXEC, 0, "the pty master must be close-on-exec");
        kill_group(pty.pgid);
        let mut child = pty.child;
        let _ = child.wait();
    }

    #[test]
    fn another_process_cannot_inject_into_a_terminal_it_does_not_own() {
        // The end to end form of the test above: a sibling child, spawned the
        // way the app spawns everything else, tries to write a command into a
        // live terminal through the inherited master fd. It must fail.
        let pty = open_pty("/bin/cat", &[], &tmpdir(), 80, 24, &[("TERM", "dumb")]).expect("open_pty");
        let fd = pty.master.as_raw_fd();
        let master = pty.master.clone();
        let child = pty.child;
        let (tx, rx) = mpsc::channel();
        let h = std::thread::spawn(move || {
            pump("cloexec", master, child, |ev| {
                let _ = tx.send(ev);
            });
        });

        let mut intruder = Command::new("/bin/sh")
            .arg("-c")
            .arg(format!("printf 'INJECTED\n' >&{fd} 2>/dev/null; exit 0"))
            .spawn()
            .expect("spawn the intruder");
        let _ = intruder.wait();

        // cat echoes what reaches its input, so an injection would come back.
        std::thread::sleep(Duration::from_millis(250));
        let mut seen = String::new();
        while let Ok(ev) = rx.try_recv() {
            seen.push_str(&ev.data);
        }
        assert!(!seen.contains("INJECTED"), "a sibling process reached the pty: {seen:?}");

        kill_group(pty.pgid);
        let _ = h.join();
    }

    #[test]
    fn an_absurd_geometry_is_clamped_rather_than_refused() {
        let (out, _) = run("/bin/sh", &["-c", "stty size"], 60000, 60000);
        assert!(
            out.contains(&format!("{MAX_ROWS} {MAX_COLS}")),
            "stty reported {out:?}"
        );
    }

    #[test]
    fn resize_reaches_a_running_child() {
        // A long lived child, resized while it runs, must see the new size.
        let pty = open_pty(
            "/bin/sh",
            &["-c", "sleep 0.35; stty size"],
            &tmpdir(),
            80,
            24,
            &[("TERM", "dumb")],
        )
        .expect("open_pty");
        let master = pty.master.clone();
        let child = pty.child;
        let (tx, rx) = mpsc::channel();
        let h = std::thread::spawn(move || {
            pump("resize", master, child, |ev| {
                let _ = tx.send(ev);
            });
        });
        std::thread::sleep(Duration::from_millis(120));
        let applied = resize_pty(&pty.master, 97, 33).expect("resize");
        assert_eq!(applied, (97, 33));
        let mut text = String::new();
        while let Ok(ev) = rx.recv() {
            text.push_str(&ev.data);
            if ev.done {
                break;
            }
        }
        h.join().unwrap();
        assert!(text.contains("33 97"), "stty reported {text:?}");
    }

    // ---- tty semantics

    #[test]
    fn the_child_believes_it_is_on_a_terminal() {
        // The whole reason this module is not a pair of pipes.
        let (out, ev) = run("/bin/sh", &["-c", "test -t 1 && echo ISATTY"], 80, 24);
        assert!(out.contains("ISATTY"), "got {out:?}");
        assert_eq!(ev.exit_code, Some(0));
    }

    #[test]
    fn the_child_is_its_own_session_leader() {
        // setsid in pre_exec. Without it, a Ctrl-C in the pane would be
        // delivered to Galactus' own process group.
        let (out, _) = run("/bin/sh", &["-c", "echo pid=$$; ps -o pgid= -p $$"], 80, 24);
        let pid: i32 = out
            .lines()
            .find_map(|l| l.trim().strip_prefix("pid=").and_then(|v| v.trim().parse().ok()))
            .expect("pid line");
        let pgid: i32 = out
            .lines()
            .filter_map(|l| l.trim().parse::<i32>().ok())
            .find(|v| *v == pid)
            .expect("pgid equal to pid");
        assert_eq!(pid, pgid);
    }

    #[test]
    fn exit_code_is_reported() {
        let (_, ev) = run("/bin/sh", &["-c", "exit 7"], 80, 24);
        assert!(ev.done);
        assert_eq!(ev.exit_code, Some(7));
    }

    #[test]
    fn output_is_decoded_even_when_it_straddles_reads() {
        // 4000 emoji: far more than one read(2) buffer, so the split is real.
        let (out, _) = run(
            "/bin/sh",
            &["-c", "i=0; while [ $i -lt 400 ]; do printf '🎉éàü✓'; i=$((i+1)); done"],
            200,
            50,
        );
        assert_eq!(out.matches('🎉').count(), 400, "emoji lost or duplicated");
        assert!(!out.contains('\u{FFFD}'), "a replacement character appeared");
    }

    // ---- lifetime

    #[test]
    fn a_dead_child_ends_its_reader_thread() {
        // The leak this guards: if the parent kept a slave fd, read(2) would
        // never return and this join would hang forever.
        let pty = open_pty("/bin/sh", &["-c", "echo bye"], &tmpdir(), 80, 24, &[]).expect("open_pty");
        let master = pty.master.clone();
        let child = pty.child;
        let (tx, rx) = mpsc::channel();
        let h = std::thread::spawn(move || {
            pump("dead", master, child, |ev| {
                let _ = tx.send(ev);
            });
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut saw_done = false;
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(ev) => {
                    if ev.done {
                        saw_done = true;
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => break,
            }
        }
        assert!(saw_done, "the reader thread never reported the child's death");
        h.join().expect("the reader thread outlived its child");
    }

    #[test]
    fn killing_the_group_takes_the_grandchildren_with_it() {
        // `Child::kill` would signal the shell only and leave the sleep
        // running. This is why signals go to the process group.
        let pty = open_pty(
            "/bin/sh",
            &["-c", "sleep 60 & echo started; wait"],
            &tmpdir(),
            80,
            24,
            &[],
        )
        .expect("open_pty");
        let master = pty.master.clone();
        let child = pty.child;
        let pgid = pty.pgid;
        let (tx, rx) = mpsc::channel();
        let h = std::thread::spawn(move || {
            pump("group", master, child, |ev| {
                let _ = tx.send(ev);
            });
        });
        // Wait for the shell to have really started the background job.
        let mut started = false;
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && !started {
            if let Ok(ev) = rx.recv_timeout(Duration::from_millis(200)) {
                started = ev.data.contains("started");
            }
        }
        assert!(started, "the child never announced itself");
        kill_group(pgid);
        let mut done = false;
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(ev) => {
                    if ev.done {
                        done = true;
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => break,
            }
        }
        assert!(done, "the group survived SIGKILL");
        h.join().expect("reader thread");
    }

    #[test]
    fn a_missing_working_directory_is_refused_before_spawning() {
        let bad = tmpdir().join("galactus-pty-does-not-exist-1a2b3c");
        // `unwrap_err` would need Pty: Debug, and a pty is not a value worth
        // making printable just for a test.
        let err = match open_pty("/bin/sh", &["-c", "true"], &bad, 80, 24, &[]) {
            Ok(_) => panic!("a missing directory was accepted"),
            Err(e) => e,
        };
        assert!(err.contains("not a directory"), "got {err}");
    }

    #[test]
    fn the_child_starts_in_the_directory_it_was_given() {
        let dir = std::fs::canonicalize(tmpdir()).unwrap();
        let (out, _) = run("/bin/sh", &["-c", "pwd -P"], 80, 24);
        // `run` uses tmpdir(); compare the resolved forms because /tmp is a
        // symlink to /private/tmp on macOS and `pwd -P` prints the target.
        assert!(
            out.trim().contains(dir.to_string_lossy().trim()),
            "pwd printed {out:?}, expected {dir:?}"
        );
    }

    // ---- authorization

    #[test]
    fn a_user_keystroke_needs_no_gate() {
        assert!(authorize_write(Owner::User, Some(Owner::User), false).is_ok());
        assert!(authorize_write(Owner::Model, Some(Owner::User), false).is_ok());
    }

    #[test]
    fn a_model_write_without_the_gate_is_refused() {
        let err = authorize_write(Owner::User, Some(Owner::Model), false).unwrap_err();
        assert!(err.contains("shell permission gate"), "got {err}");
        // Even into a session the model itself opened: the frontend gates that
        // one too, and this layer does not second-guess it.
        assert!(authorize_write(Owner::Model, Some(Owner::Model), false).is_err());
    }

    #[test]
    fn a_gated_model_write_is_allowed() {
        assert!(authorize_write(Owner::User, Some(Owner::Model), true).is_ok());
    }

    #[test]
    fn an_unknown_origin_fails_closed() {
        assert_eq!(Owner::parse("root"), None);
        assert_eq!(Owner::parse(""), None);
        assert_eq!(Owner::parse("User"), None);
        let err = authorize_write(Owner::User, None, true).unwrap_err();
        assert!(err.contains("unknown write origin"), "got {err}");
    }

    // ---- registry

    #[test]
    fn taking_a_session_twice_yields_it_once() {
        // The property that makes pty_kill idempotent and stops the reader
        // thread and the close button from both killing the same group.
        let id = mint_id();
        {
            let pty = open_pty("/bin/sh", &["-c", "sleep 5"], &tmpdir(), 80, 24, &[]).expect("open_pty");
            let mut map = sessions().lock().unwrap();
            map.insert(
                id.clone(),
                Session { master: pty.master.clone(), pgid: pty.pgid, owner: Owner::User, cols: 80, rows: 24 },
            );
            drop(map);
            let first = take_session(&id);
            assert!(first.is_some());
            assert!(take_session(&id).is_none());
            kill_group(pty.pgid);
            let mut child = pty.child;
            let _ = child.wait();
        }
        assert!(!session_ids().contains(&id));
    }

    #[test]
    fn ids_are_unique_and_never_reused() {
        let a = mint_id();
        let b = mint_id();
        let c = mint_id();
        assert_ne!(a, b);
        assert_ne!(b, c);
        assert_ne!(a, c);
    }

    #[test]
    fn kill_all_empties_the_registry() {
        let mut pgids = Vec::new();
        let mut children = Vec::new();
        for _ in 0..3 {
            let pty = open_pty("/bin/sh", &["-c", "sleep 30"], &tmpdir(), 80, 24, &[]).expect("open_pty");
            let id = mint_id();
            pgids.push(pty.pgid);
            sessions().lock().unwrap().insert(
                id,
                Session { master: pty.master.clone(), pgid: pty.pgid, owner: Owner::User, cols: 80, rows: 24 },
            );
            children.push(pty.child);
        }
        assert!(session_count() >= 3);
        kill_all();
        assert_eq!(session_count(), 0);
        for mut c in children {
            let _ = c.wait();
        }
        let _ = pgids;
    }

    #[test]
    fn killing_the_group_frees_a_pipe_a_grandchild_still_holds() {
        // The exact shape that hung the shell tool: zsh backgrounds a child,
        // the deadline kills the direct process, the grandchild keeps the
        // inherited stdout write end, and read_to_end never returns.
        //
        // Reproduced before the fix with a plain kill: the reader stayed
        // blocked and the orphan was still listed by pgrep afterwards.
        use std::io::Read;
        use std::process::{Command, Stdio};

        let mut cmd = Command::new("/bin/zsh");
        cmd.arg("-lc").arg("(sleep 30 &) ; sleep 30");
        own_session(&mut cmd);
        let mut child = cmd.stdout(Stdio::piped()).spawn().expect("spawn");
        let pgid = child.id() as i32;
        let mut out = child.stdout.take().expect("stdout");

        let reader = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = out.read_to_end(&mut buf);
            buf.len()
        });

        std::thread::sleep(std::time::Duration::from_millis(250));
        kill_group(pgid);
        let _ = child.wait();

        // Without the group kill this join never completes and the test hangs
        // instead of failing, which is why the deadline below is the assertion.
        let start = std::time::Instant::now();
        while !reader.is_finished() {
            assert!(
                start.elapsed() < std::time::Duration::from_secs(5),
                "the pipe never closed: a grandchild is still holding it"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        reader.join().expect("reader");
    }

    #[test]
    fn kill_group_refuses_dangerous_group_ids() {
        // pgid 0 means "every process in my own group", which would take
        // Galactus down with it. A defensive guard, exercised so it cannot be
        // deleted as dead code.
        kill_group(0);
        kill_group(1);
        kill_group(-1);
        // Returning at all IS the assertion: had the guard let any of those
        // three through, this process would have taken SIGKILL and there would
        // be no verdict to report. So there is deliberately no assert! here;
        // an `assert!(true)` would only look like one.
    }
}
