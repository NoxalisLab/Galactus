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

THE TRAP THIS SCRIPT WALKS AROUND

llama.cpp offloads an operation to the GPU once the batch reaches
op_offload_min_batch_size, which is 32. Above that, `--n-cpu-moe` stops being
a CPU reference: the "stock" run is then partly on Metal and the comparison
measures nothing. That mistake already invalidated a whole perplexity table in
this project. The batch shape is therefore not a caller argument at all: it is
frozen in SAFE_UBATCH and no flag can raise it, so there is nothing to refuse
at run time. The one check left compares the two constants, and the only
person it can ever stop is whoever edits SAFE_UBATCH in this file. That is who
it is for, and it is written down that way rather than described as a check on
input, which it never was.

WHAT A STORED PERPLEXITY MUST CARRY

A perplexity means nothing without the text it was measured on. The registry
used to hold `certified_ppl` as a bare number, and four of those numbers were
taken on a corpus file nobody wrote down: the per-model launchers in
lanceurs/differentiel/ read coding-repobench-p-e-0048.txt, this script reads
its own file, and on the same model the two disagree by more than a factor of
three. A number nobody can reproduce looks like evidence and is not. So the
field is an object now, and this script fills it in from what it actually ran:
corpus path, sha256 of the corpus bytes, seed, context, batch shape, regime,
date and run stamp. None of it is typed in by hand, which is the only way it
stays true.

DUAL PACKS

By default the wired run points both volumes at the one pack it found, which
is the mono-volume layout. --internal-pack / --external-pack aim it at a real
two-volume pair instead, which is how a pack cut at a measured ratio gets
proven readable: the engine takes the cut from the .split record beside the
internal pack, and one wrong block anywhere shows up here as a differing
fingerprint. --ratio additionally hands the engine the caller's own copy of
that ratio, exercising the cross-check that refuses to start on a mismatch.

Usage:
  python3 scripts/certify.py --model qwen3-30b-a3b
  python3 scripts/certify.py --model qwen3-30b-a3b --layer 3 --json
  python3 scripts/certify.py --model qwen3-30b-a3b --no-registry
  python3 scripts/certify.py --model olmoe-1b-7b \
      --internal-pack /a/m-internal.pack --external-pack /b/m-external.pack \
      --ratio 0.5
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "scripts" / "models-registry.json"
PACKAGED_REGISTRY = ROOT / "app" / "src-tauri" / "packaged" / "scripts" / "models-registry.json"
PERPLEXITY = ROOT / "third_party" / "llama.cpp" / "build" / "bin" / "llama-perplexity"
OUT_DIR = ROOT / "artifacts" / "h4" / "certification"
CORPUS_DIR = ROOT / "corpus" / "materialized" / "stage1"

# The reference text, pinned by name rather than by position. corpus/ is not
# versioned, so an index into the sorted directory changes meaning the day a
# file is added or removed, and every perplexity taken after that silently
# refers to another text. This is the file every stored certified_ppl that
# carries a corpus was measured on.
CORPUS_NAME = "long-context-multifieldqa-zh-0029.txt"

# Above this batch size llama.cpp offloads to the GPU and --n-cpu-moe is no
# longer a CPU reference. See the module docstring.
OP_OFFLOAD_MIN_BATCH = 32
SAFE_UBATCH = 2
SAFE_BATCH = 512
SEED = 42
CTX = 512

# The flags that make the two runs comparable, stored beside the number so a
# reader knows what regime it belongs to without opening this file.
REGIME = ("llama-perplexity, CPU expert reference: --n-cpu-moe 99 --no-repack --fit off "
          "--chunks 1, stock against wired (GALACTUS_H4=1, --no-mmap)")


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
    """The one reference text, pinned by name.

    This used to be files[len(files) // 2] of the sorted directory. That is
    deterministic only for a fixed directory, and corpus/ is not versioned:
    one added file shifts the median and every later perplexity refers to
    another text without saying so. The name is explicit now, and the fallback
    says out loud that the number it is about to produce is not comparable to
    the stored ones.
    """
    pinned = CORPUS_DIR / CORPUS_NAME
    if pinned.is_file():
        return pinned
    files = sorted(CORPUS_DIR.glob("*.txt"))
    if not files:
        die(f"no corpus under {CORPUS_DIR}")
    chosen = files[len(files) // 2]
    print(f"  WARNING: {CORPUS_NAME} is missing from {CORPUS_DIR}, falling back to "
          f"{chosen.name}: this perplexity is not comparable to the stored ones", flush=True)
    return chosen


def sha256_of(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def ppl_record(corpus: pathlib.Path, stock: float, wired: float, stamp: str,
               day: str) -> dict:
    """Everything needed to reproduce this perplexity, and nothing hand-typed.

    The sha256 is here because the filename alone does not pin the bytes: the
    corpus directory is generated by scripts/materialize-stage1-corpus.py and
    is not under version control, so the same name on another checkout can be
    another text.
    """
    return {
        "stock": stock,
        "wired": wired,
        "corpus": str(corpus.relative_to(ROOT)),
        "corpus_sha256": sha256_of(corpus),
        "corpus_bytes": corpus.stat().st_size,
        "seed": SEED,
        "ctx": CTX,
        "batch": SAFE_BATCH,
        "ubatch": SAFE_UBATCH,
        "regime": REGIME,
        "date": day,
        "run": stamp,
        "recorded_by": "scripts/certify.py",
    }


def update_registry(model_id: str, record: dict, day: str) -> None:
    """Write the perplexity and its provenance into both copies of the registry.

    app/src-tauri/packaged/scripts/models-registry.json is a build input copied
    verbatim from scripts/models-registry.json by app/tools/sync-packaged.mjs.
    The same copy is done here so the two never drift between two app builds.
    """
    data = json.loads(REGISTRY.read_text(encoding="utf-8"))
    for entry in data["models"]:
        if entry.get("id") == model_id:
            entry["certified_ppl"] = record
            entry["certified_date"] = day
            break
    else:
        die(f"{model_id} vanished from the registry between read and write")
    REGISTRY.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    if PACKAGED_REGISTRY.is_file():
        PACKAGED_REGISTRY.write_text(REGISTRY.read_text(encoding="utf-8"), encoding="utf-8")


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


def certify(model_id: str, layer: int, internal_pack: str | None = None,
            external_pack: str | None = None, ratio: str | None = None,
            write_registry: bool = True) -> dict:
    # Not an input check: no argument of this function and no flag of this
    # script can move SAFE_UBATCH. It is an invariant on the two constants, and
    # it fires for exactly one reader, whoever raises SAFE_UBATCH in this file
    # without knowing what op_offload_min_batch_size does to --n-cpu-moe.
    # Written as if/raise and not as assert, because python -O drops asserts and
    # a check that can be compiled away is not a check.
    if SAFE_UBATCH >= OP_OFFLOAD_MIN_BATCH:
        raise RuntimeError(
            f"SAFE_UBATCH={SAFE_UBATCH} is at or above op_offload_min_batch_size="
            f"{OP_OFFLOAD_MIN_BATCH}: llama.cpp would offload the expert matmul to the "
            f"GPU, --n-cpu-moe would stop being a CPU reference and the comparison would "
            f"measure nothing. Lower SAFE_UBATCH, do not raise OP_OFFLOAD_MIN_BATCH.")
    if not PERPLEXITY.is_file():
        die(f"{PERPLEXITY} is missing: build the engine first")

    entry = find_model(model_id)
    gguf, pack, profile = resolve_paths(model_id)
    # An explicit pair replaces the discovered pack entirely. Both halves are
    # required together: one of the two alone would silently fall back to the
    # mono layout and the run would certify something nobody asked for.
    if (internal_pack is None) != (external_pack is None):
        die("--internal-pack and --external-pack go together")
    if internal_pack is not None:
        for side in (internal_pack, external_pack):
            if not pathlib.Path(side).is_file():
                die(f"{side} does not exist")
        pack_internal, pack_external = internal_pack, external_pack
    else:
        pack_internal = pack_external = str(pack)
    corpus = pick_corpus()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    day = time.strftime("%Y-%m-%d", time.gmtime())
    # Suffixes are appended, not substituted. base.with_suffix(".stock.out")
    # replaces everything after the first dot of the name, so glm-4.5-air wrote
    # its logs as "<stamp>-glm-4.stock.out": the model id was truncated and any
    # two ids sharing a prefix before their first dot would overwrite each
    # other's evidence.
    stock_log = OUT_DIR / f"{stamp}-{model_id}.stock.out"
    wired_log = OUT_DIR / f"{stamp}-{model_id}.wired.out"
    verdict_path = OUT_DIR / f"{stamp}-{model_id}.verdict.json"

    print(f"certifying {model_id} ({entry.get('arch', 'unknown arch')})")
    print(f"  gguf   {gguf.name}")
    if internal_pack is not None:
        print(f"  packs  {pathlib.Path(pack_internal).name} + "
              f"{pathlib.Path(pack_external).name}"
              + (f" @ ratio {ratio}" if ratio else ""))
    else:
        print(f"  pack   {pack.name}")
    print(f"  corpus {corpus.name}")
    print(f"  layer  {layer}, ubatch {SAFE_UBATCH}, seed {SEED}")

    stock_raw = run_pass("stock ", gguf, layer, {}, [], stock_log, corpus)
    wired_env = {
        "GALACTUS_H4": "1",
        "GALACTUS_H4_INTERNAL": pack_internal,
        "GALACTUS_H4_EXTERNAL": pack_external,
        "GALACTUS_H4_CPU_MOE": "1",
        "GALACTUS_H4_QD": "32",
    }
    if profile:
        wired_env["GALACTUS_PROFILE"] = str(profile)
    if ratio:
        wired_env["GALACTUS_H4_RATIO"] = ratio
    wired_raw = run_pass("wired ", gguf, layer, wired_env, ["--no-mmap"], wired_log, corpus)

    a, b = fingerprints(stock_raw), fingerprints(wired_raw)
    # An empty comparison is not a pass. If neither run dumped anything the
    # instrumentation did not fire, and reporting "no divergence" would be
    # the most expensive kind of false positive this project can produce.
    verdict: dict = {
        "model": model_id,
        "arch": entry.get("arch"),
        "layer": layer,
        "internal_pack": pack_internal,
        "external_pack": pack_external,
        "ratio": ratio,
        "stock_lines": len(a),
        "wired_lines": len(b),
        "stock_ppl": final_ppl(stock_raw),
        "wired_ppl": final_ppl(wired_raw),
        "ppl": ppl_record(corpus, final_ppl(stock_raw), final_ppl(wired_raw), stamp, day),
        "logs": [str(stock_log), str(wired_log)],
    }

    def finish(v: dict) -> dict:
        """Land the verdict on disk, then the registry if there is one to write.

        The sidecar is written whatever the outcome, because a failed run is
        also evidence and the two .out files alone never said which corpus they
        read: llama-perplexity does not echo --file. The registry is only
        touched by a run that certified and produced a perplexity on both
        sides, so a crashed run can never overwrite a good number.
        """
        v["verdict_file"] = str(verdict_path)
        verdict_path.write_text(json.dumps(v, indent=2, ensure_ascii=False) + "\n",
                                encoding="utf-8")
        if (write_registry and v.get("certified")
                and v["ppl"]["stock"] is not None and v["ppl"]["wired"] is not None):
            update_registry(model_id, v["ppl"], day)
            v["registry_written"] = True
        return v

    if not a or not b:
        # Naming the side matters. "nothing was dumped" sent the last
        # investigation to the probe, when the truth was that the wired run had
        # died on startup and never reached a tensor.
        side = "neither run" if not a and not b else ("the stock run" if not a else "the wired run")
        verdict.update(certified=False,
                       reason=f"{side} dumped any fingerprint: it likely failed to start, "
                              f"see the logs listed above")
        return finish(verdict)
    if len(a) != len(b):
        verdict.update(certified=False,
                       reason=f"different number of dumped tensors: {len(a)} vs {len(b)}")
        return finish(verdict)
    diffs = [(i, x, y) for i, (x, y) in enumerate(zip(a, b)) if x != y]
    if diffs:
        i, x, y = diffs[0]
        verdict.update(certified=False, divergences=len(diffs), first_divergence=i,
                       reason=f"{len(diffs)} of {len(a)} tensors differ; first at index {i}",
                       stock_line=x[:200], wired_line=y[:200])
        return finish(verdict)
    verdict.update(certified=True, divergences=0,
                   reason=f"{len(a)} tensors identical, zero divergence")
    return finish(verdict)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model", required=True)
    ap.add_argument("--layer", type=int, default=3)
    ap.add_argument("--internal-pack", help="dual pack: internal half (overrides discovery)")
    ap.add_argument("--external-pack", help="dual pack: external half")
    ap.add_argument("--ratio", help="pass this ratio to the engine as GALACTUS_H4_RATIO "
                                    "(cross-check against the pack's own .split record)")
    ap.add_argument("--no-registry", action="store_true",
                    help="do not write certified_ppl and its provenance into the registry "
                         "(the run still writes its .verdict.json sidecar)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    v = certify(args.model, args.layer, args.internal_pack, args.external_pack, args.ratio,
                write_registry=not args.no_registry)
    if args.json:
        print(json.dumps(v, indent=2, ensure_ascii=False))
    else:
        print()
        print("CERTIFIED" if v["certified"] else "NOT CERTIFIED")
        print(f"  {v['reason']}")
        if v.get("stock_ppl") is not None:
            print(f"  ppl stock {v['stock_ppl']}  wired {v['wired_ppl']}")
            print(f"  on {v['ppl']['corpus']} (sha256 {v['ppl']['corpus_sha256'][:16]}), "
                  f"seed {v['ppl']['seed']}, ctx {v['ppl']['ctx']}, "
                  f"batch {v['ppl']['batch']}/{v['ppl']['ubatch']}")
        print(f"  verdict {v['verdict_file']}")
        if v.get("registry_written"):
            print(f"  registry {REGISTRY}")
            print(f"  packaged {PACKAGED_REGISTRY}")
    return 0 if v["certified"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
