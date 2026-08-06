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
                snippet: snippet_of(&chunk.text, SNIPPET_MAX),
                score,
                line: chunk.line,
            }
        })
        .collect()
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
    let folders = configured_folders();
    if folders.is_empty() {
        return Err("no knowledge folders configured".to_string());
    }
    let index = build_index(&folders)?;
    persist_index(&index)?;
    let stats = index.stats();
    *kb_state().lock().unwrap_or_else(|e| e.into_inner()) = Some(index);
    Ok(stats)
}

/// Stats of the last built index: memory first, disk otherwise.
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

/// BM25 top-k search. Index resolution order: memory, then disk (if built
/// for the current folders), then a fresh reindex.
#[tauri::command]
pub async fn kb_search(query: String, k: Option<usize>) -> Result<Vec<KbHit>, String> {
    let folders = configured_folders();
    if folders.is_empty() {
        return Err("no knowledge folders configured".to_string());
    }
    let k = k.unwrap_or(DEFAULT_K).max(1);
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
    Ok(bm25_search(index, &query, k))
}
