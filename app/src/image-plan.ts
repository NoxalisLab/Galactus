/**
 * The arithmetic behind the Images view: default settings, the sizes offered,
 * and how a measurement is worded.
 *
 * Pure and tested, because these are the parts that quietly go wrong: a model
 * whose registry entry has no defaults must still open with something sensible,
 * and a size list that does not contain the model's own default would silently
 * change what the user asked for.
 */

export interface ImageDefaults {
  steps: number;
  cfg: number;
  width: number;
  height: number;
}

/** What a model opens with. Its own defaults, or values that work anywhere. */
export function defaultsFor(m: { defaults?: Partial<ImageDefaults> } | undefined): ImageDefaults {
  const d = m?.defaults ?? {};
  return {
    steps: clamp(d.steps ?? 20, 1, 100),
    cfg: clamp(d.cfg ?? 7, 0, 30),
    width: clamp(d.width ?? 512, 64, 2048),
    height: clamp(d.height ?? 512, 64, 2048),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : lo;
}

/**
 * The sizes offered, always including the model's own default.
 *
 * A list that omitted it would quietly generate something other than what the
 * model was measured at, and the first thing a user compares is the time.
 *
 * `maxSide` is the ceiling the backend's image_plan computed for this machine:
 * a preset above it would be an invitation to a generation the Rust side will
 * clamp anyway, so it is simply not offered. The caller caps the default it
 * passes in the same way, which keeps the "default is always present" rule
 * true for the default this machine can actually reach.
 */
export function sizePresets(width: number, height: number, maxSide = 2048): Array<{ w: number; h: number }> {
  const base = [
    { w: 512, h: 512 },
    { w: 768, h: 768 },
    { w: 1024, h: 1024 },
    { w: 1024, h: 576 },
    { w: 576, h: 1024 },
  ];
  const has = base.some((p) => p.w === width && p.h === height);
  const out = (has ? base : [{ w: width, h: height }, ...base]).filter(
    (p) => Math.max(p.w, p.h) <= maxSide,
  );
  // A ceiling below every preset still needs one entry to render. 512 is the
  // floor image_plan itself uses, so this only shows for an unusable model,
  // whose selector is disabled anyway.
  return out.length ? out : [{ w: 512, h: 512 }];
}

/** "1024 x 1024", or "1024 x 576 (wide)" for the ones with a shape. */
export function sizeLabel(w: number, h: number): string {
  if (!w || !h) return "";
  return `${w} x ${h}`;
}

/**
 * The clip lengths offered, in frames, on the model's own grid.
 *
 * Video counts are not free-form: the engine accepts `step * k + base` and
 * silently rounds anything else up, so every option here is a count that
 * will render exactly as shown. The list walks the grid from about half a
 * second to `maxFrames`, thinning as it grows: nearby long clips differ by
 * seconds of rendering and pennies of content, so the ladder spaces out the
 * way SIDE_LADDER does rather than listing every rung.
 */
export function framePresets(
  v: { frames: number; frame_step: number; frame_base: number; fps: number },
  maxFrames: number,
): number[] {
  const step = Math.max(1, v.frame_step);
  const align = (n: number): number =>
    step * Math.ceil(Math.max(0, n - v.frame_base) / step) + v.frame_base;
  const out: number[] = [];
  // Half a second, one, two, three, five, ten seconds... then the ceiling.
  for (const secs of [0.5, 1, 2, 3, 5, 10, 15]) {
    const f = align(Math.round(secs * v.fps));
    if (f > maxFrames) break;
    if (!out.includes(f)) out.push(f);
  }
  const top = align(Math.min(v.frames, maxFrames));
  if (top <= maxFrames && !out.includes(top)) {
    out.push(top);
    out.sort((a, b) => a - b);
  }
  return out.length ? out : [align(v.frame_base)];
}

/** "56 frames" said as time: "2.3s at 24 fps". The number a person wants. */
export function clipLabel(frames: number, fps: number): string {
  const secs = frames / Math.max(1, fps);
  const t = secs >= 10 ? String(Math.round(secs)) : (Math.round(secs * 10) / 10).toFixed(1);
  return `${t}s`;
}

/** A duration a person reads at a glance: seconds under a minute, else m s. */
export function fmtSeconds(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return "";
  // A tenth of a second is kept only when it says something: 18.6s against
  // 33.2s is the comparison a user makes between two models, and "45.0s" is
  // just noise.
  if (s < 60) {
    const one = Math.round(s * 10) / 10;
    return Number.isInteger(one) ? `${one}s` : `${one.toFixed(1)}s`;
  }
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return rest ? `${m}m ${rest}s` : `${m}m`;
}
