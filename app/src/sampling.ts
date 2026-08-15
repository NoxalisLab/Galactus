/**
 * How the model picks its next token, and where those three numbers live.
 *
 * WHY THIS IS A SETTING AT ALL. Every model publishes the sampling it was tuned
 * with, and the numbers differ enough to matter: Qwen3.8 ships temperature 1.0,
 * top_p 0.95, top_k 20, while the value hard-coded here for two years was 0.6
 * with neither of the other two sent at all. A model run outside the sampling it
 * was tuned for is not broken, it is just quietly worse than it should be, and
 * nothing on screen says so.
 *
 * WHY THE APP DOES NOT SET THEM PER MODEL. It could read a recommendation out of
 * the registry, and that is worth doing later. It would still be a default, and
 * defaults are what this file is for: somewhere to put the number a person
 * decided on, so it survives a restart and applies to every conversation.
 */

/** The three knobs llama-server accepts and that a model card publishes. */
export interface Sampling {
  temperature: number;
  top_p: number;
  top_k: number;
}

/**
 * llama.cpp's own defaults, which is what the app used to send by accident for
 * top_p and top_k (by not sending them) and nearly for temperature.
 */
export const SAMPLING_DEFAULT: Sampling = { temperature: 0.6, top_p: 0.95, top_k: 40 };

/**
 * Bounds, and they are not decoration.
 *
 * A temperature of 0 is a legitimate and useful setting: it is what the
 * certification runs and the benchmarks use, and it must stay reachable. Above
 * about 2 the distribution is noise for every model in this catalogue. top_p is
 * a probability and cannot leave [0, 1]. top_k of 0 means "no limit" in
 * llama.cpp, which is why the floor is 0 rather than 1.
 */
const BOUNDS = {
  temperature: { min: 0, max: 2 },
  top_p: { min: 0, max: 1 },
  top_k: { min: 0, max: 200 },
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Read one stored value, falling back to the default when it is missing or not
 * a number.
 *
 * Settings arrive as strings from disk and a hand-edited file can hold
 * anything. NaN is the case that matters: it passes every comparison, so it
 * would flow into the request body as `"temperature": null` and llama-server
 * would answer 400 for a conversation the user cannot see the cause of.
 */
export function readSampling(stored: Record<string, string | undefined>): Sampling {
  const one = (key: keyof Sampling): number => {
    const raw = stored[`sampling_${key}`];
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      return SAMPLING_DEFAULT[key];
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) return SAMPLING_DEFAULT[key];
    return clamp(value, BOUNDS[key].min, BOUNDS[key].max);
  };
  return { temperature: one("temperature"), top_p: one("top_p"), top_k: one("top_k") };
}

/** The same clamping, for a value coming from an input the user just typed. */
export function clampSampling(key: keyof Sampling, value: number): number {
  if (!Number.isFinite(value)) return SAMPLING_DEFAULT[key];
  return clamp(value, BOUNDS[key].min, BOUNDS[key].max);
}

/**
 * The sampling that actually goes on the wire for one turn.
 *
 * `override` is a task temperature: a skill or a run may ask for 0 because it
 * needs a repeatable answer, and that has to win over the user's preference for
 * that turn only. It overrides the temperature ALONE: top_p and top_k stay as
 * configured, because a caller asking for determinism is asking about
 * temperature and knows nothing about the other two.
 */
export function samplingFor(configured: Sampling, override?: number): Sampling {
  if (override === undefined || !Number.isFinite(override)) return configured;
  return { ...configured, temperature: clampSampling("temperature", override) };
}
