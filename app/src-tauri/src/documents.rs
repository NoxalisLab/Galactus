// Lire et modifier des documents: PDF, Word, tableurs, images, OCR.
//
// Sorti de lib.rs, qui portait 10 673 lignes et melait le cycle de vie du
// moteur, la planification memoire, l'installation des modeles et ceci. Le bloc
// etait deja delimite par sa banniere et ne demande au reste du fichier que
// deux fonctions: app_support() et run_with_deadline().
//
// Les helpers (Swift pour PDFKit et Vision, Python pour docx et xlsx) sont
// compiles ou copies a la premiere utilisation dans Application Support.

use crate::tools::{floor_char_boundary, run_with_deadline};
use crate::{galactus_root, python3_cmd, resource_dir, swift_helper};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// The Swift helper is compiled once, on first use, into Application Support.
/// It only needs the Command Line Tools, which any machine building llama.cpp
/// already has. Everything it does (PDFKit text, Vision OCR) is offline.
fn doc_helper() -> Result<PathBuf, String> {
    swift_helper("galactus-doc")
}

/// The Word editor, which is a script rather than a compiled binary.
fn docx_helper() -> Result<PathBuf, String> {
    python_helper("galactus-docx.py")
}

/// The spreadsheet reader, resolved the same way.
fn sheet_helper() -> Result<PathBuf, String> {
    python_helper("galactus-sheet.py")
}

/// Where a bundled Python helper lives, in the bundle or in a checkout.
///
/// Nothing to build: these run on the Python that already ships in the app,
/// with nothing but the standard library, so unlike the Swift helpers there is
/// no compile step and no machine that can fail to produce one.
fn python_helper(name: &str) -> Result<PathBuf, String> {
    let mut tried: Vec<PathBuf> = Vec::new();
    if let Some(res) = resource_dir() {
        tried.push(res.join("helpers").join(name));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            tried.push(dir.join("helpers").join(name));
            if let Some(up) = dir.parent() {
                tried.push(up.join("Resources").join("helpers").join(name));
            }
        }
    }
    // The checkout, for anyone working on the app itself.
    tried.push(
        std::env::current_dir()
            .unwrap_or_default()
            .join("src-tauri/helpers")
            .join(name),
    );
    // Under test, the crate's own directory, known at compile time.
    //
    // WHY: every other candidate here goes through the settings, and a test
    // that redirects the settings to a scratch folder (settings_read_tests)
    // makes `galactus_root` fail for every OTHER test running beside it. The
    // helpers then look missing, and two document tests failed for a reason
    // that had nothing to do with documents. Compiled out of a release build,
    // where a path from the machine that built it would mean nothing.
    #[cfg(test)]
    tried.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("helpers").join(name));
    if let Ok(root) = galactus_root() {
        tried.push(root.join("app/src-tauri/helpers").join(name));
    }
    tried
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| format!("a helper is missing from this build ({name})"))
}

/// Build or find one of the bundled Swift helpers, by name.
///
/// Was `doc_helper`, hard-coded to one name, until a second helper was needed.
/// Everything here is the original logic with the name lifted out: a
/// precompiled binary in the bundle first, so a Mac without the Command Line
/// Tools works, then a compile into Application Support, refreshed when the
/// source is newer than the cached binary.

fn run_helper(bin: &Path, cmd: &str, path: &str, secs: u64) -> Result<String, String> {
    let child = Command::new(bin)
        .arg(cmd)
        .arg(path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let out = run_with_deadline(child, Instant::now() + Duration::from_secs(secs))?;
    let Some(status) = out.status else {
        return Err("document reading timed out".into());
    };
    if !status.success() {
        return Err(out.stderr.trim().to_string());
    }
    Ok(out.stdout)
}

/// Pull text out of Office files without any dependency: docx/pptx/xlsx are
/// zipped XML, and macOS ships textutil for rtf/doc/html.
fn office_text(path: &str, ext: &str) -> Result<String, String> {
    match ext {
        "rtf" | "doc" | "html" | "htm" | "webarchive" | "odt" => {
            let out = Command::new("textutil")
                .args(["-convert", "txt", "-stdout", path])
                .output()
                .map_err(|e| e.to_string())?;
            if out.status.success() {
                return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
            }
            Err("textutil could not read this file".into())
        }
        // A spreadsheet is not a document with tags to strip. Stripping them
        // handed the caller the shared string table and then a grid of
        // INDEXES into it, plus dates as the day counts they are stored as:
        // usable by nobody, and the source of a silent wrong join on any
        // table long enough to matter. See helpers/galactus-sheet.py.
        "xlsx" | "xlsm" => {
            let script = sheet_helper()?;
            let out = python3_cmd()
                .arg(&script)
                .arg(path)
                .output()
                .map_err(|e| e.to_string())?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
            }
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        }
        "docx" | "pptx" => {
            // textutil handles docx directly; the others go through Python's
            // stdlib zip/XML reader (no third-party packages).
            if ext == "docx" {
                let out = Command::new("textutil")
                    .args(["-convert", "txt", "-stdout", path])
                    .output()
                    .map_err(|e| e.to_string())?;
                if out.status.success() {
                    let text = String::from_utf8_lossy(&out.stdout).into_owned();
                    if !text.trim().is_empty() {
                        return Ok(text);
                    }
                }
            }
            // NOTE: this is a Rust *raw* string, so `\n`/`\t` reach Python as
            // escape sequences inside its own string literals, never put a
            // literal newline inside the Python quotes (SyntaxError).
            let script = r#"
import sys, zipfile, re
p = sys.argv[1]
parts = []
with zipfile.ZipFile(p) as z:
    names = [n for n in z.namelist() if n.endswith('.xml')]
    order = [n for n in names if 'document' in n or 'slide' in n or 'sharedStrings' in n or 'sheet' in n]
    for n in (order or names):
        try:
            raw = z.read(n).decode('utf-8', 'ignore')
        except Exception:
            continue
        raw = re.sub(r'</w:p>|</a:p>|</row>', '\n', raw)
        raw = re.sub(r'<[^>]+>', ' ', raw)
        raw = re.sub(r'[ \t]+', ' ', raw)
        raw = re.sub(r'\n\s*\n+', '\n', raw)
        t = raw.strip()
        if t:
            parts.append(t)
print('\n\n'.join(parts))
"#;
            let out = python3_cmd()
                .arg("-c")
                .arg(script)
                .arg(path)
                .output()
                .map_err(|e| e.to_string())?;
            if out.status.success() {
                Ok(String::from_utf8_lossy(&out.stdout).into_owned())
            } else {
                Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
            }
        }
        _ => Err("unsupported office format".into()),
    }
}

const DOC_MAX: usize = 400_000;

/// One edit asked of a PDF: which operation, and what it needs.
///
/// Flat rather than an enum with payloads because it crosses the Tauri
/// boundary from JavaScript, where a tagged union is a source of silent
/// mismatches. `check` turns it into the argv the helper takes, and every
/// missing field becomes a sentence naming what is missing rather than a
/// helper usage error the user cannot act on.
#[derive(serde::Deserialize, Debug, Clone, Default)]
pub struct DocEdit {
    pub op: String,
    pub path: String,
    #[serde(default)]
    pub out: String,
    #[serde(default)]
    pub find: String,
    #[serde(default)]
    pub replace: String,
    #[serde(default)]
    pub page: u32,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub size: f64,
    #[serde(default)]
    pub text: String,
    /// Keep the page's text layer, at the price of leaving the replaced words
    /// underneath the white box. Off by default; see the helper's comment.
    #[serde(default)]
    pub keep_text: bool,
    /// Word only: narrow the edit to the paragraphs between two anchors, which
    /// is how a section of a contract is addressed when the file has no pages.
    #[serde(default)]
    pub between_start: String,
    #[serde(default)]
    pub between_end: String,
    /// Word only: only paragraph N, numbered as `find` numbers them.
    #[serde(default)]
    pub paragraph: u32,
    /// Word only: only the Nth match, in reading order.
    #[serde(default)]
    pub occurrence: u32,
    /// Word only, for `apply`: a JSON file holding the whole batch of edits.
    #[serde(default)]
    pub plan: String,
}

/// Which helper an edit belongs to, and what to pass it.
#[derive(Debug, PartialEq, Eq)]
pub enum EditPlan {
    /// PDFKit and Core Graphics, through the Swift helper.
    Pdf(Vec<String>),
    /// A zip of XML, through the Python helper. Layout is kept exactly.
    Docx(Vec<String>),
}

fn extension_of(p: &str) -> String {
    Path::new(p)
        .extension()
        .map(|x| x.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/// Decide which editor an edit needs, and refuse the pairings that cannot work.
///
/// The two formats are not interchangeable and the difference is worth
/// refusing on rather than papering over: a .docx keeps its layout because the
/// text is text, and a PDF cannot, because it has none. Asking for a PDF out
/// of a Word document, or the reverse, is a conversion this does not do.
pub fn doc_edit_plan(e: &DocEdit) -> Result<EditPlan, String> {
    let ext = extension_of(&e.path);
    if e.op != "find" && !e.out.trim().is_empty() {
        let out_ext = extension_of(&e.out);
        if out_ext != ext {
            return Err(format!(
                "the result has to be a .{ext} like the source: this edits documents, it does not convert them"
            ));
        }
    }
    match ext.as_str() {
        "pdf" => Ok(EditPlan::Pdf(doc_edit_argv(e)?)),
        "docx" => Ok(EditPlan::Docx(docx_edit_argv(e)?)),
        "doc" => Err("this is the old binary Word format: open it in Word and save it as .docx first".into()),
        _ => Err("editing works on .docx and .pdf files".into()),
    }
}

/// The argument list for the Word helper.
///
/// The operations carry the same names as the PDF ones and mean the nearest
/// equivalent, which for `insert` is not the same thing at all: a Word
/// document has no coordinates, so inserting means adding a paragraph AFTER
/// the one holding a sentence, not drawing at a point.
pub fn docx_edit_argv(e: &DocEdit) -> Result<Vec<String>, String> {
    // The refusal that saves a spreadsheet from being built around a column
    // that cannot work. Word computes pagination when it lays the document
    // out, from the page size, the fonts, the images and the printer driver:
    // the same file paginates differently on two machines, and nothing in the
    // XML says "page 3". Said here, once, in words a user can act on.
    if e.page != 0 {
        return Err(
            "a Word document has no pages to address: Word computes them when it lays the file out,              so nothing in it says page 3. Point at a heading with between_start and between_end,              at a paragraph number, or at an occurrence number instead"
                .into(),
        );
    }
    let scope = |mut v: Vec<String>| -> Vec<String> {
        if !e.between_start.trim().is_empty() {
            v.push("--between".into());
            v.push(e.between_start.clone());
            v.push(e.between_end.clone());
        }
        if e.paragraph > 0 {
            v.push("--paragraph".into());
            v.push(e.paragraph.to_string());
        }
        if e.occurrence > 0 {
            v.push("--occurrence".into());
            v.push(e.occurrence.to_string());
        }
        v
    };
    match e.op.as_str() {
        "find" => {
            if e.find.trim().is_empty() {
                return Err("find needs the text to look for".into());
            }
            Ok(scope(vec!["find".into(), e.path.clone(), e.find.clone()]))
        }
        "replace" => {
            if e.find.trim().is_empty() {
                return Err("replace needs the sentence to look for".into());
            }
            if e.replace.is_empty() {
                return Err("replace needs the replacement text".into());
            }
            Ok(scope(vec![
                "replace".into(),
                e.path.clone(),
                e.out.clone(),
                e.find.clone(),
                e.replace.clone(),
            ]))
        }
        "insert" => {
            if e.find.trim().is_empty() {
                return Err(
                    "in a Word document, insert adds a paragraph after the one holding `find`: say what to look for"
                        .into(),
                );
            }
            if e.text.trim().is_empty() {
                return Err("insert needs the text to add".into());
            }
            Ok(vec![
                "insert".into(),
                e.path.clone(),
                e.out.clone(),
                e.find.clone(),
                e.text.clone(),
            ])
        }
        "append" => {
            if e.text.trim().is_empty() {
                return Err("append needs the text for the new paragraph".into());
            }
            Ok(vec!["append".into(), e.path.clone(), e.out.clone(), e.text.clone()])
        }
        // The whole batch in one pass. WHY IT EXISTS: driving edits one call
        // per row costs a model round trip each time, and a translation matrix
        // is hundreds of rows across a dozen languages. Measured on a real
        // notice, 414 edits over 15 000 paragraphs: 20 seconds here against
        // the hours the same work takes one call at a time.
        "apply" => {
            if e.plan.trim().is_empty() {
                return Err("apply needs a plan: the path of a JSON file holding the edits".into());
            }
            if !Path::new(&e.plan).is_file() {
                return Err(format!("there is no plan at {}", e.plan));
            }
            Ok(vec!["apply".into(), e.path.clone(), e.out.clone(), e.plan.clone()])
        }
        other => Err(format!(
            "unknown operation {other:?}: use find, replace, insert or append"
        )),
    }
}

/// Validate a PDF edit and build the Swift helper's argument list.
///
/// Pure, and tested as such: the refusals here are the ones that would
/// otherwise be discovered as a corrupt file or an unreadable helper error.
pub fn doc_edit_argv(e: &DocEdit) -> Result<Vec<String>, String> {
    let is_pdf = |p: &str| Path::new(p).extension().map(|x| x.eq_ignore_ascii_case("pdf")).unwrap_or(false);
    if !is_pdf(&e.path) {
        return Err("editing works on PDF files only".into());
    }
    let needs_out = e.op != "find";
    if needs_out {
        if e.out.trim().is_empty() {
            return Err("say where to write the result: out is required".into());
        }
        if !is_pdf(&e.out) {
            return Err("the result has to be a .pdf".into());
        }
        // In place would read a file while writing it, and what comes out is
        // neither the old document nor the new one. Refused rather than
        // discovered afterwards, because the input is gone by then.
        if Path::new(&e.out) == Path::new(&e.path) {
            return Err("write the result to a different file: editing in place would destroy the original".into());
        }
    }
    let size = if e.size > 0.0 { e.size } else { 11.0 };
    if !(4.0..=200.0).contains(&size) {
        return Err("size has to be between 4 and 200 points".into());
    }
    match e.op.as_str() {
        "find" => {
            if e.find.trim().is_empty() {
                return Err("find needs the text to look for".into());
            }
            Ok(vec!["find".into(), e.path.clone(), e.find.clone()])
        }
        "replace" => {
            if e.find.trim().is_empty() {
                return Err("replace needs the sentence to look for".into());
            }
            if e.replace.is_empty() {
                return Err("replace needs the replacement text".into());
            }
            let mut v = vec![
                "replace".into(),
                e.path.clone(),
                e.out.clone(),
                e.find.clone(),
                e.replace.clone(),
            ];
            if e.keep_text {
                v.push("--keep-text".into());
            }
            Ok(v)
        }
        "insert" => {
            if e.page == 0 {
                return Err("insert needs a page number, counting from 1".into());
            }
            if e.text.trim().is_empty() {
                return Err("insert needs the text to draw".into());
            }
            if !(0.0..=5000.0).contains(&e.x) || !(0.0..=5000.0).contains(&e.y) {
                return Err("x and y are page points, between 0 and 5000".into());
            }
            Ok(vec![
                "insert".into(),
                e.path.clone(),
                e.out.clone(),
                e.page.to_string(),
                format!("{:.2}", e.x),
                format!("{:.2}", e.y),
                format!("{size:.2}"),
                e.text.clone(),
            ])
        }
        "append" => {
            if e.text.trim().is_empty() {
                return Err("append needs the text for the new page".into());
            }
            Ok(vec![
                "append".into(),
                e.path.clone(),
                e.out.clone(),
                format!("{size:.2}"),
                e.text.clone(),
            ])
        }
        other => Err(format!(
            "unknown operation {other:?}: use find, replace, insert or append"
        )),
    }
}

/// Edit a PDF: replace a sentence, draw text on a page, or add a page.
///
/// The work happens in galactus-doc, the same Swift helper that reads
/// documents, through PDFKit and Core Graphics. No third party library, no
/// network, and nothing leaves the machine.
#[tauri::command]
pub async fn doc_edit(edit: DocEdit) -> Result<String, String> {
    if !Path::new(&edit.path).is_file() {
        return Err(format!("file not found: {}", edit.path));
    }
    let mut cmd = match doc_edit_plan(&edit)? {
        EditPlan::Pdf(args) => {
            let bin = doc_helper()?;
            let mut c = Command::new(&bin);
            c.args(&args);
            c
        }
        EditPlan::Docx(args) => {
            let script = docx_helper()?;
            let mut c = python3_cmd();
            c.arg(&script).args(&args);
            c
        }
    };
    let child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    // Editing a long document rasterises the pages it changes, which is
    // seconds rather than minutes; the same ceiling as reading is plenty.
    let out = run_with_deadline(child, Instant::now() + Duration::from_secs(300))?;
    let Some(status) = out.status else {
        return Err("editing the document timed out".into());
    };
    if !status.success() {
        return Err(out.stderr.trim().to_string());
    }
    Ok(out.stdout.trim().to_string())
}

/// The editing pipeline end to end: a real PDF, the real Swift helper.
///
/// WHY THIS IS NOT `#[ignore]`. The argv tests below are pure and prove
/// nothing about the thing that matters: that the old sentence is gone from
/// the file. The first version of the helper covered it with a white
/// rectangle and left the words in the content stream, so `pdftext` on the
/// result handed the replaced sentence straight back, and no unit test on an
/// argument list could ever have noticed. This one would. It compiles the
/// helper through the same path the app uses, which is a few seconds the
/// first time and cached afterwards, and it needs macOS, which this app is.
#[cfg(test)]
mod doc_edit_live_tests {
    use super::*;

    fn helper_run(bin: &Path, args: &[&str]) -> Result<String, String> {
        let out = Command::new(bin).args(args).output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    /// A one page PDF holding two sentences, built with what macOS ships.
    fn sample_pdf(dir: &Path) -> PathBuf {
        let txt = dir.join("sample.txt");
        std::fs::write(
            &txt,
            "Rapport client Dupont\n\nMerci de votre fidelite depuis 2019.\nVotre conseiller reste joignable.\n",
        )
        .expect("write the source text");
        let pdf = dir.join("sample.pdf");
        let out = Command::new("/usr/sbin/cupsfilter")
            .arg(&txt)
            .output()
            .expect("cupsfilter ships with macOS");
        assert!(out.status.success(), "cupsfilter failed: {}", String::from_utf8_lossy(&out.stderr));
        std::fs::write(&pdf, &out.stdout).expect("write the pdf");
        pdf
    }

    #[test]
    fn a_replaced_sentence_is_gone_from_the_file_and_not_merely_hidden() {
        let bin = doc_helper().expect("the document helper builds");
        let dir = std::env::temp_dir().join(format!("galactus-docedit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch");
        let src = sample_pdf(&dir);
        let out = dir.join("edited.pdf");

        let answer = helper_run(
            &bin,
            &[
                "replace",
                &src.to_string_lossy(),
                &out.to_string_lossy(),
                "Merci de votre fidelite depuis 2019.",
                "Livraison offerte sur votre prochaine commande.",
            ],
        )
        .expect("the replacement runs");
        assert!(answer.contains("\"replaced\":1"), "got: {answer}");

        let before = helper_run(&bin, &["pdftext", &src.to_string_lossy()]).expect("read the source");
        assert!(before.contains("Merci de votre fidelite"), "the fixture must contain it: {before}");
        let after = helper_run(&bin, &["pdftext", &out.to_string_lossy()]).expect("read the result");
        assert!(
            !after.contains("Merci de votre fidelite"),
            "the replaced sentence is still extractable from the result: {after}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_appended_page_is_added_without_touching_the_pages_before_it() {
        let bin = doc_helper().expect("the document helper builds");
        let dir = std::env::temp_dir().join(format!("galactus-docappend-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch");
        let src = sample_pdf(&dir);
        let out = dir.join("appended.pdf");

        let answer = helper_run(
            &bin,
            &[
                "append",
                &src.to_string_lossy(),
                &out.to_string_lossy(),
                "11",
                "Annexe: ligne ajoutee depuis un tableau.",
            ],
        )
        .expect("the append runs");
        assert!(answer.contains("\"pages\":2"), "got: {answer}");
        let text = helper_run(&bin, &["pdftext", &out.to_string_lossy()]).expect("read the result");
        assert!(text.contains("Annexe: ligne ajoutee"), "the new page is missing: {text}");
        // The pages that were already there keep their text: only a page an
        // edit lands on is flattened, and an append lands on none of them.
        assert!(text.contains("Merci de votre fidelite"), "an untouched page lost its text: {text}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Reading a workbook, which is where a table-driven edit begins.
///
/// WHY THE ASSERTIONS ARE ON EXACT LINES. Everything downstream of this is a
/// model reading a table and acting on each row, so a column that shifts by
/// one, or a date printed as the day count it is stored as, is not a display
/// problem: it is the wrong sentence written into the wrong contract. The
/// previous reader stripped the XML tags and printed what was left, which for
/// a spreadsheet is the shared string table followed by a grid of indexes.
#[cfg(test)]
mod sheet_read_tests {
    use super::*;

    /// A workbook with every shape that costs something to get wrong: shared
    /// strings, an inline string, a cached formula result, a date, a gap in
    /// the middle of a row, and a second sheet.
    fn sample_xlsx(dir: &Path) -> PathBuf {
        let script = r#"
import sys, zipfile
out = sys.argv[1]
M = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
shared = ["Document","Phrase a remplacer","Nouvelle phrase","Echeance",
          "contrat-dupont.docx","Le tarif est de 120 euros.","Le tarif est de 96 euros.",
          "contrat-martin.docx","Livraison sous 5 jours."]
ss = '<?xml version="1.0"?><sst ' + M + '>' + ''.join('<si><t>' + v + '</t></si>' for v in shared) + '</sst>'
def s_cell(ref, idx):
    return '<c r="' + ref + '" t="s"><v>' + str(idx) + '</v></c>'
def d_cell(ref, serial):
    return '<c r="' + ref + '" s="1"><v>' + str(serial) + '</v></c>'
rows = (
    '<row r="1">' + s_cell('A1',0) + s_cell('B1',1) + s_cell('C1',2) + s_cell('D1',3) + '</row>'
    '<row r="2">' + s_cell('A2',4) + s_cell('B2',5) + s_cell('C2',6) + d_cell('D2',45658) + '</row>'
    '<row r="3">' + s_cell('A3',7) + s_cell('B3',8) + d_cell('D3',45700) + '</row>'
    '<row r="4"><c r="A4" t="inlineStr"><is><t>contrat-inline.docx</t></is></c>'
    '<c r="B4" t="str"><f>X()</f><v>phrase calculee</v></c><c r="C4"><v>42.5</v></c></row>'
)
sheet = '<?xml version="1.0"?><worksheet ' + M + '><sheetData>' + rows + '</sheetData></worksheet>'
sheet2 = '<?xml version="1.0"?><worksheet ' + M + '><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Notes</t></is></c></row></sheetData></worksheet>'
styles = '<?xml version="1.0"?><styleSheet ' + M + '><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>'
wb = ('<?xml version="1.0"?><workbook ' + M + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      '<sheets><sheet name="Consignes" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>')
rels = ('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>')
ct = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', ct)
    z.writestr('xl/workbook.xml', wb)
    z.writestr('xl/_rels/workbook.xml.rels', rels)
    z.writestr('xl/sharedStrings.xml', ss)
    z.writestr('xl/styles.xml', styles)
    z.writestr('xl/worksheets/sheet1.xml', sheet)
    z.writestr('xl/worksheets/sheet2.xml', sheet2)
"#;
        let path = dir.join("consignes.xlsx");
        let out = python3_cmd().arg("-c").arg(script).arg(&path).output().expect("python runs");
        assert!(out.status.success(), "fixture: {}", String::from_utf8_lossy(&out.stderr));
        path
    }

    #[test]
    fn a_workbook_reads_back_as_a_table_a_caller_can_act_on() {
        let dir = std::env::temp_dir().join(format!("galactus-sheet-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch");
        let path = sample_xlsx(&dir);

        let text = office_text(&path.to_string_lossy(), "xlsx").expect("the workbook reads");
        let lines: Vec<&str> = text.lines().collect();

        assert!(lines[0].contains("sheet: Consignes"), "no sheet header: {text}");
        assert_eq!(lines[1], "row,A,B,C,D", "the columns must be named: {text}");
        // Shared strings resolved, in the right columns, with the Excel row
        // number so a report can name a row the user can find.
        assert_eq!(
            lines[3],
            "2,contrat-dupont.docx,Le tarif est de 120 euros.,Le tarif est de 96 euros.,2025-01-01"
        );
        // The gap at C3 keeps its place: without that, the date walks into the
        // column the replacement text was supposed to be in.
        assert_eq!(lines[4], "3,contrat-martin.docx,Livraison sous 5 jours.,,2025-02-12");
        // An inline string, a formula's cached result, and a plain number.
        assert_eq!(lines[5], "4,contrat-inline.docx,phrase calculee,42.5,");
        // Every sheet, named as its tab is named.
        assert!(text.contains("sheet: Notes"), "the second sheet is missing: {text}");
        // And the failure that started all of this: no raw indexes anywhere.
        assert!(!text.contains("\n0 1 2 3"), "the shared string indexes leaked: {text}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// The Word path end to end, on a document shaped like the ones that break
/// naive tools: a sentence cut across three runs, one of them bold.
#[cfg(test)]
mod docx_edit_live_tests {
    use super::*;

    /// A .docx with a heading style, a bold fragment mid-sentence, an image
    /// and a page setup, written with nothing but zip and string formatting.
    fn sample_docx(dir: &Path) -> PathBuf {
        let script = r#"
import sys, zipfile
out = sys.argv[1]
W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
def run(text, bold=False):
    rpr = '<w:rPr><w:b/></w:rPr>' if bold else ''
    return '<w:r>' + rpr + '<w:t xml:space="preserve">' + text + '</w:t></w:r>'
p1 = '<w:p><w:pPr><w:pStyle w:val="Titre1"/></w:pPr>' + run('Contrat client Dupont') + '</w:p>'
p2 = '<w:p>' + run('Le tarif applicable est de ') + run('120 euros', True) + run(' par mois.') + '</w:p>'
doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ' + W + '><w:body>' + p1 + p2 + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>'
ct = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
rels = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
styles = '<?xml version="1.0"?><w:styles ' + W + '><w:style w:type="paragraph" w:styleId="Titre1"><w:name w:val="heading 1"/></w:style></w:styles>'
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', ct)
    z.writestr('_rels/.rels', rels)
    z.writestr('word/document.xml', doc)
    z.writestr('word/styles.xml', styles)
    z.writestr('word/media/image1.png', b'\x89PNG\r\n\x1a\n' + b'BINARY' * 40)
"#;
        let path = dir.join("contrat.docx");
        let out = python3_cmd()
            .arg("-c")
            .arg(script)
            .arg(&path)
            .output()
            .expect("python runs");
        assert!(out.status.success(), "fixture: {}", String::from_utf8_lossy(&out.stderr));
        path
    }

    fn run_edit(edit: &DocEdit) -> String {
        let args = match doc_edit_plan(edit).expect("a plan") {
            EditPlan::Docx(a) => a,
            EditPlan::Pdf(_) => panic!("a .docx must not be sent to the PDF helper"),
        };
        let out = python3_cmd()
            .arg(docx_helper().expect("the helper ships"))
            .args(&args)
            .output()
            .expect("the helper runs");
        assert!(out.status.success(), "helper: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn a_sentence_split_across_runs_is_replaced_and_the_layout_survives() {
        let dir = std::env::temp_dir().join(format!("galactus-docx-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch");
        let src = sample_docx(&dir);
        let out = dir.join("modifie.docx");

        // The needle spans three runs and the middle one is bold: a tool that
        // searched inside each run would find nothing at all here, which is
        // the failure this whole helper is shaped around.
        let answer = run_edit(&DocEdit {
            op: "replace".into(),
            path: src.to_string_lossy().into(),
            out: out.to_string_lossy().into(),
            find: "Le tarif applicable est de 120 euros par mois.".into(),
            replace: "Le tarif applicable est de 96 euros par mois.".into(),
            ..Default::default()
        });
        assert!(answer.contains("\"replaced\": 1"), "got: {answer}");

        // What Word will read, through the reader macOS itself ships.
        let text = office_text(&out.to_string_lossy(), "docx").expect("readable");
        assert!(text.contains("96 euros"), "the edit is missing: {text}");
        assert!(!text.contains("120 euros"), "the old amount survived: {text}");

        // And the layout: every part except the document is byte identical,
        // and the document keeps its style, its bold and its page setup.
        let check = python3_cmd()
            .arg("-c")
            .arg(
                r#"
import sys, zipfile
a = zipfile.ZipFile(sys.argv[1]); b = zipfile.ZipFile(sys.argv[2])
assert a.namelist() == b.namelist(), 'the parts changed'
for name in a.namelist():
    if name == 'word/document.xml':
        continue
    assert a.read(name) == b.read(name), 'part rewritten: ' + name
doc = b.read('word/document.xml').decode()
assert 'w:val="Titre1"' in doc, 'the heading style is gone'
assert '<w:b' in doc, 'the bold run is gone'
assert '11906' in doc, 'the page setup is gone'
print('ok')
"#,
            )
            .arg(&src)
            .arg(&out)
            .output()
            .expect("python runs");
        assert!(
            check.status.success(),
            "layout check failed: {}",
            String::from_utf8_lossy(&check.stderr)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Every place a sentence can hide in a real contract, in one document.
    ///
    /// Body text, a table cell, a text box, a header, a footer and a footnote.
    /// The last four are parts of their own inside the zip and were invisible
    /// to any reader that only opened word/document.xml.
    ///
    /// The equality between what `find` counts and what `replace` changes is
    /// the assertion that matters most, because the skill makes callers run a
    /// dry pass over the whole batch and show it to the user before writing
    /// anything. A text box is a paragraph nested inside another paragraph, so
    /// a recursive read counted it twice: the dry run said seven where six
    /// happened, which is exactly the number a user would have been asked to
    /// approve.
    #[test]
    fn a_sentence_is_found_and_replaced_wherever_word_can_hide_it() {
        let dir = std::env::temp_dir().join(format!("galactus-docx-parts-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch");

        let script = r#"
import sys, zipfile
out = sys.argv[1]
W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
def r(t, b=False):
    rpr = '<w:rPr><w:b/></w:rPr>' if b else ''
    return '<w:r>' + rpr + '<w:t xml:space="preserve">' + t + '</w:t></w:r>'
def phrase():
    return r('Le tarif est de ') + r('120 euros', True) + r(' par mois.')
body = '<w:p>' + phrase() + '</w:p>'
table = '<w:tbl><w:tr><w:tc><w:p>' + r('Ligne') + '</w:p></w:tc><w:tc><w:p>' + phrase() + '</w:p></w:tc></w:tr></w:tbl>'
box = ('<w:p><w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">'
       '<mc:Choice Requires="wps"><w:drawing><w:txbxContent><w:p>' + phrase() + '</w:p></w:txbxContent></w:drawing>'
       '</mc:Choice></mc:AlternateContent></w:r></w:p>')
doc = '<?xml version="1.0"?><w:document ' + W + '><w:body>' + body + table + box + '<w:sectPr/></w:body></w:document>'
hdr = '<?xml version="1.0"?><w:hdr ' + W + '><w:p>' + phrase() + '</w:p></w:hdr>'
ftr = '<?xml version="1.0"?><w:ftr ' + W + '><w:p>' + phrase() + '</w:p></w:ftr>'
fn = '<?xml version="1.0"?><w:footnotes ' + W + '><w:footnote w:id="1"><w:p>' + phrase() + '</w:p></w:footnote></w:footnotes>'
ct = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'
rels = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', ct)
    z.writestr('_rels/.rels', rels)
    z.writestr('word/document.xml', doc)
    z.writestr('word/header1.xml', hdr)
    z.writestr('word/footer1.xml', ftr)
    z.writestr('word/footnotes.xml', fn)
"#;
        let src = dir.join("complet.docx");
        let made = python3_cmd().arg("-c").arg(script).arg(&src).output().expect("python runs");
        assert!(made.status.success(), "fixture: {}", String::from_utf8_lossy(&made.stderr));

        let needle = "Le tarif est de 120 euros par mois.";
        let found = run_edit(&DocEdit {
            op: "find".into(),
            path: src.to_string_lossy().into(),
            find: needle.into(),
            ..Default::default()
        });
        assert!(found.contains("\"total\": 6"), "the dry run miscounts: {found}");
        for part in ["header1.xml", "footer1.xml", "footnotes.xml"] {
            assert!(found.contains(part), "{part} was not searched: {found}");
        }

        let out = dir.join("complet-modifie.docx");
        let answer = run_edit(&DocEdit {
            op: "replace".into(),
            path: src.to_string_lossy().into(),
            out: out.to_string_lossy().into(),
            find: needle.into(),
            replace: "Le tarif est de 96 euros par mois.".into(),
            ..Default::default()
        });
        assert!(
            answer.contains("\"replaced\": 6"),
            "what was announced and what was done must agree: {answer}"
        );

        // And the old amount is gone from every part, not merely from the body.
        let check = python3_cmd()
            .arg("-c")
            .arg(
                r#"
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
for name in ['word/document.xml', 'word/header1.xml', 'word/footer1.xml', 'word/footnotes.xml']:
    text = z.read(name).decode()
    assert '120 euros' not in text, 'the old amount survived in ' + name
    assert '96 euros' in text, 'the new amount is missing from ' + name
print('ok')
"#,
            )
            .arg(&out)
            .output()
            .expect("python runs");
        assert!(check.status.success(), "{}", String::from_utf8_lossy(&check.stderr));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A section of a contract, addressed the only way a .docx allows.
    ///
    /// WHY THIS MATTERS MORE THAN IT LOOKS. A table driving edits wants to say
    /// WHERE, and the obvious column to write is "page". A Word file has no
    /// pages: Word computes them at layout time from the page size, the fonts,
    /// the images and the printer driver, so the same file paginates
    /// differently on two machines and nothing in the XML says "page 3". What
    /// it does have is headings, and this pins that a range between two of
    /// them reaches one article and leaves the identical sentences in the
    /// articles on either side alone.
    #[test]
    fn a_range_between_two_headings_reaches_one_article_and_spares_the_others() {
        let dir = std::env::temp_dir().join(format!("galactus-docx-scope-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch");

        let script = r#"
import sys, zipfile
out = sys.argv[1]
W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
def p(t):
    return '<w:p><w:r><w:t xml:space="preserve">' + t + '</w:t></w:r></w:p>'
brk = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
body = (p('Article 3 - Duree') + p('Le tarif est de 120 euros par mois.') + brk +
        p('Article 4 - Tarifs') + p('Le tarif est de 120 euros par mois.') + p('Revision annuelle.') +
        brk + p('Article 5 - Resiliation') + p('Le tarif est de 120 euros par mois.'))
doc = '<?xml version="1.0"?><w:document ' + W + '><w:body>' + body + '<w:sectPr/></w:body></w:document>'
ct = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'
rels = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', ct)
    z.writestr('_rels/.rels', rels)
    z.writestr('word/document.xml', doc)
"#;
        let src = dir.join("contrat.docx");
        let made = python3_cmd().arg("-c").arg(script).arg(&src).output().expect("python runs");
        assert!(made.status.success(), "fixture: {}", String::from_utf8_lossy(&made.stderr));

        // Unscoped, the sentence is in all three articles.
        let all = run_edit(&DocEdit {
            op: "find".into(),
            path: src.to_string_lossy().into(),
            find: "120 euros".into(),
            ..Default::default()
        });
        assert!(all.contains("\"total\": 3"), "got: {all}");
        // And the answer says how much hand pagination there is, which is what
        // tells a caller whether "page" was ever a meaningful column.
        assert!(all.contains("\"explicit_page_breaks\": 2"), "got: {all}");

        let out = dir.join("cible.docx");
        let answer = run_edit(&DocEdit {
            op: "replace".into(),
            path: src.to_string_lossy().into(),
            out: out.to_string_lossy().into(),
            find: "120 euros".into(),
            replace: "96 euros".into(),
            between_start: "Article 4".into(),
            between_end: "Article 5".into(),
            ..Default::default()
        });
        assert!(answer.contains("\"replaced\": 1"), "the range leaked: {answer}");

        let text = office_text(&out.to_string_lossy(), "docx").expect("readable");
        assert_eq!(text.matches("120 euros").count(), 2, "the other articles changed: {text}");
        assert_eq!(text.matches("96 euros").count(), 1, "article 4 did not change: {text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Asking for a page on a Word document is refused, with the reason.
    #[test]
    fn a_page_number_on_a_word_document_is_refused_in_words() {
        let err = doc_edit_plan(&DocEdit {
            op: "replace".into(),
            path: "/tmp/contrat.docx".into(),
            out: "/tmp/sortie.docx".into(),
            find: "x".into(),
            replace: "y".into(),
            page: 3,
            ..Default::default()
        })
        .unwrap_err();
        assert!(err.contains("no pages to address"), "got: {err}");
        assert!(err.contains("between_start"), "the message must say what to use instead: {err}");
    }

    /// The edited part keeps every namespace prefix the original declared.
    ///
    /// WHY THIS IS THE MOST IMPORTANT TEST IN THIS MODULE. A Word file declares
    /// three dozen namespaces and then refers to some of them BY NAME, in the
    /// value of `mc:Ignorable` and in the `Requires` of every AlternateContent
    /// block. ElementTree does not keep the prefixes it read: it invents ns0,
    /// ns1, ns2 for anything it was not told about, and those references then
    /// point at names nobody declares. The file is still well formed XML, so
    /// nothing fails on our side; Word opens it, calls the content unreadable
    /// and offers to repair it. That shipped, and the user found it before any
    /// test did.
    #[test]
    fn every_namespace_prefix_survives_an_edit() {
        let dir = std::env::temp_dir().join(format!("galactus-docx-ns-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch");

        let script = r#"
import sys, zipfile
out = sys.argv[1]
# A root shaped like Word's: several prefixes, one of them named only inside
# mc:Ignorable, and a namespace declared deeper in the tree rather than here.
root = ('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
        'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
        'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" '
        'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" '
        'mc:Ignorable="w14">')
inner = ('<w:p><w:r><w:t xml:space="preserve">Le tarif est de 120 euros.</w:t></w:r></w:r></w:p>'
         .replace('</w:r></w:r>', '</w:r>'))
deep = ('<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps">'
        '<w:drawing xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main">'
        '<w:txbxContent><w:p><w:r><w:t>encadre</w:t></w:r></w:p></w:txbxContent>'
        '</w:drawing></mc:Choice></mc:AlternateContent></w:r></w:p>')
doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + root + '<w:body>' + inner + deep + '</w:body></w:document>'
ct = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'
rels = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', ct)
    z.writestr('_rels/.rels', rels)
    z.writestr('word/document.xml', doc)
"#;
        let src = dir.join("styled.docx");
        let made = python3_cmd().arg("-c").arg(script).arg(&src).output().expect("python runs");
        assert!(made.status.success(), "fixture: {}", String::from_utf8_lossy(&made.stderr));

        let out = dir.join("edited.docx");
        let answer = run_edit(&DocEdit {
            op: "replace".into(),
            path: src.to_string_lossy().into(),
            out: out.to_string_lossy().into(),
            find: "120 euros".into(),
            replace: "96 euros".into(),
            ..Default::default()
        });
        assert!(answer.contains("\"replaced\": 1"), "got: {answer}");

        let check = python3_cmd()
            .arg("-c")
            .arg(
                r#"
import sys, zipfile, re
def root_tag(data):
    i = 0
    while True:
        i = data.find(b'<', i)
        if i < 0: return b''
        if data[i+1:i+2] not in (b'?', b'!'):
            return data[i:data.find(b'>', i)+1]
        i = data.find(b'>', i) + 1
a = zipfile.ZipFile(sys.argv[1]).read('word/document.xml')
b = zipfile.ZipFile(sys.argv[2]).read('word/document.xml')
pa = dict(re.findall(rb'xmlns:([A-Za-z0-9_.\-]+)="([^"]+)"', root_tag(a)))
pb = dict(re.findall(rb'xmlns:([A-Za-z0-9_.\-]+)="([^"]+)"', root_tag(b)))
for prefix, uri in pa.items():
    assert prefix in pb, 'prefix dropped: ' + prefix.decode()
    assert pb[prefix] == uri, 'prefix rebound: ' + prefix.decode()
assert not re.search(rb'xmlns:ns[0-9]+=', b), 'a prefix was invented'
ign = re.search(rb'mc:Ignorable="([^"]*)"', root_tag(b))
assert ign, 'mc:Ignorable was dropped'
for name in ign.group(1).split():
    assert name in pb, 'mc:Ignorable names an undeclared prefix: ' + name.decode()
for name in re.findall(rb'Requires="([^"]*)"', b):
    assert name in pb, 'Requires names an undeclared prefix: ' + name.decode()
print('ok')
"#,
            )
            .arg(&src)
            .arg(&out)
            .output()
            .expect("python runs");
        assert!(
            check.status.success(),
            "the edited file would not open in Word: {}",
            String::from_utf8_lossy(&check.stderr)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An inserted paragraph takes the font of the one it follows, even when
    /// that paragraph's runs are wrapped in tracked changes.
    ///
    /// WHY THE WRAPPING MATTERS. Word puts every inserted run inside <w:ins>,
    /// and a document under review is made of them: the notice this was found
    /// on carries 5534. A search for the paragraph's first run among its DIRECT
    /// children finds nothing there, so the new paragraph was created with no
    /// run properties at all and Word drew it in the document default. Beside
    /// Arial text in a table, that is visible at a glance, and no test saw it
    /// because every fixture here had plain runs.
    #[test]
    fn an_inserted_paragraph_keeps_the_font_through_tracked_changes() {
        let dir = std::env::temp_dir().join(format!("galactus-docx-font-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch");

        let script = r#"
import sys, zipfile
out = sys.argv[1]
W = ('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"')
rpr = '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="18"/></w:rPr>'
# The run is inside <w:ins>, exactly as Word writes a document under review,
# and the paragraph carries a style as a table cell paragraph does.
para = ('<w:p><w:pPr><w:pStyle w:val="Sansinterligne"/></w:pPr>'
        '<w:ins w:id="7" w:author="X" w:date="2026-01-01T00:00:00Z">'
        '<w:r>' + rpr + '<w:t xml:space="preserve">Pinces de prehension</w:t></w:r></w:ins></w:p>')
table = '<w:tbl><w:tr><w:tc>' + para + '</w:tc></w:tr></w:tbl>'
doc = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ' + W + '>'
       '<w:body>' + table + '<w:sectPr/></w:body></w:document>')
ct = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'
rels = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', ct)
    z.writestr('_rels/.rels', rels)
    z.writestr('word/document.xml', doc)
"#;
        let src = dir.join("revise.docx");
        let made = python3_cmd().arg("-c").arg(script).arg(&src).output().expect("python runs");
        assert!(made.status.success(), "fixture: {}", String::from_utf8_lossy(&made.stderr));

        let out = dir.join("avec-traduction.docx");
        let answer = run_edit(&DocEdit {
            op: "insert".into(),
            path: src.to_string_lossy().into(),
            out: out.to_string_lossy().into(),
            find: "Pinces de prehension".into(),
            text: "[EN] Gripping tweezers".into(),
            ..Default::default()
        });
        assert!(answer.contains("\"inserted\": 1"), "got: {answer}");

        let check = python3_cmd()
            .arg("-c")
            .arg(
                r#"
import sys, zipfile, re
doc = zipfile.ZipFile(sys.argv[1]).read('word/document.xml').decode()
new = doc[doc.index('Gripping tweezers') - 600 : doc.index('Gripping tweezers')]
assert 'w:ascii="Arial"' in new, 'the inserted run lost the font: ' + new[-300:]
assert 'w:val="18"' in new, 'the inserted run lost the size'
assert 'Sansinterligne' in new, 'the inserted paragraph lost the style'
print('ok')
"#,
            )
            .arg(&out)
            .output()
            .expect("python runs");
        assert!(
            check.status.success(),
            "the inserted line would not match its neighbours: {}",
            String::from_utf8_lossy(&check.stderr)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_found_writes_nothing_at_all() {
        // The failure it prevents: an untouched copy that a caller reports as
        // an edit, and a user who ships the wrong contract.
        let dir = std::env::temp_dir().join(format!("galactus-docx-miss-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch");
        let src = sample_docx(&dir);
        let out = dir.join("jamais.docx");
        let answer = run_edit(&DocEdit {
            op: "replace".into(),
            path: src.to_string_lossy().into(),
            out: out.to_string_lossy().into(),
            find: "une phrase qui n'existe pas".into(),
            replace: "peu importe".into(),
            ..Default::default()
        });
        assert!(answer.contains("\"replaced\": 0"), "got: {answer}");
        assert!(!out.exists(), "a file was written for an edit that did not happen");
        let _ = std::fs::remove_dir_all(&dir);
    }
}


#[cfg(test)]
mod doc_edit_tests {
    use super::*;

    fn edit(op: &str) -> DocEdit {
        DocEdit {
            op: op.into(),
            path: "/tmp/in.pdf".into(),
            out: "/tmp/out.pdf".into(),
            ..Default::default()
        }
    }

    #[test]
    fn only_pdfs_are_edited_and_only_to_another_file() {
        let mut e = edit("append");
        e.text = "x".into();
        e.path = "/tmp/notes.txt".into();
        assert!(doc_edit_argv(&e).unwrap_err().contains("PDF files only"));

        let mut e = edit("append");
        e.text = "x".into();
        e.out = "/tmp/out.txt".into();
        assert!(doc_edit_argv(&e).unwrap_err().contains("has to be a .pdf"));

        // The one that would destroy the document: the helper reads the input
        // while the context writes the output, and in place is neither.
        let mut e = edit("append");
        e.text = "x".into();
        e.out = e.path.clone();
        assert!(doc_edit_argv(&e).unwrap_err().contains("destroy the original"));
    }

    #[test]
    fn each_operation_says_what_it_is_missing() {
        assert!(doc_edit_argv(&edit("find")).unwrap_err().contains("text to look for"));
        assert!(doc_edit_argv(&edit("replace")).unwrap_err().contains("sentence to look for"));
        assert!(doc_edit_argv(&edit("insert")).unwrap_err().contains("page number"));
        assert!(doc_edit_argv(&edit("append")).unwrap_err().contains("text for the new page"));
        assert!(doc_edit_argv(&edit("delete")).unwrap_err().contains("unknown operation"));
        // find is the one operation that writes nothing, so it must not demand
        // an output file.
        let mut e = edit("find");
        e.out = String::new();
        e.find = "hello".into();
        assert_eq!(doc_edit_argv(&e).unwrap(), vec!["find", "/tmp/in.pdf", "hello"]);
    }

    #[test]
    fn a_replacement_keeps_the_text_layer_only_when_asked() {
        let mut e = edit("replace");
        e.find = "old".into();
        e.replace = "new".into();
        let plain = doc_edit_argv(&e).unwrap();
        assert!(!plain.contains(&"--keep-text".to_string()), "flattening is the default");
        e.keep_text = true;
        assert!(doc_edit_argv(&e).unwrap().contains(&"--keep-text".to_string()));
    }

    #[test]
    fn numbers_are_bounded_and_defaulted() {
        let mut e = edit("insert");
        e.page = 1;
        e.text = "hello".into();
        e.x = 60.0;
        e.y = 300.0;
        // No size given means the readable default, not zero.
        assert_eq!(doc_edit_argv(&e).unwrap()[6], "11.00");
        e.size = 900.0;
        assert!(doc_edit_argv(&e).unwrap_err().contains("between 4 and 200"));
        e.size = 12.0;
        e.x = -5.0;
        assert!(doc_edit_argv(&e).unwrap_err().contains("page points"));
    }

    #[test]
    fn the_replacement_text_reaches_the_helper_as_one_argument() {
        // Not a shell: a sentence with quotes, an ampersand and a newline is a
        // single argv entry, so nothing needs escaping and nothing can inject.
        let mut e = edit("replace");
        e.find = "old".into();
        e.replace = "Tarif \"2026\" & remise\nligne deux".into();
        let v = doc_edit_argv(&e).unwrap();
        assert_eq!(v[4], "Tarif \"2026\" & remise\nligne deux");
        assert_eq!(v.len(), 5);
    }
}

/// Read any document as text. `mode` is "auto" (text layer, OCR fallback),
/// "ocr" (force OCR) or "text" (text layer only).
#[tauri::command]
pub async fn doc_read(path: String, mode: Option<String>) -> Result<String, String> {
    if !Path::new(&path).is_file() {
        return Err(format!("file not found: {path}"));
    }
    let ext = Path::new(&path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let mode = mode.unwrap_or_else(|| "auto".into());

    let text = match ext.as_str() {
        "txt" | "md" | "markdown" | "csv" | "tsv" | "json" | "log" | "yaml" | "yml" | "xml"
        | "srt" | "vtt" | "ini" | "toml" | "conf" => {
            std::fs::read_to_string(&path).map_err(|e| e.to_string())?
        }
        "pdf" | "png" | "jpg" | "jpeg" | "heic" | "heif" | "tiff" | "tif" | "bmp" | "gif"
        | "webp" => {
            let bin = doc_helper()?;
            let cmd = match mode.as_str() {
                "ocr" => "ocr",
                "text" => "pdftext",
                _ => "auto",
            };
            run_helper(&bin, cmd, &path, 300)?
        }
        "rtf" | "doc" | "docx" | "pptx" | "xlsx" | "html" | "htm" | "odt" | "webarchive" => {
            office_text(&path, &ext)?
        }
        _ => {
            // Unknown extension: try plain text, fall back to OCR if binary.
            match std::fs::read_to_string(&path) {
                Ok(t) => t,
                Err(_) => {
                    let bin = doc_helper()?;
                    run_helper(&bin, "auto", &path, 300)?
                }
            }
        }
    };

    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok("(no text found in this document)".into());
    }
    if trimmed.len() > DOC_MAX {
        let mut cut = trimmed[..floor_char_boundary(trimmed, DOC_MAX)].to_string();
        cut.push_str("\n…(truncated)");
        return Ok(cut);
    }
    Ok(trimmed.to_string())
}

/// Quick capability probe for the UI (is the OCR helper usable?).
#[tauri::command]
pub fn doc_capabilities() -> Value {
    // The Xcode stub at /usr/bin/swiftc exists even without the Command Line
    // Tools, only a successful exit means the compiler is really usable.
    let swiftc = Command::new("swiftc")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let helper = doc_helper().is_ok();
    json!({ "swiftc": swiftc, "helper": helper })
}
