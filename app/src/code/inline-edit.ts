// Galactus, Code view: inline edit at the cursor.
//
// The gesture: put the caret in some code, or select a region, press Cmd+K, a
// small box opens anchored on the region, you describe the change in one
// sentence, and the rewritten region comes back as a PENDING diff. Nothing is
// written to disk here. This module never touches the filesystem and never
// dispatches the replacement into the editor either: it hands the whole new
// document to the host through `propose`, which is what turns it into a
// proposal the user accepts hunk by hunk in the merge view.
//
// The module deliberately imports nothing from app/src/code.ts and nothing
// from app/src/api.ts. Everything it needs (ask the model, file a proposal,
// translate a string, tell me the current file) arrives as an options object,
// exactly like auto-tab.ts. That is not architectural taste: it is the only
// reason the interesting half of this file can be unit tested at all, since
// code.ts drags in the whole Tauri bridge and cannot be loaded under
// `node --test`.
//
// The four pure functions below are the interesting half:
//
//   expandEditRange()        where does the edit apply when nothing is selected
//   buildInlineEditRequest() what exactly is sent, and what is refused as too big
//   normalizeInlineEdit()    turn a chatty answer into code, or into null
//   applyInlineEdit()        the new document text, or null when it is a no-op
//
// Every one of them returns null rather than a best effort guess. A wrong
// guess here does not produce a bad suggestion, it produces a corrupted file
// in a diff the user is being invited to accept.

import {
  Facet,
  Prec,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import {
  keymap,
  showTooltip,
  type Command,
  type EditorView,
  type Tooltip,
  type TooltipView,
} from "@codemirror/view";

// ---------------------------------------------------------------- budget

/**
 * Bytes per token. Mirrors BYTES_PER_TOKEN in app/src/agent.ts and is
 * duplicated on purpose: importing agent.ts would drag api.ts, the chat loop
 * and the Tauri bridge into a module whose whole point is to be loadable
 * without them.
 *
 * 3.0 and not the usual 4.0 for the same reason agent.ts uses 3.0: the 4.0
 * figure is roughly 25 percent optimistic on the text this app actually sends
 * (French prose, dense source code, identifiers the tokenizer splits), and the
 * densest record measured came out at 1.99. A budget built on 4.0 is exactly
 * how a request the caller believed fitted comes back as a 400 from the
 * server. If agent.ts ever remeasures, this constant moves with it.
 */
export const BYTES_PER_TOKEN = 3.0;

/**
 * Token budget for the whole inline edit payload. Small on purpose: an inline
 * edit is a local rewrite, it competes with nothing else in the context, and
 * a model that has to read 8k tokens before writing three lines is a model
 * that answers in twelve seconds instead of two.
 */
export const INLINE_EDIT_TOKEN_BUDGET = 2400;

/** The hard character budget derived from it. Nothing sent may exceed this. */
export const INLINE_EDIT_CHAR_BUDGET = Math.floor(INLINE_EDIT_TOKEN_BUDGET * BYTES_PER_TOKEN);

/**
 * The region being rewritten may take at most this share of the budget. Past
 * it the request is refused outright instead of trimmed, because trimming the
 * REGION means asking the model to rewrite code it was never shown, and the
 * answer would then be spliced over the part it never saw.
 */
export const SELECTION_CHAR_LIMIT = Math.floor(INLINE_EDIT_CHAR_BUDGET * 0.6);

/** Context lines offered on each side before the budget starts cutting. */
export const CONTEXT_LINES = 24;

/** The user's sentence. Truncating this is safe: it is prose, not code. */
export const MAX_INSTRUCTION_CHARS = 600;

/** A blank line expands to a block, but never to a whole file. */
export const MAX_BLOCK_LINES = 60;

// ---------------------------------------------------------------- lines

/**
 * Offsets where each line starts. Built once per call rather than kept in a
 * structure, because every entry point here is a one shot pure function and a
 * cached index that can go stale next to a live CodeMirror document is a bug
 * waiting for a race.
 */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineIndexAt(starts: number[], pos: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * End offset of line `i`, excluding the newline AND excluding the carriage
 * return of a CRLF file. Including the \r would make the replaced region end
 * with a stray \r that the model's answer does not carry, so the rewritten
 * line would silently switch line ending in the middle of a CRLF file.
 */
function lineEndOffset(text: string, starts: number[], i: number): number {
  const end = i + 1 < starts.length ? starts[i + 1] - 1 : text.length;
  return end > starts[i] && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
}

function lineTextAt(text: string, starts: number[], i: number): string {
  return text.slice(starts[i], lineEndOffset(text, starts, i));
}

/**
 * Indentation width of a line, tabs counted as 4. The exact tab width does not
 * matter, only that one tab always compares as deeper than one space, which is
 * what a mixed file needs to stay classifiable.
 */
function indentWidth(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === " ") width += 1;
    else if (ch === "\t") width += 4;
    else break;
  }
  return width;
}

/** Leading whitespace of a line, verbatim, tabs and spaces as written. */
export function leadingWhitespace(line: string): string {
  const match = line.match(/^[ \t]*/);
  return match ? match[0] : "";
}

// ---------------------------------------------------------------- range

export interface EditRange {
  /** Character offset where the replacement starts. */
  from: number;
  /** Character offset where the replacement ends, newline excluded. */
  to: number;
  /** 1-based first line of the region. */
  startLine: number;
  /** 1-based last line of the region, inclusive. */
  endLine: number;
}

/**
 * Turn whatever the user's selection happens to be into a region worth
 * rewriting.
 *
 * Three cases, in the order they are hit in practice:
 *
 *   - a real selection: snapped OUT to whole lines. A half line region makes
 *     the model complete a fragment and makes the merge view show a hunk that
 *     starts mid token, which is unreadable. Snapping costs nothing because
 *     the rest of the line is shown to the model anyway.
 *   - a bare caret on a line with content: that line.
 *   - a bare caret on a blank line: the enclosing indented block, because a
 *     blank line on its own says nothing and "write the loop here" needs the
 *     body it belongs to. The block is found by indentation: the reference
 *     indent is the DEEPER of the nearest non blank neighbour above and below,
 *     so a blank line between the end of a function body and the next top
 *     level statement belongs to the body it trails, not to the file.
 *
 * The one case where the blank line does NOT expand is a reference indent of
 * zero, that is a blank line between two top level items. Expanding there
 * would swallow the file, so the region stays the run of blank lines: an
 * insertion point, which is exactly what it looks like on screen.
 */
export function expandEditRange(doc: string, from: number, to: number): EditRange {
  const starts = lineStarts(doc);
  const lo = Math.min(Math.max(Math.round(from), 0), doc.length);
  const hi = Math.min(Math.max(Math.round(to), 0), doc.length);
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);

  if (a !== b) {
    const first = lineIndexAt(starts, a);
    let last = lineIndexAt(starts, b);
    // A selection dragged over full lines ends ON the next line's first
    // character. That line was never selected, and including it would make
    // every line selection one line too greedy.
    if (last > first && b === starts[last]) last--;
    return {
      from: starts[first],
      to: lineEndOffset(doc, starts, last),
      startLine: first + 1,
      endLine: last + 1,
    };
  }

  const caret = lineIndexAt(starts, a);
  if (lineTextAt(doc, starts, caret).trim() !== "") {
    return {
      from: starts[caret],
      to: lineEndOffset(doc, starts, caret),
      startLine: caret + 1,
      endLine: caret + 1,
    };
  }

  const block = blankLineBlock(doc, starts, caret);
  return {
    from: starts[block.first],
    to: lineEndOffset(doc, starts, block.last),
    startLine: block.first + 1,
    endLine: block.last + 1,
  };
}

function blankLineBlock(
  doc: string,
  starts: number[],
  caret: number
): { first: number; last: number } {
  const count = starts.length;
  const blank = (i: number): boolean => lineTextAt(doc, starts, i).trim() === "";

  let above = caret - 1;
  while (above >= 0 && blank(above)) above--;
  let below = caret + 1;
  while (below < count && blank(below)) below++;

  const indentAbove = above >= 0 ? indentWidth(lineTextAt(doc, starts, above)) : -1;
  const indentBelow = below < count ? indentWidth(lineTextAt(doc, starts, below)) : -1;
  const reference = Math.max(indentAbove, indentBelow);

  // No content anywhere, or content sitting at column zero: there is no block
  // to speak of, only a gap. Return the run of blank lines around the caret.
  if (reference <= 0) {
    let first = caret;
    while (first > 0 && blank(first - 1)) first--;
    let last = caret;
    while (last + 1 < count && blank(last + 1)) last++;
    return { first, last };
  }

  let first = caret;
  while (first > 0) {
    const line = lineTextAt(doc, starts, first - 1);
    if (line.trim() !== "" && indentWidth(line) < reference) break;
    first--;
  }
  let last = caret;
  while (last + 1 < count) {
    const line = lineTextAt(doc, starts, last + 1);
    if (line.trim() !== "" && indentWidth(line) < reference) break;
    last++;
  }
  // The sweep above stops on the first shallower line, so both ends may be
  // padding. Trim them back to real content, otherwise the region starts with
  // blank lines the model would have to reproduce exactly.
  while (first < last && blank(first)) first++;
  while (last > first && blank(last)) last--;
  if (blank(first) && blank(last)) return { first: caret, last: caret };

  if (last - first + 1 > MAX_BLOCK_LINES) {
    first = Math.max(first, caret - (MAX_BLOCK_LINES >> 1));
    last = Math.min(last, first + MAX_BLOCK_LINES - 1);
  }
  return { first, last };
}

// ---------------------------------------------------------------- language

/**
 * The language name put in the prompt. This is NOT `langIdFor()` from
 * outline.ts and must not be replaced by it: that table lists the grammars the
 * editor loads, and it returns null for Go, Java or shell. The model can edit
 * a Go file perfectly well even though the editor has no Go grammar, so the
 * prompt needs a name for it. Falling back to the bare extension keeps that
 * true for anything not listed.
 */
export function languageIdFor(rel: string): string {
  const dot = rel.lastIndexOf(".");
  const ext = dot > rel.lastIndexOf("/") ? rel.slice(dot + 1).toLowerCase() : "";
  switch (ext) {
    case "js": case "mjs": case "cjs": return "javascript";
    case "jsx": return "jsx";
    case "ts": case "mts": case "cts": return "typescript";
    case "tsx": return "tsx";
    case "py": case "pyi": return "python";
    case "rs": return "rust";
    case "go": return "go";
    case "java": return "java";
    case "kt": case "kts": return "kotlin";
    case "swift": return "swift";
    case "rb": return "ruby";
    case "php": return "php";
    case "c": case "h": return "c";
    case "cc": case "cpp": case "cxx": case "hpp": case "hh": return "c++";
    case "m": case "mm": return "objective-c";
    case "sh": case "bash": case "zsh": return "shell";
    case "sql": return "sql";
    case "json": return "json";
    case "toml": return "toml";
    case "yml": case "yaml": return "yaml";
    case "html": case "htm": return "html";
    case "svg": case "xml": return "xml";
    case "css": return "css";
    case "scss": case "sass": return "scss";
    case "md": case "markdown": return "markdown";
    case "txt": case "": return "text";
    default: return ext;
  }
}

/**
 * Languages whose legitimate content reads like prose. The prose refusal in
 * `normalizeInlineEdit` would reject a perfectly good paragraph in a README,
 * so it is switched off for these.
 */
export function isProseLanguage(language: string): boolean {
  return language === "markdown" || language === "text";
}

// ---------------------------------------------------------------- request

export interface InlineEditInput {
  /** Full text of the document as the user sees it right now. */
  doc: string;
  /**
   * The region to rewrite, normally from `expandEditRange`.
   *
   * When it carries `startLine`/`endLine` those are used verbatim rather than
   * recomputed from the offsets. They disagree for an empty region: a run of
   * blank lines has `to` sitting at the start of its last line, so deriving
   * the span from the offsets loses that line, and the box would then announce
   * one span to the user while the prompt announced another to the model.
   */
  range: { from: number; to: number; startLine?: number; endLine?: number };
  /** Workspace relative path, used in the prompt and to pick the language. */
  rel: string;
  /** What the user typed in the box. */
  instruction: string;
  /** Override the detected language. Only tests and callers with a real LSP. */
  language?: string;
}

export interface InlineEditRequest {
  path: string;
  language: string;
  /** Trimmed and length capped version of what the user typed. */
  instruction: string;
  /** The region, verbatim. Never truncated: it is what gets replaced. */
  selection: string;
  /** Lines above the region, already inside the budget. */
  before: string;
  /** Lines below the region, already inside the budget. */
  after: string;
  /** 1-based inclusive line span of the region. */
  startLine: number;
  endLine: number;
  /** True when context lines had to be dropped to fit the budget. */
  trimmed: boolean;
  /** The complete prompt, ready to hand to the model. */
  prompt: string;
}

/**
 * Build the request, or refuse. Refusal (null) happens when the region alone
 * blows `SELECTION_CHAR_LIMIT`, or when the instruction is empty. Both are
 * user visible states in the box, not silent failures.
 *
 * Context is cut from the outside in, dropping whole lines and always from the
 * heavier side first, so a region near the top of a file keeps its lines below
 * instead of losing them to a padding of imports it does not need.
 */
export function buildInlineEditRequest(input: InlineEditInput): InlineEditRequest | null {
  const instruction = input.instruction.trim().slice(0, MAX_INSTRUCTION_CHARS);
  if (!instruction) return null;

  const doc = input.doc;
  const from = Math.min(Math.max(Math.round(input.range.from), 0), doc.length);
  const to = Math.min(Math.max(Math.round(input.range.to), from), doc.length);
  const selection = doc.slice(from, to);
  if (selection.length > SELECTION_CHAR_LIMIT) return null;

  const starts = lineStarts(doc);
  const firstLine = lineIndexAt(starts, from);
  const lastLine = to > from ? lineIndexAt(starts, Math.max(from, to - 1)) : firstLine;

  const beforeLines: string[] = [];
  for (let i = Math.max(0, firstLine - CONTEXT_LINES); i < firstLine; i++) {
    beforeLines.push(lineTextAt(doc, starts, i));
  }
  const afterLines: string[] = [];
  for (let i = lastLine + 1; i < starts.length && i <= lastLine + CONTEXT_LINES; i++) {
    afterLines.push(lineTextAt(doc, starts, i));
  }

  const language = input.language ?? languageIdFor(input.rel);
  const request: InlineEditRequest = {
    path: input.rel,
    language,
    instruction,
    selection,
    before: beforeLines.join("\n"),
    after: afterLines.join("\n"),
    startLine: input.range.startLine ?? firstLine + 1,
    endLine: input.range.endLine ?? lastLine + 1,
    trimmed: false,
    prompt: "",
  };

  // The budget is checked against the RENDERED prompt, not against the sum of
  // its pieces. The first version measured selection + instruction + context
  // and ignored the preamble and the section labels, so the string actually
  // sent was over budget on every non-trivial request while the code reported
  // that it fitted. Rendering and measuring is a handful of extra string joins
  // for at most 48 iterations, and it makes the constant mean what its comment
  // says it means.
  //
  // The one thing never cut is the region itself: it is refused above when it
  // is too big, because trimming it would splice an answer over code the model
  // was never shown. When the region plus the instruction plus the preamble
  // alone exceed the budget, the loop runs out of context to drop and returns
  // an oversize prompt on purpose, since the alternative is refusing an edit
  // the user can legitimately ask for.
  const size = (lines: string[]): number => (lines.length ? lines.join("\n").length : 0);
  request.prompt = renderInlineEditPrompt(request);
  while (
    request.prompt.length > INLINE_EDIT_CHAR_BUDGET &&
    (beforeLines.length || afterLines.length)
  ) {
    if (beforeLines.length && size(beforeLines) >= size(afterLines)) beforeLines.shift();
    else if (afterLines.length) afterLines.pop();
    else beforeLines.shift();
    request.trimmed = true;
    request.before = beforeLines.join("\n");
    request.after = afterLines.join("\n");
    request.prompt = renderInlineEditPrompt(request);
  }
  return request;
}

/**
 * The prompt. Exported separately so a test can assert the region is present
 * verbatim, which is the property that actually matters: a prompt that drops
 * or reflows the region gets an answer aligned to code that is not in the
 * file.
 */
export function renderInlineEditPrompt(request: InlineEditRequest): string {
  const lines = [
    `You are editing ${request.path}, a ${request.language} file.`,
    "Rewrite ONLY the region marked below, following the instruction.",
    "Answer with the replacement code and nothing else: no explanation, " +
      "no markdown fence, no line numbers, no commentary.",
    "Keep the surrounding indentation and coding style.",
    "",
    `Instruction: ${request.instruction}`,
    "",
  ];
  if (request.before) lines.push("Lines before the region:", request.before, "");
  lines.push(
    `Region to rewrite, lines ${request.startLine} to ${request.endLine}:`,
    request.selection,
    ""
  );
  if (request.after) lines.push("Lines after the region:", request.after, "");
  return lines.join("\n").trimEnd();
}

// ---------------------------------------------------------------- answer

/** Nothing longer than this is a plausible replacement for one region. */
export const MAX_ANSWER_CHARS = 24000;
/** An answer this many times shorter than the region is a summary, not code. */
const SHRINK_FLOOR = 10;
/** An answer this many times longer has stopped rewriting and started rambling. */
const GROWTH_CEILING = 8;

/**
 * A fence marker starting a line, opening or closing. Indentation tolerated,
 * because a model that indents its answer indents the fence with it.
 *
 * Only the line START is tested, and that is a fix. The first version also
 * matched any line ENDING in a fence marker, which made ` * ``` ` inside a
 * JSDoc or a docstring look like a stray fence. `longestFencedBlock` cannot
 * see those lines either (they carry a ` * ` prefix, not whitespace), so the
 * answer fell through to the bare path and was refused outright: any region
 * whose correct rewrite carries a fenced example in a comment could never be
 * accepted. A fence marker is only structurally meaningful at the start of a
 * line, so that is the only place worth refusing one.
 */
const STRAY_FENCE = /^[ \t]*(?:```|~~~)/m;

/**
 * Openers that betray a chat answer rather than code.
 *
 * `ok`, `okay` and a bare `note` used to be in this list and had to go. They
 * are the single most idiomatic identifier in Go (`ok := ...`, `v, ok := m[k]`)
 * and ordinary variable names everywhere else, so an answer that began with
 * them was refused deterministically, forever, no matter how correct it was.
 * `note:` and `explanation:` keep their prose meaning only with the colon, and
 * no language starts a statement that way.
 */
const PROSE_OPENERS =
  /^(?:here(?:'s| is| are)\b|sure[\s,.!:]|certainly[\s,.!:]|of course\b|i (?:can|will|have|'ll|'ve|'m)\b|let me\b|this (?:code|function|snippet|change|version|will)\b|the (?:code|function|following|change|snippet)\b|below is\b|to (?:do|achieve) (?:this|that)\b|explanation:|note:|sorry[\s,.!:])/i;

export interface NormalizeOptions {
  /**
   * Accept an answer that reads like prose. Set for markdown and plain text,
   * where a paragraph IS the code. Off everywhere else, because "Here is the
   * updated function:" spliced into a .ts file is a syntax error the user is
   * being asked to accept.
   */
  allowProse?: boolean;
}

/**
 * Turn a model answer into replacement code, or into null.
 *
 * Null is a first class result. Everything downstream of this function writes
 * into a diff the user is invited to accept with one keystroke, so the bar is
 * not "probably fine": an answer that cannot be proven to be code is dropped
 * and the box says so.
 *
 * The order matters. Reasoning tags go first because a reasoning model puts
 * prose inside them and code after them, so testing for prose before stripping
 * them would reject every answer from such a model. Fences go next, and how
 * they are unwrapped depends on the language, see below.
 */
export function normalizeInlineEdit(
  raw: string,
  original: string,
  opts: NormalizeOptions = {}
): string | null {
  const prose = opts.allowProse === true;
  let text = raw ?? "";

  // Drop everything up to the last closing reasoning tag. Slicing on the tag
  // rather than on a matched pair also handles the truncated case, where the
  // opening tag was never emitted or the stream cut the pair apart.
  const endThink = text.lastIndexOf("</think>");
  if (endThink >= 0) text = text.slice(endThink + "</think>".length);
  text = text.replace(/<\/?think>/gi, "");

  // trimBlankEdges and NOT trim(): a bare `trim()` would eat the leading
  // indentation of the first line, which is precisely the information the
  // answer is expected to carry back for an indented region.
  text = trimBlankEdges(text, prose);

  // How the fence is unwrapped is NOT the same question in the two modes, and
  // treating it as one destroyed content.
  //
  // In a code file, the answer is one snippet and everything around it is
  // chatter, so the LONGEST closed block wins rather than the first: a model
  // that explains itself often quotes the OLD snippet before the new one, and
  // taking the first would replace the region with itself.
  //
  // In markdown or plain text a fenced block is legitimate CONTENT, and the
  // prose around it is the rest of the content. Reaching in and keeping only
  // the fence body there means proposing a README paragraph replaced by a bare
  // shell command, filed as a one-keystroke-acceptable diff. So in prose mode
  // a fence is unwrapped only when the whole answer IS that one fence, which
  // is the "the model wrapped its reply out of habit" case; anything else is
  // kept verbatim, fence included, because that is what the file should hold.
  const fenced = prose ? soleFencedBlock(text) : longestFencedBlock(text);
  if (fenced !== null) {
    text = trimBlankEdges(fenced, prose);
  } else if (!prose) {
    // No fence, so the answer is bare. It has to look like code.
    if (PROSE_OPENERS.test(text.trimStart())) return null;
    // A leftover half fence means the answer was cut mid block; what is left
    // may be half a function, which is worse than nothing.
    if (STRAY_FENCE.test(text)) return null;
  }

  if (!text.trim()) return null;
  if (text.length > MAX_ANSWER_CHARS) return null;

  const base = original.length;
  // Length sanity only applies once the region is big enough for a ratio to
  // mean anything. Below that, replacing three characters with forty is a
  // completely ordinary edit.
  if (base > 400 && text.length * SHRINK_FLOOR < base) return null;
  if (text.length > Math.max(800, base * GROWTH_CEILING)) return null;

  return text;
}

/**
 * The longest CLOSED fenced block in the text, or null when there is none.
 *
 * The closing fence is mandatory. An answer that opens a fence and never
 * closes it was cut off mid generation, and its body is half a function; that
 * has to fall through to the bare answer path, where the stray fence marker is
 * detected and the whole thing refused.
 */
function longestFencedBlock(text: string): string | null {
  const re = /(?:^|\n)[ \t]*(```|~~~)[^\n]*\n([\s\S]*?)\n[ \t]*\1/g;
  let best: string | null = null;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const body = m[2];
    if (best === null || body.length > best.length) best = body;
  }
  return best;
}

/**
 * Strip blank lines at both ends, keep indentation and inner blank lines.
 *
 * Trailing whitespace is stripped in code, where it is noise the linter would
 * flag anyway, and KEPT in prose: two trailing spaces are a hard line break in
 * markdown, so stripping them silently reflows three rendered lines into one
 * paragraph in a diff the user is being invited to accept.
 */
function trimBlankEdges(text: string, keepTrailingSpaces = false): string {
  const lines = text.split("\n");
  while (lines.length && lines[0].trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  if (keepTrailingSpaces) return lines.join("\n");
  return lines.map((line) => line.replace(/[ \t]+$/, "")).join("\n");
}

/**
 * The body of the answer when the ENTIRE answer is one fenced block, and null
 * otherwise. Used in prose mode, where a fence in the middle of a reply is
 * content to keep and not a wrapper to strip.
 */
function soleFencedBlock(text: string): string | null {
  const m = /^[ \t]*(```|~~~)[^\n]*\n([\s\S]*?)\n[ \t]*\1[ \t]*$/.exec(text.trim());
  return m ? m[2] : null;
}

// ---------------------------------------------------------------- apply

export interface InlineEditApplication {
  from: number;
  to: number;
  /** The replacement as it will land, after indentation is restored. */
  text: string;
  /** The complete new document. This is what gets proposed. */
  doc: string;
}

/**
 * Re-indent a replacement that came back flush left. Models routinely answer
 * with the region dedented to column zero because that is how the snippet
 * reads on its own, and in Python that is not a cosmetic problem, it is a
 * different program.
 *
 * The shift is applied only when the answer is strictly shallower than the
 * region AND the region's indent starts with the answer's, so a replacement
 * that already carries the right indentation is never doubled. Every line
 * moves by the same padding, which preserves the answer's internal structure.
 * Blank lines are left alone rather than padded into trailing whitespace.
 */
export function realignIndent(regionFirstLine: string, replacement: string): string {
  const target = leadingWhitespace(regionFirstLine);
  if (!target) return replacement;
  const lines = replacement.split("\n");
  const current = leadingWhitespace(lines[0]);
  if (current.length >= target.length || !target.startsWith(current)) return replacement;
  const pad = target.slice(current.length);
  return lines.map((line) => (line.trim() === "" ? line : pad + line)).join("\n");
}

/**
 * True when the document is a CRLF document.
 *
 * Counted rather than sniffed on the first line: a file that has been through
 * two editors can hold both endings, and the right answer is the one that is
 * already in the majority, not the one that happens to come first.
 */
export function usesCrlf(doc: string): boolean {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < doc.length; i++) {
    if (doc.charCodeAt(i) !== 10) continue;
    if (i > 0 && doc.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  return crlf > lf;
}

/**
 * Give the replacement the document's line endings.
 *
 * Models answer with bare \n whatever they were shown, and the region handed
 * to them had its \r stripped, so splicing the answer verbatim into a CRLF
 * file silently converts exactly the edited lines to LF. The file then holds
 * both endings, which is invisible in the merge view and shows up later as a
 * whole-file diff in git. Normalising first means the function is idempotent
 * on an answer that already came back with CRLF.
 */
function matchLineEndings(doc: string, text: string): string {
  const flat = text.replace(/\r\n/g, "\n");
  return usesCrlf(doc) ? flat.replace(/\n/g, "\r\n") : flat;
}

/**
 * Compute the replacement and the resulting document, or null when there is
 * nothing to propose. A no-op is a null and not an empty diff: filing a
 * proposal identical to the file puts the editor in review mode over a diff
 * with zero hunks, which the user cannot exit by accepting anything.
 */
export function applyInlineEdit(
  doc: string,
  range: { from: number; to: number },
  replacement: string
): InlineEditApplication | null {
  const from = Math.min(Math.max(Math.round(range.from), 0), doc.length);
  const to = Math.min(Math.max(Math.round(range.to), from), doc.length);
  const starts = lineStarts(doc);
  const firstLine = lineTextAt(doc, starts, lineIndexAt(starts, from));
  const text = matchLineEndings(doc, realignIndent(firstLine, replacement));
  if (text === doc.slice(from, to)) return null;
  return { from, to, text, doc: doc.slice(0, from) + text + doc.slice(to) };
}

// ---------------------------------------------------------------- state

/**
 * The open box, as a state field, so "is one already open" is a question about
 * the editor state and not about whatever DOM happens to exist. That is what
 * makes the no-stacking rule provable without a browser: a second open effect
 * on a state that already has a box is ignored HERE, one layer below the
 * command, so no caller can get around it.
 */
export const openInlineEditEffect = StateEffect.define<InlineEditSession>();
export const closeInlineEditEffect = StateEffect.define<null>();

export interface InlineEditSession {
  /** Workspace relative path, captured when the box opened. */
  rel: string;
  range: EditRange;
}

export interface InlineEditDeps {
  /** Workspace relative path of this document, or null when there is none. */
  file(): string | null;
  /** A model is loaded and able to answer. */
  enabled(): boolean;
  /** The editor is already showing a pending diff. */
  reviewing(): boolean;
  /** Ask the model. Must reject or resolve null when the signal aborts. */
  ask(request: InlineEditRequest, signal: AbortSignal): Promise<string | null>;
  /**
   * File the new document as a pending proposal. Must not write to disk.
   *
   * It runs AFTER the box has closed, because filing a proposal repaints the
   * Code pane and destroys the editor view the box lives in. The consequence
   * for the host: propose() has to report its own failures, since there is no
   * box left to show them in.
   */
  propose(rel: string, doc: string): void | Promise<void>;
  /** Translator. Every key used here needs an `en` and an `fr` in i18n.ts. */
  t(key: string): string;
}

const inlineEditDepsFacet = Facet.define<InlineEditDeps, InlineEditDeps | null>({
  combine: (values) => (values.length ? values[0] : null),
});

const inlineEditField = StateField.define<Tooltip | null>({
  create: () => null,
  update(value, tr) {
    // Any edit under the box invalidates the region offsets the answer will be
    // spliced into. Mapping them through the changes would keep the box alive
    // over code the user just changed by hand, and the model was shown the old
    // text. Closing is the honest move.
    if (tr.docChanged) return null;
    for (const effect of tr.effects) {
      if (effect.is(closeInlineEditEffect)) return null;
      // Already open: a second Cmd+K refocuses, it does not stack.
      if (effect.is(openInlineEditEffect) && value === null) {
        const deps = tr.state.facet(inlineEditDepsFacet);
        if (deps) value = inlineEditTooltip(deps, effect.value);
      }
    }
    return value;
  },
  provide: (field) => showTooltip.from(field),
});

/**
 * True when a box is open on this state. Takes the state and not the view so
 * the state machine can be exercised without a browser.
 */
export function inlineEditOpen(state: EditorState): boolean {
  return state.field(inlineEditField, false) != null;
}

/** The live input of the open box, so a second Cmd+K can put focus back. */
const openInputs = new WeakMap<EditorView, HTMLInputElement>();

// ---------------------------------------------------------------- commands

/** Cmd+K. Opens the box on the current selection, or refocuses an open one. */
export const openInlineEdit: Command = (view) => {
  const deps = view.state.facet(inlineEditDepsFacet);
  if (!deps) return false;
  if (inlineEditOpen(view.state)) {
    openInputs.get(view)?.focus();
    return true;
  }
  if (!deps.enabled() || deps.reviewing()) return false;
  const rel = deps.file();
  if (!rel) return false;
  const selection = view.state.selection.main;
  const range = expandEditRange(view.state.doc.toString(), selection.from, selection.to);
  view.dispatch({ effects: openInlineEditEffect.of({ rel, range }) });
  return true;
};

/** Escape. Returns false when no box is open, so the key keeps falling through. */
export const closeInlineEdit: Command = (view) => {
  if (!inlineEditOpen(view.state)) return false;
  view.dispatch({ effects: closeInlineEditEffect.of(null) });
  view.focus();
  return true;
};

// ---------------------------------------------------------------- widget

function inlineEditTooltip(deps: InlineEditDeps, session: InlineEditSession): Tooltip {
  return {
    pos: session.range.from,
    above: true,
    arrow: false,
    create: (view) => buildInlineEditBox(view, deps, session),
  };
}

function buildInlineEditBox(
  view: EditorView,
  deps: InlineEditDeps,
  session: InlineEditSession
): TooltipView {
  const dom = document.createElement("div");
  dom.className = "cm-inline-edit";

  const head = document.createElement("div");
  head.className = "cm-inline-edit-head";
  head.textContent =
    session.rel +
    " " +
    deps
      .t("code.inlineEdit.lines")
      .replace("%a", String(session.range.startLine))
      .replace("%b", String(session.range.endLine));

  const row = document.createElement("div");
  row.className = "cm-inline-edit-row";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "cm-inline-edit-input";
  input.placeholder = deps.t("code.inlineEdit.placeholder");
  input.spellcheck = false;
  input.setAttribute("aria-label", deps.t("code.inlineEdit.placeholder"));

  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "cm-inline-edit-go";
  submit.textContent = deps.t("code.inlineEdit.submit");

  const status = document.createElement("div");
  status.className = "cm-inline-edit-status";
  status.textContent = deps.t("code.inlineEdit.hint");
  // The status line carries the failure messages, and a failure that only
  // appears visually is a failure a screen reader user never learns about.
  status.setAttribute("role", "status");

  row.appendChild(input);
  row.appendChild(submit);
  dom.appendChild(head);
  dom.appendChild(row);
  dom.appendChild(status);

  let pending: AbortController | null = null;
  let busy = false;

  const fail = (message: string): void => {
    busy = false;
    input.disabled = false;
    submit.disabled = false;
    status.textContent = message;
    dom.classList.add("bad");
    input.focus();
  };

  const close = (): void => {
    view.dispatch({ effects: closeInlineEditEffect.of(null) });
    view.focus();
  };

  const run = async (): Promise<void> => {
    if (busy) return;
    const instruction = input.value.trim();
    if (!instruction) return;
    const doc = view.state.doc.toString();
    const request = buildInlineEditRequest({
      doc,
      range: session.range,
      rel: session.rel,
      instruction,
    });
    if (!request) {
      fail(deps.t("code.inlineEdit.tooBig"));
      return;
    }

    busy = true;
    dom.classList.remove("bad");
    input.disabled = true;
    submit.disabled = true;
    status.textContent = deps.t("code.inlineEdit.working");

    const controller = new AbortController();
    pending = controller;
    try {
      const raw = await deps.ask(request, controller.signal);
      // The box may have been closed, or the document may have moved on, while
      // the model was thinking. Either way the offsets are no longer the ones
      // the answer was written against, so nothing gets spliced.
      if (controller.signal.aborted) return;
      if (view.state.doc.toString() !== doc) {
        fail(deps.t("code.inlineEdit.stale"));
        return;
      }
      const code = raw
        ? normalizeInlineEdit(raw, request.selection, {
            allowProse: isProseLanguage(request.language),
          })
        : null;
      if (code === null) {
        fail(deps.t("code.inlineEdit.badAnswer"));
        return;
      }
      const applied = applyInlineEdit(doc, session.range, code);
      if (!applied) {
        fail(deps.t("code.inlineEdit.noChange"));
        return;
      }
      // Close BEFORE proposing, and the order is not negotiable. The host's
      // propose() files the diff and repaints the Code pane, and that repaint
      // destroys this very EditorView, so a dispatch afterwards would run
      // against a dead view. It also means propose() owns its own error
      // reporting: by the time it can fail there is no box left to fail into.
      // Closing first has one useful side effect: it tears the tooltip down,
      // destroy() aborts `controller`, and the catch below therefore stays
      // quiet instead of writing into a detached node.
      close();
      await deps.propose(session.rel, applied.doc);
    } catch {
      if (!controller.signal.aborted) fail(deps.t("code.inlineEdit.failed"));
    } finally {
      if (pending === controller) pending = null;
      busy = false;
    }
  };

  input.addEventListener("keydown", (event) => {
    // The box lives inside view.dom but outside contentDOM, so CodeMirror's
    // own key handling never sees these. stopPropagation is belt and braces
    // against a host that installs a capture listener higher up.
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      void run();
    }
  });
  submit.addEventListener("click", () => void run());
  // Clicks inside the box must not move the caret, which would change the
  // selection the region was computed from.
  dom.addEventListener("mousedown", (event) => event.stopPropagation());

  return {
    dom,
    mount: () => {
      openInputs.set(view, input);
      input.focus();
    },
    destroy: () => {
      // Closing while the model is still thinking has to abort the request,
      // otherwise a slow answer lands in a box that no longer exists and, worse,
      // proposes a diff the user already cancelled.
      pending?.abort();
      pending = null;
      if (openInputs.get(view) === input) openInputs.delete(view);
    },
  };
}

// ---------------------------------------------------------------- extension

export interface InlineEditOptions {
  /**
   * Install the Cmd+K and Escape bindings. Leave it on unless the host binds
   * `openInlineEdit` and `closeInlineEdit` inside its own single keymap, which
   * is what app/src/code/extensions.ts does for auto-tab.
   */
  keys?: boolean;
}

/**
 * Inline edit at the cursor: Cmd+K, describe the change, review the diff.
 *
 * The keymap is `Prec.highest` and that is a fix, not a preference. Escape is
 * bound by defaultKeymap to simplifySelection, which RETURNS TRUE whenever a
 * range is selected, and a selected range is exactly the state Cmd+K is used
 * from. At normal precedence the editor's own keymap runs first and eats the
 * Escape, leaving the box open with no way to dismiss it. Both commands here
 * return false when no box is open, so nothing else is stolen.
 */
export function inlineEditExtension(
  deps: InlineEditDeps,
  options: InlineEditOptions = {}
): Extension {
  const parts: Extension[] = [inlineEditDepsFacet.of(deps), inlineEditField];
  if (options.keys !== false) {
    parts.push(
      Prec.highest(
        keymap.of([
          { key: "Mod-k", preventDefault: true, run: openInlineEdit },
          { key: "Escape", run: closeInlineEdit },
        ])
      )
    );
  }
  return parts;
}
