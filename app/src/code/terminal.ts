// Galactus, the integrated terminal of the Code view.
//
// The editor could already read, write and search a project, and the agent
// could already run a command, but there was no place for the user to type
// one. That gap sends people to Terminal.app for anything real, and once they
// are there the app has lost the session. This module closes it.
//
// WHY A HAND WRITTEN EMULATOR AND NOT XTERM.JS. xterm.js is the better
// emulator by a wide margin and nobody should pretend otherwise. It is not
// used here for one reason: this file may not add a dependency to the app's
// package.json (see the ownership rules for this change), and a terminal that
// only works after somebody else's integration pass is a terminal nobody can
// test. What is implemented is stated in full under "SCOPE" below, honestly,
// including everything that is not.
//
// SECURITY. This is the part to read twice, because a terminal is arbitrary
// code execution and the app has a model in it.
//
// There are two completely different actors that can put bytes into a pty,
// and conflating them is the whole class of bug worth preventing:
//
//   * THE USER TYPING. A keystroke is not gated, and gating it would be
//     actively harmful. Nothing is more corrosive to a permission system than
//     a dialog that fires on every key: the user learns to dismiss it without
//     reading, and then the one dialog that mattered gets dismissed too. The
//     user pressing a key IS the authorization; the app already trusts the
//     same user to click "Run command" in the agent pane.
//
//   * THE MODEL WRITING. Bytes a model sends into a session look identical on
//     screen to bytes the user typed. There is no visual difference, no
//     provenance, no undo. So a model write goes through the SAME `shell`
//     permission kind the `run_command` tool uses in agent.ts, with the exact
//     command as the detail, and `decideTerminalWrite` below refuses unless it
//     is handed the approval for THAT payload. It is a per-payload approval on
//     purpose: an approval bound to the session rather than to the text would
//     mean one accepted `ls` grants every command afterwards.
//
// `decideTerminalWrite` fails closed on every axis: unknown origin, unknown
// session, dead session, missing gate, wrong permission kind, mismatched
// detail. There is no default-allow branch anywhere in it, and the tests pin
// that down one reason at a time.
//
// A model payload is also refused outright when it carries control characters
// beyond a single trailing newline. This is not paranoia about escape codes in
// the abstract: a permission dialog can honestly show `git status` and let a
// human judge it, but it cannot honestly show
// `\x1b]52;c;<base64>\x07` or a bare `\x03`, and an approval the user could
// not actually evaluate is worse than no approval at all.
//
// The OUTPUT side has its own rule, and it is the reason two families of
// escape sequence are deliberately parsed and thrown away rather than left
// unparsed:
//
//   * OSC 52 writes the system clipboard. Any program whose output the user
//     merely LOOKS AT (a `cat` of a downloaded file, a compiler printing an
//     attacker controlled string) could otherwise replace what the user
//     pastes next. It is consumed and discarded, never honoured.
//   * Nothing in this emulator ever writes back to the pty. Device status
//     reports (CSI n), device attributes (CSI c) and DECRQSS are recognised so
//     they do not corrupt the screen, and then dropped. A terminal that
//     answers queries is a terminal where output can become input, which is
//     the classic terminal injection.
//
// SCOPE, stated plainly.
//
// Handled: UTF-8 text with combining marks folded into the preceding cell and
// two-cell wide characters (CJK, emoji); C0 controls BEL, BS, HT with 8-column
// tab stops, LF, VT, FF, CR; ESC 7/8 (DECSC/DECRC), D (IND), E (NEL), M (RI),
// c (RIS), = / > (keypad), ( ) * + charset designation including the DEC line
// drawing set for G0; CSI @ A B C D E F G H I J K L M P S T X Z d f g m n r s
// u; SGR 0-9, 21-29, 30-37, 39, 40-47, 49, 90-97, 100-107 plus 38/48 in both
// the ;5;n indexed form and the ;2;r;g;b truecolor form, semicolon or colon
// separated; DEC private modes 1 (application cursor keys), 7 (autowrap),
// 25 (cursor visibility), 1049 (alternate screen), 2004 (bracketed paste);
// scroll regions (DECSTBM); the deferred wrap at the last column, which is
// what makes a full width line not skip a row.
//
// NOT handled, and the failure mode of each: mouse reporting (modes 1000-1006
// are consumed, so a program enabling them will not corrupt the screen, but it
// will not receive clicks); Sixel, iTerm2 and Kitty image protocols (consumed
// as string sequences, images do not appear); double width and double height
// lines (DECDWL/DECDHL are consumed, the line renders single width); G1-G3
// charset invocation via SO/SI (consumed, no effect); bidirectional text and
// grapheme clusters beyond simple combining marks (a family emoji built from
// several ZWJ joined code points occupies the cells of its parts); blink
// (tracked, rendered as a static dim). Anything else falls through the parser
// without reaching the screen, which is the safe direction.
//
// This module imports nothing but the dictionary. The Tauri bridge arrives as
// a `TerminalHost` the app supplies, exactly like `WorkspaceApi` in
// workspace-api.ts, which is what lets every test below run under plain
// `node --test` with no window, no webview and no backend.

import { t } from "../i18n.js";

// ================================================================ geometry

/** Matches the clamp in src-tauri/src/pty.rs. The two must not drift. */
export const MIN_COLS = 2;
export const MAX_COLS = 1000;
export const MIN_ROWS = 1;
export const MAX_ROWS = 300;
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

export interface GridSize {
  cols: number;
  rows: number;
}

/**
 * Force a requested geometry into something a child process can survive.
 *
 * Every caller of this is ultimately a DOM measurement divided by a font
 * metric, and both halves of that division lie: a pane that is display:none
 * measures 0, a font that has not loaded yet measures 0, and 0/0 is NaN. A
 * terminal told it has NaN columns makes ncurses allocate nothing and the
 * child segfaults, so nothing here is trusted and there is no error path: a
 * nonsense size becomes the default size.
 */
export function clampTerminalSize(cols: number, rows: number): GridSize {
  const c = Number.isFinite(cols) ? Math.floor(cols) : DEFAULT_COLS;
  const r = Number.isFinite(rows) ? Math.floor(rows) : DEFAULT_ROWS;
  return {
    cols: Math.min(MAX_COLS, Math.max(MIN_COLS, c)),
    rows: Math.min(MAX_ROWS, Math.max(MIN_ROWS, r)),
  };
}

/**
 * Grid size for a pixel box and a measured cell. Separate from the clamp so
 * the division, which is where the zeroes come from, is tested on its own.
 */
export function gridSizeFor(width: number, height: number, cellWidth: number, cellHeight: number): GridSize {
  if (!(cellWidth > 0) || !(cellHeight > 0)) return { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
  return clampTerminalSize(width / cellWidth, height / cellHeight);
}

// ============================================================== ring buffer

/**
 * Bounded scrollback. A terminal's output is unbounded by nature (`yarn build`
 * on a monorepo, a stray `cat` on a binary) and the only question is where the
 * ceiling is, not whether there is one. Dropping the oldest line is the only
 * eviction policy that keeps what the user is looking at.
 *
 * `dropped` is kept and surfaced rather than hidden: a scrollback that
 * silently begins mid-history teaches the user the build printed less than it
 * did, which is the same honesty rule the search panel follows for its own
 * ceiling.
 */
export class RingBuffer<T> {
  private items: (T | undefined)[];
  private head = 0; // index of the oldest retained item
  private count = 0;
  private droppedCount = 0;
  private pushedCount = 0;

  constructor(capacity: number) {
    this.items = new Array<T | undefined>(RingBuffer.normalizeCapacity(capacity));
  }

  /** A capacity below one has no meaning and NaN has less. */
  private static normalizeCapacity(capacity: number): number {
    if (!Number.isFinite(capacity)) return 1;
    return Math.max(1, Math.floor(capacity));
  }

  get capacity(): number {
    return this.items.length;
  }

  get length(): number {
    return this.count;
  }

  /** Everything ever pushed, evicted included. */
  get pushed(): number {
    return this.pushedCount;
  }

  /** How many items the ceiling cost. Zero means the history is complete. */
  get dropped(): number {
    return this.droppedCount;
  }

  /** Push, returning the evicted item when the buffer was already full. */
  push(item: T): T | undefined {
    this.pushedCount++;
    const cap = this.items.length;
    if (this.count < cap) {
      this.items[(this.head + this.count) % cap] = item;
      this.count++;
      return undefined;
    }
    const evicted = this.items[this.head];
    this.items[this.head] = item;
    this.head = (this.head + 1) % cap;
    this.droppedCount++;
    return evicted;
  }

  /** Index 0 is the OLDEST retained item. Out of range yields undefined. */
  at(i: number): T | undefined {
    if (!Number.isInteger(i) || i < 0 || i >= this.count) return undefined;
    return this.items[(this.head + i) % this.items.length];
  }

  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i++) out.push(this.items[(this.head + i) % this.items.length] as T);
    return out;
  }

  clear(): void {
    this.items = new Array<T | undefined>(this.items.length);
    this.head = 0;
    this.count = 0;
    // `dropped` and `pushed` are lifetime counters and survive a clear on
    // purpose: they describe the stream, not the buffer.
  }

  /**
   * Change the ceiling in place. Shrinking discards the OLDEST items, which is
   * the same rule as an ordinary eviction, and counts them as dropped so the
   * banner stays truthful.
   */
  resize(capacity: number): void {
    const cap = RingBuffer.normalizeCapacity(capacity);
    if (cap === this.items.length) return;
    const kept = this.toArray();
    const overflow = Math.max(0, kept.length - cap);
    this.droppedCount += overflow;
    const tail = kept.slice(overflow);
    this.items = new Array<T | undefined>(cap);
    for (let i = 0; i < tail.length; i++) this.items[i] = tail[i];
    this.head = 0;
    this.count = tail.length;
  }
}

// ================================================================ cells

/** Attribute bits. Packed into one byte so a row costs a Uint8Array. */
export const ATTR_BOLD = 1;
export const ATTR_DIM = 2;
export const ATTR_ITALIC = 4;
export const ATTR_UNDERLINE = 8;
export const ATTR_BLINK = 16;
export const ATTR_INVERSE = 32;
export const ATTR_HIDDEN = 64;
export const ATTR_STRIKE = 128;

/**
 * Colour encoding, one number per cell so the row stays a typed array:
 *   -1              the terminal default (theme foreground / background)
 *   0 .. 255        an index into the xterm palette
 *   >= 0x1000000    truecolor, the low 24 bits are RGB
 */
export const COLOR_DEFAULT = -1;
export const COLOR_RGB_FLAG = 0x1000000;

export function rgbColor(r: number, g: number, b: number): number {
  const cl = (v: number) => Math.min(255, Math.max(0, Math.floor(Number.isFinite(v) ? v : 0)));
  return COLOR_RGB_FLAG | (cl(r) << 16) | (cl(g) << 8) | cl(b);
}

/** A 256 colour palette index, clamped into the palette it names. */
export function indexColor(n: number): number {
  return Math.min(255, Math.max(0, Math.floor(Number.isFinite(n) ? n : 0)));
}

/**
 * One line of the grid. Three parallel typed arrays plus the characters: an
 * array of per-cell objects would be four thousand allocations for one screen
 * and a hundred thousand for the scrollback.
 */
export interface Row {
  chars: string[];
  fg: Int32Array;
  bg: Int32Array;
  at: Uint8Array;
}

export function blankRow(cols: number): Row {
  const chars = new Array<string>(cols).fill(" ");
  const fg = new Int32Array(cols).fill(COLOR_DEFAULT);
  const bg = new Int32Array(cols).fill(COLOR_DEFAULT);
  return { chars, fg, bg, at: new Uint8Array(cols) };
}

/**
 * Drop the trailing run of untouched cells before a row enters the
 * scrollback. A build log is mostly short lines in an 80 to 200 column
 * terminal, so this is the difference between storing what was printed and
 * storing the width of the window times the length of the history.
 */
export function compactRow(row: Row): Row {
  let end = row.chars.length;
  while (end > 0) {
    const i = end - 1;
    if (row.chars[i] !== " " || row.fg[i] !== COLOR_DEFAULT || row.bg[i] !== COLOR_DEFAULT || row.at[i] !== 0) break;
    end--;
  }
  return {
    chars: row.chars.slice(0, end),
    fg: row.fg.slice(0, end),
    bg: row.bg.slice(0, end),
    at: row.at.slice(0, end),
  };
}

// ============================================================ character width

const ZERO_WIDTH: [number, number][] = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x05bf, 0x05bf],
  [0x0610, 0x061a], [0x064b, 0x065f], [0x0670, 0x0670], [0x06d6, 0x06dc],
  [0x0711, 0x0711], [0x0730, 0x074a], [0x07eb, 0x07f3], [0x0816, 0x0819],
  [0x0e31, 0x0e31], [0x0e34, 0x0e3a], [0x0e47, 0x0e4e], [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x2060, 0x2064], [0x20d0, 0x20f0],
  [0xfe00, 0xfe0f], [0xfe20, 0xfe2f],
];

const WIDE: [number, number][] = [
  [0x1100, 0x115f], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3041, 0x33ff],
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

function inRanges(cp: number, ranges: [number, number][]): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid];
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Cells a code point occupies: 0 for a combining mark, 2 for the wide ranges,
 * 1 otherwise. Getting this wrong does not merely look bad, it desynchronises
 * the cursor from what the child process believes, and every subsequent
 * redraw lands one column off.
 */
export function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x0300) return 1;
  if (inRanges(cp, ZERO_WIDTH)) return 0;
  if (inRanges(cp, WIDE)) return 2;
  return 1;
}

// ============================================================ DEC line drawing

/**
 * The DEC Special Graphics set, selected by `ESC ( 0`. Every ncurses program
 * that predates UTF-8 boxes draws its borders with it, so without this table
 * a `dialog` or an old `htop` renders its frame as `lqqqk`.
 */
const DEC_GRAPHICS: Record<string, string> = {
  "`": "◆", a: "▒", b: "␉", c: "␌", d: "␍", e: "␊",
  f: "°", g: "±", h: "␤", i: "␋", j: "┘", k: "┐",
  l: "┌", m: "└", n: "┼", o: "⎺", p: "⎻", q: "─",
  r: "⎼", s: "⎽", t: "├", u: "┤", v: "┴", w: "┬",
  x: "│", y: "≤", z: "≥", "{": "π", "|": "≠",
  "}": "£", "~": "·",
};

// ================================================================ emulator

type ParserState = "ground" | "esc" | "csi" | "osc" | "string" | "charset";

export interface EmulatorOptions {
  cols: number;
  rows: number;
  /** Lines of history kept above the screen. */
  scrollback: number;
}

export interface EmulatorState {
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
  cursorVisible: boolean;
  altActive: boolean;
  appCursorKeys: boolean;
  bracketedPaste: boolean;
  title: string;
}

/**
 * The screen. Feed it bytes with `write`, read it back with `viewport`.
 *
 * Parser state survives between calls on purpose: a pty read can and does cut
 * an escape sequence in half, and an emulator that resets on chunk boundaries
 * prints `[32m` into the middle of a compiler warning. The tests feed the same
 * sequence in one piece and one character at a time and require the same
 * screen.
 */
export class TerminalEmulator {
  cols: number;
  rows: number;
  private grid: Row[];
  /** The normal screen, parked while the alternate screen is active. */
  private saved: Row[] | null = null;
  readonly scrollback: RingBuffer<Row>;

  private x = 0;
  private y = 0;
  private fg = COLOR_DEFAULT;
  private bg = COLOR_DEFAULT;
  private at = 0;
  private savedCursor = { x: 0, y: 0, fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, at: 0 };
  private scrollTop = 0;
  private scrollBottom: number;
  private autowrap = true;
  /**
   * The deferred wrap. Writing to the last column does NOT move to the next
   * line; the move happens when the NEXT printable arrives. Terminals that
   * wrap eagerly insert a blank line after every full width line, which is the
   * single most visible emulator bug there is.
   */
  private wrapPending = false;
  cursorVisible = true;
  altActive = false;
  appCursorKeys = false;
  bracketedPaste = false;
  title = "";
  private g0Graphics = false;

  private parserState: ParserState = "ground";
  private paramBuf = "";
  private privMarker = "";
  private oscBuf = "";
  private stringSawEsc = false;

  constructor(opts: EmulatorOptions) {
    const size = clampTerminalSize(opts.cols, opts.rows);
    this.cols = size.cols;
    this.rows = size.rows;
    this.scrollBottom = this.rows - 1;
    this.grid = Array.from({ length: this.rows }, () => blankRow(this.cols));
    this.scrollback = new RingBuffer<Row>(opts.scrollback);
  }

  /** A read-only view of the modes the view and the key encoder need. */
  snapshot(): EmulatorState {
    return {
      cols: this.cols,
      rows: this.rows,
      cursorX: this.x,
      cursorY: this.y,
      cursorVisible: this.cursorVisible,
      altActive: this.altActive,
      appCursorKeys: this.appCursorKeys,
      bracketedPaste: this.bracketedPaste,
      title: this.title,
    };
  }

  /** The live screen, top row first. Never the scrollback. */
  screen(): Row[] {
    return this.grid;
  }

  /** Plain text of the screen, trailing blanks trimmed. For tests and copy. */
  screenText(): string {
    return this.grid.map((r) => compactRow(r).chars.join("")).join("\n");
  }

  /** Plain text of the history plus the screen. */
  allText(): string {
    const hist = this.scrollback.toArray().map((r) => r.chars.join(""));
    return hist.concat(this.grid.map((r) => compactRow(r).chars.join(""))).join("\n");
  }

  /**
   * `rows` lines ending `offset` lines above the live screen. offset 0 is the
   * live screen; larger offsets walk back into the history.
   */
  viewport(offset: number): Row[] {
    const back = Math.max(0, Math.min(Math.floor(offset) || 0, this.scrollback.length));
    if (back === 0) return this.grid;
    const out: Row[] = [];
    const histStart = this.scrollback.length - back;
    for (let i = 0; i < this.rows; i++) {
      const h = histStart + i;
      if (h < this.scrollback.length) {
        const r = this.scrollback.at(h);
        out.push(r ? this.padRow(r) : blankRow(this.cols));
      } else {
        out.push(this.grid[h - this.scrollback.length]);
      }
    }
    return out;
  }

  /** A compacted history row widened back to the current column count. */
  private padRow(r: Row): Row {
    if (r.chars.length === this.cols) return r;
    const out = blankRow(this.cols);
    const n = Math.min(r.chars.length, this.cols);
    for (let i = 0; i < n; i++) {
      out.chars[i] = r.chars[i];
      out.fg[i] = r.fg[i];
      out.bg[i] = r.bg[i];
      out.at[i] = r.at[i];
    }
    return out;
  }

  // ------------------------------------------------------------ resizing

  /**
   * Re-geometry the screen. Lines pushed off the top by a shrink go to the
   * scrollback rather than being deleted: a build that just failed must not
   * lose its error because the user dragged the splitter.
   */
  resize(cols: number, rows: number): GridSize {
    const size = clampTerminalSize(cols, rows);
    if (size.cols === this.cols && size.rows === this.rows) return size;
    const oldRows = this.rows;
    this.cols = size.cols;
    this.rows = size.rows;

    const rewidth = (r: Row): Row => {
      if (r.chars.length === this.cols) return r;
      const out = blankRow(this.cols);
      const n = Math.min(r.chars.length, this.cols);
      for (let i = 0; i < n; i++) {
        out.chars[i] = r.chars[i];
        out.fg[i] = r.fg[i];
        out.bg[i] = r.bg[i];
        out.at[i] = r.at[i];
      }
      return out;
    };
    this.grid = this.grid.map(rewidth);
    if (this.saved) this.saved = this.saved.map(rewidth);

    if (this.rows < oldRows) {
      const drop = oldRows - this.rows;
      // Prefer to drop from the TOP, which is what a real terminal does, but
      // never scroll the cursor off the bottom.
      const fromTop = Math.min(drop, Math.max(0, this.y - (this.rows - 1)));
      for (let i = 0; i < fromTop; i++) {
        const row = this.grid.shift();
        if (row && !this.altActive) this.scrollback.push(compactRow(row));
      }
      this.grid.length = this.rows;
      this.y -= fromTop;
      // The parked normal screen shrinks from the TOP as well. Truncating with
      // `saved.length = rows` drops rows from the BOTTOM, which throws away
      // the most recent output and the prompt the user was about to type at,
      // then resurrects the oldest lines when the full screen program quits.
      // Nothing recovers them: a parked screen never pushes into scrollback.
      if (this.saved && this.saved.length > this.rows) {
        this.saved.splice(0, this.saved.length - this.rows);
      }
    } else if (this.rows > oldRows) {
      for (let i = oldRows; i < this.rows; i++) this.grid.push(blankRow(this.cols));
      if (this.saved) for (let i = oldRows; i < this.rows; i++) this.saved.push(blankRow(this.cols));
    }
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.x = Math.min(this.x, this.cols - 1);
    this.y = Math.min(Math.max(this.y, 0), this.rows - 1);
    this.wrapPending = false;
    return size;
  }

  // ------------------------------------------------------------- parsing

  write(data: string): void {
    for (const ch of data) {
      const cp = ch.codePointAt(0) ?? 0;
      switch (this.parserState) {
        case "ground":
          this.ground(ch, cp);
          break;
        case "esc":
          this.escState(ch);
          break;
        case "csi":
          this.csiState(ch, cp);
          break;
        case "osc":
          this.oscState(ch, cp);
          break;
        case "string":
          this.stringState(ch, cp);
          break;
        case "charset":
          // ESC ( X and friends. Only G0 line drawing changes anything here;
          // the other slots are consumed so their designator never prints.
          this.g0Graphics = ch === "0";
          this.parserState = "ground";
          break;
      }
    }
  }

  private ground(ch: string, cp: number): void {
    if (cp === 0x1b) {
      this.parserState = "esc";
      return;
    }
    if (cp < 0x20) {
      this.execute(cp);
      return;
    }
    if (cp === 0x7f) return; // DEL prints nothing
    this.print(ch, cp);
  }

  private execute(cp: number): void {
    switch (cp) {
      case 0x07: // BEL. Deliberately silent: an audible bell from a background
        break; //  build is a hostile feature in a desktop app.
      case 0x08: // BS
        if (this.wrapPending) this.wrapPending = false;
        else if (this.x > 0) this.x--;
        break;
      case 0x09: { // HT, fixed 8-column stops
        const next = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8);
        this.x = next;
        this.wrapPending = false;
        break;
      }
      case 0x0a:
      case 0x0b:
      case 0x0c:
        this.lineFeed();
        break;
      case 0x0d:
        this.x = 0;
        this.wrapPending = false;
        break;
      default:
        break; // SO/SI and the rest: consumed, no effect
    }
  }

  private escState(ch: string): void {
    switch (ch) {
      case "[":
        this.parserState = "csi";
        this.paramBuf = "";
        this.privMarker = "";
        return;
      case "]":
        this.parserState = "osc";
        this.oscBuf = "";
        this.stringSawEsc = false;
        return;
      case "P": // DCS
      case "^": // PM
      case "_": // APC
      case "X": // SOS
        this.parserState = "string";
        this.stringSawEsc = false;
        return;
      case "(":
      case ")":
      case "*":
      case "+":
        this.parserState = "charset";
        return;
      case "7":
        this.savedCursor = { x: this.x, y: this.y, fg: this.fg, bg: this.bg, at: this.at };
        break;
      case "8":
        this.x = Math.min(this.savedCursor.x, this.cols - 1);
        this.y = Math.min(this.savedCursor.y, this.rows - 1);
        this.fg = this.savedCursor.fg;
        this.bg = this.savedCursor.bg;
        this.at = this.savedCursor.at;
        break;
      case "D":
        this.lineFeed();
        break;
      case "E":
        this.x = 0;
        this.lineFeed();
        break;
      case "M":
        this.reverseIndex();
        break;
      case "c":
        this.reset();
        break;
      default:
        break; // keypad modes and anything else: consumed
    }
    this.parserState = "ground";
  }

  private csiState(ch: string, cp: number): void {
    // A C0 control inside a CSI is executed in place, exactly as a real
    // terminal does; a program that prints a newline mid-sequence must not
    // leave the parser stuck forever.
    if (cp < 0x20) {
      this.execute(cp);
      return;
    }
    if (cp >= 0x40 && cp <= 0x7e) {
      this.dispatchCsi(ch);
      this.parserState = "ground";
      return;
    }
    if (this.paramBuf.length === 0 && (ch === "?" || ch === ">" || ch === "<" || ch === "=")) {
      this.privMarker = ch;
      return;
    }
    // A runaway sequence must not grow without bound.
    if (this.paramBuf.length < 128) this.paramBuf += ch;
  }

  private oscState(ch: string, cp: number): void {
    if (this.stringSawEsc) {
      this.stringSawEsc = false;
      if (ch === "\\") {
        this.dispatchOsc();
        this.parserState = "ground";
        return;
      }
      // A lone ESC aborts the string; re-enter the escape state so the real
      // sequence that follows is not eaten.
      this.parserState = "esc";
      this.escState(ch);
      return;
    }
    if (cp === 0x07) {
      this.dispatchOsc();
      this.parserState = "ground";
      return;
    }
    if (cp === 0x1b) {
      this.stringSawEsc = true;
      return;
    }
    if (cp === 0x18 || cp === 0x1a) {
      this.parserState = "ground";
      return;
    }
    if (this.oscBuf.length < 4096) this.oscBuf += ch;
  }

  private stringState(ch: string, cp: number): void {
    // DCS / PM / APC / SOS: consumed to their terminator and discarded. This
    // is where Sixel and the Kitty graphics protocol land, which is why an
    // image does not appear but also does not vomit its payload on screen.
    if (this.stringSawEsc) {
      this.stringSawEsc = false;
      if (ch === "\\") {
        this.parserState = "ground";
        return;
      }
      this.parserState = "esc";
      this.escState(ch);
      return;
    }
    if (cp === 0x1b) {
      this.stringSawEsc = true;
      return;
    }
    if (cp === 0x07 || cp === 0x18 || cp === 0x1a) this.parserState = "ground";
  }

  private dispatchOsc(): void {
    const buf = this.oscBuf;
    this.oscBuf = "";
    const sep = buf.indexOf(";");
    const code = sep < 0 ? buf : buf.slice(0, sep);
    const arg = sep < 0 ? "" : buf.slice(sep + 1);
    switch (code) {
      case "0":
      case "1":
      case "2":
        this.title = arg.slice(0, 200);
        return;
      // 52 is the clipboard. See the security note at the top: consumed and
      // thrown away, never applied, because the user only looked at the
      // output that carried it.
      case "52":
        return;
      default:
        return; // palette, cwd reporting, hyperlinks: consumed
    }
  }

  private params(): number[] {
    if (this.paramBuf === "") return [];
    return this.paramBuf.split(";").map((p) => {
      // Colon separated sub-parameters (SGR 38:2::r:g:b) are flattened by the
      // SGR handler; here only the first number matters.
      const n = parseInt(p.split(":")[0], 10);
      return Number.isFinite(n) ? n : 0;
    });
  }

  private dispatchCsi(final: string): void {
    const p = this.params();
    const arg = (i: number, dflt: number) => {
      const v = p[i];
      return v === undefined || v === 0 ? dflt : v;
    };
    switch (final) {
      case "@": this.insertChars(arg(0, 1)); break;
      case "A": this.moveY(-arg(0, 1)); break;
      case "B": this.moveY(arg(0, 1)); break;
      case "C": this.moveX(arg(0, 1)); break;
      case "D": this.moveX(-arg(0, 1)); break;
      case "E": this.x = 0; this.moveY(arg(0, 1)); break;
      case "F": this.x = 0; this.moveY(-arg(0, 1)); break;
      case "G": this.x = this.clampX(arg(0, 1) - 1); this.wrapPending = false; break;
      case "H":
      case "f":
        this.y = Math.min(Math.max(arg(0, 1) - 1, 0), this.rows - 1);
        this.x = this.clampX(arg(1, 1) - 1);
        this.wrapPending = false;
        break;
      case "I": for (let i = 0; i < arg(0, 1); i++) this.execute(0x09); break;
      case "J": this.eraseDisplay(p[0] ?? 0); break;
      case "K": this.eraseLine(p[0] ?? 0); break;
      case "L": this.insertLines(arg(0, 1)); break;
      case "M": this.deleteLines(arg(0, 1)); break;
      case "P": this.deleteChars(arg(0, 1)); break;
      case "S": this.scrollUp(arg(0, 1)); break;
      case "T": this.scrollDown(arg(0, 1)); break;
      case "X": this.eraseChars(arg(0, 1)); break;
      case "Z": this.backTab(arg(0, 1)); break;
      case "d": this.y = Math.min(Math.max(arg(0, 1) - 1, 0), this.rows - 1); this.wrapPending = false; break;
      case "g": break; // tab stops are fixed at 8, so clearing one is a no-op
      case "h": this.setMode(p, true); break;
      case "l": this.setMode(p, false); break;
      case "m": this.sgr(); break;
      // CSI n is a device status REPORT request. Recognised so it does not
      // corrupt the screen, and then dropped: see the security note. Nothing
      // in this emulator ever writes back to the pty.
      case "n": break;
      case "r": {
        const top = Math.max(0, arg(0, 1) - 1);
        const bot = Math.min(this.rows - 1, (p[1] ?? this.rows) - 1);
        if (top < bot) {
          this.scrollTop = top;
          this.scrollBottom = bot;
          this.x = 0;
          this.y = top;
        }
        break;
      }
      case "s":
        this.savedCursor = { x: this.x, y: this.y, fg: this.fg, bg: this.bg, at: this.at };
        break;
      case "u":
        this.x = Math.min(this.savedCursor.x, this.cols - 1);
        this.y = Math.min(this.savedCursor.y, this.rows - 1);
        break;
      default:
        break; // unknown final byte: consumed, nothing printed
    }
  }

  private setMode(p: number[], on: boolean): void {
    if (this.privMarker !== "?") return; // ANSI modes: none of them apply here
    for (const m of p) {
      switch (m) {
        case 1: this.appCursorKeys = on; break;
        case 7: this.autowrap = on; break;
        case 25: this.cursorVisible = on; break;
        case 1047:
        case 1049:
          this.setAltScreen(on);
          break;
        case 2004: this.bracketedPaste = on; break;
        default: break; // mouse modes 1000..1006 and the rest: consumed
      }
    }
  }

  private setAltScreen(on: boolean): void {
    if (on === this.altActive) return;
    if (on) {
      this.saved = this.grid;
      this.savedCursor = { x: this.x, y: this.y, fg: this.fg, bg: this.bg, at: this.at };
      this.grid = Array.from({ length: this.rows }, () => blankRow(this.cols));
      this.x = 0;
      this.y = 0;
    } else {
      this.grid = this.saved ?? Array.from({ length: this.rows }, () => blankRow(this.cols));
      this.saved = null;
      this.x = Math.min(this.savedCursor.x, this.cols - 1);
      this.y = Math.min(this.savedCursor.y, this.rows - 1);
      this.fg = this.savedCursor.fg;
      this.bg = this.savedCursor.bg;
      this.at = this.savedCursor.at;
    }
    this.altActive = on;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.wrapPending = false;
  }

  /**
   * SGR, parsed as a list of PARAMETERS each of which may carry its own
   * sub-parameters, which is what ECMA-48 actually says.
   *
   * The first version flattened every colon into the top level list and fed
   * each number to sgrSimple(). Only 38 and 48 consumed their sub-parameters,
   * so every other colon form executed its sub-parameters as independent SGR
   * codes: `ESC[58:2::0:255:0m` (set the underline colour, which we do not
   * render) ran SGR 2 then SGR 0 and wiped the whole run, `ESC[4:0m` (no
   * underline) wiped it too, `ESC[4:3m` turned on italic, and `ESC[58:5:9m`
   * set blink and strikethrough. The colour space offset was also decided once
   * for the entire parameter string, so a sequence mixing both separators read
   * the wrong slots. Grouping first fixes all of it, because a sub-parameter
   * now belongs to exactly one selector and nothing else can ever see it.
   */
  private sgr(): void {
    const raw = this.paramBuf === "" ? ["0"] : this.paramBuf.split(";");
    // An empty sub-parameter is a zero: `38:2::r:g:b` really does carry an
    // empty colour space slot, and it must be counted, not elided.
    const groups: number[][] = raw.map((part) =>
      part.split(":").map((sub) => (sub === "" ? 0 : parseInt(sub, 10) || 0))
    );
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (g.length > 1) {
        this.sgrSub(g);
        continue;
      }
      const v = g[0];
      // The semicolon form of an extended colour takes its operands from the
      // parameters that FOLLOW, and they must be consumed here or they run as
      // SGR codes of their own.
      if (v === 38 || v === 48 || v === 58) {
        const kind = groups[i + 1]?.[0];
        if (kind === 5) {
          this.setExtColor(v, indexColor(groups[i + 2]?.[0] ?? 0));
          i += 2;
        } else if (kind === 2) {
          const r = groups[i + 2]?.[0] ?? 0;
          const gr = groups[i + 3]?.[0] ?? 0;
          const b = groups[i + 4]?.[0] ?? 0;
          this.setExtColor(v, rgbColor(r, gr, b));
          i += 4;
        } else {
          i += 1; // unknown colour kind: skip its selector and carry on
        }
        continue;
      }
      this.sgrSimple(v);
    }
  }

  /** One SGR parameter that carried colon separated sub-parameters. */
  private sgrSub(g: number[]): void {
    const v = g[0];
    if (v === 38 || v === 48 || v === 58) {
      const kind = g[1];
      if (kind === 5) this.setExtColor(v, indexColor(g[2] ?? 0));
      else if (kind === 2) {
        // T.416 puts a colour space id between the 2 and the components and
        // emitters disagree on whether it is there. Six sub-parameters means
        // it is, five means the short form; reading it as red is the classic
        // off by one. Decided PER GROUP, never once for the whole string.
        const base = g.length >= 6 ? 3 : 2;
        this.setExtColor(v, rgbColor(g[base] ?? 0, g[base + 1] ?? 0, g[base + 2] ?? 0));
      }
      return;
    }
    if (v === 4) {
      // 4:0 is "no underline"; 4:1 through 4:5 are underline STYLES (double,
      // curly, dotted, dashed). One underline is all this renderer draws, so
      // every non zero style is simply an underline.
      this.sgrSimple(g[1] === 0 ? 24 : 4);
      return;
    }
    // Every other colon form is consumed whole and applied to nothing. That is
    // the point: an unrecognised sub-parameter must never reach sgrSimple.
  }

  /** 38 is the foreground, 48 the background, 58 the underline colour. */
  private setExtColor(selector: number, color: number): void {
    if (selector === 38) this.fg = color;
    else if (selector === 48) this.bg = color;
    // 58 is parsed so it cannot corrupt the run and then dropped: this
    // renderer underlines in the foreground colour and has nowhere to put a
    // second one.
  }

  private sgrSimple(v: number): void {
    if (v === 0) {
      this.fg = COLOR_DEFAULT;
      this.bg = COLOR_DEFAULT;
      this.at = 0;
      return;
    }
    const set = (bit: number, on: boolean) => {
      this.at = on ? this.at | bit : this.at & ~bit;
    };
    if (v === 1) set(ATTR_BOLD, true);
    else if (v === 2) set(ATTR_DIM, true);
    else if (v === 3) set(ATTR_ITALIC, true);
    else if (v === 4) set(ATTR_UNDERLINE, true);
    else if (v === 5 || v === 6) set(ATTR_BLINK, true);
    else if (v === 7) set(ATTR_INVERSE, true);
    else if (v === 8) set(ATTR_HIDDEN, true);
    else if (v === 9) set(ATTR_STRIKE, true);
    else if (v === 21 || v === 22) {
      set(ATTR_BOLD, false);
      set(ATTR_DIM, false);
    } else if (v === 23) set(ATTR_ITALIC, false);
    else if (v === 24) set(ATTR_UNDERLINE, false);
    else if (v === 25) set(ATTR_BLINK, false);
    else if (v === 27) set(ATTR_INVERSE, false);
    else if (v === 28) set(ATTR_HIDDEN, false);
    else if (v === 29) set(ATTR_STRIKE, false);
    else if (v >= 30 && v <= 37) this.fg = v - 30;
    else if (v === 39) this.fg = COLOR_DEFAULT;
    else if (v >= 40 && v <= 47) this.bg = v - 40;
    else if (v === 49) this.bg = COLOR_DEFAULT;
    else if (v >= 90 && v <= 97) this.fg = v - 90 + 8;
    else if (v >= 100 && v <= 107) this.bg = v - 100 + 8;
  }

  // ---------------------------------------------------------- screen ops

  private clampX(v: number): number {
    return Math.min(Math.max(v, 0), this.cols - 1);
  }

  private moveX(d: number): void {
    this.x = this.clampX(this.x + d);
    this.wrapPending = false;
  }

  private moveY(d: number): void {
    // Movement never scrolls; it stops at the scroll region edge it started
    // inside, which is what makes a status line at the bottom stay put.
    const inRegion = this.y >= this.scrollTop && this.y <= this.scrollBottom;
    const lo = inRegion ? this.scrollTop : 0;
    const hi = inRegion ? this.scrollBottom : this.rows - 1;
    this.y = Math.min(Math.max(this.y + d, lo), hi);
    this.wrapPending = false;
  }

  private lineFeed(): void {
    this.wrapPending = false;
    if (this.y === this.scrollBottom) this.scrollUp(1);
    else if (this.y < this.rows - 1) this.y++;
  }

  private reverseIndex(): void {
    this.wrapPending = false;
    if (this.y === this.scrollTop) this.scrollDown(1);
    else if (this.y > 0) this.y--;
  }

  private scrollUp(n: number): void {
    const count = Math.min(Math.max(1, n), this.scrollBottom - this.scrollTop + 1);
    for (let i = 0; i < count; i++) {
      const row = this.grid[this.scrollTop];
      // History is only kept for the real screen scrolling as a whole. A
      // scroll region is a program repainting part of its own UI (a pager, a
      // status bar) and pushing those rows into the history would fill it
      // with redraw noise.
      if (!this.altActive && this.scrollTop === 0 && this.scrollBottom === this.rows - 1) {
        this.scrollback.push(compactRow(row));
      }
      this.grid.splice(this.scrollTop, 1);
      this.grid.splice(this.scrollBottom, 0, blankRow(this.cols));
    }
  }

  private scrollDown(n: number): void {
    const count = Math.min(Math.max(1, n), this.scrollBottom - this.scrollTop + 1);
    for (let i = 0; i < count; i++) {
      this.grid.splice(this.scrollBottom, 1);
      this.grid.splice(this.scrollTop, 0, blankRow(this.cols));
    }
  }

  private insertLines(n: number): void {
    if (this.y < this.scrollTop || this.y > this.scrollBottom) return;
    const count = Math.min(Math.max(1, n), this.scrollBottom - this.y + 1);
    for (let i = 0; i < count; i++) {
      this.grid.splice(this.scrollBottom, 1);
      this.grid.splice(this.y, 0, blankRow(this.cols));
    }
    this.x = 0;
  }

  private deleteLines(n: number): void {
    if (this.y < this.scrollTop || this.y > this.scrollBottom) return;
    const count = Math.min(Math.max(1, n), this.scrollBottom - this.y + 1);
    for (let i = 0; i < count; i++) {
      this.grid.splice(this.y, 1);
      this.grid.splice(this.scrollBottom, 0, blankRow(this.cols));
    }
    this.x = 0;
  }

  private insertChars(n: number): void {
    const row = this.grid[this.y];
    const count = Math.min(Math.max(1, n), this.cols - this.x);
    for (let i = this.cols - 1; i >= this.x + count; i--) {
      row.chars[i] = row.chars[i - count];
      row.fg[i] = row.fg[i - count];
      row.bg[i] = row.bg[i - count];
      row.at[i] = row.at[i - count];
    }
    for (let i = this.x; i < this.x + count; i++) this.blank(row, i);
  }

  private deleteChars(n: number): void {
    const row = this.grid[this.y];
    const count = Math.min(Math.max(1, n), this.cols - this.x);
    for (let i = this.x; i < this.cols - count; i++) {
      row.chars[i] = row.chars[i + count];
      row.fg[i] = row.fg[i + count];
      row.bg[i] = row.bg[i + count];
      row.at[i] = row.at[i + count];
    }
    for (let i = this.cols - count; i < this.cols; i++) this.blank(row, i);
  }

  private eraseChars(n: number): void {
    const row = this.grid[this.y];
    const count = Math.min(Math.max(1, n), this.cols - this.x);
    for (let i = this.x; i < this.x + count; i++) this.blank(row, i);
  }

  private backTab(n: number): void {
    for (let i = 0; i < Math.max(1, n); i++) {
      this.x = Math.max(0, (Math.ceil(this.x / 8) - 1) * 8);
    }
    this.wrapPending = false;
  }

  /**
   * Erasing writes the CURRENT background, not the default one. A program that
   * sets a background and then clears the screen expects a coloured screen,
   * and getting this wrong is why some TUIs show black bands.
   */
  private blank(row: Row, i: number): void {
    row.chars[i] = " ";
    row.fg[i] = COLOR_DEFAULT;
    row.bg[i] = this.bg;
    row.at[i] = 0;
  }

  private eraseLine(mode: number): void {
    const row = this.grid[this.y];
    const from = mode === 1 ? 0 : mode === 2 ? 0 : this.x;
    const to = mode === 0 ? this.cols - 1 : mode === 1 ? this.x : this.cols - 1;
    for (let i = from; i <= to; i++) this.blank(row, i);
    this.wrapPending = false;
  }

  private eraseDisplay(mode: number): void {
    if (mode === 2 || mode === 3) {
      for (const row of this.grid) for (let i = 0; i < this.cols; i++) this.blank(row, i);
      // Mode 3 also clears the history. Honour it: `clear` relies on it and a
      // user who asked for a clean slate meant it.
      if (mode === 3) this.scrollback.clear();
    } else if (mode === 1) {
      for (let y = 0; y < this.y; y++) for (let i = 0; i < this.cols; i++) this.blank(this.grid[y], i);
      for (let i = 0; i <= this.x && i < this.cols; i++) this.blank(this.grid[this.y], i);
    } else {
      for (let i = this.x; i < this.cols; i++) this.blank(this.grid[this.y], i);
      for (let y = this.y + 1; y < this.rows; y++) {
        for (let i = 0; i < this.cols; i++) this.blank(this.grid[y], i);
      }
    }
    this.wrapPending = false;
  }

  private print(ch: string, cp: number): void {
    const w = charWidth(cp);
    if (w === 0) {
      // A combining mark belongs to the character already on screen. Attaching
      // it to the previous cell is what keeps an accented letter one cell wide
      // instead of splitting it in two.
      const px = this.x > 0 ? this.x - 1 : 0;
      const row = this.grid[this.y];
      if (row.chars[px] !== undefined && row.chars[px] !== " ") row.chars[px] += ch;
      return;
    }
    const glyph = this.g0Graphics && DEC_GRAPHICS[ch] !== undefined ? DEC_GRAPHICS[ch] : ch;
    if (this.wrapPending) {
      this.wrapPending = false;
      this.x = 0;
      this.lineFeed();
    }
    if (this.x + w > this.cols) {
      if (!this.autowrap) {
        // Autowrap off: the last cell is overwritten in place forever.
        this.x = this.cols - w;
        if (this.x < 0) return;
      } else {
        this.x = 0;
        this.lineFeed();
      }
    }
    const row = this.grid[this.y];
    row.chars[this.x] = glyph;
    row.fg[this.x] = this.fg;
    row.bg[this.x] = this.bg;
    row.at[this.x] = this.at;
    if (w === 2 && this.x + 1 < this.cols) {
      // The trailing half of a wide glyph holds an empty string, not a space:
      // the renderer skips it, and a copy of the line does not gain a stray
      // blank in the middle of a CJK word.
      row.chars[this.x + 1] = "";
      row.fg[this.x + 1] = this.fg;
      row.bg[this.x + 1] = this.bg;
      row.at[this.x + 1] = this.at;
    }
    this.x += w;
    if (this.x >= this.cols) {
      this.x = this.cols - 1;
      if (this.autowrap) this.wrapPending = true;
    }
  }

  reset(): void {
    this.grid = Array.from({ length: this.rows }, () => blankRow(this.cols));
    this.saved = null;
    this.altActive = false;
    this.x = 0;
    this.y = 0;
    this.fg = COLOR_DEFAULT;
    this.bg = COLOR_DEFAULT;
    this.at = 0;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.autowrap = true;
    this.wrapPending = false;
    this.cursorVisible = true;
    this.appCursorKeys = false;
    this.bracketedPaste = false;
    this.g0Graphics = false;
    this.parserState = "ground";
  }

  /** What the "Clear" button does: history gone, screen blank, cursor home. */
  clear(): void {
    this.scrollback.clear();
    for (const row of this.grid) for (let i = 0; i < this.cols; i++) this.blank(row, i);
    this.x = 0;
    this.y = 0;
    this.wrapPending = false;
  }
}

// ================================================================ gating

export type WriteOrigin = "user" | "model";

export type DenyReason =
  | "unknown-origin"
  | "unknown-session"
  | "session-not-live"
  | "control-bytes"
  | "gate-missing"
  | "gate-wrong-kind"
  | "gate-denied"
  | "gate-detail-mismatch";

export type WriteVerdict =
  | { allow: true; reason: "user-input" | "gate-approved" }
  | { allow: false; reason: DenyReason };

/** The outcome of the app's permission dialog, as agent.ts produces it. */
export interface GateOutcome {
  /** Must be exactly "shell". A `code` or `fs_read` approval buys nothing here. */
  kind: string;
  /** The text the user was shown. Must equal the command about to run. */
  detail: string;
  decision: string;
}

export interface WriteRequest {
  /** Deliberately `unknown`: the whole point is that a bad value is refused. */
  origin: unknown;
  session: { id: string; status: SessionStatus } | undefined;
  data: string;
  gate?: GateOutcome;
}

/**
 * The command text a model payload represents, which is what the permission
 * dialog must show and what the gate detail must match. Exactly one trailing
 * newline is allowed and stripped; anything else stays and will be rejected as
 * a control byte.
 */
export function modelCommandText(data: string): string {
  return data.endsWith("\r\n") ? data.slice(0, -2) : data.endsWith("\n") || data.endsWith("\r") ? data.slice(0, -1) : data;
}

/**
 * True when a payload is something a human could actually judge in a dialog.
 * Anything with an embedded control character is not: `\x03` is an interrupt,
 * `\x1b]52;c;...` rewrites the clipboard, and a dialog reading "run: ls" that
 * secretly also sends a Ctrl-C is a lie told by the permission system.
 */
export function isReviewableCommand(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || cp === 0x7f) return false;
  }
  return true;
}

/**
 * The one decision function. It is the ONLY thing allowed to say yes, it has
 * no default-allow branch, and every early return is a refusal.
 *
 * Order of checks, and why: origin first, because "who is asking" decides
 * which rules apply at all and an unrecognised answer can never be resolved
 * later; then the session, because writing into a dead pty is a bug whoever
 * asked; then, for a model only, the payload and its approval.
 */
export function decideTerminalWrite(req: WriteRequest): WriteVerdict {
  const origin = req.origin;
  if (origin !== "user" && origin !== "model") return { allow: false, reason: "unknown-origin" };
  if (!req.session) return { allow: false, reason: "unknown-session" };
  if (req.session.status !== "live") return { allow: false, reason: "session-not-live" };

  // A keystroke IS the authorization. See the security note at the top of this
  // file for why gating it would make the app less safe, not more.
  if (origin === "user") return { allow: true, reason: "user-input" };

  const command = modelCommandText(req.data);
  if (!isReviewableCommand(command)) return { allow: false, reason: "control-bytes" };
  const gate = req.gate;
  if (!gate) return { allow: false, reason: "gate-missing" };
  if (gate.kind !== "shell") return { allow: false, reason: "gate-wrong-kind" };
  if (gate.decision !== "once" && gate.decision !== "always") return { allow: false, reason: "gate-denied" };
  // The approval is bound to THIS text. Without this line, one approved `ls`
  // would be a standing licence to write anything into the session afterwards.
  if (gate.detail !== command) return { allow: false, reason: "gate-detail-mismatch" };
  return { allow: true, reason: "gate-approved" };
}

// ================================================================ registry

export type SessionStatus = "live" | "exited" | "disposed";

export interface TerminalSession {
  id: string;
  title: string;
  cwd: string;
  shell: string;
  /** Who opened it. A model session is still gated; this is for labelling. */
  owner: WriteOrigin;
  status: SessionStatus;
  exitCode: number | null;
  cols: number;
  rows: number;
  emu: TerminalEmulator;
  /** Lines the viewport is scrolled back by. 0 is following the output. */
  scrollOffset: number;
}

/**
 * The set of open sessions, keyed by the id the backend minted.
 *
 * Two lifecycle rules are load bearing and both are tested:
 *
 *   * An EXITED session is still in the registry. Its scrollback is the whole
 *     point of having run the command, and a build that fails must not erase
 *     its own error message by dying. Only `dispose` removes it.
 *   * A DISPOSED session is marked disposed on the object BEFORE it leaves the
 *     map. Anything still holding a reference (the active tab, an in flight
 *     write) therefore sees a non-live status and fails the gate, instead of
 *     writing into an id the backend has already reused.
 */
export class TerminalRegistry {
  private map = new Map<string, TerminalSession>();

  add(session: TerminalSession): void {
    // Refusing rather than replacing: a duplicate id means the backend or the
    // caller lost track, and silently dropping the old session would strand
    // its pty with nothing left holding its id.
    if (this.map.has(session.id)) throw new Error(`terminal session ${session.id} already exists`);
    this.map.set(session.id, session);
  }

  get(id: string): TerminalSession | undefined {
    return this.map.get(id);
  }

  /** Insertion order, which is the order the tabs are drawn in. */
  list(): TerminalSession[] {
    return [...this.map.values()];
  }

  get size(): number {
    return this.map.size;
  }

  get liveCount(): number {
    let n = 0;
    for (const s of this.map.values()) if (s.status === "live") n++;
    return n;
  }

  /**
   * Record the child's exit. Idempotent and one way: the FIRST exit code wins,
   * because a second "done" event (a duplicated event, a re-delivered one)
   * must not overwrite the real status with a later default.
   */
  markExited(id: string, code: number | null): boolean {
    const s = this.map.get(id);
    if (!s || s.status !== "live") return false;
    s.status = "exited";
    s.exitCode = code;
    return true;
  }

  dispose(id: string): boolean {
    const s = this.map.get(id);
    if (!s) return false;
    s.status = "disposed";
    this.map.delete(id);
    return true;
  }

  /** Close everything, returning the ids that were really removed. */
  disposeAll(): string[] {
    const ids = [...this.map.keys()];
    for (const id of ids) this.dispose(id);
    return ids;
  }
}

// ============================================================ key encoding

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

const FN_KEYS: Record<string, string> = {
  F1: "\x1bOP", F2: "\x1bOQ", F3: "\x1bOR", F4: "\x1bOS",
  F5: "\x1b[15~", F6: "\x1b[17~", F7: "\x1b[18~", F8: "\x1b[19~",
  F9: "\x1b[20~", F10: "\x1b[21~", F11: "\x1b[23~", F12: "\x1b[24~",
};

/**
 * A DOM keydown turned into the bytes a tty expects, or null when the app
 * should keep the key for itself.
 *
 * Cmd is ALWAYS null. On macOS Cmd belongs to the application: Cmd-C copies
 * the selection and Cmd-V pastes, and a terminal that swallowed them would
 * make the pane feel foreign in its own window. Ctrl is the terminal's
 * modifier and is forwarded in full, Ctrl-C included, which is exactly why the
 * child was given its own session in pty.rs.
 */
export function encodeKey(ev: KeyLike, appCursor: boolean): string | null {
  if (ev.metaKey) return null;
  const k = ev.key;
  const csi = (letter: string) => {
    // Modified cursor keys carry a parameter: 1;2 shift, 1;3 alt, 1;5 ctrl.
    const mod = 1 + (ev.shiftKey ? 1 : 0) + (ev.altKey ? 2 : 0) + (ev.ctrlKey ? 4 : 0);
    if (mod > 1) return `\x1b[1;${mod}${letter}`;
    return appCursor ? `\x1bO${letter}` : `\x1b[${letter}`;
  };
  switch (k) {
    case "Enter": return "\r";
    case "Backspace": return ev.altKey ? "\x1b\x7f" : "\x7f";
    case "Tab": return ev.shiftKey ? "\x1b[Z" : "\t";
    case "Escape": return "\x1b";
    case "ArrowUp": return csi("A");
    case "ArrowDown": return csi("B");
    case "ArrowRight": return csi("C");
    case "ArrowLeft": return csi("D");
    case "Home": return csi("H");
    case "End": return csi("F");
    case "PageUp": return "\x1b[5~";
    case "PageDown": return "\x1b[6~";
    case "Insert": return "\x1b[2~";
    case "Delete": return "\x1b[3~";
    default: break;
  }
  if (FN_KEYS[k] !== undefined) return FN_KEYS[k];
  if (ev.ctrlKey) {
    if (k === " " || k === "@") return "\x00";
    if (k === "[") return "\x1b";
    if (k === "\\") return "\x1c";
    if (k === "]") return "\x1d";
    if (k === "^") return "\x1e";
    if (k === "_" || k === "?") return "\x1f";
    if (k.length === 1) {
      const c = k.toUpperCase().charCodeAt(0);
      if (c >= 0x40 && c <= 0x5f) return String.fromCharCode(c - 0x40);
    }
    return null;
  }
  // Alt sends the key prefixed with ESC, which is how a shell reads Meta.
  if (ev.altKey && k.length === 1) return `\x1b${k}`;
  // Everything with a multi-character name that reached here (Shift, Dead,
  // F13 and up, media keys) is not text and must not be sent as one.
  if (k.length === 1) return k;
  return null;
}

/**
 * Wrap pasted text for bracketed paste mode when the child asked for it. The
 * wrapper is what lets a shell tell a paste from typing, so that pasting a
 * multi line script does not execute each line as it arrives.
 *
 * The paste is also stripped of its own bracket terminator: a payload
 * containing the literal end marker would otherwise close the bracket early
 * and the tail would execute as typed input. That is the known bracketed paste
 * escape and it costs one replace to close.
 */
export function encodePaste(text: string, bracketed: boolean): string {
  const clean = text.replace(/\x1b\[201~/g, "");
  return bracketed ? `\x1b[200~${clean}\x1b[201~` : clean;
}

// ================================================================ palette

/** The 16 ANSI colours, tuned to sit on this app's near-black surfaces. */
const BASE16 = [
  "#12121a", "#e06c75", "#7fc98a", "#d9b06a", "#7aa2f7", "#c397e8", "#5fc0c8", "#c4c4d2",
  "#5c5c6a", "#f28b82", "#98d7a4", "#e8c887", "#9dbdfa", "#d8b4f8", "#84d6dd", "#f0f0f6",
];

let PALETTE: string[] | null = null;

/** The xterm 256 colour table: 16 base, a 6x6x6 cube, then 24 greys. */
export function palette(): string[] {
  if (PALETTE) return PALETTE;
  const out = BASE16.slice();
  const steps = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) out.push(hex(steps[r], steps[g], steps[b]));
    }
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    out.push(hex(v, v, v));
  }
  PALETTE = out;
  return out;
}

function hex(r: number, g: number, b: number): string {
  const h = (v: number) => v.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** A cell colour turned into CSS, or null for "use the theme default". */
export function colorCss(value: number): string | null {
  if (value === COLOR_DEFAULT) return null;
  if (value >= COLOR_RGB_FLAG) {
    const v = value & 0xffffff;
    return hex((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  }
  const p = palette();
  return p[value] ?? null;
}

// ================================================================ rendering

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface RenderOptions {
  /** Column of the block cursor on this row, or -1. */
  cursorCol: number;
}

/**
 * One row as HTML, cells with identical styling merged into one span.
 *
 * Merging is not a micro-optimisation: a 200 column row of one span per cell
 * is 200 DOM nodes, and a full screen redraw at 30 lines is six thousand. A
 * coloured build log typically collapses to a handful of runs.
 */
export function rowHtml(row: Row, cols: number, opts: RenderOptions): string {
  let out = "";
  let runStart = 0;
  const key = (i: number): string => {
    // The cursor cell always breaks the run: it carries its own class.
    if (i === opts.cursorCol) return "cursor";
    return `${row.fg[i] ?? COLOR_DEFAULT}|${row.bg[i] ?? COLOR_DEFAULT}|${row.at[i] ?? 0}`;
  };
  const flush = (from: number, to: number) => {
    if (to <= from) return;
    let text = "";
    for (let i = from; i < to; i++) text += row.chars[i] ?? " ";
    // An empty run is normally the trailing half of a wide glyph, which holds
    // the empty string and must render as nothing at all. The cursor cell is
    // the exception: it always forms a run of its own, and a cursor parked on
    // the second cell of a CJK character or an emoji would otherwise vanish
    // entirely, with nothing on screen to say where typing will land.
    if (text === "" && from !== opts.cursorCol) return;
    const fg = row.fg[from] ?? COLOR_DEFAULT;
    const bg = row.bg[from] ?? COLOR_DEFAULT;
    const at = row.at[from] ?? 0;
    const isCursor = from === opts.cursorCol;
    const styles: string[] = [];
    // Inverse swaps the two colours here rather than in CSS, because a swap
    // that also has to work when one side is the theme default cannot be
    // expressed as a class.
    let fgCss = colorCss(fg);
    let bgCss = colorCss(bg);
    if (at & ATTR_INVERSE) {
      const a = fgCss;
      fgCss = bgCss ?? "var(--term-bg)";
      bgCss = a ?? "var(--term-fg)";
    }
    if (fgCss) styles.push(`color:${fgCss}`);
    if (bgCss) styles.push(`background:${bgCss}`);
    // Every class here is prefixed "t-": the app's stylesheet already owns
    // `.trow`, `.ts` and `.tx` for the outline and the git panel, and a bare
    // two-letter class inside the terminal would inherit their padding.
    const classes: string[] = [];
    if (at & ATTR_BOLD) classes.push("t-b");
    if (at & (ATTR_DIM | ATTR_BLINK)) classes.push("t-d");
    if (at & ATTR_ITALIC) classes.push("t-i");
    if (at & ATTR_UNDERLINE) classes.push("t-u");
    if (at & ATTR_STRIKE) classes.push("t-s");
    if (at & ATTR_HIDDEN) classes.push("t-h");
    if (isCursor) classes.push("t-cur");
    if (classes.length === 0 && styles.length === 0) {
      out += esc(text);
      return;
    }
    const cls = classes.length ? ` class="${classes.join(" ")}"` : "";
    const sty = styles.length ? ` style="${styles.join(";")}"` : "";
    out += `<span${cls}${sty}>${esc(text)}</span>`;
  };
  let current = cols > 0 ? key(0) : "";
  for (let i = 1; i < cols; i++) {
    const k = key(i);
    if (k !== current) {
      flush(runStart, i);
      runStart = i;
      current = k;
    }
  }
  flush(runStart, cols);
  return out;
}

/** The whole visible screen. One `<div>` per row so line heights stay exact. */
export function screenHtml(session: TerminalSession): string {
  const emu = session.emu;
  const rows = emu.viewport(session.scrollOffset);
  const showCursor = session.status === "live" && emu.cursorVisible && session.scrollOffset === 0;
  const st = emu.snapshot();
  const lines: string[] = [];
  for (let y = 0; y < rows.length; y++) {
    const cursorCol = showCursor && y === st.cursorY ? st.cursorX : -1;
    lines.push(`<div class="t-line">${rowHtml(rows[y], emu.cols, { cursorCol }) || " "}</div>`);
  }
  return lines.join("");
}

// ================================================================ host

export interface SpawnResult {
  id: string;
  cols: number;
  rows: number;
  shell: string;
  cwd: string;
}

export interface PtyOutputEvent {
  id: string;
  data: string;
  done: boolean;
  exit_code: number | null;
}

/**
 * Everything this module needs from the outside world. The app binds it to the
 * Tauri commands in pty.rs; the tests bind it to a fake. No import of
 * `@tauri-apps/api` appears in this file, which is what makes that possible.
 */
export interface TerminalHost {
  spawn(req: { cwd: string; cols: number; rows: number; owner: WriteOrigin }): Promise<SpawnResult>;
  /**
   * Open a session on a saved remote machine.
   *
   * Optional so a test harness need not provide it, and so a build without the
   * feature degrades to a local terminal rather than to a crash. The id names a
   * machine the BACKEND holds: no address, no command and no credential crosses
   * this boundary.
   */
  sshSpawn?(req: { id: string; cwd: string; cols: number; rows: number }): Promise<SpawnResult>;
  write(req: { id: string; data: string; origin: WriteOrigin; gated: boolean }): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<[number, number]>;
  kill(id: string): Promise<void>;
  /** Subscribe to output. Returns the unsubscribe function. */
  onOutput(cb: (ev: PtyOutputEvent) => void): () => void;
  /**
   * Raise the app's `shell` permission dialog for `detail` and resolve with
   * the user's decision. Supplied by the app because the dialog belongs to the
   * agent pane, not to this module.
   */
  requestShellPermission(detail: string): Promise<string>;
}

// ================================================================ controller

/** Scrollback lines per session. Roughly a full `cargo build` of a large crate. */
export const SCROLLBACK_LINES = 5000;

export interface TerminalControllerDeps {
  host: TerminalHost;
  /** Workspace root. Sessions start here; null means no workspace is open. */
  root(): string | null;
  /** Ask the view to repaint. Called on output, so it must be cheap or throttled. */
  repaint(): void;
  toast?(message: string): void;
  /**
   * The last session just closed, by the user or by its own exit.
   *
   * A pane holding no terminal has nothing to show and nothing to do: it sat
   * there taking a third of the editor to say "no terminal open", which is a
   * sentence about itself rather than about the work. Closing the last tab is
   * how a person says they are done with the terminal, so the pane goes with it.
   */
  onEmpty?(): void;
}

/**
 * Session bookkeeping, sitting between the view and the host: it owns the
 * registry, routes output events to the right emulator, and is the only place
 * that calls `decideTerminalWrite`.
 *
 * Separated from the DOM so the interesting behaviour (a write refused, an
 * exit recorded, a resize clamped) can be driven by a test without a document.
 */
export class TerminalController {
  readonly sessions = new TerminalRegistry();
  private unlisten: (() => void) | null = null;
  private deps: TerminalControllerDeps;
  activeId: string | null = null;

  constructor(deps: TerminalControllerDeps) {
    this.deps = deps;
    this.unlisten = deps.host.onOutput((ev) => this.onOutput(ev));
  }

  private onOutput(ev: PtyOutputEvent): void {
    const s = this.sessions.get(ev.id);
    // An event for an id we do not know is not an error: the session may have
    // been disposed while the last chunk was already in flight.
    if (!s) return;
    if (ev.data) {
      // A user who scrolled up is READING. Output arriving underneath must not
      // drag the text out from under them, so the offset grows by however many
      // lines the write pushed into the history and the same content stays on
      // screen. Leaving the offset alone looks like the log scrolling itself,
      // which is the behaviour people complain about in every log viewer.
      const before = s.emu.scrollback.pushed;
      s.emu.write(ev.data);
      if (s.scrollOffset > 0) {
        const added = s.emu.scrollback.pushed - before;
        s.scrollOffset = Math.min(s.scrollOffset + added, s.emu.scrollback.length);
      }
      if (s.emu.title) s.title = s.emu.title;
    }
    if (ev.done) this.sessions.markExited(ev.id, ev.exit_code);
    this.deps.repaint();
  }

  async open(owner: WriteOrigin, cols: number, rows: number): Promise<TerminalSession | null> {
    return this.openWith(owner, cols, rows, null);
  }

  /**
   * A session on a saved remote machine.
   *
   * Always owned by "user": a remote shell is never handed to the model. The
   * gate that asks before a model writes into a terminal stays exactly as it
   * was, and this adds no way around it.
   */
  async openRemote(id: string, cols: number, rows: number): Promise<TerminalSession | null> {
    if (!this.deps.host.sshSpawn) {
      this.deps.toast?.(t("ssh.unavailable"));
      return null;
    }
    return this.openWith("user", cols, rows, id);
  }

  private async openWith(
    owner: WriteOrigin,
    cols: number,
    rows: number,
    remoteId: string | null,
  ): Promise<TerminalSession | null> {
    const root = this.deps.root();
    if (!root) {
      this.deps.toast?.(t("term.noWorkspace"));
      return null;
    }
    const size = clampTerminalSize(cols, rows);
    let res: SpawnResult;
    try {
      res =
        remoteId !== null && this.deps.host.sshSpawn
          ? await this.deps.host.sshSpawn({ id: remoteId, cwd: root, cols: size.cols, rows: size.rows })
          : await this.deps.host.spawn({ cwd: root, cols: size.cols, rows: size.rows, owner });
    } catch (e) {
      this.deps.toast?.(String(e));
      return null;
    }
    const session: TerminalSession = {
      id: res.id,
      title: shellName(res.shell),
      cwd: res.cwd,
      shell: res.shell,
      owner,
      status: "live",
      exitCode: null,
      cols: res.cols,
      rows: res.rows,
      emu: new TerminalEmulator({ cols: res.cols, rows: res.rows, scrollback: SCROLLBACK_LINES }),
      scrollOffset: 0,
    };
    this.sessions.add(session);
    this.activeId = session.id;
    this.deps.repaint();
    return session;
  }

  /**
   * Send user keystrokes. Not gated, by design: see the security note at the
   * top of the file.
   */
  async sendUser(id: string, data: string): Promise<WriteVerdict> {
    const session = this.sessions.get(id);
    const verdict = decideTerminalWrite({ origin: "user", session, data });
    if (!verdict.allow) return verdict;
    await this.deps.host.write({ id, data, origin: "user", gated: false });
    return verdict;
  }

  /**
   * Send a command on the model's behalf. ALWAYS raises the `shell` gate, with
   * the exact command as the detail, and refuses on anything short of an
   * explicit approval for that exact text.
   *
   * The dialog is raised BEFORE the verdict is computed on purpose, so that
   * `decideTerminalWrite` is the single arbiter and this method cannot become
   * a second, weaker one.
   */
  async sendFromModel(id: string, command: string): Promise<WriteVerdict> {
    const session = this.sessions.get(id);
    // A payload the user could not judge never reaches a dialog at all: see
    // `isReviewableCommand`.
    if (!isReviewableCommand(command)) {
      const early = decideTerminalWrite({ origin: "model", session, data: command });
      return early.allow ? { allow: false, reason: "control-bytes" } : early;
    }
    if (!session || session.status !== "live") {
      return decideTerminalWrite({ origin: "model", session, data: command });
    }
    let decision: string;
    try {
      decision = await this.deps.host.requestShellPermission(command);
    } catch {
      // A dialog that threw is not an approval. Fail closed.
      decision = "deny";
    }
    // Re-read the session: the dialog was open for as long as the user took,
    // and the child may have exited in the meantime.
    const now = this.sessions.get(id);
    const verdict = decideTerminalWrite({
      origin: "model",
      session: now,
      data: `${command}\n`,
      gate: { kind: "shell", detail: command, decision },
    });
    if (!verdict.allow) return verdict;
    await this.deps.host.write({ id, data: `${command}\n`, origin: "model", gated: true });
    return verdict;
  }

  async resize(id: string, cols: number, rows: number): Promise<GridSize | null> {
    const s = this.sessions.get(id);
    if (!s || s.status !== "live") return null;
    const size = s.emu.resize(cols, rows);
    s.cols = size.cols;
    s.rows = size.rows;
    try {
      const [c, r] = await this.deps.host.resize(id, size.cols, size.rows);
      // Trust the backend's answer over our own: it is the one that clamped
      // against the real pty and the child sized itself to that.
      if (c !== size.cols || r !== size.rows) {
        s.emu.resize(c, r);
        s.cols = c;
        s.rows = r;
      }
      return { cols: s.cols, rows: s.rows };
    } catch {
      return size;
    }
  }

  /** Kill the child if it is still running, then forget the session. */
  async close(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.dispose(id);
    if (this.activeId === id) {
      const rest = this.sessions.list();
      this.activeId = rest.length ? rest[rest.length - 1].id : null;
    }
    try {
      await this.deps.host.kill(id);
    } catch {
      // The child may already be gone; killing it twice is not an error.
    }
    this.deps.repaint();
    // After the repaint, so a view that closes the pane does so over a tree that
    // already reflects the session being gone.
    if (!this.sessions.list().length) this.deps.onEmpty?.();
  }

  /**
   * Tear everything down. Called when the Code view unmounts and when the
   * window goes: the backend also kills its own sessions on app exit, and both
   * halves are needed because a view can close without the app closing.
   */
  disposeAll(): void {
    const ids = this.sessions.disposeAll();
    for (const id of ids) void this.deps.host.kill(id).catch(() => undefined);
    this.activeId = null;
    this.unlisten?.();
    this.unlisten = null;
  }
}

/** `/bin/zsh` becomes `zsh`. The tab label, not a path display. */
export function shellName(path: string): string {
  const base = path.split("/").filter(Boolean).pop();
  return base && base.length ? base : "shell";
}

/**
 * Substitute into a translated string, appending when the placeholder is gone.
 *
 * A translation that lost its `%s`, or a key with no entry in the dictionary
 * yet, must not swallow the value: the exit code is the only part of "exited
 * (%s)" that carries information, and a sentence that silently drops it is
 * worse than an ugly one that keeps it.
 */
function fill(key: string, value: string): string {
  const s = t(key);
  return s.includes("%s") ? s.replace("%s", value) : `${s} ${value}`;
}

/** A one line status for a session tab, already translated. */
export function sessionLabel(s: TerminalSession): string {
  if (s.status === "live") return s.title;
  if (s.exitCode === null) return `${s.title} ${t("term.killed")}`;
  return `${s.title} ${fill("term.exited", String(s.exitCode))}`;
}

// ================================================================ view

/** Everything the DOM layer needs, so the panel can be built by the app. */
export interface TerminalViewDeps extends TerminalControllerDeps {
  /** Measured cell box in CSS pixels. The app measures it once per font load. */
  cell(): { width: number; height: number };
  /**
   * Ask the app to show the saved machines and start a session on one.
   *
   * Owned by the view above rather than here: the list lives in settings and
   * the dialog belongs to the app's own modal shell, and a terminal that grew
   * its own settings UI would be a second place to maintain them.
   */
  chooseRemote?(): void;
}

function elt(html: string): HTMLElement {
  const d = document.createElement("div");
  d.innerHTML = html.trim();
  return d.firstElementChild as HTMLElement;
}

/**
 * The terminal pane: a tab strip, a screen, and the event wiring.
 *
 * Kept deliberately thin. Everything that can be decided without a document
 * lives above this line and is unit tested; what is left here is DOM plumbing,
 * which tests cannot honestly cover and which is therefore written to contain
 * as little judgement as possible.
 */
export class TerminalPanel {
  readonly controller: TerminalController;
  private deps: TerminalViewDeps;
  private root: HTMLElement;
  private screenEl: HTMLElement | null = null;
  private repaintQueued = false;
  private resizeObserver: ResizeObserver | null = null;

  constructor(deps: TerminalViewDeps) {
    this.deps = deps;
    this.controller = new TerminalController({
      host: deps.host,
      root: deps.root,
      repaint: () => this.queueRepaint(),
      toast: deps.toast,
      onEmpty: () => deps.onEmpty?.(),
    });
    this.root = elt(`<div class="term" tabindex="0">
      <div class="term-tabs" role="tablist"></div>
      <div class="term-screen" role="log" aria-live="off"></div>
    </div>`);
    this.root.setAttribute("aria-label", t("term.title"));
    this.wire();
  }

  element(): HTMLElement {
    return this.root;
  }

  private wire(): void {
    this.screenEl = this.root.querySelector(".term-screen");
    this.root.querySelector(".term-tabs")!.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const close = target.closest("[data-tclose]") as HTMLElement | null;
      if (close) {
        e.stopPropagation();
        void this.controller.close(close.dataset.tclose!);
        return;
      }
      const tab = target.closest("[data-tsel]") as HTMLElement | null;
      if (tab) {
        this.controller.activeId = tab.dataset.tsel!;
        this.queueRepaint();
        this.root.focus();
        return;
      }
      if (target.closest("[data-tnew]")) void this.openSession();
      else if (target.closest("[data-tssh]")) void this.deps.chooseRemote?.();
      else if (target.closest("[data-tclear]")) {
        const s = this.active();
        if (s) {
          s.emu.clear();
          s.scrollOffset = 0;
          this.queueRepaint();
        }
      }
    });

    this.root.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.root.addEventListener("paste", (e) => this.onPaste(e));
    this.root.addEventListener("wheel", (e) => this.onWheel(e), { passive: true });

    // A pane resize changes the column count, which the child must be told
    // about or every wrapped line lands in the wrong place.
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.fit());
      this.resizeObserver.observe(this.root);
    }
  }

  private active(): TerminalSession | null {
    const id = this.controller.activeId;
    return id ? this.controller.sessions.get(id) ?? null : null;
  }

  /** Open a session sized to the pane as it is right now. */
  async openSession(): Promise<void> {
    const size = this.measure();
    await this.controller.open("user", size.cols, size.rows);
    this.root.focus();
  }

  /** Open a session on a saved machine, as another tab in this same pane. */
  async openRemote(id: string): Promise<void> {
    const size = this.measure();
    await this.controller.openRemote(id, size.cols, size.rows);
    this.root.focus();
  }

  private measure(): GridSize {
    const cell = this.deps.cell();
    const box = this.screenEl?.getBoundingClientRect();
    return gridSizeFor(box?.width ?? 0, box?.height ?? 0, cell.width, cell.height);
  }

  /**
   * Give every LIVE session the pane's current geometry, not only the visible
   * one.
   *
   * Only resizing the active tab looks harmless and is not: nothing else ever
   * calls resize(), and selecting a tab does not fit it, so a background pty
   * keeps the geometry it was spawned with forever. Drag the window from 80 to
   * 200 columns, switch tabs, and that shell wraps every line at column 80
   * inside a 200 column box while vim draws an 80x24 frame in the middle of
   * the pane, with no path back short of closing the tab. The resize is one
   * ioctl and one SIGWINCH per session, and there are at most MAX_SESSIONS.
   */
  fit(): void {
    const size = this.measure();
    for (const s of this.controller.sessions.list()) {
      if (s.status !== "live") continue;
      if (size.cols === s.cols && size.rows === s.rows) continue;
      void this.controller.resize(s.id, size.cols, size.rows);
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    const s = this.active();
    if (!s) return;
    // Shift-PageUp / Shift-PageDown scroll the view instead of reaching the
    // child, matching every terminal emulator on the platform.
    if (e.shiftKey && (e.key === "PageUp" || e.key === "PageDown")) {
      e.preventDefault();
      const delta = e.key === "PageUp" ? s.rows : -s.rows;
      s.scrollOffset = Math.max(0, Math.min(s.scrollOffset + delta, s.emu.scrollback.length));
      this.queueRepaint();
      return;
    }
    const bytes = encodeKey(e, s.emu.appCursorKeys);
    if (bytes === null) return; // Cmd shortcuts and non-text keys stay with the app
    e.preventDefault();
    s.scrollOffset = 0;
    void this.controller.sendUser(s.id, bytes);
  }

  private onPaste(e: ClipboardEvent): void {
    const s = this.active();
    if (!s) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    e.preventDefault();
    s.scrollOffset = 0;
    void this.controller.sendUser(s.id, encodePaste(text, s.emu.bracketedPaste));
  }

  private onWheel(e: WheelEvent): void {
    const s = this.active();
    if (!s) return;
    const cell = this.deps.cell();
    const lines = Math.round(e.deltaY / Math.max(1, cell.height));
    if (lines === 0) return;
    const next = Math.max(0, Math.min(s.scrollOffset - lines, s.emu.scrollback.length));
    if (next === s.scrollOffset) return;
    s.scrollOffset = next;
    this.queueRepaint();
  }

  /**
   * Repaint at most once per frame. A `cargo build` produces output far faster
   * than the screen refreshes, and painting per event turns the pane into the
   * slowest part of the app.
   */
  private queueRepaint(): void {
    if (this.repaintQueued) return;
    this.repaintQueued = true;
    const run = () => {
      this.repaintQueued = false;
      this.paint();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  paint(): void {
    const tabs = this.root.querySelector(".term-tabs");
    if (tabs) tabs.innerHTML = this.tabsHtml();
    const screen = this.screenEl;
    if (!screen) return;
    const s = this.active();
    if (!s) {
      screen.innerHTML = `<div class="term-empty">${esc(t("term.empty"))}</div>`;
      return;
    }
    screen.innerHTML = screenHtml(s);
  }

  private tabsHtml(): string {
    const list = this.controller.sessions.list();
    const tabs = list
      .map((s) => {
        const on = s.id === this.controller.activeId ? " on" : "";
        const dead = s.status === "live" ? "" : " dead";
        return `<button class="term-tab${on}${dead}" data-tsel="${esc(s.id)}" role="tab">
          <span>${esc(sessionLabel(s))}</span>
          <span class="t-x" data-tclose="${esc(s.id)}" aria-label="${esc(t("term.close"))}">×</span>
        </button>`;
      })
      .join("");
    return `${tabs}<button class="term-act" data-tnew title="${esc(t("term.new"))}">+</button>
      <button class="term-act" data-tssh title="${esc(t("ssh.title"))}">⇄</button>
      <button class="term-act" data-tclear title="${esc(t("term.clear"))}">⊘</button>`;
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.controller.disposeAll();
  }
}
