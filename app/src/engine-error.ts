// What a failed engine turn should say to a person.
//
// llama-server has exactly three messages for a decode that gave up, and none
// of them names a cause: "Compute error." (llama_decode returned below -1, the
// graph did not run), "Invalid input batch.", "Context size has been
// exceeded.". A user who reads the first one has no way to know that his Mac
// ran out of memory, and the colleague this module exists for found his way
// out by trying eco mode at random.
//
// The cause is decided in Rust, from the engine's own log (classify_engine_
// failure). This module turns that verdict into which sentence to show and
// which mode name to put in it. It imports nothing and touches nothing, so
// every branch is testable without an engine, without a Mac under pressure and
// without waiting for a model to load.

/** The backend verdict, narrowed to the fields the sentence depends on. */
export interface EngineVerdict {
  /** "memory" | "context" | "unknown" */
  kind: string;
  /** Footprint mode the engine was started in: eco | balanced | perf, or "". */
  mode: string;
  /** Whether a leaner footprint is still available below `mode`. */
  can_step_down: boolean;
}

/** The sentence to show, as an i18n key plus the mode name it talks about. */
export interface EngineAdvice {
  /** Key into i18n.ts. */
  key: string;
  /**
   * i18n key for the mode name to substitute for %s, or "" when the sentence
   * takes no mode.
   */
  modeKey: string;
}

/**
 * The engine's own decode messages.
 *
 * Matched as a whitelist rather than by sniffing for the word "error": every
 * other failure on this path (a network drop, a template error, a tool loop
 * giving up) already carries its own explanation, and replacing THOSE with a
 * story about memory would be the same defect pointed the other way.
 */
const DECODE_MESSAGES = [
  "compute error",
  "invalid input batch",
  "context size has been exceeded",
];

/**
 * Whether this failure is one the engine cannot explain by itself, and is
 * therefore worth asking the backend to diagnose.
 */
export function isEngineDecodeFailure(message: string): boolean {
  const low = message.toLowerCase();
  return DECODE_MESSAGES.some((m) => low.includes(m));
}

/** i18n key for a footprint mode name, as the settings segmented control uses. */
export function modeLabelKey(mode: string): string {
  if (mode === "eco") return "settings.ramEco";
  if (mode === "perf") return "settings.ramPerf";
  return "settings.ramBalanced";
}

/**
 * The advice to show for a diagnosed failure, or null when the app has nothing
 * better to say than what the engine already said.
 *
 * Returning null on `unknown` is deliberate. A message that blames memory for
 * every failure would be wrong often enough to be worse than the bare string:
 * the user would go and free memory that was never the problem, and the real
 * fault would stay hidden behind advice that sounds authoritative.
 */
export function engineAdvice(v: EngineVerdict): EngineAdvice | null {
  if (v.kind === "context") return { key: "engfail.context", modeKey: "" };
  if (v.kind !== "memory") return null;
  // Already at the leanest footprint: there is no mode left to step down to,
  // so the only action that works is giving the machine its memory back.
  if (!v.can_step_down) return { key: "engfail.memoryAtFloor", modeKey: "" };
  return { key: "engfail.memoryStepDown", modeKey: modeLabelKey(v.mode) };
}
