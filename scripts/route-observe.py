#!/usr/bin/env python3
"""Record what the router selected, for one model at one cache budget.

WHY THIS SCRIPT EXISTS

The prefetch question is empirical: the router of layer L+1 consumes the output
of layer L, so no prefetch can be exact, and the only thing that decides whether
speculation pays is a hit rate measured on real routes against the bytes the
guess wastes. This launches the engine with GALACTUS_H4_ROUTES set, which makes
the remap callback record, per decoded token and per MoE layer, the expert ids
the router picked, in score order, together with the residency bit each id had
BEFORE the layer was served and the timestamps around the read.

It launches the same way scripts/bench-curve.py does, at the cache budget the
app would plan for a given Mac tier, because a prefetch design has to be judged
on the regime a user actually gets: a fully resident cache never reads the SSD
at all, so it has nothing to prefetch and nothing to say.

Usage:
  python3 scripts/route-observe.py --model qwen3-30b-a3b --mac 16
  python3 scripts/route-observe.py --model phi35-moe --mac 16 --ranks
"""
from __future__ import annotations

import argparse
import importlib.util
import os
import pathlib
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "artifacts" / "h4" / "routes"

# WHY NOT THE BENCH PROMPT
#
# scripts/bench-curve.py repeats one paragraph twenty four times, which is the
# right prompt for a throughput bench and the wrong one for this question. A
# prompt that says the same thing twenty four times routes to the same experts
# twenty four times, so it warms the cache in a way no real prompt does and it
# flatters every predictor that looks backwards. This one is a single passage of
# ordinary prose, never repeating, followed by an instruction that produces a
# long free running answer. Generation is what the study is about; the prompt is
# only there to leave the cache in a realistic state.
PROMPT = (
    "You are a systems engineer writing for other engineers. Below is some "
    "background, and then a task.\n\n"
    "Background. A solid state drive presents itself as a flat array of logical "
    "blocks, but underneath it is a collection of NAND dies that can only be "
    "erased in large units and only written in smaller ones. The flash "
    "translation layer keeps a mapping from logical addresses to physical pages "
    "and rewrites that mapping constantly, which is why sustained random writes "
    "eventually collapse to the speed of garbage collection rather than the "
    "speed of the flash. Controllers hide this with a fast single level cell "
    "region that absorbs bursts and is folded into denser cells later, during "
    "idle time if there is any. Meanwhile a distributed database on the other "
    "side of the machine is making its own assumptions: that a commit is durable "
    "once fsync returns, that a sequential log is cheap, and that read latency is "
    "roughly constant. Those assumptions meet the drive somewhere in the middle "
    "of the night, when a compaction and a garbage collection cycle overlap and "
    "the tail latency of a supposedly read only query goes up by two orders of "
    "magnitude. The interesting failures are never in one layer; they are in the "
    "handshake between two layers that each behave correctly on their own.\n\n"
    "Task. Write a long, concrete technical note for a colleague who has to debug "
    "exactly that class of failure. Cover how you would instrument the storage "
    "stack, what you would measure first, which measurements are traps, how you "
    "would separate a controller problem from a file system problem from an "
    "application problem, and what you would change if the tail latency turned "
    "out to be unavoidable. Use examples. Do not summarise; go into detail.\n"
)


def load_bench_curve():
    """bench-curve.py as a module, so the launch is not a second opinion.

    Every path, geometry, cache ceiling and slot plan comes from there. A copy
    of those rules here would drift, and a route file taken at a budget the app
    never plans would answer a question nobody asked.
    """
    path = ROOT / "scripts" / "bench-curve.py"
    spec = importlib.util.spec_from_file_location("bench_curve", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    ap = argparse.ArgumentParser(description="Record MoE routes from a real decode run.")
    ap.add_argument("--model", required=True, help="registry model id")
    ap.add_argument("--mac", type=int, default=16,
                    help="Mac tier in GB whose planned cache budget to run at (default 16)")
    ap.add_argument("--cache-gb", type=float, default=None,
                    help="run at this cache budget instead of a Mac tier, for a smoke test or "
                         "for a model the lineup only ever runs fully resident")
    ap.add_argument("--predict", type=int, default=256, help="tokens to generate")
    ap.add_argument("--prompt-file", default=None,
                    help="use this file as the prompt instead of the built in passage")
    ap.add_argument("--ranks", action="store_true",
                    help="also record the argsort ranks below the top-k cut, which is what "
                         "answers whether a wider fetch would have covered the next token")
    ap.add_argument("--out", default=None, help="route file (default under artifacts/h4/routes)")
    ap.add_argument("--pack", default=None,
                    help="read the expert pack from here instead of artifacts/h4/packs. The "
                         "routes do not change with the storage, the timestamps do, so this "
                         "is how the same decode is measured on two different devices")
    ap.add_argument("--force", action="store_true",
                    help="record even on a busy machine, and say so. The hit rates would "
                         "survive that; the timestamps in the same file would not")
    args = ap.parse_args()

    bench = load_bench_curve()
    registry = bench.load_registry()
    entry = bench.find_model(registry, args.model)
    gguf = bench.resolve_gguf(args.model)
    pack = pathlib.Path(args.pack) if args.pack else bench.resolve_pack(args.model)
    if not pack.is_file():
        print(f"ECHEC: no pack at {pack}", file=sys.stderr)
        return 2
    geo = bench.read_geometry(args.model, entry)

    if args.cache_gb is not None:
        cache_bytes = int(args.cache_gb * 1e9)
        label = f"cache {args.cache_gb:g} Go"
    else:
        cache_bytes = bench.max_cache_bytes(args.mac, geo)
        label = f"Mac {args.mac} Go"
    plan = bench.plan_slots(cache_bytes, geo)
    if not plan.get("ok"):
        print(f"ECHEC: {label} is refused for {args.model}: {plan['why']}", file=sys.stderr)
        return 2
    if plan.get("resident"):
        print(f"AVERTISSEMENT: {label} holds every routed expert of {args.model}. "
              f"Nothing is read from the SSD, so there is nothing to prefetch and the "
              f"route file will say so.")

    tier = {"mac_gb": args.mac if args.cache_gb is None else None,
            "cache_bytes": cache_bytes, **plan}
    ubatch = bench.ship_ubatch(tier, geo)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    suffix = "-ranks" if args.ranks else ""
    budget = f"cache{args.cache_gb:g}g" if args.cache_gb is not None else f"mac{args.mac}g"
    routes = pathlib.Path(args.out) if args.out else \
        OUT_DIR / f"{args.model}-{budget}{suffix}-{stamp}.routes"
    log = routes.with_suffix(".log")

    prompt = PROMPT
    if args.prompt_file is not None:
        prompt = pathlib.Path(args.prompt_file).read_text(encoding="utf-8")

    env = dict(os.environ)
    env.update({
        "LC_ALL": "C",
        "GALACTUS_H4": "1",
        "GALACTUS_PROFILE": str(geo["profile"]),
        "GALACTUS_H4_INTERNAL": str(pack),
        "GALACTUS_H4_EXTERNAL": str(pack),
        "GALACTUS_H4_CACHE_BYTES": str(cache_bytes),
        "GALACTUS_H4_PROTECTED": f"{plan['fraction']:.2f}",
        "GALACTUS_H4_QD": str(bench.QUEUE_DEPTH),
        "GALACTUS_METAL_BITEXACT": "1",
        "GALACTUS_H4_ROUTES": str(routes),
    })
    if args.ranks:
        env["GALACTUS_H4_ROUTES_RANKS"] = "1"

    command = [
        str(bench.LLAMA_CLI),
        "--model", str(gguf),
        "-p", prompt,
        "--predict", str(args.predict),
        "--ctx-size", str(bench.CTX),
        "--n-gpu-layers", "99",
        "--no-repack", "--fit", "off", "--no-mmap",
        "--batch-size", str(bench.SHIP_BATCH),
        "--ubatch-size", str(ubatch),
        "--seed", str(bench.SEED), "--temp", "0",
        "--single-turn", "--simple-io", "--show-timings", "--log-colors", "off",
    ]

    print(f"observation {args.model} sur {label}")
    print(f"  cache    {cache_bytes / 1e9:.2f} Go, quota {plan['quota']}/{geo['experts']}, "
          f"probation {plan['probation']}, protected {plan['fraction']:.2f}")
    print(f"  geometry {geo['layers']} MoE layers, {geo['experts']} experts, "
          f"{geo['used']} used, {geo['one_of_each'] / geo['layers'] / 1e6:.2f} MB per record")
    print(f"  batch    {bench.SHIP_BATCH} logical, {ubatch} physical")
    print(f"  prompt   {len(prompt)} characters, {args.predict} tokens generated")
    print(f"  pack     {pack}")
    print(f"  routes   {routes}")
    # The file carries timings as well as routes, and a timing taken next to a
    # build measures the build. Same guard as scripts/bench-curve.py.
    bench.require_quiet_machine(args.force)

    started = time.time()
    with log.open("wb") as handle:
        subprocess.run(command, env=env, stdout=handle, stderr=subprocess.STDOUT, check=False)
    elapsed = time.time() - started
    raw = log.read_text(encoding="utf-8", errors="replace")
    timing = [line for line in raw.splitlines() if "t/s" in line]
    print(f"  fini en {elapsed:.0f}s")
    for line in timing[-2:]:
        print(f"  {line.strip()}")
    if not routes.is_file():
        print(f"ECHEC: no route file was written, see {log}", file=sys.stderr)
        return 1
    print(f"  taille   {routes.stat().st_size / 1e6:.1f} Mo")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
