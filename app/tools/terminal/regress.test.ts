// Regressions for the defects found in review.
//
// All of these passed the original 142 test suite while the emulator was
// wrong, which is what makes them worth having: the first suite covered the
// sequences the implementation was written against, and these are the ones it
// was not.

// @ts-ignore Node's own test runner, no dependency added.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import {
  ATTR_BLINK,
  ATTR_ITALIC,
  ATTR_STRIKE,
  ATTR_UNDERLINE,
  COLOR_DEFAULT,
  TerminalEmulator,
  rgbColor,
  rowHtml,
} from "../../src/code/terminal.js";

function emu(cols = 20, rows = 4, scrollback = 16): TerminalEmulator {
  return new TerminalEmulator({ cols, rows, scrollback });
}

/** The attributes and colours the NEXT printed character would carry. */
function pen(e: TerminalEmulator): { fg: number; bg: number; at: number } {
  e.write("X");
  const row = e.viewport(0)[e.snapshot().cursorY];
  const col = e.snapshot().cursorX - 1;
  return { fg: row.fg[col], bg: row.bg[col], at: row.at[col] };
}

// ------------------------------------------------------- colon form SGR

test("an underline colour never touches the foreground or the attributes", () => {
  // ESC[58:2::0:255:0m is "set the underline colour to green", ITU T.416. The
  // flattening parser ran it as SGR 2 (dim) then SGR 0 (full reset), so a red
  // run silently went back to the default colour.
  const e = emu();
  e.write("\x1b[31m\x1b[58:2::0:255:0m");
  const p = pen(e);
  assert.equal(p.fg, 1, "the foreground must still be red");
  assert.equal(p.at, 0, "no attribute may have been set");
});

test("the colon form of 'no underline' turns off exactly the underline", () => {
  const e = emu();
  e.write("\x1b[1;4;31m\x1b[4:0m");
  const p = pen(e);
  assert.equal(p.at & ATTR_UNDERLINE, 0, "underline off");
  assert.ok(p.at & 1, "bold survives");
  assert.equal(p.fg, 1, "red survives");
});

test("a curly underline is an underline and nothing else", () => {
  const e = emu();
  e.write("\x1b[4:3m");
  const p = pen(e);
  assert.ok(p.at & ATTR_UNDERLINE);
  assert.equal(p.at & ATTR_ITALIC, 0, "4:3 must not become SGR 3");
});

test("an indexed underline colour does not set blink and strikethrough", () => {
  const e = emu();
  e.write("\x1b[58:5:9m");
  const p = pen(e);
  assert.equal(p.at & (ATTR_BLINK | ATTR_STRIKE), 0);
  assert.equal(p.fg, COLOR_DEFAULT);
});

test("mixing colon and semicolon forms in one sequence reads the right slots", () => {
  // The colour space offset used to be decided once for the whole parameter
  // string, so the semicolon group behind a colon group was read one field
  // out and the background came back green instead of blue.
  const e = emu();
  e.write("\x1b[38:2::255:0:0;48;2;0;0;255m");
  const p = pen(e);
  assert.equal(p.fg, rgbColor(255, 0, 0));
  assert.equal(p.bg, rgbColor(0, 0, 255));
});

test("the semicolon form of an underline colour consumes its own operands", () => {
  // 58;2;r;g;b must not leave r, g and b to run as SGR codes: 255 is nothing,
  // but a green of 1 would turn on bold.
  const e = emu();
  e.write("\x1b[58;2;1;1;1m");
  assert.equal(pen(e).at, 0);
});

test("the plain 256 colour and truecolour forms still work", () => {
  const a = emu();
  a.write("\x1b[38;5;196m");
  assert.equal(pen(a).fg, 196);
  const b = emu();
  b.write("\x1b[38;2;10;20;30m");
  assert.equal(pen(b).fg, rgbColor(10, 20, 30));
  const c = emu();
  c.write("\x1b[48:5:21m");
  assert.equal(pen(c).bg, 21);
});

// ------------------------------------------------- alternate screen resize

test("shrinking while a full screen program runs keeps the NEWEST parked lines", () => {
  const e = emu(20, 6, 32);
  for (let i = 1; i <= 6; i++) e.write(`N${i}\r\n`.slice(0, i === 6 ? 2 : 5));
  // Six lines of shell output, the last one without a newline so the cursor
  // stays on it, exactly like a prompt.
  const before = e.screenText().split("\n").filter((l) => l !== "");
  assert.deepEqual(before, ["N1", "N2", "N3", "N4", "N5", "N6"]);

  e.write("\x1b[?1049h"); // less, vim, htop
  e.resize(20, 3); // the user drags the pane smaller
  e.write("\x1b[?1049l"); // the program quits

  const after = e.screenText().split("\n").filter((l) => l !== "");
  assert.deepEqual(after, ["N4", "N5", "N6"], "the prompt the user was typing at must survive");
});

// -------------------------------------------------------- cursor rendering

test("the block cursor is still drawn on the trailing half of a wide glyph", () => {
  const e = emu(6, 1);
  e.write("你"); // one CJK character, two cells
  const row = e.viewport(0)[0];
  const html = rowHtml(row, 6, { cursorCol: 1 });
  assert.ok(html.includes("t-cur"), `no cursor in ${JSON.stringify(html)}`);
});

test("the trailing half of a wide glyph still renders as nothing when unmarked", () => {
  const e = emu(6, 1);
  e.write("你");
  const html = rowHtml(e.viewport(0)[0], 6, { cursorCol: -1 });
  assert.ok(!html.includes("t-cur"));
  assert.ok(!html.includes("<span"), "an unstyled row needs no markup at all");
});
