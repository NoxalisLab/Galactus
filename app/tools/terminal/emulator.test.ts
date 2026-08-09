// The emulator: parser, grid, scrollback and rendering.
//
// The tests are written against what a real program would emit, not against
// the shape of the implementation: each one names a program or a situation
// that produces the sequence, so a failure says what broke rather than which
// method changed.

// @ts-ignore Node's own test runner, no dependency added.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import {
  ATTR_BOLD,
  ATTR_UNDERLINE,
  COLOR_DEFAULT,
  COLOR_RGB_FLAG,
  TerminalEmulator,
  charWidth,
  colorCss,
  encodeKey,
  encodePaste,
  rgbColor,
  rowHtml,
} from "../../src/code/terminal.js";
import type { KeyLike } from "../../src/code/terminal.js";

function emu(cols = 20, rows = 4, scrollback = 8): TerminalEmulator {
  return new TerminalEmulator({ cols, rows, scrollback });
}

/** The visible screen as trimmed lines, which is what a human would read. */
function lines(e: TerminalEmulator): string[] {
  return e.screenText().split("\n");
}

// ---------------------------------------------------------------- text

test("plain text lands on the screen and the cursor follows it", () => {
  const e = emu();
  e.write("hello");
  assert.equal(lines(e)[0], "hello");
  assert.equal(e.snapshot().cursorX, 5);
  assert.equal(e.snapshot().cursorY, 0);
});

test("carriage return and line feed do their separate jobs", () => {
  const e = emu();
  // A pty converts "\n" to "\r\n" on output, so this is the real shape.
  e.write("one\r\ntwo\r\n");
  assert.equal(lines(e)[0], "one");
  assert.equal(lines(e)[1], "two");
  assert.equal(e.snapshot().cursorX, 0);
  assert.equal(e.snapshot().cursorY, 2);
});

test("a bare carriage return overwrites the line, which is how progress bars work", () => {
  const e = emu();
  e.write("downloading 10%\rdownloading 99%");
  assert.equal(lines(e)[0], "downloading 99%");
});

test("backspace moves back and the next character overwrites", () => {
  const e = emu();
  // Readline erases by writing BS, space, BS.
  e.write("abc\b\b \b");
  assert.equal(lines(e)[0], "a c".replace(" c", " c"));
  assert.equal(e.snapshot().cursorX, 1);
});

test("tab stops are every eight columns", () => {
  const e = emu(40);
  e.write("a\tb\tc");
  const l = lines(e)[0];
  assert.equal(l.indexOf("b"), 8);
  assert.equal(l.indexOf("c"), 16);
});

test("a tab at the last stop does not run off the row", () => {
  const e = emu(10);
  e.write("123456789\t");
  assert.equal(e.snapshot().cursorX, 9);
});

// ---------------------------------------------------------------- wrapping

test("a line exactly as wide as the screen does not skip a row", () => {
  // The deferred wrap. Wrapping eagerly at the last column inserts a blank
  // line after every full width line, which is the single most visible
  // emulator bug there is.
  const e = emu(5, 4);
  e.write("abcde");
  assert.equal(e.snapshot().cursorY, 0, "the cursor left the row too early");
  e.write("f");
  assert.equal(e.snapshot().cursorY, 1);
  assert.equal(lines(e)[0], "abcde");
  assert.equal(lines(e)[1], "f");
});

test("autowrap off pins the last column instead of wrapping", () => {
  const e = emu(5, 4);
  e.write("\x1b[?7l");
  e.write("abcdefgh");
  assert.equal(e.snapshot().cursorY, 0);
  assert.equal(lines(e)[0], "abcdh");
});

// ---------------------------------------------------------------- colour

test("the basic SGR colours reach the cells", () => {
  const e = emu();
  e.write("\x1b[31mred\x1b[0mplain");
  const row = e.screen()[0];
  assert.equal(row.fg[0], 1, "red is palette index 1");
  assert.equal(row.fg[3], COLOR_DEFAULT, "the reset did not take");
});

test("bright colours map to the upper half of the base sixteen", () => {
  const e = emu();
  e.write("\x1b[91mx\x1b[102my");
  assert.equal(e.screen()[0].fg[0], 9);
  assert.equal(e.screen()[0].bg[1], 10);
});

test("indexed 256 colour is read from the right parameter", () => {
  const e = emu();
  e.write("\x1b[38;5;196mx\x1b[48;5;21my");
  assert.equal(e.screen()[0].fg[0], 196);
  assert.equal(e.screen()[0].bg[1], 21);
});

test("truecolor is read in both the semicolon and the colon form", () => {
  const e = emu();
  e.write("\x1b[38;2;10;20;30mx");
  assert.equal(e.screen()[0].fg[0], rgbColor(10, 20, 30));
  // The colon form carries a colour space slot that is usually empty:
  // 38:2::r:g:b. Reading it as red is a classic off-by-one and turns every
  // truecolor prompt black.
  const e2 = emu();
  e2.write("\x1b[38:2::10:20:30my");
  assert.equal(e2.screen()[0].fg[0], rgbColor(10, 20, 30));
});

test("attributes accumulate and are reset one at a time", () => {
  const e = emu();
  e.write("\x1b[1;4mx\x1b[24my\x1b[0mz");
  const row = e.screen()[0];
  assert.equal(row.at[0] & ATTR_BOLD, ATTR_BOLD);
  assert.equal(row.at[0] & ATTR_UNDERLINE, ATTR_UNDERLINE);
  assert.equal(row.at[1] & ATTR_BOLD, ATTR_BOLD, "SGR 24 cleared bold as well");
  assert.equal(row.at[1] & ATTR_UNDERLINE, 0);
  assert.equal(row.at[2], 0);
});

test("a bare CSI m is a full reset", () => {
  const e = emu();
  e.write("\x1b[1;31mx\x1b[my");
  assert.equal(e.screen()[0].at[1], 0);
  assert.equal(e.screen()[0].fg[1], COLOR_DEFAULT);
});

test("a colour becomes CSS, and the default becomes nothing", () => {
  assert.equal(colorCss(COLOR_DEFAULT), null);
  assert.equal(colorCss(rgbColor(255, 0, 128)), "#ff0080");
  assert.equal(colorCss(rgbColor(300, -5, 1.9)), "#ff0001", "out of range channels are clamped");
  assert.equal(typeof colorCss(196), "string");
  assert.ok((colorCss(196) as string).startsWith("#"));
  assert.ok(rgbColor(0, 0, 0) >= COLOR_RGB_FLAG, "black must not collide with palette index 0");
  assert.equal(colorCss(rgbColor(0, 0, 0)), "#000000");
});

// ---------------------------------------------------------------- erasing

test("clear screen blanks everything and homes nothing by itself", () => {
  const e = emu();
  e.write("a\r\nb\r\nc");
  e.write("\x1b[2J");
  assert.deepEqual(lines(e), ["", "", "", ""]);
});

test("erase to end of line leaves the head of the line alone", () => {
  const e = emu(10);
  e.write("abcdefgh");
  e.write("\x1b[5G\x1b[K");
  assert.equal(lines(e)[0], "abcd");
});

test("erase to start of line clears through the cursor cell", () => {
  const e = emu(10);
  e.write("abcdefgh\x1b[5G\x1b[1K");
  assert.equal(lines(e)[0].slice(0, 5), "     ");
  assert.equal(lines(e)[0][5], "f");
});

test("erasing paints the current background, not the default one", () => {
  // A TUI that sets a background then clears expects a coloured screen.
  const e = emu(6, 2);
  e.write("\x1b[44m\x1b[2J");
  assert.equal(e.screen()[0].bg[0], 4);
});

// ------------------------------------------------------------- cursor moves

test("absolute positioning is one based on the wire and zero based inside", () => {
  const e = emu(20, 5);
  e.write("\x1b[3;7H");
  assert.equal(e.snapshot().cursorY, 2);
  assert.equal(e.snapshot().cursorX, 6);
  // A missing parameter means one, not zero.
  e.write("\x1b[H");
  assert.deepEqual([e.snapshot().cursorX, e.snapshot().cursorY], [0, 0]);
});

test("cursor movement stops at the edges instead of wrapping round", () => {
  const e = emu(10, 3);
  e.write("\x1b[99A\x1b[99D");
  assert.deepEqual([e.snapshot().cursorX, e.snapshot().cursorY], [0, 0]);
  e.write("\x1b[99B\x1b[99C");
  assert.deepEqual([e.snapshot().cursorX, e.snapshot().cursorY], [9, 2]);
});

test("save and restore round trip through both spellings", () => {
  const e = emu(20, 5);
  e.write("\x1b[3;7H\x1b7\x1b[1;1H\x1b8");
  assert.deepEqual([e.snapshot().cursorX, e.snapshot().cursorY], [6, 2]);
  e.write("\x1b[2;3H\x1b[s\x1b[5;9H\x1b[u");
  assert.deepEqual([e.snapshot().cursorX, e.snapshot().cursorY], [2, 1]);
});

// --------------------------------------------------------------- editing

test("insert and delete characters shift the rest of the line", () => {
  const e = emu(10);
  e.write("abcdef\x1b[1;3H\x1b[2@");
  assert.equal(lines(e)[0], "ab  cdef");
  e.write("\x1b[1;3H\x1b[2P");
  assert.equal(lines(e)[0], "abcdef");
});

test("erase characters blanks in place without shifting", () => {
  const e = emu(10);
  e.write("abcdef\x1b[1;3H\x1b[2X");
  assert.equal(lines(e)[0], "ab  ef");
});

test("insert and delete lines shift the rows below", () => {
  const e = emu(10, 4);
  e.write("one\r\ntwo\r\nthree");
  e.write("\x1b[2;1H\x1b[L");
  assert.deepEqual(lines(e).slice(0, 3), ["one", "", "two"]);
  e.write("\x1b[2;1H\x1b[M");
  assert.deepEqual(lines(e).slice(0, 3), ["one", "two", "three"]);
});

// ------------------------------------------------------------ scroll region

test("a scroll region keeps the rows outside it perfectly still", () => {
  // What a pager or a status bar does: reserve the last row, scroll the rest.
  const e = emu(10, 4);
  e.write("\x1b[4;1Hstatus");
  e.write("\x1b[1;3r");
  e.write("\x1b[1;1Ha\r\nb\r\nc\r\nd");
  assert.equal(lines(e)[3], "status", "the reserved row scrolled");
  assert.deepEqual(lines(e).slice(0, 3), ["b", "c", "d"]);
});

test("a scroll region does not pour its redraws into the history", () => {
  // Otherwise scrolling in `less` fills the scrollback with the pager's own
  // repaints and the real command output is evicted.
  const e = emu(10, 4, 20);
  e.write("\x1b[1;3r");
  for (let i = 0; i < 10; i++) e.write(`line${i}\r\n`);
  assert.equal(e.scrollback.length, 0);
});

// ------------------------------------------------------------- scrollback

test("lines scrolled off the top enter the history in order", () => {
  const e = emu(10, 3, 20);
  for (let i = 0; i < 6; i++) e.write(`l${i}\r\n`);
  // Six lines each followed by a newline, into a three row screen. The sixth
  // newline scrolls once more than the eye expects, which is why the count is
  // spelled out here rather than left as "six minus three".
  assert.deepEqual(e.scrollback.toArray().map((r) => r.chars.join("")), ["l0", "l1", "l2", "l3"]);
  assert.deepEqual(lines(e), ["l4", "l5", ""]);
});

test("the history is bounded and the oldest lines are the ones lost", () => {
  const e = emu(10, 2, 4);
  for (let i = 0; i < 20; i++) e.write(`l${i}\r\n`);
  assert.equal(e.scrollback.length, 4);
  assert.ok(e.scrollback.dropped > 0, "the ceiling was never reported");
  // Nineteen lines reached the history and the ring kept the last four.
  assert.deepEqual(e.scrollback.toArray().map((r) => r.chars.join("")), ["l15", "l16", "l17", "l18"]);
  assert.equal(e.scrollback.dropped, 15);
});

test("a history row is stored trimmed, not padded to the terminal width", () => {
  const e = emu(200, 2, 10);
  e.write("hi\r\n\r\n\r\n");
  const row = e.scrollback.at(0)!;
  assert.equal(row.chars.length, 2, "the row kept 200 columns of nothing");
});

test("the viewport walks back into the history and returns to the live screen", () => {
  const e = emu(10, 2, 10);
  for (let i = 0; i < 6; i++) e.write(`l${i}\r\n`);
  const live = e.viewport(0).map((r) => r.chars.join("").trimEnd());
  assert.deepEqual(live, ["l5", ""]);
  const back = e.viewport(2).map((r) => r.chars.join("").trimEnd());
  assert.deepEqual(back, ["l3", "l4"]);
  // Scrolling further than the history exists must clamp, not throw.
  assert.equal(e.viewport(9999).length, 2);
  assert.equal(e.viewport(-3).length, 2);
});

test("clear wipes the history as well as the screen", () => {
  const e = emu(10, 2, 10);
  for (let i = 0; i < 6; i++) e.write(`l${i}\r\n`);
  e.clear();
  assert.equal(e.scrollback.length, 0);
  assert.deepEqual(lines(e), ["", ""]);
});

// ------------------------------------------------------------- alt screen

test("the alternate screen hides the history and gives it back on exit", () => {
  // `vim`, `less` and `htop` all do exactly this, and the promise is that the
  // shell output is untouched when they quit.
  const e = emu(20, 3, 20);
  e.write("shell output\r\n");
  const before = e.scrollback.length;
  e.write("\x1b[?1049h");
  assert.equal(e.snapshot().altActive, true);
  for (let i = 0; i < 10; i++) e.write(`editor${i}\r\n`);
  assert.equal(e.scrollback.length, before, "the editor polluted the history");
  e.write("\x1b[?1049l");
  assert.equal(e.snapshot().altActive, false);
  assert.ok(e.allText().includes("shell output"));
  assert.ok(!e.allText().includes("editor9"));
});

// ---------------------------------------------------------------- modes

test("the modes a shell actually sets are tracked", () => {
  const e = emu();
  assert.equal(e.snapshot().cursorVisible, true);
  e.write("\x1b[?25l");
  assert.equal(e.snapshot().cursorVisible, false);
  e.write("\x1b[?25h");
  assert.equal(e.snapshot().cursorVisible, true);
  e.write("\x1b[?1h");
  assert.equal(e.snapshot().appCursorKeys, true);
  e.write("\x1b[?2004h");
  assert.equal(e.snapshot().bracketedPaste, true);
});

test("an ANSI mode without the private marker is ignored, not confused with a DEC one", () => {
  const e = emu();
  // CSI 25 l is not DECTCEM; only CSI ? 25 l is.
  e.write("\x1b[25l");
  assert.equal(e.snapshot().cursorVisible, true);
});

// ---------------------------------------------------------------- OSC

test("a title sequence sets the title and prints nothing", () => {
  const e = emu();
  e.write("\x1b]0;my project\x07after");
  assert.equal(e.snapshot().title, "my project");
  assert.equal(lines(e)[0], "after");
  // The other terminator, ESC backslash, must work too.
  e.write("\x1b]2;second\x1b\\");
  assert.equal(e.snapshot().title, "second");
});

test("a clipboard sequence is swallowed and never honoured", () => {
  // OSC 52 lets anything the user merely LOOKS AT rewrite the clipboard. It is
  // parsed only so it does not corrupt the screen.
  const e = emu();
  e.write("\x1b]52;c;bWFsaWNpb3Vz\x07visible");
  assert.equal(lines(e)[0], "visible");
  assert.equal(e.snapshot().title, "", "OSC 52 leaked into the title");
});

test("a device status request produces no reply and no output", () => {
  // A terminal that answers queries is a terminal where program output can
  // become terminal input. Nothing here ever writes back to the pty.
  const e = emu();
  e.write("before\x1b[6n\x1b[c after");
  assert.equal(lines(e)[0], "before after");
});

test("an unterminated OSC does not eat the rest of the session", () => {
  const e = emu(40, 4);
  // 4096 characters is the cap; past it the parser keeps consuming but does
  // not grow, and the terminator still ends it.
  e.write("\x1b]0;" + "x".repeat(9000) + "\x07done");
  assert.equal(lines(e)[0], "done");
});

test("a DCS payload is consumed rather than printed", () => {
  // Sixel and the Kitty graphics protocol land here. No image appears, but no
  // payload is vomited onto the screen either.
  const e = emu(40, 4);
  e.write("\x1bPq#0;2;0;0;0#0~~@@vv@@~~@@~~$\x1b\\text");
  assert.equal(lines(e)[0], "text");
});

// ------------------------------------------------------------- chunking

test("an escape sequence split across reads still works", () => {
  // A pty read cuts wherever the kernel buffer ended. An emulator that resets
  // its parser at a chunk boundary prints "[32m" into the middle of a build
  // log, and this is the test that catches it.
  const script = "\x1b[1;31mERROR\x1b[0m: \x1b[38;2;100;200;50mdetail\x1b[0m\r\nnext\x1b[?25l";
  const whole = emu(40, 4);
  whole.write(script);
  const piecemeal = emu(40, 4);
  for (const ch of script) piecemeal.write(ch);
  assert.deepEqual(lines(piecemeal), lines(whole));
  assert.equal(piecemeal.screen()[0].fg[0], whole.screen()[0].fg[0]);
  assert.equal(piecemeal.snapshot().cursorVisible, false);
  assert.equal(piecemeal.snapshot().cursorVisible, whole.snapshot().cursorVisible);
});

test("a runaway CSI parameter list cannot grow without bound", () => {
  const e = emu();
  e.write("\x1b[" + "1;".repeat(5000) + "mx");
  assert.equal(lines(e)[0], "x");
});

// ------------------------------------------------------------ unicode

test("a wide character occupies two cells", () => {
  const e = emu(10);
  e.write("漢字");
  assert.equal(e.snapshot().cursorX, 4);
  const row = e.screen()[0];
  assert.equal(row.chars[0], "漢");
  assert.equal(row.chars[1], "", "the trailing half must not be a space");
  assert.equal(row.chars[2], "字");
});

test("a wide character that does not fit wraps whole", () => {
  // Two columns: the "a" fills one and the wide glyph cannot be split, so the
  // whole character moves down rather than losing half of itself.
  const e = emu(2, 3);
  e.write("a漢");
  assert.equal(e.screen()[0].chars.join("").trimEnd(), "a");
  assert.equal(e.screen()[1].chars[0], "漢");
  assert.equal(e.screen()[1].chars[1], "");
});

test("a combining mark joins the character it follows", () => {
  const e = emu(10);
  e.write("é");
  assert.equal(e.snapshot().cursorX, 1, "the accent took a cell of its own");
  assert.equal(e.screen()[0].chars[0], "é");
});

test("character widths follow the ranges the grid is built on", () => {
  assert.equal(charWidth("a".codePointAt(0)!), 1);
  assert.equal(charWidth("é".codePointAt(0)!), 1);
  assert.equal(charWidth("漢".codePointAt(0)!), 2);
  assert.equal(charWidth("🎉".codePointAt(0)!), 2);
  assert.equal(charWidth(0x0301), 0, "a combining acute is not a cell");
  assert.equal(charWidth(0x200d), 0, "a zero width joiner is not a cell");
  assert.equal(charWidth(0), 0);
  assert.equal(charWidth(0x1b), 0);
});

test("the DEC line drawing set turns letters into box characters", () => {
  // `dialog` and older ncurses programs draw every border with it.
  const e = emu(10);
  e.write("\x1b(0lqqk\x1b(Bx");
  assert.equal(lines(e)[0], "┌──┐x");
});

// --------------------------------------------------------------- resizing

test("a shrink keeps the cursor on screen and saves what it pushes off", () => {
  const e = emu(10, 5, 20);
  for (let i = 0; i < 5; i++) e.write(`row${i}\r\n`);
  // The cursor is now on the last row after the final newline scrolled once.
  const before = e.scrollback.length;
  e.resize(10, 2);
  assert.equal(e.snapshot().rows, 2);
  assert.ok(e.snapshot().cursorY <= 1, "the cursor was left below the screen");
  assert.ok(e.scrollback.length >= before, "the lines pushed off were deleted");
});

test("a widen and re-narrow does not corrupt the grid", () => {
  const e = emu(10, 3, 20);
  e.write("abcdefghij");
  e.resize(20, 3);
  assert.equal(e.screen()[0].chars.length, 20);
  assert.equal(e.screen()[0].chars.join("").trimEnd(), "abcdefghij");
  e.resize(5, 3);
  assert.equal(e.screen()[0].chars.length, 5);
  assert.equal(e.screen()[0].chars.join(""), "abcde");
});

test("a resize is clamped exactly like a spawn", () => {
  const e = emu(10, 3);
  assert.deepEqual(e.resize(NaN, NaN), { cols: 80, rows: 24 });
  assert.deepEqual(e.resize(0, 0), { cols: 2, rows: 1 });
  assert.equal(e.snapshot().cols, 2);
  assert.equal(e.snapshot().rows, 1);
});

test("a resize drops a scroll region that no longer fits", () => {
  const e = emu(10, 6);
  e.write("\x1b[2;5r");
  e.resize(10, 3);
  // Writing enough lines must scroll the whole screen, not a stale region.
  e.write("\x1b[1;1Ha\r\nb\r\nc\r\nd");
  assert.deepEqual(lines(e), ["b", "c", "d"]);
});

// -------------------------------------------------------------- rendering

test("rendered output escapes the characters that would become markup", () => {
  const e = emu(20);
  e.write("<script>&\"'");
  const html = rowHtml(e.screen()[0], 20, { cursorCol: -1 });
  assert.ok(!html.includes("<script>"), "a tag survived into the DOM string");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&amp;"));
});

test("cells with identical styling collapse into one span", () => {
  // Per cell spans are two hundred DOM nodes for one row and six thousand for
  // a screen, which is the difference between a terminal and a slideshow.
  const e = emu(20);
  e.write("\x1b[31maaaaa\x1b[32mbbbbb\x1b[0m");
  const html = rowHtml(e.screen()[0], 20, { cursorCol: -1 });
  assert.equal((html.match(/<span/g) ?? []).length, 2);
});

test("an unstyled row renders as bare text with no span at all", () => {
  const e = emu(10);
  e.write("plain");
  const html = rowHtml(e.screen()[0], 10, { cursorCol: -1 });
  assert.equal(html.trimEnd(), "plain");
});

test("the cursor cell is its own span so it can be painted", () => {
  const e = emu(10);
  e.write("abc");
  const html = rowHtml(e.screen()[0], 10, { cursorCol: 1 });
  assert.ok(html.includes('class="t-cur"'), "the cursor cell was merged away");
});

// ------------------------------------------------------------ key encoding

function key(k: string, mods: Partial<KeyLike> = {}): KeyLike {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods };
}

test("ordinary keys send themselves", () => {
  assert.equal(encodeKey(key("a"), false), "a");
  assert.equal(encodeKey(key("A", { shiftKey: true }), false), "A");
  assert.equal(encodeKey(key("é"), false), "é");
  assert.equal(encodeKey(key("Enter"), false), "\r");
  assert.equal(encodeKey(key("Tab"), false), "\t");
  assert.equal(encodeKey(key("Tab", { shiftKey: true }), false), "\x1b[Z");
  assert.equal(encodeKey(key("Escape"), false), "\x1b");
});

test("backspace sends DEL, which is what a mac terminal sends", () => {
  assert.equal(encodeKey(key("Backspace"), false), "\x7f");
  assert.equal(encodeKey(key("Backspace", { altKey: true }), false), "\x1b\x7f");
});

test("control keys become their C0 codes", () => {
  assert.equal(encodeKey(key("c", { ctrlKey: true }), false), "\x03");
  assert.equal(encodeKey(key("C", { ctrlKey: true, shiftKey: true }), false), "\x03");
  assert.equal(encodeKey(key("d", { ctrlKey: true }), false), "\x04");
  assert.equal(encodeKey(key("z", { ctrlKey: true }), false), "\x1a");
  assert.equal(encodeKey(key(" ", { ctrlKey: true }), false), "\x00");
  assert.equal(encodeKey(key("[", { ctrlKey: true }), false), "\x1b");
  assert.equal(encodeKey(key("\\", { ctrlKey: true }), false), "\x1c");
  // A control chord with no C0 meaning must send nothing rather than a letter.
  assert.equal(encodeKey(key("1", { ctrlKey: true }), false), null);
});

test("Cmd always belongs to the application", () => {
  // Otherwise Cmd-C in the pane would send a byte instead of copying, and the
  // terminal would feel foreign in its own window.
  assert.equal(encodeKey(key("c", { metaKey: true }), false), null);
  assert.equal(encodeKey(key("v", { metaKey: true }), false), null);
  assert.equal(encodeKey(key("ArrowUp", { metaKey: true }), false), null);
});

test("cursor keys change shape in application mode", () => {
  assert.equal(encodeKey(key("ArrowUp"), false), "\x1b[A");
  assert.equal(encodeKey(key("ArrowUp"), true), "\x1bOA");
  assert.equal(encodeKey(key("Home"), false), "\x1b[H");
  assert.equal(encodeKey(key("Home"), true), "\x1bOH");
});

test("a modified cursor key carries its modifier parameter", () => {
  assert.equal(encodeKey(key("ArrowRight", { ctrlKey: true }), false), "\x1b[1;5C");
  assert.equal(encodeKey(key("ArrowLeft", { shiftKey: true }), false), "\x1b[1;2D");
  assert.equal(encodeKey(key("ArrowUp", { altKey: true }), false), "\x1b[1;3A");
  // Application mode loses to an explicit modifier, as every terminal does.
  assert.equal(encodeKey(key("ArrowRight", { ctrlKey: true }), true), "\x1b[1;5C");
});

test("function and navigation keys have their sequences", () => {
  assert.equal(encodeKey(key("F1"), false), "\x1bOP");
  assert.equal(encodeKey(key("F5"), false), "\x1b[15~");
  assert.equal(encodeKey(key("F12"), false), "\x1b[24~");
  assert.equal(encodeKey(key("Delete"), false), "\x1b[3~");
  assert.equal(encodeKey(key("PageUp"), false), "\x1b[5~");
});

test("keys that are not text send nothing", () => {
  for (const k of ["Shift", "Control", "Alt", "Meta", "CapsLock", "F13", "AudioVolumeUp", "Dead"]) {
    assert.equal(encodeKey(key(k), false), null, `${k} produced bytes`);
  }
});

test("alt prefixes a key with escape, which is how a shell reads meta", () => {
  assert.equal(encodeKey(key("b", { altKey: true }), false), "\x1bb");
  assert.equal(encodeKey(key("f", { altKey: true }), false), "\x1bf");
});

// ---------------------------------------------------------------- paste

test("a paste is bracketed only when the child asked for it", () => {
  assert.equal(encodePaste("hello", false), "hello");
  assert.equal(encodePaste("hello", true), "\x1b[200~hello\x1b[201~");
});

test("a paste cannot close its own bracket early", () => {
  // The known bracketed paste escape: a payload containing the end marker
  // would otherwise leave the rest to be executed as typed input.
  const hostile = "safe\x1b[201~rm -rf /\n";
  const wrapped = encodePaste(hostile, true);
  assert.equal(wrapped.indexOf("\x1b[201~"), wrapped.length - "\x1b[201~".length);
  assert.ok(wrapped.startsWith("\x1b[200~"));
  // The marker is stripped even when bracketing is off, so the two paths agree
  // about what the text is.
  assert.ok(!encodePaste(hostile, false).includes("\x1b[201~"));
});

// ---------------------------------------------------------------- reset

test("a full reset returns every mode to its start state", () => {
  const e = emu(10, 3, 10);
  e.write("\x1b[?25l\x1b[?1h\x1b[?2004h\x1b[31mtext\x1b[?1049h");
  e.write("\x1bc");
  const st = e.snapshot();
  assert.equal(st.cursorVisible, true);
  assert.equal(st.appCursorKeys, false);
  assert.equal(st.bracketedPaste, false);
  assert.equal(st.altActive, false);
  assert.deepEqual([st.cursorX, st.cursorY], [0, 0]);
  e.write("x");
  assert.equal(e.screen()[0].fg[0], COLOR_DEFAULT, "the colour survived the reset");
});
