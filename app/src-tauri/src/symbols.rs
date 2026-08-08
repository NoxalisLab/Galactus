// Galactus desktop, declaration index for the workspace.
//
// WHAT THIS IS, HONESTLY. A heuristic. There is no ctags fallback on macOS:
// /usr/bin/ctags is the same Xcode Command Line Tools shim as /usr/bin/git,
// and a real parser per language would be several crates, a NOTICE section and
// a licence review. So this is a set of per-language LINE SCANNERS. They read
// one line at a time, strip the obvious comment tail, and recognise the shapes
// a declaration takes. Consequences, stated up front rather than discovered:
//
//   - a symbol produced by a macro is invisible here;
//   - a declaration keyword inside a long string literal can be picked up;
//   - a declaration split across two lines is missed;
//   - `container` is inferred from brace depth (Rust, TS) or indentation
//     (Python), which a stray brace inside a string can throw off.
//
// That is the trade for zero install. For the file currently open in the
// editor, M5's Lezer outline is parsed from the real grammar and stays
// authoritative; this index exists to answer "where is X in this project",
// across files that are not open.
//
// Shape modelled on knowledge.rs: walk, build, persist one JSON document under
// Application Support, keep a copy in memory. std + serde only, no new crate.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Files bigger than this are not scanned: a declaration index of a minified
/// bundle is noise, and reading it costs more than it can return.
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const NUL_PROBE: usize = 8 * 1024;
/// Guards against one generated file, and one pathological repo.
const MAX_PER_FILE: usize = 5_000;
const MAX_TOTAL: usize = 200_000;
const DEFAULT_LIMIT: usize = 50;
/// How long a verified fingerprint is trusted before the tree is walked again.
/// The symbol palette calls `query()` on every keystroke, and re-stat-ing the
/// whole workspace per keystroke would be the new bug. Two seconds is short
/// enough that no realistic edit-then-look-it-up sequence sees stale symbols,
/// and long enough that a burst of typing costs one walk.
const FRESHNESS: Duration = Duration::from_secs(2);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Symbol {
    pub name: String,
    /// "fn", "struct", "enum", "trait", "impl", "mod", "type", "const",
    /// "static", "macro", "class", "def", "interface", "heading", ...
    pub kind: String,
    /// Relative to the workspace root.
    pub path: String,
    /// 1-based.
    pub line: usize,
    /// Enclosing impl block, class, trait, module or parent heading. Empty at
    /// the top level.
    pub container: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct SymbolHit {
    pub name: String,
    pub kind: String,
    pub path: String,
    pub line: usize,
    pub container: String,
    pub score: i32,
}

// ---------------------------------------------------------------- storage

fn app_support() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(home).join("Library/Application Support/Galactus")
}

const FNV_SEED: u64 = 0xcbf2_9ce4_8422_2325;

/// FNV-1a, 64 bits, folded over `bytes` starting from `h`.
fn fnv_fold(mut h: u64, bytes: &[u8]) -> u64 {
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// FNV-1a, 64 bits. Used to give each workspace its own index file name and to
/// fold the tree signature; nothing security-relevant hangs off either.
fn fnv1a(s: &str) -> u64 {
    fnv_fold(FNV_SEED, s.as_bytes())
}

fn index_path(root_key: &str) -> PathBuf {
    app_support().join(format!("code-symbols-{:016x}.json", fnv1a(root_key)))
}

#[derive(Serialize, Deserialize)]
struct StoredIndex {
    root: String,
    built_at: u64,
    /// Signature of the tree these symbols were scanned from. knowledge.rs
    /// rejects its persisted index when the folder list it was built for no
    /// longer matches; this is the same idea for a workspace, where the input
    /// is not a short list of folders but the file set itself. Absent (0) in a
    /// document written by an older build, which is treated as stale rather
    /// than as "no check needed".
    #[serde(default)]
    fingerprint: u64,
    symbols: Vec<Symbol>,
}

/// One workspace's symbols, with the tree signature they belong to and the
/// last moment that signature was checked against the disk.
struct Cached {
    fingerprint: u64,
    checked: Instant,
    symbols: Arc<Vec<Symbol>>,
}

fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn memory() -> &'static Mutex<HashMap<String, Cached>> {
    static MEM: OnceLock<Mutex<HashMap<String, Cached>>> = OnceLock::new();
    MEM.get_or_init(|| Mutex::new(HashMap::new()))
}

fn persist(root_key: &str, fingerprint: u64, symbols: &[Symbol]) -> Result<(), String> {
    let doc = StoredIndex {
        root: root_key.to_string(),
        built_at: now_unix(),
        fingerprint,
        symbols: symbols.to_vec(),
    };
    let p = index_path(root_key);
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string(&doc).map_err(|e| e.to_string())?;
    // Write-then-rename, like every other persisted file in this app: an
    // interrupted write must not leave a half-parsed index behind.
    let tmp = p.with_extension(format!("tmp.{}", std::process::id()));
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// The persisted index, only if it belongs to this workspace AND to the tree
/// as it stands right now. A mismatch returns None, which sends `index_for`
/// down the rebuild path: a stale index is never served as current.
fn load_persisted(root_key: &str, fingerprint: u64) -> Option<Vec<Symbol>> {
    let text = std::fs::read_to_string(index_path(root_key)).ok()?;
    let doc: StoredIndex = serde_json::from_str(&text).ok()?;
    if doc.root != root_key {
        return None;
    }
    if doc.fingerprint == 0 || doc.fingerprint != fingerprint {
        return None;
    }
    Some(doc.symbols)
}

// ---------------------------------------------------------------- text helpers

fn is_ident_start(c: char) -> bool {
    c.is_alphabetic() || c == '_' || c == '$'
}

fn is_ident(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// Leading identifier of `s`, with the remainder after it.
fn ident_at(s: &str) -> Option<(&str, &str)> {
    let mut end = 0usize;
    for (i, c) in s.char_indices() {
        if i == 0 {
            if !is_ident_start(c) {
                return None;
            }
        } else if !is_ident(c) {
            break;
        }
        end = i + c.len_utf8();
    }
    if end == 0 {
        None
    } else {
        Some((&s[..end], s[end..].trim_start()))
    }
}

/// `s` without a leading `word`, when `word` is a whole token there.
fn strip_word<'a>(s: &'a str, word: &str) -> Option<&'a str> {
    let rest = s.strip_prefix(word)?;
    match rest.chars().next() {
        Some(c) if is_ident(c) => None,
        _ => Some(rest.trim_start()),
    }
}

/// Cut a line at its comment marker, ignoring a marker that sits inside a
/// string or character literal. Crude (no raw strings, no template literals)
/// but it stops the obvious false positive: a URL in a string.
fn strip_comment<'a>(line: &'a str, marker: &str) -> &'a str {
    let bytes = line.as_bytes();
    let m = marker.as_bytes();
    let mut quote: Option<u8> = None;
    let mut i = 0usize;
    while i < bytes.len() {
        let c = bytes[i];
        match quote {
            Some(q) => {
                if c == b'\\' {
                    i += 2;
                    continue;
                }
                if c == q {
                    quote = None;
                }
            }
            None => {
                if c == b'"' || c == b'\'' || c == b'`' {
                    quote = Some(c);
                } else if bytes[i..].starts_with(m) {
                    return &line[..i];
                }
            }
        }
        i += 1;
    }
    line
}

/// Net brace balance of a line, ignoring braces inside quotes.
fn brace_delta(line: &str) -> i32 {
    let bytes = line.as_bytes();
    let mut quote: Option<u8> = None;
    let mut d = 0i32;
    let mut i = 0usize;
    while i < bytes.len() {
        let c = bytes[i];
        match quote {
            Some(q) => {
                if c == b'\\' {
                    i += 2;
                    continue;
                }
                if c == q {
                    quote = None;
                }
            }
            None => match c {
                b'"' | b'\'' | b'`' => quote = Some(c),
                b'{' => d += 1,
                b'}' => d -= 1,
                _ => {}
            },
        }
        i += 1;
    }
    d
}

/// A container stack entry: the brace depth the block was opened at, and its
/// name.
type Frame = (i32, String);

fn unwind(stack: &mut Vec<Frame>, depth: i32) {
    while let Some((d, _)) = stack.last() {
        if depth <= *d {
            stack.pop();
        } else {
            break;
        }
    }
}

fn top(stack: &[Frame]) -> String {
    stack.last().map(|(_, n)| n.clone()).unwrap_or_default()
}

// ---------------------------------------------------------------- Rust

/// Strip the visibility and modifier prefixes that can precede a Rust item.
/// Returns the remainder, plus whether an `async` was seen (unused today, kept
/// so the caller reads naturally).
fn rust_strip_modifiers(mut s: &str) -> &str {
    loop {
        if s.starts_with("pub(") {
            match s.find(')') {
                Some(i) => {
                    s = s[i + 1..].trim_start();
                    continue;
                }
                None => return s,
            }
        }
        if s.starts_with("extern \"") {
            match s[8..].find('"') {
                Some(i) => {
                    s = s[8 + i + 1..].trim_start();
                    continue;
                }
                None => return s,
            }
        }
        let next = ["pub", "async", "unsafe", "extern", "default"]
            .iter()
            .find_map(|w| strip_word(s, w));
        match next {
            Some(r) => s = r,
            None => return s,
        }
    }
}

/// The type an `impl` block is for: `impl<T> Trait for Type<T> where ...` gives
/// "Type", `impl Foo` gives "Foo".
fn impl_target(rest: &str) -> String {
    let mut s = rest.trim();
    // Drop the generic parameter list that follows `impl`.
    if s.starts_with('<') {
        let mut depth = 0i32;
        let mut cut = None;
        for (i, c) in s.char_indices() {
            match c {
                '<' => depth += 1,
                '>' => {
                    depth -= 1;
                    if depth == 0 {
                        cut = Some(i + 1);
                        break;
                    }
                }
                _ => {}
            }
        }
        if let Some(i) = cut {
            s = s[i..].trim_start();
        }
    }
    // `Trait for Type`: the type is what the block belongs to.
    if let Some(i) = s.find(" for ") {
        s = s[i + 5..].trim_start();
    }
    for stop in ['<', '{', ' ', '\t'] {
        if let Some(i) = s.find(stop) {
            s = &s[..i];
        }
    }
    s.trim_end_matches('{').rsplit("::").next().unwrap_or(s).trim().to_string()
}

fn scan_rust(rel: &str, text: &str, out: &mut Vec<Symbol>) {
    let mut stack: Vec<Frame> = Vec::new();
    let mut depth = 0i32;
    for (i, raw) in text.lines().enumerate() {
        let line = strip_comment(raw, "//");
        let t = line.trim_start();
        let delta = brace_delta(line);
        if t.is_empty() || t.starts_with('*') || t.starts_with("/*") || t.starts_with('#') {
            depth += delta;
            unwind(&mut stack, depth);
            continue;
        }
        let container = top(&stack);
        let body = rust_strip_modifiers(t);

        let mut opened: Option<String> = None;
        if let Some(rest) = strip_word(body, "impl") {
            let name = impl_target(rest);
            if !name.is_empty() {
                out.push(Symbol {
                    name: name.clone(),
                    kind: "impl".into(),
                    path: rel.into(),
                    line: i + 1,
                    container: container.clone(),
                });
                opened = Some(name);
            }
        } else if let Some(rest) = body.strip_prefix("macro_rules!") {
            if let Some((name, _)) = ident_at(rest.trim_start()) {
                out.push(Symbol {
                    name: name.into(),
                    kind: "macro".into(),
                    path: rel.into(),
                    line: i + 1,
                    container: container.clone(),
                });
            }
        } else {
            // `const fn` is a function, `const NAME` is a constant: the item
            // keyword is whichever of the two comes second.
            let (kw, rest) = match strip_word(body, "const").and_then(|r| strip_word(r, "fn")) {
                Some(r) => ("fn", Some(r)),
                None => {
                    let table: &[(&str, &str)] = &[
                        ("fn", "fn"),
                        ("struct", "struct"),
                        ("enum", "enum"),
                        ("union", "struct"),
                        ("trait", "trait"),
                        ("mod", "mod"),
                        ("type", "type"),
                        ("const", "const"),
                        ("static", "static"),
                    ];
                    let mut found = ("", None);
                    for (word, kind) in table {
                        if let Some(r) = strip_word(body, word) {
                            found = (kind, Some(r));
                            break;
                        }
                    }
                    found
                }
            };
            if let (true, Some(rest)) = (!kw.is_empty(), rest) {
                if let Some((name, _)) = ident_at(rest) {
                    out.push(Symbol {
                        name: name.into(),
                        kind: kw.into(),
                        path: rel.into(),
                        line: i + 1,
                        container: container.clone(),
                    });
                    if (kw == "trait" || kw == "mod") && delta > 0 {
                        opened = Some(name.to_string());
                    }
                }
            }
        }
        if let Some(name) = opened {
            if delta > 0 {
                stack.push((depth, name));
            }
        }
        depth += delta;
        unwind(&mut stack, depth);
        if out.len() >= MAX_PER_FILE {
            return;
        }
    }
}

// ---------------------------------------------------------------- Python

fn scan_python(rel: &str, text: &str, out: &mut Vec<Symbol>) {
    // (indent column, name): Python nests by indentation, not braces.
    let mut stack: Vec<(usize, String)> = Vec::new();
    for (i, raw) in text.lines().enumerate() {
        let line = strip_comment(raw, "#");
        let t = line.trim_start();
        if t.is_empty() {
            continue;
        }
        let indent = line.chars().take_while(|c| *c == ' ' || *c == '\t').fold(0usize, |a, c| {
            a + if c == '\t' { 4 } else { 1 }
        });
        let (kind, rest) = if let Some(r) = strip_word(t, "class") {
            ("class", r)
        } else if let Some(r) = strip_word(t, "def") {
            ("def", r)
        } else if let Some(r) = strip_word(t, "async").and_then(|r| strip_word(r, "def")) {
            ("def", r)
        } else {
            continue;
        };
        let Some((name, _)) = ident_at(rest) else { continue };
        while stack.last().is_some_and(|(d, _)| *d >= indent) {
            stack.pop();
        }
        out.push(Symbol {
            name: name.into(),
            kind: kind.into(),
            path: rel.into(),
            line: i + 1,
            container: stack.last().map(|(_, n)| n.clone()).unwrap_or_default(),
        });
        stack.push((indent, name.to_string()));
        if out.len() >= MAX_PER_FILE {
            return;
        }
    }
}

// ---------------------------------------------------------------- TypeScript / JavaScript

fn scan_ts(rel: &str, text: &str, out: &mut Vec<Symbol>) {
    let mut stack: Vec<Frame> = Vec::new();
    let mut depth = 0i32;
    for (i, raw) in text.lines().enumerate() {
        let line = strip_comment(raw, "//");
        let t = line.trim_start();
        let delta = brace_delta(line);
        if t.is_empty() || t.starts_with('*') || t.starts_with("/*") {
            depth += delta;
            unwind(&mut stack, depth);
            continue;
        }
        let container = top(&stack);
        // `export`, `export default`, `declare` and `abstract` are noise in
        // front of the declaration keyword; `async` too.
        let mut body = t;
        for word in ["export", "default", "declare", "abstract", "async"] {
            if let Some(r) = strip_word(body, word) {
                body = r;
            }
        }
        // `export async function` puts async after export, so one more pass.
        for word in ["async", "function*"] {
            if let Some(r) = strip_word(body, word) {
                body = r;
            }
        }
        let table: &[(&str, &str)] = &[
            ("function", "function"),
            ("class", "class"),
            ("interface", "interface"),
            ("enum", "enum"),
            ("type", "type"),
            ("const", "const"),
            ("let", "let"),
            ("var", "var"),
        ];
        let mut hit: Option<(&str, &str)> = None;
        for (word, kind) in table {
            if let Some(r) = strip_word(body, word) {
                hit = Some((kind, r));
                break;
            }
        }
        // A bare `const`/`let`/`var` is only indexed when it is exported: every
        // local binding in the project would otherwise drown the index.
        if let Some((kind, rest)) = hit {
            let exported = t.starts_with("export");
            let value_binding = matches!(kind, "const" | "let" | "var");
            if !value_binding || exported {
                let rest = rest.trim_start_matches('*').trim_start();
                if let Some((name, _)) = ident_at(rest) {
                    out.push(Symbol {
                        name: name.into(),
                        kind: kind.into(),
                        path: rel.into(),
                        line: i + 1,
                        container: container.clone(),
                    });
                    if kind == "class" && delta > 0 {
                        stack.push((depth, name.to_string()));
                    }
                }
            }
        }
        depth += delta;
        unwind(&mut stack, depth);
        if out.len() >= MAX_PER_FILE {
            return;
        }
    }
}

// ---------------------------------------------------------------- Markdown

fn scan_markdown(rel: &str, text: &str, out: &mut Vec<Symbol>) {
    let mut stack: Vec<(usize, String)> = Vec::new();
    let mut fenced = false;
    for (i, raw) in text.lines().enumerate() {
        let t = raw.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced || !t.starts_with('#') {
            continue;
        }
        let level = t.chars().take_while(|c| *c == '#').count();
        if level > 6 {
            continue;
        }
        let title = t[level..].trim().trim_end_matches('#').trim();
        if title.is_empty() {
            continue;
        }
        while stack.last().is_some_and(|(l, _)| *l >= level) {
            stack.pop();
        }
        out.push(Symbol {
            name: title.to_string(),
            kind: "heading".into(),
            path: rel.into(),
            line: i + 1,
            container: stack.last().map(|(_, n)| n.clone()).unwrap_or_default(),
        });
        stack.push((level, title.to_string()));
        if out.len() >= MAX_PER_FILE {
            return;
        }
    }
}

// ---------------------------------------------------------------- build

/// Scan the text of one file. Public so the CLI can exercise a single file.
pub fn scan_text(rel: &str, text: &str) -> Vec<Symbol> {
    let ext = Path::new(rel)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let mut out = Vec::new();
    match ext.as_str() {
        "rs" => scan_rust(rel, text, &mut out),
        "py" | "pyi" => scan_python(rel, text, &mut out),
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "mts" | "cts" => scan_ts(rel, text, &mut out),
        "md" | "markdown" => scan_markdown(rel, text, &mut out),
        _ => {}
    }
    out
}

fn read_scannable(full: &Path) -> Option<String> {
    let meta = std::fs::symlink_metadata(full).ok()?;
    if !meta.file_type().is_file() || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let bytes = std::fs::read(full).ok()?;
    if bytes[..bytes.len().min(NUL_PROBE)].contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// Walk the workspace once and return both what the index will be built from
/// and a signature of it.
///
/// The signature folds, for every file the enumeration returns, its relative
/// path, its byte length and its modification time in nanoseconds. That is
/// enough to catch every change that can alter the symbols: a file added,
/// removed, renamed, truncated, grown or rewritten in place. It reads no file
/// content, so it costs one directory walk plus one stat per file, against a
/// full rebuild that reads every byte of every file.
///
/// What it deliberately does NOT catch: an edit that leaves both length and
/// mtime untouched, which means a tool that restores timestamps and happens to
/// keep the size. That is the honest limit of a stat-based check, and it is
/// stated here rather than left to be discovered. `refresh` (the Refresh
/// button, a pull, a checkout) forces a rebuild past it.
fn tree_signature(real: &Path) -> Result<(u64, Vec<String>), String> {
    let files = crate::search::cached_files(real, true)?;
    let mut h = fnv_fold(FNV_SEED, &(files.len() as u64).to_le_bytes());
    for rel in &files {
        h = fnv_fold(h, rel.as_bytes());
        let (len, mtime) = match std::fs::metadata(real.join(rel)) {
            Ok(m) => {
                let stamp = m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    // Nanoseconds, not seconds: two edits inside the same
                    // second are precisely the case a coarse clock hides.
                    .map(|d| d.as_nanos() as u64)
                    .unwrap_or(0);
                (m.len(), stamp)
            }
            // Enumerated but no longer stat-able: that is itself a change, and
            // a sentinel keeps it visible instead of folding it away as zero.
            Err(_) => (u64::MAX, u64::MAX),
        };
        h = fnv_fold(h, &len.to_le_bytes());
        h = fnv_fold(h, &mtime.to_le_bytes());
    }
    Ok((h, files))
}

/// Scan an already-enumerated file list. Split out of `build` so a caller that
/// has just walked the tree for its signature does not walk it a second time.
fn build_from(real: &Path, files: &[String]) -> Vec<Symbol> {
    let mut out: Vec<Symbol> = Vec::new();
    for rel in files {
        if out.len() >= MAX_TOTAL {
            break;
        }
        let full = real.join(rel);
        if !full.starts_with(real) {
            continue;
        }
        let Some(text) = read_scannable(&full) else { continue };
        out.extend(scan_text(rel, &text));
    }
    // Deterministic order, so two runs over an unchanged tree produce the same
    // file byte for byte.
    out.sort_by(|a, b| {
        a.path.cmp(&b.path).then(a.line.cmp(&b.line)).then(a.name.cmp(&b.name))
    });
    out.dedup();
    out
}

/// Build the whole index for a workspace, over the same file list search uses.
///
/// The app itself goes through `index_for`, which walks once and keeps the
/// signature; this entry point exists for `gx-workspace`, which includes this
/// module by path and wants an unconditional build with no cache in the way.
#[allow(dead_code)]
pub fn build(root: &Path) -> Result<Vec<Symbol>, String> {
    let real = std::fs::canonicalize(root).map_err(|e| format!("{}: {e}", root.display()))?;
    let (_, files) = tree_signature(&real)?;
    Ok(build_from(&real, &files))
}

fn root_key(root: &Path) -> Result<String, String> {
    Ok(std::fs::canonicalize(root)
        .map_err(|e| format!("{}: {e}", root.display()))?
        .to_string_lossy()
        .to_string())
}

/// Memory, then disk, then a fresh build. `refresh` forces the build.
///
/// Every cached answer is checked against the tree before it is served. The
/// index used to be handed back on the strength of its existence alone, so
/// after the workspace changed on disk the palette went on offering symbols
/// from files that no longer said that, and "go to definition" landed on the
/// wrong line. Neither the in-memory copy nor the persisted one is trusted
/// without its fingerprint matching what is on disk now.
pub fn index_for(root: &Path, refresh: bool) -> Result<Arc<Vec<Symbol>>, String> {
    let key = root_key(root)?;
    let real = PathBuf::from(&key);
    if !refresh {
        // A fingerprint verified moments ago is taken at its word: this is the
        // per-keystroke path, and it must not walk the tree.
        {
            let cache = memory().lock().unwrap_or_else(|e| e.into_inner());
            if let Some(hit) = cache.get(&key) {
                if hit.checked.elapsed() < FRESHNESS {
                    return Ok(hit.symbols.clone());
                }
            }
        }
        let (fp, files) = tree_signature(&real)?;
        {
            let mut cache = memory().lock().unwrap_or_else(|e| e.into_inner());
            if let Some(hit) = cache.get_mut(&key) {
                if hit.fingerprint == fp {
                    hit.checked = Instant::now();
                    return Ok(hit.symbols.clone());
                }
            }
        }
        if let Some(disk) = load_persisted(&key, fp) {
            let arc = Arc::new(disk);
            memory().lock().unwrap_or_else(|e| e.into_inner()).insert(
                key,
                Cached { fingerprint: fp, checked: Instant::now(), symbols: arc.clone() },
            );
            return Ok(arc);
        }
        // Stale, or nothing stored: rebuild from the list just walked.
        return Ok(store(key, fp, build_from(&real, &files)));
    }
    let (fp, files) = tree_signature(&real)?;
    Ok(store(key, fp, build_from(&real, &files)))
}

/// Persist and memoise a freshly built index. A failed persist must not fail
/// the query: the index is a cache.
fn store(key: String, fingerprint: u64, built: Vec<Symbol>) -> Arc<Vec<Symbol>> {
    let _ = persist(&key, fingerprint, &built);
    let arc = Arc::new(built);
    memory()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(key, Cached { fingerprint, checked: Instant::now(), symbols: arc.clone() });
    arc
}

// ---------------------------------------------------------------- query

/// Is `q` a subsequence of `name`, and how tightly? Used last, so `sfw` still
/// finds `set_folder_watch` when nothing better matched.
fn subsequence_score(name: &str, q: &str) -> Option<i32> {
    let mut chars = name.chars();
    let mut gaps = 0i32;
    for needle in q.chars() {
        let mut skipped = 0i32;
        loop {
            match chars.next() {
                Some(c) if c == needle => break,
                Some(_) => skipped += 1,
                None => return None,
            }
        }
        gaps += skipped;
    }
    Some(300 - gaps.min(250))
}

fn score(name: &str, q: &str) -> Option<i32> {
    let n = name.to_lowercase();
    if n == q {
        return Some(1000);
    }
    if let Some(rest) = n.strip_prefix(q) {
        return Some(800 - (rest.chars().count() as i32).min(200));
    }
    if let Some(pos) = n.find(q) {
        return Some(600 - (pos as i32).min(200));
    }
    subsequence_score(&n, q)
}

pub fn query(root: &Path, q: &str, limit: usize) -> Result<Vec<SymbolHit>, String> {
    let q = q.trim().to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let index = index_for(root, false)?;
    let mut hits: Vec<SymbolHit> = index
        .iter()
        .filter_map(|s| {
            score(&s.name, &q).map(|sc| SymbolHit {
                name: s.name.clone(),
                kind: s.kind.clone(),
                path: s.path.clone(),
                line: s.line,
                container: s.container.clone(),
                score: sc,
            })
        })
        .collect();
    hits.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then(a.name.len().cmp(&b.name.len()))
            .then(a.path.cmp(&b.path))
            .then(a.line.cmp(&b.line))
    });
    hits.truncate(limit.clamp(1, 1000));
    Ok(hits)
}

// ---------------------------------------------------------------- commands

// Both commands walk a directory tree, stat every file in it and, on a miss,
// read and scan all of them. That is filesystem work measured in seconds on a
// large workspace, and running it in the body of an async command parks a
// tokio worker for the whole time: the chat stream, the search events and
// every other command share those workers. It goes on the blocking pool, the
// same way pylang.rs and snapshot.rs already do it.

#[tauri::command]
pub async fn symbols_index(root: String, refresh: bool) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        index_for(Path::new(&root), refresh).map(|i| i.len())
    })
    .await
    .map_err(|e| format!("the symbol index thread died: {e}"))?
}

#[tauri::command]
pub async fn symbols_query(
    root: String,
    q: String,
    limit: Option<usize>,
) -> Result<Vec<SymbolHit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        query(Path::new(&root), &q, limit.unwrap_or(DEFAULT_LIMIT))
    })
    .await
    .map_err(|e| format!("the symbol query thread died: {e}"))?
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    fn names(syms: &[Symbol], kind: &str) -> Vec<String> {
        syms.iter().filter(|s| s.kind == kind).map(|s| s.name.clone()).collect()
    }

    #[test]
    fn rust_declarations_and_containers() {
        let src = r#"
// fn commented_out() {}
use std::fmt;

pub struct Widget { pub id: u32 }

pub enum Mode { On, Off }

pub trait Draw {
    fn draw(&self) -> String;
}

impl Draw for Widget {
    fn draw(&self) -> String { String::new() }
    pub(crate) async unsafe fn risky() {}
}

pub mod inner {
    pub const LIMIT: usize = 4;
    pub const fn limit() -> usize { LIMIT }
}

macro_rules! shout { () => {} }
pub type Alias = Widget;
static COUNT: u32 = 0;
"#;
        let syms = scan_text("a.rs", src);
        assert_eq!(names(&syms, "struct"), vec!["Widget"]);
        assert_eq!(names(&syms, "enum"), vec!["Mode"]);
        assert_eq!(names(&syms, "trait"), vec!["Draw"]);
        assert_eq!(names(&syms, "impl"), vec!["Widget"]);
        assert_eq!(names(&syms, "macro"), vec!["shout"]);
        assert_eq!(names(&syms, "type"), vec!["Alias"]);
        assert_eq!(names(&syms, "mod"), vec!["inner"]);
        assert_eq!(names(&syms, "const"), vec!["LIMIT"]);
        assert_eq!(names(&syms, "static"), vec!["COUNT"]);
        assert_eq!(names(&syms, "fn"), vec!["draw", "draw", "risky", "limit"]);
        assert!(!names(&syms, "fn").contains(&"commented_out".to_string()));

        let draw_impl: Vec<&Symbol> =
            syms.iter().filter(|s| s.name == "draw" && s.container == "Widget").collect();
        assert_eq!(draw_impl.len(), 1, "the impl body's fn lost its container");
        let in_trait: Vec<&Symbol> =
            syms.iter().filter(|s| s.name == "draw" && s.container == "Draw").collect();
        assert_eq!(in_trait.len(), 1, "the trait body's fn lost its container");
        let limit_fn = syms.iter().find(|s| s.name == "limit").unwrap();
        assert_eq!(limit_fn.container, "inner");
        assert_eq!(limit_fn.kind, "fn", "`const fn` was indexed as a constant");
    }

    #[test]
    fn python_declarations_nest_by_indentation() {
        let src = "class Robot:\n    def walk(self):\n        pass\n\n    async def run(self):\n        def inner():\n            pass\n\ndef free():\n    pass\n# def commented(): pass\n";
        let syms = scan_text("a.py", src);
        assert_eq!(names(&syms, "class"), vec!["Robot"]);
        assert_eq!(names(&syms, "def"), vec!["walk", "run", "inner", "free"]);
        let by = |n: &str| syms.iter().find(|s| s.name == n).unwrap().container.clone();
        assert_eq!(by("walk"), "Robot");
        assert_eq!(by("run"), "Robot");
        assert_eq!(by("inner"), "run");
        assert_eq!(by("free"), "");
        assert!(!names(&syms, "def").contains(&"commented".to_string()));
    }

    #[test]
    fn typescript_exports_and_bare_declarations() {
        let src = concat!(
            "export interface CodeEntry { name: string }\n",
            "export type Lang = \"en\" | \"fr\";\n",
            "export const dict = {};\n",
            "const privateThing = 1;\n",
            "export default class Agent {\n",
            "  run() {}\n",
            "}\n",
            "export async function boot(): Promise<void> {}\n",
            "function helper() {}\n",
            "// function commented() {}\n",
        );
        let syms = scan_text("a.ts", src);
        assert_eq!(names(&syms, "interface"), vec!["CodeEntry"]);
        assert_eq!(names(&syms, "type"), vec!["Lang"]);
        assert_eq!(names(&syms, "const"), vec!["dict"], "a non-exported const leaked in");
        assert_eq!(names(&syms, "class"), vec!["Agent"]);
        assert_eq!(names(&syms, "function"), vec!["boot", "helper"]);
        assert!(!syms.iter().any(|s| s.name == "privateThing"));
        assert!(!syms.iter().any(|s| s.name == "commented"));
    }

    #[test]
    fn markdown_headings_nest_and_skip_fenced_code() {
        let src = "# Title\n\ntext\n\n## Section\n\n```sh\n# not a heading\n```\n\n### Detail ###\n\n# Second\n";
        let syms = scan_text("a.md", src);
        let titles: Vec<&str> = syms.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(titles, vec!["Title", "Section", "Detail", "Second"]);
        let by = |n: &str| syms.iter().find(|s| s.name == n).unwrap().container.clone();
        assert_eq!(by("Section"), "Title");
        assert_eq!(by("Detail"), "Section");
        assert_eq!(by("Second"), "");
    }

    #[test]
    fn a_url_in_a_string_is_not_a_comment() {
        let src = "const url = \"https://example.com//x\";\nexport function after() {}\n";
        let syms = scan_text("a.ts", src);
        assert_eq!(names(&syms, "function"), vec!["after"]);
    }

    #[test]
    fn ranking_prefers_exact_then_prefix_then_substring() {
        assert!(score("run", "run").unwrap() > score("runner", "run").unwrap());
        assert!(score("runner", "run").unwrap() > score("prerun", "run").unwrap());
        assert!(score("prerun", "run").unwrap() > score("r_u_n", "run").unwrap());
        assert!(score("nothing", "zzz").is_none());
    }

    #[test]
    fn an_unsupported_extension_yields_nothing_rather_than_guessing() {
        assert!(scan_text("a.swift", "func hello() {}").is_empty());
        assert!(scan_text("Makefile", "all:\n\techo hi").is_empty());
    }

    // ------------------------------------------------------------ staleness

    use crate::search::testutil::{temp_tree, write};

    /// Move the whole tree's mtime forward. The check reads modification time
    /// with nanosecond resolution, but a test that edits a file microseconds
    /// after creating it can still land on the same coarse timestamp on a
    /// filesystem that only stores seconds. Stamping explicitly makes the test
    /// about the staleness logic, not about the host filesystem's clock.
    fn bump_mtime(path: &Path, secs_ahead: u64) {
        let when = SystemTime::now() + Duration::from_secs(secs_ahead);
        let f = std::fs::File::options().write(true).open(path).expect("open for touch");
        f.set_modified(when).expect("set mtime");
    }

    #[test]
    fn an_edited_file_invalidates_the_persisted_index() {
        let base = temp_tree("symstale");
        let root = base.join("root");
        write(&root.join("a.rs"), b"pub fn before_edit() {}\n");

        let first = index_for(&root, false).expect("first index");
        assert_eq!(
            first.iter().map(|s| s.name.clone()).collect::<Vec<_>>(),
            vec!["before_edit".to_string()]
        );
        let key = root_key(&root).unwrap();
        let (fp_before, _) = tree_signature(Path::new(&key)).unwrap();

        // The workspace changes on disk, exactly the case that used to be
        // served from the cache as if nothing had happened.
        write(&root.join("a.rs"), b"pub fn after_edit() {}\n");
        bump_mtime(&root.join("a.rs"), 5);

        let (fp_after, _) = tree_signature(Path::new(&key)).unwrap();
        assert_ne!(fp_before, fp_after, "an edited file left the signature unchanged");

        // The persisted document is still the old one, and must be refused.
        assert!(
            load_persisted(&key, fp_after).is_none(),
            "the stale persisted index was accepted as current"
        );
        assert!(
            load_persisted(&key, fp_before).is_some(),
            "the persisted index does not carry its own signature"
        );

        // Drop the in-memory copy's grace window so the check actually runs,
        // then confirm the query returns the NEW symbol, not the old one.
        memory()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(&key)
            .expect("cached")
            .checked = Instant::now() - FRESHNESS - Duration::from_secs(1);

        let second = index_for(&root, false).expect("second index");
        assert_eq!(
            second.iter().map(|s| s.name.clone()).collect::<Vec<_>>(),
            vec!["after_edit".to_string()],
            "a stale index was served after the workspace changed"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_added_and_a_removed_file_both_move_the_signature() {
        let base = temp_tree("symsig");
        let root = base.join("root");
        write(&root.join("a.rs"), b"pub fn one() {}\n");
        let (start, _) = tree_signature(&std::fs::canonicalize(&root).unwrap()).unwrap();

        write(&root.join("b.rs"), b"pub fn two() {}\n");
        let real = std::fs::canonicalize(&root).unwrap();
        let (added, _) = tree_signature(&real).unwrap();
        assert_ne!(start, added, "a new file left the signature unchanged");

        std::fs::remove_file(root.join("b.rs")).unwrap();
        let (removed, _) = tree_signature(&real).unwrap();
        assert_eq!(start, removed, "removing the file did not restore the signature");

        let _ = std::fs::remove_dir_all(&base);
    }
}
