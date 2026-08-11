#!/usr/bin/env python3
"""Judge the measured curves in the registry, so an unattended sweep cannot land
something wrong in silence.

WHY THIS EXISTS

The curves are not decoration. app/src/main.ts interpolates them to tell a user
what their Mac will do, and plan_cache in app/src-tauri/src/lib.rs reads them to
decide how much RAM to reserve: eco takes the smallest measured cache, balanced
takes the knee, which is the smallest cache reaching 90 percent of the best
throughput reachable here. A wrong point therefore does not merely display a
wrong number, it makes the planner size the arena wrongly.

One point of gpt-oss-120b read 6.0 generated tokens per second where the tier
below it read 7.7, with a larger quota. That is not a slow tier, it is an
impossible one, and it sat in the registry for two days feeding the knee.
Nobody noticed because nothing was looking.

WHAT IT REPORTS

  impossible   generation falls while the cache grows. Physically cannot happen
               on a cache that only gets bigger, so it is a measurement, not a
               property of the model.
  unstable     the passes that produced the point disagreed by more than
               UNSTABLE_PCT. The number is published with its spread, and this
               says out loud that it should not be read finely.
  single       the point comes from one pass, so nothing bounds its error.
               Not wrong, just unverified, and worth knowing which are which.
  thin         fewer than MIN_POINTS, so the app clamps instead of interpolating
               and every machine gets the same answer.

Exit code is 1 when anything impossible was found, 0 otherwise: unstable and
single are facts to know, not reasons to stop a build.

Usage:
  python3 scripts/check-curves.py
  python3 scripts/check-curves.py --strict   (unstable also fails)
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "scripts" / "models-registry.json"

UNSTABLE_PCT = 10.0
# The app needs room to interpolate: with fewer points than this, eco and the
# knee collapse onto the same cache and every machine is told the same number.
MIN_POINTS = 4


def verdicts(entry: dict) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    pts = entry.get("measured") or []
    if not pts:
        return [("thin", "no curve at all")]
    pts = sorted(pts, key=lambda p: p["cache_gb"])
    if len(pts) < MIN_POINTS:
        out.append(("thin", f"{len(pts)} point(s), the app clamps instead of interpolating"))
    for prev, cur in zip(pts, pts[1:]):
        if cur["gen_tps"] < prev["gen_tps"]:
            drop = (prev["gen_tps"] - cur["gen_tps"]) / prev["gen_tps"] * 100
            out.append((
                "impossible",
                f"{prev['gen_tps']} at {prev['cache_gb']} GB then {cur['gen_tps']} at "
                f"{cur['cache_gb']} GB, {drop:.0f} percent down on a bigger cache",
            ))
    for p in pts:
        spread = max(p.get("spread_pct", 0.0), p.get("prompt_spread_pct", 0.0))
        if p.get("passes"):
            if spread > UNSTABLE_PCT:
                out.append(("unstable",
                            f"{p['cache_gb']} GB: {p['passes']} passes still {spread:.1f} percent apart"))
        else:
            out.append(("single", f"{p['cache_gb']} GB: one pass, no error bar"))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Judge the measured curves in the registry.")
    ap.add_argument("--strict", action="store_true",
                    help="fail on unstable points too, not only impossible ones")
    args = ap.parse_args()

    data = json.loads(REGISTRY.read_text(encoding="utf-8"))
    counts: dict[str, int] = {}
    for entry in data["models"]:
        found = verdicts(entry)
        if not found:
            print(f"  {entry['id']:<20} ok")
            continue
        # One line per model, then its findings, so a long registry stays
        # readable and a clean model is one line rather than silence.
        print(f"  {entry['id']:<20} {len(found)} finding(s)")
        for kind, why in found:
            counts[kind] = counts.get(kind, 0) + 1
            print(f"      {kind:<11} {why}")
    print()
    print("  " + (", ".join(f"{k}: {v}" for k, v in sorted(counts.items())) or "nothing to report"))
    bad = counts.get("impossible", 0) + (counts.get("unstable", 0) if args.strict else 0)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
