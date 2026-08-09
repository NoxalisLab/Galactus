// Galactus — live preview panel (signature feature).
//
// When the assistant emits an HTML / SVG / Mermaid / markdown code block, the
// user can open it rendered, live, in a side panel. `show()` is cheap and
// idempotent: call it again with new code while the model is still typing and
// the panel updates in place ("live preview").
//
// Safety model:
//  - HTML is ONLY rendered inside <iframe sandbox="allow-scripts"> via
//    `srcdoc`. It never touches the host document, cannot navigate the app,
//    and has no same-origin access.
//  - SVG is parsed with DOMParser, sanitized (scripts, foreignObject, event
//    handlers, javascript:/data: hrefs removed), then inlined.
//  - Markdown goes through the app's own safe renderer (./markdown).
//  - Mermaid renders only if a mermaid runtime is already present on
//    `window` (no dependency is added); otherwise the source is shown with a
//    note.
//
// ───────────────────────────────────────────────────────────────────────────
// CSS — the integrator adds these classes to styles.css (this module does not
// touch styles.css itself). The panel host must be `position: relative`.
//
//   .pvw { position: absolute; top: 0; right: 0; bottom: 0; width: 46%;
//          min-width: 300px; max-width: 88%; display: flex; flex-direction: column;
//          background: var(--card); border-left: 1px solid var(--bd2);
//          box-shadow: -18px 0 40px rgba(0,0,0,.45); z-index: 40;
//          transform: translateX(105%); transition: transform .22s ease;
//          will-change: transform; }
//   .pvw.open { transform: translateX(0); }
//   .pvw-grip { position: absolute; left: -4px; top: 0; bottom: 0; width: 9px;
//          cursor: col-resize; z-index: 2; }
//   .pvw-grip:hover, .pvw.resizing .pvw-grip { background:
//          linear-gradient(90deg, transparent, rgba(138,124,255,.35), transparent); }
//   .pvw.resizing { transition: none; }
//   .pvw.resizing .pvw-frame { pointer-events: none; }
//   .pvw-head { height: 44px; flex: none; display: flex; align-items: center;
//          gap: 8px; padding: 0 12px 0 16px; border-bottom: 1px solid var(--bd);
//          background: var(--side); }
//   .pvw-title { flex: 1; min-width: 0; font-size: 12.5px; font-weight: 600;
//          color: var(--tx3); white-space: nowrap; overflow: hidden;
//          text-overflow: ellipsis; }
//   .pvw-kind { flex: none; font-family: var(--mono); font-size: 10px;
//          text-transform: uppercase; letter-spacing: .6px; color: var(--acc-tx);
//          background: rgba(138,124,255,.13); border-radius: 6px; padding: 2px 7px; }
//   .pvw-btn { flex: none; padding: 5px 10px; border-radius: 8px; font-size: 12px;
//          font-weight: 500; color: var(--tx2); background: rgba(255,255,255,.05);
//          border: 1px solid var(--bd3); cursor: default; transition: all .15s; }
//   .pvw-btn:hover { background: rgba(255,255,255,.09); color: var(--tx); }
//   .pvw-btn.pvw-x:hover { border-color: var(--bad); color: var(--bad); }
//   .pvw-body { flex: 1; min-height: 0; overflow: auto; background: var(--inset); }
//   .pvw-frame { display: block; width: 100%; height: 100%; border: 0;
//          background: #fff; }
//   .pvw-svg { display: flex; align-items: center; justify-content: center;
//          min-height: 100%; padding: 18px; }
//   .pvw-svg svg { max-width: 100%; height: auto; }
//   .pvw-md { padding: 18px 20px; max-width: 760px; }
//   .pvw-note { display: flex; align-items: center; gap: 8px; margin: 14px;
//          padding: 10px 13px; border: 1px dashed var(--bd3); border-radius: 10px;
//          color: var(--dim2); font-size: 12px; }
//   .pvw-src { margin: 0 14px 14px; padding: 12px 14px; border-radius: 10px;
//          background: var(--pre); border: 1px solid var(--bd);
//          font-family: var(--mono); font-size: 11.5px; line-height: 1.7;
//          color: #9a9aac; white-space: pre-wrap; word-break: break-word;
//          overflow: auto; }
// ───────────────────────────────────────────────────────────────────────────
//
// i18n — all visible strings live in i18n.ts (preview.* keys) and go
// through t(), like everywhere else in the app.

import { renderMarkdown, wireCodeCopy } from "./markdown";
import { t } from "./i18n";
import { api } from "./api";
import { wirePaneResizer } from "./layout/pane-resize";

/** Publish through the app scheme; rejects outside Tauri so srcdoc takes over. */
async function publishPreview(html: string): Promise<string> {
  const url = await api.previewPublish(html);
  if (!url) throw new Error("preview scheme unavailable");
  return url;
}

// ---------------------------------------------------------------- detection

export type PreviewKind = "html" | "svg" | "markdown" | "mermaid" | "none";

const SVG_START = /^(?:<\?xml[^>]*\?>\s*)?(?:<!DOCTYPE\s+svg[^>]*>\s*)?<svg[\s>]/i;
const HTML_DOC = /<!DOCTYPE\s+html|<html[\s>]/i;
const HTML_STRONGISH = /<(?:head|body)[\s>]/i;
const MERMAID_HEAD = new RegExp(
  "^(?:graph\\s+(?:TB|TD|BT|RL|LR)\\b|flowchart\\b|sequenceDiagram\\b|classDiagram\\b|" +
    "stateDiagram(?:-v2)?\\b|erDiagram\\b|gantt\\b|pie\\b|journey\\b|mindmap\\b|" +
    "timeline\\b|gitGraph\\b|quadrantChart\\b|xychart(?:-beta)?\\b|C4Context\\b)"
);

function firstMeaningfulLine(code: string): string {
  for (const raw of code.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("%%")) continue; // mermaid comments/directives
    return line;
  }
  return "";
}

/**
 * Decide whether a fenced code block can be previewed, from its declared
 * language AND its content. Conservative: a JS file that merely mentions
 * "<html>" in a string stays "none".
 */
export function detectPreviewable(code: string, lang: string): PreviewKind {
  const src = code.trim();
  if (!src) return "none";
  const l = (lang || "").trim().toLowerCase();
  const head = src.slice(0, 4000);

  if (l === "mermaid" || l === "mmd") return "mermaid";
  if (l === "markdown" || l === "md" || l === "mdown" || l === "gfm") return "markdown";
  if (l === "svg") return "svg";

  if (l === "html" || l === "htm" || l === "xhtml") {
    return SVG_START.test(head) ? "svg" : "html";
  }
  if (l === "xml") {
    if (SVG_START.test(head)) return "svg";
    if (HTML_DOC.test(head)) return "html";
    return "none";
  }

  // Unlabelled (or plain-text) block: sniff the content.
  if (l === "" || l === "text" || l === "txt" || l === "plain" || l === "plaintext") {
    if (SVG_START.test(head)) return "svg";
    if (HTML_DOC.test(head) || (head.startsWith("<") && HTML_STRONGISH.test(head))) return "html";
    if (MERMAID_HEAD.test(firstMeaningfulLine(src))) return "mermaid";
    return "none";
  }

  return "none";
}

// ---------------------------------------------------------------- sanitizing

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const URL_ATTRS = ["href", "xlink:href", "src"];

/** Parse and clean an SVG document. Returns a detached, safe <svg> node or null. */
function sanitizeSvg(code: string): SVGElement | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(code, "image/svg+xml");
  } catch {
    return null;
  }
  if (doc.querySelector("parsererror")) return null;
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg") return null;

  const walk = (el: Element): void => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase();
      // animate/set can rewrite href of a parent <a> at runtime (SMIL) —
      // their targets are not covered by the URL_ATTRS scan below.
      if (
        tag === "script" || tag === "foreignobject" || tag === "iframe" ||
        tag === "embed" || tag === "object" || tag === "animate" || tag === "set"
      ) {
        child.remove();
        continue;
      }
      walk(child);
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (URL_ATTRS.includes(name)) {
        // Strip control/space chars first: browsers ignore them when parsing
        // the scheme, so "java\tscript:" would sail past a plain startsWith.
        const v = attr.value.replace(/[\u0000-\u0020]/g, "").toLowerCase();
        if (v.startsWith("javascript:") || v.startsWith("data:text/html") || v.startsWith("vbscript:")) {
          el.removeAttribute(attr.name);
        }
      }
    }
  };
  walk(root);
  // Root attributes too (onload etc.).
  for (const attr of Array.from(root.attributes)) {
    if (attr.name.toLowerCase().startsWith("on")) root.removeAttribute(attr.name);
  }
  return root as unknown as SVGElement;
}

// ---------------------------------------------------------------- mermaid

interface MermaidLike {
  render(id: string, src: string): Promise<{ svg: string }>;
}

function getMermaid(): MermaidLike | null {
  const w = window as unknown as { mermaid?: Partial<MermaidLike> };
  return w.mermaid && typeof w.mermaid.render === "function" ? (w.mermaid as MermaidLike) : null;
}

// ---------------------------------------------------------------- panel

const MIN_W = 300;
let mermaidSeq = 0;

export class PreviewPanel {
  private host: HTMLElement;
  private root: HTMLElement;
  private head: HTMLElement;
  private titleEl: HTMLElement;
  private kindEl: HTMLElement;
  private body: HTMLElement;
  private grip: HTMLElement;
  private frame: HTMLIFrameElement | null = null;

  private open = false;
  private destroyed = false;
  private code = "";
  private kind: PreviewKind = "none";
  private renderToken = 0;
  private blobUrl: string | null = null;

  private resizeCleanup: (() => void) | null = null;

  constructor(host: HTMLElement) {
    this.host = host;

    this.root = document.createElement("aside");
    this.root.className = "pvw";
    this.root.setAttribute("role", "complementary");

    this.grip = document.createElement("div");
    this.grip.className = "pvw-grip";

    this.head = document.createElement("div");
    this.head.className = "pvw-head";

    this.titleEl = document.createElement("div");
    this.titleEl.className = "pvw-title";

    this.kindEl = document.createElement("span");
    this.kindEl.className = "pvw-kind";

    const btnRefresh = this.button(t("preview.refresh"), "pvw-refresh");
    const btnOpen = this.button(t("preview.openBrowser"), "pvw-open");
    const btnClose = this.button(t("preview.close"), "pvw-x");

    this.head.append(this.titleEl, this.kindEl, btnRefresh, btnOpen, btnClose);

    this.body = document.createElement("div");
    this.body.className = "pvw-body";

    this.root.append(this.grip, this.head, this.body);
    host.appendChild(this.root);

    // Listeners (bound arrow fields — removed in destroy()).
    this.head.addEventListener("click", this.onHeadClick);
    this.resizeCleanup = wirePaneResizer({
      handle: this.grip,
      container: this.host,
      pane: this.root,
      edge: "after",
      setting: "ui_preview_width",
      label: t("layout.resizePreview"),
      hint: t("layout.resizeHint"),
      min: MIN_W,
      max: 1200,
      defaultSize: Math.max(MIN_W, Math.round(this.host.clientWidth * 0.46)),
      reserved: () => Math.max(240, Math.round(this.host.clientWidth * 0.12)),
    });
    document.addEventListener("keydown", this.onKeyDown);
  }

  // ------------------------------------------------------------ public API

  /**
   * Show (or live-update) the preview. Safe to call repeatedly with new code:
   * the panel and, for HTML, the iframe are reused — no flicker, no rebuild.
   */
  show(code: string, kind: PreviewKind, title?: string): void {
    if (this.destroyed) return;
    const kindChanged = kind !== this.kind;
    const codeChanged = code !== this.code;
    this.code = code;
    this.kind = kind;
    this.titleEl.textContent = title ?? t("preview.title");
    this.kindEl.textContent = kind === "none" ? "" : kind;
    this.kindEl.style.display = kind === "none" ? "none" : "";
    if (kindChanged || codeChanged || !this.open) this.renderContent();
    if (!this.open) {
      this.open = true;
      // Two frames so the initial transform is committed before transitioning.
      requestAnimationFrame(() => {
        if (!this.destroyed) this.root.classList.add("open");
      });
    }
  }

  hide(): void {
    if (this.destroyed || !this.open) return;
    this.open = false;
    this.root.classList.remove("open");
  }

  isOpen(): boolean {
    return this.open;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.open = false;
    this.renderToken++;
    this.head.removeEventListener("click", this.onHeadClick);
    this.resizeCleanup?.();
    this.resizeCleanup = null;
    document.removeEventListener("keydown", this.onKeyDown);
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }
    this.frame = null;
    this.root.remove();
  }

  // ------------------------------------------------------------ rendering

  private renderContent(): void {
    const token = ++this.renderToken;
    switch (this.kind) {
      case "html":
        this.renderHtml();
        break;
      case "svg":
        this.renderSvg();
        break;
      case "markdown":
        this.renderMd();
        break;
      case "mermaid":
        this.renderMermaid(token);
        break;
      default:
        this.frame = null;
        this.body.innerHTML = "";
        this.body.append(this.note(t("preview.empty")));
    }
  }

  /**
   * HTML only ever renders inside a sandboxed iframe. The document is served
   * by the app's own preview scheme rather than written into `srcdoc`: a
   * srcdoc document INHERITS the app's content policy, which allows nothing
   * external, so every previewed page silently lost its images, fonts,
   * stylesheets and scripts. Served over its own scheme it carries its own
   * policy and renders like a browser would.
   *
   * The isolation never depended on that policy: allow-scripts WITHOUT
   * allow-same-origin keeps the frame in an opaque origin with no access to
   * the app and no IPC. srcdoc stays as the fallback outside Tauri (dev
   * harness) or if publishing fails.
   */
  private renderHtml(): void {
    if (!this.frame || this.frame.parentElement !== this.body) {
      this.body.innerHTML = "";
      const f = document.createElement("iframe");
      f.className = "pvw-frame";
      f.setAttribute("sandbox", "allow-scripts");
      f.setAttribute("referrerpolicy", "no-referrer");
      this.body.appendChild(f);
      this.frame = f;
    }
    const frame = this.frame;
    const token = ++this.renderToken;
    const code = this.code;
    publishPreview(code)
      .then((url) => {
        // A newer render (or a destroy) won the race: leave its document up.
        if (this.destroyed || token !== this.renderToken || this.frame !== frame) return;
        frame.removeAttribute("srcdoc");
        frame.src = url;
      })
      .catch(() => {
        if (this.destroyed || token !== this.renderToken || this.frame !== frame) return;
        if (frame.srcdoc !== code) frame.srcdoc = code;
      });
  }

  private renderSvg(): void {
    this.frame = null;
    this.body.innerHTML = "";
    const clean = sanitizeSvg(this.code);
    if (clean) {
      const wrap = document.createElement("div");
      wrap.className = "pvw-svg";
      wrap.appendChild(document.importNode(clean, true));
      this.body.appendChild(wrap);
    } else {
      this.body.append(this.note(t("preview.svgError")), this.source(this.code));
    }
  }

  private renderMd(): void {
    this.frame = null;
    this.body.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "pvw-md msg-body";
    wrap.innerHTML = renderMarkdown(this.code);
    this.body.appendChild(wrap);
    wireCodeCopy(this.body, t("preview.copied"));
  }

  private renderMermaid(token: number): void {
    this.frame = null;
    this.body.innerHTML = "";
    const mermaid = getMermaid();
    if (!mermaid) {
      this.body.append(this.note(t("preview.mermaidMissing")), this.source(this.code));
      return;
    }
    const src = this.code;
    mermaid
      .render("gx-mermaid-" + ++mermaidSeq, src)
      .then(({ svg }) => {
        // Stale? (panel destroyed, closed+reopened with other content, etc.)
        if (this.destroyed || token !== this.renderToken) return;
        const clean = sanitizeSvg(svg);
        this.body.innerHTML = "";
        if (clean) {
          const wrap = document.createElement("div");
          wrap.className = "pvw-svg";
          wrap.appendChild(document.importNode(clean, true));
          this.body.appendChild(wrap);
        } else {
          this.body.append(this.note(t("preview.mermaidError")), this.source(src));
        }
      })
      .catch(() => {
        if (this.destroyed || token !== this.renderToken) return;
        this.body.innerHTML = "";
        this.body.append(this.note(t("preview.mermaidError")), this.source(src));
      });
  }

  private note(text: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "pvw-note";
    el.textContent = text;
    return el;
  }

  private source(code: string): HTMLElement {
    const pre = document.createElement("pre");
    pre.className = "pvw-src";
    pre.textContent = code; // textContent: no escaping pitfalls
    return pre;
  }

  private button(label: string, extra: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pvw-btn " + extra;
    b.textContent = label;
    b.title = label;
    return b;
  }

  // ------------------------------------------------------------ actions

  private onHeadClick = (e: MouseEvent): void => {
    const btn = (e.target as HTMLElement).closest(".pvw-btn");
    if (!btn) return;
    if (btn.classList.contains("pvw-x")) {
      this.hide();
    } else if (btn.classList.contains("pvw-refresh")) {
      // Full re-render; for HTML this re-runs the document's scripts.
      if (this.frame) {
        const doc = this.code;
        this.frame.srcdoc = "";
        this.frame.srcdoc = doc;
      } else {
        this.renderContent();
      }
    } else if (btn.classList.contains("pvw-open")) {
      this.openInBrowser();
    }
  };

  private openInBrowser(): void {
    let mime = "text/plain;charset=utf-8";
    let payload = this.code;
    if (this.kind === "html") {
      mime = "text/html;charset=utf-8";
    } else if (this.kind === "svg") {
      const clean = sanitizeSvg(this.code);
      if (clean) payload = new XMLSerializer().serializeToString(clean);
      mime = "image/svg+xml;charset=utf-8";
    } else if (this.kind === "markdown") {
      mime = "text/html;charset=utf-8";
      payload =
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>" +
        esc(this.titleEl.textContent ?? "") +
        "</title><style>body{font:15px/1.6 -apple-system,sans-serif;max-width:760px;" +
        "margin:40px auto;padding:0 20px;color:#1c1c22}pre{background:#f4f4f7;" +
        "padding:12px 14px;border-radius:8px;overflow:auto}code{font-family:ui-monospace,Menlo,monospace}" +
        "</style></head><body>" +
        renderMarkdown(this.code) +
        "</body></html>";
    }
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    this.blobUrl = URL.createObjectURL(new Blob([payload], { type: mime }));
    window.open(this.blobUrl, "_blank", "noopener");
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.open) {
      // Don't steal Escape from modals: only close when nothing above us.
      const modal = document.querySelector(".modal-bd, dialog[open]");
      if (!modal) this.hide();
    }
  };

}
