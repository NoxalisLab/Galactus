// Galactus, Code view: the tab strip.
//
// A pure string function and a pure click decoder. No DOM is touched at module
// load, no state is read from anywhere: everything the strip shows is an
// argument. That is what lets the rendering be asserted character by character
// in a test with no browser.

import type { Doc } from "./docs.js";

/** Titles shown on hover. Passed in so this file never imports the i18n table. */
export interface TabLabels {
  /** Tooltip on the close cross. */
  close: string;
  /** Tooltip on the dirty dot. */
  unsaved: string;
  /** Tooltip on the pending-proposal diamond. */
  proposed: string;
}

export const DEFAULT_TAB_LABELS: TabLabels = {
  close: "Close",
  unsaved: "unsaved",
  proposed: "proposed change",
};

/** Same escaping rule as code.ts: the four characters that can break markup. */
function esc(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!
  );
}

function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * The whole strip, as one HTML string.
 *
 * A tab carries the basename, a dirty dot when the buffer no longer matches
 * the disk content, the same diamond the file tree uses for a file with a
 * pending proposal, and a close cross. Returns "" when nothing is open, so the
 * caller can drop the strip entirely instead of painting an empty bar.
 */
export function tabsHtml(
  docs: Doc[],
  activeRel: string | null,
  pendingRels: Set<string>,
  labels: TabLabels = DEFAULT_TAB_LABELS
): string {
  if (!docs.length) return "";
  let out = "";
  for (const d of docs) {
    const dirty = d.error === null && d.state.doc.toString() !== d.saved;
    const prop = pendingRels.has(d.rel) || d.mergeBase !== null;
    const cls =
      "ctab2" +
      (d.rel === activeRel ? " on" : "") +
      (dirty ? " dirty" : "") +
      (prop ? " prop" : "");
    out +=
      `<div class="${cls}" data-tab2="${esc(d.rel)}" title="${esc(d.rel)}">` +
      `<span class="nm">${esc(baseName(d.rel))}</span>` +
      (prop ? `<span class="prop" title="${esc(labels.proposed)}">◆</span>` : "") +
      (dirty ? `<span class="dot" title="${esc(labels.unsaved)}"></span>` : "") +
      `<span class="x" data-tabx="${esc(d.rel)}" title="${esc(labels.close)}">×</span>` +
      `</div>`;
  }
  return `<div class="ctabs2">${out}</div>`;
}

export interface TabAction {
  action: "select" | "close";
  rel: string;
}

/**
 * Decode a click on the strip. The close cross is tested first, because it
 * sits inside the tab: without that order every close would also select.
 * Returns null when the click landed on the strip's background.
 */
export function onTabsClick(e: MouseEvent): TabAction | null {
  const target = e.target as HTMLElement | null;
  if (!target || typeof target.closest !== "function") return null;
  const x = target.closest("[data-tabx]") as HTMLElement | null;
  if (x) return { action: "close", rel: x.dataset.tabx! };
  const tab = target.closest("[data-tab2]") as HTMLElement | null;
  if (tab) return { action: "select", rel: tab.dataset.tab2! };
  return null;
}

/** Class names this module emits, for the stylesheet and for the dump. */
export const TAB_CLASSES = Object.freeze([
  "ctabs2",
  "ctab2",
  "ctab2.on",
  "ctab2.dirty",
  "ctab2.prop",
  "ctab2 .nm",
  "ctab2 .dot",
  "ctab2 .prop",
  "ctab2 .x",
]);
