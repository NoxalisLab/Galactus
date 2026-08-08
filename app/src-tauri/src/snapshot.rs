// Galactus desktop, bulk workspace snapshot for the TypeScript language service.
//
// Why this exists at all. `ts.LanguageServiceHost.readFile` is SYNCHRONOUS and
// Tauri's `invoke` is async. There is no bridge between the two inside a
// WKWebView: a synchronous XHR needs an HTTP origin the CSP does not grant, and
// `Atomics.wait` on the main thread freezes the window. So the language service
// never reads the disk at all. It reads a Map that a worker owns, and this
// command is what fills that Map: one bulk read of the workspace, up front.
//
// Containment is the same rule as the rest of the Code view: a path outside the
// root chosen by the user is refused here, not merely hidden in the frontend,
// because the model reaches these commands too.
//
// The one deliberate exception to `code.rs`'s SKIP_DIRS. That list excludes
// node_modules, and for a file tree that is right: nobody wants to click
// through 30 000 entries. But TypeScript needs `node_modules/**/*.d.ts` and the
// `types`/`exports` fields of `node_modules/**/package.json` to type a third
// party import. Without them every `import { x } from "some-package"` resolves
// to `any` and hover degrades SILENTLY, which is worse than having no hover at
// all: the user cannot tell a correct answer from a hollow one. So those two
// patterns, and only those two, are admitted under node_modules.

use serde::Serialize;
use std::path::{Component, Path, PathBuf};

// ---------------------------------------------------------------- shared rules
//
// The three items below are a VERBATIM copy of `code.rs`: the same containment
// rule, the same skip list, the same per-file ceiling. They are duplicated only
// because they are private there and this module could not be added without
// touching that file. `copy_is_verbatim` in the tests reads both sources and
// fails the build if they ever drift. The integration note carries the four
// line change that deletes this block and imports the originals instead.
// --- BEGIN COPY OF code.rs ---
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
// --- END COPY OF code.rs ---

// ---------------------------------------------------------------- snapshot rules

/// Extensions taken when the caller passes an empty list. Everything the
/// language service can parse as a program root, plus json because tsconfig,
/// jsconfig and package.json all steer module resolution.
const DEFAULT_EXTS: &[&str] = &[
    "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json",
];

/// Ceilings the caller can lower but not raise past these. A snapshot is held
/// in memory twice for a moment (Rust side, then the worker's Map), so an
/// unbounded read of somebody's monorepo is a way to kill the app.
const HARD_CAP_BYTES: u64 = 256 * 1024 * 1024;
const HARD_CAP_FILES: usize = 200_000;

#[derive(Serialize, Debug)]
pub struct SnapshotResult {
    /// `(path relative to the root, UTF-8 content)`, workspace sources first
    /// and node_modules last, deterministic across runs.
    pub files: Vec<(String, String)>,
    /// A cap was hit and the walk stopped early. Reported, never hidden: a
    /// silently partial program produces confident wrong answers.
    pub truncated: bool,
    /// Bytes of the content actually returned.
    pub total_bytes: u64,
}

/// The TypeScript default libraries live in `node_modules/typescript/lib` as
/// `lib.d.ts` and `lib.*.d.ts`. They are shipped separately as a bundled asset
/// under `public/tslib/`, so carrying them in the snapshot as well would spend
/// 2.4 MB of the budget twice.
fn is_bundled_default_lib(rel: &Path, name: &str) -> bool {
    if !(name.starts_with("lib.") && name.ends_with(".d.ts")) {
        return false;
    }
    let mut anc = rel.ancestors().skip(1);
    let parent = anc.next().and_then(|p| p.file_name());
    let grand = anc.next().and_then(|p| p.file_name());
    parent.map(|p| p == "lib").unwrap_or(false) && grand.map(|g| g == "typescript").unwrap_or(false)
}

/// Inside node_modules only two patterns are worth their weight.
fn admitted_under_node_modules(rel: &Path, name: &str) -> bool {
    if name == "package.json" {
        return true;
    }
    name.ends_with(".d.ts") && !is_bundled_default_lib(rel, name)
}

fn has_ext(name: &str, exts: &[String]) -> bool {
    let Some(dot) = name.rfind('.') else {
        return false;
    };
    let ext = &name[dot + 1..];
    exts.iter().any(|e| e.eq_ignore_ascii_case(ext))
}

struct Walk<'a> {
    root: PathBuf,
    exts: &'a [String],
    cap_bytes: u64,
    cap_files: usize,
    out: Vec<(String, String)>,
    bytes: u64,
    truncated: bool,
}

impl Walk<'_> {
    /// One directory level. `rel` is the path of `dir` relative to the root,
    /// empty at the top. `in_modules` is true once the walk is anywhere under a
    /// node_modules, which switches the admission rule.
    fn dir(&mut self, dir: &Path, rel: &Path, in_modules: bool) {
        if self.truncated {
            return;
        }
        let Ok(read) = std::fs::read_dir(dir) else {
            // An unreadable directory is not a failure of the snapshot: the
            // language service simply will not see what is in it.
            return;
        };
        let mut files: Vec<(String, PathBuf)> = Vec::new();
        let mut dirs: Vec<(String, PathBuf)> = Vec::new();
        for e in read.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            // Hidden entries are skipped whole, the way the file tree skips
            // them. .git, .vite caches and editor state are not source.
            if name.starts_with('.') {
                continue;
            }
            // Symlinks are not followed. A link can point outside the root and
            // a link cycle would not terminate; a missed file costs a hover,
            // an escaped read costs the containment guarantee.
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                dirs.push((name, e.path()));
            } else if ft.is_file() {
                files.push((name, e.path()));
            }
        }
        files.sort_by(|a, b| a.0.cmp(&b.0));
        // node_modules is visited last at every level, so that when a cap does
        // bite it takes third party typings and leaves the user's own sources.
        dirs.sort_by(|a, b| {
            let key = |n: &String| (n == "node_modules", n.clone());
            key(&a.0).cmp(&key(&b.0))
        });

        for (name, path) in files {
            let child = rel.join(&name);
            let keep = if in_modules {
                admitted_under_node_modules(&child, &name)
            } else {
                has_ext(&name, self.exts)
            };
            if !keep {
                continue;
            }
            if !self.push(&child, &path) {
                return;
            }
        }
        for (name, path) in dirs {
            if self.truncated {
                return;
            }
            let entering_modules = name == "node_modules";
            // SKIP_DIRS applies to the workspace, not to the inside of a
            // node_modules: packages ship their typings under dist/, build/ and
            // lib/, and honouring the list there would drop most of them.
            if !in_modules && SKIP_DIRS.contains(&name.as_str()) && !entering_modules {
                continue;
            }
            self.dir(&path, &rel.join(&name), in_modules || entering_modules);
        }
    }

    /// Returns false once a cap has been hit and the walk must stop.
    fn push(&mut self, rel: &Path, full: &Path) -> bool {
        let Ok(meta) = std::fs::metadata(full) else {
            return true;
        };
        let len = meta.len();
        // Same per-file ceiling as the editor. A 40 MB generated bundle in the
        // snapshot buys nothing and costs everything.
        if len > MAX_FILE_BYTES {
            return true;
        }
        if self.out.len() + 1 > self.cap_files || self.bytes + len > self.cap_bytes {
            self.truncated = true;
            return false;
        }
        let Ok(raw) = std::fs::read(full) else {
            return true;
        };
        // Binary and non UTF-8 files are not source the parser can use, and
        // lossy decoding would hand the program silently wrong offsets.
        if raw.contains(&0) {
            return true;
        }
        let Ok(text) = String::from_utf8(raw) else {
            return true;
        };
        self.bytes += text.len() as u64;
        // Always forward slashes: the worker's Map keys and TypeScript's own
        // path handling are posix, and the app is macOS only anyway.
        let key = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        self.out.push((key, text));
        true
    }
}

/// Read the workspace in bulk. Pure function over the filesystem so it can be
/// exercised from `gx-snapshot` without a running app.
pub fn snapshot(
    root: &str,
    exts: &[String],
    cap_bytes: u64,
    cap_files: usize,
) -> Result<SnapshotResult, String> {
    let base = std::fs::canonicalize(root).map_err(|e| format!("{root}: {e}"))?;
    if !base.is_dir() {
        return Err(format!("{} is not a directory", base.display()));
    }
    // The Code view's containment rule, applied to the root itself before a
    // single byte is read. Everything below is built by walking down from here,
    // and symlinks are never followed, so nothing the walk emits can leave it.
    inside(root, ".")?;
    let owned: Vec<String>;
    let exts = if exts.is_empty() {
        owned = DEFAULT_EXTS.iter().map(|s| s.to_string()).collect();
        &owned[..]
    } else {
        exts
    };
    let mut w = Walk {
        root: base.clone(),
        exts,
        cap_bytes: cap_bytes.min(HARD_CAP_BYTES),
        cap_files: cap_files.min(HARD_CAP_FILES),
        out: Vec::new(),
        bytes: 0,
        truncated: false,
    };
    let root_dir = w.root.clone();
    w.dir(&root_dir, Path::new(""), false);
    Ok(SnapshotResult {
        files: w.out,
        truncated: w.truncated,
        total_bytes: w.bytes,
    })
}

#[tauri::command]
pub async fn code_snapshot(
    root: String,
    exts: Vec<String>,
    cap_bytes: u64,
    cap_files: usize,
) -> Result<SnapshotResult, String> {
    tauri::async_runtime::spawn_blocking(move || snapshot(&root, &exts, cap_bytes, cap_files))
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    fn tmp() -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let d = std::env::temp_dir().join(format!("gx-snapshot-{t}-{n}"));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    fn names(r: &SnapshotResult) -> Vec<&str> {
        r.files.iter().map(|(p, _)| p.as_str()).collect()
    }

    fn all() -> Vec<String> {
        Vec::new()
    }

    #[test]
    fn takes_sources_and_skips_the_skip_dirs() {
        let d = tmp();
        write(&d, "src/a.ts", "export const a = 1;\n");
        write(&d, "src/b.tsx", "export const b = 2;\n");
        write(&d, "src/notes.md", "# no\n");
        write(&d, "tsconfig.json", "{}\n");
        write(&d, "dist/bundle.js", "boom\n");
        write(&d, "target/x.ts", "boom\n");
        write(&d, ".git/config", "boom\n");
        write(&d, ".hidden/x.ts", "boom\n");
        let r = snapshot(d.to_str().unwrap(), &all(), 1 << 30, 10_000).unwrap();
        assert_eq!(names(&r), vec!["tsconfig.json", "src/a.ts", "src/b.tsx"]);
        assert!(!r.truncated);
        assert_eq!(r.total_bytes, 20 + 20 + 3);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn node_modules_admits_only_dts_and_package_json() {
        let d = tmp();
        write(&d, "src/a.ts", "export const a = 1;\n");
        write(&d, "node_modules/pkg/package.json", "{\"types\":\"i.d.ts\"}\n");
        write(&d, "node_modules/pkg/i.d.ts", "export declare const x: number;\n");
        // Runtime JavaScript is never worth its weight: the language service
        // only ever reads the typings.
        write(&d, "node_modules/pkg/index.js", "module.exports={}\n");
        // SKIP_DIRS must NOT apply under node_modules, or most packages lose
        // their typings, which ship under dist/ or build/.
        write(&d, "node_modules/pkg/dist/deep.d.ts", "export {};\n");
        write(&d, "node_modules/pkg/build/other.d.ts", "export {};\n");
        let r = snapshot(d.to_str().unwrap(), &all(), 1 << 30, 10_000).unwrap();
        assert_eq!(
            names(&r),
            vec![
                "src/a.ts",
                "node_modules/pkg/i.d.ts",
                "node_modules/pkg/package.json",
                "node_modules/pkg/build/other.d.ts",
                "node_modules/pkg/dist/deep.d.ts",
            ]
        );
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn typescript_default_libs_are_left_to_the_bundled_copy() {
        let d = tmp();
        write(&d, "node_modules/typescript/package.json", "{}\n");
        write(&d, "node_modules/typescript/lib/lib.d.ts", "// default\n");
        write(&d, "node_modules/typescript/lib/lib.es2023.full.d.ts", "// default\n");
        write(&d, "node_modules/typescript/lib/typescript.d.ts", "export {};\n");
        // A package that legitimately ships a file called lib.something.d.ts
        // outside typescript/lib keeps it.
        write(&d, "node_modules/other/lib.core.d.ts", "export {};\n");
        let r = snapshot(d.to_str().unwrap(), &all(), 1 << 30, 10_000).unwrap();
        assert_eq!(
            names(&r),
            vec![
                "node_modules/other/lib.core.d.ts",
                "node_modules/typescript/package.json",
                "node_modules/typescript/lib/typescript.d.ts",
            ]
        );
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn sources_come_before_node_modules_so_a_cap_takes_the_typings_first() {
        let d = tmp();
        write(&d, "src/a.ts", "export const a = 1;\n");
        write(&d, "node_modules/pkg/i.d.ts", "export {};\n");
        let r = snapshot(d.to_str().unwrap(), &all(), 1 << 30, 1).unwrap();
        assert_eq!(names(&r), vec!["src/a.ts"]);
        assert!(r.truncated, "a dropped file must be reported, never hidden");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn byte_cap_truncates_and_says_so() {
        let d = tmp();
        write(&d, "a.ts", &"x".repeat(100));
        write(&d, "b.ts", &"y".repeat(100));
        let r = snapshot(d.to_str().unwrap(), &all(), 150, 10_000).unwrap();
        assert_eq!(names(&r), vec!["a.ts"]);
        assert_eq!(r.total_bytes, 100);
        assert!(r.truncated);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn oversized_and_binary_files_are_dropped_without_truncating() {
        let d = tmp();
        write(&d, "ok.ts", "export {};\n");
        fs::write(d.join("huge.ts"), vec![b'x'; (MAX_FILE_BYTES + 1) as usize]).unwrap();
        fs::write(d.join("bin.ts"), [0x00u8, 0x01, 0x02]).unwrap();
        let r = snapshot(d.to_str().unwrap(), &all(), 1 << 30, 10_000).unwrap();
        assert_eq!(names(&r), vec!["ok.ts"]);
        assert!(!r.truncated, "a file the walk refuses on its own merits is not truncation");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn extension_list_is_honoured() {
        let d = tmp();
        write(&d, "a.ts", "export {};\n");
        write(&d, "b.py", "pass\n");
        write(&d, "c.json", "{}\n");
        let only_ts = vec!["ts".to_string()];
        let r = snapshot(d.to_str().unwrap(), &only_ts, 1 << 30, 10_000).unwrap();
        assert_eq!(names(&r), vec!["a.ts"]);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_root_that_is_not_a_directory_is_refused() {
        let d = tmp();
        write(&d, "a.ts", "export {};\n");
        let e = snapshot(d.join("a.ts").to_str().unwrap(), &all(), 1 << 30, 10).unwrap_err();
        assert!(e.contains("not a directory"), "{e}");
        let e = snapshot(&format!("{}/nope", d.display()), &all(), 1 << 30, 10).unwrap_err();
        assert!(!e.is_empty());
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn inside_refuses_a_parent_component() {
        let d = tmp();
        write(&d, "a.ts", "export {};\n");
        let e = inside(d.to_str().unwrap(), "../etc/passwd").unwrap_err();
        assert!(e.contains(".."), "{e}");
        fs::remove_dir_all(&d).ok();
    }

    /// Extract `text` between the first line that contains `head` and the line
    /// that closes it at the same brace depth. Used to compare the copied block
    /// with its original character for character.
    fn slice_item(src: &str, head: &str) -> String {
        let start = src.find(head).unwrap_or_else(|| panic!("{head} not found"));
        let rest = &src[start..];
        // A const is one statement, a fn is a brace block.
        if head.starts_with("const ") {
            let end = rest.find(";").unwrap() + 1;
            return rest[..end].to_string();
        }
        let mut depth = 0usize;
        let mut seen = false;
        for (i, c) in rest.char_indices() {
            if c == '{' {
                depth += 1;
                seen = true;
            } else if c == '}' {
                depth -= 1;
                if seen && depth == 0 {
                    return rest[..=i].to_string();
                }
            }
        }
        panic!("unterminated {head}");
    }

    /// The shared rules are duplicated from code.rs on purpose (see the note at
    /// the top of this file). This test is the thing that makes the duplication
    /// safe: the day either copy is edited, the build stops.
    #[test]
    fn copy_is_verbatim() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
        let code = fs::read_to_string(dir.join("code.rs")).unwrap();
        let snap = fs::read_to_string(dir.join("snapshot.rs")).unwrap();
        for head in [
            "const MAX_FILE_BYTES: u64",
            "const SKIP_DIRS: &[&str]",
            "fn inside(root: &str, path: &str)",
        ] {
            assert_eq!(
                slice_item(&code, head),
                slice_item(&snap, head),
                "`{head}` has drifted between code.rs and snapshot.rs"
            );
        }
    }
}
