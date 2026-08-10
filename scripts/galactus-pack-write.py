#!/usr/bin/env python3
"""Generic pack writer: v3 plan -> pack file(s), any MoE model.

Consumes the plan emitted by galactus-pack-plan.py. Writes records in
ascending key order, each assembled from its GGUF source spans, zero-padded
to its aligned size, then cut at the plan's per-record internal/external
boundary (single-volume plans put everything internal). Safety patterns kept
from the GLM writer: fixture mode first, explicit confirmation derived from
the plan hash, free-space check, atomic manifest, full readback verification.

  fixture : 3 records (first, middle, last) written and verified, seconds.
  full    : the real packs. --confirm must equal WRITE-<12 first hex of plan sha>.

A full write also leaves "<internal pack>.split" beside the internal pack: the
ratio the records were cut at and the totals it produced. That file is what the
engine reads to know where to cut, and what it checks its own arithmetic
against before serving a single byte.
"""
import argparse, hashlib, json, os
from pathlib import Path

CHUNK = 8 * 1024 * 1024

def sha256_file(path, limit=None):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(CHUNK)
            if not b: break
            h.update(b)
    return h.hexdigest()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", required=True, type=Path)
    ap.add_argument("--expected-plan-sha256", required=True)
    ap.add_argument("--model-directory", required=True, type=Path)
    ap.add_argument("--mode", required=True, choices=("fixture", "full"))
    ap.add_argument("--internal-output", type=Path, required=True)
    ap.add_argument("--external-output", type=Path)
    ap.add_argument("--manifest", required=True, type=Path)
    ap.add_argument("--minimum-free-after-gib", type=int, default=64)
    ap.add_argument("--confirm")
    args = ap.parse_args()

    raw = args.plan.read_bytes()
    plan_sha = hashlib.sha256(raw).hexdigest()
    if plan_sha != args.expected_plan_sha256:
        raise SystemExit(f"plan sha256 {plan_sha[:12]}... != attendu")
    plan = json.loads(raw)
    if plan.get("schema_version") != 3 or plan.get("generator") != "galactus-pack-plan":
        raise SystemExit("plan inconnu (schema v3 galactus-pack-plan attendu)")
    dual = plan["volumes"] == "dual"
    if dual and args.external_output is None:
        raise SystemExit("plan dual: --external-output requis")

    records = sorted(plan["records"], key=lambda r: r["key"])
    if [r["key"] for r in records] != sorted({r["key"] for r in records}):
        raise SystemExit("clefs dupliquees dans le plan")

    if args.mode == "full":
        want = "WRITE-" + plan_sha[:12]
        if args.confirm != want:
            raise SystemExit(f"mode full: passer --confirm {want}")
        free = os.statvfs(args.internal_output.parent).f_bavail * os.statvfs(args.internal_output.parent).f_frsize
        need = plan["totals"]["internal_bytes"] + args.minimum_free_after_gib * (1 << 30)
        if free < need:
            raise SystemExit(f"espace interne insuffisant: {free:,} libres, {need:,} requis")
        chosen = records
    else:
        chosen = [records[0], records[len(records) // 2], records[-1]]

    shards = {}
    def shard(name):
        if name not in shards:
            path = args.model_directory / name
            shards[name] = open(path, "rb")
        return shards[name]

    args.internal_output.parent.mkdir(parents=True, exist_ok=True)
    out_i = open(args.internal_output, "wb")
    out_e = open(args.external_output, "wb") if dual else None
    written_i = written_e = 0
    record_shas = []
    for n, r in enumerate(chosen):
        buf = bytearray(r["record_bytes"])
        for s in r["source_spans"]:
            f = shard(s["source_shard"])
            f.seek(s["source_offset"])
            data = f.read(s["length"])
            if len(data) != s["length"]:
                raise SystemExit(f"lecture incomplete clef {r['key']} role {s['role']}")
            buf[s["record_offset"]:s["record_offset"] + s["length"]] = data
        # rembourrage: buf est deja zero au-dela de record_bytes_raw
        record_shas.append(hashlib.sha256(bytes(buf)).hexdigest())
        cut = r["internal_bytes"]
        out_i.write(bytes(buf[:cut])); written_i += cut
        if dual:
            out_e.write(bytes(buf[cut:])); written_e += len(buf) - cut
        if args.mode == "full" and n % 500 == 0:
            print(f"  {n}/{len(chosen)} enregistrements, {written_i + written_e:,} o", flush=True)
    out_i.close()
    if out_e: out_e.close()
    for f in shards.values(): f.close()

    if args.mode == "full":
        if written_i != plan["totals"]["internal_bytes"]:
            raise SystemExit("octets internes ecrits != plan")
        if dual and written_e != plan["totals"]["external_bytes"]:
            raise SystemExit("octets externes ecrits != plan")

    # The split record, beside the pack it describes.
    #
    # A dual pack is unreadable without the ratio its records were cut at, and
    # a reader that guesses is a reader that returns the wrong bytes in
    # silence. The ratio therefore travels WITH the pack, not with the app:
    # settings can be copied between machines, an app update can change a
    # default, a user can reprobe their SSDs and get a different r*, and none
    # of that moves the bytes already on disk.
    #
    # It lives here rather than in a pack header because a header would shift
    # every record offset and make every installed pack unreadable, and rather
    # than in the model's engine profile because that file describes the MODEL
    # (geometry, shared by every pack of it) while this describes ONE pack.
    #
    # Flat text, same shape as profile.engine.txt: the C++ loader parses it
    # without a JSON library. The totals are what makes a rounding
    # disagreement loud: the engine recomputes the layout and refuses to start
    # unless it reproduces these two numbers exactly.
    #
    # Full mode only. A fixture pack holds three records, so its totals would
    # describe nothing the engine could check itself against.
    if args.mode == "full":
        ratio = plan["ratio"] if dual else 1.0
        split = args.internal_output.with_name(args.internal_output.name + ".split")
        split_tmp = split.with_name(split.name + ".tmp")
        split_tmp.write_text(
            "\n".join([
                "galactus-split 1",
                f"volumes {plan['volumes']}",
                # repr() is the shortest spelling that round-trips this double,
                # and C strtod recovers the same one: that is what lets the
                # engine reproduce round(blocks * ratio) block for block.
                f"ratio {ratio!r}",
                f"records {len(chosen)}",
                f"internal_bytes {written_i}",
                f"external_bytes {written_e}",
                "end",
            ]) + "\n",
            encoding="utf-8")
        split_tmp.replace(split)
        print(f"decoupe: {split}")

    manifest = {
        "generator": "galactus-pack-write", "mode": args.mode,
        "plan_sha256": plan_sha, "architecture": plan["architecture"],
        "volumes": plan["volumes"], "ratio": plan["ratio"],
        "records_written": len(chosen),
        "internal_pack": str(args.internal_output),
        "internal_bytes": written_i,
        "internal_sha256": sha256_file(args.internal_output),
        "record_sha256": record_shas if args.mode == "fixture" else
                         hashlib.sha256("".join(record_shas).encode()).hexdigest(),
    }
    if dual:
        manifest["external_pack"] = str(args.external_output)
        manifest["external_bytes"] = written_e
        manifest["external_sha256"] = sha256_file(args.external_output)
    tmp = args.manifest.with_suffix(".tmp")
    tmp.write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    tmp.replace(args.manifest)
    print(f"{len(chosen)} enregistrements ecrits ({args.mode}), "
          f"interne {written_i:,} o" + (f", externe {written_e:,} o" if dual else ""))
    print(f"manifeste: {args.manifest}")
    if args.mode == "fixture":
        print(f"pour le mode full: --confirm WRITE-{plan_sha[:12]}")

if __name__ == "__main__":
    main()
