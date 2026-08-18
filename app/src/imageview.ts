/**
 * The Images view: a prompt, a model, and the pictures made so far.
 *
 * It reads like the model list because it is the same idea: a model you install
 * once, a measurement rather than a promise, and everything happening on this
 * machine. Nothing here reaches the network at generation time.
 *
 * The pure parts live in image-plan.ts and are tested there. This file is the
 * DOM and the wiring.
 */

import { api, onEvent, type ImageModelInfo, type ImageRequest } from "./api";
import { t } from "./i18n";
/**
 * Same two helpers as every other view in this app. Duplicated rather than
 * shared, exactly as runsview and learnedview do it: a module of two functions
 * that every view imports is a dependency for no gain.
 */
function el(html: string): HTMLElement {
  const d = document.createElement("div");
  d.innerHTML = html.trim();
  return d.firstElementChild as HTMLElement;
}

function esc(s: string): string {
  // Quotes too: this output lands inside attributes as well as in text.
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
import { defaultsFor, fmtSeconds, sizeLabel, sizePresets } from "./image-plan";

export interface ImageDeps {
  root: () => string | null;
  toast: (msg: string, kind?: "err" | "ok") => void;
}

let models: ImageModelInfo[] = [];
let gallery: string[] = [];
let chosen = "";
let busy = false;
let progress: { done: number; total: number } | null = null;
let installing: string | null = null;
let deps: ImageDeps | null = null;
let unlisten: (() => void) | null = null;

export function setImageDeps(d: ImageDeps): void {
  deps = d;
}

/** How many gallery images are decoded into the page at once. */
const GALLERY_PAGE = 12;

export function imageView(): HTMLElement {
  const wrap = el(`<div class="main">
    <div class="topbar" data-tauri-drag-region><span class="ttl">${esc(t("nav.images"))}</span><span class="sub">${esc(t("img.subtitle"))}</span></div>
    <div class="page"><div class="hold" id="imghold">
      <div class="sect"><b>${esc(t("img.sect"))}</b><span>${esc(t("img.sectHint"))}</span></div>
      <div id="imgbody"></div>
    </div></div>
  </div>`);
  void refresh(wrap);
  listen(wrap);
  return wrap;
}

/** Progress and completion arrive as events, not as a return value. */
function listen(wrap: HTMLElement): void {
  unlisten?.();
  unlisten = null;
  let dead = false;
  void onEvent("galactus://image", (p: any) => {
    if (dead) return;
    if (p?.kind === "step") {
      progress = { done: Number(p.done) || 0, total: Number(p.total) || 0 };
      paintProgress(wrap);
    } else if (p?.kind === "installed" || p?.kind === "done" || p?.kind === "failed" || p?.kind === "cancelled") {
      progress = null;
      void refresh(wrap);
    }
  }).then((off) => {
    if (dead) off();
    else unlisten = () => { dead = true; off(); };
  });
}

async function refresh(wrap: HTMLElement): Promise<void> {
  const root = deps?.root();
  if (!root) {
    paint(wrap, `<div class="empty-block"><span class="big">◇</span><b>${esc(t("img.noRoot"))}</b></div>`);
    return;
  }
  try {
    models = await api.imageModels(root);
  } catch (e: any) {
    models = [];
    paint(wrap, `<div class="cerror"><b>${esc(t("img.noRegistry"))}</b><span class="mono">${esc(String(e?.message ?? e))}</span></div>`);
    return;
  }
  if (!chosen || !models.some((m) => m.id === chosen)) {
    chosen = (models.find((m) => m.installed) ?? models[0])?.id ?? "";
  }
  try {
    gallery = await api.imageGallery();
  } catch {
    gallery = [];
  }
  paint(wrap, bodyHtml());
  wire(wrap);
}

function paint(wrap: HTMLElement, html: string): void {
  const box = wrap.querySelector<HTMLElement>("#imgbody");
  if (box) box.innerHTML = html;
}

function current(): ImageModelInfo | undefined {
  return models.find((m) => m.id === chosen);
}

function modelCard(m: ImageModelInfo): string {
  const gb = (m.bytes / 1e9).toFixed(1);
  const fastest = m.measured.find((x) => x.seconds);
  const speed = fastest
    ? t("img.measured")
        .replace("%t", fmtSeconds(fastest.seconds ?? 0))
        .replace("%s", sizeLabel(fastest.width ?? 0, fastest.height ?? 0))
    : t("img.notMeasured");
  return `<div class="mcard ${m.id === chosen ? "on" : ""}" data-pick="${esc(m.id)}">
    <div class="top"><div class="info">
      <div class="nm"><b>${esc(m.name)}</b>${m.installed ? "" : `<span class="chip-cert pending">◷ ${esc(t("img.notInstalled"))}</span>`}</div>
      <span class="meta">${gb} GB · ${esc(speed)}</span>
    </div><span data-a></span></div>
    <div class="brief">${esc(m.note)}</div>
  </div>`;
}

function bodyHtml(): string {
  const m = current();
  const d = defaultsFor(m);
  const cards = models.map(modelCard).join("");
  const canRun = !!m?.installed;
  return `
  <div class="imgmodels">${cards}</div>
  ${
    m && !m.installed
      ? `<div class="card"><div class="hd"><div class="grow"><b>${esc(t("img.installTitle").replace("%s", m.name))}</b>
           <span class="d">${esc(t("img.installHint").replace("%g", (m.bytes / 1e9).toFixed(1)))}</span></div>
           <button class="bp" id="imginstall" ${installing ? "disabled" : ""}>${esc(installing === m.id ? t("img.installing") : t("img.install"))}</button></div></div>`
      : ""
  }
  <div class="card imgmake">
    <textarea id="imgprompt" rows="3" placeholder="${esc(t("img.promptPlaceholder"))}" ${canRun ? "" : "disabled"}></textarea>
    <div class="imgrow">
      <label>${esc(t("img.negative"))}<input id="imgneg" ${canRun ? "" : "disabled"} placeholder="${esc(t("img.negativePlaceholder"))}"/></label>
    </div>
    <div class="imgrow">
      <label>${esc(t("img.size"))}<select id="imgsize" ${canRun ? "" : "disabled"}>${sizePresets(d.width, d.height)
        .map((p) => `<option value="${p.w}x${p.h}" ${p.w === d.width && p.h === d.height ? "selected" : ""}>${esc(sizeLabel(p.w, p.h))}</option>`)
        .join("")}</select></label>
      <label>${esc(t("img.steps"))}<input id="imgsteps" type="number" min="1" max="100" value="${d.steps}" ${canRun ? "" : "disabled"}/></label>
      <label>${esc(t("img.cfg"))}<input id="imgcfg" type="number" min="0" max="30" step="0.5" value="${d.cfg}" ${canRun ? "" : "disabled"}/></label>
      <label>${esc(t("img.seed"))}<input id="imgseed" type="number" value="-1" ${canRun ? "" : "disabled"}/></label>
    </div>
    <div class="imgacts">
      <span class="d" id="imgstatus">${esc(canRun ? t("img.ready") : t("img.pickInstalled"))}</span>
      <span class="grow"></span>
      ${busy ? `<button class="bs" id="imgstop">${esc(t("img.stop"))}</button>` : ""}
      <button class="bp" id="imggo" ${canRun && !busy ? "" : "disabled"}>${esc(busy ? t("img.working") : t("img.generate"))}</button>
    </div>
  </div>
  <div class="sect"><b>${esc(t("img.gallery"))}</b><span>${esc(t("img.galleryHint"))}</span></div>
  <div class="imggrid" id="imggrid">${
    gallery.length
      ? gallery.slice(0, GALLERY_PAGE).map((p) => `<figure class="imgcell" data-img="${esc(p)}"><div class="ph"></div></figure>`).join("")
      : `<div class="cempty">${esc(t("img.galleryEmpty"))}</div>`
  }</div>`;
}

function paintProgress(wrap: HTMLElement): void {
  const box = wrap.querySelector<HTMLElement>("#imgstatus");
  if (!box || !progress) return;
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  box.textContent = t("img.progress")
    .replace("%d", String(progress.done))
    .replace("%n", String(progress.total))
    .replace("%p", String(pct));
}

function wire(wrap: HTMLElement): void {
  const box = wrap.querySelector<HTMLElement>("#imgbody");
  if (!box) return;
  box.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const pick = target.closest("[data-pick]") as HTMLElement | null;
    if (pick) {
      chosen = pick.dataset.pick!;
      paint(wrap, bodyHtml());
      wire(wrap);
      void decodeVisible(wrap);
      return;
    }
    if (target.closest("#imginstall")) {
      void install(wrap);
      return;
    }
    if (target.closest("#imggo")) {
      void generate(wrap);
      return;
    }
    if (target.closest("#imgstop")) {
      void api.imageCancel();
      return;
    }
    const cell = target.closest("[data-img]") as HTMLElement | null;
    if (cell && e.altKey) {
      // Alt-click removes it. Deliberately not a visible button on every tile:
      // a delete control under the pointer in a grid is a picture lost to a
      // mis-click.
      void api.imageForget(cell.dataset.img!).then(() => refresh(wrap)).catch(() => undefined);
    }
  });
  void decodeVisible(wrap);
}

/** Decode the visible tiles. One command per image, newest first. */
async function decodeVisible(wrap: HTMLElement): Promise<void> {
  for (const cell of Array.from(wrap.querySelectorAll<HTMLElement>("[data-img]"))) {
    if (cell.querySelector("img")) continue;
    try {
      const url = await api.imageRead(cell.dataset.img!);
      // The src is assigned as a property, not interpolated into markup. It is
      // our own base64 either way, but a data URL in a template is the kind of
      // line that gets copied somewhere it is not.
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      img.loading = "lazy";
      cell.replaceChildren(img);
    } catch {
      // A file removed under us is not worth a dialog: the tile stays blank and
      // the next refresh drops it.
    }
  }
}

async function install(wrap: HTMLElement): Promise<void> {
  const root = deps?.root();
  const m = current();
  if (!root || !m || installing) return;
  installing = m.id;
  paint(wrap, bodyHtml());
  wire(wrap);
  try {
    await api.imageInstall(root, m.id);
    deps?.toast(t("img.installed").replace("%s", m.name), "ok");
  } catch (e: any) {
    deps?.toast(String(e?.message ?? e));
  }
  installing = null;
  await refresh(wrap);
}

async function generate(wrap: HTMLElement): Promise<void> {
  const root = deps?.root();
  const m = current();
  if (!root || !m || busy) return;
  const num = (id: string, fallback: number): number => {
    const raw = wrap.querySelector<HTMLInputElement>(id)?.value ?? "";
    const v = Number(raw);
    return Number.isFinite(v) ? v : fallback;
  };
  const [w, h] = (wrap.querySelector<HTMLSelectElement>("#imgsize")?.value ?? "512x512")
    .split("x")
    .map((n) => Number(n) || 512);
  const req: ImageRequest = {
    model: m.id,
    prompt: wrap.querySelector<HTMLTextAreaElement>("#imgprompt")?.value ?? "",
    negative: wrap.querySelector<HTMLInputElement>("#imgneg")?.value ?? "",
    steps: num("#imgsteps", 20),
    cfg: num("#imgcfg", 7),
    width: w,
    height: h,
    seed: num("#imgseed", -1),
  };
  if (!req.prompt.trim()) {
    deps?.toast(t("img.needPrompt"));
    return;
  }
  busy = true;
  progress = null;
  paint(wrap, bodyHtml());
  wire(wrap);
  try {
    await api.imageGenerate(root, req);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    // Cancelling is not a failure, and saying so would be noise.
    if (msg !== "cancelled") deps?.toast(msg);
  }
  busy = false;
  progress = null;
  await refresh(wrap);
}
