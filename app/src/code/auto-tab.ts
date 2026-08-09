const PREFIX_LIMIT = 6000;
const SUFFIX_LIMIT = 2000;

import { StateEffect, StateField, Transaction, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

export interface InlineContext {
  prefix: string;
  suffix: string;
}

export function inlineCompletionContext(text: string, pos: number): InlineContext {
  const caret = Math.min(Math.max(Math.round(pos), 0), text.length);
  return {
    prefix: text.slice(Math.max(0, caret - PREFIX_LIMIT), caret),
    suffix: text.slice(caret, caret + SUFFIX_LIMIT),
  };
}

/** Refuse prose and turn the model's answer into insertion-only text. */
export function normalizeInlineCompletion(raw: string, prefix: string): string | null {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fenced = text.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (fenced) text = fenced[1].trim();
  if (/^(here(?:'s| is)|sure[,!:]|the corrected|explanation:)/i.test(text)) return null;
  if (prefix && text.startsWith(prefix)) text = text.slice(prefix.length);
  text = text.replace(/<\/?(?:completion|insert)>/gi, "").trimEnd();
  return text.length > 0 && text.length <= 8000 ? text : null;
}

export interface InlineRequestState {
  docChanged: boolean;
  emptySelection: boolean;
  serverReady: boolean;
  reviewing: boolean;
  before: string;
}

export function shouldRequestInlineCompletion(state: InlineRequestState): boolean {
  return (
    state.docChanged &&
    state.emptySelection &&
    state.serverReady &&
    !state.reviewing &&
    /\S/.test(state.before)
  );
}

interface InlineSuggestion {
  pos: number;
  text: string;
}

const setInlineSuggestion = StateEffect.define<InlineSuggestion | null>();

class InlineSuggestionWidget extends WidgetType {
  constructor(private readonly text: string) { super(); }
  eq(other: InlineSuggestionWidget): boolean { return other.text === this.text; }
  toDOM(): HTMLElement {
    const ghost = document.createElement("span");
    ghost.className = "cm-autotab-ghost";
    ghost.setAttribute("aria-hidden", "true");
    ghost.textContent = this.text;
    const key = document.createElement("kbd");
    key.className = "cm-autotab-key";
    key.textContent = "Tab";
    ghost.appendChild(key);
    return ghost;
  }
}

const inlineSuggestionField = StateField.define<InlineSuggestion | null>({
  create: () => null,
  update(value, transaction) {
    if (transaction.docChanged) value = null;
    for (const effect of transaction.effects) {
      if (effect.is(setInlineSuggestion)) value = effect.value;
    }
    return value && value.pos <= transaction.newDoc.length ? value : null;
  },
  provide: (field) => EditorView.decorations.from(field, (value): DecorationSet =>
    value
      ? Decoration.set([
          Decoration.widget({ widget: new InlineSuggestionWidget(value.text), side: 1 }).range(value.pos),
        ])
      : Decoration.none
  ),
});

export interface AutoTabDeps {
  file(): string | null;
  enabled(): boolean;
  reviewing(): boolean;
  complete(
    rel: string,
    prefix: string,
    suffix: string,
    signal: AbortSignal
  ): Promise<string | null>;
}

export function acceptAutoTab(view: EditorView): boolean {
  const suggestion = view.state.field(inlineSuggestionField, false);
  if (!suggestion) return false;
  view.dispatch({
    changes: { from: suggestion.pos, insert: suggestion.text },
    selection: { anchor: suggestion.pos + suggestion.text.length },
    effects: setInlineSuggestion.of(null),
    annotations: Transaction.userEvent.of("input.complete"),
  });
  return true;
}

export function clearAutoTab(view: EditorView): boolean {
  if (!view.state.field(inlineSuggestionField, false)) return false;
  view.dispatch({ effects: setInlineSuggestion.of(null) });
  return true;
}

/** Local-model inline completion: ghost text, Tab to accept, Escape to clear. */
export function autoTabExtension(deps: AutoTabDeps): Extension {
  const plugin = ViewPlugin.fromClass(class {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private request: AbortController | null = null;

    constructor(private readonly view: EditorView) {}

    update(update: ViewUpdate): void {
      const completed = update.transactions.some((tr) => tr.isUserEvent("input.complete"));
      const selection = update.state.selection.main;
      const prefix = update.state.doc.sliceString(0, selection.head);
      const eligible = shouldRequestInlineCompletion({
        docChanged: update.docChanged && !completed,
        emptySelection: selection.empty,
        serverReady: deps.enabled(),
        reviewing: deps.reviewing(),
        before: prefix,
      });
      if (update.docChanged || update.selectionSet) this.clearSuggestion();
      this.cancelPending();
      if (!eligible) return;
      const rel = deps.file();
      if (!rel) return;
      const doc = update.state.doc.toString();
      const pos = selection.head;
      const context = inlineCompletionContext(doc, pos);
      this.timer = setTimeout(() => void this.requestCompletion(rel, doc, pos, context), 650);
    }

    destroy(): void { this.cancelPending(); }

    private clearSuggestion(): void {
      if (this.view.state.field(inlineSuggestionField, false)) {
        this.view.dispatch({ effects: setInlineSuggestion.of(null) });
      }
    }

    private cancelPending(): void {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      this.request?.abort();
      this.request = null;
    }

    private async requestCompletion(
      rel: string,
      doc: string,
      pos: number,
      context: InlineContext
    ): Promise<void> {
      this.timer = null;
      const request = new AbortController();
      this.request = request;
      try {
        const raw = await deps.complete(rel, context.prefix, context.suffix, request.signal);
        if (request.signal.aborted || !raw || !deps.enabled() || deps.reviewing()) return;
        const selection = this.view.state.selection.main;
        if (!selection.empty || selection.head !== pos || this.view.state.doc.toString() !== doc) return;
        const text = normalizeInlineCompletion(raw, context.prefix);
        if (text) this.view.dispatch({ effects: setInlineSuggestion.of({ pos, text }) });
      } catch {
        // Auto Tab is assistance, never a reason to interrupt editing.
      } finally {
        if (this.request === request) this.request = null;
      }
    }
  });

  return [inlineSuggestionField, plugin];
}
