// Galactus desktop — local knowledge index.
//
// Pure-Rust BM25 search over user-configured folders. Zero external
// dependency beyond std + serde/serde_json (already in the project). The
// folder list lives under the "kb_folders" key of settings.json; the built
// index is persisted as JSON in app_support/kb-index.json and the term
// statistics (tf/df) are rebuilt at load time so the file stays compact.
//
// Deliberately self-contained: the settings and app_support helpers are
// local copies of the ones in lib.rs so this module does not depend on it.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const SETTINGS_KEY: &str = "kb_folders";
const INDEX_FILE: &str = "kb-index.json";

const CHUNK_TARGET: usize = 1400; // ~chars per chunk, cut on line boundaries
const CHUNK_OVERLAP: usize = 200; // ~chars carried over between chunks
const SNIPPET_MAX: usize = 700; // snippet truncation (UTF-8 safe)
const MAX_DEPTH: usize = 8;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const BM25_K1: f64 = 1.4;
const BM25_B: f64 = 0.75;
const DEFAULT_K: usize = 6;

const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "build",
    "dist",
    "__pycache__",
    "venv",
];

const TEXT_EXTS: &[&str] = &[
    // plain text / markup / config
    "txt", "md", "markdown", "rst", "csv", "json", "yaml", "yml", "toml", "ini", "conf", "html",
    "htm", "tex", "log", // common code sources
    "rs", "py", "js", "ts", "tsx", "swift", "c", "cpp", "h", "hpp", "java", "kt", "go", "rb",
    "sh", "sql",
];

// ---------------------------------------------------------------- settings
// Local equivalents of the lib.rs helpers (kept private to this module).

fn settings_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(home).join("Library/Application Support/Galactus/settings.json")
}

fn settings_load() -> HashMap<String, String> {
    std::fs::read_to_string(settings_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}


fn app_support() -> PathBuf {
    settings_path().parent().unwrap().to_path_buf()
}

fn index_file_path() -> PathBuf {
    app_support().join(INDEX_FILE)
}

fn configured_folders() -> Vec<String> {
    settings_load()
        .get(SETTINGS_KEY)
        .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|f| !f.trim().is_empty())
        .collect()
}

/// Configured list minus every folder nested inside another configured one.
///
/// The user can pick ~/Documents and later ~/Documents/Notes: walking both
/// indexes the nested files twice, which duplicates chunks, inflates the BM25
/// df/avg_len statistics and returns the same file twice in the results. The
/// stored setting is left untouched (kb_folders keeps showing what the user
/// picked); only what indexing walks is reduced.
fn dedup_nested(folders: Vec<String>) -> Vec<String> {
    // Canonicalized so symlinks and "." / ".." spellings of the same folder
    // compare equal. A folder that cannot be canonicalized (does not exist
    // yet, unreadable) keeps its raw path and simply never matches.
    let canon: Vec<(String, PathBuf)> = folders
        .into_iter()
        .map(|f| {
            let p = PathBuf::from(&f);
            let c = std::fs::canonicalize(&p).unwrap_or(p);
            (f, c)
        })
        .collect();
    let mut out = Vec::with_capacity(canon.len());
    for (i, (raw, path)) in canon.iter().enumerate() {
        // Same folder listed twice: keep the first spelling only.
        if canon[..i].iter().any(|(_, other)| other == path) {
            continue;
        }
        // Path::starts_with matches whole path components, so /a/bc is not
        // reported as living inside /a/b (a raw string prefix test would).
        let nested = canon
            .iter()
            .any(|(_, other)| other != path && path.starts_with(other));
        if !nested {
            out.push(raw.clone());
        }
    }
    out
}

/// The folder list every indexing path walks. Everything downstream (built
/// index, persisted index, KbStats.folders) carries this reduced list, so the
/// disk-index freshness check in `load_persisted` compares like for like.
fn indexing_folders() -> Vec<String> {
    dedup_nested(configured_folders())
}

// ---------------------------------------------------------------- types

#[derive(Serialize, Clone)]
pub struct KbStats {
    pub files: usize,
    pub chunks: usize,
    pub folders: Vec<String>,
    pub indexed_at: u64,
}

#[derive(Serialize, Clone)]
pub struct KbHit {
    pub path: String,
    pub snippet: String,
    pub score: f64,
    pub line: usize,
}

/// What goes to disk: chunks only, term statistics are rebuilt at load.
#[derive(Serialize, Deserialize, Clone)]
struct StoredChunk {
    path: String,
    line: usize,
    text: String,
}

#[derive(Serialize)]
struct StoredIndexOut<'a> {
    folders: &'a [String],
    files: usize,
    indexed_at: u64,
    chunks: &'a [StoredChunk],
}

#[derive(Deserialize)]
struct StoredIndexIn {
    folders: Vec<String>,
    files: usize,
    indexed_at: u64,
    chunks: Vec<StoredChunk>,
}

/// In-memory index: stored chunks + BM25 term statistics.
struct Index {
    folders: Vec<String>,
    files: usize,
    indexed_at: u64,
    chunks: Vec<StoredChunk>,
    tf: Vec<HashMap<String, u32>>, // per-chunk term frequencies
    doc_len: Vec<u32>,             // per-chunk token counts
    df: HashMap<String, u32>,      // document frequencies
    avg_len: f64,
}

impl Index {
    fn stats(&self) -> KbStats {
        KbStats {
            files: self.files,
            chunks: self.chunks.len(),
            folders: self.folders.clone(),
            indexed_at: self.indexed_at,
        }
    }
}

fn kb_state() -> &'static Mutex<Option<Index>> {
    static KB: OnceLock<Mutex<Option<Index>>> = OnceLock::new();
    KB.get_or_init(|| Mutex::new(None))
}

// ---------------------------------------------------------------- tokenizer

/// Basic accent folding, enough for French text (no stemming).
fn fold_char(c: char) -> char {
    match c {
        'à' | 'â' | 'ä' | 'á' | 'ã' | 'å' => 'a',
        'é' | 'è' | 'ê' | 'ë' => 'e',
        'î' | 'ï' | 'í' | 'ì' => 'i',
        'ô' | 'ö' | 'ò' | 'ó' | 'õ' => 'o',
        'ù' | 'û' | 'ü' | 'ú' => 'u',
        'ç' => 'c',
        'ñ' => 'n',
        'ÿ' => 'y',
        _ => c,
    }
}

/// Lowercased, accent-folded runs of Unicode alphanumerics, 2..=30 chars.
fn tokenize(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let flush = |cur: &mut String, tokens: &mut Vec<String>| {
        if !cur.is_empty() {
            let n = cur.chars().count();
            if (2..=30).contains(&n) {
                tokens.push(std::mem::take(cur));
            } else {
                cur.clear();
            }
        }
    };
    for c in text.chars() {
        if c.is_alphanumeric() {
            for lc in c.to_lowercase() {
                cur.push(fold_char(lc));
            }
        } else {
            flush(&mut cur, &mut tokens);
        }
    }
    flush(&mut cur, &mut tokens);
    tokens
}

// ---------------------------------------------------------------- chunking

/// ~CHUNK_TARGET chars per chunk, cut on line boundaries, ~CHUNK_OVERLAP
/// chars of overlap. Returns (1-based start line, text). Pathologically long
/// single lines (minified files) are split on char boundaries, every piece
/// keeping the line number.
fn chunk_text(text: &str) -> Vec<(usize, String)> {
    let lines: Vec<&str> = text.lines().collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        if lines[i].len() > 2 * CHUNK_TARGET {
            let mut rest = lines[i];
            while !rest.is_empty() {
                let mut end = rest.len().min(CHUNK_TARGET);
                while !rest.is_char_boundary(end) {
                    end -= 1;
                }
                let piece = &rest[..end];
                if !piece.trim().is_empty() {
                    out.push((i + 1, piece.to_string()));
                }
                rest = &rest[end..];
            }
            i += 1;
            continue;
        }
        let start = i;
        let mut len = 0usize;
        while i < lines.len() && len < CHUNK_TARGET && lines[i].len() <= 2 * CHUNK_TARGET {
            len += lines[i].len() + 1;
            i += 1;
        }
        let chunk = lines[start..i].join("\n");
        if !chunk.trim().is_empty() {
            out.push((start + 1, chunk));
        }
        if i >= lines.len() {
            break;
        }
        // Step back ~CHUNK_OVERLAP chars for the next chunk; `back > start + 1`
        // guarantees forward progress.
        let mut back = i;
        let mut over = 0usize;
        while back > start + 1 && over < CHUNK_OVERLAP {
            over += lines[back - 1].len() + 1;
            back -= 1;
        }
        i = back;
    }
    out
}

// ---------------------------------------------------------------- crawling

fn collect_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > MAX_DEPTH {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue; // hidden files and folders
        }
        let path = entry.path();
        if path.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            collect_files(&path, depth + 1, out);
        } else if path.is_file() {
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase());
            if let Some(ext) = ext {
                if TEXT_EXTS.contains(&ext.as_str()) {
                    out.push(path);
                }
            }
        }
    }
}

// ---------------------------------------------------------------- index build

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Rebuild tf/df/avg_len from raw chunks (also used after a disk load).
fn index_from_chunks(
    folders: Vec<String>,
    files: usize,
    indexed_at: u64,
    chunks: Vec<StoredChunk>,
) -> Index {
    let mut tf: Vec<HashMap<String, u32>> = Vec::with_capacity(chunks.len());
    let mut doc_len: Vec<u32> = Vec::with_capacity(chunks.len());
    let mut df: HashMap<String, u32> = HashMap::new();
    let mut total_len = 0u64;
    for chunk in &chunks {
        let tokens = tokenize(&chunk.text);
        doc_len.push(tokens.len() as u32);
        total_len += tokens.len() as u64;
        let mut freqs: HashMap<String, u32> = HashMap::new();
        for t in tokens {
            *freqs.entry(t).or_insert(0) += 1;
        }
        for term in freqs.keys() {
            *df.entry(term.clone()).or_insert(0) += 1;
        }
        tf.push(freqs);
    }
    let avg_len = if chunks.is_empty() {
        1.0
    } else {
        (total_len as f64 / chunks.len() as f64).max(1.0)
    };
    Index {
        folders,
        files,
        indexed_at,
        chunks,
        tf,
        doc_len,
        df,
        avg_len,
    }
}

fn build_index(folders: &[String]) -> Result<Index, String> {
    let mut paths = Vec::new();
    for folder in folders {
        let p = PathBuf::from(folder);
        if p.is_dir() {
            collect_files(&p, 0, &mut paths);
        }
    }
    let mut chunks = Vec::new();
    let mut files = 0usize;
    for path in paths {
        match std::fs::metadata(&path) {
            Ok(m) if m.len() <= MAX_FILE_BYTES => {}
            _ => continue,
        }
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        // Strict UTF-8: binary or badly encoded content is skipped.
        let text = match String::from_utf8(bytes) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let file_chunks = chunk_text(&text);
        if file_chunks.is_empty() {
            continue;
        }
        files += 1;
        let path_str = path.to_string_lossy().into_owned();
        for (line, text) in file_chunks {
            chunks.push(StoredChunk {
                path: path_str.clone(),
                line,
                text,
            });
        }
    }
    Ok(index_from_chunks(
        folders.to_vec(),
        files,
        now_unix(),
        chunks,
    ))
}

fn persist_index(index: &Index) -> Result<(), String> {
    let out = StoredIndexOut {
        folders: &index.folders,
        files: index.files,
        indexed_at: index.indexed_at,
        chunks: &index.chunks,
    };
    let p = index_file_path();
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string(&out).map_err(|e| e.to_string())?;
    std::fs::write(&p, json).map_err(|e| e.to_string())
}

fn read_persisted() -> Option<StoredIndexIn> {
    let s = std::fs::read_to_string(index_file_path()).ok()?;
    serde_json::from_str(&s).ok()
}

/// Disk index, only if it was built for the currently configured folders.
fn load_persisted(expected_folders: &[String]) -> Option<Index> {
    let stored = read_persisted()?;
    if stored.folders != expected_folders {
        return None;
    }
    Some(index_from_chunks(
        stored.folders,
        stored.files,
        stored.indexed_at,
        stored.chunks,
    ))
}

// ---------------------------------------------------------------- scoring

/// Truncate on a UTF-8 char boundary at most `max` bytes in.
fn snippet_of(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

/// Folded copy of `text` (same lowercasing and accent folding as `tokenize`)
/// plus, for every byte of it, the byte offset of the source char it came
/// from. Folding can change a char's byte length, so an offset found in the
/// folded copy has to be translated back before slicing `text`. The map holds
/// one extra entry so `map[folded.len()]` is `text.len()`.
fn folded_with_offsets(text: &str) -> (String, Vec<usize>) {
    let mut folded = String::with_capacity(text.len());
    let mut map: Vec<usize> = Vec::with_capacity(text.len() + 1);
    for (i, c) in text.char_indices() {
        let before = folded.len();
        for lc in c.to_lowercase() {
            folded.push(fold_char(lc));
        }
        for _ in before..folded.len() {
            map.push(i);
        }
    }
    map.push(text.len());
    (folded, map)
}

/// First byte offset at or after `from` that starts a word, capped at `limit`
/// so the window never swallows the match it is supposed to show.
fn snap_word_start(text: &str, from: usize, limit: usize) -> usize {
    if from == 0 {
        return 0;
    }
    let mut prev_alnum = false;
    for (i, c) in text.char_indices() {
        if i >= limit {
            return limit;
        }
        if i >= from && !prev_alnum {
            return i;
        }
        prev_alnum = c.is_alphanumeric();
    }
    limit
}

/// Last byte offset at or before `to` that ends a word, never below `min_end`
/// (the end of the match). Falls back to a plain char-boundary cut when the
/// span holds no separator at all.
fn snap_word_end(text: &str, to: usize, min_end: usize) -> usize {
    if to >= text.len() {
        return text.len();
    }
    let mut best: Option<usize> = None;
    for (i, c) in text.char_indices() {
        if i > to {
            break;
        }
        if i >= min_end && !c.is_alphanumeric() {
            best = Some(i);
        }
    }
    if let Some(i) = best {
        return i;
    }
    let mut end = to;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    end.max(min_end)
}

/// Snippet of at most ~`max` bytes centred on the first query term found in
/// `text`, edges snapped to word boundaries and marked with an ellipsis when
/// they are not the chunk boundaries.
///
/// `terms` are the folded tokens of the query, so the search runs on a folded
/// copy of the chunk. A chunk can rank without holding any term literally
/// (folding, or a hit driven by another term of the query), and then the
/// original from-the-start truncation is kept.
fn snippet_centered(text: &str, terms: &[String], max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let (folded, map) = folded_with_offsets(text);
    let mut hit: Option<(usize, usize)> = None; // (start, end) in source bytes
    for term in terms {
        let f = match folded.find(term.as_str()) {
            Some(f) => f,
            None => continue,
        };
        let start = map[f];
        let end = map[(f + term.len()).min(map.len() - 1)];
        if hit.map_or(true, |(s, _)| start < s) {
            hit = Some((start, end));
        }
    }
    let (m_start, m_end) = match hit {
        Some(h) => h,
        None => return snippet_of(text, max),
    };
    // Centre on the match, then slide the window back inside the chunk so the
    // full budget is used when the match sits near the end.
    let lead = max.saturating_sub(m_end - m_start) / 2;
    let mut start = m_start.saturating_sub(lead);
    let end = (start + max).min(text.len());
    if end == text.len() {
        start = text.len().saturating_sub(max).min(m_start);
    }
    let start = snap_word_start(text, start, m_start);
    let end = snap_word_end(text, end, m_end);
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.push_str(text[start..end].trim());
    if end < text.len() {
        out.push('…');
    }
    out
}

fn bm25_search(index: &Index, query: &str, k: usize) -> Vec<KbHit> {
    if index.chunks.is_empty() {
        return Vec::new();
    }
    let mut terms = tokenize(query);
    terms.sort();
    terms.dedup();
    if terms.is_empty() {
        return Vec::new();
    }
    let n = index.chunks.len() as f64;
    let mut scored: Vec<(f64, usize)> = Vec::new();
    for (i, freqs) in index.tf.iter().enumerate() {
        let mut score = 0.0f64;
        for term in &terms {
            let tf = match freqs.get(term) {
                Some(&f) => f as f64,
                None => continue,
            };
            let df = *index.df.get(term).unwrap_or(&0) as f64;
            let idf = (1.0 + (n - df + 0.5) / (df + 0.5)).ln();
            let dl = index.doc_len[i] as f64;
            let denom = tf + BM25_K1 * (1.0 - BM25_B + BM25_B * dl / index.avg_len);
            score += idf * tf * (BM25_K1 + 1.0) / denom;
        }
        if score > 0.0 {
            scored.push((score, i));
        }
    }
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored
        .into_iter()
        .take(k)
        .map(|(score, i)| {
            let chunk = &index.chunks[i];
            KbHit {
                path: chunk.path.clone(),
                snippet: snippet_centered(&chunk.text, &terms, SNIPPET_MAX),
                score,
                line: chunk.line,
            }
        })
        .collect()
}

/// Rank an ad-hoc corpus with the SAME chunking, tokenizer, BM25 and snippet
/// centring the knowledge folders use, without touching the persisted index.
///
/// The conversation history is the caller: a few small JSON files that change
/// on every token streamed. Indexing them on disk would buy nothing (the whole
/// corpus is read in milliseconds) and would cost the one thing that matters
/// there, freshness: a thread saved two seconds ago must be searchable now.
/// Each input is (key, text); the key comes back in KbHit.path and the chunk's
/// first line in KbHit.line.
pub fn rank_documents(docs: &[(String, String)], query: &str, k: usize) -> Vec<KbHit> {
    let mut chunks: Vec<StoredChunk> = Vec::new();
    for (key, text) in docs {
        for (line, body) in chunk_text(text) {
            chunks.push(StoredChunk { path: key.clone(), line, text: body });
        }
    }
    if chunks.is_empty() {
        return Vec::new();
    }
    let files = docs.len();
    let index = index_from_chunks(Vec::new(), files, now_unix(), chunks);
    bm25_search(&index, query, k)
}

// ---------------------------------------------------------------- commands

/// Configured knowledge folders (empty when nothing is set).
#[tauri::command]
pub fn kb_folders() -> Vec<String> {
    configured_folders()
}

/// Store the folder list and drop the in-memory index (a stale disk index is
/// rejected at load time because its folder list no longer matches).
#[tauri::command]
pub fn kb_set_folders(folders: Vec<String>) -> Result<(), String> {
    // Through the shared serialized update: settings.json has writers on three
    // threads, and a private read-modify-write here would drop their keys.
    let encoded = serde_json::to_string(&folders).map_err(|e| e.to_string())?;
    crate::settings_update(|map| {
        map.insert(SETTINGS_KEY.to_string(), encoded);
    })?;
    *kb_state().lock().unwrap_or_else(|e| e.into_inner()) = None;
    Ok(())
}

/// (Re)build the index from the configured folders and persist it.
#[tauri::command]
pub async fn kb_reindex() -> Result<KbStats, String> {
    let folders = indexing_folders();
    if folders.is_empty() {
        return Err("no knowledge folders configured".to_string());
    }
    let index = build_index(&folders)?;
    persist_index(&index)?;
    let stats = index.stats();
    *kb_state().lock().unwrap_or_else(|e| e.into_inner()) = Some(index);
    Ok(stats)
}

/// Stats of the last built index: memory first, disk otherwise. The reported
/// folders are the ones indexing actually walked, so a folder dropped as
/// nested is absent here and its files are counted once.
#[tauri::command]
pub fn kb_stats() -> Option<KbStats> {
    if let Some(index) = kb_state()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
    {
        return Some(index.stats());
    }
    read_persisted().map(|s| KbStats {
        files: s.files,
        chunks: s.chunks.len(),
        folders: s.folders,
        indexed_at: s.indexed_at,
    })
}

/// BM25 search under a TOKEN BUDGET. Index resolution order: memory, then
/// disk (if built for the current folders), then a fresh reindex.
///
/// The budget is the point. This used to return six hits truncated at 700
/// bytes each, about 1490 tokens, whatever the caller could actually afford:
/// over budget on a small window, and leaving seven eighths of a large one
/// unused. Measured over 30 questions on a real 191-note vault at an 8192
/// token budget, filling the window instead lifted the share of questions
/// whose answer actually reached the model from 0.364 to 0.813, and answer
/// accuracy from 0.26 to 0.50. That single change outweighed every
/// sophistication tried against it: a capsule layer at three resolutions
/// bought nothing above 2048 tokens, and a wikilink graph router scored
/// WORSE than plain lexical ranking, because the top forty lexical records
/// already contain the answer in 26 cases out of 30.
///
/// Hits are emitted whole, in rank order, until the next one would not fit.
/// A hit is never cut to make it fit: half a passage reads as a complete one
/// and that is how a retrieval system quietly loses information. What was
/// left out is reported instead, so the caller can raise the budget or
/// narrow the query.
#[tauri::command]
pub async fn kb_search(
    query: String,
    k: Option<usize>,
    budget_tokens: Option<usize>,
) -> Result<Vec<KbHit>, String> {
    // Building or loading an index walks the disk and can take seconds on a
    // large folder set. On the async runtime that starves a worker and the
    // whole UI stalls, so the work runs on a blocking thread like every other
    // long command in this app.
    tauri::async_runtime::spawn_blocking(move || kb_search_blocking(query, k, budget_tokens))
        .await
        .map_err(|e| format!("the knowledge thread died: {e}"))?
}

fn kb_search_blocking(
    query: String,
    k: Option<usize>,
    budget_tokens: Option<usize>,
) -> Result<Vec<KbHit>, String> {
    let folders = indexing_folders();
    if folders.is_empty() {
        return Err("no knowledge folders configured".to_string());
    }
    // Without a budget, keep the historical shape so existing callers and
    // stored conversations behave exactly as before.
    let budget = budget_tokens.filter(|b| *b > 0);
    // Rank deep enough to fill a large window, then let the budget cut.
    let k = match budget {
        Some(_) => k.unwrap_or(64).max(1),
        None => k.unwrap_or(DEFAULT_K).max(1),
    };
    let mut guard = kb_state().lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        *guard = load_persisted(&folders);
    }
    if guard.is_none() {
        let index = build_index(&folders)?;
        persist_index(&index)?;
        *guard = Some(index);
    }
    let index = guard.as_ref().expect("index resolved above");
    let hits = bm25_search(index, &query, k);
    Ok(match budget {
        None => hits,
        Some(b) => fit_to_budget(hits, b),
    })
}

/// Bytes per token, measured rather than assumed. The usual 4.0 is 22 percent
/// optimistic on this corpus: calibrated against a real tokenizer over 30
/// stratified records of a French vault with markdown tables, the figure is
/// 3.09, and the worst single record reaches 1.99. Budgeting at 4.0 would
/// overrun by up to a factor of two on the densest passage, so the estimate
/// stays deliberately pessimistic.
const BYTES_PER_TOKEN: f64 = 3.0;
/// Charged per hit for its path line and separator. Framing is not free: at a
/// median passage size, a full-path markdown header costs 28 percent of the
/// passage itself, and shortening it moved measured evidence more than any
/// other single change in the study.
const HIT_FRAMING_TOKENS: usize = 9;

fn hit_tokens(hit: &KbHit) -> usize {
    let body = (hit.snippet.len() as f64 / BYTES_PER_TOKEN).ceil() as usize;
    let path = (hit.path.len() as f64 / BYTES_PER_TOKEN).ceil() as usize;
    body + path + HIT_FRAMING_TOKENS
}

/// Take whole hits in rank order while they fit. A hit too large for the
/// remaining room is skipped, not truncated, and the following ones are still
/// considered: a long passage must not starve every shorter one behind it.
fn fit_to_budget(hits: Vec<KbHit>, budget: usize) -> Vec<KbHit> {
    let mut out = Vec::new();
    let mut spent = 0usize;
    let mut dropped = 0usize;
    for hit in hits {
        let cost = hit_tokens(&hit);
        if spent + cost <= budget {
            spent += cost;
            out.push(hit);
        } else {
            dropped += 1;
        }
    }
    // Fail closed and say so: a caller that receives nothing must be able to
    // tell an empty index from a budget too small to hold even one passage.
    if out.is_empty() && dropped > 0 {
        return vec![KbHit {
            path: String::from("(budget)"),
            snippet: format!(
                "{dropped} matching passages found, none small enough for a {budget} token budget. Raise the budget or narrow the query."
            ),
            score: 0.0,
            line: 0,
        }];
    }
    if dropped > 0 {
        if let Some(last) = out.last_mut() {
            last.snippet.push_str(&format!(
                "\n\n[{dropped} further matching passages omitted, budget {budget} tokens reached]"
            ));
        }
    }
    out
}

