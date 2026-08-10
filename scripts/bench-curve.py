#!/usr/bin/env python3
"""Measure the memory-tier throughput curve of one model, for any MoE model.

WHY THIS SCRIPT EXISTS

lanceurs/banc/ held one launcher per model, each with that model's GGUF path,
pack path, record size, MoE layer count, system margin and full-residency size
baked in as constants. Adding a model meant copying a file and editing six
numbers, which is exactly why the three most recently certified models shipped
with an empty `measured` array in scripts/models-registry.json. Nothing here is
per-model: the identifier is the only argument, and every number comes from the
registry, from models/<id>/ and from artifacts/h4/packs/<id>/.

WHAT A TIER IS

A tier is a Mac from the official lineup (registry `mac_lineup.tiers_gb`) and
the expert-cache budget the app would actually give the model on it. That
budget is not a hand-picked "RAM minus a margin": it is the ceiling computed by
plan_cache() in app/src-tauri/src/lib.rs, mirrored here term for term. Measuring
anywhere else would produce a curve the planner never lands on, and the app
interpolates generation throughput straight out of these points.

WHY THE CURVE STOPS AT FULL RESIDENCY

Once the arena holds every routed expert byte, a bigger cache buys nothing: the
cache stops evicting and the throughput is flat from there on. Worse, a Mac
with that much memory can run the model as plain stock llama.cpp, which is
faster than any streamed regime, so a measured point above full residency would
advertise Galactus on ground where Galactus is not the right answer. The sweep
therefore emits the first tier that reaches full residency and stops.

WHAT IS NEVER DONE HERE

No point is invented, interpolated or extrapolated. A tier the engine refuses
(quota below 2 slots, or a probation segment too small to hold the distinct
experts of one micro-batch) is reported as refused and left out of the curve. A
run that produces no timing line is reported as failed and left out too.

Usage:
  python3 scripts/bench-curve.py --model olmoe-1b-7b
  python3 scripts/bench-curve.py --model phi35-moe --dry-run
  python3 scripts/bench-curve.py --model qwen3-coder-30b --update-registry
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
PACKAGED_REGISTRY = ROOT / "app" / "src-tauri" / "packaged" / "scripts" / "models-registry.json"
LLAMA_CLI = ROOT / "third_party" / "llama.cpp" / "build" / "bin" / "llama-cli"
OUT_DIR = ROOT / "artifacts" / "h4" / "bench"

# TWO REGIMES, AND ONLY ONE OF THEM IS WHAT A USER GETS
#
# The six per-model launchers this script replaces all measured the CROSS-CHECK
# path: experts and biases recomputed on the CPU, physical micro-batch 1. That
# path exists to prove the Metal kernels bit for bit, not to be fast, and the
# app never takes it unless a model is explicitly flagged `cpu_moe` in the
# registry. Today no model is.
#
# What the app actually launches (start_engine in app/src-tauri/src/lib.rs) is
# the SHIPPED path: Metal bit-exact experts, logical batch 512, and the
# planner's physical micro-batch, which is 512 once the cache holds every
# routed expert and probation/experts_used capped at 8 below that. The
# difference is not a detail. Prompt processing measured five to thirteen times
# faster at full residency, so a cross-check curve understates by that much
# exactly where a well-provisioned Mac lands.
#
# `ship` is the default because the curve is shown to a user as what their
# machine will do. `crosscheck` stays reachable for comparing against the older
# curves that were taken that way, and every curve records which one it used.
REGIMES = ("ship", "crosscheck")

# The prompt has to outlast one micro-batch or the prompt column measures the
# wrong thing. At the shipped batch of 512 a fifty-token prompt fits entirely in
# the first micro-batch, so its throughput is fixed startup cost divided by
# fifty and it looks slower on the faster path. The paragraph below is repeated
# until the prompt is comfortably longer than 512 tokens, which makes the number
# a prefill rate rather than a startup artefact. Generation is unaffected either
# way; it is also the only column the app reads when it estimates a machine.
PROMPT_UNIT = (
    "Write a detailed, well-structured explanation of how a modern solid state "
    "drive stores, reads and wears its flash cells, covering SLC caching, wear "
    "leveling and garbage collection, in about three hundred words. "
)
PROMPT_REPEATS = 24
PROMPT = PROMPT_UNIT * PROMPT_REPEATS
PREDICT = 192
CTX = 4096
QUEUE_DEPTH = 32
SEED = 42

# A throughput bench measures the machine, so the machine has to be idle. This
# was learned the expensive way: a first sweep ran while a parallel TypeScript
# build and its test suites held the same cores, and produced 1.3 prompt tok/s
# on a tier whose architectural twin measured 7.6, plus two runs that took three
# times as long as the same work on a quiet machine. Nothing in the numbers said
# so. A bench that cannot tell you it was disturbed will publish the disturbance
# as a property of the model.
#
# The sharp instrument is the process list below, not this number. A desktop Mac
# with a window server and an animated wallpaper idles near a load of 2, so a
# threshold set anywhere near that refuses every honest run and teaches whoever
# hits it to reach for --force, which is worse than having no guard. This is a
# coarse backstop for sustained load the process list does not name.
MAX_LOAD_AVG = 4.0

# Cross-check only. The logical batch is 2 rather than 1 because llama.cpp
# sizes its output buffers from it and asserts in output_reserve on a batch of
# one; the physical micro-batch is what the measurement is about.
CROSSCHECK_BATCH = 2
CROSSCHECK_UBATCH = 1
# Shipped path. Mirrors the two arguments start_engine passes: the logical
# batch is fixed, the physical one comes from the planner per tier.
SHIP_BATCH = 512
SHIP_RESIDENT_UBATCH = 512
SHIP_STREAMED_UBATCH_CAP = 8


def load_average() -> float:
    """The one-minute load average, or 0.0 where the platform has none."""
    try:
        return os.getloadavg()[0]
    except (OSError, AttributeError):
        return 0.0


def competing_processes() -> list[str]:
    """Build and test commands running right now, by name.

    The load average alone is not enough. It is an average, so a build that
    started thirty seconds ago barely shows in it while it is already taking
    the cores this bench needs. These are the commands that actually caused a
    contaminated sweep, plus another engine, which would be competing for the
    same SSD as well as the same cores.
    """
    names = ("tsc", "cargo", "rustc", "npm", "vite", "llama-cli", "llama-server", "cmake")
    try:
        out = subprocess.run(["/bin/ps", "-Ao", "comm="], capture_output=True, text=True,
                             check=False).stdout
    except OSError:
        return []
    seen = []
    for line in out.splitlines():
        base = line.strip().rsplit("/", 1)[-1]
        if base in names and base not in seen:
            seen.append(base)
    return seen


def require_quiet_machine(force: bool) -> None:
    """Refuse to measure on a busy machine, or say plainly that it was ignored.

    Refusing is the right default. A contaminated curve is worse than a missing
    one: it looks exactly like a measurement, it gets written to the registry,
    and the app then tells a user their Mac will do a number no Mac ever did.
    """
    load = load_average()
    busy = competing_processes()
    reasons = []
    if load > MAX_LOAD_AVG:
        reasons.append(f"load average {load:.2f} is above {MAX_LOAD_AVG:.1f}")
    if busy:
        reasons.append("these are running: " + ", ".join(busy))
    if not reasons:
        return
    msg = ("the machine is not idle, so the timings would measure it too ("
           + "; ".join(reasons) + ")")
    if not force:
        die(f"{msg}. Wait for it to finish, or pass --force to measure anyway")
    print(f"AVERTISSEMENT: {msg} (--force)")


def ship_ubatch(tier: dict, geo: dict) -> int:
    """The physical micro-batch the planner would choose for this tier.

    Mirrors the ubatch branch of plan_cache() in app/src-tauri/src/lib.rs. A
    resident cache never evicts, so nothing constrains the batch shape; a
    streamed one must not admit more distinct experts than its probation
    segment holds, or a cold batch evicts its own members.
    """
    if tier.get("resident"):
        return SHIP_RESIDENT_UBATCH
    return min(max(tier["probation"] // geo["used"], 1), SHIP_STREAMED_UBATCH_CAP)

# The SLRU protected fractions the engine accepts, largest first. The planner
# takes the largest one whose probation segment still holds the distinct
# experts of a micro-batch, so a small machine trades hit rate for the right to
# run at all. Mirrors plan_cache() and h4-expert-cache.cpp.
PROTECTED_FRACTIONS = (0.75, 0.50, 0.25)

# A curve with one or two points is a curve the app cannot interpolate on: eco
# and perf collapse onto the same cache and the knee is whatever was measured
# first. When the Mac lineup yields fewer than this many points, which happens
# exactly when the model reaches full residency on the smallest Mac, the sweep
# adds points below the smallest Mac tier, taken as fractions of the model's
# own expert size. Those points carry no mac_gb: they are cache budgets, not
# machines.
MIN_POINTS = 4
FILL_FRACTIONS = (0.125, 0.25, 0.5, 0.75)


def die(msg: str) -> "None":
    print(f"ECHEC: {msg}", file=sys.stderr)
    raise SystemExit(2)


def load_registry() -> dict:
    if not REGISTRY.is_file():
        die(f"registry not found: {REGISTRY}")
    return json.loads(REGISTRY.read_text(encoding="utf-8"))


def find_model(registry: dict, model_id: str) -> dict:
    for m in registry.get("models", []):
        if m.get("id") == model_id:
            return m
    known = ", ".join(sorted(m.get("id", "?") for m in registry.get("models", [])))
    die(f"{model_id} is not in {REGISTRY}. Known ids: {known}")
    raise AssertionError("unreachable")


def resolve_gguf(model_id: str) -> pathlib.Path:
    """The GGUF to open, or an error naming the directory that was searched."""
    mdir = ROOT / "models" / model_id
    if not mdir.is_dir():
        die(f"no model directory for {model_id}: {mdir} does not exist. "
            f"Download the GGUF first (see lanceurs/telechargement/).")
    ggufs = sorted(mdir.glob("*.gguf"))
    if not ggufs:
        die(f"no .gguf file for {model_id}: looked in {mdir}. "
            f"Download the GGUF first (see lanceurs/telechargement/).")
    # Sharded checkpoints: llama.cpp is handed the first shard and finds the
    # rest by itself.
    return next((g for g in ggufs if "00001-of-" in g.name), ggufs[0])


def resolve_pack(model_id: str) -> pathlib.Path:
    """The expert pack, or an error naming the directory that was searched."""
    pdir = ROOT / "artifacts" / "h4" / "packs" / model_id
    if not pdir.is_dir():
        die(f"no pack directory for {model_id}: {pdir} does not exist. "
            f"Build the pack first (plan, then write).")
    every = sorted(pdir.glob("*.pack"))
    # The fixture pack holds three records and exists only to prove the packing
    # chain end to end in seconds. Alphabetical order puts it first, and picking
    # it is silent and fatal: every run dies on the first expert miss.
    packs = [p for p in every if "fixture" not in p.name]
    if not packs:
        if every:
            die(f"only a fixture pack exists for {model_id} in {pdir}: "
                f"run the full pack write before benching.")
        die(f"no .pack file for {model_id}: looked in {pdir}. "
            f"Build the pack first (plan, then write).")
    # Largest wins: a full pack dwarfs anything partial left behind.
    packs.sort(key=lambda p: p.stat().st_size, reverse=True)
    return packs[0]


def read_engine_profile(model_id: str) -> dict:
    """The frozen per-layer record table the engine itself will use.

    This is the same file passed as GALACTUS_PROFILE, so the quota computed
    below is the quota the engine will compute, not an approximation of it.
    """
    path = ROOT / "models" / model_id / "profile.engine.txt"
    if not path.is_file():
        die(f"no engine profile for {model_id}: looked for {path}. "
            f"Regenerate it with scripts/moe-profile.py, or reinstall the model.")
    first = last = experts = used = None
    records: dict[int, int] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "first_layer":
            first = int(parts[1])
        elif parts[0] == "last_layer":
            last = int(parts[1])
        elif parts[0] == "experts":
            experts = int(parts[1])
        elif parts[0] == "used":
            used = int(parts[1])
        elif parts[0] == "layer" and len(parts) >= 4 and parts[2] == "record":
            records[int(parts[1])] = int(parts[3])
    if first is None or last is None or experts is None or used is None or not records:
        die(f"{path} is not a readable engine profile (missing header or layer records)")
    missing = [n for n in range(first, last + 1) if n not in records]
    if missing:
        die(f"{path} has no record size for layer(s) {missing[:5]}")
    return {
        "path": path,
        "first_layer": first,
        "last_layer": last,
        "experts": experts,
        "used": used,
        "records": [records[n] for n in range(first, last + 1)],
    }


def read_geometry(model_id: str, entry: dict) -> dict:
    """Everything the sweep needs, measured from the GGUF rather than assumed.

    models/<id>/profile.json is written by scripts/moe-profile.py from the real
    checkpoint, so it is the truth; the registry is only a pre-install estimate
    and is used solely to fill a field the profile does not carry.
    """
    prof = read_engine_profile(model_id)
    one_of_each = sum(prof["records"])
    expert_total = one_of_each * prof["experts"]

    json_path = ROOT / "models" / model_id / "profile.json"
    non_expert = None
    if json_path.is_file():
        totals = json.loads(json_path.read_text(encoding="utf-8")).get("totals", {})
        non_expert = totals.get("non_routed_bytes")
    if not non_expert:
        non_expert = entry.get("non_expert_bytes")
    if not non_expert:
        die(f"no non-expert weight size for {model_id}: neither {json_path} nor the "
            f"registry entry carries it, and the memory ceiling cannot be computed "
            f"without it")
    return {
        "profile": prof["path"],
        "first_layer": prof["first_layer"],
        "last_layer": prof["last_layer"],
        "layers": len(prof["records"]),
        "experts": prof["experts"],
        "used": prof["used"],
        "one_of_each": one_of_each,
        "expert_total": expert_total,
        "non_expert": int(non_expert),
    }


def system_reserve_bytes(ram: int) -> int:
    """RAM Galactus never assigns to weights or to the cache.

    Mirrors system_reserve_bytes() in app/src-tauri/src/lib.rs.
    """
    return max(2_000_000_000, ram // 16)


def max_cache_bytes(ram_gb: int, geo: dict) -> int:
    """The expert-cache ceiling the app would plan on a Mac of that size.

    Mirrors the ceiling in plan_cache(), app/src-tauri/src/lib.rs: the machine
    must still hold the non-expert weights, the runtime overhead that tracks
    them (KV cache, compute buffers, graph) and a reserve for macOS, and it
    never assigns more than 70 percent of unified memory nor more than every
    routed expert byte.
    """
    ram = ram_gb * 1_000_000_000
    non_expert = geo["non_expert"]
    runtime_overhead = 2_500_000_000 + non_expert * 45 // 100
    afford = ram - (non_expert + runtime_overhead + system_reserve_bytes(ram))
    return max(0, min(afford, ram * 7 // 10, geo["expert_total"]))


def plan_slots(cache_bytes: int, geo: dict) -> dict:
    """Quota, protected fraction and probation for a cache budget, or a refusal.

    Mirrors ExpertCache's constructor (src/h4/h4-expert-cache.cpp) and the
    fraction search in plan_cache(). Returning a refusal rather than a number is
    the point: a tier the engine would abort on must never end up in the curve.
    """
    if cache_bytes < geo["one_of_each"]:
        return {"ok": False, "why": "cache below one expert per layer"}
    quota = min(cache_bytes // geo["one_of_each"], geo["experts"])
    if quota < 2:
        return {"ok": False, "why": f"quota {quota} slots per layer, the engine needs 2"}
    if quota == geo["experts"]:
        # Full residency: every expert owns a permanent slot, the cache never
        # evicts, and both SLRU segments are carried up to the quota.
        return {"ok": True, "quota": int(quota), "fraction": 0.75,
                "probation": int(quota), "resident": True}
    for fraction in PROTECTED_FRACTIONS:
        protected = min(max(int(quota * fraction), 1), quota - 1)
        probation = quota - protected
        if probation >= geo["used"]:
            return {"ok": True, "quota": int(quota), "fraction": fraction,
                    "probation": int(probation), "resident": False}
    return {"ok": False,
            "why": f"quota {quota}, probation below the {geo['used']} distinct experts "
                   f"of one micro-batch even at protected 0.25"}


def build_tiers(registry: dict, geo: dict) -> list[dict]:
    """The tiers to measure, ascending, stopping at full residency.

    Two sources, in this order:
      - the official Mac lineup, each mapped through the planner ceiling. The
        first tier whose ceiling reaches full residency is the last one kept:
        above it the curve is flat and stock llama.cpp is the faster answer.
      - fill points below the smallest Mac tier, as fractions of the model's own
        expert size, and only when the lineup yielded fewer than MIN_POINTS.
        A small model reaches full residency on a 16 GB Mac, so without these
        its whole curve would be a single point.
    """
    lineup = registry.get("mac_lineup", {}).get("tiers_gb")
    if not lineup:
        die(f"{REGISTRY} has no mac_lineup.tiers_gb, there is no Mac range to sweep")
    tiers: list[dict] = []
    for ram_gb in sorted(lineup):
        cache = max_cache_bytes(ram_gb, geo)
        plan = plan_slots(cache, geo)
        tiers.append({"mac_gb": ram_gb, "cache_bytes": cache, **plan})
        if cache >= geo["expert_total"]:
            break

    viable = [t for t in tiers if t.get("ok")]
    if len(viable) < MIN_POINTS and viable:
        floor = min(t["cache_bytes"] for t in viable)
        fill: list[dict] = []
        for f in FILL_FRACTIONS:
            cache = int(geo["expert_total"] * f)
            if cache >= floor:
                continue
            plan = plan_slots(cache, geo)
            if not plan["ok"]:
                # Below the engine's own floor. Silently dropped rather than
                # reported: it is a candidate this script proposed, not a
                # machine a user owns.
                continue
            fill.append({"mac_gb": None, "cache_bytes": cache, **plan})
        tiers = fill + tiers
    return tiers


def run_tier(model_id: str, gguf: pathlib.Path, pack: pathlib.Path, profile: pathlib.Path,
             tier: dict, log: pathlib.Path, predict: int, regime: str, geo: dict) -> dict:
    env = dict(os.environ)
    env.update({
        "LC_ALL": "C",
        "GALACTUS_H4": "1",
        "GALACTUS_PROFILE": str(profile),
        "GALACTUS_H4_INTERNAL": str(pack),
        "GALACTUS_H4_EXTERNAL": str(pack),
        "GALACTUS_H4_CACHE_BYTES": str(tier["cache_bytes"]),
        "GALACTUS_H4_PROTECTED": f"{tier['fraction']:.2f}",
        "GALACTUS_H4_QD": str(QUEUE_DEPTH),
    })
    args = [
        str(LLAMA_CLI),
        "--model", str(gguf),
        "-p", PROMPT,
        "--predict", str(predict),
        "--ctx-size", str(CTX),
        "--n-gpu-layers", "99",
        "--no-repack", "--fit", "off", "--no-mmap",
    ]
    if regime == "crosscheck":
        env["GALACTUS_H4_CPU_MOE"] = "1"
        args += ["--n-cpu-moe", "99",
                 "--batch-size", str(CROSSCHECK_BATCH),
                 "--ubatch-size", str(CROSSCHECK_UBATCH)]
    else:
        # The same two variables start_engine sets on the default path. Metal
        # experts replay the CPU algorithm bit for bit here, so this is the
        # certified numerics AND the speed, not a trade between them.
        env["GALACTUS_METAL_BITEXACT"] = "1"
        args += ["--batch-size", str(SHIP_BATCH),
                 "--ubatch-size", str(ship_ubatch(tier, geo))]
    args += [
        "--seed", str(SEED), "--temp", "0",
        "--single-turn", "--simple-io", "--show-timings", "--log-colors", "off",
    ]
    started = time.time()
    with log.open("wb") as fh:
        subprocess.run(args, env=env, stdout=fh, stderr=subprocess.STDOUT, check=False)
    elapsed = time.time() - started
    raw = log.read_text(encoding="utf-8", errors="replace")
    hits = re.findall(r"Prompt:\s*([0-9.]+)\s*t/s\s*\|\s*Generation:\s*([0-9.]+)\s*t/s", raw)
    if not hits:
        # No timing line means the run died, usually on startup. Naming the log
        # matters more than guessing why: the engine prints its own refusal.
        reason = next((line.strip() for line in raw.splitlines() if "galactus_h4:" in line
                       and ("erreur" in line or "error" in line)), None)
        return {"ok": False, "seconds": elapsed, "log": log,
                "why": reason or f"no timing line in {log.name}"}
    prompt_tps, gen_tps = hits[-1]
    return {"ok": True, "seconds": elapsed, "log": log,
            "prompt_tps": float(prompt_tps), "gen_tps": float(gen_tps)}


def measured_point(tier: dict, result: dict) -> dict:
    """One entry of the registry's `measured` array, in the app's schema.

    MeasuredPoint in app/src/api.ts: cache_gb, gen_tps, prompt_tps?, mac_gb?.
    cache_gb is the budget handed to the engine, in decimal GB, because that is
    the unit plan_cache() compares against when it interpolates.
    """
    point = {
        "cache_gb": round(tier["cache_bytes"] / 1e9, 2),
        "gen_tps": result["gen_tps"],
        "prompt_tps": result["prompt_tps"],
    }
    if tier["mac_gb"] is not None:
        point["mac_gb"] = tier["mac_gb"]
    return point


SETTLE_SECONDS = 45


def settle(after_a_run: bool) -> None:
    """Let the machine come back to itself between two tiers.

    Measured, not assumed: the same tier of the same model read 1.8 generated
    tokens per second as the fifth tier of a sweep and 2.4 in a process of its
    own, a third apart. A tier that has just held a forty gigabyte arena leaves
    the memory system busy reclaiming it, and the next tier pays for that and
    reports it as the model being slower on a bigger machine.

    A pause is a mitigation, not a fix. Measuring one tier per process, with
    --only-mac, is the honest protocol for a curve that will be published, and
    it is what the launcher does for the largest models.
    """
    if not after_a_run:
        return
    print(f"    (pause de {SETTLE_SECONDS}s pour laisser la machine se reposer)", flush=True)
    time.sleep(SETTLE_SECONDS)


def note_for(registry: dict, regime: str, predict: int, full_gb: float) -> str:
    """The provenance line stored beside the curve.

    It names the regime because the registry held both for a while and nothing
    on screen distinguished them: six model cards were showing a number measured
    on a path the app does not take.
    """
    path = ("cross-check path (CPU experts and biases), ubatch "
            f"{CROSSCHECK_UBATCH}" if regime == "crosscheck"
            else f"shipped path (Metal bit-exact experts), batch {SHIP_BATCH}, planner ubatch")
    return (f"{registry.get('reference_machine', 'reference machine')}, {path}, "
            f"{predict} predicted tokens on a {PROMPT_REPEATS}-paragraph prompt, "
            f"bench {time.strftime('%Y-%m-%d', time.gmtime())} by scripts/bench-curve.py; "
            f"cache = app planning ceiling per Mac tier, curve stops at full residency "
            f"({full_gb:.2f} GB)")


SHIP_MARK = "shipped path"


def regime_of(note: str) -> str:
    """Which regime a stored note describes. Unknown counts as its own regime.

    An empty or unrecognised note means nobody recorded how those numbers were
    taken, and points nobody can vouch for must not be merged with points
    somebody can.
    """
    if SHIP_MARK in note:
        return "ship"
    if "cross-check path" in note:
        return "crosscheck"
    return "unknown"


def merge_points(existing: list[dict], fresh: list[dict], same_regime: bool) -> list[dict]:
    """Fresh points win over stored ones at the same cache budget, sorted.

    Sweeping one tier at a time is not a convenience: the whole sweep of a large
    model runs for hours, and anything that interrupts it used to throw away
    every tier it had already measured, so the biggest models were the ones that
    could never be finished. A tier is a complete measurement on its own, so it
    is merged on its own, keyed on the cache budget it was taken at.

    Merging stops at the regime boundary. Two regimes in one curve would be the
    worst of both: the app interpolates straight across the points, so a card
    would show a number half measured on a path it takes and half on one it does
    not, and no note could make that legible. The planner ceiling has moved too,
    so the old points do not even sit at the cache budgets the app now plans, and
    keying on cache_gb would silently keep every one of them. When the regime
    changes, the old curve goes.
    """
    base = list(existing) if same_regime else []
    by_cache = {round(float(p["cache_gb"]), 2): p for p in base}
    for p in fresh:
        by_cache[round(float(p["cache_gb"]), 2)] = p
    return [by_cache[k] for k in sorted(by_cache)]


def update_registry(model_id: str, points: list[dict], note: str) -> None:
    """Write the curve into both copies of the registry, keeping them identical.

    app/src-tauri/packaged/scripts/models-registry.json is a build input copied
    verbatim from scripts/models-registry.json by app/tools/sync-packaged.mjs.
    The same copy is done here so the two never drift between two app builds.
    """
    raw = REGISTRY.read_text(encoding="utf-8")
    data = json.loads(raw)
    for entry in data["models"]:
        if entry.get("id") == model_id:
            # The stored note is the only record of how the stored points were
            # taken, so it is what decides whether they may keep their place.
            stored = entry.get("measured_note") or ""
            same = regime_of(stored) == regime_of(note)
            entry["measured"] = merge_points(entry.get("measured") or [], points, same)
            entry["measured_note"] = note
            break
    else:
        die(f"{model_id} vanished from the registry between read and write")
    REGISTRY.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    if PACKAGED_REGISTRY.is_file():
        PACKAGED_REGISTRY.write_text(REGISTRY.read_text(encoding="utf-8"), encoding="utf-8")


def bench(model_id: str, predict: int, dry_run: bool, write_registry: bool,
          regime: str, force: bool, only_mac: set[int]) -> int:
    if not dry_run and not LLAMA_CLI.is_file():
        die(f"{LLAMA_CLI} is missing: build the engine first "
            f"(cmake --build third_party/llama.cpp/build --target llama-cli -j)")
    registry = load_registry()
    entry = find_model(registry, model_id)
    gguf = resolve_gguf(model_id)
    pack = resolve_pack(model_id)
    geo = read_geometry(model_id, entry)

    # The pack is the arena's backing store, so a pack that does not hold every
    # routed expert byte cannot serve a full-residency tier. Catching it here
    # names the mismatch; catching it at run time yields a short read.
    if pack.stat().st_size < geo["expert_total"]:
        die(f"pack {pack} is {pack.stat().st_size} bytes but the profile describes "
            f"{geo['expert_total']} bytes of routed experts: the pack is incomplete "
            f"or belongs to another checkpoint")

    tiers = build_tiers(registry, geo)
    if only_mac:
        tiers = [x for x in tiers if x["mac_gb"] in only_mac]
        if not tiers:
            die(f"no tier of {model_id} matches --only-mac {sorted(only_mac)}: "
                f"run --dry-run to see the tiers this model has")

    full_gb = geo["expert_total"] / 1e9
    print(f"banc {model_id} ({entry.get('arch', 'unknown arch')})")
    print(f"  gguf     {gguf.name}")
    print(f"  pack     {pack.name}")
    print(f"  profil   {geo['profile'].name}")
    print(f"  geometry {geo['layers']} MoE layers {geo['first_layer']}-{geo['last_layer']}, "
          f"{geo['experts']} experts, {geo['used']} used, "
          f"{geo['one_of_each'] / 1e6:.1f} MB per slot per layer")
    print(f"  residency full at {full_gb:.2f} GB of cache, "
          f"non-expert weights {geo['non_expert'] / 1e9:.2f} GB")
    if regime == "crosscheck":
        print(f"  regime   cross-check path (CPU experts and biases), "
              f"ubatch {CROSSCHECK_UBATCH}, {predict} predicted tokens")
        print("           NOT what the app launches: no registry model is flagged cpu_moe")
    else:
        print(f"  regime   shipped path (Metal bit-exact experts), batch {SHIP_BATCH}, "
              f"planner ubatch per tier, {predict} predicted tokens")
    print()
    for t in tiers:
        machine = f"Mac {t['mac_gb']} GB" if t["mac_gb"] is not None else "cache only"
        head = f"  {machine:<12} cache {t['cache_bytes'] / 1e9:6.2f} GB"
        if t.get("ok"):
            tag = "residence complete" if t["resident"] else f"protected {t['fraction']:.2f}"
            print(f"{head}  quota {t['quota']:>3}  probation {t['probation']:>3}  {tag}")
        else:
            print(f"{head}  REFUSE: {t['why']}")
    if dry_run:
        print("\n--dry-run: nothing was measured")
        return 0

    require_quiet_machine(force)

    runnable = [t for t in tiers if t.get("ok")]
    if not runnable:
        die(f"no tier of the Mac lineup can run {model_id}: nothing to measure")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    csv = OUT_DIR / f"{model_id}-paliers-{stamp}.csv"
    rows = ["machine_gb,cache_gb,quota,fraction,probation,prompt_tps,gen_tps"]
    points: list[dict] = []
    failures: list[str] = []
    measured_any = False
    print()
    for t in tiers:
        machine = str(t["mac_gb"]) if t["mac_gb"] is not None else "-"
        cache_gb = round(t["cache_bytes"] / 1e9, 2)
        if not t.get("ok"):
            rows.append(f"{machine},{cache_gb},-,-,-,refuse,refuse")
            continue
        suffix = f"mac{t['mac_gb']}g" if t["mac_gb"] is not None else f"cache{cache_gb:g}g"
        log = OUT_DIR / f"{model_id}-{suffix}-{stamp}.log"
        print(f"--- {('Mac ' + str(t['mac_gb']) + ' Go') if t['mac_gb'] is not None else 'palier'} "
              f"-> cache {cache_gb} Go (quota {t['quota']}, probation {t['probation']}) ---",
              flush=True)
        settle(measured_any)
        r = run_tier(model_id, gguf, pack, geo["profile"], t, log, predict, regime, geo)
        measured_any = True
        if not r["ok"]:
            print(f"    ECHEC en {r['seconds']:.0f}s : {r['why']}")
            failures.append(f"{machine} GB / cache {cache_gb} GB: {r['why']}")
            rows.append(f"{machine},{cache_gb},{t['quota']},{t['fraction']:.2f},"
                        f"{t['probation']},echec,echec")
            continue
        print(f"    prompt {r['prompt_tps']} t/s | generation {r['gen_tps']} t/s "
              f"({r['seconds']:.0f}s)")
        rows.append(f"{machine},{cache_gb},{t['quota']},{t['fraction']:.2f},"
                    f"{t['probation']},{r['prompt_tps']},{r['gen_tps']}")
        points.append(measured_point(t, r))
        if write_registry:
            # Written now, not at the end. A sweep that dies on tier six must
            # leave tiers one to five behind it, or a long model is a model
            # nobody can ever finish measuring.
            update_registry(model_id, [points[-1]], note_for(registry, regime, predict, full_gb))

    csv.write_text("\n".join(rows) + "\n", encoding="utf-8")
    note = note_for(registry, regime, predict, full_gb)
    sidecar = OUT_DIR / f"{model_id}-mesures-{stamp}.json"
    sidecar.write_text(json.dumps({"id": model_id, "measured": points,
                                   "measured_note": note}, indent=2) + "\n",
                       encoding="utf-8")

    print()
    print("=== TABLEAU FINAL ===")
    for row in rows:
        print("  " + row.replace(",", "\t"))
    print()
    print(f"CSV     : {csv}")
    print(f"Mesures : {sidecar}")
    print()
    print(json.dumps({"measured": points}, indent=2))
    if failures:
        print()
        print("PALIERS NON MESURES (aucun chiffre n'est invente a leur place) :")
        for f in failures:
            print(f"  - {f}")
    if write_registry:
        if not points:
            die("no tier produced a measurement: the registry is left untouched")
        update_registry(model_id, points, note)
        print()
        print(f"registre mis a jour : {REGISTRY}")
        print(f"copie packagee      : {PACKAGED_REGISTRY}")
    return 0 if points and not failures else (0 if points else 1)


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Measured memory-tier throughput curve for one registry model.")
    ap.add_argument("--model", required=True, help="registry model id, for example olmoe-1b-7b")
    ap.add_argument("--predict", type=int, default=PREDICT,
                    help=f"tokens generated per tier (default {PREDICT})")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the tiers and the plan, measure nothing")
    ap.add_argument("--update-registry", action="store_true",
                    help="write the curve into both copies of models-registry.json")
    ap.add_argument("--only-mac", type=int, nargs="+", metavar="GB",
                    help="measure only these Mac tiers and merge them into the stored curve, "
                         "for finishing a long sweep one tier at a time")
    ap.add_argument("--force", action="store_true",
                    help="measure even when the machine is busy, and say so in the output")
    ap.add_argument("--regime", choices=REGIMES, default="ship",
                    help="ship: what start_engine launches, Metal bit-exact experts and the "
                         "planner micro-batch (default). crosscheck: CPU experts at micro-batch "
                         "1, the path that proves the kernels and that the app does not take")
    args = ap.parse_args()
    return bench(args.model, args.predict, args.dry_run, args.update_registry,
                 args.regime, args.force, set(args.only_mac or []))


if __name__ == "__main__":
    raise SystemExit(main())
