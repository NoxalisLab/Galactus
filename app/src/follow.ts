/**
 * Whether a scroller should keep following what is being written into it.
 *
 * Three surfaces in this app stream text into a box the reader may be reading:
 * the chat log, the reasoning block, and any transcript that grows. All three
 * asked the same question and two of them answered it differently, so it lives
 * here once.
 *
 * The rule is not "scroll to the bottom". It is "were they at the bottom?". A
 * reader who scrolled up to re-read an earlier message, or who is halfway
 * through selecting text to copy, was dragged back within one frame for as long
 * as the answer kept coming, and a background teammate's tokens did it to a
 * thread nobody had asked about.
 */

/** Pixels of slack. A reader within this of the end was following. */
export const FOLLOW_SLACK = 40;

export interface Scrolled {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * True when the reader is at, or within `slack` of, the end.
 *
 * A box with nothing to scroll counts as following: it has no "up" to have
 * scrolled to, and refusing to follow it would freeze the first lines of every
 * short answer.
 */
export function isFollowing(box: Scrolled, slack: number = FOLLOW_SLACK): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= slack;
}
