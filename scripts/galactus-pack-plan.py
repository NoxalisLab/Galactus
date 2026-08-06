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

Fail-closed: span lengths must sum to the profile's raw record size for every
record; totals must match the profile's totals byte-for-byte.
"""
import argparse, hashlib, json
from pathlib import Path

RANK = {"down": 0, "gate": 1, "gate_up": 1, "up": 2}
ALIGN = 16384

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", required=True, type=Path)
    ap.add_argument("--output", required=True, type=Path)
    ap.add_argument("--volumes", choices=("single", "dual"), default="single")
    ap.add_argument("--ratio", type=float, default=0.7157,
                    help="part interne (volumes=dual), depuis les debits mesures")
    args = ap.parse_args()

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
                internal = min(blocks, max(0, round(blocks * args.ratio))) * ALIGN
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
        "ratio": args.ratio if args.volumes == "dual" else 1.0,
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
    print(f"plan: {args.output}")
    print(f"sha256: {sha}")

if __name__ == "__main__":
    main()
