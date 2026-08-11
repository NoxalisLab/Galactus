/**
 * One sentence a non-expert understands, out of everything the app decided.
 *
 * A turnkey product still has to say what it chose and why. Silent magic that
 * gets it wrong is worse than a visible choice: the user on the 24 GB Mac was
 * not helped by the app deciding for him, he was helped by finding out, by
 * hand, that Eco worked.
 *
 * Pure: a recommendation and a machine in, an i18n key and its numbers out. No
 * DOM, no invoke, no clock, so every shape the sentence can take is tested
 * rather than only the shape the developer's Mac happens to produce.
 *
 * Translation happens at the call site, because `t()` reads a language this
 * module has no business knowing about. What comes back is the key and the
 * values, never a formatted string.
 */

// The wire shapes are declared here rather than imported from api.ts, exactly
// as model-policy.ts declares its own. TypeScript is structural, so the real
// api.ts values satisfy these, and this module stays testable without pulling
// the Tauri runtime into a `node --test` process that has no webview.

/** Subset of `api.PackLayout` this module reads. */
export type PackLayoutBrief =
  | { kind: "single"; mount: string }
  | { kind: "dual"; internal: string; external: string }
  | { kind: "no-room" };

/** Subset of `api.Recommendation` this module reads. */
export interface RecommendationBrief {
  mode: string;
  requested_mode: string;
  slots: number;
  resident_bytes: number;
  budget_bytes: number;
  blocked: string | null;
}

/** Subset of `api.HwInfo` this module reads. */
export interface HwInfoBrief {
  chip: string;
  ram_gb: number;
  gpu_cores: number | null;
  bandwidth_gbs: number | null;
  engine_budget_bytes: number;
  power_source: string;
}

// One definition of the mode label, shared with the engine failure advice.
// Two copies of "eco means settings.ramEco" is one copy too many: they would
// drift the day a fourth mode is added, and the two surfaces would name the
// same mode differently in the same window.
export { modeLabelKey } from "./engine-error.js";
import { modeLabelKey } from "./engine-error.js";

/** How the sentence should read: informative, cautionary, or a refusal. */
export type BriefTone = "ok" | "adjusted" | "blocked";

export interface MachineBrief {
  tone: BriefTone;
  /**
   * i18n key of the sentence. Its placeholders, always by name so a
   * translation may reorder them:
   *   %m the footprint mode label, already translated by the caller
   *   %q the mode the settings asked for, same
   *   %n the number of conversations
   *   %r the footprint in GB, one decimal
   *   %b what the Mac can spare in GB, one decimal
   */
  key: string;
  /** i18n key of the mode label to substitute for %m. */
  modeKey: string;
  /** i18n key of the requested mode label, for %q. Equal to modeKey unless
   *  the machine stepped the mode down. */
  requestedModeKey: string;
  slots: number;
  residentGb: number;
  budgetGb: number;
  /** The planner's own words, on a refusal only. Rendered verbatim. */
  reason?: string;
}

function gb(bytes: number): number {
  return Math.round((bytes / 1e9) * 10) / 10;
}

/**
 * The sentence for one model on this Mac.
 *
 * Three shapes, and which one appears is the whole message:
 *
 *  - blocked: nothing this app can arrange will start the model right now. The
 *    planner's own numbers are in the Rust message; this key carries the two
 *    the user can act on.
 *  - adjusted: the machine could not afford the mode the settings asked for
 *    and stepped down. Said out loud, because a user who picked Performance
 *    and silently got Eco would rightly call that a bug.
 *  - ok: what will run, in how much memory, for how many conversations.
 */
export function machineBrief(rec: RecommendationBrief): MachineBrief {
  const common = {
    modeKey: modeLabelKey(rec.mode),
    requestedModeKey: modeLabelKey(rec.requested_mode),
    slots: rec.slots,
    residentGb: gb(rec.resident_bytes),
    budgetGb: gb(rec.budget_bytes),
  };
  // A refusal carries its own sentence, written by the planner, which is the
  // only thing that knows WHY it said no: not enough free memory and by how
  // much, or a model below this Mac's floor, or a volume that vanished. The
  // first version of this threw that string away and rendered a fixed memory
  // template instead, whose numbers came from a struct the refusal path never
  // fills. A user testing it read "it needs about 0.0 GB and your Mac can
  // spare 57.8 GB", which is a sentence that argues against itself.
  if (rec.blocked) {
    return { tone: "blocked", key: "brief.blocked", reason: rec.blocked, ...common };
  }
  if (rec.mode !== rec.requested_mode) return { tone: "adjusted", key: "brief.adjusted", ...common };
  return { tone: "ok", key: "brief.ok", ...common };
}

/**
 * The sentence naming where a pack would be written.
 *
 * Returns null when no layout was computed, which is the case for an installed
 * model and for any caller that did not measure the drives. Null means "say
 * nothing", never "one volume".
 */
export function layoutBriefKey(layout: PackLayoutBrief | null): string | null {
  if (!layout) return null;
  switch (layout.kind) {
    case "single":
      return "brief.layoutSingle";
    case "dual":
      return "brief.layoutDual";
    default:
      return "brief.layoutNoRoom";
  }
}

/**
 * What this Mac is, in the four figures that change a decision.
 *
 * `hw.chip` alone could not tell a 16 GB M1 from a 16 GB M4 Max, and those are
 * not the same machine. The GPU core count is what separates them, and on the
 * binned Max parts it is also the only reading that separates two chips of the
 * same name with different memory bandwidth.
 */
export interface MachineSummary {
  chip: string;
  /** "40 GPU cores", or null when there is no GPU to count. */
  gpuCores: number | null;
  ramGb: number;
  /** What the engine may hold in total right now, GB. */
  budgetGb: number;
  /** Apple's published bandwidth, GB/s, or null when Apple published none. */
  bandwidthGbs: number | null;
  /** True when the Mac is on battery, where sustained throughput is not what
   *  the measured curves were recorded at. */
  onBattery: boolean;
}

export function machineSummary(hw: HwInfoBrief): MachineSummary {
  return {
    chip: hw.chip,
    gpuCores: hw.gpu_cores,
    ramGb: hw.ram_gb,
    budgetGb: gb(hw.engine_budget_bytes),
    bandwidthGbs: hw.bandwidth_gbs,
    onBattery: hw.power_source === "battery",
  };
}
