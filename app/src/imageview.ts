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

import { api, onEvent, type HwInfo, type ImageModelInfo, type ImageRequest } from "./api";
import { getLang, t } from "./i18n";

/**
 * A registry text in the user's language. Notes and licences ship as
 * `{en, fr}` because the card shows them verbatim; the bare-string form is
 * kept working so an older registry file degrades to itself rather than to
 * "[object Object]".
 */
function inLang(v: string | { en: string; fr: string } | null | undefined): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  return v[getLang() as "en" | "fr"] ?? v.en ?? "";
}
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
import { confirmDestructive } from "./confirm";
import { clipLabel, defaultsFor, fmtSeconds, framePresets, sizeLabel, sizePresets } from "./image-plan";

export interface ImageDeps {
  root: () => string | null;
  toast: (msg: string, kind?: "err" | "ok") => void;
}

let models: ImageModelInfo[] = [];
/** Set once per session: whether this build carries the engine at all. */
let enginePresent: boolean | null = null;
/**
 * The machine, for the "this Mac has N GB" half of a blocked model's sentence.
 * Fetched once, like the Models view does: soldered memory does not move while
 * the app runs. Null only when hw_info itself failed, and the card then falls
 * back to the backend's English reason rather than showing a blank.
 */
let hw: HwInfo | null = null;
/** The live element, so a repaint after an await never targets a detached one. */
let liveWrap: HTMLElement | null = null;
/** Download progress, straight from the backend. */
let installPct: { pct: number; done: number; bytes: number } | null = null;
let gallery: string[] = [];
let chosen = "";
let busy = false;
let progress: { done: number; total: number } | null = null;
let installing: string | null = null;
let deps: ImageDeps | null = null;
let unlisten: (() => void) | null = null;
/** Starting picture for the video models that animate one. Per session. */
let initImage = "";
/** Driving WAV for the speech-to-video models. Per session. */
let refAudio = "";

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
  liveWrap = wrap;
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
      paintProgress();
    } else if (p?.kind === "install") {
      installPct = {
        pct: Number(p.pct) || 0,
        done: Number(p.done) || 0,
        bytes: Number(p.bytes) || 0,
      };
      paintInstall();
    } else if (p?.kind === "installed" || p?.kind === "done" || p?.kind === "failed" || p?.kind === "cancelled") {
      progress = null;
      void refresh();
    }
  }).then((off) => {
    if (dead) off();
    else unlisten = () => { dead = true; off(); };
  });
}

async function refresh(_wrap?: HTMLElement): Promise<void> {
  // The live element, never the one captured when the click happened: leaving
  // the view during a download and coming back used to repaint a detached node,
  // leaving the visible button stuck on "Downloading" forever.
  const wrap = liveWrap;
  if (!wrap) return;
  if (enginePresent === null) {
    enginePresent = await api.imageEnginePresent().catch(() => false);
  }
  if (!enginePresent) {
    paint(
      wrap,
      `<div class="empty-block"><span class="big">◇</span><b>${esc(t("img.noEngine"))}</b><span>${esc(t("img.noEngineHint"))}</span></div>`,
    );
    return;
  }
  if (!hw) {
    hw = await api.hwInfo().catch(() => null);
  }
  try {
    models = await api.imageModels();
  } catch (e: any) {
    models = [];
    paint(wrap, `<div class="cerror"><b>${esc(t("img.noRegistry"))}</b><span class="mono">${esc(String(e?.message ?? e))}</span></div>`);
    return;
  }
  if (!chosen || !models.some((m) => m.id === chosen)) {
    // Installed AND usable first: opening the view on a model this machine
    // cannot run would start every session with a disabled prompt.
    chosen =
      (models.find((m) => m.installed && m.usable) ??
        models.find((m) => m.usable) ??
        models[0])?.id ?? "";
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

/**
 * Why a model is blocked here, as the sentence the LLM cards get: what it
 * needs against what this Mac has. The backend's English reason is the
 * fallback for the rare case where hw_info itself failed.
 */
function blockedLine(m: ImageModelInfo): string {
  return hw
    ? t("img.tooBig").replace("%n", String(m.need_gb)).replace("%r", String(hw.ram_gb))
    : m.reason;
}

function modelCard(m: ImageModelInfo): string {
  const gb = (m.bytes / 1e9).toFixed(1);
  const fastest = m.measured.find((x) => x.seconds);
  const speed = fastest
    ? t("img.measured")
        .replace("%t", fmtSeconds(fastest.seconds ?? 0))
        .replace("%s", sizeLabel(fastest.width ?? 0, fastest.height ?? 0))
    : t("img.notMeasured");
  // The same verdict the LLM cards carry: what this MACHINE can do with the
  // model, next to what the model is. A usable model says how far it goes
  // here; a blocked one wears the chip and says why underneath. For a video
  // model the useful half of the verdict is time, not pixels.
  const fit = !m.usable
    ? ""
    : m.video
      ? ` · ${esc(t("img.fitsClip").replace("%s", clipLabel(m.max_frames, m.video.fps)))}`
      : ` · ${esc(t("img.fitsUpTo").replace("%s", sizeLabel(m.max_side, m.max_side)))}`;
  const videoChip = m.video ? `<span class="chip-cert">▸ ${esc(t("img.videoChip"))}</span>` : "";
  return `<div class="mcard ${m.id === chosen ? "on" : ""}" data-pick="${esc(m.id)}">
    <div class="top"><div class="info">
      <div class="nm"><b>${esc(m.name)}</b>${videoChip}${m.usable ? "" : `<span class="chip-cert pending">✕ ${esc(t("img.blockedChip"))}</span>`}${m.installed ? "" : `<span class="chip-cert pending">◷ ${esc(t("img.notInstalled"))}</span>`}</div>
      <span class="meta">${gb} GB · ${esc(speed)}${fit}</span>
    </div><span data-a></span></div>
    <div class="brief">${esc(inLang(m.note))}</div>
    ${inLang(m.licence) ? `<div class="brief blocked">${esc(t("img.licenceLine"))} ${esc(inLang(m.licence))}</div>` : ""}
    ${m.usable ? "" : `<div class="brief blocked">${esc(blockedLine(m))}</div>`}
  </div>`;
}

function bodyHtml(): string {
  const m = current();
  const d = defaultsFor(m);
  const cards = models.map(modelCard).join("");
  // Startable means installed AND within this machine, exactly the pair the
  // LLM list uses: an installed model too big for the Mac would otherwise
  // offer a Generate button whose only outcome is a swap spiral.
  const canRun = !!m?.installed && !!m?.usable;
  // The sizes offered stop at what image_plan says this machine can decode,
  // and the model's own default is capped the same way, so the selected entry
  // is always the largest thing that is both wanted and possible.
  const cap = m?.usable && m.max_side ? m.max_side : 2048;
  const dw = Math.min(d.width, cap);
  const dh = Math.min(d.height, cap);
  // A machine near its memory opens with the shorter run the plan suggested;
  // the input stays editable, this is a starting point rather than a wall.
  const steps = m?.recommended_steps ?? d.steps;
  return `
  <div class="imgmodels">${cards}</div>
  ${
    m && !m.installed
      ? m.usable
        ? `<div class="card"><div class="hd"><div class="grow"><b>${esc(t("img.installTitle").replace("%s", m.name))}</b>
             <span class="d">${esc(t("img.installHint").replace("%g", (m.bytes / 1e9).toFixed(1)))}</span></div>
             ${installing === m.id ? `<button class="bs" id="imginstallstop">${esc(t("img.stop"))}</button>` : ""}
             <button class="bp" id="imginstall" ${installing ? "disabled" : ""}>${esc(installing === m.id ? t("img.installing") : t("img.install"))}</button></div></div>`
        : `<div class="card"><div class="hd"><div class="grow"><b>${esc(t("img.cantRunTitle").replace("%s", m.name))}</b>
             <span class="d">${esc(blockedLine(m))}</span></div></div></div>`
      : ""
  }
  <div class="card imgmake">
    <textarea id="imgprompt" rows="3" placeholder="${esc(t("img.promptPlaceholder"))}" ${canRun ? "" : "disabled"}></textarea>
    <div class="imgrow">
      <label>${esc(t("img.negative"))}<input id="imgneg" ${canRun ? "" : "disabled"} placeholder="${esc(t("img.negativePlaceholder"))}"/></label>
    </div>
    <div class="imgrow">
      ${
        m?.video
          ? // A video model was trained at one shape and diverges away from
            // it, so the shape is stated rather than offered, and the choice
            // that matters, how LONG, takes the row instead. The list opens
            // on about a second, not on the trained length: the VAE decode
            // grows with the frame count (784 of TI2V's measured 873 seconds
            // were the decode alone), and a first click that runs most of an
            // hour reads as a hang, exactly the recommended_steps reasoning.
            m.video.duration_follows_audio
              ? `<span class="d">${esc(t("img.durationFromWav"))} · ${esc(sizeLabel(dw, dh))} · ${m.video.fps} fps</span>`
              : (() => {
              const presets = framePresets(m.video, m.max_frames || m.video.frames);
              const first = presets.find((f) => f >= m.video!.fps) ?? presets[0];
              return `<label>${esc(t("img.duration"))}<select id="imgframes" ${canRun ? "" : "disabled"}>${presets
                .map((f) => `<option value="${f}" ${f === first ? "selected" : ""}>${esc(clipLabel(f, m.video!.fps))} · ${f}</option>`)
                .join("")}</select></label>
              <span class="d">${esc(sizeLabel(dw, dh))} · ${m.video!.fps} fps</span>`;
            })()
          : `<label>${esc(t("img.size"))}<select id="imgsize" ${canRun ? "" : "disabled"}>${sizePresets(dw, dh, cap)
              .map((p) => `<option value="${p.w}x${p.h}" ${p.w === dw && p.h === dh ? "selected" : ""}>${esc(sizeLabel(p.w, p.h))}</option>`)
              .join("")}</select></label>`
      }
      <label>${esc(t("img.steps"))}<input id="imgsteps" type="number" min="1" max="100" value="${steps}" ${canRun ? "" : "disabled"}/></label>
      <label>${esc(t("img.cfg"))}<input id="imgcfg" type="number" min="0" max="30" step="0.5" value="${d.cfg}" ${canRun ? "" : "disabled"}/></label>
      <label>${esc(t("img.seed"))}<input id="imgseed" type="number" value="-1" ${canRun ? "" : "disabled"}/></label>
      ${m?.video?.fast_decode ? `<label class="chk"><input type="checkbox" id="imgfast" checked ${canRun ? "" : "disabled"}/>${esc(t("img.fastDecode"))}</label>` : ""}
    </div>
    ${
      m?.video?.needs_ref_audio
        ? `<div class="imgrow">
            <span class="d">${esc(t("img.audioNeeded"))}</span>
            <button class="bs" id="imgpickaudio" ${canRun ? "" : "disabled"}>${esc(refAudio ? t("img.audioChange") : t("img.audioPick"))}</button>
            ${refAudio ? `<span class="d mono">${esc(refAudio.split("/").pop() ?? "")}</span><button class="bs" id="imgaudioclear">✕</button>` : ""}
          </div>`
        : ""
    }
    ${
      m?.video && (m.video.needs_init_image || m.video.accepts_init_image)
        ? `<div class="imgrow">
            <span class="d">${esc(m.video.needs_init_image ? t("img.startNeeded") : t("img.startOptional"))}</span>
            <button class="bs" id="imgpickstart" ${canRun ? "" : "disabled"}>${esc(initImage ? t("img.startChange") : t("img.startPick"))}</button>
            ${initImage ? `<span class="d mono" id="imgstartpath">${esc(initImage.split("/").pop() ?? "")}</span><button class="bs" id="imgstartclear">✕</button>` : ""}
          </div>`
        : ""
    }
    <div class="imgacts">
      <span class="d" id="imgstatus">${esc(
        busy && m?.video
          ? t("img.workingVideo")
          : canRun
            ? t("img.ready")
            : m && !m.usable
              ? blockedLine(m)
              : t("img.pickInstalled"),
      )}</span>
      <span class="grow"></span>
      ${busy ? `<button class="bs" id="imgstop">${esc(t("img.stop"))}</button>` : ""}
      <button class="bp" id="imggo" ${canRun && !busy ? "" : "disabled"}>${esc(busy ? t("img.working") : t("img.generate"))}</button>
    </div>
  </div>
  <div class="sect"><b>${esc(t("img.gallery"))}</b><span>${esc(t("img.galleryHint"))}</span></div>
  <div class="imggrid" id="imggrid">${
    gallery.length
      ? gallery.slice(0, GALLERY_PAGE).map((p) => `<figure class="imgcell" data-img="${esc(p)}" title="${esc(t("img.open"))}" role="button" tabindex="0"><div class="ph"></div></figure>`).join("")
      : `<div class="cempty">${esc(t("img.galleryEmpty"))}</div>`
  }</div>`;
}

function paintInstall(): void {
  const box = liveWrap?.querySelector<HTMLElement>("#imginstall");
  if (!box || !installPct) return;
  const gb = (n: number) => (n / 1e9).toFixed(1);
  box.textContent = t("img.installingPct")
    .replace("%p", String(Math.round(installPct.pct)))
    .replace("%a", gb(installPct.done))
    .replace("%b", gb(installPct.bytes));
}

function paintProgress(): void {
  const box = liveWrap?.querySelector<HTMLElement>("#imgstatus");
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
    if (target.closest("#imginstallstop")) {
      void api.imageInstallCancel();
      return;
    }
    if (target.closest("#imginstall")) {
      void install();
      return;
    }
    if (target.closest("#imgpickstart")) {
      void api
        .pickImage()
        .then((p) => {
          if (p) {
            initImage = p;
            repaint();
          }
        })
        .catch((e: any) => deps?.toast(String(e?.message ?? e)));
      return;
    }
    if (target.closest("#imgstartclear")) {
      initImage = "";
      repaint();
      return;
    }
    if (target.closest("#imgpickaudio")) {
      void api
        .pickAudio()
        .then((p) => {
          if (p) {
            refAudio = p;
            repaint();
          }
        })
        .catch((e: any) => deps?.toast(String(e?.message ?? e)));
      return;
    }
    if (target.closest("#imgaudioclear")) {
      refAudio = "";
      repaint();
      return;
    }
    if (target.closest("#imggo")) {
      void generate();
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
      return;
    }
    if (cell) {
      // A plain click opens it. Checked AFTER the alt-click branch, so the
      // modifier keeps meaning delete and never both.
      openLightbox(gallery.indexOf(cell.dataset.img!));
    }
  });
  // The tiles say role="button" and carry a tabindex, so Return and Space have
  // to work: an element that announces itself as a button and answers no key is
  // worse than a plain image, because a screen reader will offer it.
  box.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const cell = (e.target as HTMLElement).closest("[data-img]") as HTMLElement | null;
    if (!cell) return;
    e.preventDefault();
    openLightbox(gallery.indexOf(cell.dataset.img!));
  });
  void decodeVisible(wrap);
}

/**
 * One picture, filling the window.
 *
 * WHY. A generated image is 512 or 1024 square and the gallery shows it in a
 * grid tile a few hundred pixels wide, which is not enough to judge the thing
 * you just waited thirty seconds for. Clicking did nothing at all: the only
 * gesture the grid had was alt-click, and that DELETES. So the obvious click
 * was the one action with no result, and the destructive one was the only one
 * bound.
 *
 * Keyboard first, since this is a viewer and the hands are already there:
 * arrows move through the gallery, escape closes, and focus is trapped and
 * returned like every other dialog in the app.
 */
function openLightbox(startAt: number): void {
  if (gallery.length === 0) return;
  let at = Math.max(0, Math.min(startAt, gallery.length - 1));
  const previous = document.activeElement as HTMLElement | null;

  const back = el(`<div class="lightbox" role="dialog" aria-modal="true" aria-label="${esc(t("img.open"))}">
    <div class="lb-bar">
      <span class="lb-count"></span>
      <span class="lb-hint">${esc(t("img.lbHint"))}</span>
      <button class="lb-btn" data-lb="close" title="${esc(t("img.lbClose"))}" aria-label="${esc(t("img.lbClose"))}">✕</button>
    </div>
    <button class="lb-nav prev" data-lb="prev" aria-label="${esc(t("img.lbPrev"))}">‹</button>
    <figure class="lb-stage"></figure>
    <button class="lb-nav next" data-lb="next" aria-label="${esc(t("img.lbNext"))}">›</button>
  </div>`);

  const stage = back.querySelector<HTMLElement>(".lb-stage")!;
  const count = back.querySelector<HTMLElement>(".lb-count")!;
  const prev = back.querySelector<HTMLElement>('[data-lb="prev"]')!;
  const next = back.querySelector<HTMLElement>('[data-lb="next"]')!;

  // A token per show: the decode is async, so arrowing quickly through the
  // gallery can land an older answer after a newer one and show the wrong
  // picture. Only the most recent request is allowed to paint.
  let token = 0;
  const show = async (): Promise<void> => {
    const mine = ++token;
    count.textContent = t("img.lbCount")
      .replace("%i", String(at + 1))
      .replace("%n", String(gallery.length));
    prev.toggleAttribute("disabled", at === 0);
    next.toggleAttribute("disabled", at >= gallery.length - 1);
    try {
      const url = await api.imageRead(gallery[at]);
      if (mine !== token) return;
      if (gallery[at].endsWith(".webm")) {
        // Full controls and sound here: the lightbox is the one place a clip
        // is actually watched rather than glanced at.
        const vid = document.createElement("video");
        vid.src = url;
        vid.controls = true;
        vid.autoplay = true;
        vid.playsInline = true;
        stage.replaceChildren(vid);
        // The soundtrack, when the clip has one. H3's audio arrives as a WAV
        // beside the WebM because WKWebView refuses PCM inside it (measured:
        // MEDIA_ERR_SRC_NOT_SUPPORTED on the muxed file). The pair is kept in
        // step through the video's own transport events, so the controls the
        // user sees drive both.
        void api
          .imageRead(gallery[at].replace(/\.webm$/, ".wav"))
          .then((wavUrl) => {
            if (mine !== token) return;
            const snd = new Audio(wavUrl);
            const align = (): void => {
              if (Math.abs(snd.currentTime - vid.currentTime) > 0.25) {
                snd.currentTime = vid.currentTime;
              }
            };
            vid.addEventListener("play", () => { align(); void snd.play().catch(() => undefined); });
            vid.addEventListener("pause", () => snd.pause());
            vid.addEventListener("seeked", align);
            vid.addEventListener("ratechange", () => { snd.playbackRate = vid.playbackRate; });
            // The stage owns the audio's lifetime: navigating or closing
            // replaces the stage children, and this keeps a handle so the
            // replaced clip does not keep singing underneath the next one.
            vid.addEventListener("emptied", () => snd.pause());
            const stop = new MutationObserver(() => {
              if (!vid.isConnected) {
                snd.pause();
                stop.disconnect();
              }
            });
            stop.observe(stage, { childList: true });
            if (!vid.paused) {
              align();
              void snd.play().catch(() => undefined);
            }
          })
          .catch(() => undefined); // a clip with no soundtrack is every Wan clip
      } else {
        const img = document.createElement("img");
        img.src = url;
        img.alt = "";
        stage.replaceChildren(img);
      }
    } catch {
      // Removed under us. Close rather than show a broken frame.
      if (mine === token) close();
    }
  };

  const close = (): void => {
    document.removeEventListener("keydown", onKey, true);
    back.remove();
    previous?.focus?.();
  };

  const move = (delta: number): void => {
    const to = at + delta;
    if (to < 0 || to >= gallery.length) return;
    at = to;
    void show();
  };

  function onKey(e: KeyboardEvent): void {
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      case "ArrowLeft":
        e.preventDefault();
        move(-1);
        return;
      case "ArrowRight":
        e.preventDefault();
        move(1);
        return;
      case "Tab": {
        // Trapped: the grid behind is still there and still reachable.
        const items = [...back.querySelectorAll<HTMLElement>("button:not([disabled])")];
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      default:
    }
  }

  back.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-lb]") as HTMLElement | null;
    if (btn?.dataset.lb === "close") return close();
    if (btn?.dataset.lb === "prev") return move(-1);
    if (btn?.dataset.lb === "next") return move(1);
    // The backdrop, meaning anywhere that is not the picture or a control.
    if (e.target === back || (e.target as HTMLElement).classList.contains("lb-stage")) close();
  });

  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(back);
  back.querySelector<HTMLElement>('[data-lb="close"]')!.focus();
  void show();
}

/** Decode the visible tiles. One command per image, newest first. */
async function decodeVisible(wrap: HTMLElement): Promise<void> {
  for (const cell of Array.from(wrap.querySelectorAll<HTMLElement>("[data-img]"))) {
    if (cell.querySelector("img,video")) continue;
    try {
      const url = await api.imageRead(cell.dataset.img!);
      // The src is assigned as a property, not interpolated into markup. It is
      // our own base64 either way, but a data URL in a template is the kind of
      // line that gets copied somewhere it is not.
      if (cell.dataset.img!.endsWith(".webm")) {
        // Muted and looping in the grid: a dozen tiles all playing sound
        // would be chaos, and the lightbox is where the audio belongs.
        const vid = document.createElement("video");
        vid.src = url;
        vid.muted = true;
        vid.loop = true;
        vid.autoplay = true;
        vid.playsInline = true;
        cell.replaceChildren(vid);
      } else {
        const img = document.createElement("img");
        img.src = url;
        img.alt = "";
        img.loading = "lazy";
        cell.replaceChildren(img);
      }
    } catch {
      // A file removed under us is not worth a dialog: the tile stays blank and
      // the next refresh drops it.
    }
  }
}

async function install(): Promise<void> {
  const m = current();
  if (!m || installing) return;
  // The licence, shown while the choice still costs nothing. H3's territory
  // clause restricts USE, not just distribution, so discovering it after a
  // forty gigabyte download would be finding out too late.
  const licence = inLang(m.licence);
  if (licence) {
    const ok = await confirmDestructive({
      title: t("img.licenceTitle").replace("%s", m.name),
      detail: licence,
      confirmLabel: t("img.licenceAccept"),
      danger: false,
    });
    if (!ok) return;
  }
  installing = m.id;
  installPct = null;
  repaint();
  try {
    await api.imageInstall(m.id);
    deps?.toast(t("img.installed").replace("%s", m.name), "ok");
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg !== "cancelled") deps?.toast(msg);
  }
  installing = null;
  installPct = null;
  await refresh();
}

/** Repaint the live view from current state. */
function repaint(): void {
  if (!liveWrap) return;
  paint(liveWrap, bodyHtml());
  wire(liveWrap);
}

async function generate(): Promise<void> {
  const wrap = liveWrap;
  const m = current();
  if (!wrap || !m || busy) return;
  if (!m.usable) {
    // The button is disabled, but this function is also reachable through a
    // stale repaint. Saying why beats silently doing nothing, and the Rust
    // side refuses too: this is the polite layer, not the load-bearing one.
    deps?.toast(blockedLine(m));
    return;
  }
  const num = (id: string, fallback: number): number => {
    const raw = wrap.querySelector<HTMLInputElement>(id)?.value ?? "";
    const v = Number(raw);
    return Number.isFinite(v) ? v : fallback;
  };
  // A video model renders at its trained shape; only an image one offers the
  // size select, so its absence falls back to the model's own defaults.
  const d = defaultsFor(m);
  const [w, h] = m.video
    ? [d.width, d.height]
    : (wrap.querySelector<HTMLSelectElement>("#imgsize")?.value ?? "512x512")
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
    frames: m.video ? num("#imgframes", m.video.frames) : 0,
    init_image: m.video ? initImage : "",
    ref_audio: m.video ? refAudio : "",
    fast: !!m.video?.fast_decode && (wrap.querySelector<HTMLInputElement>("#imgfast")?.checked ?? true),
  };
  if (!req.prompt.trim()) {
    deps?.toast(t("img.needPrompt"));
    return;
  }
  if (m.video?.needs_init_image && !initImage) {
    // The same sentence the backend would answer with, said before minutes
    // of model loading rather than after.
    deps?.toast(t("img.needStart"));
    return;
  }
  if (m.video?.needs_ref_audio && !refAudio) {
    deps?.toast(t("img.needAudio"));
    return;
  }
  busy = true;
  progress = null;
  repaint();
  try {
    await api.imageGenerate(req);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    // Cancelling is not a failure, and saying so would be noise.
    if (msg !== "cancelled") deps?.toast(msg);
  }
  busy = false;
  progress = null;
  await refresh();
}
