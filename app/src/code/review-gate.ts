export type ReviewDecision = "accepted" | "rejected" | "partial" | "discarded";

export interface ReviewOutcome {
  rel: string;
  decision: ReviewDecision;
}

interface WaitingReview {
  promise: Promise<ReviewOutcome>;
  resolve(outcome: ReviewOutcome): void;
}

/** One blocking promise per proposed file, owned by the editor review UI. */
export class ReviewGate {
  private waiting = new Map<string, WaitingReview>();

  wait(rel: string): Promise<ReviewOutcome> {
    const existing = this.waiting.get(rel);
    if (existing) return existing.promise;
    let resolve!: (outcome: ReviewOutcome) => void;
    const promise = new Promise<ReviewOutcome>((done) => { resolve = done; });
    this.waiting.set(rel, { promise, resolve });
    return promise;
  }

  has(rel: string): boolean {
    return this.waiting.has(rel);
  }

  resolve(rel: string, decision: ReviewDecision): boolean {
    const slot = this.waiting.get(rel);
    if (!slot) return false;
    this.waiting.delete(rel);
    slot.resolve({ rel, decision });
    return true;
  }

  resolveAll(decision: ReviewDecision): string[] {
    const paths = [...this.waiting.keys()];
    for (const rel of paths) this.resolve(rel, decision);
    return paths;
  }
}

/** Tool result handed back to the model after the human review completes. */
export function reviewInstruction(outcome: ReviewOutcome): string {
  const file = outcome.rel;
  if (outcome.decision === "accepted") {
    return `review accepted by the user: ${file} is now on disk. Continue with the relevant verification before claiming completion.`;
  }
  if (outcome.decision === "partial") {
    return (
      `review partially accepted by the user: only selected hunks of ${file} are now on disk. ` +
      "Ask which remaining changes they want revised or abandoned before proposing anything else."
    );
  }
  if (outcome.decision === "rejected") {
    return (
      `review rejected by the user: nothing from the proposal for ${file} was applied. ` +
      "Ask why it was rejected and whether they want a targeted revision or a different approach. " +
      "Do not propose another edit until they answer."
    );
  }
  return (
    `review discarded by the user while leaving the workspace: nothing from the proposal for ${file} was applied. ` +
    "Acknowledge that outcome and ask what they want to do next."
  );
}
