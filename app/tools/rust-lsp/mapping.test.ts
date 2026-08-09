// The pure half of the .rs tier: positions, URIs and payload shapes.
//
// Every assertion here is about a conversion that has exactly one correct
// answer and several plausible wrong ones. The two that would really hurt in
// production are the position mapping on non-ASCII lines (LSP counts UTF-16
// code units, and getting that wrong moves every hover by a few characters on
// any line with an accent) and the URI encoding, which has to produce byte for
// byte the same string as `path_to_uri` in src-tauri/src/lsp.rs or the server
// answers about a document it has never been told about.

import {
  applyEdits,
  completionItems,
  completionType,
  locations,
  lspRangeToOffsets,
  lspToPos,
  pathToUri,
  posToLsp,
  RUST_LSP_SOURCE,
  rustReferencesHtml,
  severityOf,
  sourceLabel,
  splitHoverMarkdown,
  toEditorDiagnostics,
  uriToPath,
  uriToRel,
  workspaceEditFiles,
  type TextDocLike,
} from "../../src/code/rust-lsp.js";

const builtin = (name: string): Promise<any> => import(name);
const { test } = await builtin("node:test");
const assert = (await builtin("node:assert/strict")).default;

/** The three methods `TextDocLike` promises, over a plain string. */
function doc(text: string): TextDocLike {
  const lines = text.split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const l of lines) {
    starts.push(at);
    at += l.length + 1;
  }
  return {
    length: text.length,
    lines: lines.length,
    line(n: number) {
      const i = Math.min(Math.max(n, 1), lines.length) - 1;
      return { from: starts[i], to: starts[i] + lines[i].length, text: lines[i] };
    },
    toString: () => text,
  };
}

// ---------------------------------------------------------------- positions

test("offsets and LSP positions round trip on every offset of a plain buffer", () => {
  const text = "fn main() {\n    let x = 1;\n}\n";
  const d = doc(text);
  for (let pos = 0; pos <= text.length; pos++) {
    const back = lspToPos(d, posToLsp(d, pos));
    assert.equal(back, pos, `offset ${pos} did not survive the round trip`);
  }
});

test("characters are UTF-16 code units, not bytes and not codepoints", () => {
  // "é" is one UTF-16 unit and two UTF-8 bytes; the emoji is two UTF-16 units
  // and one codepoint. A client counting either of the other two reports this
  // line's columns wrong, and every hover on it lands on the wrong token.
  const text = 'let s = "é🚀";';
  const d = doc(text);
  const afterEmoji = text.indexOf('"', 9) + 1;
  const p = posToLsp(d, afterEmoji);
  assert.equal(p.line, 0);
  assert.equal(p.character, afterEmoji);
  assert.equal(p.character, [...text.slice(0, afterEmoji)].length + 1, "the emoji counts twice");
  assert.equal(lspToPos(d, p), afterEmoji);
});

test("a character past the end of a line stops at the line end", () => {
  // rust-analyzer answers about the buffer it was last told about. When the
  // user has already deleted half the line, an unclamped conversion spills
  // into the NEXT line and underlines innocent code.
  const d = doc("short\nmuch longer line\n");
  assert.equal(lspToPos(d, { line: 0, character: 99 }), 5);
  assert.equal(lspToPos(d, { line: 99, character: 0 }), doc("short\nmuch longer line\n").line(3).from);
});

test("negative and fractional positions are clamped rather than thrown", () => {
  const d = doc("a\nb\n");
  assert.equal(lspToPos(d, { line: -3, character: -7 }), 0);
  assert.equal(posToLsp(d, -1).line, 0);
  assert.equal(posToLsp(d, 10_000).line, 2);
});

test("a zero width diagnostic range is widened to one character", () => {
  // A marker with from === to draws nothing at all: the error exists and the
  // user never sees it.
  const d = doc("fn f() {}\n");
  const r = lspRangeToOffsets(d, { start: { line: 0, character: 3 }, end: { line: 0, character: 3 } });
  assert.deepEqual(r, { from: 3, to: 4 });
});

test("line lookup is exact on the last line and on an empty trailing line", () => {
  const d = doc("a\nbb\n");
  assert.deepEqual(posToLsp(d, 5), { line: 2, character: 0 });
  assert.deepEqual(posToLsp(d, 2), { line: 1, character: 0 });
  assert.deepEqual(posToLsp(d, 4), { line: 1, character: 2 });
});

// ---------------------------------------------------------------- uri

test("file URIs match the Rust side byte for byte", () => {
  // These two expectations are duplicated in lsp.rs's own tests on purpose:
  // if the two encoders ever drift, both suites fail and the drift is named.
  assert.equal(
    pathToUri("/Volumes/Noxalis Lab/a+b/main.rs"),
    "file:///Volumes/Noxalis%20Lab/a%2Bb/main.rs"
  );
  assert.equal(pathToUri("/tmp/café"), "file:///tmp/caf%C3%A9");
});

test("encodeURIComponent would be wrong here, in both directions", () => {
  // It escapes the separator and leaves characters the Rust side escapes.
  assert.notEqual("file://" + encodeURIComponent("/a b/c.rs"), pathToUri("/a b/c.rs"));
  assert.equal(pathToUri("/a'b(c)!/d*.rs"), "file:///a%27b%28c%29%21/d%2A.rs");
});

test("URIs decode back to the original path, multi-byte included", () => {
  for (const p of ["/tmp/café/naïve.rs", "/a b/c+d/e.rs", "/plain/path.rs", "/emoji/🚀/x.rs"]) {
    assert.equal(uriToPath(pathToUri(p)), p);
  }
});

test("a URI outside the workspace resolves to null, not to a bogus relative path", () => {
  // Go to definition on a std item lands in the bundled sources inside the
  // .app. Returning something like "../../Resources/..." would make the Code
  // view try to open a file its tree cannot show.
  const root = "/Users/x/proj";
  assert.equal(uriToRel(root, pathToUri("/Users/x/proj/src/main.rs")), "src/main.rs");
  assert.equal(uriToRel(root, pathToUri("/Applications/Galactus.app/library/std/src/lib.rs")), null);
  // A sibling whose name merely starts with the root is outside too.
  assert.equal(uriToRel(root, pathToUri("/Users/x/proj-other/src/main.rs")), null);
});

// ---------------------------------------------------------------- diagnostics

test("a diagnostic with no severity is an error", () => {
  // The specification says absent means error. Defaulting to info would hide
  // exactly the diagnostics worth showing.
  assert.equal(severityOf({ range: r(0, 0, 0, 1), message: "x" }), "error");
  assert.equal(severityOf({ range: r(0, 0, 0, 1), message: "x", severity: 2 }), "warning");
  assert.equal(severityOf({ range: r(0, 0, 0, 1), message: "x", severity: 3 }), "info");
  assert.equal(severityOf({ range: r(0, 0, 0, 1), message: "x", severity: 4 }), "hint");
});

test("the source label carries the code when there is one", () => {
  assert.equal(sourceLabel({ range: r(0, 0, 0, 1), message: "m", code: "E0433" }), "rust(E0433)");
  assert.equal(sourceLabel({ range: r(0, 0, 0, 1), message: "m" }), RUST_LSP_SOURCE);
});

test("published diagnostics map onto the buffer the editor is showing", () => {
  const d = doc("fn main() {\n    undefined_thing();\n}\n");
  const out = toEditorDiagnostics(d, [
    { range: r(1, 4, 1, 19), severity: 1, code: "E0425", message: "cannot find function" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, "error");
  assert.equal(out[0].source, "rust(E0425)");
  assert.equal(d.toString().slice(out[0].from, out[0].to), "undefined_thing");
});

// ---------------------------------------------------------------- hover

test("a rust-analyzer hover splits into a signature and its prose", () => {
  // Verbatim shape of a real answer, captured from the bundled server.
  const markdown =
    "\n```rust\ncore::time\n```\n\n```rust\npub struct Duration { /* … */ }\n```\n\n---\n\n" +
    "A `Duration` type to represent a span of time.\n";
  const { signature, docs } = splitHoverMarkdown(markdown);
  assert.equal(signature, "core::time\npub struct Duration { /* … */ }");
  assert.equal(docs, "A `Duration` type to represent a span of time.");
});

test("a hover with no code fence still yields its prose", () => {
  const { signature, docs } = splitHoverMarkdown("just words\n");
  assert.equal(signature, "");
  assert.equal(docs, "just words");
});

// ---------------------------------------------------------------- completion

test("both completion payload shapes are accepted", () => {
  assert.equal(completionItems([{ label: "a" }]).length, 1);
  assert.equal(completionItems({ isIncomplete: true, items: [{ label: "a" }, { label: "b" }] }).length, 2);
  assert.equal(completionItems(null).length, 0);
  assert.equal(completionItems({ nope: 1 }).length, 0);
});

test("completion kinds map to icons rather than falling through to text", () => {
  assert.equal(completionType(3), "function");
  assert.equal(completionType(22), "class");
  assert.equal(completionType(5), "property");
  assert.equal(completionType(14), "keyword");
  assert.equal(completionType(undefined), "text");
});

// ---------------------------------------------------------------- locations

test("Location, Location[] and LocationLink[] all resolve", () => {
  const range = r(2, 0, 2, 5);
  assert.equal(locations({ uri: "file:///a.rs", range }).length, 1);
  assert.equal(locations([{ uri: "file:///a.rs", range }]).length, 1);
  const link = locations([{ targetUri: "file:///a.rs", targetSelectionRange: range, targetRange: range }]);
  assert.equal(link.length, 1);
  assert.equal(link[0].uri, "file:///a.rs");
  assert.equal(locations(null).length, 0);
  // Half an answer is no answer: a link with no range cannot move a cursor.
  assert.equal(locations([{ targetUri: "file:///a.rs" }]).length, 0);
});

// ---------------------------------------------------------------- rename

test("workspace edits are read from both the old and the new shape", () => {
  const edit = { range: r(0, 0, 0, 1), newText: "y" };
  assert.equal(workspaceEditFiles({ changes: { "file:///a.rs": [edit] } }).length, 1);
  assert.equal(
    workspaceEditFiles({ documentChanges: [{ textDocument: { uri: "file:///a.rs" }, edits: [edit] }] }).length,
    1
  );
  // A create/rename/delete operation has no textDocument and must not be
  // mistaken for an empty edit list.
  assert.equal(workspaceEditFiles({ documentChanges: [{ edits: [edit] }] }).length, 0);
});

test("edits apply back to front so earlier ones cannot move later ones", () => {
  const text = "let aa = aa + aa;\n";
  const d = doc(text);
  const out = applyEdits(d, text, [
    { range: r(0, 4, 0, 6), newText: "renamed" },
    { range: r(0, 9, 0, 11), newText: "renamed" },
    { range: r(0, 14, 0, 16), newText: "renamed" },
  ]);
  assert.equal(out, "let renamed = renamed + renamed;\n");
});

test("an empty edit range inserts and does not eat the next character", () => {
  // lspRangeToOffsets widens a zero width range for DISPLAY. Doing that here
  // would delete a character on every insertion.
  const text = "abc";
  assert.equal(applyEdits(doc(text), text, [{ range: r(0, 1, 0, 1), newText: "X" }]), "aXbc");
});

test("overlapping edits are refused rather than silently corrupting a file", () => {
  const text = "abcdef";
  assert.throws(
    () =>
      applyEdits(doc(text), text, [
        { range: r(0, 0, 0, 4), newText: "X" },
        { range: r(0, 2, 0, 6), newText: "Y" },
      ]),
    /overlapping/
  );
});

test("edits spanning several lines are applied against the right offsets", () => {
  const text = "one\ntwo\nthree\n";
  const out = applyEdits(doc(text), text, [{ range: r(0, 1, 2, 2), newText: "-" }]);
  assert.equal(out, "o-ree\n");
});

// ---------------------------------------------------------------- references

test("the references list groups by file and escapes what it prints", () => {
  const html = rustReferencesHtml([
    { rel: "src/<a>.rs", line: 3, col: 4, start: 0, text: "  let x = &y;" },
    { rel: "src/<a>.rs", line: 1, col: 0, start: 0, text: "fn y() {}" },
    { rel: "src/b.rs", line: 9, col: 2, start: 0, text: "y()" },
  ]);
  assert.ok(html.includes("3 references in 2 files"));
  assert.ok(!html.includes("<a>.rs"), "the path was interpolated unescaped");
  assert.ok(html.includes("src/&lt;a&gt;.rs"));
  // Sorted by line inside a file, so the list reads like the file does.
  assert.ok(html.indexOf('data-ref-line="1"') < html.indexOf('data-ref-line="3"'));
});

test("no references says so instead of rendering an empty box", () => {
  assert.ok(rustReferencesHtml([]).includes("no references"));
});

function r(sl: number, sc: number, el: number, ec: number) {
  return { start: { line: sl, character: sc }, end: { line: el, character: ec } };
}
