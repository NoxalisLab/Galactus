// @ts-ignore Node's own test runner, no dependency added.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import {
  HIT_CAP,
  ROW_CAP,
  applySearchEvent,
  groupHits,
  hitByteLen,
  hitSpan,
  hitTextHtml,
  newSearchState,
  searchOpts,
  searchPanelHtml,
  searchResultsHtml,
  splitGlobs,
  toggleOption,
} from "../../src/code/searchpanel.js";
import { paletteRowsHtml, fileRow, markHtml, symbolSub } from "../../src/code/palette.js";
import { rank } from "../../src/code/fuzzy.js";
import { utf8Len, byteToCharIndex, charToByteIndex, hitCharSpan, indexToScalar, pathAllowed } from "../../src/code/workspace-api.js";
import type { SearchHit } from "../../src/code/workspace-api.js";
import { makeFake, searchAll, opts, SYMBOLS } from "./fake.js";
import { t } from "../../src/i18n.js";

/**
 * The panel renders through `t()`, so an assertion on the raw key only holds
 * while the key is MISSING from the dictionary. It is not any more: these
 * helpers assert on what the key resolves to, in whatever language the table
 * hands back, which is the thing the user actually reads.
 */
/** The literal fragments of a template, with its %n / %f placeholders removed. */
function fragments(key: string): string[] {
  return t(key)
    .split(/%[a-z]/)
    .map((f) => f.trim())
    .filter((f) => f.length > 3);
}
function says(html: string, key: string): void {
  for (const f of fragments(key)) {
    assert.ok(html.includes(f), `expected the panel to say ${key} ("${f}")\n${html}`);
  }
}
function silentOn(html: string, key: string): void {
  for (const f of fragments(key)) {
    assert.ok(!html.includes(f), `did not expect ${key} ("${f}")\n${html}`);
  }
}

function hit(path: string, line: number, col: number, text: string): SearchHit {
  return { path, line, col, text };
}

// ------------------------------------------------------------- panel states

test("empty state: no query, no results, only the hint", () => {
  const s = newSearchState();
  const html = searchPanelHtml(s);
  assert.match(html, /id="srchq"/);
  says(html, "code.search.hint");
  assert.doesNotMatch(html, /class="srow"/);
  assert.doesNotMatch(html, /srch-warn/);
  assert.match(html, /data-toggle="case"/);
  assert.match(html, /data-toggle="word"/);
  // The toggles are off, so neither carries the "on" class.
  assert.doesNotMatch(html, /class="stog on" data-toggle="case"/);
});

test("streaming state: running, partial hits, a live count and a cancel", () => {
  const s = newSearchState();
  s.query = "target";
  s.gen = 1;
  s.running = true;
  applySearchEvent(s, {
    gen: 1,
    hits: [hit("src/main.ts", 1, 1, "target = 1;"), hit("src/main.ts", 2, 15, "const other = target;")],
    done: false,
    capped: false,
  });
  const html = searchPanelHtml(s);
  assert.match(html, /srch-status run/);
  assert.match(html, /id="srchcancel"/);
  assert.equal(s.hits.length, 2);
  assert.equal((html.match(/class="srow"/g) ?? []).length, 2);
  assert.equal((html.match(/data-group="src\/main\.ts"/g) ?? []).length, 1);
  assert.ok(!s.done);
});

test("capped state: the truncation is said out loud, never swallowed", () => {
  const s = newSearchState();
  s.query = "e";
  s.gen = 3;
  s.running = true;
  applySearchEvent(s, { gen: 3, hits: [hit("a.ts", 1, 1, "everywhere")], done: true, capped: true });
  assert.equal(s.running, false);
  assert.equal(s.done, true);
  assert.equal(s.capped, true);
  const html = searchPanelHtml(s);
  assert.match(html, /srch-warn/);
  says(html, "code.search.capped");
});

test("the panel's own ceiling is a second, distinct banner", () => {
  const s = newSearchState();
  s.query = "e";
  s.gen = 4;
  s.running = true;
  const many = Array.from({ length: HIT_CAP + 50 }, (_, i) => hit("a.ts", i + 1, 1, "e"));
  applySearchEvent(s, { gen: 4, hits: many, done: true, capped: false });
  assert.equal(s.hits.length, HIT_CAP);
  assert.equal(s.clientCapped, true);
  assert.equal(s.capped, false);
  const html = searchPanelHtml(s);
  says(html, "code.search.clientCapped");
  silentOn(html, "code.search.capped");
  // And the render itself is bounded, with the shortfall stated.
  assert.equal((html.match(/class="srow"/g) ?? []).length, ROW_CAP);
  assert.match(html, /srch-more/);
});

test("the deadline is a different fact from the cap, and gets its own banner", () => {
  const s = newSearchState();
  s.query = "e";
  s.gen = 9;
  s.running = true;
  applySearchEvent(s, {
    gen: 9,
    hits: [hit("a.ts", 1, 1, "everywhere")],
    done: true,
    capped: false,
    timedOut: true,
  });
  assert.equal(s.timedOut, true);
  assert.equal(s.capped, false);
  const html = searchPanelHtml(s);
  says(html, "code.search.timedOut");
  silentOn(html, "code.search.capped");
});

test("a backend error reaches the panel instead of looking like no results", () => {
  const s = newSearchState();
  s.query = "e";
  s.gen = 10;
  s.running = true;
  applySearchEvent(s, { gen: 10, hits: [], done: true, capped: false, error: "index unavailable" });
  assert.equal(s.error, "index unavailable");
  assert.match(searchPanelHtml(s), /srch-warn err">index unavailable/);
});

test("a timed-out fake search reports it end to end", async () => {
  const fake = makeFake();
  fake.timeOut = true;
  const s = newSearchState();
  const off = fake.onSearch((p) => applySearchEvent(s, p));
  s.query = "target";
  s.gen = await fake.searchStart("/root", "target", opts());
  s.running = true;
  await fake.idle();
  off();
  assert.equal(s.timedOut, true);
  assert.equal(s.done, true);
});

test("no-match state: done, zero hits, an explicit message", () => {
  const s = newSearchState();
  s.query = "nothinghere";
  s.gen = 5;
  s.running = true;
  applySearchEvent(s, { gen: 5, hits: [], done: true, capped: false });
  const html = searchPanelHtml(s);
  says(html, "code.search.none");
  assert.doesNotMatch(html, /class="srow"/);
  assert.doesNotMatch(html, /srch-warn/);
});

test("events from another generation are dropped, ahead-of-time events are parked", () => {
  const s = newSearchState();
  s.gen = 7;
  applySearchEvent(s, { gen: 6, hits: [hit("a.ts", 1, 1, "old")], done: true, capped: false });
  assert.equal(s.hits.length, 0);
  assert.equal(s.early.length, 0);
  assert.equal(s.done, false);
  applySearchEvent(s, { gen: 8, hits: [hit("a.ts", 1, 1, "new")], done: false, capped: false });
  assert.equal(s.hits.length, 0);
  assert.equal(s.early.length, 1);
});

test("hits stay grouped by file in the order the files first appeared", () => {
  const groups = groupHits([
    hit("b.ts", 1, 1, "x"),
    hit("a.ts", 2, 1, "x"),
    hit("b.ts", 9, 1, "x"),
  ]);
  assert.deepEqual(groups.map((g) => g.path), ["b.ts", "a.ts"]);
  assert.deepEqual(groups[0].hits.map((h) => h.line), [1, 9]);
});

test("a collapsed group keeps its header and drops its rows", () => {
  const s = newSearchState();
  s.query = "x";
  s.hits = [hit("a.ts", 1, 1, "x"), hit("b.ts", 1, 1, "x")];
  s.done = true;
  s.collapsed = ["a.ts"];
  const html = searchResultsHtml(s);
  assert.equal((html.match(/class="sgh shut"/g) ?? []).length, 1);
  assert.equal((html.match(/class="srow"/g) ?? []).length, 1);
  assert.match(html, /data-path="b\.ts"/);
});

// ------------------------------------------------------- highlight offsets

test("highlight offsets are byte-safe on an accented line", () => {
  const text = 'const café = "fête target fête";';
  const at = text.indexOf("target");
  const col = at + 1; // 1-based CHARACTER column, what search.rs reports
  // The byte offset of the same position is two larger: café and fête each
  // cost one extra byte. Mixing the two units is the bug this pins down.
  assert.equal(charToByteIndex(text, at) + 1, col + 2);

  const span = hitSpan(text, col, utf8Len("target"));
  assert.deepEqual(span, { start: at, end: at + 6 });
  const html = hitTextHtml(text, col, utf8Len("target"));
  assert.equal(html, 'const café = &quot;fête <b>target</b> fête&quot;;');

  // Feeding the byte column in as if it were a character column highlights
  // the wrong two characters, which is exactly what the panel never does.
  assert.notDeepEqual(hitSpan(text, charToByteIndex(text, at) + 1, 6), span);
});

test("a match that is itself multi-byte ends where the character ends", () => {
  const text = 'const café = "fête target fête";';
  const at = text.indexOf("fête");
  // "fête" is 4 characters but 5 bytes: the end can only be found by going
  // through the byte offsets and coming back.
  assert.equal(utf8Len("fête"), 5);
  assert.deepEqual(hitSpan(text, at + 1, 5), { start: at, end: at + 4 });
  assert.equal(
    hitTextHtml(text, at + 1, 5),
    'const café = &quot;<b>fête</b> target fête&quot;;'
  );
});

test("the backend's own match length wins over the query's length", () => {
  const hitWithLen = { path: "a.ts", line: 1, col: 1, text: "x", len: 9 };
  assert.equal(hitByteLen(hitWithLen, "query"), 9);
  assert.equal(hitByteLen({ path: "a.ts", line: 1, col: 1, text: "x" }, "fête"), 5);
});

test("highlight offsets are byte-safe past an emoji", () => {
  const text = 'const emoji = "🎉 target 🎉";';
  const at = text.indexOf("target");
  // The emoji is four bytes but two UTF-16 code units: the offsets diverge.
  assert.equal(charToByteIndex(text, at) - at, 2);
  // And it is ONE scalar, which is the unit the backend counts columns in. This
  // test used to pass the JavaScript index as the column, which is the very
  // confusion the app had: with a real backend the highlight landed one place
  // left per emoji before it.
  const col = indexToScalar(text, at) + 1;
  assert.equal(col, at, "one emoji before it, so the column is one less than the index");
  assert.equal(hitTextHtml(text, col, utf8Len("target")), 'const emoji = &quot;🎉 <b>target</b> 🎉&quot;;');
  // And the emoji itself, four bytes long, is highlighted whole.
  const e = text.indexOf("🎉");
  assert.deepEqual(hitSpan(text, indexToScalar(text, e) + 1, 4), { start: e, end: e + 2 });
  assert.equal(hitTextHtml(text, e + 1, 4), 'const emoji = &quot;<b>🎉</b> target 🎉&quot;;');
});

test("a byte offset landing inside a character snaps forward, never splits it", () => {
  const text = "é🎉x";
  assert.equal(byteToCharIndex(text, 0), 0);
  assert.equal(byteToCharIndex(text, 1), 1); // mid "é" snaps to the next start
  assert.equal(byteToCharIndex(text, 2), 1);
  assert.equal(byteToCharIndex(text, 4), 3); // mid emoji snaps past the pair
  assert.equal(byteToCharIndex(text, 6), 3);
  assert.equal(byteToCharIndex(text, 99), text.length);
  assert.equal(charToByteIndex(text, 3), 6);
});

test("the matched text is escaped, so a hit inside markup cannot inject any", () => {
  const text = '<div class="x">target</div>';
  const col = text.indexOf("target") + 1;
  const html = hitTextHtml(text, col, 6);
  assert.equal(html, "&lt;div class=&quot;x&quot;&gt;<b>target</b>&lt;/div&gt;");
});

test("a long line is windowed around its match, both cuts marked", () => {
  const text = "  " + "a".repeat(400) + "target" + "b".repeat(400);
  const col = text.indexOf("target") + 1;
  const html = hitTextHtml(text, col, 6);
  assert.ok(html.startsWith("…"));
  assert.ok(html.endsWith("…"));
  assert.match(html, /<b>target<\/b>/);
  assert.ok(html.length < 400);
});

test("leading indentation is dropped but the match is never cut off", () => {
  const text = "\t\t  const x = target;";
  const col = text.indexOf("target") + 1;
  assert.equal(hitTextHtml(text, col, 6), "const x = <b>target</b>;");
});

// ------------------------------------------------------------------ options

test("glob boxes split on commas and whitespace, empties dropped", () => {
  assert.deepEqual(splitGlobs("*.ts, *.rs   src/**"), ["*.ts", "*.rs", "src/**"]);
  assert.deepEqual(splitGlobs("  "), []);
  const s = newSearchState();
  s.include = "*.ts";
  s.exclude = "vendor/**, dist/**";
  s.caseSensitive = true;
  assert.deepEqual(searchOpts(s), {
    caseSensitive: true,
    wholeWord: false,
    regex: false,
    include: ["*.ts"],
    exclude: ["vendor/**", "dist/**"],
  });
});

test("the include and exclude filter is the one the backend must implement", () => {
  const o = { include: ["*.ts"], exclude: ["vendor/**"] };
  assert.equal(pathAllowed("src/main.ts", o), true);
  assert.equal(pathAllowed("src/deep/nest/main.ts", o), true);
  assert.equal(pathAllowed("src/main.rs", o), false);
  assert.equal(pathAllowed("vendor/lib/main.ts", o), false);
  assert.equal(pathAllowed("anything.rs", { include: [], exclude: [] }), true);
});

// ---------------------------------------------------- against the fake api

test("a real streamed search fills the panel state end to end", async () => {
  const fake = makeFake();
  const s = newSearchState();
  s.query = "target";
  const off = fake.onSearch((p) => applySearchEvent(s, p));
  s.gen = await fake.searchStart("/root", s.query, opts());
  s.running = true;
  await fake.idle();
  off();
  assert.equal(s.running, false);
  assert.equal(s.done, true);
  assert.equal(s.capped, false);
  assert.equal(s.hits.length, 10);
  assert.deepEqual(groupHits(s.hits).map((g) => g.path), [
    "docs/readme.md",
    "src/accents.ts",
    "src/crlf.ts",
    "src/eof.ts",
    "src/main.ts",
    "vendor/skip.js",
  ]);
  const html = searchPanelHtml(s);
  assert.equal((html.match(/class="srow"/g) ?? []).length, 10);
  assert.match(html, /data-col="/); // the character column the editor gets
});

test("an exclude glob keeps vendor out of the results", async () => {
  const fake = makeFake();
  const hits = await searchAll(fake, "target", opts({ exclude: ["vendor/**"] }));
  assert.ok(hits.length > 0);
  assert.ok(!hits.some((h) => h.path.startsWith("vendor/")));
});

test("a capped backend reports it, and the panel keeps the flag", async () => {
  const fake = makeFake();
  fake.hitCap = 3;
  const s = newSearchState();
  const off = fake.onSearch((p) => applySearchEvent(s, p));
  s.gen = await fake.searchStart("/root", "target", opts());
  s.query = "target";
  s.running = true;
  await fake.idle();
  off();
  assert.equal(s.hits.length, 3);
  assert.equal(s.capped, true);
  says(searchPanelHtml(s), "code.search.capped");
});

// ------------------------------------------------------------- the palettes

test("palette rows mark the matched characters and flag the active row", () => {
  const rows = rank("pal", ["src/code/palette.ts", "src/palette/index.ts"], [], 10).map((r) =>
    fileRow(r.path, r.positions)
  );
  const html = paletteRowsHtml(rows, 0);
  assert.match(html, /class="pal-row on" data-i="0"/);
  assert.match(html, /data-i="1"/);
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /<b>pal<\/b>ette\.ts/);
  // The directory half keeps its own highlight when the query reached it.
  assert.match(html, /class="sub mono">src\/<b>pal<\/b>ette/);
});

test("an empty palette says so instead of rendering nothing", () => {
  assert.match(paletteRowsHtml([], 0), /pal-empty/);
});

test("a highlight never cuts a surrogate pair in half", () => {
  // Position 1 is the low half of the emoji: the range widens to the pair.
  assert.equal(markHtml("a🎉b", [1]), "a<b>🎉</b>b");
  assert.equal(markHtml("a🎉b", [3]), "a🎉<b>b</b>");
  assert.equal(markHtml("<x>", [0]), "<b>&lt;</b>x&gt;");
  assert.equal(markHtml("abc", []), "abc");
});

test("symbol rows carry their kind and their location", async () => {
  const fake = makeFake();
  const hits = await fake.symbolsQuery("/root", "rep", 10);
  assert.deepEqual(hits.map((h) => h.name), ["planReplace"]);
  assert.equal(symbolSub(SYMBOLS[4]), "FakeWorkspaceApi · src/code/workspace-api.ts:178");
  const html = paletteRowsHtml(
    [{ main: hits[0].name, positions: [4, 5, 6], sub: symbolSub(hits[0]), badge: hits[0].kind }],
    0
  );
  assert.match(html, /class="kind">function</);
  assert.match(html, /plan<b>Rep<\/b>lace/);
});

test("turning on the pattern toggle drops whole word, which is a literal idea", () => {
  // With a pattern the user writes the boundary they want. Leaving whole word
  // on would quietly filter out matches a correct pattern had found, which
  // reads as an engine that does not work rather than as a setting still on.
  const s = newSearchState();
  s.wholeWord = true;
  toggleOption(s, "regex");
  assert.equal(s.regex, true);
  assert.equal(s.wholeWord, false, "whole word must not survive the switch");
  // Off again leaves whole word where the user put it: it is not restored
  // behind their back either.
  toggleOption(s, "regex");
  assert.equal(s.regex, false);
  assert.equal(s.wholeWord, false);
  // And the button is in the panel.
  assert.match(searchPanelHtml(s), /data-toggle="regex"/);
});

test("a column past an emoji lands where the backend meant it", () => {
  // search.rs computes col with chars().count(), which counts SCALARS.
  // JavaScript indexes UTF-16 units and an emoji costs two, so reading the
  // column as an index put the highlight one place left per emoji before it.
  const line = "const x = 1; // 🚀 ok, target here";
  const scalars = [...line];
  const at = scalars.indexOf("t", scalars.indexOf("🚀"));
  // What the backend would send: a 1-based scalar count.
  const col = at + 1;

  const span = hitCharSpan(line, col, 6);
  assert.equal(line.slice(span.start, span.end), "target", "the span covers the word, not one before it");

  // Nothing changes for a line that stays inside the BMP.
  const plain = "const target = 1;";
  const plainSpan = hitCharSpan(plain, plain.indexOf("target") + 1, 6);
  assert.equal(plain.slice(plainSpan.start, plainSpan.end), "target");

  // Accented text is two BYTES but one unit, which the byte side already knew.
  const accented = "// éé target";
  const accCol = [...accented].indexOf("t") + 1;
  const accSpan = hitCharSpan(accented, accCol, 6);
  assert.equal(accented.slice(accSpan.start, accSpan.end), "target");
});
