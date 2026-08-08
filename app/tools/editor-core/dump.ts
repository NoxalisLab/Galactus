// A deterministic description of the editor core, printed as JSON.
//
//   node tools/editor-core/out/tools/editor-core/dump.js
//
// Nothing here reads the clock, the filesystem or the network, so the output
// only moves when the editor's composition moves. Diff it across commits to
// see, in one line, that a module added a compartment, dropped an extension or
// changed a translation.

import { EditorState } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { COMPARTMENT_NAMES, editorExtensions, extensionNames } from "../../src/code/extensions.js";
import { LINT_DELAY_MS, diagnosticSourceIds, diagnosticsExtension } from "../../src/code/diagnostics.js";
import { PHRASE_KEYS, cmPhrases } from "../../src/code/phrases.js";
import { TAB_CLASSES, DEFAULT_TAB_LABELS, tabsHtml } from "../../src/code/tabs.js";
import { Docs } from "../../src/code/docs.js";
import type { Extension } from "@codemirror/state";

function sampleOpts() {
  return {
    onSave: () => {},
    phrases: cmPhrases("en"),
    language: [javascript({ typescript: true })],
    diagnostics: [diagnosticsExtension(() => null)],
  };
}

function sampleTabs(): string {
  const docs = new Docs((_rel: string, doc: string, extra: Extension[]) =>
    EditorState.create({ doc, extensions: extra })
  );
  docs.open("src/main.ts", "clean");
  docs.open("src/dirty.ts", "on disk");
  docs.open("src/proposed.ts", "before", "after");
  const d = docs.get("src/dirty.ts")!;
  d.state = d.state.update({ changes: { from: 0, insert: "edited " } }).state;
  return tabsHtml(docs.list(), "src/main.ts", new Set(["src/proposed.ts"]));
}

const out = {
  extensions: extensionNames(sampleOpts()),
  extensionCount: editorExtensions(sampleOpts()).length,
  compartments: [...COMPARTMENT_NAMES],
  diagnostics: {
    delayMs: LINT_DELAY_MS,
    registeredSources: diagnosticSourceIds(),
  },
  tabs: {
    classes: [...TAB_CLASSES],
    defaultLabels: DEFAULT_TAB_LABELS,
    sample: sampleTabs(),
  },
  phrases: {
    keys: PHRASE_KEYS.length,
    en: cmPhrases("en"),
    fr: cmPhrases("fr"),
  },
};

console.log(JSON.stringify(out, null, 2));
