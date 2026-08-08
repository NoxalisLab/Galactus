// Fixture: the file that DEFINES things. Kept deliberately small and
// deliberately typed, so a test can assert an exact hover string.

export interface Point {
  x: number;
  y: number;
}

export function distance(from: Point, to: Point): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return Math.sqrt(dx * dx + dy * dy);
}
