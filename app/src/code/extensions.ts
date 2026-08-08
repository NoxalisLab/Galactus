// Galactus, Code view: the ONE place the editor's extension set is declared.
//
// The Code view used to mount the `basicSetup` bundle from the `codemirror`
// meta package. That bundle is explicitly not configurable: its own source
// says "once you decide you want to configure your editor more precisely, you
// take this package's source and copy it into your own code". We reached that
// point. As long as basicSetup was in the way, nobody could add a completion
// source or a lint source without instantiating a SECOND autocompletion() and
// a second keymap, which means two competing completion tooltips and two
// handlers fighting for the same keys.
//
// The array below is basicSetup expanded literally, read from
// app/node_modules/codemirror/dist/index.js (lines 51-79), plus exactly three
// deliberate additions:
//   - lintGutter(), which basicSetup does NOT include, so diagnostics get a
//     gutter marker and not only underlines,
//   - EditorState.phrases.of(...), so the search / lint / completion / merge
//     UI speaks the app's language,
//   - the Mod-s binding, merged INTO the single keymap rather than stacked as
//     a second one, first in the list so it wins over anything below it.
//
// Everything a later module needs to swap at runtime goes through a
// Compartment declared here. Reconfiguring a compartment is a plain
// transaction: it never rebuilds the state, so history, folds, cursor and
// scroll survive.

import { Compartment, EditorState, Extension } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { lintGutter, lintKeymap } from "@codemirror/lint";

/** Language support for the open file. Swapped when the active tab changes. */
export const languageComp = new Compartment();
/**
 * Extra completion sources. There is only ever ONE autocompletion() in the
 * editor; a module that wants to contribute completions reconfigures this
 * compartment with `EditorState.languageData.of(() => [{ autocomplete: src }])`
 * instead of calling autocompletion() a second time.
 */
export const autocompleteComp = new Compartment();
/** The diagnostics host (see diagnostics.ts). Kept swappable per document. */
export const lintComp = new Compartment();
/**
 * Code intelligence: hover tooltips, symbol highlighting, anything a later
 * module bolts on. Starts empty on purpose.
 */
export const intelComp = new Compartment();

export const COMPARTMENT_NAMES = Object.freeze([
  "languageComp",
  "autocompleteComp",
  "lintComp",
  "intelComp",
]);

export interface EditorOpts {
  /** Cmd+S. The view never saves by itself; it calls back into the app. */
  onSave(): void;
  /** The CodeMirror phrase table for the current UI language (phrases.ts). */
  phrases: Record<string, string>;
  /** Language support for this document, e.g. `[python()]`. May be empty. */
  language: Extension[];
  /** The diagnostics host for this document. May be empty. */
  diagnostics: Extension[];
}

interface Part {
  name: string;
  ext: Extension;
}

/**
 * basicSetup, expanded, in its original order. Split out so that
 * `editorExtensions` and `extensionNames` can never drift apart: both are
 * derived from this one array.
 */
function parts(opts: EditorOpts): Part[] {
  return [
    { name: "lineNumbers", ext: lineNumbers() },
    { name: "highlightActiveLineGutter", ext: highlightActiveLineGutter() },
    { name: "highlightSpecialChars", ext: highlightSpecialChars() },
    { name: "history", ext: history() },
    { name: "foldGutter", ext: foldGutter() },
    { name: "drawSelection", ext: drawSelection() },
    { name: "dropCursor", ext: dropCursor() },
    { name: "allowMultipleSelections", ext: EditorState.allowMultipleSelections.of(true) },
    { name: "indentOnInput", ext: indentOnInput() },
    {
      name: "syntaxHighlighting",
      ext: syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    },
    { name: "bracketMatching", ext: bracketMatching() },
    { name: "closeBrackets", ext: closeBrackets() },
    // `defaultKeymap: false` is a fix, not a preference. autocompletion()
    // installs completionKeymap itself, and basicSetup ALSO spreads
    // completionKeymap into its own keymap, so a stock basicSetup editor
    // carries two keymaps and every completion binding twice. We keep the
    // bindings in the single keymap below and switch the internal one off.
    { name: "autocompletion", ext: autocompletion({ defaultKeymap: false }) },
    { name: "rectangularSelection", ext: rectangularSelection() },
    { name: "crosshairCursor", ext: crosshairCursor() },
    { name: "highlightActiveLine", ext: highlightActiveLine() },
    { name: "highlightSelectionMatches", ext: highlightSelectionMatches() },
    // Not part of basicSetup: the gutter that shows where the diagnostics are.
    { name: "lintGutter", ext: lintGutter() },
    // Not part of basicSetup: the translated strings.
    { name: "phrases", ext: EditorState.phrases.of(opts.phrases) },
    // The compartments. Every one of them may legitimately be empty.
    { name: "languageComp", ext: languageComp.of(opts.language) },
    { name: "autocompleteComp", ext: autocompleteComp.of([]) },
    { name: "lintComp", ext: lintComp.of(opts.diagnostics) },
    { name: "intelComp", ext: intelComp.of([]) },
    // ONE keymap. Mod-s first: within a single keymap the first binding that
    // handles the key wins, so the app's save always beats anything below.
    {
      name: "keymap",
      ext: keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            opts.onSave();
            return true;
          },
        },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        ...lintKeymap,
      ]),
    },
  ];
}

/** The editor's extension set. Pass the result straight to EditorState.create. */
export function editorExtensions(opts: EditorOpts): Extension[] {
  return parts(opts).map((p) => p.ext);
}

/**
 * The same list, by name, in the same order. Used by the test to assert there
 * is exactly one autocompletion and exactly one keymap, and by dump.ts so a
 * reviewer can diff the editor's composition across commits.
 */
export function extensionNames(opts: EditorOpts): string[] {
  return parts(opts).map((p) => p.name);
}
