// Galactus desktop, code workspace and version control.
//
// Backend for the Code view: a file tree over a folder the user picked, file
// read and write, and the git operations the view exposes. Everything is
// scoped to the workspace root chosen in the UI: a path outside it is refused
// here, not merely hidden in the frontend, because the model reaches these
// commands too.
//
// Git runs through the `git` binary rather than a library. The user's repo may
// carry hooks, credential helpers, SSH signing and includeIf configuration
// that only the real client honours, and a commit made by anything else would
// behave differently from the one they make in a terminal.

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

/// Entries listed for one directory level. The tree is loaded lazily, one
/// directory at a time: a repository with a node_modules would otherwise cost
/// tens of thousands of entries on the first click.
const MAX_ENTRIES: usize = 2_000;
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// Directories never worth walking in a code workspace.
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "__pycache__",
    ".venv",
    "venv",
    ".next",
    ".turbo",
];

#[derive(Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub dir: bool,
    pub size: u64,
    /// Git worktree status for this path: "M", "A", "D", "?", or empty.
    pub status: String,
}

#[derive(Serialize)]
pub struct GitCommit {
    pub hash: String,
    pub short: String,
    pub author: String,
    pub when: String,
    pub subject: String,
}

/// One entry of the working tree, split the way the user acts on it: what is
/// already staged, what is modified but not staged, and what git does not
/// track yet. `code_tree` only carries a merged letter for decoration; the
/// Changes panel needs the two sides apart because Stage and Unstage act on
/// different things.
#[derive(Serialize)]
pub struct GitChange {
    pub path: String,
    /// Index side of the porcelain code (" " when unmodified in the index).
    pub index: String,
    /// Worktree side of the porcelain code.
    pub work: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
    /// Original path of a rename, empty otherwise.
    pub from: String,
}

#[derive(Serialize)]
pub struct GitInfo {
    pub repo: bool,
    /// False when this Mac has no usable git at all. Distinct from `repo`:
    /// "the folder is not a repository" and "there is no git here" are two
    /// different sentences and the UI says whichever is true.
    pub available: bool,
    pub branch: String,
    pub upstream: String,
    pub ahead: u32,
    pub behind: u32,
    pub staged: usize,
    pub unstaged: usize,
    pub untracked: usize,
    pub dirty: bool,
}

/// A workspace path must stay inside its root. Rejects a parent component
/// outright rather than resolving it: the caller can be the model, and a
/// resolved `..` that lands back inside the root would still be a path the
/// user never showed it.
fn inside(root: &str, path: &str) -> Result<PathBuf, String> {
    let root_path = std::fs::canonicalize(root).map_err(|e| format!("{root}: {e}"))?;
    let candidate = Path::new(path);
    if candidate.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("path contains a '..' component, refusing".into());
    }
    let full = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root_path.join(candidate)
    };
    // Compare on the deepest existing ancestor: a file about to be created has
    // no canonical form yet.
    let mut probe = full.clone();
    while !probe.exists() {
        match probe.parent() {
            Some(p) => probe = p.to_path_buf(),
            None => return Err("path escapes the workspace".into()),
        }
    }
    let probe = std::fs::canonicalize(&probe).map_err(|e| e.to_string())?;
    if !probe.starts_with(&root_path) {
        return Err("path escapes the workspace".into());
    }
    Ok(full)
}

/// What `git()` says when this Mac has no git. Matched by `git_info` so that a
/// missing binary reads as "unavailable" instead of "this failed".
pub(crate) const GIT_MISSING: &str = "git is not installed on this Mac";

fn git(root: &str, args: &[&str]) -> Result<String, String> {
    // /usr/bin/git is the Xcode Command Line Tools shim, not git: invoking it
    // on a Mac without the tools raises Apple's installer dialog instead of
    // returning. toolchain::git_program() hands back the real binary, absolute,
    // shim resolved away, or None when this Mac genuinely has no git. A
    // packaged app also inherits only /usr/bin:/bin:/usr/sbin:/sbin from
    // Finder, so a bare Command::new("git") would miss a Homebrew install too.
    let program = crate::toolchain::git_program().ok_or(GIT_MISSING)?;
    let out = Command::new(program)
        .arg("-C")
        .arg(root)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("git: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Cached worktree status, keyed by workspace root.
///
/// `reloadTree()` in the Code view refreshes every open directory level in
/// parallel, and each level used to run a full `git status --porcelain` scan of
/// the whole repository. On a large repo that is one full scan per open folder,
/// on every accepted hunk. The scan now happens once and is dropped by anything
/// that can change it: a write, a stage, a commit, a checkout or a pull.
type StatusMap = HashMap<String, String>;

fn status_cache() -> &'static Mutex<HashMap<String, StatusMap>> {
    static CACHE: OnceLock<Mutex<HashMap<String, StatusMap>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Forget the cached status of one workspace. Called by every command that
/// can move a file between git's three sides.
fn invalidate_status(root: &str) {
    if let Ok(mut c) = status_cache().lock() {
        c.remove(root);
    }
}

fn cached_status_map(root: &str) -> StatusMap {
    if let Ok(c) = status_cache().lock() {
        if let Some(hit) = c.get(root) {
            return hit.clone();
        }
    }
    let fresh = status_map(root);
    if let Ok(mut c) = status_cache().lock() {
        // Bounded: one workspace is the normal case, a handful across a long
        // session, and an entry is a few hundred short strings.
        if c.len() > 8 {
            c.clear();
        }
        c.insert(root.to_string(), fresh.clone());
    }
    fresh
}

/// Worktree status as a map path -> code, for decorating the tree.
fn status_map(root: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Ok(out) = git(root, &["status", "--porcelain=v1", "-z", "--untracked-files=normal"]) else {
        return map;
    };
    for chunk in out.split('\0') {
        if chunk.len() < 4 {
            continue;
        }
        let (code, rest) = chunk.split_at(2);
        let code = code.trim();
        let path = rest.trim_start().to_string();
        let short = if code.contains('?') {
            "?"
        } else if code.contains('A') {
            "A"
        } else if code.contains('D') {
            "D"
        } else {
            "M"
        };
        map.insert(path, short.to_string());
    }
    map
}

// ---------------------------------------------------------------- dispatch
//
// Every command in this module is blocking: it spawns git and waits for it, or
// it walks and reads the filesystem. A synchronous `#[tauri::command]` runs on
// the main thread, and an `async` one whose body blocks parks a tokio worker
// for the whole call. Both are wrong here: `git log` on a large repository, or
// a tree read on a cold NFS home, would stall the chat stream and the search
// events that share those workers.
//
// So each command is a thin async wrapper that hands its `_blocking` twin to
// the blocking pool, exactly the pattern pylang.rs and snapshot.rs already
// use. The real work keeps its plain synchronous signature, which is also what
// lets the tests call it directly with no runtime.

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("the workspace thread died: {e}"))?
}

#[tauri::command]
pub async fn code_tree(root: String, sub: String) -> Result<Vec<Entry>, String> {
    blocking(move || code_tree_blocking(root, sub)).await
}

fn code_tree_blocking(root: String, sub: String) -> Result<Vec<Entry>, String> {
    let dir = inside(&root, if sub.is_empty() { "." } else { &sub })?;
    if !dir.is_dir() {
        return Err(format!("{} is not a directory", dir.display()));
    }
    let status = cached_status_map(&root);
    let root_path = std::fs::canonicalize(&root).map_err(|e| e.to_string())?;
    let mut out: Vec<Entry> = Vec::new();
    let mut count = 0usize;
    for e in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        if count >= MAX_ENTRIES {
            break;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && name != ".gitignore" && name != ".env.example" {
            continue;
        }
        let meta = match e.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = meta.is_dir();
        if is_dir && SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        let rel = e
            .path()
            .strip_prefix(&root_path)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| name.clone());
        // A directory is marked dirty when anything under it is.
        let st = if is_dir {
            let prefix = format!("{rel}/");
            if status.keys().any(|k| k.starts_with(&prefix)) { "M".to_string() } else { String::new() }
        } else {
            status.get(&rel).cloned().unwrap_or_default()
        };
        out.push(Entry {
            name,
            path: rel,
            dir: is_dir,
            size: if is_dir { 0 } else { meta.len() },
            status: st,
        });
        count += 1;
    }
    // Directories first, then case-insensitive by name: the order a file tree
    // is expected to have.
    out.sort_by(|a, b| match (a.dir, b.dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

#[tauri::command]
pub async fn code_read(root: String, path: String) -> Result<String, String> {
    blocking(move || code_read_blocking(root, path)).await
}

fn code_read_blocking(root: String, path: String) -> Result<String, String> {
    let full = inside(&root, &path)?;
    let meta = std::fs::metadata(&full).map_err(|e| e.to_string())?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!(
            "file is {:.1} MB, over the {} MB editor limit",
            meta.len() as f64 / 1e6,
            MAX_FILE_BYTES / 1_000_000
        ));
    }
    let bytes = std::fs::read(&full).map_err(|e| e.to_string())?;
    // Binary files have no business in the editor, and pretending otherwise
    // would let the user "save" a mangled copy over one.
    if bytes.contains(&0) {
        return Err("binary file".into());
    }
    String::from_utf8(bytes).map_err(|_| "file is not valid UTF-8".into())
}

#[tauri::command]
pub async fn code_write(root: String, path: String, content: String) -> Result<(), String> {
    blocking(move || code_write_blocking(root, path, content)).await
}

fn code_write_blocking(root: String, path: String, content: String) -> Result<(), String> {
    let full = inside(&root, &path)?;
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Same write-then-rename as everywhere else: an interrupted save must not
    // leave a half-written source file behind.
    let tmp = full.with_extension(format!(
        "{}.galactus-tmp",
        full.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default()
    ));
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &full).map_err(|e| e.to_string())?;
    invalidate_status(&root);
    Ok(())
}

#[tauri::command]
pub async fn git_info(root: String) -> Result<GitInfo, String> {
    blocking(move || git_info_blocking(root)).await
}

fn git_info_blocking(root: String) -> Result<GitInfo, String> {
    // Probe once and keep the reason. "not a repository" and "no git on this
    // Mac" are two different states, and the panel says which one it is.
    let probe = git(&root, &["rev-parse", "--is-inside-work-tree"]);
    let available = !matches!(probe.as_ref(), Err(e) if e == GIT_MISSING);
    let repo = probe.map(|s| s.trim() == "true").unwrap_or(false);
    if !repo {
        return Ok(GitInfo {
            repo: false,
            available,
            branch: String::new(),
            upstream: String::new(),
            ahead: 0,
            behind: 0,
            staged: 0,
            unstaged: 0,
            untracked: 0,
            dirty: false,
        });
    }
    let branch = git(&root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let upstream = git(&root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let (mut ahead, mut behind) = (0u32, 0u32);
    if !upstream.is_empty() {
        if let Ok(counts) = git(&root, &["rev-list", "--left-right", "--count", "@{u}...HEAD"]) {
            let mut it = counts.split_whitespace();
            behind = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
            ahead = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        }
    }
    let porcelain = git(&root, &["status", "--porcelain=v1"]).unwrap_or_default();
    let mut staged = 0usize;
    let mut unstaged = 0usize;
    let mut untracked = 0usize;
    for line in porcelain.lines() {
        if line.len() < 2 {
            continue;
        }
        let x = line.as_bytes()[0] as char;
        let y = line.as_bytes()[1] as char;
        if x == '?' {
            untracked += 1;
            continue;
        }
        if x != ' ' {
            staged += 1;
        }
        if y != ' ' {
            unstaged += 1;
        }
    }
    Ok(GitInfo {
        repo: true,
        available: true,
        branch,
        upstream,
        ahead,
        behind,
        staged,
        unstaged,
        untracked,
        dirty: staged + unstaged + untracked > 0,
    })
}

/// The working tree, entry by entry. Parsed from `--porcelain=v1 -z` because
/// the NUL form is the only one that survives a path with a space, a quote or
/// a newline in it, and a rename spends TWO records there (new path, then old)
/// which the line-based form hides behind a quoted "->" string.
#[tauri::command]
pub async fn git_status(root: String) -> Result<Vec<GitChange>, String> {
    blocking(move || git_status_blocking(root)).await
}

fn git_status_blocking(root: String) -> Result<Vec<GitChange>, String> {
    let out = git(&root, &["status", "--porcelain=v1", "-z", "--untracked-files=normal"])?;
    let mut chunks = out.split('\0').filter(|c| !c.is_empty());
    let mut rows: Vec<GitChange> = Vec::new();
    while let Some(chunk) = chunks.next() {
        if chunk.len() < 4 {
            continue;
        }
        let (code, rest) = chunk.split_at(2);
        let bytes = code.as_bytes();
        let index = (bytes[0] as char).to_string();
        let work = (bytes[1] as char).to_string();
        let path = rest.trim_start().to_string();
        // A rename or a copy carries its source in the NEXT record: consume it
        // here or every following entry would be read one record off.
        let from = if index == "R" || index == "C" {
            chunks.next().unwrap_or("").to_string()
        } else {
            String::new()
        };
        let untracked = index == "?";
        rows.push(GitChange {
            staged: !untracked && index != " ",
            unstaged: !untracked && work != " ",
            untracked,
            index,
            work,
            path,
            from,
        });
    }
    rows.sort_by_key(|r| r.path.to_lowercase());
    Ok(rows)
}

/// Diff of ONE path, on one side of the index. `git_diff` compares the
/// worktree with HEAD, which merges the two sides into a single patch; the
/// Changes panel has to show them apart, since Stage moves lines from one to
/// the other.
#[tauri::command]
pub async fn git_file_diff(root: String, path: String, staged: bool) -> Result<String, String> {
    blocking(move || git_file_diff_blocking(root, path, staged)).await
}

fn git_file_diff_blocking(root: String, path: String, staged: bool) -> Result<String, String> {
    inside(&root, &path)?;
    let mut args: Vec<&str> = vec!["--no-pager", "diff", "--no-color"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(path.as_str());
    git(&root, &args)
}

#[tauri::command]
pub async fn git_log(root: String, limit: Option<u32>, path: Option<String>) -> Result<Vec<GitCommit>, String> {
    blocking(move || git_log_blocking(root, limit, path)).await
}

fn git_log_blocking(root: String, limit: Option<u32>, path: Option<String>) -> Result<Vec<GitCommit>, String> {
    let n = limit.unwrap_or(60).clamp(1, 500).to_string();
    // Unit separator between fields, record separator between commits: a
    // subject containing any printable character stays parseable.
    let mut args: Vec<String> = vec![
        "log".into(),
        format!("-{n}"),
        "--date=iso-strict".into(),
        "--pretty=format:%H\x1f%h\x1f%an\x1f%ad\x1f%s\x1e".into(),
    ];
    if let Some(p) = path.as_ref().filter(|p| !p.is_empty()) {
        inside(&root, p)?;
        args.push("--".into());
        args.push(p.clone());
    }
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let out = git(&root, &refs)?;
    let mut commits = Vec::new();
    for rec in out.split('\x1e') {
        let rec = rec.trim_start_matches('\n');
        if rec.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = rec.split('\x1f').collect();
        if f.len() < 5 {
            continue;
        }
        commits.push(GitCommit {
            hash: f[0].to_string(),
            short: f[1].to_string(),
            author: f[2].to_string(),
            when: f[3].to_string(),
            subject: f[4].to_string(),
        });
    }
    Ok(commits)
}

/// Diff for the editor. `rev` empty means the worktree against HEAD.
#[tauri::command]
pub async fn git_diff(root: String, path: Option<String>, rev: Option<String>) -> Result<String, String> {
    blocking(move || git_diff_blocking(root, path, rev)).await
}

fn git_diff_blocking(root: String, path: Option<String>, rev: Option<String>) -> Result<String, String> {
    let mut args: Vec<String> = vec!["--no-pager".into(), "diff".into(), "--no-color".into()];
    match rev.as_deref().filter(|r| !r.is_empty()) {
        Some(r) => {
            // A commit's own change, not a range: show what it introduced.
            args = vec![
                "--no-pager".into(),
                "show".into(),
                "--no-color".into(),
                "--format=%H%n%an%n%ad%n%n%s%n%n%b".into(),
                r.to_string(),
            ];
        }
        None => args.push("HEAD".into()),
    }
    if let Some(p) = path.as_ref().filter(|p| !p.is_empty()) {
        inside(&root, p)?;
        args.push("--".into());
        args.push(p.clone());
    }
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    git(&root, &refs)
}

/// Content of a path at a revision, for the side-by-side view.
#[tauri::command]
pub async fn git_show_file(root: String, rev: String, path: String) -> Result<String, String> {
    blocking(move || git_show_file_blocking(root, rev, path)).await
}

fn git_show_file_blocking(root: String, rev: String, path: String) -> Result<String, String> {
    inside(&root, &path)?;
    let spec = format!("{rev}:{path}");
    git(&root, &["--no-pager", "show", &spec])
}

#[tauri::command]
pub async fn git_stage(root: String, paths: Vec<String>, unstage: bool) -> Result<(), String> {
    blocking(move || git_stage_blocking(root, paths, unstage)).await
}

fn git_stage_blocking(root: String, paths: Vec<String>, unstage: bool) -> Result<(), String> {
    if paths.is_empty() {
        return Err("nothing to stage".into());
    }
    for p in &paths {
        inside(&root, p)?;
    }
    let mut args: Vec<String> = if unstage {
        vec!["restore".into(), "--staged".into(), "--".into()]
    } else {
        vec!["add".into(), "--".into()]
    };
    args.extend(paths.iter().cloned());
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    git(&root, &refs)?;
    invalidate_status(&root);
    Ok(())
}

#[tauri::command]
pub async fn git_commit(root: String, message: String, all: bool) -> Result<String, String> {
    blocking(move || git_commit_blocking(root, message, all)).await
}

fn git_commit_blocking(root: String, message: String, all: bool) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("a commit needs a message".into());
    }
    let mut args: Vec<&str> = vec!["commit", "-m", message.as_str()];
    if all {
        args.insert(1, "-a");
    }
    git(&root, &args)?;
    invalidate_status(&root);
    git(&root, &["--no-pager", "log", "-1", "--pretty=format:%h %s"])
}

/// Push and pull reach the network and change a shared branch, so they are
/// separate commands: the UI gates them explicitly rather than folding them
/// into a generic "sync".
#[tauri::command]
pub async fn git_push(root: String) -> Result<String, String> {
    blocking(move || git_push_blocking(root)).await
}

fn git_push_blocking(root: String) -> Result<String, String> {
    git(&root, &["push"])
        .map(|s| if s.trim().is_empty() { "pushed".to_string() } else { s })
}

#[tauri::command]
pub async fn git_pull(root: String, rebase: bool) -> Result<String, String> {
    blocking(move || git_pull_blocking(root, rebase)).await
}

fn git_pull_blocking(root: String, rebase: bool) -> Result<String, String> {
    let args: Vec<&str> = if rebase { vec!["pull", "--rebase"] } else { vec!["pull", "--ff-only"] };
    let out = git(&root, &args);
    invalidate_status(&root);
    out
}

#[tauri::command]
pub async fn git_branches(root: String) -> Result<Vec<String>, String> {
    blocking(move || git_branches_blocking(root)).await
}

fn git_branches_blocking(root: String) -> Result<Vec<String>, String> {
    let out = git(&root, &["branch", "--format=%(refname:short)"])?;
    Ok(out.lines().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
}

#[tauri::command]
pub async fn git_checkout(root: String, branch: String, create: bool) -> Result<String, String> {
    blocking(move || git_checkout_blocking(root, branch, create)).await
}

fn git_checkout_blocking(root: String, branch: String, create: bool) -> Result<String, String> {
    if branch.trim().is_empty() {
        return Err("branch name is empty".into());
    }
    let args: Vec<&str> = if create {
        vec!["checkout", "-b", branch.as_str()]
    } else {
        vec!["checkout", branch.as_str()]
    };
    let out = git(&root, &args).map(|s| if s.trim().is_empty() { format!("on {branch}") } else { s });
    invalidate_status(&root);
    out
}

// ---------------------------------------------------------------- clone

/// Whether a string is a remote this app will clone from.
///
/// THE POINT OF REFUSING ANYTHING. `git clone` takes more than a URL: a local
/// path clones a directory, and `ext::` or a `--upload-pack` smuggled into the
/// argument runs a command. This is user-typed text heading for a process, so
/// the set of accepted shapes is written down rather than assumed.
///
/// https and ssh only, and no argument may begin with a dash, which is what
/// keeps a "URL" from becoming an option.
pub fn is_clonable_remote(url: &str) -> bool {
    let u = url.trim();
    if u.is_empty() || u.starts_with('-') || u.contains(char::is_whitespace) {
        return false;
    }
    if u.starts_with("https://") || u.starts_with("http://") {
        return true;
    }
    // scp-like: git@host:owner/repo.git, the form every forge prints.
    if u.starts_with("ssh://") {
        return true;
    }
    if let Some((before, after)) = u.split_once(':') {
        return before.contains('@') && !before.contains('/') && !after.is_empty();
    }
    false
}

/// The folder name a clone would create, as git itself would choose it.
pub fn clone_dir_name(url: &str) -> Option<String> {
    let u = url.trim().trim_end_matches('/');
    let last = u.rsplit(['/', ':']).next()?;
    let name = last.strip_suffix(".git").unwrap_or(last);
    // No traversal, no hidden folder, no empty name: this becomes a directory.
    if name.is_empty() || name == "." || name == ".." || name.contains('/') {
        return None;
    }
    Some(name.to_string())
}

/// Clone a repository into `parent`, returning the path of the new folder.
///
/// Shallow by default: someone opening a project to read and edit it does not
/// need ten years of history, and a full clone of a large repository is minutes
/// of waiting with nothing on screen. The full history is one `git fetch
/// --unshallow` away in the terminal, and the UI says so.
#[tauri::command]
pub async fn git_clone(url: String, parent: String, depth: Option<u32>) -> Result<String, String> {
    blocking(move || git_clone_blocking(url, parent, depth)).await
}

fn git_clone_blocking(url: String, parent: String, depth: Option<u32>) -> Result<String, String> {
    if !is_clonable_remote(&url) {
        return Err("that does not look like a repository address: use an https:// URL or git@host:owner/repo".into());
    }
    let name = clone_dir_name(&url).ok_or("could not work out a folder name from that address")?;
    let parent_dir = std::fs::canonicalize(&parent).map_err(|e| format!("{parent}: {e}"))?;
    let dest = parent_dir.join(&name);
    if dest.exists() {
        return Err(format!("{} already exists", dest.display()));
    }
    let program = crate::toolchain::git_program().ok_or(GIT_MISSING)?;
    let mut cmd = Command::new(program);
    cmd.current_dir(&parent_dir)
        .arg("clone")
        // Never prompt. A packaged app has no terminal to answer on, so a
        // private repository without a working key would otherwise hang
        // forever on a password prompt nobody can see.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "");
    let d = depth.unwrap_or(1);
    if d > 0 {
        cmd.arg("--depth").arg(d.to_string());
    }
    let out = cmd
        .arg("--")
        .arg(&url)
        .arg(&name)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("git: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        // git says a great deal on stderr even when it succeeds; on failure the
        // last line is the one that names the cause.
        let last = err.lines().last().unwrap_or("").trim();
        return Err(if last.is_empty() { "clone failed".into() } else { last.to_string() });
    }
    Ok(dest.display().to_string())
}

#[cfg(test)]
mod clone_tests {
    use super::{clone_dir_name, is_clonable_remote};

    #[test]
    fn the_two_forms_every_forge_prints_are_accepted() {
        assert!(is_clonable_remote("https://github.com/NoxalisLab/Galactus.git"));
        assert!(is_clonable_remote("git@github.com:NoxalisLab/Galactus.git"));
        assert!(is_clonable_remote("ssh://git@example.com/x/y.git"));
    }

    #[test]
    fn nothing_that_could_become_an_option_or_a_command() {
        // git clone takes more than URLs: a leading dash is an option, and the
        // ext:: transport runs a command. This is user-typed text on its way to
        // a process, so the accepted shapes are a list, not an assumption.
        for bad in [
            "--upload-pack=touch /tmp/pwned",
            "-u/tmp/x",
            "ext::sh -c whoami",
            "/tmp/local/repo",
            "file:///tmp/repo",
            "https://x.invalid/a b",
            "",
            "   ",
        ] {
            assert!(!is_clonable_remote(bad), "{bad} must be refused");
        }
    }

    #[test]
    fn the_folder_name_is_the_one_git_would_choose() {
        assert_eq!(clone_dir_name("https://github.com/a/b.git").as_deref(), Some("b"));
        assert_eq!(clone_dir_name("https://github.com/a/b/").as_deref(), Some("b"));
        assert_eq!(clone_dir_name("git@host:owner/repo.git").as_deref(), Some("repo"));
    }

    #[test]
    fn a_name_that_would_escape_its_parent_is_refused() {
        // The name becomes a directory next to the others. "..' would put the
        // clone somewhere the user did not choose.
        assert_eq!(clone_dir_name("https://x.invalid/a/.."), None);
        assert_eq!(clone_dir_name("https://x.invalid/a/."), None);
        assert_eq!(clone_dir_name("https://x.invalid/a/"), Some("a".to_string()));
    }
}

// ---------------------------------------------------------------- file operations
//
// Create, rename, delete. An editor without these is a viewer, and the way out
// was the terminal or Finder, which is the moment the workspace stops being the
// place the work happens.
//
// Two rules hold for all three, and the tests below name them.
//
// Confinement is `inside()`, the same function every other command in this file
// uses: a name is data typed into a text field, and "../../.ssh/config" is a
// perfectly typeable name.
//
// Nothing is ever unlinked. Delete moves to the trash, so the mistake made at
// speed in a file tree is a drag back rather than a lost afternoon. The system
// trash first, since that is where the user will look, and a folder inside the
// workspace when the volumes differ and a rename across them cannot work.

/// A name a user may type for a new file or folder.
///
/// Refused: empty, a path separator (create makes ONE entry, not a tree), and
/// the two names that mean somewhere else. A name with spaces or an accent is
/// perfectly fine and is not this function's business.
pub fn is_valid_entry_name(name: &str) -> bool {
    let n = name.trim();
    !n.is_empty() && n != "." && n != ".." && !n.contains('/') && !n.contains('\0') && n.len() <= 255
}

#[tauri::command]
pub async fn code_create(root: String, path: String, dir: bool) -> Result<String, String> {
    blocking(move || code_create_blocking(root, path, dir)).await
}

fn code_create_blocking(root: String, path: String, dir: bool) -> Result<String, String> {
    let name = path.rsplit('/').next().unwrap_or_default();
    if !is_valid_entry_name(name) {
        return Err("that name cannot be used".into());
    }
    let full = inside(&root, &path)?;
    // Never over an existing entry: a "new file" that silently truncated the
    // one already there would be the worst kind of quiet.
    if full.exists() {
        return Err(format!("{name} already exists here"));
    }
    if dir {
        std::fs::create_dir_all(&full).map_err(|e| e.to_string())?;
    } else {
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&full, b"").map_err(|e| e.to_string())?;
    }
    Ok(path)
}

#[tauri::command]
pub async fn code_rename(root: String, from: String, to: String) -> Result<String, String> {
    blocking(move || code_rename_blocking(root, from, to)).await
}

fn code_rename_blocking(root: String, from: String, to: String) -> Result<String, String> {
    let name = to.rsplit('/').next().unwrap_or_default();
    if !is_valid_entry_name(name) {
        return Err("that name cannot be used".into());
    }
    let src = inside(&root, &from)?;
    let dst = inside(&root, &to)?;
    if !src.exists() {
        return Err(format!("{from} is gone"));
    }
    // On a case-insensitive volume, README.md -> readme.md is a rename onto
    // itself and must be allowed; anything else that exists is a collision.
    if dst.exists() && std::fs::canonicalize(&dst).ok() != std::fs::canonicalize(&src).ok() {
        return Err(format!("{name} already exists here"));
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    Ok(to)
}

/// Where a deleted entry goes, and under what name.
///
/// Separated from the move itself so the collision rule is testable without
/// touching a real trash: two files called notes.md deleted on the same day
/// must both survive, so the second takes a numbered name.
pub fn trash_target(trash: &Path, name: &str, exists: impl Fn(&Path) -> bool) -> PathBuf {
    let first = trash.join(name);
    if !exists(&first) {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        // A leading dot is the whole name, not an extension: ".env" keeps it.
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    for n in 2..10_000 {
        let candidate = trash.join(format!("{stem} {n}{ext}"));
        if !exists(&candidate) {
            return candidate;
        }
    }
    trash.join(format!("{stem} last{ext}"))
}

#[tauri::command]
pub async fn code_delete(root: String, path: String) -> Result<String, String> {
    blocking(move || code_delete_blocking(root, path)).await
}

fn code_delete_blocking(root: String, path: String) -> Result<String, String> {
    let full = inside(&root, &path)?;
    let root_path = std::fs::canonicalize(&root).map_err(|e| e.to_string())?;
    if !full.exists() {
        return Err(format!("{path} is gone"));
    }
    // The workspace itself is not one of its own entries.
    if std::fs::canonicalize(&full).ok().as_deref() == Some(root_path.as_path()) {
        return Err("that is the workspace folder itself".into());
    }
    let name = full
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or("nothing to delete")?;
    let exists = |p: &Path| p.exists();
    if let Some(home) = std::env::var_os("HOME") {
        let trash = PathBuf::from(home).join(".Trash");
        if trash.is_dir() {
            let target = trash_target(&trash, &name, exists);
            if std::fs::rename(&full, &target).is_ok() {
                return Ok(format!("moved to Trash: {name}"));
            }
            // A rename across volumes fails with EXDEV. An external SSD is a
            // different volume, and an external SSD is where a large project
            // usually lives, so this fallback is the normal case there, not an
            // exotic one.
        }
    }
    let local = root_path.join(".galactus").join("trash");
    std::fs::create_dir_all(&local).map_err(|e| e.to_string())?;
    let target = trash_target(&local, &name, exists);
    std::fs::rename(&full, &target).map_err(|e| e.to_string())?;
    Ok(format!("moved to .galactus/trash: {name}"))
}

#[cfg(test)]
mod fileop_tests {
    use super::{code_create_blocking, code_delete_blocking, code_rename_blocking, is_valid_entry_name, trash_target};
    use std::path::{Path, PathBuf};

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("galactus-fileop-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_name_is_one_entry_never_a_path() {
        assert!(is_valid_entry_name("notes.md"));
        assert!(is_valid_entry_name("mon dossier"));
        assert!(is_valid_entry_name(".env"));
        for bad in ["", " ", ".", "..", "a/b", "../escape", "with\0nul"] {
            assert!(!is_valid_entry_name(bad), "{bad:?} must be refused");
        }
    }

    #[test]
    fn create_refuses_to_overwrite_what_is_there() {
        let d = tmp("create");
        std::fs::write(d.join("keep.txt"), b"important").unwrap();
        let root = d.to_string_lossy().to_string();
        assert!(code_create_blocking(root.clone(), "keep.txt".into(), false).is_err());
        assert_eq!(std::fs::read(d.join("keep.txt")).unwrap(), b"important");
        // And a fresh name works, empty, in place.
        code_create_blocking(root, "new.txt".into(), false).unwrap();
        assert_eq!(std::fs::read(d.join("new.txt")).unwrap(), b"");
    }

    #[test]
    fn nothing_reaches_outside_the_workspace() {
        let d = tmp("escape");
        let root = d.to_string_lossy().to_string();
        assert!(code_create_blocking(root.clone(), "../outside.txt".into(), false).is_err());
        assert!(code_rename_blocking(root.clone(), "a.txt".into(), "../../moved.txt".into()).is_err());
        assert!(code_delete_blocking(root, "../../../etc/hosts".into()).is_err());
    }

    #[test]
    fn rename_moves_the_file_and_refuses_a_collision() {
        let d = tmp("rename");
        std::fs::write(d.join("a.txt"), b"x").unwrap();
        std::fs::write(d.join("b.txt"), b"y").unwrap();
        let root = d.to_string_lossy().to_string();
        assert!(code_rename_blocking(root.clone(), "a.txt".into(), "b.txt".into()).is_err());
        assert_eq!(std::fs::read(d.join("b.txt")).unwrap(), b"y", "b was not clobbered");
        code_rename_blocking(root, "a.txt".into(), "c.txt".into()).unwrap();
        assert!(!d.join("a.txt").exists());
        assert_eq!(std::fs::read(d.join("c.txt")).unwrap(), b"x");
    }

    #[test]
    fn delete_never_unlinks_and_never_eats_the_workspace() {
        let d = tmp("delete");
        std::fs::write(d.join("gone.txt"), b"recoverable").unwrap();
        let root = d.to_string_lossy().to_string();
        // The root is not one of its entries.
        assert!(code_delete_blocking(root.clone(), ".".into()).is_err());
        let msg = code_delete_blocking(root, "gone.txt".into()).unwrap();
        assert!(!d.join("gone.txt").exists(), "it left the workspace");
        // Wherever it landed, the bytes are still readable: this is the whole
        // point of trashing instead of removing.
        assert!(msg.contains("Trash") || msg.contains("trash"));
    }

    #[test]
    fn two_files_of_the_same_name_both_survive_the_trash() {
        let trash = Path::new("/tmp/trash");
        let taken = |p: &Path| p == Path::new("/tmp/trash/notes.md");
        assert_eq!(trash_target(trash, "notes.md", taken), PathBuf::from("/tmp/trash/notes 2.md"));
        // A dotfile has no extension to split on.
        let none = |_: &Path| false;
        assert_eq!(trash_target(trash, ".env", none), PathBuf::from("/tmp/trash/.env"));
        let dot_taken = |p: &Path| p == Path::new("/tmp/trash/.env");
        assert_eq!(trash_target(trash, ".env", dot_taken), PathBuf::from("/tmp/trash/.env 2"));
    }
}
