#!/usr/bin/env python3
"""Generic pack planner: profile.json -> pack plan, any MoE model.

Reads the profile emitted by moe-profile.py (which already carries, for every
layer and role, the absolute source offset of the tensor and the per-expert
byte count) and emits the record-level plan the packer consumes: one record
per (layer, expert), spans ordered by role rank (down, gate|gate_up, up),
expert-major slicing of each source tensor.

Volume policy:
  --volumes single   one SSD, every record entirely on the internal volume
  --volumes dual     two SSDs, per-record block split at --ratio (internal share)

The dual ratio is a MEASUREMENT, not a constant: both volumes are read in
parallel, so a record is ready when the slower side finishes, and the optimum
is r* = Bi / (Bi + Be) for the two measured bandwidths, where both finish
together. The app computes it at install; DEFAULT_RATIO below is only the
fallback for a measurement that failed.

The cut this file computes is the same cut the engine reproduces at read time
(src/h4/h4-core.cpp, generic_dual_cut). See sanitize_ratio and internal_blocks
for what keeps the two implementations exactly equal, and
scripts/tests/test-p0-split-differential.py for the proof that they are.

Fail-closed: span lengths must sum to the profile's raw record size for every
record; totals must match the profile's totals byte-for-byte.
"""
import argparse, hashlib, json
from pathlib import Path

RANK = {"down": 0, "gate": 1, "gate_up": 1, "up": 2}
ALIGN = 16384

# Split ratio bounds and grid. These MUST stay identical to h4-core.hpp
# (p0_ratio_minimum / p0_ratio_maximum / p0_ratio_decimals): the engine
# validates what this planner writes.
#
# DEFAULT_RATIO is the historical P0v2 cut. It is the fallback for a
# degenerate or failed bandwidth measurement, and the value every pack written
# before the ratio became a runtime value used.
DEFAULT_RATIO = 0.7157
RATIO_MINIMUM = 0.05
RATIO_MAXIMUM = 0.95
RATIO_DECIMALS = 4


def sanitize_ratio(value: float) -> float:
    """The ratio the pack will actually be cut at.

    Quantised to RATIO_DECIMALS so its shortest decimal spelling round-trips to
    the same IEEE double through C strtod, which is what lets the engine
    reproduce round(blocks * ratio) exactly. Out of bounds, not finite, or a
    degenerate 0 / 1 falls back to DEFAULT_RATIO rather than producing a pack
    that nothing can read.
    """
    try:
        r = round(float(value), RATIO_DECIMALS)
    except (TypeError, ValueError, OverflowError):
        return DEFAULT_RATIO
    if r != r or r in (float("inf"), float("-inf")):   # NaN, infinities
        return DEFAULT_RATIO
    if not (RATIO_MINIMUM <= r <= RATIO_MAXIMUM):
        return DEFAULT_RATIO
    return r


def internal_blocks(blocks: int, ratio: float) -> int:
    """THE cut, and the only place this file computes one.

    round() on a float is ties-to-even; the engine reproduces it with
    std::nearbyint under FE_TONEAREST (src/h4/h4-core.cpp, generic_dual_cut).
    Any change here is a change to the on-disk layout of every dual pack.
    """
    return min(blocks, max(0, round(blocks * ratio)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", required=True, type=Path)
    ap.add_argument("--output", required=True, type=Path)
    ap.add_argument("--volumes", choices=("single", "dual"), default="single")
    ap.add_argument("--ratio", type=float, default=DEFAULT_RATIO,
                    help="part interne (volumes=dual), depuis les debits mesures "
                         f"[{RATIO_MINIMUM}, {RATIO_MAXIMUM}], defaut {DEFAULT_RATIO}")
    args = ap.parse_args()

    ratio = sanitize_ratio(args.ratio) if args.volumes == "dual" else 1.0
    if args.volumes == "dual" and ratio != args.ratio:
        print(f"ratio {args.ratio} ramene a {ratio}")

    profile = json.loads(args.profile.read_text(encoding="utf-8"))
    records, total_raw = [], 0
    for layer_entry in profile["layers"]:
        layer = layer_entry["layer"]
        experts = layer_entry["experts"]
        raw = layer_entry["record_bytes_raw"]
        padded = layer_entry["record_bytes_padded"]
        roles = sorted(layer_entry["roles"].items(), key=lambda kv: RANK[kv[0]])
        ranks = [RANK[r] for r, _ in roles]
        if len(set(ranks)) != len(ranks):
            raise SystemExit(f"couche {layer}: rangs de roles dupliques")
        for expert in range(experts):
            spans, record_offset = [], 0
            for role, info in roles:
                per = info["per_expert_bytes"]
                spans.append({
                    "role": role,
                    "source_shard": info["shard"],
                    "source_offset": info["abs_offset"] + expert * per,
                    "length": per,
                    "record_offset": record_offset,
                })
                record_offset += per
            if record_offset != raw:
                raise SystemExit(f"couche {layer} expert {expert}: somme des spans "
                                 f"{record_offset} != record utile {raw}")
            blocks = padded // ALIGN
            if args.volumes == "single":
                internal = padded
            else:
                internal = internal_blocks(blocks, ratio) * ALIGN
            records.append({
                "key": (layer << 10) | expert,  # clef 10 bits, alignee sur le moteur (1024 experts max)
                "layer": layer, "expert": expert,
                "record_bytes": padded, "record_bytes_raw": raw,
                "pad_bytes": padded - raw,
                "internal_bytes": internal, "external_bytes": padded - internal,
                "source_spans": spans,
            })
            total_raw += raw

    if total_raw != profile["totals"]["routed_bytes_raw"]:
        raise SystemExit("total des spans != total du profil")
    total_padded = sum(r["record_bytes"] for r in records)
    if total_padded != profile["totals"]["routed_bytes_padded_pack"]:
        raise SystemExit("total pack != total du profil")

    plan = {
        "schema_version": 3,
        "generator": "galactus-pack-plan",
        "architecture": profile["architecture"],
        "model_name": profile.get("model_name", ""),
        "volumes": args.volumes,
        "ratio": ratio,
        "record_align": ALIGN,
        "record_count": len(records),
        "totals": {
            "pack_bytes": total_padded,
            "internal_bytes": sum(r["internal_bytes"] for r in records),
            "external_bytes": sum(r["external_bytes"] for r in records),
        },
        "records": records,
    }
    text = json.dumps(plan, indent=1)
    args.output.write_text(text, encoding="utf-8")
    sha = hashlib.sha256(text.encode()).hexdigest()
    print(f"{len(records)} enregistrements, pack {total_padded:,} o "
          f"(interne {plan['totals']['internal_bytes']:,} / externe {plan['totals']['external_bytes']:,})")
    if args.volumes == "dual":
        print(f"ratio interne: {ratio}")
    print(f"plan: {args.output}")
    print(f"sha256: {sha}")

if __name__ == "__main__":
    main()
