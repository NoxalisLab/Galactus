// Galactus desktop — code workspace and version control.
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
use std::path::{Component, Path, PathBuf};
use std::process::Command;

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

#[derive(Serialize)]
pub struct GitInfo {
    pub repo: bool,
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

fn git(root: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
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

/// Worktree status as a map path -> code, for decorating the tree.
fn status_map(root: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
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

#[tauri::command]
pub async fn code_tree(root: String, sub: String) -> Result<Vec<Entry>, String> {
    let dir = inside(&root, if sub.is_empty() { "." } else { &sub })?;
    if !dir.is_dir() {
        return Err(format!("{} is not a directory", dir.display()));
    }
    let status = status_map(&root);
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
    std::fs::rename(&tmp, &full).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_info(root: String) -> Result<GitInfo, String> {
    let repo = git(&root, &["rev-parse", "--is-inside-work-tree"])
        .map(|s| s.trim() == "true")
        .unwrap_or(false);
    if !repo {
        return Ok(GitInfo {
            repo: false,
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

#[tauri::command]
pub async fn git_log(root: String, limit: Option<u32>, path: Option<String>) -> Result<Vec<GitCommit>, String> {
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
    inside(&root, &path)?;
    let spec = format!("{rev}:{path}");
    git(&root, &["--no-pager", "show", &spec])
}

#[tauri::command]
pub async fn git_stage(root: String, paths: Vec<String>, unstage: bool) -> Result<(), String> {
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
    git(&root, &refs).map(|_| ())
}

#[tauri::command]
pub async fn git_commit(root: String, message: String, all: bool) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("a commit needs a message".into());
    }
    let mut args: Vec<&str> = vec!["commit", "-m", message.as_str()];
    if all {
        args.insert(1, "-a");
    }
    git(&root, &args)?;
    git(&root, &["--no-pager", "log", "-1", "--pretty=format:%h %s"])
}

/// Push and pull reach the network and change a shared branch, so they are
/// separate commands: the UI gates them explicitly rather than folding them
/// into a generic "sync".
#[tauri::command]
pub async fn git_push(root: String) -> Result<String, String> {
    git(&root, &["push"])
        .map(|s| if s.trim().is_empty() { "pushed".to_string() } else { s })
}

#[tauri::command]
pub async fn git_pull(root: String, rebase: bool) -> Result<String, String> {
    let args: Vec<&str> = if rebase { vec!["pull", "--rebase"] } else { vec!["pull", "--ff-only"] };
    git(&root, &args)
}

#[tauri::command]
pub async fn git_branches(root: String) -> Result<Vec<String>, String> {
    let out = git(&root, &["branch", "--format=%(refname:short)"])?;
    Ok(out.lines().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
}

#[tauri::command]
pub async fn git_checkout(root: String, branch: String, create: bool) -> Result<String, String> {
    if branch.trim().is_empty() {
        return Err("branch name is empty".into());
    }
    let args: Vec<&str> = if create {
        vec!["checkout", "-b", branch.as_str()]
    } else {
        vec!["checkout", branch.as_str()]
    };
    git(&root, &args).map(|s| if s.trim().is_empty() { format!("on {branch}") } else { s })
}
