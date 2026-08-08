// Galactus, Code view: the CodeMirror phrase table.
//
// CodeMirror ships its own user-visible strings hard coded in English: the
// search panel, the go-to-line panel, the lint panel, the completion tooltip,
// the fold gutter tooltips and the merge chunk buttons. They are all routed
// through `EditorState.phrase()`, which looks the string up in the
// `EditorState.phrases` facet before showing it. Feeding that facet is the
// only way to translate them, so a French UI stops shipping an English editor.
//
// The key list below is NOT invented: it is every literal passed to
// `state.phrase(...)` in the installed dists of @codemirror/{search,lint,
// autocomplete,view,merge,language,commands}. Regenerate it with:
//
//   cd app/node_modules && for p in search lint autocomplete view merge \
//     language commands; do grep -ohE 'phrase\([^)]{0,60}' \
//     @codemirror/$p/dist/index.js; done | sort -u
//
// A `$` inside a key is CodeMirror's own placeholder: `state.phrase(key, arg)`
// substitutes the arguments for the `$` signs in order, so every translation
// has to keep the same number of `$`.

/**
 * Every phrase key CodeMirror actually asks for, in a stable order (grouped by
 * the package that raises it). Frozen so a test can assert full coverage.
 */
export const PHRASE_KEYS = Object.freeze([
  // @codemirror/search
  "Find",
  "Replace",
  "next",
  "previous",
  "all",
  "match case",
  "regexp",
  "by word",
  "replace",
  "replace all",
  "close",
  "current match",
  "replaced $ matches",
  "replaced match on line $",
  "Go to line",
  "go",
  "on line",
  // @codemirror/lint
  "Diagnostics",
  "No diagnostics",
  // @codemirror/autocomplete
  "Completions",
  // @codemirror/view
  "Control character",
  // @codemirror/merge
  "Accept",
  "Reject",
  "Revert this chunk",
  "$ unchanged lines",
  // @codemirror/language
  "folded code",
  "unfold",
  "Folded lines",
  "Unfolded lines",
  "Fold line",
  "Unfold line",
  "to",
  // @codemirror/commands
  "Selection deleted",
] as const);

export type PhraseKey = (typeof PHRASE_KEYS)[number];

/**
 * French wordings. English needs no table: the key IS the English string, so
 * `cmPhrases("en")` returns the identity map, which keeps the dump symmetric
 * and lets the coverage test treat both languages the same way.
 */
const FR: Record<PhraseKey, string> = {
  "Find": "Rechercher",
  "Replace": "Remplacer",
  "next": "suivant",
  "previous": "précédent",
  "all": "tout",
  "match case": "respecter la casse",
  "regexp": "regex",
  "by word": "mot entier",
  "replace": "remplacer",
  "replace all": "tout remplacer",
  "close": "fermer",
  "current match": "correspondance courante",
  "replaced $ matches": "$ correspondances remplacées",
  "replaced match on line $": "correspondance remplacée à la ligne $",
  "Go to line": "Aller à la ligne",
  "go": "aller",
  "on line": "à la ligne",
  "Diagnostics": "Diagnostics",
  "No diagnostics": "Aucun diagnostic",
  "Completions": "Complétions",
  "Control character": "Caractère de contrôle",
  "Accept": "Accepter",
  "Reject": "Refuser",
  "Revert this chunk": "Annuler ce bloc",
  "$ unchanged lines": "$ lignes inchangées",
  "folded code": "code replié",
  "unfold": "déplier",
  "Folded lines": "Lignes repliées",
  "Unfolded lines": "Lignes dépliées",
  "Fold line": "Replier la ligne",
  "Unfold line": "Déplier la ligne",
  "to": "à",
  "Selection deleted": "Sélection supprimée",
};

/**
 * The table to hand to `EditorState.phrases.of()`. Always complete: every key
 * in PHRASE_KEYS is present, in PHRASE_KEYS order, so the object serializes
 * deterministically.
 */
export function cmPhrases(lang: "en" | "fr"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of PHRASE_KEYS) out[k] = lang === "fr" ? FR[k] : k;
  return out;
}

/** How many `$` placeholders a key carries. Used by the coverage test. */
export function placeholderCount(s: string): number {
  return (s.match(/\$/g) ?? []).length;
}
