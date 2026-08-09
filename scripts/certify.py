#!/usr/bin/env python3
"""Certify one model bit-transparent, for any MoE architecture.

WHAT CERTIFICATION MEANS HERE

A model is certified bit-transparent when the Galactus engine and stock
llama.cpp produce the SAME numbers, not similar ones. The test runs the same
corpus, the same seed and the same batch shape twice, once with the engine
wired in and once without, dumping a fingerprint of every MoE tensor of one
layer, and compares the two dumps byte for byte. One differing line is a
failure. There is no tolerance, because a tolerance is how a regression that
moves the eighth decimal ships as "close enough" and later moves the second.

WHY THIS REPLACES THIRTEEN HAND WRITTEN SCRIPTS

lanceurs/differentiel/ held one launcher per model and lanceurs/banc/ another,
each with the paths of its own model baked in. Adding a model meant copying a
file and editing six constants, which is how the two most recent models ended
up with no differential at all. Everything here comes from the registry and
from what is on disk.

THE TRAP THIS SCRIPT REFUSES TO WALK INTO

llama.cpp offloads an operation to the GPU once the batch reaches
op_offload_min_batch_size, which is 32. Above that, `--n-cpu-moe` stops being
a CPU reference: the "stock" run is then partly on Metal and the comparison
measures nothing. That mistake already invalidated a whole perplexity table in
this project. The batch shape is therefore checked before anything runs, and a
request outside the safe regime is refused rather than answered.

Usage:
  python3 scripts/certify.py --model qwen3-30b-a3b
  python3 scripts/certify.py --model qwen3-30b-a3b --layer 3 --json
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "scripts" / "models-registry.json"
PERPLEXITY = ROOT / "third_party" / "llama.cpp" / "build" / "bin" / "llama-perplexity"
OUT_DIR = ROOT / "artifacts" / "h4" / "certification"

# Above this batch size llama.cpp offloads to the GPU and --n-cpu-moe is no
# longer a CPU reference. See the module docstring.
OP_OFFLOAD_MIN_BATCH = 32
SAFE_UBATCH = 2
SAFE_BATCH = 512
SEED = 42
CTX = 512


def die(msg: str) -> "None":
    print(f"ECHEC: {msg}", file=sys.stderr)
    raise SystemExit(2)


def load_registry() -> list[dict]:
    raw = json.loads(REGISTRY.read_text(encoding="utf-8"))
    models = raw["models"] if isinstance(raw, dict) and "models" in raw else raw
    return list(models.values()) if isinstance(models, dict) else models


def find_model(model_id: str) -> dict:
    for m in load_registry():
        if m.get("id") == model_id:
            return m
    die(f"{model_id} is not in the registry")
    raise AssertionError("unreachable")


def resolve_paths(model_id: str) -> tuple[pathlib.Path, pathlib.Path, pathlib.Path | None]:
    """The GGUF, the pack and the engine profile, or a clear error saying which."""
    mdir = ROOT / "models" / model_id
    if not mdir.is_dir():
        die(f"{mdir} does not exist: install the model first")
    ggufs = sorted(mdir.glob("*.gguf"))
    if not ggufs:
        die(f"no .gguf in {mdir}")
    # Sharded checkpoints: the first shard is the one to open.
    gguf = next((g for g in ggufs if "00001-of-" in g.name), ggufs[0])

    # The fixture pack holds three records and exists only to prove the packing
    # chain end to end in seconds. Picking it here is silent and fatal: the
    # wired run dies immediately, dumps nothing, and the comparison has no
    # second side. Alphabetical order put it first, so it was picked every
    # time until this line existed.
    all_packs = sorted((ROOT / "artifacts" / "h4" / "packs" / model_id).glob("*.pack"))
    packs = [p for p in all_packs if "fixture" not in p.name]
    if not packs:
        if all_packs:
            die(f"only a fixture pack exists for {model_id}: run the full pack write")
        die(f"no .pack for {model_id}: run the install pipeline first")
    # Largest wins: a full pack dwarfs anything partial left behind.
    packs.sort(key=lambda p: p.stat().st_size, reverse=True)
    profile = mdir / "profile.engine.txt"
    return gguf, packs[0], profile if profile.is_file() else None


def pick_corpus() -> pathlib.Path:
    """One fixed corpus file, chosen deterministically.

    Sorted and index-picked rather than random: two runs of this script on the
    same model must be comparable, and a verdict that depends on which text
    happened to be drawn is not a verdict.
    """
    d = ROOT / "corpus" / "materialized" / "stage1"
    files = sorted(d.glob("*.txt"))
    if not files:
        die(f"no corpus under {d}")
    return files[len(files) // 2]


def run_pass(label: str, gguf: pathlib.Path, layer: int, env_extra: dict[str, str],
             extra_args: list[str], out_path: pathlib.Path, corpus: pathlib.Path) -> str:
    env = dict(os.environ)
    env.pop("GALACTUS_H4", None)
    env.update({
        "GALACTUS_H4_DUMP": "1",
        "GALACTUS_H4_DUMP_LAYER": str(layer),
        "GALACTUS_H4_DUMP_CAP": "4000",
        "LC_ALL": "C",
    })
    env.update(env_extra)
    args = [
        str(PERPLEXITY),
        "--model", str(gguf),
        "--file", str(corpus),
        "--ctx-size", str(CTX),
        "--chunks", "1",
        "--n-gpu-layers", env.get("GALACTUS_NGL", "99"),
        "--no-repack", "--fit", "off",
        "--batch-size", str(SAFE_BATCH),
        "--ubatch-size", str(SAFE_UBATCH),
        "--seed", str(SEED),
        "--log-colors", "off",
        "--n-cpu-moe", "99",
    ] + extra_args
    print(f"  {label}: running", flush=True)
    started = time.time()
    with out_path.open("wb") as fh:
        subprocess.run(args, env=env, stdout=fh, stderr=subprocess.STDOUT, check=False)
    print(f"  {label}: {time.time() - started:.0f}s", flush=True)
    return out_path.read_text(encoding="utf-8", errors="replace")


def fingerprints(raw: str) -> list[str]:
    """The dumped tensor lines, minus the routing decision itself.

    `topk_galactus` records which experts the router chose. It is dropped from
    the comparison because the wired run legitimately prints it and the stock
    run does not, so keeping it would fail every model for a difference that
    is not numeric.
    """
    return [l for l in raw.splitlines() if "galactus_dump" in l and "topk_galactus" not in l]


def final_ppl(raw: str) -> float | None:
    m = re.findall(r"Final estimate: PPL = ([0-9.]+)", raw)
    return float(m[-1]) if m else None


def certify(model_id: str, layer: int) -> dict:
    if SAFE_UBATCH >= OP_OFFLOAD_MIN_BATCH:
        die("the reference batch is at or above op_offload_min_batch_size: "
            "--n-cpu-moe would not be a CPU reference and the comparison would "
            "measure nothing")
    if not PERPLEXITY.is_file():
        die(f"{PERPLEXITY} is missing: build the engine first")

    entry = find_model(model_id)
    gguf, pack, profile = resolve_paths(model_id)
    corpus = pick_corpus()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    base = OUT_DIR / f"{stamp}-{model_id}"

    print(f"certifying {model_id} ({entry.get('arch', 'unknown arch')})")
    print(f"  gguf   {gguf.name}")
    print(f"  pack   {pack.name}")
    print(f"  corpus {corpus.name}")
    print(f"  layer  {layer}, ubatch {SAFE_UBATCH}, seed {SEED}")

    stock_raw = run_pass("stock ", gguf, layer, {}, [], base.with_suffix(".stock.out"), corpus)
    wired_env = {
        "GALACTUS_H4": "1",
        "GALACTUS_H4_INTERNAL": str(pack),
        "GALACTUS_H4_EXTERNAL": str(pack),
        "GALACTUS_H4_CPU_MOE": "1",
        "GALACTUS_H4_QD": "32",
    }
    if profile:
        wired_env["GALACTUS_PROFILE"] = str(profile)
    wired_raw = run_pass("wired ", gguf, layer, wired_env, ["--no-mmap"],
                         base.with_suffix(".wired.out"), corpus)

    a, b = fingerprints(stock_raw), fingerprints(wired_raw)
    # An empty comparison is not a pass. If neither run dumped anything the
    # instrumentation did not fire, and reporting "no divergence" would be
    # the most expensive kind of false positive this project can produce.
    verdict: dict = {
        "model": model_id,
        "arch": entry.get("arch"),
        "layer": layer,
        "stock_lines": len(a),
        "wired_lines": len(b),
        "stock_ppl": final_ppl(stock_raw),
        "wired_ppl": final_ppl(wired_raw),
        "logs": [str(base.with_suffix(".stock.out")), str(base.with_suffix(".wired.out"))],
    }
    if not a or not b:
        # Naming the side matters. "nothing was dumped" sent the last
        # investigation to the probe, when the truth was that the wired run had
        # died on startup and never reached a tensor.
        side = "neither run" if not a and not b else ("the stock run" if not a else "the wired run")
        verdict.update(certified=False,
                       reason=f"{side} dumped any fingerprint: it likely failed to start, "
                              f"see the logs listed above")
        return verdict
    if len(a) != len(b):
        verdict.update(certified=False,
                       reason=f"different number of dumped tensors: {len(a)} vs {len(b)}")
        return verdict
    diffs = [(i, x, y) for i, (x, y) in enumerate(zip(a, b)) if x != y]
    if diffs:
        i, x, y = diffs[0]
        verdict.update(certified=False, divergences=len(diffs), first_divergence=i,
                       reason=f"{len(diffs)} of {len(a)} tensors differ; first at index {i}",
                       stock_line=x[:200], wired_line=y[:200])
        return verdict
    verdict.update(certified=True, divergences=0,
                   reason=f"{len(a)} tensors identical, zero divergence")
    return verdict


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model", required=True)
    ap.add_argument("--layer", type=int, default=3)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    v = certify(args.model, args.layer)
    if args.json:
        print(json.dumps(v, indent=2))
    else:
        print()
        print("CERTIFIED" if v["certified"] else "NOT CERTIFIED")
        print(f"  {v['reason']}")
        if v.get("stock_ppl") is not None:
            print(f"  ppl stock {v['stock_ppl']}  wired {v['wired_ppl']}")
    return 0 if v["certified"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
