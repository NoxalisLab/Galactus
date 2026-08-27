// Ce qui appartient a l'utilisateur: sa memoire, son coffre Obsidian, ses
// skills, et les procedures que l'agent a apprises.
//
// Sorti de lib.rs, qui melait ceci au cycle de vie du moteur. Ces quatre choses
// partagent leur nature (du contenu ecrit par l'utilisateur ou pour lui, pose
// dans des dossiers qu'il peut ouvrir) et leurs regles: rien n'est ecrit hors
// des dossiers prevus, et un slug est valide avant de devenir un chemin.

use crate::*;


fn workspace_dir() -> Option<PathBuf> {
    settings_load()
        .get("workspace")
        .cloned()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// Memory lives either globally (default) or inside the current workspace at
/// <workspace>/.galactus/memory.md when memory_scope == "workspace".
///
/// `None` means the user asked for workspace memory and there is no workspace.
/// That case used to fall back to the global file, which is the one thing it
/// must not do: someone who scopes memory to a project is saying these notes
/// belong to this project, and writing them to the file every project reads is
/// the exact leak the setting exists to prevent. No path, no write, and the
/// caller says why.
fn memory_path() -> Option<PathBuf> {
    let s = settings_load();
    memory_target(
        s.get("memory_scope").map(|v| v == "workspace").unwrap_or(false),
        s.get("workspace").map(|x| x.as_str()),
        app_support().join("memory.md"),
    )
}

/// The decision itself, with the settings read out, so it can be tested without
/// a settings file on disk.
fn memory_target(workspace_scope: bool, workspace: Option<&str>, global: PathBuf) -> Option<PathBuf> {
    if workspace_scope {
        return workspace
            .filter(|x| !x.is_empty())
            .map(|ws| PathBuf::from(ws).join(".galactus").join("memory.md"));
    }
    Some(global)
}

#[cfg(test)]
mod memory_scope_tests {
    use super::memory_target;
    use std::path::PathBuf;

    fn global() -> PathBuf {
        PathBuf::from("/Users/x/Library/Application Support/Galactus/memory.md")
    }

    #[test]
    fn global_scope_writes_the_global_file() {
        assert_eq!(memory_target(false, Some("/tmp/proj"), global()), Some(global()));
        assert_eq!(memory_target(false, None, global()), Some(global()));
    }

    #[test]
    fn workspace_scope_writes_inside_the_workspace() {
        assert_eq!(
            memory_target(true, Some("/tmp/proj"), global()),
            Some(PathBuf::from("/tmp/proj/.galactus/memory.md"))
        );
    }

    #[test]
    fn workspace_scope_without_a_workspace_writes_nowhere() {
        // The leak this guards: falling back to the global file would put notes
        // about one project into the file every other project reads.
        assert_eq!(memory_target(true, None, global()), None);
        assert_eq!(memory_target(true, Some(""), global()), None);
    }
}

/// What to tell a user, or a model, when memory is scoped to a workspace and
/// none is open.
const NO_WORKSPACE_MEMORY: &str =
    "memory is set to this workspace, and no folder is open: open one in Code, \
     or switch memory back to global in Settings";

// ---------------------------------------------------------------- skills

#[derive(Serialize, Clone)]
pub(crate) struct SkillInfo {
    name: String,
    description: String,
    path: String,
    scope: String, // "global" | "workspace"
}

/// Coffre par defaut livre avec l'app : une base de connaissances par metier,
/// semee au premier lancement pour que les outils obsidian_* et la
/// Constellation aient de la matiere reelle des l'installation.
///
/// Trois garde-fous independants rendent l'operation non destructive : un
/// marqueur de semis (un coffre supprime volontairement n'est jamais
/// ressuscite), un test d'existence sur la racine de destination, et un test
/// par fichier pendant la copie. Le reglage n'est ecrit que si l'utilisateur
/// n'a pas deja choisi un coffre.
pub(crate) fn seed_bundled_vault() -> Result<(), String> {
    let Some(res) = resource_dir() else { return Ok(()) };
    let src = res.join("packaged/vault");
    if !src.is_dir() {
        return Ok(());
    }
    let marker = app_support().join("vault-seeded");
    if marker.exists() {
        return Ok(());
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let dest = PathBuf::from(home).join("Documents/Galactus/Coffre");
    let ownership = dest.join(".galactus-bundled-vault");
    // Un coffre deja present a cet endroit appartient a l'utilisateur : on n'y
    // touche pas. L'unique exception est une copie Galactus interrompue,
    // reconnaissable a son marqueur local : elle reprend sans ecraser.
    if dest.exists() && !ownership.is_file() {
        std::fs::create_dir_all(app_support()).map_err(|e| e.to_string())?;
        std::fs::write(&marker, b"existant").map_err(|e| e.to_string())?;
        return Ok(());
    }
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    std::fs::write(&ownership, b"Galactus bundled vault v1\n").map_err(|e| e.to_string())?;
    copy_tree_no_clobber(&src, &dest).map_err(|e| e.to_string())?;
    // Obsidian reconnait un dossier comme coffre a ce repertoire, exactement
    // comme le fait obsidian_create_vault.
    std::fs::create_dir_all(dest.join(".obsidian")).map_err(|e| e.to_string())?;
    // Pointer l'app dessus UNIQUEMENT si aucun coffre n'est configure.
    settings_update(|map| {
        let unset = map.get("obsidian_vault").map(|v| v.is_empty()).unwrap_or(true);
        if unset {
            map.insert("obsidian_vault".into(), dest.display().to_string());
        }
    })?;
    // Ce marqueur global est le commit de la transaction : avant lui, un
    // lancement suivant reprend la copie ; apres lui, un coffre modifie ou
    // volontairement vide n'est jamais regenere.
    std::fs::write(&marker, dest.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

/// Copie recursive qui n'ecrase jamais : un fichier existant est saute, un
/// dossier existant est simplement parcouru. Profondeur bornee, comme toutes
/// les marches de ce fichier.
fn copy_tree_no_clobber(src: &Path, dest: &Path) -> std::io::Result<()> {
    let mut stack = vec![(src.to_path_buf(), dest.to_path_buf(), 0u32)];
    while let Some((from, to, depth)) = stack.pop() {
        if depth > 8 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "bundled vault exceeds the supported depth",
            ));
        }
        std::fs::create_dir_all(&to)?;
        for e in std::fs::read_dir(&from)? {
            let e = e?;
            let p = e.path();
            let target = to.join(e.file_name());
            let kind = e.file_type()?;
            if kind.is_symlink() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("symlink not allowed in bundled vault: {}", p.display()),
                ));
            }
            if kind.is_dir() {
                stack.push((p, target, depth + 1));
            } else if !target.exists() {
                std::fs::copy(&p, &target)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod bundled_vault_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_pair(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("galactus-{name}-{}-{unique}", std::process::id()));
        let src = base.join("src");
        let dest = base.join("dest");
        std::fs::create_dir_all(&src).unwrap();
        (base, src, dest)
    }

    #[test]
    fn vault_copy_is_recursive_and_never_clobbers_existing_notes() {
        let (base, src, dest) = temp_pair("vault-copy");
        std::fs::create_dir_all(src.join("nested")).unwrap();
        std::fs::write(src.join("nested/note.md"), "bundled").unwrap();
        std::fs::create_dir_all(dest.join("nested")).unwrap();
        std::fs::write(dest.join("nested/note.md"), "user").unwrap();
        std::fs::write(src.join("new.md"), "new").unwrap();

        copy_tree_no_clobber(&src, &dest).unwrap();

        assert_eq!(std::fs::read_to_string(dest.join("nested/note.md")).unwrap(), "user");
        assert_eq!(std::fs::read_to_string(dest.join("new.md")).unwrap(), "new");
        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(unix)]
    #[test]
    fn vault_copy_rejects_symlinks_instead_of_marking_a_partial_copy_done() {
        use std::os::unix::fs::symlink;
        let (base, src, dest) = temp_pair("vault-symlink");
        symlink(src.join("missing.md"), src.join("broken.md")).unwrap();

        assert!(copy_tree_no_clobber(&src, &dest).is_err());
        let _ = std::fs::remove_dir_all(base);
    }
}

/// Copy the skills shipped in the bundle into the global skills folder, so a
/// fresh install starts with a curated set. User-modified or user-deleted
/// skills are left alone (copy only when the skill folder does not exist).
pub(crate) fn seed_bundled_skills() {
    let Some(res) = resource_dir() else { return };
    let src = res.join("packaged/skills");
    let Ok(rd) = std::fs::read_dir(&src) else { return };
    let dest_base = app_support().join("skills");
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let name = e.file_name();
        let dest = dest_base.join(&name);
        if dest.exists() {
            continue;
        }
        let _ = std::fs::create_dir_all(&dest);
        if let Ok(files) = std::fs::read_dir(&p) {
            for f in files.flatten() {
                let _ = std::fs::copy(f.path(), dest.join(f.file_name()));
            }
        }
    }
}

fn skill_search_dirs() -> Vec<(PathBuf, String)> {
    let mut v = vec![(app_support().join("skills"), "global".to_string())];
    if let Some(ws) = workspace_dir() {
        v.push((ws.join(".galactus/skills"), "workspace".to_string()));
        v.push((ws.join(".claude/skills"), "workspace".to_string()));
    }
    v
}

fn parse_frontmatter(md: &str) -> (String, String) {
    let mut name = String::new();
    let mut desc = String::new();
    let mut lines = md.lines();
    if lines.next().map(|l| l.trim() == "---").unwrap_or(false) {
        for l in lines {
            if l.trim() == "---" {
                break;
            }
            if let Some(v) = l.strip_prefix("name:") {
                name = v.trim().trim_matches('"').to_string();
            } else if let Some(v) = l.strip_prefix("description:") {
                desc = v.trim().trim_matches('"').to_string();
            }
        }
    }
    (name, desc)
}

/// Resolved absolute path of a note (for the diff preview before an agent
/// rewrite). Same hardening as every obsidian_* command.
#[tauri::command]
pub fn obsidian_resolve(note: String) -> Result<String, String> {
    let vault = settings_load()
        .get("obsidian_vault")
        .cloned()
        .filter(|s| !s.is_empty())
        .ok_or("no Obsidian vault configured")?;
    Ok(resolve_note(Path::new(&vault), &note)?.display().to_string())
}

/// Full write of a vault note (the constellation editor's save). Same
/// traversal hardening as every obsidian_* command.
#[tauri::command]
pub fn obsidian_write(note: String, text: String) -> Result<(), String> {
    let vault = settings_load()
        .get("obsidian_vault")
        .cloned()
        .filter(|s| !s.is_empty())
        .ok_or("no Obsidian vault configured")?;
    let p = resolve_note(Path::new(&vault), &note)?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, text.as_bytes()).map_err(|e| e.to_string())
}

/// Turn a picked folder into an Obsidian vault (idempotent on an existing
/// one) and make it the configured vault.
#[tauri::command]
pub fn obsidian_create_vault(path: String) -> Result<String, String> {
    let root = PathBuf::from(&path);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(root.join(".obsidian")).map_err(|e| e.to_string())?;
    let welcome = root.join("Bienvenue.md");
    if !welcome.exists() {
        let _ = std::fs::write(
            &welcome,
            "# Bienvenue\n\nCe coffre a ete cree par Galactus. Les notes liees par des [[wikilinks]] apparaissent dans la Constellation.\n",
        );
    }
    settings_update(|map| {
        map.insert("obsidian_vault".into(), path.clone());
    })?;
    Ok(path)
}

/// Graph of the Obsidian vault for the 3D constellation view: notes as
/// nodes, wikilinks as edges. Bounded walk, resilient to weird files.
#[tauri::command]
pub async fn obsidian_graph() -> Result<Value, String> {
    let vault = settings_load()
        .get("obsidian_vault")
        .cloned()
        .filter(|s| !s.is_empty())
        .ok_or("no Obsidian vault configured")?;
    let root = PathBuf::from(&vault);

    // Collect notes (bounded).
    let mut files: Vec<PathBuf> = Vec::new();
    let mut stack = vec![(root.clone(), 0u32)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > 8 || files.len() >= 2500 {
            break;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            if p.is_dir() {
                stack.push((p, depth + 1));
            } else if p.extension().map(|x| x == "md").unwrap_or(false) {
                files.push(p);
                if files.len() >= 2500 {
                    break;
                }
            }
        }
    }

    // Index by stem (lowercased), first occurrence wins like Obsidian.
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut names: Vec<String> = Vec::new();
    let mut rels: Vec<String> = Vec::new();
    for f in &files {
        let stem = f.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let key = stem.to_lowercase();
        if let std::collections::hash_map::Entry::Vacant(slot) = index.entry(key) {
            slot.insert(names.len());
            names.push(stem);
            rels.push(
                f.strip_prefix(&root)
                    .map(|r| r.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            );
        }
    }

    // Extract [[wikilinks]] and keep edges between existing notes.
    let mut degree = vec![0u32; names.len()];
    let mut edges: Vec<(u32, u32)> = Vec::new();
    let mut seen: std::collections::HashSet<(u32, u32)> = std::collections::HashSet::new();
    for f in &files {
        let stem_key = f
            .file_stem()
            .map(|s| s.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let Some(&src) = index.get(&stem_key) else { continue };
        let Ok(text) = std::fs::read_to_string(f) else { continue };
        let capped = &text[..crate::tools::floor_char_boundary(&text, 200_000)];
        for part in capped.split("[[").skip(1) {
            let Some(end) = part.find("]]") else { continue };
            let raw = &part[..end];
            let target = raw.split(['|', '#']).next().unwrap_or("").trim();
            if target.is_empty() {
                continue;
            }
            // "dossier/Note" links resolve on the last segment.
            let leaf = target.rsplit('/').next().unwrap_or(target).to_lowercase();
            let Some(&dst) = index.get(&leaf) else { continue };
            if dst == src {
                continue;
            }
            let key = (src.min(dst) as u32, src.max(dst) as u32);
            if seen.insert(key) {
                edges.push(key);
                degree[src] += 1;
                degree[dst] += 1;
            }
        }
    }

    let nodes: Vec<Value> = names
        .iter()
        .zip(rels.iter())
        .zip(degree.iter())
        .map(|((n, p), d)| json!({ "n": n, "p": p, "d": d }))
        .collect();
    let edge_list: Vec<Value> = edges.iter().map(|(a, b)| json!([a, b])).collect();
    Ok(json!({ "nodes": nodes, "edges": edge_list }))
}

#[tauri::command]
pub fn skills_list() -> Vec<SkillInfo> {
    let mut out = Vec::new();
    for (dir, scope) in skill_search_dirs() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for e in rd.flatten() {
            let p = e.path();
            let skill_md = if p.is_dir() {
                p.join("SKILL.md")
            } else if p.file_name().map(|n| n == "SKILL.md").unwrap_or(false) {
                p.clone()
            } else {
                continue;
            };
            if !skill_md.is_file() {
                continue;
            }
            if let Ok(md) = std::fs::read_to_string(&skill_md) {
                let (mut name, desc) = parse_frontmatter(&md);
                if name.is_empty() {
                    name = p
                        .file_stem()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_default();
                }
                out.push(SkillInfo {
                    name,
                    description: desc,
                    path: skill_md.display().to_string(),
                    scope: scope.clone(),
                });
            }
        }
    }
    out
}

#[tauri::command]
pub fn skill_read(name: String) -> Result<String, String> {
    for s in skills_list() {
        if s.name == name {
            return std::fs::read_to_string(&s.path).map_err(|e| e.to_string());
        }
    }
    Err(format!("skill not found: {name}"))
}

// ------------------------------------------------- learned skills (storage)
//
// The procedural memory bank: skills the AGENT wrote for itself after a task.
// Storage only. Everything that decides whether a skill may be written, what
// it may contain and whether it may be loaded lives in app/src/learned.ts,
// where it is pure and pinned by tests.
//
// Three properties are the reason this is a separate directory and a separate
// set of commands rather than a fourth entry in `skill_search_dirs`:
//
//  1. `skills_list` and `skill_read` MUST NOT be able to return one of these.
//     The thirty shipped skills and the agent's own notes must never share a
//     listing, an ordering or a read path, or the provenance recorded in
//     docs/skills-sources.md stops meaning anything.
//  2. The folder sits under app_support(), which `is_protected_write` already
//     refuses for `tool_fs_write`. So the agent cannot rewrite a stored skill
//     with its own file tools: the authoring pipeline, which validates, is the
//     only way in. Validation that can be bypassed by a second write is not
//     validation.
//  3. Deleting is first class, one by one and all at once, because a memory
//     the user cannot empty is not a memory, it is a residue.
//
// The slug rules are enforced here as well as in TypeScript. That is not
// redundancy: this side is what actually holds if the front end is ever
// bypassed, and it is the only side that runs before a path is built.

#[derive(Serialize, Clone)]
pub(crate) struct LearnedSkillFile {
    slug: String,
    body: String,
}

pub(crate) fn learned_dir() -> PathBuf {
    app_support().join("skills-learned")
}

/// Lowercase ascii, digits and single hyphens, bounded. No dot anywhere, so
/// "..", "." and dot-files cannot be spelled at all.
fn valid_learned_slug(slug: &str) -> bool {
    let bytes = slug.as_bytes();
    if bytes.len() < 2 || bytes.len() > 48 {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        return false;
    }
    slug.bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !slug.contains("--")
}

/// A body larger than this is not a procedure. The TypeScript cap is 6000
/// characters; this one is deliberately looser and exists only so a bug on the
/// other side cannot fill the disk.
const LEARNED_MAX_BODY: usize = 40_000;
/// Hard ceiling on the bank, mirroring MAX_BANK on the TypeScript side with
/// the same intent: the catalogue is charged to every request.
const LEARNED_MAX_ENTRIES: usize = 64;

#[tauri::command]
pub fn learned_list() -> Vec<LearnedSkillFile> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(learned_dir()) else {
        return out;
    };
    let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    dirs.sort();
    for p in dirs {
        let slug = p
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        if !valid_learned_slug(&slug) {
            continue;
        }
        if let Ok(body) = std::fs::read_to_string(p.join("SKILL.md")) {
            out.push(LearnedSkillFile { slug, body });
        }
        if out.len() >= LEARNED_MAX_ENTRIES {
            break;
        }
    }
    out
}

#[tauri::command]
pub fn learned_write(slug: String, body: String) -> Result<String, String> {
    if !valid_learned_slug(&slug) {
        return Err("invalid learned skill name".into());
    }
    if body.len() > LEARNED_MAX_BODY {
        return Err("learned skill body is too large".into());
    }
    let dir = learned_dir().join(&slug);
    // Overwriting an existing slug is fine (a re-approval rewrites the state
    // line); creating a 65th one is not.
    if !dir.exists() && learned_list().len() >= LEARNED_MAX_ENTRIES {
        return Err("the learned skills bank is full".into());
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = dir.join("SKILL.md");
    std::fs::write(&p, body.as_bytes()).map_err(|e| e.to_string())?;
    Ok(p.display().to_string())
}

/// Delete one skill, or the whole bank when `slug` is absent. Deleting the
/// bank removes the directory itself, so nothing is left behind for the user
/// to wonder about.
#[tauri::command]
pub fn learned_delete(slug: Option<String>) -> Result<(), String> {
    match slug {
        Some(s) => {
            if !valid_learned_slug(&s) {
                return Err("invalid learned skill name".into());
            }
            let dir = learned_dir().join(&s);
            if dir.is_dir() {
                std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        None => {
            let dir = learned_dir();
            if dir.is_dir() {
                std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
            }
            Ok(())
        }
    }
}

/// The folder itself, so the user can open it in Finder and see that the
/// agent's notes are somewhere other than the thirty shipped skills.
#[tauri::command]
pub fn learned_folder() -> String {
    learned_dir().display().to_string()
}

#[cfg(test)]
mod learned_slug_tests {
    use super::valid_learned_slug;

    #[test]
    fn traversal_and_dotfiles_cannot_be_spelled() {
        for bad in ["..", ".", ".ssh", "a/../b", "a/b", "A", "-x", "x--y", "", "x"] {
            assert!(!valid_learned_slug(bad), "{bad} must be refused");
        }
    }

    #[test]
    fn ordinary_slugs_pass() {
        for ok in ["git-bisect-loop", "npm-test-then-fix", "a1"] {
            assert!(valid_learned_slug(ok), "{ok} must be accepted");
        }
    }
}

/// The guard the whole "the agent cannot rewrite its own skills" claim rests on.
///
/// The bank lives at app_support()/skills-learned, and the ONLY thing keeping
/// the agent's own file tools out of it is `is_protected_write`, four lines
/// consulted by tool_fs_write and tool_fs_revert. It had no test: the property
/// was documented in three comments and asserted nowhere, so a refactor that
/// dropped the check would have shipped green.
#[cfg(test)]
mod protected_write_tests {
    use super::{app_support, learned_dir};
    use crate::tools::is_protected_write;

    #[test]
    fn the_learned_bank_is_not_writable_by_the_agents_file_tools() {
        let bank = learned_dir();
        assert!(
            crate::tools::is_protected_write(&bank),
            "the bank itself must be refused: {}",
            bank.display()
        );
        // A skill FILE, not just the folder. The agent writes paths, not
        // directories, and a prefix check that only matched the directory
        // exactly would let every file inside it through.
        assert!(
            crate::tools::is_protected_write(&bank.join("git-bisect-loop").join("SKILL.md")),
            "a file inside the bank must be refused too"
        );
    }

    #[test]
    fn the_whole_configuration_folder_is_refused_not_only_the_bank() {
        let support = app_support();
        for name in ["settings.json", "conversations", "schedule/jobs.json", "skills"] {
            let p = support.join(name);
            assert!(crate::tools::is_protected_write(&p), "{} must be refused", p.display());
        }
    }

    #[test]
    fn an_ordinary_user_path_is_still_writable() {
        // The other half: a guard that refused everything would pass the two
        // tests above and break every legitimate write the agent makes.
        for p in ["/tmp/galactus-test-file", "/Users/somebody/projects/x/main.rs"] {
            assert!(
                !crate::tools::is_protected_write(std::path::Path::new(p)),
                "{p} must stay writable"
            );
        }
    }
}

#[tauri::command]
pub fn memory_read() -> String {
    memory_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn memory_write(text: String) -> Result<(), String> {
    let _guard = MEMORY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    memory_store(&text)
}

/// Save the memory the user edited, unless the agent changed it meanwhile.
///
/// The Memory view loads the text once and its Save button wrote it back
/// wholesale. While that view is open the agent can be recording facts through
/// `remember`: correcting a comma and pressing Save discarded everything it had
/// learned since the view opened, with nothing on screen to suggest it.
#[tauri::command]
pub fn memory_save(text: String, expected: String) -> Result<bool, String> {
    let _guard = MEMORY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let now = memory_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default();
    if now != expected {
        // false, not an error: the caller shows what happened and offers to
        // reload, which is information rather than a failure.
        return Ok(false);
    }
    memory_store(&text)?;
    Ok(true)
}

/// One lock over the memory file.
///
/// `remember` is a read-modify-write and the teammates run in parallel now, so
/// two facts recorded at the same instant used to keep whichever landed last.
static MEMORY_LOCK: Mutex<()> = Mutex::new(());

/// Write memory.md the way every other persistent file in this app is written.
///
/// It was the one exception: a plain `fs::write`, which truncates first. A full
/// disk, a crash or a quit during that window left the file empty or cut mid
/// sentence, with no copy anywhere. Everything the user had told the app to
/// remember, gone, on an operation nobody thinks of as risky.
fn memory_store(text: &str) -> Result<(), String> {
    let p = memory_path().ok_or(NO_WORKSPACE_MEMORY)?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension(format!("tmp.{}", std::process::id()));
    {
        let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        // Before the rename, not after: the rename is atomic for the name, not
        // for the bytes behind it.
        file.sync_all().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn memory_append(text: String) -> Result<String, String> {
    let _guard = MEMORY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut cur = memory_read();
    if !cur.is_empty() && !cur.ends_with('\n') {
        cur.push('\n');
    }
    cur.push_str("- ");
    cur.push_str(text.trim());
    cur.push('\n');
    // memory_store, NOT memory_write: the lock is already held two lines up and
    // it is a plain std Mutex, which is not reentrant. Calling memory_write here
    // deadlocked the thread on itself, permanently, the first time the agent
    // recorded anything. Every later memory command waited on a lock that would
    // never be released.
    //
    // The bitter part: this was introduced while fixing a real race on this very
    // file, and it turned a feature that silently wrote nothing into one that
    // hangs the turn. A serialised write is worth having; it has to be taken
    // once.
    memory_store(&cur)?;
    Ok("remembered".into())
}

pub(crate) fn vault_dir() -> Result<PathBuf, String> {
    let map = settings_load();
    let v = map
        .get("obsidian_vault")
        .cloned()
        .filter(|s| !s.is_empty())
        .ok_or("no Obsidian vault set")?;
    Ok(PathBuf::from(v))
}

/// Resolve a note path STRICTLY inside the vault. Absolute paths and any
/// `..` component are rejected: accepting them would turn the obsidian tools
/// into arbitrary disk read/write (e.g. `/Users/x/.ssh/id_rsa`).
fn resolve_note(vault: &Path, note: &str) -> Result<PathBuf, String> {
    use std::path::Component;
    let rel = Path::new(note);
    if rel.is_absolute()
        || note.starts_with('~')
        || rel
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err("note path must be relative to the vault (no '..', no absolute path)".into());
    }
    let mut p = vault.join(rel);
    if p.extension().is_none() {
        p.set_extension("md");
    }
    Ok(p)
}

#[tauri::command]
pub async fn obsidian_search(query: String) -> Result<String, String> {
    let vault = vault_dir()?;
    let args: Vec<String> = [
        "-rIn", "-i", "--include=*.md", "-m", "2", "--", &query,
    ]
    .iter()
    .map(|s| s.to_string())
    .chain(std::iter::once(vault.display().to_string()))
    .collect();
    let mut out = run_with_timeout("grep", &args, 8);
    if out.len() > 4000 {
        out.truncate(crate::tools::floor_char_boundary(&out, 4000));
        out.push_str("\n…(truncated)");
    }
    if out.trim().is_empty() {
        return Ok("(no matching notes)".into());
    }
    // Strip the vault prefix for readability.
    Ok(out.replace(&format!("{}/", vault.display()), ""))
}

#[tauri::command]
pub fn obsidian_read(note: String) -> Result<String, String> {
    let vault = vault_dir()?;
    let p = resolve_note(&vault, &note)?;
    let data = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    Ok(if data.len() > crate::tools::TOOL_MAX_OUTPUT {
        format!(
            "{}\n…(truncated)",
            &data[..crate::tools::floor_char_boundary(&data, crate::tools::TOOL_MAX_OUTPUT)]
        )
    } else {
        data
    })
}

#[tauri::command]
pub fn obsidian_append(note: String, text: String) -> Result<String, String> {
    let vault = vault_dir()?;
    let p = resolve_note(&vault, &note)?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut cur = std::fs::read_to_string(&p).unwrap_or_default();
    if !cur.is_empty() && !cur.ends_with('\n') {
        cur.push('\n');
    }
    cur.push_str(&text);
    cur.push('\n');
    std::fs::write(&p, cur.as_bytes()).map_err(|e| e.to_string())?;
    Ok(format!("appended to {}", p.display()))
}

#[cfg(test)]
mod memory_lock_tests {
    /// No function may take MEMORY_LOCK and then call one that takes it again.
    ///
    /// std::sync::Mutex is not reentrant, so a nested acquisition on one thread
    /// is a permanent self-deadlock, not a slow path. It happened here: a fix
    /// for a real race on memory.md added the lock to memory_append, which
    /// already called memory_write, which the same commit had also given the
    /// lock. The first `remember` of the session hung the turn and every memory
    /// command after it, and no test noticed because none of them called
    /// memory_append.
    ///
    /// A source test rather than a runtime one on purpose: reproducing a
    /// deadlock means a thread that never finishes and a timeout to catch it,
    /// and the writes would land in the real Application Support folder of
    /// whoever runs the suite. The shape is what matters, and the shape is
    /// visible.
    #[test]
    fn no_memory_function_takes_the_lock_twice() {
        let source = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/library.rs"),
        )
        .expect("library.rs");

        // The functions that take the lock themselves, and must therefore never
        // be called by another function that already holds it.
        let takers = ["memory_write", "memory_save", "memory_append"];
        for name in takers {
            let start = source
                .find(&format!("fn {name}("))
                .unwrap_or_else(|| panic!("{name} is gone: this test needs updating"));
            let body_start = source[start..].find('{').expect("a body") + start;
            // The body ends at the first line that closes at column zero.
            let end = source[body_start..]
                .find("\n}\n")
                .map(|i| body_start + i)
                .unwrap_or(source.len());
            let body = &source[body_start..end];
            assert!(
                body.contains("MEMORY_LOCK.lock()"),
                "{name} is expected to take the lock; the list above is stale"
            );
            for other in takers {
                if other == name {
                    continue;
                }
                assert!(
                    !body.contains(&format!("{other}(")),
                    "{name} holds MEMORY_LOCK and calls {other}, which takes it again: \
                     that is a self-deadlock, not a slow path"
                );
            }
        }
    }
}
