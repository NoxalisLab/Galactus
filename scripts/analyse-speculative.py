#!/usr/bin/env python3
"""Would speculative decoding pay on an engine whose bottleneck is SSD reads.

WHAT THIS ANSWERS, AND WHAT IT CANNOT

Speculative decoding is the only acceleration technique whose output
distribution is provably the target model's, given exact rejection sampling.
On a compute bound engine it wins because one forward pass verifies k
positions. This engine is not compute bound: it is bound by the expert records
that reach the SSD. So the question is narrower and entirely measurable from
the route traces already in the repo:

  1. how much does the set of experts a layer needs grow when k adjacent
     positions are evaluated in one pass instead of one
  2. what does that mean NET OF THE SLRU CACHE, which already deduplicates
     across time and is the reason a single position only costs 1.17 records
     per layer instead of 8
  3. what acceptance rate makes the whole thing break even
  4. what the draft model costs, charged against the arena it takes from

Point 3 is the one the traces CANNOT answer. An acceptance rate is a property
of a draft/target pair on a prompt distribution, and no draft model was ever
run here. This script reports the break-even rate and sweeps around it; it
does not pretend to measure the real one.

NOTHING IS RUN. Every number below comes from artifacts/h4/routes/*.routes,
from cache-plans/*.txt and from models/*/profile.json.

Usage:
  python3 scripts/analyse-speculative.py
  python3 scripts/analyse-speculative.py --routes artifacts/h4/routes/<f>.routes
"""
from __future__ import annotations

import argparse
import collections
import importlib.util
import pathlib
import random
import statistics
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
ROUTES_DIR = ROOT / "artifacts" / "h4" / "routes"
PLANS_DIR = ROOT / "cache-plans"

# One parser and one cache, not two. analyse-routes.py owns the SLRU that is
# checked callback by callback against the residency bits the engine recorded;
# a second copy here would be a cache nobody validated.
_SPEC = importlib.util.spec_from_file_location(
    "galactus_analyse_routes", ROOT / "scripts" / "analyse-routes.py")
routes_mod = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(routes_mod)

Routes = routes_mod.Routes
Slru = routes_mod.Slru
steps_of = routes_mod.steps_of

# The traces this study uses: the smallest cache budget the app plans for each
# model, which is the only regime where the SSD is on the critical path at all.
SMALLEST = {
    "qwen3-30b-a3b": "qwen3-30b-a3b-mac16g-20260810T091113Z.routes",
    "phi35-moe": "phi35-moe-mac16g-20260810T091209Z.routes",
    "olmoe-1b-7b": "olmoe-1b-7b-cache1.95g-ranks-20260810T085651Z.routes",
}
# A second trace of the same model at a larger budget, used only to cross check
# the union of two adjacent positions against a real two token micro-batch.
TWO_TOKEN = "qwen3-30b-a3b-mac24g-20260810T091941Z.routes"

GENERATION_STEPS = 256
PROTECTED_FRACTIONS = (0.75, 0.50, 0.25)


# --------------------------------------------------------------------------
# Geometry and planning, mirrored from scripts/bench-curve.py


def plan_slots(cache_bytes: int, one_of_each: int, experts: int, used: int) -> dict:
    """Quota, protected fraction and probation for a budget, or a refusal.

    Mirrors plan_slots() in scripts/bench-curve.py, which mirrors the
    ExpertCache constructor. Copied rather than imported because bench-curve.py
    is off limits for edits and importing it drags in a registry read this
    analysis has no business doing.
    """
    if cache_bytes < one_of_each:
        return {"ok": False, "why": "cache below one expert per layer"}
    quota = min(cache_bytes // one_of_each, experts)
    if quota < 2:
        return {"ok": False, "why": f"quota {quota}, the engine needs 2"}
    if quota == experts:
        return {"ok": True, "quota": int(quota), "fraction": 0.75,
                "probation": int(quota), "resident": True}
    for fraction in PROTECTED_FRACTIONS:
        protected = min(max(int(quota * fraction), 1), quota - 1)
        probation = quota - protected
        if probation >= used:
            return {"ok": True, "quota": int(quota), "fraction": fraction,
                    "probation": int(probation), "resident": False}
    return {"ok": False, "why": f"quota {quota}, probation below {used} even at 0.25"}


def ship_ubatch(plan: dict, used: int, cap: int = 8) -> int:
    """The physical micro-batch the planner would choose. Mirrors ship_ubatch().

    This is the constraint speculative decoding runs into head first: a verify
    pass of k+1 positions IS a micro-batch of k+1, and the planner refuses a
    micro-batch whose distinct experts do not fit the probation segment.
    """
    if plan.get("resident"):
        return cap
    return min(max(plan["probation"] // used, 1), cap)


# --------------------------------------------------------------------------
# Section 1: how the expert set grows with the number of verified positions


def per_layer_sequences(routes: Routes, generation_steps: int) -> dict[int, list[set[int]]]:
    """The generation phase as, per layer, one expert set per decoded position."""
    steps = steps_of(routes)
    if generation_steps >= len(steps):
        raise SystemExit(f"ECHEC: {len(steps)} steps in {routes.path.name}")
    sequences: dict[int, list[set[int]]] = collections.defaultdict(list)
    for step in steps[len(steps) - generation_steps:]:
        for entry in step:
            # A multi token entry already IS a union; this section is about
            # building one from single token entries, so it only takes those.
            if entry["tokens"] == 1:
                sequences[entry["layer"]].append(set(entry["ids"]))
    return sequences


def union_growth(routes: Routes, generation_steps: int, widths: tuple[int, ...]) -> dict:
    """Mean distinct experts per layer over k adjacent positions.

    The random control answers a question the adjacency alone cannot: a draft
    that is rejected produces positions that are NOT on the trace, so their
    routing is unknown. If k adjacent positions and k positions drawn anywhere
    in the run have nearly the same union, then the off-path positions of a
    rejected draft cost nearly the same as the on-path ones, and the whole
    simulation stops depending on an assumption nobody can check.
    """
    sequences = per_layer_sequences(routes, generation_steps)
    out: dict[int, dict] = {}
    for width in widths:
        adjacent_total = 0
        random_total = 0
        windows = 0
        pairwise_overlap = 0.0
        worst = 0
        for layer, arr in sequences.items():
            rng = random.Random(20260810 + layer)
            for start in range(len(arr) - width + 1):
                union: set[int] = set()
                for offset in range(width):
                    union |= arr[start + offset]
                adjacent_total += len(union)
                worst = max(worst, len(union))
                windows += 1
                picked = rng.sample(range(len(arr)), width)
                control: set[int] = set()
                for index in picked:
                    control |= arr[index]
                random_total += len(control)
        if width == 2:
            pairs = 0
            for layer, arr in sequences.items():
                for i in range(len(arr) - 1):
                    pairwise_overlap += len(arr[i] & arr[i + 1])
                    pairs += 1
            pairwise_overlap /= max(1, pairs)
        out[width] = {
            "adjacent": adjacent_total / max(1, windows),
            # The engine's admission guard is fail closed on the WORST window,
            # not the mean: a single pass whose distinct experts exceed
            # min(quota, probation) throws. The mean sizes the throughput, the
            # maximum decides whether the run survives at all.
            "worst": worst,
            "random": random_total / max(1, windows),
            "naive": width * routes.used,
            "pairwise_overlap": pairwise_overlap if width == 2 else None,
        }
    return out


def two_token_crosscheck(path: pathlib.Path) -> dict | None:
    """The union of two adjacent positions, taken from a real two token pass.

    The engine ran the 24 GB tier at ubatch 2, so its prompt entries carry the
    top-k of two positions concatenated. That is the same union this study
    computes from single token entries, measured inside one real forward pass
    instead of assembled afterwards. If the two disagree, the assembly is
    wrong.
    """
    if not path.is_file():
        return None
    routes = Routes(path)
    sizes: list[int] = []
    for entry in routes.entries:
        if entry["tokens"] != 2:
            continue
        half = len(entry["ids"]) // 2
        first = set(entry["ids"][:half])
        second = set(entry["ids"][half:])
        sizes.append(len(first | second))
    if not sizes:
        return None
    return {"n": len(sizes), "mean": statistics.fmean(sizes), "used": routes.used}


# --------------------------------------------------------------------------
# Section 2: reads per accepted token, net of the cache


def warm(routes: Routes, generation_steps: int, quota: int, fraction: float) -> tuple[Slru, list]:
    """A cache warmed by the prompt, and the generation steps that follow."""
    steps = steps_of(routes)
    layer_count = routes.last_layer - routes.first_layer + 1
    cache = Slru(quota, fraction, routes.experts, routes.first_layer, layer_count)
    boundary = len(steps) - generation_steps
    for step in steps[:boundary]:
        for entry in step:
            for expert in entry["ids"]:
                cache.access(entry["layer"], expert)
    return cache, steps[boundary:]


def sequential_reads(routes: Routes, generation_steps: int,
                     quota: int, fraction: float) -> dict:
    """The engine as it runs today: one position per pass."""
    cache, generation = warm(routes, generation_steps, quota, fraction)
    reads = 0
    serve_calls = 0
    for step in generation:
        for entry in step:
            layer = entry["layer"]
            need = set(entry["ids"])
            reads += sum(1 for e in need if not cache.resident(layer, e))
            serve_calls += 1
            for expert in entry["ids"]:
                cache.access(layer, expert)
    tokens = len(generation)
    return {"reads": reads, "tokens": tokens, "serve_calls": serve_calls,
            "reads_per_token": reads / tokens, "serve_calls_per_token": serve_calls / tokens}


def speculative_reads(routes: Routes, generation_steps: int, quota: int, fraction: float,
                      draft_len: int, acceptance: float, seed: int = 7) -> dict:
    """One pass verifies draft_len+1 positions; the block advances by what it keeps.

    THE ONE ASSUMPTION, STATED. A rejected drafted token is a token the target
    never emitted, so its routing is not in the trace and cannot be. The verify
    window here is taken as draft_len+1 CONSECUTIVE trace positions whatever
    the acceptance, and the block then advances by the number of tokens the run
    keeps. Section 1's random control is what makes that defensible: positions
    drawn anywhere in the run have a union within about 15 percent of adjacent
    ones, so an off-path position costs about what an on-path one costs. The
    direction of the residual error is stated in the report.

    The cache is the engine's, not an idealisation: a verify pass that needs
    more distinct experts than the probation segment holds evicts its own
    members, and the next pass reads them again. That thrash is not modelled
    away, it is exactly what the numbers below have to include.
    """
    cache, generation = warm(routes, generation_steps, quota, fraction)
    rng = random.Random(seed)
    reads = 0
    serve_calls = 0
    emitted = 0
    blocks = 0
    accepted_total = 0
    position = 0
    limit = len(generation)
    while position + draft_len < limit:
        window = generation[position:position + draft_len + 1]
        per_layer: dict[int, list[int]] = collections.defaultdict(list)
        for step in window:
            for entry in step:
                per_layer[entry["layer"]].extend(entry["ids"])
        for layer, ids in sorted(per_layer.items()):
            need = list(dict.fromkeys(ids))
            reads += sum(1 for e in need if not cache.resident(layer, e))
            serve_calls += 1
            for expert in need:
                cache.access(layer, expert)
        # Exact rejection sampling accepts each drafted token with probability
        # `acceptance` and stops at the first rejection; the target's own
        # sample at the rejection point is always emitted, so a block that
        # keeps n drafted tokens emits n+1.
        kept = 0
        while kept < draft_len and rng.random() < acceptance:
            kept += 1
        accepted_total += kept
        emitted += kept + 1
        blocks += 1
        position += kept + 1
    return {"reads": reads, "serve_calls": serve_calls, "emitted": emitted,
            "blocks": blocks,
            "reads_per_token": reads / max(1, emitted),
            "serve_calls_per_token": serve_calls / max(1, emitted),
            "tokens_per_block": emitted / max(1, blocks),
            "mean_accepted": accepted_total / max(1, blocks)}


def block_reads_at_full_acceptance(routes: Routes, generation_steps: int, quota: int,
                                   fraction: float, draft_len: int) -> dict:
    """Reads for a pass of draft_len+1 positions with every draft accepted.

    Acceptance 1.0 is the only case where the trace answers exactly: the window
    and the emitted tokens are the same positions, so there is no off-path
    assumption left in the number at all.
    """
    return speculative_reads(routes, generation_steps, quota, fraction, draft_len, 1.0)


# --------------------------------------------------------------------------
# Section 3: the time model, and the acceptance rate that breaks even


def timing_constants(routes: Routes, generation_steps: int) -> dict:
    """Per token wall time, the cost of one record, and the cost of a serve call.

    All measured, by scripts/analyse-routes.py, from the timestamps the engine
    wrote around every read.
    """
    times = routes_mod.timing(routes, generation_steps)
    slope, intercept = routes_mod.marginal_read_ns(times["serve_by_misses"])
    token_ns = statistics.fmean(times["per_step_total"]) if times["per_step_total"] else 0.0
    serve_ns = statistics.fmean(times["per_step_serve"]) if times["per_step_serve"] else 0.0
    gap_ns = statistics.fmean(times["per_step_gap"]) if times["per_step_gap"] else 0.0
    return {"token_ns": token_ns, "serve_ns": serve_ns, "gap_ns": gap_ns,
            "record_ns": slope, "call_ns": intercept}


def compute_scaling_evidence(single: pathlib.Path, double: pathlib.Path,
                             generation_steps: int) -> dict | None:
    """What a two position pass costs in compute, from the only pair that exists.

    The 16 GB tier ran its prompt at ubatch 1 and the 24 GB tier ran the SAME
    prompt at ubatch 2, on the same machine. gap_ns is the wall time between
    the end of one layer's serve and the start of the next, so it is the
    model's own compute plus whatever the device is still doing behind it. That
    contamination is real and is why this returns the generation phase figures
    too: the two runs differ there by a factor of two at an identical one token
    workload, which is the size of the contamination and the reason this
    section is evidence and not a measurement.
    """
    if not (single.is_file() and double.is_file()):
        return None
    out = {}
    for label, path in (("single", single), ("double", double)):
        routes = Routes(path)
        steps = steps_of(routes)
        boundary = len(steps) - generation_steps
        by_tokens: dict[int, list[int]] = collections.defaultdict(list)
        generation: list[int] = []
        for index, step in enumerate(steps):
            for position, entry in enumerate(step):
                if position == 0:
                    continue
                if index < boundary:
                    by_tokens[entry["tokens"]].append(entry["gap_ns"])
                else:
                    generation.append(entry["gap_ns"])
        out[label] = {
            "prompt_gap_by_tokens": {t: statistics.median(v) for t, v in by_tokens.items()},
            "generation_gap": statistics.median(generation) if generation else 0.0,
        }
    return out


def throughput_model(constants: dict, layers: int, reads_per_token: float,
                     calls_per_token: float, positions_per_token: float,
                     compute_beta: float, draft_ns_per_token: float) -> float:
    """Nanoseconds per emitted token under a given decode shape.

    compute_beta is what a second position in the same pass costs in compute,
    as a fraction of the first. 0.0 means a wider pass is free on the GPU, 1.0
    means it costs exactly as much as running it again. The truth is between,
    and the report sweeps it rather than picking one.
    """
    base_compute = constants["gap_ns"]
    compute = base_compute * (1.0 + compute_beta * (positions_per_token - 1.0))
    serve = calls_per_token * constants["call_ns"] + reads_per_token * constants["record_ns"]
    return compute + serve + draft_ns_per_token


def break_even_acceptance(routes: Routes, generation_steps: int, quota: int, fraction: float,
                          constants: dict, layers: int, draft_len: int,
                          compute_beta: float, draft_ns: float,
                          grid: tuple[float, ...]) -> dict:
    """Sweep the acceptance rate and find where the two shapes cross."""
    baseline = sequential_reads(routes, generation_steps, quota, fraction)
    base_ns = throughput_model(constants, layers, baseline["reads_per_token"],
                               baseline["serve_calls_per_token"], 1.0, compute_beta, 0.0)
    rows = []
    for acceptance in grid:
        spec = speculative_reads(routes, generation_steps, quota, fraction,
                                 draft_len, acceptance)
        positions = (draft_len + 1) / spec["tokens_per_block"]
        ns = throughput_model(constants, layers, spec["reads_per_token"],
                              spec["serve_calls_per_token"], positions,
                              compute_beta, draft_ns * positions)
        rows.append({"acceptance": acceptance, "reads_per_token": spec["reads_per_token"],
                     "tokens_per_block": spec["tokens_per_block"],
                     "positions_per_token": positions,
                     "ns_per_token": ns, "speedup": base_ns / ns})
    crossing = None
    for previous, current in zip(rows, rows[1:]):
        if previous["speedup"] < 1.0 <= current["speedup"]:
            span = current["speedup"] - previous["speedup"]
            frac = (1.0 - previous["speedup"]) / span if span else 0.0
            crossing = previous["acceptance"] + frac * (
                current["acceptance"] - previous["acceptance"])
            break
    return {"baseline_ns": base_ns, "rows": rows, "break_even": crossing,
            "baseline_reads": baseline["reads_per_token"]}


# --------------------------------------------------------------------------
# Section 4: what the draft model costs the arena it is taken from


def load_plan(path: pathlib.Path) -> dict:
    """A cache plan: per layer, misses over the measured window at every quota."""
    curves: dict[int, list[int]] = {}
    header: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if not parts or parts[0] == "end":
            continue
        if parts[0] == "curve":
            curves[int(parts[1])] = [int(v) for v in parts[2:]]
        elif len(parts) >= 2:
            header[parts[0]] = parts[1]
    return {"curves": curves, "tokens": int(header.get("tokens", "256")),
            "experts": int(header.get("experts", "0")),
            "used": int(header.get("used", "0"))}


def reads_at_quota(plan: dict, quota: int) -> float:
    """Records reaching the SSD per token at a uniform quota, from the plan."""
    total = 0
    for curve in plan["curves"].values():
        total += curve[min(quota, len(curve) - 1)]
    return total / plan["tokens"]


def draft_cost(routes: Routes, plan: dict, arena_bytes: int, one_of_each: int,
               draft_sizes: tuple[int, ...]) -> list[dict]:
    """The arena a draft takes, priced in the reads that arena was removing.

    A draft model is not free memory. On a machine whose expert cache is the
    scarce resource, every byte the draft holds is a byte the cache does not,
    and the cache plan says exactly what those bytes were buying.
    """
    rows = []
    for size in draft_sizes:
        left = arena_bytes - size
        plan_after = plan_slots(left, one_of_each, routes.experts, routes.used)
        if not plan_after.get("ok"):
            rows.append({"draft_bytes": size, "ok": False, "why": plan_after["why"]})
            continue
        rows.append({
            "draft_bytes": size, "ok": True,
            "arena_after": left,
            "quota": plan_after["quota"], "probation": plan_after["probation"],
            "fraction": plan_after["fraction"],
            "ubatch": ship_ubatch(plan_after, routes.used),
            "reads_per_token": reads_at_quota(plan, plan_after["quota"]),
        })
    return rows


# --------------------------------------------------------------------------


def report(model: str, path: pathlib.Path, args: argparse.Namespace) -> dict:
    routes = Routes(path)
    if not routes.entries:
        raise SystemExit(f"ECHEC: no entries in {path}")
    routes_mod.check_cache_simulation(routes)
    layers = routes.last_layer - routes.first_layer + 1
    one_of_each = sum(routes.records.values())
    constants = timing_constants(routes, args.generation_steps)

    print(f"=== {model}  ({path.name})")
    print(f"  {routes.arch}, {layers} MoE layers, {routes.experts} experts, "
          f"{routes.used} used, {one_of_each / layers / 1e6:.2f} MB per record")
    plan_now = plan_slots(routes.cache_bytes, one_of_each, routes.experts, routes.used)
    print(f"  arena {routes.cache_bytes / 1e9:.2f} GB, quota {routes.quota}, "
          f"protected {routes.protected_fraction:.2f}, probation {routes.probation}, "
          f"planner ubatch {ship_ubatch(plan_now, routes.used)}")
    print()

    print("  1. DISTINCT EXPERTS PER LAYER OVER k ADJACENT POSITIONS")
    growth = union_growth(routes, args.generation_steps, tuple(args.widths))
    print(f"     {'k':>3} {'union':>8} {'vs 1 pos':>9} {'vs k*used':>10} "
          f"{'k*used':>8} {'random k':>9} {'worst':>7}")
    for width in args.widths:
        row = growth[width]
        print(f"     {width:>3} {row['adjacent']:8.2f} {row['adjacent'] / routes.used:8.2f}x "
              f"{row['adjacent'] / row['naive'] * 100:9.1f}% {row['naive']:8d} "
              f"{row['random']:9.2f} {row['worst']:7d}")
    if growth.get(2) and growth[2]["pairwise_overlap"] is not None:
        overlap = growth[2]["pairwise_overlap"]
        print(f"     two adjacent positions share {overlap:.2f} of {routes.used} experts "
              f"({overlap / routes.used * 100:.0f}%)")
    print()

    print("  2. REPLAY AGAINST THE CACHE, AT THIS ARENA")
    baseline = sequential_reads(routes, args.generation_steps,
                                routes.quota, routes.protected_fraction)
    print(f"     one position per pass    {baseline['reads_per_token']:6.2f} records/token "
          f"({baseline['reads_per_token'] * one_of_each / layers / 1e6:6.1f} MB), "
          f"{baseline['serve_calls_per_token']:.0f} serve calls/token")
    for draft_len in args.draft_lengths:
        full = block_reads_at_full_acceptance(routes, args.generation_steps, routes.quota,
                                              routes.protected_fraction, draft_len)
        print(f"     k={draft_len}, every draft kept  {full['reads_per_token']:6.2f} "
              f"records/token "
              f"({full['reads_per_token'] * one_of_each / layers / 1e6:6.1f} MB), "
              f"{full['serve_calls_per_token']:5.1f} serve calls/token, "
              f"{full['reads_per_token'] / baseline['reads_per_token']:.2f}x baseline")
    print("     These hold the arena's own protected fraction fixed, so a wide pass here")
    print("     may be one the engine would REFUSE (see 5, 6 and 7). They isolate what")
    print("     batching does to the reads; section 7 is the configuration that could run.")
    print()

    print("  3. ACCEPTANCE SWEEP AND BREAK EVEN")
    print(f"     measured: {constants['token_ns'] / 1e6:.2f} ms/token, of which "
          f"{constants['gap_ns'] / 1e6:.2f} ms compute and "
          f"{constants['serve_ns'] / 1e6:.2f} ms in serve_layer; one record costs "
          f"{constants['record_ns'] / 1000:.0f} us, one serve call "
          f"{constants['call_ns'] / 1000:.0f} us")
    results = {}
    print("     beta = compute cost of a second position in the same pass, as a fraction of")
    print("            the first. draft = wall time one drafted position costs.")
    for draft_ns in args.draft_ns:
        for beta in args.compute_beta:
            for draft_len in args.draft_lengths:
                swept = break_even_acceptance(
                    routes, args.generation_steps, routes.quota, routes.protected_fraction,
                    constants, layers, draft_len, beta, draft_ns, tuple(args.acceptance))
                if draft_ns == args.draft_ns[0]:
                    results[(beta, draft_len)] = swept
                crossing = ("never" if swept["break_even"] is None
                            else f"{swept['break_even'] * 100:.0f}%")
                best = max(swept["rows"], key=lambda r: r["speedup"])
                print(f"     draft {draft_ns / 1e6:5.1f} ms  beta={beta:.1f} k={draft_len}: "
                      f"break even at acceptance {crossing:>6}"
                      f", best {best['speedup']:.2f}x at acceptance "
                      f"{best['acceptance'] * 100:.0f}%")
    for beta in args.compute_beta[:1]:
        for draft_len in args.draft_lengths:
            swept = results[(beta, draft_len)]
            print(f"     detail beta={beta:.1f} k={draft_len} "
                  f"(baseline {swept['baseline_ns'] / 1e6:.2f} ms/token)")
            print(f"       {'accept':>7} {'reads/tok':>10} {'tok/block':>10} "
                  f"{'ms/token':>9} {'speedup':>8}")
            for row in swept["rows"]:
                print(f"       {row['acceptance'] * 100:6.0f}% {row['reads_per_token']:10.2f} "
                      f"{row['tokens_per_block']:10.2f} {row['ns_per_token'] / 1e6:9.2f} "
                      f"{row['speedup']:7.2f}x")
    print()

    print("  4. WHAT A DRAFT MODEL COSTS THE ARENA")
    plan_path = PLANS_DIR / f"{routes.arch}.txt"
    if plan_path.is_file():
        plan = load_plan(plan_path)
        print(f"     {'draft':>8} {'arena':>9} {'quota':>6} {'probation':>10} "
              f"{'ubatch':>7} {'reads/tok':>10} {'vs now':>8}")
        rows = draft_cost(routes, plan, routes.cache_bytes, one_of_each,
                          tuple(args.draft_bytes))
        reference = None
        for row in rows:
            if not row["ok"]:
                print(f"     {row['draft_bytes'] / 1e9:7.1f}G  REFUSED: {row['why']}")
                continue
            if reference is None:
                reference = row["reads_per_token"]
            print(f"     {row['draft_bytes'] / 1e9:7.1f}G {row['arena_after'] / 1e9:8.2f}G "
                  f"{row['quota']:6d} {row['probation']:10d} {row['ubatch']:7d} "
                  f"{row['reads_per_token']:10.2f} "
                  f"{row['reads_per_token'] / reference:7.2f}x")
    else:
        print(f"     no cache plan at {plan_path}")
    print()

    print("  5. THE MICRO-BATCH THE PLANNER WOULD ALLOW")
    print(f"     a verify pass of T positions IS a micro-batch of T. The planner "
          f"admits\n     ubatch = probation // used, so at this arena it allows "
          f"{ship_ubatch(plan_now, routes.used)}.")
    for target in args.draft_lengths:
        positions = target + 1
        needed_conservative = positions * routes.used
        measured_union = growth.get(positions, {}).get("adjacent")
        best = None
        for fraction in PROTECTED_FRACTIONS:
            quota = None
            for candidate in range(2, routes.experts + 1):
                protected = min(max(int(candidate * fraction), 1), candidate - 1)
                if candidate - protected >= needed_conservative:
                    quota = candidate
                    break
            if quota is not None and (best is None or quota < best[0]):
                best = (quota, fraction)
        if best is None:
            print(f"     k={target} ({positions} positions): the planner's rule "
                  f"({needed_conservative} probation slots) is unreachable, "
                  f"{routes.experts} experts is the ceiling")
        else:
            print(f"     k={target} ({positions} positions): planner needs quota "
                  f">= {best[0]} at protected {best[1]:.2f}, i.e. "
                  f"{best[0] * one_of_each / 1e9:.1f} GB of arena "
                  f"(now {routes.cache_bytes / 1e9:.2f} GB)")
        if measured_union is not None:
            relaxed = None
            for fraction in PROTECTED_FRACTIONS:
                for candidate in range(2, routes.experts + 1):
                    protected = min(max(int(candidate * fraction), 1), candidate - 1)
                    if candidate - protected >= measured_union:
                        if relaxed is None or candidate < relaxed[0]:
                            relaxed = (candidate, fraction)
                        break
            if relaxed is not None:
                print(f"         measured union is {measured_union:.1f}, not "
                      f"{needed_conservative}: a rule that used it would need quota "
                      f">= {relaxed[0]} at protected {relaxed[1]:.2f} "
                      f"({relaxed[0] * one_of_each / 1e9:.1f} GB)")
    print()

    print("  6. THE ARENA IS OFTEN BIG ENOUGH ALREADY, THE PROTECTED FRACTION IS NOT")
    print("     The planner takes the LARGEST protected fraction whose probation still")
    print("     holds one micro-batch, because a large protected segment is what makes the")
    print("     hit rate. Widening the batch means giving that back. Same arena, same")
    print("     quota, replayed at each fraction the engine accepts:")
    print(f"     {'protected':>10} {'probation':>10} {'ubatch':>7} {'reads/tok':>10} "
          f"{'vs now':>8}")
    reference = None
    for fraction in PROTECTED_FRACTIONS:
        protected = min(max(int(routes.quota * fraction), 1), routes.quota - 1)
        probation = routes.quota - protected
        if probation < routes.used:
            print(f"     {fraction:10.2f} {probation:10d} {'refused':>7}")
            continue
        replayed = sequential_reads(routes, args.generation_steps, routes.quota, fraction)
        if reference is None or abs(fraction - routes.protected_fraction) < 1e-9:
            reference = replayed["reads_per_token"]
        print(f"     {fraction:10.2f} {probation:10d} "
              f"{min(max(probation // routes.used, 1), 8):7d} "
              f"{replayed['reads_per_token']:10.2f} "
              f"{replayed['reads_per_token'] / reference:7.2f}x")
    print()

    print("  7. THE CONFIGURATION THAT WOULD ACTUALLY RUN, END TO END")
    print("     Same arena, same quota. For each draft length: the smallest protected")
    print("     fraction that admits the WORST verify pass observed, then the whole")
    print("     simulation replayed there, so the widened batch pays for its own hit rate.")
    print(f"     {'k':>3} {'positions':>10} {'worst':>6} {'protected':>10} {'probation':>10} "
          f"{'reads/tok@1.0':>14} {'vs now':>8} {'ms/token':>9} {'speedup':>8}")
    for draft_len in args.draft_lengths:
        positions = draft_len + 1
        row = growth.get(positions)
        if row is None:
            continue
        worst = row["worst"]
        chosen = None
        for fraction in PROTECTED_FRACTIONS:
            protected = min(max(int(routes.quota * fraction), 1), routes.quota - 1)
            probation = routes.quota - protected
            if probation >= worst:
                chosen = (fraction, probation)
                break
        if chosen is None:
            print(f"     {draft_len:3d} {positions:10d} {worst:6d} "
                  f"{'REFUSED: the worst pass needs more probation slots than the quota':>10}")
            continue
        fraction, probation = chosen
        rebased = sequential_reads(routes, args.generation_steps, routes.quota, fraction)
        full = speculative_reads(routes, args.generation_steps, routes.quota, fraction,
                                 draft_len, 1.0)
        base_ns = throughput_model(constants, layers, rebased["reads_per_token"],
                                   rebased["serve_calls_per_token"], 1.0, 0.0, 0.0)
        spec_ns = throughput_model(constants, layers, full["reads_per_token"],
                                   full["serve_calls_per_token"], positions, 0.0, 0.0)
        print(f"     {draft_len:3d} {positions:10d} {worst:6d} {fraction:10.2f} "
              f"{probation:10d} {full['reads_per_token']:14.2f} "
              f"{full['reads_per_token'] / baseline['reads_per_token']:7.2f}x "
              f"{spec_ns / 1e6:9.2f} {base_ns / spec_ns:7.2f}x")
    print("     reads/tok@1.0 and the speedup assume EVERY draft is accepted and a free")
    print("     draft model: the ceiling, not a forecast.")
    print()
    return {"model": model, "growth": growth, "baseline": baseline}


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Does speculative decoding pay on an SSD bound MoE engine.")
    ap.add_argument("--routes", default=None, help="one route file instead of the lineup")
    ap.add_argument("--generation-steps", type=int, default=GENERATION_STEPS)
    ap.add_argument("--widths", type=int, nargs="+", default=[2, 3, 4, 5, 8, 16])
    ap.add_argument("--draft-lengths", type=int, nargs="+", default=[2, 4, 8])
    ap.add_argument("--acceptance", type=float, nargs="+",
                    default=[0.0, 0.2, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0])
    ap.add_argument("--compute-beta", type=float, nargs="+", default=[0.0, 0.5, 1.0],
                    help="cost of a second position in the same pass, as a fraction "
                         "of the first (0 free, 1 as expensive as a second pass)")
    ap.add_argument("--draft-ns", type=float, nargs="+",
                    default=[0.0, 3_000_000.0, 8_000_000.0],
                    help="wall time one drafted position costs, in nanoseconds. The "
                         "default sweep is a free draft (a bound nobody can beat), a "
                         "0.5B class dense draft and a 1.5B class one on this machine")
    ap.add_argument("--draft-bytes", type=int, nargs="+",
                    default=[0, 500_000_000, 1_000_000_000, 1_500_000_000, 2_000_000_000])
    args = ap.parse_args()

    if args.routes:
        report(pathlib.Path(args.routes).stem, pathlib.Path(args.routes), args)
        return 0

    check = two_token_crosscheck(ROUTES_DIR / TWO_TOKEN)
    for model, name in SMALLEST.items():
        path = ROUTES_DIR / name
        if not path.is_file():
            print(f"AVERTISSEMENT: no trace at {path}", file=sys.stderr)
            continue
        report(model, path, args)

    if check:
        print("CROSS CHECK, the union of two positions inside a real two token pass")
        print(f"  {TWO_TOKEN}: {check['n']} two token entries, mean union "
              f"{check['mean']:.2f} experts of a possible {2 * check['used']}")
        print("  Section 1 assembles the same quantity from single token entries. If the")
        print("  two disagree the assembly is wrong and every number above with it.")
        print()

    evidence = compute_scaling_evidence(ROUTES_DIR / SMALLEST["qwen3-30b-a3b"],
                                        ROUTES_DIR / TWO_TOKEN, args.generation_steps)
    if evidence:
        print("WHAT A WIDER PASS COSTS IN COMPUTE, and why it is evidence not a measurement")
        for label, row in evidence.items():
            gaps = ", ".join(f"{t} position(s) {v / 1000:.0f} us"
                             for t, v in sorted(row["prompt_gap_by_tokens"].items()))
            print(f"  {label:<7} prompt: {gaps};  generation (1 position): "
                  f"{row['generation_gap'] / 1000:.0f} us")
        print("  Both ran the same prompt on the same machine. The generation figures are a")
        print("  one position workload in both, and they differ by about a factor of two,")
        print("  which is the device pressure leaking into a measurement that is supposed to")
        print("  be compute. That is why the report sweeps the compute cost of a wider pass")
        print("  instead of quoting a number from this pair.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
