/**
 * The live preview: what the code in this workspace actually looks like.
 *
 * WHY IT EXISTS. Someone who asks the agent to build a page had to leave the
 * app to see it. Everything else about the Code view is a real editor, and the
 * one thing a person building a website does every thirty seconds was the one
 * thing it could not do.
 *
 * WHAT IT SHOWS, AND WHAT IT CANNOT. It serves the files on disk through the
 * app's own preview scheme, sealed: no http, no https, nothing leaves. A page
 * that pulls a font or a script from a CDN renders without them, and the header
 * says so rather than letting the author wonder why their type looks wrong. A
 * project with a dev server (Vite, Next) is not previewed here at all; that is
 * what the integrated terminal is for, and promising otherwise would be a lie
 * the first `npm run dev` exposes.
 *
 * IT SHOWS THE DISK, NOT THE EDITOR. A proposed diff the user has not accepted
 * is not on disk, so it is not in the preview. That is the first rule of this
 * whole view and not an oversight; the header counts the pending changes so the
 * gap is visible instead of puzzling.
 */

/** A device to check the layout against. Width and height are CSS pixels. */
export interface DevicePreset {
  id: string;
  label: string;
  width: number | null;
  height: number | null;
}

/**
 * The presets, and why these.
 *
 * Fill is the default because most of the time the question is "does it work",
 * not "does it work at 390". The three phones are the sizes that actually
 * differ: a small phone, the modern middle, and the largest. The tablet is
 * there because a two-column layout usually breaks first at 768.
 */
export const DEVICE_PRESETS: DevicePreset[] = [
  { id: "fill", label: "Fill", width: null, height: null },
  { id: "se", label: "375", width: 375, height: 667 },
  { id: "phone", label: "390", width: 390, height: 844 },
  { id: "max", label: "430", width: 430, height: 932 },
  { id: "tablet", label: "768", width: 768, height: 1024 },
];

/**
 * How much to shrink a device frame so it fits the pane it is drawn in.
 *
 * The frame is scaled, never resized: the iframe keeps its 390 CSS pixels, so
 * `@media (max-width: 420px)` answers the way it would on the phone. Resizing
 * it to fit would make the media queries describe the pane instead of the
 * device, which is the one thing this control exists to avoid.
 *
 * Never enlarged past 1: a 375px frame blown up to fill a wide pane would show
 * a mobile layout at desktop size and mean nothing at all.
 */
export function frameScale(deviceWidth: number, paneWidth: number, padding = 24): number {
  const room = paneWidth - padding;
  if (room <= 0 || deviceWidth <= 0) return 1;
  return Math.min(1, room / deviceWidth);
}

/**
 * The entry file to preview, given what is open and what the folder holds.
 *
 * The file the user is looking at wins when it is a page, because that is what
 * they are working on. Otherwise index.html, which is what a static site is.
 * Neither present means there is nothing to show, and the pane says so rather
 * than rendering an empty frame that looks like a broken page.
 */
export function chooseEntry(activeRel: string | null, topLevel: readonly string[]): string | null {
  if (activeRel && /\.html?$/i.test(activeRel)) return activeRel;
  const index = topLevel.find((n) => n.toLowerCase() === "index.html");
  if (index) return index;
  const anyPage = topLevel.find((n) => /\.html?$/i.test(n));
  return anyPage ?? null;
}

/**
 * Whether a written file should make the preview reload.
 *
 * Everything the page could possibly load, and nothing else. A README, a
 * .gitignore or a Rust file changing is not a reason to throw away the scroll
 * position of the page being looked at.
 */
export function affectsPreview(rel: string): boolean {
  return /\.(html?|css|js|mjs|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|wasm)$/i.test(rel);
}
