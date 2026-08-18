export type CertificationBadge = "certified" | "composition" | "stock" | "pending" | "blocked";

export interface ModelCertification {
  canExecute: boolean;
  badge: CertificationBadge;
}

export type ModelBlockReason = "certification" | "hardware" | null;

export interface ModelAvailability extends ModelCertification {
  reason: ModelBlockReason;
}

export interface ModelDownload {
  base?: string;
  files?: string[];
}

/** Frontend mirror of the backend execution gate. Rust remains authoritative. */
export function modelCertification(status: string): ModelCertification {
  switch (status) {
    case "certified":
    case "certified_bit_transparent":
      return { canExecute: true, badge: "certified" };
    case "certified_by_composition":
      return { canExecute: true, badge: "composition" };
    // A dense model has no experts to substitute, so there is nothing for the
    // differential probe to compare and no bit-exactness claim to make. It runs
    // through unmodified llama.cpp, which is a weaker and DIFFERENT statement
    // than the one every other card makes, and it gets its own badge rather
    // than borrowing the certified one.
    case "stock_unmodified":
      return { canExecute: true, badge: "stock" };
    case "pending_certification":
      return { canExecute: false, badge: "pending" };
    default:
      return { canExecute: false, badge: "blocked" };
  }
}

/**
 * Client-side availability for display and interaction gating.
 * The Rust backend independently enforces the same policy for every start and
 * install, so bypassing the UI cannot bypass hardware or certification rules.
 */
export function modelAvailability(
  status: string,
  minimumRamGb: number | undefined,
  detectedRamGb: number | undefined,
): ModelAvailability {
  const certification = modelCertification(status);
  if (!certification.canExecute) return { ...certification, reason: "certification" };
  if (!minimumRamGb || minimumRamGb <= 0) {
    return { canExecute: false, badge: "blocked", reason: "hardware" };
  }
  if (detectedRamGb === undefined || detectedRamGb < minimumRamGb) {
    return { ...certification, canExecute: false, reason: "hardware" };
  }
  return { ...certification, reason: null };
}

export function hasVerifiedDownload(download: ModelDownload | undefined): boolean {
  return Boolean(
    download?.base?.startsWith("https://huggingface.co/") &&
      download.files?.length &&
      download.files.every((file) => Boolean(file) && !file.startsWith("/") && !file.split("/").includes("..")),
  );
}

/**
 * Which model to suggest on THIS machine.
 *
 * The model list is a wall of numbers: an architecture, a size in gigabytes, a
 * count of experts. Someone who has just installed the app has no way to read
 * that into a choice, and the honest answer is not "the biggest" (it crawls) nor
 * "the fastest" (it is the least capable one there).
 *
 * The rule is one sentence, and it is the one shown to the user: the most
 * capable model that still answers at a comfortable reading speed here. Size
 * stands for capability, which is crude but true within one family and across
 * the ones in this registry; speed comes from the same estimate the card
 * already prints, so the badge can never contradict the number beside it.
 *
 * Nothing is recommended when nothing is measured yet, rather than a guess
 * dressed as advice.
 */

/** Below this, generation is slower than reading, and it shows. */
export const COMFORTABLE_TPS = 15;

export interface Recommendable {
  id: string;
  /** Weights on disk. Stands in for capability. */
  gguf_bytes?: number;
  /** Estimated or measured tokens per second on this machine, null if unknown. */
  tps: number | null;
  /** Whether this Mac can run it at all (certification and memory). */
  ok: boolean;
}

export function recommendedModel(models: Recommendable[]): string | null {
  const runnable = models.filter((m) => m.ok && m.tps !== null);
  if (!runnable.length) return null;
  const comfortable = runnable.filter((m) => (m.tps as number) >= COMFORTABLE_TPS);
  // Nothing comfortable: recommend the fastest thing that runs, because on a
  // machine where everything is slow the useful advice is "start with this one",
  // not silence.
  const pool = comfortable.length ? comfortable : runnable;
  let best = pool[0];
  for (const m of pool.slice(1)) {
    const bigger = (m.gguf_bytes ?? 0) > (best.gguf_bytes ?? 0);
    const sameSize = (m.gguf_bytes ?? 0) === (best.gguf_bytes ?? 0);
    if (comfortable.length) {
      // Most capable that stays comfortable; ties go to the faster one.
      if (bigger || (sameSize && (m.tps as number) > (best.tps as number))) best = m;
    } else if ((m.tps as number) > (best.tps as number)) {
      best = m;
    }
  }
  return best.id;
}
