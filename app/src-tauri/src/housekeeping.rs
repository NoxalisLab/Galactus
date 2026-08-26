//! What the app leaves behind, and what it takes back.
//!
//! Four folders under Application Support grow with use and nothing ever
//! removed anything from them:
//!
//!   backups/  a full copy of every file the agent has ever overwritten, one
//!             per distinct path, kept forever. An agent that rewrites a two
//!             thousand file repository leaves two thousand copies, including
//!             of files the user has since deleted.
//!   scratch/  tool output too large for the context window, written whole.
//!             That includes the contents of files read through read_file, so
//!             a permission that asked to READ a file quietly left a permanent
//!             copy of it here.
//!   images/   generated pictures, about a megabyte each, from a feature meant
//!             to be used in bursts.
//!   code-symbols-*.json  one index per folder ever opened in the Code view,
//!             at the ROOT of Application Support, next to settings.json. This
//!             machine had 146 of them, 144 of which were empty.
//!
//! WHAT THIS IS NOT. It is not a cache eviction policy with a heuristic. Each
//! rule is a sentence a user would recognise: keep recent work, drop what is
//! old, and never touch anything that is still referenced. It runs once at
//! launch, off the main thread, and its failures are silent by design: a
//! machine that cannot delete a temporary file must still start.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Backups of overwritten files. Generous, because this is somebody's undo.
const BACKUP_MAX_AGE: Duration = Duration::from_secs(30 * 24 * 3600);
const BACKUP_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Tool output spilled to disk. Short, because it is read back within the turn
/// that wrote it and is worthless afterwards.
const SCRATCH_MAX_AGE: Duration = Duration::from_secs(3 * 24 * 3600);
const SCRATCH_MAX_BYTES: u64 = 512 * 1024 * 1024;

/// Generated images. The gallery is the feature, so this is a ceiling, not a
/// cleanup: it only bites after gigabytes.
const IMAGE_MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// A symbol index whose workspace no longer exists is dead weight.
const SYMBOL_MAX_AGE: Duration = Duration::from_secs(60 * 24 * 3600);

#[derive(Debug, Default, PartialEq)]
pub struct Swept {
    pub files: usize,
    pub bytes: u64,
}

/// One directory entry, as the rules see it.
#[derive(Debug, Clone)]
pub struct Aged {
    pub path: PathBuf,
    pub bytes: u64,
    pub age: Duration,
}

/// Which entries to remove, oldest first, to satisfy an age and a size budget.
///
/// Pure so the policy can be tested without a disk: the interesting cases are
/// "everything is recent but too big" and "everything is small but ancient",
/// and both are awkward to stage as real files.
pub fn to_remove(mut entries: Vec<Aged>, max_age: Duration, max_bytes: u64) -> Vec<PathBuf> {
    // Oldest first: age decides who goes when the budget is what is exceeded.
    entries.sort_by(|a, b| b.age.cmp(&a.age));
    let mut out = Vec::new();
    let mut total: u64 = entries.iter().map(|e| e.bytes).sum();
    for e in &entries {
        let too_old = e.age > max_age;
        let too_big = total > max_bytes;
        if !too_old && !too_big {
            // Sorted by age, so nothing later is older; only size can still
            // trigger, and it is checked on the running total.
            if total <= max_bytes {
                break;
            }
        }
        if too_old || too_big {
            out.push(e.path.clone());
            total = total.saturating_sub(e.bytes);
        }
    }
    out
}

fn scan(dir: &Path, now: SystemTime) -> Vec<Aged> {
    let Ok(read) = std::fs::read_dir(dir) else { return Vec::new() };
    read.flatten()
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            let age = meta
                .modified()
                .ok()
                .and_then(|m| now.duration_since(m).ok())
                .unwrap_or_default();
            Some(Aged { path: e.path(), bytes: meta.len(), age })
        })
        .collect()
}

fn sweep(dir: &Path, max_age: Duration, max_bytes: u64) -> Swept {
    let now = SystemTime::now();
    let mut out = Swept::default();
    for path in to_remove(scan(dir, now), max_age, max_bytes) {
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if std::fs::remove_file(&path).is_ok() {
            out.files += 1;
            out.bytes += size;
        }
    }
    out
}

/// Symbol indexes at the root of Application Support.
///
/// Moved into a folder of their own AND pruned: the ones whose workspace is
/// gone are useless, and an empty index is worse than useless since it takes a
/// slot and answers nothing. The path is inside each file, which is what makes
/// "does this workspace still exist" answerable at all.
fn sweep_symbols(root: &Path) -> Swept {
    let mut out = Swept::default();
    let now = SystemTime::now();
    let home = root.join("symbols");
    let _ = std::fs::create_dir_all(&home);

    // Both places, and the order matters. The first version read only the root,
    // so an index survived its first sweep, moved into symbols/, and was never
    // looked at again: its workspace could be deleted and the file stayed for
    // good. Sweeping the root migrates, sweeping the folder prunes, and a file
    // migrated on this pass is judged on the next one rather than twice now.
    for (dir, migrate) in [(root.to_path_buf(), true), (home.clone(), false)] {
        let Ok(read) = std::fs::read_dir(&dir) else { continue };
        for entry in read.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with("code-symbols-") || !name.ends_with(".json") {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let age = meta
                .modified()
                .ok()
                .and_then(|m| now.duration_since(m).ok())
                .unwrap_or_default();
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            let parsed = serde_json::from_str::<serde_json::Value>(&text).ok();
            let workspace_gone = parsed
                .as_ref()
                .and_then(|v| v["root"].as_str().map(|s| !Path::new(s).is_dir()))
                .unwrap_or(false);
            // An index with no symbols in it is what 144 of the 146 files here
            // were: written for a folder that had none, and re-read forever.
            //
            // Asked of the CONTENT, not of the byte count. `text.len() < 400`
            // also described a small project that is open right now and whose
            // index is perfectly good: three or four real symbols fit in far
            // less than four hundred bytes, so that index was deleted at every
            // launch and rebuilt on the next visit to the Code view. A file
            // that does not parse is left to the age rule rather than deleted
            // on a guess.
            let empty = parsed
                .as_ref()
                .map(|v| v["symbols"].as_array().map(|a| a.is_empty()).unwrap_or(true))
                .unwrap_or(false);
            if workspace_gone || empty || age > SYMBOL_MAX_AGE {
                let size = meta.len();
                if std::fs::remove_file(&path).is_ok() {
                    out.files += 1;
                    out.bytes += size;
                }
                continue;
            }
            if migrate {
                // Keep it, but out of the way of settings.json.
                let _ = std::fs::rename(&path, home.join(&name));
            }
        }
    }
    out
}

/// Run every rule once. Called at launch, off the main thread.
pub fn sweep_all(root: &Path) -> Swept {
    let mut total = Swept::default();
    for (dir, age, bytes) in [
        (root.join("backups"), BACKUP_MAX_AGE, BACKUP_MAX_BYTES),
        (root.join("scratch"), SCRATCH_MAX_AGE, SCRATCH_MAX_BYTES),
        (root.join("images"), Duration::from_secs(u64::MAX / 2), IMAGE_MAX_BYTES),
    ] {
        let s = sweep(&dir, age, bytes);
        total.files += s.files;
        total.bytes += s.bytes;
    }
    let s = sweep_symbols(root);
    total.files += s.files;
    total.bytes += s.bytes;
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    fn aged(name: &str, bytes: u64, days: u64) -> Aged {
        Aged {
            path: PathBuf::from(name),
            bytes,
            age: Duration::from_secs(days * 24 * 3600),
        }
    }

    #[test]
    fn recent_work_within_budget_is_never_touched() {
        // The rule has to be safe first: somebody's undo history lives here.
        let entries = vec![aged("a", 10, 1), aged("b", 10, 2), aged("c", 10, 3)];
        assert!(to_remove(entries, Duration::from_secs(30 * 24 * 3600), 1000).is_empty());
    }

    #[test]
    fn what_is_older_than_the_limit_goes_whatever_the_size() {
        let entries = vec![aged("old", 1, 40), aged("new", 1, 1)];
        let gone = to_remove(entries, Duration::from_secs(30 * 24 * 3600), u64::MAX);
        assert_eq!(gone, vec![PathBuf::from("old")]);
    }

    #[test]
    fn over_budget_removes_the_oldest_until_it_fits_and_then_stops() {
        // Everything is recent; only the total is wrong. The newest must
        // survive, which is the whole point of sorting by age.
        let entries = vec![aged("oldest", 100, 3), aged("middle", 100, 2), aged("newest", 100, 1)];
        let gone = to_remove(entries, Duration::from_secs(30 * 24 * 3600), 250);
        assert_eq!(gone, vec![PathBuf::from("oldest")], "one removal brings 300 under 250");
    }

    #[test]
    fn an_empty_folder_and_a_missing_one_are_both_fine() {
        assert_eq!(to_remove(vec![], Duration::from_secs(1), 1), Vec::<PathBuf>::new());
        let missing = std::env::temp_dir().join("galactus-not-here-at-all");
        assert_eq!(sweep(&missing, Duration::from_secs(1), 1), Swept::default());
    }

    #[test]
    fn it_actually_removes_files_and_reports_what_it_took() {
        let dir = std::env::temp_dir().join(format!("galactus-sweep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("big.txt"), vec![0u8; 4096]).unwrap();
        std::fs::write(dir.join("small.txt"), b"x").unwrap();
        // A budget of one byte is SATISFIED once the big file is gone: 1 byte
        // remains and 1 <= 1. That is the correct behaviour and the first
        // version of this test asserted otherwise.
        let swept = sweep(&dir, Duration::from_secs(u64::MAX / 2), 1);
        assert_eq!(swept.files, 1, "it stops as soon as the budget is met");
        assert!(swept.bytes >= 4096, "and it removed the big one, not the small one");
        assert!(dir.join("small.txt").exists());
        assert!(!dir.join("big.txt").exists());

        // A budget of zero leaves nothing.
        let swept = sweep(&dir, Duration::from_secs(u64::MAX / 2), 0);
        assert_eq!(swept.files, 1);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_index_that_was_already_filed_away_is_still_pruned() {
        // The bug this pins: sweep_symbols read only the root, so an index kept
        // by one pass moved into symbols/ and left the sweep's sight for good.
        // Delete its workspace afterwards and the file stayed on disk forever.
        let dir = std::env::temp_dir().join("galactus-symbols-test");
        let _ = std::fs::remove_dir_all(&dir);
        let home = dir.join("symbols");
        std::fs::create_dir_all(&home).unwrap();

        let live = std::env::temp_dir().join("galactus-symbols-workspace");
        std::fs::create_dir_all(&live).unwrap();
        // Valid JSON, and over the 400-byte floor, so neither the parse failure
        // nor the empty-index rule is what decides the outcome here.
        let body = |root: &Path| {
            let names: Vec<String> = (0..40).map(|i| format!(r#""symbol_number_{i}""#)).collect();
            format!(r#"{{"root":"{}","symbols":[{}]}}"#, root.display(), names.join(","))
        };

        // Already filed: one whose folder is gone, one whose folder is there.
        std::fs::write(home.join("code-symbols-dead.json"), body(Path::new("/nope/gone"))).unwrap();
        std::fs::write(home.join("code-symbols-live.json"), body(&live)).unwrap();
        // And one still at the root, to check migration keeps working.
        std::fs::write(dir.join("code-symbols-new.json"), body(&live)).unwrap();

        let swept = sweep_symbols(&dir);

        assert_eq!(swept.files, 1, "the filed-away orphan is the one that goes");
        assert!(!home.join("code-symbols-dead.json").exists());
        assert!(home.join("code-symbols-live.json").exists(), "a live index survives");
        assert!(home.join("code-symbols-new.json").exists(), "and the root one is filed");
        assert!(!dir.join("code-symbols-new.json").exists());

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&live);
    }
}
