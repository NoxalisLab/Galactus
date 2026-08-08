// Galactus desktop, workspace enumeration and project-wide literal search.
//
// Two jobs live here.
//
// ENUMERATION. The list of files a workspace really contains. When a real git
// is available and the root is a work tree, `git ls-files -co --exclude-standard
// -z` answers in one call: tracked plus untracked-not-ignored, honouring nested
// .gitignore files, ~/.config/git/ignore and .git/info/exclude for free. That is
// worth far more than any parser we could write, so it is the primary path.
// Otherwise a parallel walk takes over, with a small .gitignore implementation.
//
// The walk uses `symlink_metadata`, never `metadata`. `read_dir` + `metadata()`
// follows symlinks, so a directory linked to one of its own ancestors makes the
// walk run forever, and a link pointing outside the workspace reads files the
// user never opened. That would defeat the containment guarantee `inside()` in
// code.rs exists to provide, so symlinks are skipped outright, in both paths.
//
// SEARCH. Literal substring matching only, no regex mode: `str::find` uses
// core's two-way searcher, which is linear and needs no dependency, and a regex
// engine would be a crate, a NOTICE entry and a licence review. Case-insensitive
// matching runs on a lowercased copy paired with a byte-offset map, because
// lowercasing can change a character's byte length and an offset found in the
// copy must be translated back before slicing the source.
//
// Results stream: a batch every ~120 ms or 200 matches, over
// `galactus://search`. Both caps (5000 matches, 30 s) are reported to the UI as
// flags; nothing is ever dropped silently.
//
// std only: no new crate.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Same list as code.rs. Duplicated rather than shared: code.rs keeps it
/// private and this module must build as part of a standalone test binary too.
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

/// Files larger than this are not searched. A source file is never this big;
/// what is, is a minified bundle or a checked-in dataset, and reading it costs
/// more than any hit it could contain is worth.
const MAX_SEARCH_BYTES: u64 = 1024 * 1024;
/// A NUL in this prefix means binary. Same rule as `code_read`, applied to a
/// window so a 1 MB file is classified without scanning it twice.
const NUL_PROBE: usize = 8 * 1024;
/// Hard caps, both surfaced to the UI.
const MATCH_CAP: usize = 5_000;
const SEARCH_DEADLINE: Duration = Duration::from_secs(30);
/// Enumeration safety valve for a root that is not a project at all.
const MAX_FILES: usize = 200_000;
/// Streaming cadence.
const FLUSH_EVERY: Duration = Duration::from_millis(120);
const BATCH_SIZE: usize = 200;
const POLL: Duration = Duration::from_millis(15);
/// Longest line excerpt returned with a hit.
const LINE_MAX: usize = 400;

// ================================================================ glob

/// One compiled glob token. `Star` never crosses a path separator; a whole
/// segment spelled `**` does, and is handled a level up in `glob_match`.
#[derive(Clone, Debug, PartialEq)]
enum Tok {
    Char(char),
    Any,
    Star,
    Class { neg: bool, set: Vec<(char, char)> },
}

fn compile(pattern: &str) -> Vec<Tok> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out: Vec<Tok> = Vec::with_capacity(chars.len());
    let mut i = 0usize;
    while i < chars.len() {
        match chars[i] {
            '\\' if i + 1 < chars.len() => {
                out.push(Tok::Char(chars[i + 1]));
                i += 2;
            }
            '*' => {
                // Consecutive stars collapse: `a**b` inside a segment is `a*b`.
                if out.last() != Some(&Tok::Star) {
                    out.push(Tok::Star);
                }
                i += 1;
            }
            '?' => {
                out.push(Tok::Any);
                i += 1;
            }
            '[' => {
                match parse_class(&chars, i) {
                    Some((tok, next)) => {
                        out.push(tok);
                        i = next;
                    }
                    // Unterminated class: a literal bracket, like the shell.
                    None => {
                        out.push(Tok::Char('['));
                        i += 1;
                    }
                }
            }
            c => {
                out.push(Tok::Char(c));
                i += 1;
            }
        }
    }
    out
}

/// Parse `[...]` starting at `start`. Returns the token and the index just past
/// the closing bracket, or None when there is no closing bracket.
fn parse_class(chars: &[char], start: usize) -> Option<(Tok, usize)> {
    let mut i = start + 1;
    let mut neg = false;
    if i < chars.len() && (chars[i] == '!' || chars[i] == '^') {
        neg = true;
        i += 1;
    }
    let mut set: Vec<(char, char)> = Vec::new();
    // A ']' in first position is a literal, per POSIX.
    if i < chars.len() && chars[i] == ']' {
        set.push((']', ']'));
        i += 1;
    }
    while i < chars.len() && chars[i] != ']' {
        let lo = chars[i];
        if i + 2 < chars.len() && chars[i + 1] == '-' && chars[i + 2] != ']' {
            set.push((lo, chars[i + 2]));
            i += 3;
        } else {
            set.push((lo, lo));
            i += 1;
        }
    }
    if i >= chars.len() {
        return None;
    }
    Some((Tok::Class { neg, set }, i + 1))
}

fn class_hit(neg: bool, set: &[(char, char)], c: char) -> bool {
    let inside = set.iter().any(|(lo, hi)| c >= *lo && c <= *hi);
    inside != neg
}

/// Match one path segment against compiled tokens. Iterative backtracking on
/// the last star, so the cost stays linear on the patterns people actually
/// write and never recurses deeply.
fn seg_hit(toks: &[Tok], text: &str) -> bool {
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let mut star: Option<usize> = None;
    let mut mark = 0usize;
    while ti < t.len() {
        let matched = if pi < toks.len() {
            match &toks[pi] {
                Tok::Star => {
                    star = Some(pi);
                    mark = ti;
                    pi += 1;
                    continue;
                }
                Tok::Any => true,
                Tok::Char(c) => *c == t[ti],
                Tok::Class { neg, set } => class_hit(*neg, set, t[ti]),
            }
        } else {
            false
        };
        if matched {
            pi += 1;
            ti += 1;
            continue;
        }
        match star {
            Some(s) => {
                pi = s + 1;
                mark += 1;
                ti = mark;
            }
            None => return false,
        }
    }
    while pi < toks.len() && toks[pi] == Tok::Star {
        pi += 1;
    }
    pi == toks.len()
}

/// Glob match over a slash-separated relative path. A segment spelled `**`
/// matches zero or more whole segments; `*` and `?` never cross a separator.
pub fn glob_match(pattern: &str, path: &str) -> bool {
    let p: Vec<&str> = pattern.split('/').filter(|s| !s.is_empty()).collect();
    let s: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    seg_match(&p, &s)
}

fn seg_match(p: &[&str], s: &[&str]) -> bool {
    if p.is_empty() {
        return s.is_empty();
    }
    if p[0] == "**" {
        for i in 0..=s.len() {
            if seg_match(&p[1..], &s[i..]) {
                return true;
            }
        }
        return false;
    }
    if s.is_empty() {
        return false;
    }
    if !seg_hit(&compile(p[0]), s[0]) {
        return false;
    }
    seg_match(&p[1..], &s[1..])
}

/// One ignore or filter rule, in gitignore spelling.
#[derive(Clone, Debug)]
pub struct Rule {
    /// Leading `!`: this rule re-includes what an earlier rule excluded.
    pub negate: bool,
    /// Trailing `/`: applies to directories only.
    pub dir_only: bool,
    /// Contains a `/`: matched against the path relative to the rule's base,
    /// not against the file name.
    pub anchored: bool,
    pub pattern: String,
}

pub fn parse_rule(raw: &str) -> Option<Rule> {
    let line = raw.trim_end();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let mut body = line;
    let mut negate = false;
    if let Some(rest) = body.strip_prefix('!') {
        negate = true;
        body = rest;
    }
    let mut dir_only = false;
    while let Some(rest) = body.strip_suffix('/') {
        dir_only = true;
        body = rest;
    }
    let anchored = body.contains('/') || body.starts_with('/');
    let body = body.strip_prefix('/').unwrap_or(body);
    if body.is_empty() {
        return None;
    }
    Some(Rule { negate, dir_only, anchored, pattern: body.to_string() })
}

pub fn parse_rules<'a>(lines: impl IntoIterator<Item = &'a str>) -> Vec<Rule> {
    lines.into_iter().filter_map(parse_rule).collect()
}

/// Does a user-supplied include/exclude rule cover this relative file path?
/// A bare name covers the file AND everything under a directory of that name,
/// which is what someone typing `--exclude docs` means.
fn user_hit(rule: &Rule, rel: &str) -> bool {
    let p = &rule.pattern;
    if glob_match(p, rel) || glob_match(&format!("{p}/**"), rel) {
        return true;
    }
    if !rule.anchored
        && (glob_match(&format!("**/{p}"), rel) || glob_match(&format!("**/{p}/**"), rel))
    {
        return true;
    }
    false
}

/// Last matching rule wins, exactly as gitignore resolves a file. `None` means
/// no rule had an opinion.
fn verdict(rules: &[Rule], rel: &str) -> Option<bool> {
    let mut v = None;
    for r in rules {
        if user_hit(r, rel) {
            v = Some(!r.negate);
        }
    }
    v
}

/// Apply the include and exclude lists of a search to one relative path.
pub fn passes_filters(rel: &str, include: &[Rule], exclude: &[Rule]) -> bool {
    if !include.is_empty() && verdict(include, rel) != Some(true) {
        return false;
    }
    verdict(exclude, rel) != Some(true)
}

// ================================================================ ignore chain

/// The .gitignore rules of one directory, chained to its parent's. Immutable
/// and shared by Arc so the parallel walk can hand a directory's chain to
/// whichever worker picks up its children.
struct IgnoreNode {
    /// Directory the rules are relative to, as a root-relative path ("" at the
    /// top).
    base: String,
    rules: Vec<Rule>,
    parent: Option<Arc<IgnoreNode>>,
}

fn read_ignore(dir: &Path, base: &str, parent: Option<Arc<IgnoreNode>>) -> Option<Arc<IgnoreNode>> {
    // No .gitignore here, or an empty one: the parent chain is the answer.
    // Returning None instead would silently drop every rule above this level.
    let Ok(text) = std::fs::read_to_string(dir.join(".gitignore")) else {
        return parent;
    };
    let rules = parse_rules(text.lines());
    if rules.is_empty() {
        return parent;
    }
    Some(Arc::new(IgnoreNode { base: base.to_string(), rules, parent }))
}

fn ignore_hit(rule: &Rule, sub: &str, name: &str, is_dir: bool) -> bool {
    if rule.dir_only && !is_dir {
        return false;
    }
    if rule.anchored {
        glob_match(&rule.pattern, sub) || glob_match(&format!("{}/**", rule.pattern), sub)
    } else {
        glob_match(&rule.pattern, name)
    }
}

/// Innermost .gitignore that has an opinion decides; within a file, the last
/// matching line wins. `rel` is relative to the workspace root.
fn is_ignored(chain: &Option<Arc<IgnoreNode>>, rel: &str, name: &str, is_dir: bool) -> bool {
    let mut node = chain.clone();
    while let Some(n) = node {
        let sub = if n.base.is_empty() {
            Some(rel)
        } else {
            rel.strip_prefix(&format!("{}/", n.base))
        };
        if let Some(sub) = sub {
            let mut v = None;
            for r in &n.rules {
                if ignore_hit(r, sub, name, is_dir) {
                    v = Some(!r.negate);
                }
            }
            if let Some(v) = v {
                return v;
            }
        }
        node = n.parent.clone();
    }
    false
}

// ================================================================ enumeration

/// Files of a workspace, as paths relative to the root, sorted.
pub fn enumerate_files(root: &Path) -> Result<Vec<String>, String> {
    enumerate_files_with(root, true)
}

/// `use_git=false` forces the walk, which is how the fallback is exercised.
pub fn enumerate_files_with(root: &Path, use_git: bool) -> Result<Vec<String>, String> {
    enumerate_sourced(root, use_git).map(|(files, _)| files)
}

/// Same, plus which of the two paths actually produced the list. The UI never
/// needs this; the CLI prints it so a reviewer can tell the two apart.
pub fn enumerate_sourced(root: &Path, use_git: bool) -> Result<(Vec<String>, &'static str), String> {
    let real = std::fs::canonicalize(root).map_err(|e| format!("{}: {e}", root.display()))?;
    if !real.is_dir() {
        return Err(format!("{} is not a directory", real.display()));
    }
    let (mut files, source) = match use_git.then(|| git_files(&real)).flatten() {
        Some(f) => (f, "git ls-files"),
        None => (walk_files(&real), "parallel walk"),
    };
    files.sort();
    files.dedup();
    files.truncate(MAX_FILES);
    Ok((files, source))
}

/// True when a real git is usable and `root` is inside a work tree.
fn git_work_tree(git: &Path, root: &Path) -> bool {
    Command::new(git)
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--is-inside-work-tree"])
        .stdin(Stdio::null())
        .output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false)
}

/// Tracked plus untracked-not-ignored, in one call. `-z` because a path may
/// contain a space, a quote or a newline, and the plain form quotes those in a
/// way that has to be un-escaped by hand.
fn git_files(root: &Path) -> Option<Vec<String>> {
    let git = crate::toolchain::git_program()?;
    if !git_work_tree(&git, root) {
        return None;
    }
    let out = Command::new(&git)
        .arg("-C")
        .arg(root)
        .args(["ls-files", "-co", "--exclude-standard", "-z"])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let mut files = Vec::new();
    for rel in text.split('\0').filter(|s| !s.is_empty()) {
        // `ls-files -c` also lists a tracked path that was deleted on disk, and
        // it lists symlinks. Both are dropped here so this path and the walk
        // report the same kind of thing: real, readable, contained files.
        if !keepable(root, rel) {
            continue;
        }
        files.push(rel.to_string());
    }
    // Git can legitimately answer "nothing here" for a directory that is full
    // of files: open ~/work/build inside a repo whose .gitignore has `build/`
    // and ls-files returns an empty list. A Code view that then finds nothing
    // to search would be simply wrong, so an empty answer hands over to the
    // walk. A genuinely empty repository costs one extra walk of one empty
    // directory.
    if files.is_empty() {
        return None;
    }
    Some(files)
}

/// A relative path is keepable when it stays inside the root by construction
/// and points at a regular file that is not a symlink.
fn keepable(root: &Path, rel: &str) -> bool {
    if rel.is_empty() || Path::new(rel).components().any(|c| matches!(c, Component::ParentDir)) {
        return false;
    }
    let full = root.join(rel);
    if !full.starts_with(root) {
        return false;
    }
    match std::fs::symlink_metadata(&full) {
        Ok(m) => m.file_type().is_file(),
        Err(_) => false,
    }
}

struct Job {
    dir: PathBuf,
    rel: String,
    ignore: Option<Arc<IgnoreNode>>,
}

/// Parallel directory walk. Workers pull jobs off one shared stack; the busy
/// counter is incremented while the stack lock is still held, so a worker that
/// finds the stack empty can only see busy == 0 once no other worker is about
/// to push children.
fn walk_files(root: &Path) -> Vec<String> {
    let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8);
    // The root's own .gitignore is read by visit_dir, like every other
    // directory's: seeding it here too would chain the same rules twice.
    let stack: Mutex<Vec<Job>> =
        Mutex::new(vec![Job { dir: root.to_path_buf(), rel: String::new(), ignore: None }]);
    let files: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let busy = AtomicUsize::new(0);
    let stop = AtomicBool::new(false);

    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                if stop.load(Ordering::Relaxed) {
                    return;
                }
                let job = {
                    let mut s = stack.lock().unwrap_or_else(|e| e.into_inner());
                    match s.pop() {
                        Some(j) => {
                            busy.fetch_add(1, Ordering::SeqCst);
                            Some(j)
                        }
                        None => None,
                    }
                };
                let Some(job) = job else {
                    if busy.load(Ordering::SeqCst) == 0 {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(1));
                    continue;
                };
                let (mut dirs, mut found) = (Vec::new(), Vec::new());
                visit_dir(&job, &mut dirs, &mut found);
                {
                    let mut f = files.lock().unwrap_or_else(|e| e.into_inner());
                    f.extend(found);
                    if f.len() >= MAX_FILES {
                        stop.store(true, Ordering::Relaxed);
                    }
                }
                if !dirs.is_empty() {
                    stack.lock().unwrap_or_else(|e| e.into_inner()).extend(dirs);
                }
                busy.fetch_sub(1, Ordering::SeqCst);
            });
        }
    });

    files.into_inner().unwrap_or_else(|e| e.into_inner())
}

fn visit_dir(job: &Job, dirs: &mut Vec<Job>, found: &mut Vec<String>) {
    // The directory's own .gitignore governs its children.
    let chain = read_ignore(&job.dir, &job.rel, job.ignore.clone());
    let Ok(entries) = std::fs::read_dir(&job.dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // symlink_metadata, never metadata: metadata() follows the link, and a
        // directory linked to one of its ancestors would loop forever while a
        // link pointing outward would be read from outside the workspace.
        // Spelled out rather than relying on DirEntry::metadata's platform
        // behaviour, because the containment guarantee hangs off this line.
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        let rel = if job.rel.is_empty() { name.clone() } else { format!("{}/{}", job.rel, name) };
        if meta.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            if is_ignored(&chain, &rel, &name, true) {
                continue;
            }
            dirs.push(Job { dir: entry.path(), rel, ignore: chain.clone() });
        } else if meta.is_file() {
            if is_ignored(&chain, &rel, &name, false) {
                continue;
            }
            found.push(rel);
        }
    }
}

/// Cached enumeration, keyed by the canonical root. `refresh` rebuilds it: the
/// UI calls it after a checkout or a pull, when the file set really did move.
pub fn cached_files(root: &Path, refresh: bool) -> Result<Vec<String>, String> {
    static CACHE: OnceLock<Mutex<HashMap<String, Vec<String>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = std::fs::canonicalize(root)
        .map_err(|e| format!("{}: {e}", root.display()))?
        .to_string_lossy()
        .to_string();
    if !refresh {
        if let Some(hit) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
            return Ok(hit.clone());
        }
    }
    let files = enumerate_files(Path::new(&key))?;
    cache.lock().unwrap_or_else(|e| e.into_inner()).insert(key, files.clone());
    Ok(files)
}

// ================================================================ matching

/// Lowercased copy of `text` plus, for every byte of it, the byte offset of the
/// source character it came from. `char::to_lowercase` can change a character's
/// byte length ('ẞ' is 3 bytes, 'ß' is 2), so an offset found in the copy has
/// to be translated back before slicing the source or the slice lands mid
/// character. One extra entry makes `map[lowered.len()] == text.len()`.
fn lowered_with_offsets(text: &str) -> (String, Vec<usize>) {
    let mut lowered = String::with_capacity(text.len());
    let mut map: Vec<usize> = Vec::with_capacity(text.len() + 1);
    for (i, c) in text.char_indices() {
        let before = lowered.len();
        for lc in c.to_lowercase() {
            lowered.push(lc);
        }
        for _ in before..lowered.len() {
            map.push(i);
        }
    }
    map.push(text.len());
    (lowered, map)
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Neither neighbour of [s, e) is a word character.
fn at_word_boundary(text: &str, s: usize, e: usize) -> bool {
    let before = text[..s].chars().next_back();
    let after = text[e..].chars().next();
    !before.is_some_and(is_word) && !after.is_some_and(is_word)
}

/// Byte ranges of every literal occurrence of `needle` in `text`, expressed in
/// SOURCE offsets whichever case mode is in use.
pub fn find_matches(text: &str, needle: &str, case_sensitive: bool, whole_word: bool) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    if needle.is_empty() {
        return out;
    }
    if case_sensitive {
        let mut from = 0usize;
        while from <= text.len() {
            let Some(off) = text[from..].find(needle) else { break };
            let s = from + off;
            let e = s + needle.len();
            if !whole_word || at_word_boundary(text, s, e) {
                out.push((s, e));
            }
            // Non-overlapping, the way an editor counts matches: "aa" occurs
            // twice in "aaaa", not three times.
            from = e;
        }
        return out;
    }
    let needle_lc: String = needle.to_lowercase();
    let (lowered, map) = lowered_with_offsets(text);
    let mut from = 0usize;
    while from <= lowered.len() {
        let Some(off) = lowered[from..].find(needle_lc.as_str()) else { break };
        let ls = from + off;
        let le = ls + needle_lc.len();
        let s = map[ls.min(map.len() - 1)];
        let mut e = map[le.min(map.len() - 1)];
        if e <= s {
            // Defensive: a lowercase expansion that swallowed the whole match.
            e = s + text[s..].chars().next().map_or(0, |c| c.len_utf8());
        }
        if e > s && (!whole_word || at_word_boundary(text, s, e)) {
            out.push((s, e));
        }
        from = le;
    }
    out
}

/// Byte offset of the start of every line, for turning a match offset into a
/// line number by binary search.
fn line_starts(text: &str) -> Vec<usize> {
    let mut v = vec![0usize];
    for (i, b) in text.bytes().enumerate() {
        if b == b'\n' {
            v.push(i + 1);
        }
    }
    v
}

fn line_index(starts: &[usize], off: usize) -> usize {
    match starts.binary_search(&off) {
        Ok(i) => i,
        Err(i) => i - 1,
    }
}

fn truncate_utf8(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

// ================================================================ options and hits

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct SearchOpts {
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub include_globs: Vec<String>,
    pub exclude_globs: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Hit {
    /// Relative to the workspace root.
    pub path: String,
    /// 1-based.
    pub line: usize,
    /// 1-based CHARACTER column, so an editor can place a caret with it. The
    /// byte offset is carried separately for anyone who needs to slice.
    pub col: usize,
    /// Byte offset of the match from the start of the file.
    pub offset: usize,
    /// Byte length of the match, which is not the needle's length in a
    /// case-insensitive search over non-ASCII text.
    pub len: usize,
    /// The whole line, trimmed of its newline and capped at 400 bytes.
    pub text: String,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct SearchReport {
    pub matches: usize,
    /// Files that were actually read.
    pub scanned: usize,
    /// Files the enumeration offered, before filters.
    pub files: usize,
    /// The 5000-match cap was reached.
    pub capped: bool,
    /// The 30 s deadline expired.
    pub timed_out: bool,
    /// A newer search, or search_cancel, ended this one.
    pub cancelled: bool,
}

/// Read and scan one file. Returns false when the file was skipped, so the
/// caller can report how much of the workspace was really looked at.
fn scan_file(root: &Path, rel: &str, needle: &str, opts: &SearchOpts, out: &mut Vec<Hit>) -> bool {
    if Path::new(rel).components().any(|c| matches!(c, Component::ParentDir)) {
        return false;
    }
    let full = root.join(rel);
    // The root was canonicalized once by the caller and no symlink survived
    // enumeration, so a prefix test is enough here. Canonicalizing every file
    // instead would cost one realpath syscall per file: 100k of them on a big
    // tree, for an answer that cannot differ.
    if !full.starts_with(root) {
        return false;
    }
    let Ok(meta) = std::fs::symlink_metadata(&full) else {
        return false;
    };
    if !meta.file_type().is_file() || meta.len() > MAX_SEARCH_BYTES {
        return false;
    }
    let Ok(bytes) = std::fs::read(&full) else {
        return false;
    };
    if bytes[..bytes.len().min(NUL_PROBE)].contains(&0) {
        return false;
    }
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return false;
    };
    let ranges = find_matches(text, needle, opts.case_sensitive, opts.whole_word);
    if ranges.is_empty() {
        return true;
    }
    let starts = line_starts(text);
    for (s, e) in ranges {
        let li = line_index(&starts, s);
        let ls = starts[li];
        let le = starts.get(li + 1).map(|n| n - 1).unwrap_or(text.len());
        let line = text[ls..le.max(ls)].trim_end_matches('\r');
        out.push(Hit {
            path: rel.to_string(),
            line: li + 1,
            col: text[ls..s].chars().count() + 1,
            offset: s,
            len: e - s,
            text: truncate_utf8(line, LINE_MAX).to_string(),
        });
    }
    true
}

/// Run a search to completion, handing batches of hits to `sink` as they come.
///
/// `alive` is polled by the coordinator; returning false ends the search and
/// sets `cancelled`. Everything else about the run is reported in the returned
/// SearchReport, never swallowed.
pub fn run_search(
    root: &Path,
    query: &str,
    opts: &SearchOpts,
    alive: &dyn Fn() -> bool,
    sink: &mut dyn FnMut(Vec<Hit>),
) -> Result<SearchReport, String> {
    if query.is_empty() {
        return Err("empty query".into());
    }
    let real = std::fs::canonicalize(root).map_err(|e| format!("{}: {e}", root.display()))?;
    let all = cached_files(&real, false)?;
    let include = parse_rules(opts.include_globs.iter().map(|s| s.as_str()));
    let exclude = parse_rules(opts.exclude_globs.iter().map(|s| s.as_str()));
    let files: Vec<String> = all
        .iter()
        .filter(|rel| passes_filters(rel, &include, &exclude))
        .cloned()
        .collect();

    let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8);
    let cursor = AtomicUsize::new(0);
    let total = AtomicUsize::new(0);
    let scanned = AtomicUsize::new(0);
    let stop = AtomicBool::new(false);
    let capped = AtomicBool::new(false);
    let live = AtomicUsize::new(workers);
    let pending: Mutex<Vec<Hit>> = Mutex::new(Vec::new());
    let deadline = Instant::now() + SEARCH_DEADLINE;
    let mut timed_out = false;
    let mut cancelled = false;

    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                loop {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    let i = cursor.fetch_add(1, Ordering::SeqCst);
                    if i >= files.len() {
                        break;
                    }
                    let mut hits: Vec<Hit> = Vec::new();
                    if scan_file(&real, &files[i], query, opts, &mut hits) {
                        scanned.fetch_add(1, Ordering::Relaxed);
                    }
                    if hits.is_empty() {
                        continue;
                    }
                    let before = total.fetch_add(hits.len(), Ordering::SeqCst);
                    if before >= MATCH_CAP {
                        capped.store(true, Ordering::Relaxed);
                        stop.store(true, Ordering::Relaxed);
                        break;
                    }
                    if before + hits.len() > MATCH_CAP {
                        hits.truncate(MATCH_CAP - before);
                        capped.store(true, Ordering::Relaxed);
                        stop.store(true, Ordering::Relaxed);
                    }
                    pending.lock().unwrap_or_else(|e| e.into_inner()).extend(hits);
                }
                live.fetch_sub(1, Ordering::SeqCst);
            });
        }
        // Coordinator: this thread owns `sink`, so batches are emitted in one
        // place and the workers never touch the AppHandle.
        let mut last = Instant::now();
        loop {
            let done = live.load(Ordering::SeqCst) == 0;
            if Instant::now() >= deadline {
                timed_out = true;
                stop.store(true, Ordering::Relaxed);
            }
            if !alive() {
                cancelled = true;
                stop.store(true, Ordering::Relaxed);
            }
            let ready = {
                let p = pending.lock().unwrap_or_else(|e| e.into_inner());
                p.len() >= BATCH_SIZE || (!p.is_empty() && last.elapsed() >= FLUSH_EVERY)
            };
            if ready {
                let batch = std::mem::take(&mut *pending.lock().unwrap_or_else(|e| e.into_inner()));
                if !batch.is_empty() {
                    sink(batch);
                }
                last = Instant::now();
            }
            if done {
                break;
            }
            std::thread::sleep(POLL);
        }
    });

    let rest = std::mem::take(&mut *pending.lock().unwrap_or_else(|e| e.into_inner()));
    if !rest.is_empty() {
        sink(rest);
    }
    Ok(SearchReport {
        matches: total.load(Ordering::SeqCst).min(MATCH_CAP),
        scanned: scanned.load(Ordering::SeqCst),
        files: files.len(),
        capped: capped.load(Ordering::SeqCst),
        timed_out,
        cancelled,
    })
}

/// Convenience for tests and the CLI: run to completion, sorted, no streaming.
#[allow(dead_code)] // driven by the gx-workspace CLI and by the tests.
pub fn search_all(root: &Path, query: &str, opts: &SearchOpts) -> Result<(Vec<Hit>, SearchReport), String> {
    let mut hits: Vec<Hit> = Vec::new();
    let report = run_search(root, query, opts, &|| true, &mut |batch| hits.extend(batch))?;
    hits.sort_by(|a, b| a.path.cmp(&b.path).then(a.offset.cmp(&b.offset)));
    Ok((hits, report))
}

// ================================================================ commands

/// Generation of the last search started, and the one currently allowed to run.
/// Starting a search implicitly cancels the previous one: a user typing in the
/// search box produces one of these per keystroke.
static SEARCH_GEN: AtomicU64 = AtomicU64::new(0);
static SEARCH_ACTIVE: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
pub async fn search_start(
    app: tauri::AppHandle,
    root: String,
    query: String,
    opts: Option<SearchOpts>,
) -> Result<u64, String> {
    use tauri::Emitter;
    if query.is_empty() {
        return Err("empty query".into());
    }
    let opts = opts.unwrap_or_default();
    let gen = SEARCH_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    SEARCH_ACTIVE.store(gen, Ordering::SeqCst);
    let root_path = PathBuf::from(&root);
    std::thread::spawn(move || {
        let alive = || SEARCH_ACTIVE.load(Ordering::SeqCst) == gen;
        let emit = &app;
        let mut sink = |batch: Vec<Hit>| {
            let _ = emit.emit(
                "galactus://search",
                serde_json::json!({"gen": gen, "hits": batch, "done": false,
                                   "capped": false, "timed_out": false}),
            );
        };
        let result = run_search(&root_path, &query, &opts, &alive, &mut sink);
        let payload = match result {
            Ok(r) => serde_json::json!({
                "gen": gen, "hits": Vec::<Hit>::new(), "done": true,
                "capped": r.capped, "timed_out": r.timed_out, "cancelled": r.cancelled,
                "matches": r.matches, "scanned": r.scanned, "files": r.files,
            }),
            Err(e) => serde_json::json!({
                "gen": gen, "hits": Vec::<Hit>::new(), "done": true,
                "capped": false, "timed_out": false, "cancelled": false, "error": e,
            }),
        };
        let _ = app.emit("galactus://search", payload);
        // Only clear the slot if it is still ours: a newer search may already
        // own it, and zeroing it would cancel that one instead.
        let _ = SEARCH_ACTIVE.compare_exchange(gen, 0, Ordering::SeqCst, Ordering::SeqCst);
    });
    Ok(gen)
}

#[tauri::command]
pub fn search_cancel(gen: u64) {
    let _ = SEARCH_ACTIVE.compare_exchange(gen, 0, Ordering::SeqCst, Ordering::SeqCst);
}

/// Stop whatever is running, whichever generation owns the slot. Called from
/// the app's Exit handler: a scan started a second before the window closes
/// must not keep walking a disk nobody is watching.
pub fn cancel_all() {
    SEARCH_ACTIVE.store(0, Ordering::SeqCst);
}

/// The workspace file list, for the file picker and for anything that needs to
/// know what the project contains.
///
/// On the blocking pool: a cache miss walks the whole tree, and doing that in
/// the body of an async command parks a tokio worker that the chat stream and
/// every other command need. Same pattern as pylang.rs and snapshot.rs.
#[tauri::command]
pub async fn search_files(root: String, refresh: bool) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || cached_files(Path::new(&root), refresh))
        .await
        .map_err(|e| format!("the workspace enumeration thread died: {e}"))?
}

// ================================================================ tests

#[cfg(test)]
pub(crate) mod testutil {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    /// A fresh directory under the system temp dir, removed first so a rerun
    /// never inherits the previous tree.
    pub fn temp_tree(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let base = std::env::temp_dir()
            .join(format!("galactus-workspace-{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).expect("temp tree");
        base
    }

    pub fn write(path: &std::path::Path, body: &[u8]) {
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p).expect("mkdir");
        }
        std::fs::write(path, body).expect("write");
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::{temp_tree, write};
    use super::*;

    fn opts() -> SearchOpts {
        SearchOpts::default()
    }

    #[test]
    fn a_directory_symlinked_to_itself_terminates_the_walk() {
        let base = temp_tree("selfloop");
        let root = base.join("root");
        write(&root.join("a/file.txt"), b"hello");
        // Two shapes of the same trap: a link to the tree top, and a link to
        // the directory that contains it.
        std::os::unix::fs::symlink(&root, root.join("a/top")).unwrap();
        std::os::unix::fs::symlink(root.join("a"), root.join("a/self")).unwrap();

        let files = enumerate_files_with(&root, false).unwrap();
        assert_eq!(files, vec!["a/file.txt".to_string()], "walk followed a symlinked directory");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_symlink_pointing_outside_the_root_is_never_read() {
        let base = temp_tree("escape");
        let root = base.join("root");
        let outside = base.join("outside");
        write(&outside.join("secret.txt"), b"TOPSECRET value");
        write(&root.join("inside.txt"), b"ordinary value");
        std::os::unix::fs::symlink(&outside, root.join("out")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("secret.txt")).unwrap();

        let files = enumerate_files_with(&root, false).unwrap();
        assert_eq!(files, vec!["inside.txt".to_string()], "a symlink was enumerated: {files:?}");

        let (hits, _) = search_all(&root, "TOPSECRET", &opts()).unwrap();
        assert!(hits.is_empty(), "content outside the root was read: {hits:?}");
        // Even asked for by name, the linked path must not be scanned.
        let mut direct = Vec::new();
        assert!(!scan_file(
            &std::fs::canonicalize(&root).unwrap(),
            "secret.txt",
            "TOPSECRET",
            &opts(),
            &mut direct
        ));
        assert!(direct.is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_nul_byte_in_the_first_8k_skips_the_file() {
        let base = temp_tree("nul");
        let root = base.join("root");
        let mut early = b"needle here\0 and more".to_vec();
        early.extend_from_slice(&[b'x'; 32]);
        write(&root.join("early.bin"), &early);
        // The rule is a window, not the whole file: a NUL past 8 KB is not
        // looked at, so the file is still searched. Asserted so the boundary
        // is documented rather than assumed.
        let mut late = vec![b'x'; NUL_PROBE + 16];
        late.extend_from_slice(b"\nneedle here\n\0");
        write(&root.join("late.bin"), &late);

        let (hits, _) = search_all(&root, "needle", &opts()).unwrap();
        let paths: Vec<&str> = hits.iter().map(|h| h.path.as_str()).collect();
        assert!(!paths.contains(&"early.bin"), "binary file was searched");
        assert_eq!(paths, vec!["late.bin"], "unexpected hit set: {paths:?}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_two_megabyte_file_is_skipped() {
        let base = temp_tree("big");
        let root = base.join("root");
        let mut big = vec![b'a'; 2 * 1024 * 1024];
        big.extend_from_slice(b"\nneedle\n");
        write(&root.join("big.txt"), &big);
        write(&root.join("small.txt"), b"needle\n");

        let (hits, report) = search_all(&root, "needle", &opts()).unwrap();
        let paths: Vec<&str> = hits.iter().map(|h| h.path.as_str()).collect();
        assert_eq!(paths, vec!["small.txt"], "the oversized file was searched");
        assert_eq!(report.files, 2, "the oversized file should still be enumerated");
        assert_eq!(report.scanned, 1, "only the small file should be read");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn whole_word_does_not_match_inside_foobar() {
        let base = temp_tree("word");
        let root = base.join("root");
        write(&root.join("a.txt"), b"foobar\nfoo\nbarfoo\nfoo_bar\n(foo)\n");

        let mut o = opts();
        o.whole_word = true;
        let (hits, _) = search_all(&root, "foo", &o).unwrap();
        let lines: Vec<usize> = hits.iter().map(|h| h.line).collect();
        assert_eq!(lines, vec![2, 5], "whole-word matched a substring: {hits:?}");

        let (loose, _) = search_all(&root, "foo", &opts()).unwrap();
        assert_eq!(loose.len(), 5, "plain search should see every occurrence");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn case_insensitive_matches_across_a_multibyte_boundary() {
        // 'ẞ' is three bytes, its lowercase 'ß' is two: the match offset found
        // in the lowercased copy is NOT a valid offset in the source, and
        // slicing with it would split a character.
        let text = "let STRAẞE_TOTAL = 1;\nune caf\u{c9} noire\n";
        let base = temp_tree("utf8");
        let root = base.join("root");
        write(&root.join("a.rs"), text.as_bytes());

        let (hits, _) = search_all(&root, "e_total", &opts()).unwrap();
        assert_eq!(hits.len(), 1, "expected one hit, got {hits:?}");
        let h = &hits[0];
        assert!(text.is_char_boundary(h.offset), "offset {} splits a character", h.offset);
        assert_eq!(&text[h.offset..h.offset + h.len], "E_TOTAL");
        // "let STRAẞE" is 10 characters, so the match starts at column 10.
        assert_eq!(h.col, 10, "column {} is not the character column", h.col);
        assert_eq!(h.line, 1);
        // And the column really is a character index, not a byte index.
        let prefix: String = h.text.chars().take(h.col - 1).collect();
        assert_eq!(prefix, "let STRAẞ");

        let (accents, _) = search_all(&root, "CAFÉ", &opts()).unwrap();
        assert_eq!(accents.len(), 1, "accented needle missed: {accents:?}");
        assert_eq!(accents[0].line, 2);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_glob_matcher_handles_doublestar_extensions_and_negation() {
        assert!(glob_match("**/*.rs", "app/src-tauri/src/search.rs"));
        assert!(glob_match("**/*.rs", "search.rs"));
        assert!(!glob_match("**/*.rs", "app/src/main.ts"));
        assert!(glob_match("src/**", "src/a/b/c.txt"));
        assert!(glob_match("src/**/*.ts", "src/a/b.ts"));
        assert!(!glob_match("src/*.ts", "src/a/b.ts"), "a single star crossed a separator");
        assert!(glob_match("*.rs", "search.rs"));
        assert!(!glob_match("*.rs", "src/search.rs"), "a bare glob must not span directories");
        assert!(glob_match("doc?.md", "doc1.md"));
        assert!(glob_match("f[aeiou]o", "foo"));
        assert!(!glob_match("f[!aeiou]o", "foo"));

        let neg = parse_rule("!keep/**").unwrap();
        assert!(neg.negate, "a leading '!' must mark the rule as a re-inclusion");
        assert_eq!(neg.pattern, "keep/**");
        assert!(neg.anchored);
        // The '!' is consumed by the parser, never by the matcher.
        assert!(glob_match(&neg.pattern, "keep/a/b.txt"));

        let dir = parse_rule("target/").unwrap();
        assert!(dir.dir_only && !dir.negate && !dir.anchored);
        assert!(parse_rule("# a comment").is_none());
        assert!(parse_rule("   ").is_none());

        // Last match wins, so a '!' rule brings a path back.
        let rules = parse_rules(vec!["*.log", "!keep.log"]);
        assert_eq!(verdict(&rules, "a/b/noisy.log"), Some(true));
        assert_eq!(verdict(&rules, "a/b/keep.log"), Some(false));
        assert_eq!(verdict(&rules, "a/b/main.rs"), None);
    }

    #[test]
    fn include_and_exclude_globs_filter_the_file_list() {
        let base = temp_tree("globs");
        let root = base.join("root");
        write(&root.join("src/a.rs"), b"needle\n");
        write(&root.join("src/b.ts"), b"needle\n");
        write(&root.join("docs/c.md"), b"needle\n");

        let mut only_rs = opts();
        only_rs.include_globs = vec!["*.rs".into()];
        let (hits, _) = search_all(&root, "needle", &only_rs).unwrap();
        assert_eq!(hits.iter().map(|h| h.path.as_str()).collect::<Vec<_>>(), vec!["src/a.rs"]);

        let mut no_docs = opts();
        no_docs.exclude_globs = vec!["docs".into()];
        let (hits, _) = search_all(&root, "needle", &no_docs).unwrap();
        assert_eq!(
            hits.iter().map(|h| h.path.as_str()).collect::<Vec<_>>(),
            vec!["src/a.rs", "src/b.ts"]
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_walk_honours_nested_gitignore_files() {
        let base = temp_tree("ignore");
        let root = base.join("root");
        write(&root.join(".gitignore"), b"*.log\nbuildout/\n");
        write(&root.join("app/.gitignore"), b"!important.log\ntmp\n");
        write(&root.join("keep.txt"), b"x");
        write(&root.join("noisy.log"), b"x");
        write(&root.join("buildout/gen.txt"), b"x");
        write(&root.join("app/important.log"), b"x");
        write(&root.join("app/other.log"), b"x");
        write(&root.join("app/tmp"), b"x");

        let files = enumerate_files_with(&root, false).unwrap();
        assert_eq!(
            files,
            vec![
                ".gitignore".to_string(),
                "app/.gitignore".to_string(),
                "app/important.log".to_string(),
                "keep.txt".to_string(),
            ],
            "gitignore handling drifted: {files:?}"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn skip_dirs_are_never_walked() {
        let base = temp_tree("skip");
        let root = base.join("root");
        write(&root.join("node_modules/pkg/index.js"), b"needle");
        write(&root.join("target/debug/x.rs"), b"needle");
        write(&root.join("src/main.rs"), b"needle");
        let files = enumerate_files_with(&root, false).unwrap();
        assert_eq!(files, vec!["src/main.rs".to_string()]);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_cancelled_search_reports_it_instead_of_looking_finished() {
        let base = temp_tree("cancel");
        let root = base.join("root");
        for i in 0..64 {
            write(&root.join(format!("f{i}.txt")), b"needle\n");
        }
        let report = run_search(&root, "needle", &opts(), &|| false, &mut |_| {}).unwrap();
        assert!(report.cancelled, "cancellation was not reported");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_match_cap_is_enforced_and_reported() {
        let base = temp_tree("cap");
        let root = base.join("root");
        // 60 files x 100 matches = 6000, comfortably over the 5000 cap.
        let body: String = (0..100).map(|i| format!("line {i} needle here\n")).collect();
        for f in 0..60 {
            write(&root.join(format!("f{f:02}.txt")), body.as_bytes());
        }
        let mut delivered = 0usize;
        let mut batches = 0usize;
        let report = run_search(&root, "needle", &opts(), &|| true, &mut |b| {
            delivered += b.len();
            batches += 1;
        })
        .unwrap();
        assert!(report.capped, "the cap was hit but not reported");
        assert!(!report.timed_out);
        assert_eq!(report.matches, MATCH_CAP, "reported count is not the cap");
        assert_eq!(delivered, MATCH_CAP, "streamed {delivered} hits, cap is {MATCH_CAP}");
        assert!(batches >= 1);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn line_and_column_arithmetic_is_one_based() {
        let base = temp_tree("linecol");
        let root = base.join("root");
        write(&root.join("a.txt"), b"first\nsecond needle here\nthird\n");
        let (hits, _) = search_all(&root, "needle", &opts()).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 2);
        assert_eq!(hits[0].col, 8);
        assert_eq!(hits[0].text, "second needle here");
        let _ = std::fs::remove_dir_all(&base);
    }
}
