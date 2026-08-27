// Les fils de discussion sur le disque, et la recherche dedans.
//
// Sorti de lib.rs avec sa banniere. Un fil est un JSON par conversation; la
// recherche est un grep borne sur ces fichiers, avec extraits et rang, plutot
// qu'un index a tenir a jour pour un corpus de cette taille.

use crate::*;

fn conv_dir() -> PathBuf {
    app_support().join("conversations")
}

/// Conversations are plain JSON files, one per thread, plus a lightweight
/// index rebuilt from them on demand. Shared context across threads comes from
/// the memory file, which every conversation reads.
/// The conversation list, from a cache keyed on each file's stamp.
///
/// It used to open, read and parse EVERY conversation file to keep five fields
/// from each, on the main thread, and it is called at the end of every turn of
/// every thread. At five hundred conversations of three hundred kilobytes that
/// is a hundred and fifty megabytes read and parsed after each answer, and it
/// grows and never comes down.
///
/// The cache is keyed on size and modification time, so a file rewritten by
/// another process is picked up, and nothing has to be invalidated by hand.
/// `async` as well, since a cold start still reads the folder.
#[tauri::command(async)]
pub fn conv_list() -> Vec<Value> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (String, Value)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let dir = conv_dir();
    let mut out: Vec<Value> = Vec::new();
    let mut seen: Vec<PathBuf> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().map(|x| x != "json").unwrap_or(true) {
                continue;
            }
            let stamp = e
                .metadata()
                .ok()
                .map(|m| {
                    let modified = m
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_nanos())
                        .unwrap_or(0);
                    format!("{}:{modified}", m.len())
                })
                .unwrap_or_default();
            seen.push(p.clone());
            if let Ok(map) = cache.lock() {
                if let Some((known, value)) = map.get(&p) {
                    if *known == stamp {
                        out.push(value.clone());
                        continue;
                    }
                }
            }
            let Ok(txt) = std::fs::read_to_string(&p) else { continue };
            let Ok(v) = serde_json::from_str::<Value>(&txt) else { continue };
            let summary = json!({
                "id": v["id"].clone(),
                "title": v["title"].clone(),
                "created": v["created"].clone(),
                "updated": v["updated"].clone(),
                "count": v["items"].as_array().map(|a| a.len()).unwrap_or(0),
            });
            if let Ok(mut map) = cache.lock() {
                map.insert(p.clone(), (stamp, summary.clone()));
            }
            out.push(summary);
        }
    }
    // Forget what is gone, so a deleted conversation does not hold memory for
    // the rest of the session.
    if let Ok(mut map) = cache.lock() {
        map.retain(|k, _| seen.contains(k));
    }
    out.sort_by(|a, b| {
        b["updated"]
            .as_u64()
            .unwrap_or(0)
            .cmp(&a["updated"].as_u64().unwrap_or(0))
    });
    out
}

#[tauri::command]
pub fn conv_load(id: String) -> Result<Value, String> {
    let p = conv_dir().join(format!("{}.json", sanitize_id(&id)));
    let txt = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    serde_json::from_str(&txt).map_err(|e| e.to_string())
}

/// Atomic per-thread write: temp file in the same directory, then rename.
///
/// Several conversations now stream at the same time, each saving on its own
/// debounce. They target distinct files, so they cannot overwrite each other,
/// but a plain write that is interrupted mid-way (quit, crash, full disk)
/// leaves a truncated JSON that reopens as a lost thread. The rename is
/// atomic on APFS, so a reader sees either the old file or the new one.
#[tauri::command]
pub fn conv_save(id: String, data: String) -> Result<(), String> {
    let dir = conv_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe = sanitize_id(&id);
    let p = dir.join(format!("{safe}.json"));
    let tmp = dir.join(format!(".{safe}.{}.tmp", std::process::id()));
    // Written, forced to the platter, and only then renamed. The rename alone
    // is atomic with respect to a READER, which is what it was there for, but
    // it says nothing about a power cut: rename metadata can land while the
    // data behind it has not, and the conversation reopens as a valid name
    // pointing at zeros. Same order as settings_write and memory_store, which
    // is the pattern this file uses everywhere else it cares.
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        if let Err(e) = file
            .write_all(data.as_bytes())
            .and_then(|()| file.sync_all())
        {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.to_string());
        }
    }
    if let Err(e) = std::fs::rename(&tmp, &p) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn conv_delete(id: String) -> Result<(), String> {
    let p = conv_dir().join(format!("{}.json", sanitize_id(&id)));
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn sanitize_id(id: &str) -> String {
    id.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect()
}

// ------------------------------------------------- conversation history search
//
// The model can reach the threads it is NOT in (search_conversations,
// read_conversation). Both go through the permission gate on the TypeScript
// side; here we only render and rank.
//
// No persisted index: the whole corpus is a handful of small JSON files that
// change on every streamed token, so it is read and ranked in milliseconds and
// is always fresh. Ranking itself is the knowledge module's BM25, chunker and
// snippet centring: the same relevance behaviour the user already gets on
// their folders, reused rather than reinvented (knowledge::rank_documents).

/// UTC "YYYY-MM-DD HH:MM" from epoch milliseconds; "?" when there is no date.
///
/// Every excerpt and every transcript carries one: the whole point of reaching
/// old threads is that the model must not mistake them for the current one.
fn stamp(ms: u64) -> String {
    if ms == 0 {
        return "?".into();
    }
    let secs = (ms / 1000) as i64;
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}",
        tod / 3600,
        (tod % 3600) / 60
    )
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}…")
}

/// Plain-text rendering of a stored thread: one line per item, roles named.
/// Tool cards keep their name, argument and a clipped result, enough to be
/// searchable without dragging whole 200 KB dumps into the ranking.
fn conv_transcript(v: &Value) -> String {
    let mut out = String::new();
    for it in v["items"].as_array().cloned().unwrap_or_default() {
        let kind = it["kind"].as_str().unwrap_or("");
        let line = match kind {
            "user" => match it["from"].as_str() {
                Some(from) if !from.is_empty() => format!(
                    "[user · relayed by the agent of \"{from}\"] {}",
                    clip(it["text"].as_str().unwrap_or(""), 4000)
                ),
                _ => format!("[user] {}", clip(it["text"].as_str().unwrap_or(""), 4000)),
            },
            "assistant" => format!("[assistant] {}", clip(it["text"].as_str().unwrap_or(""), 8000)),
            "tool" => format!(
                "[tool {} {}] {}",
                it["name"].as_str().unwrap_or("?"),
                clip(it["arg"].as_str().unwrap_or(""), 200),
                clip(it["result"].as_str().unwrap_or(""), 800)
            ),
            "notice" => format!("[note] {}", clip(it["text"].as_str().unwrap_or(""), 500)),
            "error" => format!("[error] {}", clip(it["text"].as_str().unwrap_or(""), 500)),
            _ => continue,
        };
        out.push_str(&line);
        out.push('\n');
    }
    out
}

/// Every stored thread as (id, title, created, updated, transcript).
/// Oversized files are skipped rather than read: a runaway thread must not
/// stall a search.
fn conv_corpus() -> Vec<(String, String, u64, u64, String)> {
    const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(conv_dir()) else {
        return out;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().map(|x| x != "json").unwrap_or(true) {
            continue;
        }
        if e.metadata().map(|m| m.len() > MAX_FILE_BYTES).unwrap_or(false) {
            continue;
        }
        let Ok(txt) = std::fs::read_to_string(&p) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&txt) else { continue };
        let id = v["id"].as_str().unwrap_or_default().to_string();
        if id.is_empty() {
            continue;
        }
        out.push((
            id,
            v["title"].as_str().unwrap_or_default().to_string(),
            v["created"].as_u64().unwrap_or(0),
            v["updated"].as_u64().unwrap_or(0),
            conv_transcript(&v),
        ));
    }
    out
}

#[derive(Serialize)]
pub(crate) struct ConvHit {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) created: u64,
    pub(crate) updated: u64,
    /// First line of the matching excerpt inside the rendered transcript.
    pub(crate) line: usize,
    pub(crate) snippet: String,
    pub(crate) score: f64,
}

#[tauri::command]
pub fn conv_search(query: String, k: Option<usize>) -> Vec<ConvHit> {
    let k = k.unwrap_or(6).clamp(1, 20);
    let corpus = conv_corpus();
    let docs: Vec<(String, String)> = corpus
        .iter()
        .map(|(id, _, _, _, text)| (id.clone(), text.clone()))
        .collect();
    knowledge::rank_documents(&docs, &query, k)
        .into_iter()
        .filter_map(|h| {
            let (id, title, created, updated, _) = corpus.iter().find(|c| c.0 == h.path)?;
            Some(ConvHit {
                id: id.clone(),
                title: title.clone(),
                created: *created,
                updated: *updated,
                line: h.line,
                snippet: h.snippet,
                score: h.score,
            })
        })
        .collect()
}

/// One stored thread as a dated transcript, header first.
#[tauri::command]
pub fn conv_read(id: String, max_chars: Option<usize>) -> Result<String, String> {
    let cap = max_chars.unwrap_or(24_000).clamp(1_000, 200_000);
    let p = conv_dir().join(format!("{}.json", sanitize_id(&id)));
    let txt = std::fs::read_to_string(&p).map_err(|_| format!("no stored conversation with id {id}"))?;
    let v: Value = serde_json::from_str(&txt).map_err(|e| e.to_string())?;
    let title = v["title"].as_str().unwrap_or("");
    let created = v["created"].as_u64().unwrap_or(0);
    let updated = v["updated"].as_u64().unwrap_or(0);
    let count = v["items"].as_array().map(|a| a.len()).unwrap_or(0);
    let body = conv_transcript(&v);
    let mut head = format!(
        "[stored conversation \"{}\" · id {} · started {} UTC · last updated {} UTC · {} entries]\n\
         [This is a PAST thread, not the conversation you are in. Attribute anything you reuse from it to this title and date.]\n\n",
        if title.is_empty() { "(untitled)" } else { title },
        id,
        stamp(created),
        stamp(updated),
        count
    );
    if body.chars().count() > cap {
        let cut: String = body.chars().take(cap).collect();
        head.push_str(&cut);
        head.push_str(&format!(
            "\n…(transcript truncated at {cap} chars; raise max_chars to read further)"
        ));
    } else {
        head.push_str(&body);
    }
    Ok(head)
}

// documents: voir documents.rs
