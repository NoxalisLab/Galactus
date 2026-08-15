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
