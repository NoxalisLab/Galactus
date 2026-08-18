/**
 * The bar down the left of the editor: green where lines were added, blue where
 * they changed, a wedge where something was removed.
 *
 * The marks come from changebar.ts, which compares the buffer with the version
 * git holds. This file is only the CodeMirror plumbing: a field holding the
 * current marks and a gutter that paints them.
 *
 * It is a gutter of its own, not decorations on the line-number gutter, so the
 * bar keeps its position when line numbers are wide and it cannot collide with
 * the lint gutter.
 */

import { StateEffect, StateField, RangeSetBuilder, type Extension } from "@codemirror/state";
import { gutter, GutterMarker } from "@codemirror/view";
import type { LineChange } from "./changebar";

/** Replace the marks. Sent after a diff against git, never per keystroke. */
export const setChanges = StateEffect.define<LineChange[]>();

export const changesField = StateField.define<LineChange[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setChanges)) return e.value;
    // A document change does not move the marks: they are recomputed and sent
    // in, and until they arrive the old ones are still the best answer. This is
    // what stops the bar flickering on every keystroke.
    return value;
  },
});

class ChangeMarker extends GutterMarker {
  constructor(private readonly kind: LineChange["kind"]) {
    super();
  }
  eq(other: ChangeMarker): boolean {
    return other.kind === this.kind;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = `cm-chg cm-chg-${this.kind}`;
    return el;
  }
}

const MARKERS: Record<LineChange["kind"], ChangeMarker> = {
  add: new ChangeMarker("add"),
  mod: new ChangeMarker("mod"),
  del: new ChangeMarker("del"),
};

export function changeGutter(): Extension {
  return [
    changesField,
    gutter({
      class: "cm-changebar",
      markers(view) {
        const marks = view.state.field(changesField, false) ?? [];
        const builder = new RangeSetBuilder<GutterMarker>();
        if (!marks.length) return builder.finish();
        const lines = view.state.doc.lines;
        // Sorted and clamped: the marks were computed against a document that
        // may already have moved on, and a stale line number past the end
        // would throw rather than simply not paint.
        const seen = new Set<number>();
        for (const m of [...marks].sort((a, b) => a.line - b.line)) {
          const line = Math.min(Math.max(m.line, 1), lines);
          if (seen.has(line)) continue;
          seen.add(line);
          builder.add(view.state.doc.line(line).from, view.state.doc.line(line).from, MARKERS[m.kind]);
        }
        return builder.finish();
      },
      initialSpacer: () => MARKERS.mod,
    }),
  ];
}
