// Galactus, Code view: which tier of code intelligence this file gets.
//
// The app deliberately ships two very different levels of help, and the gap
// between them is a PRODUCT problem before it is a technical one. Without a
// visible badge, a greyed-out "go to definition" in a .rs file reads as a bug;
// with it, it reads as a stated limit, which is what it is.
//
//   Tier A  full intelligence: types, hover, go to definition, references,
//           rename. Only where a real language service is running, which today
//           means TypeScript and JavaScript, and only while it is active.
//   Tier B  the bundled Lezer grammar: outline, breadcrumb, syntax errors.
//           No types, no inference, no cross-file resolution, no import
//           following, no telling two same-named identifiers apart.
//           Python additionally gets EXACT syntax errors and an exact outline
//           from the bundled CPython, but still no types, so it stays B.
//   none    no bundled grammar for this extension: a plain text editor with
//           line numbers, search and undo. Nothing is claimed.
//
// No network, no download, no "install support for this language" button:
// what the app ships is what the app can do, and the badge says which.

import { langIdFor } from "./outline.js";
import type { LangId } from "./outline.js";

export type Tier = "A" | "B" | "none";

/** Extensions a TypeScript/JavaScript language service can serve. */
const TIER_A_LANGS: ReadonlySet<LangId> = new Set<LangId>(["javascript", "typescript"]);

/**
 * The tier for one workspace-relative path.
 *
 * `tsIntelActive` is the live state of the TypeScript service, not a static
 * capability: while it is starting, or after it failed, a .ts file honestly
 * falls back to B rather than promising a hover that will never come.
 */
export function tierFor(rel: string, tsIntelActive: boolean, rustActive = false): Tier {
  const lang = langIdFor(rel);
  if (!lang) return "none";
  if (tsIntelActive && TIER_A_LANGS.has(lang)) return "A";
  // Rust reaches tier A only while the bundled rust-analyzer is ANSWERING.
  // Not while it indexes and not when the bundle carries no server: in both
  // of those a .rs file honestly falls back to the grammar tier, which is
  // exactly what it had before the language server existed.
  if (rustActive && lang === "rust") return "A";
  return "B";
}

/** True when this path could reach tier A once the service is up. */
export function tierCouldBeA(rel: string): boolean {
  const lang = langIdFor(rel);
  return lang !== null && (TIER_A_LANGS.has(lang) || lang === "rust");
}

// ---------------------------------------------------------------- copy

const LABEL_KEY: Record<Tier, string> = {
  A: "tier.a.label",
  B: "tier.b.label",
  none: "tier.none.label",
};

const HINT_KEY: Record<Tier, string> = {
  A: "tier.a.hint",
  B: "tier.b.hint",
  none: "tier.none.hint",
};

// English fallbacks, so the badge is never blank and never a raw key even
// before the integrator adds the entries to i18n.ts. Both languages are
// declared in the integration note.
const FALLBACK: Record<string, string> = {
  "tier.a.label": "Full",
  "tier.b.label": "Syntax",
  "tier.none.label": "Plain",
  "tier.a.hint":
    "Types, hover, go to definition, references and rename, from a language service running inside the app.",
  "tier.b.hint":
    "Outline, breadcrumb and syntax errors, from the bundled grammar. No types, no cross-file resolution, no go to definition.",
  "tier.none.hint":
    "No bundled grammar for this file type: line numbers, search and undo only. Nothing is analysed.",
};

let translate: (key: string) => string = (key) => FALLBACK[key] ?? key;

/** Inject i18n.t at startup; the tests and headless callers keep the English. */
export function setTierTranslator(fn: (key: string) => string): void {
  translate = (key) => {
    const s = fn(key);
    return s && s !== key ? s : (FALLBACK[key] ?? key);
  };
}

export function tierLabel(tier: Tier): string {
  return translate(LABEL_KEY[tier]);
}

export function tierHint(tier: Tier): string {
  return translate(HINT_KEY[tier]);
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/**
 * The badge for the file header. Pure: string in, string out, testable without
 * a DOM. Reuses the existing `.fbadge` class from styles.css, with a `tier-*`
 * modifier so the design system can colour the three states later without any
 * change here.
 */
export function tierBadgeHtml(tier: Tier): string {
  return (
    `<span class="fbadge tier-${tier === "none" ? "none" : tier.toLowerCase()}" ` +
    `data-tier="${tier}" title="${esc(tierHint(tier))}">${esc(tierLabel(tier))}</span>`
  );
}
