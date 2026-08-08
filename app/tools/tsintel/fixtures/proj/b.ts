// Fixture: the file that USES a.ts, and carries exactly ONE seeded type error.
//
// One error, not two, so a test can assert the count as well as the message: a
// host that half works usually produces either zero diagnostics (nothing
// resolved) or a flood (the default library never loaded), and both of those
// are caught by asserting exactly one.

import { distance, Point } from "./a";

const origin: Point = { x: 0, y: 0 };
const target: Point = { x: 3, y: 4 };

export const near = distance(origin, target);

// SEEDED ERROR: distance returns a number, and this asks for a string.
export const label: string = distance(origin, target);
