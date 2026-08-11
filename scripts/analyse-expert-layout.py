#!/usr/bin/env python3
"""Would a co-occurrence driven physical layout of expert records pay.

WHAT THIS ANSWERS

Today the pack writes records in expert INDEX order: layer L expert 0, expert 1,
and so on (scripts/galactus-pack-plan.py). A router never picks one expert, it
picks k of them together, and if the same groups recur then the experts of a
group could be written next to each other, so that one larger read fetches
several of them instead of k scattered reads.

That idea has three ways to be wrong and this script tests all three.

  1. THERE MAY BE NO STRUCTURE. Co-occurrence looks concentrated the moment
     expert popularity is skewed, even when the router is conditionally
     independent given its marginals. So every concentration figure here is
     printed next to the same figure computed on a MARGINAL MATCHED NULL: the
     same per-expert frequencies, drawn independently. Only the excess is
     exploitable.

  2. A BETTER ORDER MAY BUY NOTHING. Merging n adjacent records into one read
     saves at most the per-request overhead and costs a whole record of
     bandwidth for every neighbour that turns out to be useless. Both sides are
     counted: reads saved, and bytes wasted.

  3. IT MAY NOT GENERALISE. An order fitted on one trace and evaluated on the
     same trace is worthless. Every ordering is therefore also evaluated on a
     segment it was not fitted on, and across cache budgets.

The cache is the SLRU of src/h4/h4-expert-cache.cpp, replayed by
scripts/analyse-routes.py, which checks itself against the residency bits the
engine recorded. This script imports that replay rather than copying it.

ANALYSIS ONLY. It reads route files. It runs no model and repacks nothing.

Usage:
  python3 scripts/analyse-expert-layout.py --routes artifacts/h4/routes/*.routes
  python3 scripts/analyse-expert-layout.py --routes <file> --json out.json
"""
from __future__ import annotations

import argparse
import collections
import importlib.util
import json
import math
import pathlib
import random
import statistics
import sys

ROOT = pathlib.Path(__file__).resolve().parent


def load_analyse_routes():
    """The route parser and the SLRU replay, from the script that owns them.

    A second copy of the cache here would drift from the engine, and the whole
    point of that replay is that it is checked against recorded residency bits.
    """
    path = ROOT / "analyse-routes.py"
    spec = importlib.util.spec_from_file_location("analyse_routes", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


AR = load_analyse_routes()


# --------------------------------------------------------------------------
# Segments of a trace


def segments(routes, generation_steps: int) -> dict[str, tuple[int, int]]:
    """Ranges of callback indices: prompt, and the two halves of generation.

    A step is one token here: this engine fires the remap callback once per
    token per MoE layer, prompt included, so every callback carries exactly one
    router decision and the whole file is usable as top-k sets.

    The split is what makes a train/test honest. The prompt is a fixed passage
    written by a human; the generation is text the model wrote itself. Fitting
    an order on one and evaluating it on the other is a real distribution shift,
    which is the cheapest generalisation test a single file can support. The two
    halves of generation are the weaker, same-distribution check.
    """
    steps = AR.steps_of(routes)
    bounds = []
    index = 0
    for step in steps:
        bounds.append((index, index + len(step)))
        index += len(step)
    total = bounds[-1][1]
    first_gen = max(0, len(steps) - generation_steps)
    gen_start = bounds[first_gen][0]
    mid_step = first_gen + (len(steps) - first_gen) // 2
    mid = bounds[mid_step][0]
    return {
        "prompt": (0, gen_start),
        "generation": (gen_start, total),
        "gen_first_half": (gen_start, mid),
        "gen_second_half": (mid, total),
        "all": (0, total),
    }


def single_token_entries(routes, span: tuple[int, int]) -> list[dict]:
    lo, hi = span
    return [e for e in routes.entries[lo:hi] if e["tokens"] == 1]


# --------------------------------------------------------------------------
# Co-occurrence, and the null it has to beat


def cooccurrence(entries: list[dict], layer: int, experts: int):
    """Pair counts and marginal counts for one layer, from top-k sets."""
    pair: dict[tuple[int, int], int] = collections.Counter()
    marginal = [0] * experts
    sets = 0
    distinct: collections.Counter = collections.Counter()
    for entry in entries:
        if entry["layer"] != layer:
            continue
        ids = sorted(set(entry["ids"]))
        if len(ids) < 2:
            continue
        sets += 1
        distinct[tuple(ids)] += 1
        for e in ids:
            marginal[e] += 1
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                pair[(ids[i], ids[j])] += 1
    return pair, marginal, sets, distinct


def null_pairs(marginal: list[int], k: int, experts: int,
               draws: int, rng: random.Random):
    """Pair counts from independent draws with the SAME marginal frequencies.

    Weighted sampling of k ids without replacement, by the Gumbel top-k trick:
    the top k of log(w_i) + Gumbel(0,1) is exactly a Plackett-Luce draw, which
    is sequential sampling proportional to weight without replacement. This is
    the distribution a router with the observed popularity skew and NO group
    structure would produce, and it is what any concentration claim has to beat.

    A concentration figure without this baseline says nothing: a skewed router
    that picks its experts independently already produces a heavily concentrated
    pair histogram, and a sample of a few hundred tokens produces another one
    out of pure sampling noise.
    """
    logw = [math.log(m) if m > 0 else None for m in marginal]
    live = [i for i in range(experts) if logw[i] is not None]
    if len(live) <= k:
        return collections.Counter(), 0
    pair: dict[tuple[int, int], int] = collections.Counter()
    total = 0
    gumbel = rng.random
    for _ in range(draws):
        keys = [(logw[i] - math.log(-math.log(gumbel())), i) for i in live]
        keys.sort(reverse=True)
        chosen = sorted(i for _, i in keys[:k])
        total += 1
        for a in range(k):
            ia = chosen[a]
            for b in range(a + 1, k):
                pair[(ia, chosen[b])] += 1
    return pair, total


def concentration(pair: collections.Counter, experts: int) -> dict:
    """How much of the co-occurrence mass the heaviest pairs carry."""
    possible = experts * (experts - 1) // 2
    values = sorted(pair.values(), reverse=True)
    mass = sum(values)
    if mass == 0 or possible == 0:
        return {}
    out = {"mass": mass, "pairs_seen": len(values), "pairs_possible": possible}
    for fraction in (0.01, 0.05, 0.10, 0.25):
        take = max(1, int(round(possible * fraction)))
        out[f"top{int(fraction * 100)}pc"] = sum(values[:take]) / mass
    # Gini over all possible pairs, unseen pairs counted as zero
    padded = values + [0] * (possible - len(values))
    padded.sort()
    n = len(padded)
    cumulative = 0
    weighted = 0
    for i, v in enumerate(padded, start=1):
        cumulative += v
        weighted += i * v
    out["gini"] = (2 * weighted) / (n * cumulative) - (n + 1) / n if cumulative else 0.0
    return out


def normalised_entropy(counts: list[int]) -> float:
    total = sum(counts)
    if total <= 0:
        return 0.0
    support = sum(1 for c in counts if c > 0)
    if support <= 1:
        return 0.0
    h = 0.0
    for c in counts:
        if c > 0:
            p = c / total
            h -= p * math.log(p)
    return h / math.log(len(counts))


# --------------------------------------------------------------------------
# Orderings


def order_index(experts: int, affinity, marginal) -> list[int]:
    return list(range(experts))


def order_frequency(experts: int, affinity, marginal) -> list[int]:
    return sorted(range(experts), key=lambda e: -marginal[e])


def order_greedy(experts: int, affinity, marginal) -> list[int]:
    """Chain the experts, always appending the strongest remaining neighbour.

    A cheap approximation of the path that maximises the sum of adjacent
    affinities, which is the quantity a contiguous layout of pairs cares about.
    """
    remaining = set(range(experts))
    if not affinity:
        return list(range(experts))
    start = max(affinity.items(), key=lambda kv: kv[1])[0][0]
    order = [start]
    remaining.discard(start)
    while remaining:
        head = order[-1]
        best, best_w = None, -1.0
        for candidate in remaining:
            key = (head, candidate) if head < candidate else (candidate, head)
            w = affinity.get(key, 0.0)
            if w > best_w:
                best, best_w = candidate, w
        if best is None:
            best = next(iter(remaining))
        order.append(best)
        remaining.discard(best)
    return order


def order_spectral(experts: int, affinity, marginal) -> list[int]:
    """Sort by the Fiedler vector of the affinity graph.

    The classic relaxation of minimum linear arrangement: the second eigenvector
    of the Laplacian places strongly connected vertices at nearby coordinates.
    Power iteration on a shifted operator, deflating the constant vector; the
    matrices here are at most 128 wide so nothing fancier is warranted.
    """
    rows: list[list[tuple[int, float]]] = [[] for _ in range(experts)]
    degree = [0.0] * experts
    for (i, j), w in affinity.items():
        if not w:
            continue
        rows[i].append((j, w))
        rows[j].append((i, w))
        degree[i] += w
        degree[j] += w
    shift = max(degree) * 2 + 1.0
    if shift <= 1.0:
        return list(range(experts))
    seed = random.Random(1234)
    vector = [seed.random() - 0.5 for _ in range(experts)]

    def deflate(v):
        mean = sum(v) / len(v)
        return [x - mean for x in v]

    def normalise(v):
        norm = math.sqrt(sum(x * x for x in v))
        return [x / norm for x in v] if norm > 0 else v

    vector = normalise(deflate(vector))
    for _ in range(300):
        # y = (shift * I - L) v, with L = D - W
        new = [(shift - degree[i]) * vector[i]
               + sum(w * vector[j] for j, w in rows[i])
               for i in range(experts)]
        new = normalise(deflate(new))
        if all(abs(a - b) < 1e-9 for a, b in zip(new, vector)):
            vector = new
            break
        vector = new
    return sorted(range(experts), key=lambda e: vector[e])


def order_rcm(experts: int, affinity, marginal) -> list[int]:
    """Reverse Cuthill-McKee on the graph of the heaviest edges.

    The textbook bandwidth minimisation heuristic. The graph is thresholded at
    the median edge weight, otherwise every pair is an edge and the ordering
    degenerates.
    """
    if not affinity:
        return list(range(experts))
    values = sorted(affinity.values())
    threshold = values[len(values) // 2]
    adjacency = collections.defaultdict(list)
    for (i, j), w in affinity.items():
        if w >= threshold and w > 0:
            adjacency[i].append((j, w))
            adjacency[j].append((i, w))
    for node in adjacency:
        adjacency[node].sort(key=lambda kv: -kv[1])
    visited = set()
    order: list[int] = []
    nodes = sorted(range(experts), key=lambda e: len(adjacency[e]))
    for seed in nodes:
        if seed in visited:
            continue
        queue = collections.deque([seed])
        visited.add(seed)
        while queue:
            node = queue.popleft()
            order.append(node)
            for neighbour, _ in adjacency[node]:
                if neighbour not in visited:
                    visited.add(neighbour)
                    queue.append(neighbour)
    order.reverse()
    return order


ORDERINGS = {
    "index": order_index,
    "frequency": order_frequency,
    "greedy": order_greedy,
    "spectral": order_spectral,
    "rcm": order_rcm,
}


# --------------------------------------------------------------------------
# What a layout costs


def miss_stream(routes, span: tuple[int, int], quota: int | None = None):
    """Replay the cache over `span` and yield, per callback, the missing ids.

    The cache is warmed by everything before `span` so the miss sets are the
    ones the engine would really have produced at that point of the run.
    """
    layer_count = routes.last_layer - routes.first_layer + 1
    cache = AR.Slru(quota if quota is not None else routes.quota,
                    routes.protected_fraction, routes.experts,
                    routes.first_layer, layer_count)
    lo, hi = span
    for entry in routes.entries[:lo]:
        for expert in entry["ids"]:
            cache.access(entry["layer"], expert)
    out = []
    for entry in routes.entries[lo:hi]:
        layer = entry["layer"]
        absent = [e for e in dict.fromkeys(entry["ids"])
                  if not cache.resident(layer, e)]
        for expert in entry["ids"]:
            cache.access(layer, expert)
        out.append({"layer": layer, "missing": absent})
    return out


def runs_of(positions: list[int], gap: int) -> list[tuple[int, int]]:
    """Group sorted positions into spans, tolerating `gap` unwanted records."""
    if not positions:
        return []
    spans = []
    start = prev = positions[0]
    for p in positions[1:]:
        if p - prev - 1 <= gap:
            prev = p
        else:
            spans.append((start, prev))
            start = prev = p
    spans.append((start, prev))
    return spans


def evaluate(routes, stream: list[dict], orders: dict[int, list[int]],
             gap: int, future_window: int = 8) -> dict:
    """Reads, records fetched, records wasted, for one ordering and one gap.

    `orders` maps layer to the permutation, expressed as the list of expert ids
    in disk order. A record fetched but not needed now is counted as waste; if
    the same layer asks for it within `future_window` later callbacks it is also
    counted separately, which is the most generous reading the idea can get.
    """
    position: dict[int, dict[int, int]] = {}
    for layer, order in orders.items():
        position[layer] = {expert: index for index, expert in enumerate(order)}
    # For each callback, the next `future_window` callbacks OF THE SAME LAYER.
    # A layer fires once per token, so its next occurrence is one whole layer
    # sweep away; counting stream indices instead would look ahead zero tokens.
    by_layer: dict[int, list[int]] = collections.defaultdict(list)
    rank_in_layer: list[int] = [0] * len(stream)
    for index, item in enumerate(stream):
        rank_in_layer[index] = len(by_layer[item["layer"]])
        by_layer[item["layer"]].append(index)

    reads = 0
    useful = 0
    fetched = 0
    wasted_bytes = 0
    useful_bytes = 0
    rescued = 0
    serves_with_misses = 0
    for index, item in enumerate(stream):
        layer = item["layer"]
        missing = item["missing"]
        if not missing:
            continue
        serves_with_misses += 1
        record = routes.records[layer]
        pos = sorted(position[layer][e] for e in missing)
        spans = runs_of(pos, gap)
        reads += len(spans)
        useful += len(missing)
        useful_bytes += len(missing) * record
        order = orders[layer]
        for lo, hi in spans:
            span_len = hi - lo + 1
            fetched += span_len
            extra = span_len - sum(1 for p in pos if lo <= p <= hi)
            wasted_bytes += extra * record
            if extra:
                collateral = {order[p] for p in range(lo, hi + 1)}
                collateral -= {order[p] for p in pos if lo <= p <= hi}
                same = by_layer[layer]
                start = rank_in_layer[index] + 1
                soon: set[int] = set()
                for i in same[start:start + future_window]:
                    soon.update(stream[i]["missing"])
                rescued += len(collateral & soon)
    return {
        "reads": reads,
        "useful_records": useful,
        "fetched_records": fetched,
        "useful_bytes": useful_bytes,
        "wasted_bytes": wasted_bytes,
        "rescued_records": rescued,
        "serves_with_misses": serves_with_misses,
    }


# The one measured number the whole cost model turns on.
#
# docs/PHYSICAL-MODEL.md, section 4, "Read splitting": on GLM-5.2, records of
# 13,172,736 bytes striped over two volumes, cutting each volume part into four
# preads instead of one moved effective throughput from 15.406 GB/s to 15.148
# GB/s on strictly identical bytes (549,158,092,800 both ways). That is 2 preads
# per record against 8, so six extra preads cost
#
#   13172736 / 15.148e9 - 13172736 / 15.406e9 = 14.6 us
#
# and ONE pread costs about 2.43 us of overhead beyond its own bytes. The same
# document measures the device flat at 15.227 GB/s at every cache size, so there
# is no second effect where a larger read goes faster: the device is saturated
# and the only thing coalescing can remove is this 2.43 us.
#
# That number is the whole verdict. Merging two records saves 2.43 us; fetching
# one record that turns out to be useless costs the time to transfer it, which
# is 268 us for olmoe, 329 us for qwen3-30b and 3127 us for phi35. Waste is
# between a hundred and a thousand times more expensive than the thing the merge
# is buying.
PREAD_OVERHEAD_US = 2.43

# Measured sustained throughput of the pack path, same document, 8 runs,
# 0.55% standard deviation.
DEVICE_BYTES_PER_US = 15.227e9 / 1e6


def overhead_share(record_bytes: int, preads_per_record: int = 1) -> float:
    """What one read request costs, as a fraction of transferring one record."""
    transfer_us = record_bytes / DEVICE_BYTES_PER_US
    return (PREAD_OVERHEAD_US * preads_per_record) / transfer_us if transfer_us else 0.0


def cost_verdict(base: dict, got: dict, record_share: float) -> dict:
    """Reads saved against bytes wasted, in the only unit that decides.

    Merging is worth it only if the per-request overhead is larger than the
    bandwidth spent on the neighbours the merge dragged in. Written as a
    condition it is device independent:

        overhead of one request  >  (records wasted / requests saved)
                                    x  time to transfer one record

    so `break_even_records` below is the number of record transfer times a
    single request would have to cost before this ordering pays. Measured, one
    request costs about 0.0057 record transfers at the record sizes in play, so
    anything above that is a loss.
    """
    saved = base["reads"] - got["reads"]
    wasted = got["fetched_records"] - base["fetched_records"]
    useful = base["useful_records"]
    baseline_units = base["reads"] * record_share + base["fetched_records"]
    new_units = got["reads"] * record_share + got["fetched_records"]
    return {
        "reads_saved": saved,
        "reads_saved_pc": saved / base["reads"] * 100 if base["reads"] else 0.0,
        "records_wasted": wasted,
        "records_wasted_pc": wasted / useful * 100 if useful else 0.0,
        "break_even_records": (wasted / saved) if saved > 0 else float("inf"),
        "net_time_pc": (new_units - baseline_units) / baseline_units * 100
        if baseline_units else 0.0,
    }


def affinity_from(entries: list[dict], routes, mode: str) -> dict[int, dict]:
    """Per layer edge weights, from routing sets or from co-missed sets."""
    out: dict[int, dict] = {}
    for layer in range(routes.first_layer, routes.last_layer + 1):
        pair, marginal, _, _ = cooccurrence(entries, layer, routes.experts)
        if mode == "raw":
            out[layer] = ({k: float(v) for k, v in pair.items()}, marginal)
        elif mode == "lift":
            total = sum(marginal)
            weights = {}
            for (i, j), v in pair.items():
                expected = marginal[i] * marginal[j] / total if total else 0
                weights[(i, j)] = v / expected if expected > 0 else 0.0
            out[layer] = (weights, marginal)
        else:
            raise ValueError(mode)
    return out


def comiss_affinity(stream: list[dict], routes) -> dict[int, tuple[dict, list[int]]]:
    """Edge weights from experts MISSED together, which is what a read merges."""
    out: dict[int, tuple[dict, list[int]]] = {}
    pairs: dict[int, collections.Counter] = collections.defaultdict(collections.Counter)
    marginals: dict[int, list[int]] = {
        layer: [0] * routes.experts
        for layer in range(routes.first_layer, routes.last_layer + 1)}
    for item in stream:
        layer = item["layer"]
        missing = sorted(item["missing"])
        for e in missing:
            marginals[layer][e] += 1
        for i in range(len(missing)):
            for j in range(i + 1, len(missing)):
                pairs[layer][(missing[i], missing[j])] += 1
    for layer in range(routes.first_layer, routes.last_layer + 1):
        out[layer] = ({k: float(v) for k, v in pairs[layer].items()}, marginals[layer])
    return out


def build_orders(routes, affinity: dict, name: str) -> dict[int, list[int]]:
    orders = {}
    for layer in range(routes.first_layer, routes.last_layer + 1):
        weights, marginal = affinity[layer]
        orders[layer] = ORDERINGS[name](routes.experts, weights, marginal)
    return orders


# --------------------------------------------------------------------------


def report_structure(routes, entries: list[dict], rng: random.Random) -> dict:
    """Is there anything to exploit, once popularity skew is taken out."""
    rows = []
    for layer in range(routes.first_layer, routes.last_layer + 1):
        pair, marginal, sets, distinct = cooccurrence(entries, layer, routes.experts)
        if sets < 32:
            continue
        observed = concentration(pair, routes.experts)
        k = int(round(statistics.fmean(
            [len(set(e["ids"])) for e in entries if e["layer"] == layer])))
        null_pair, _ = null_pairs(marginal, k, routes.experts, sets, rng)
        null = concentration(null_pair, routes.experts)
        # lift on the pairs that carry the mass
        total = sum(marginal)
        lifts = []
        for (i, j), v in pair.items():
            expected = marginal[i] * marginal[j] / total if total else 0
            if expected > 0:
                lifts.append((v / expected, v))
        lifts.sort(key=lambda t: -t[1])
        heavy = lifts[:max(1, len(lifts) // 100)]
        rows.append({
            "layer": layer,
            "sets": sets,
            "distinct_sets": len(distinct),
            "most_common_set_share": distinct.most_common(1)[0][1] / sets,
            "expert_entropy": normalised_entropy(marginal),
            "top1pc": observed.get("top1pc", 0.0),
            "top5pc": observed.get("top5pc", 0.0),
            "gini": observed.get("gini", 0.0),
            "null_top1pc": null.get("top1pc", 0.0),
            "null_top5pc": null.get("top5pc", 0.0),
            "null_gini": null.get("gini", 0.0),
            "pair_coverage": observed.get("pairs_seen", 0) / observed.get("pairs_possible", 1),
            "null_pair_coverage": null.get("pairs_seen", 0) / null.get("pairs_possible", 1)
            if null else 0.0,
            "lift_top1pc": statistics.fmean([t[0] for t in heavy]) if heavy else 0.0,
            "lift_max": max((t[0] for t in lifts), default=0.0),
        })
    return {"layers": rows}


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Co-occurrence structure and physical layout of expert records.")
    ap.add_argument("--routes", nargs="+", required=True)
    ap.add_argument("--gaps", type=int, nargs="+", default=[0, 1, 2])
    ap.add_argument("--json", default=None)
    ap.add_argument("--generation-steps", type=int, default=256,
                    help="how many trailing tokens are generation (default 256, "
                         "the same convention as scripts/analyse-routes.py)")
    ap.add_argument("--quotas", type=int, nargs="*", default=None,
                    help="also evaluate at these cache quotas (records per layer)")
    ap.add_argument("--fit-from", default=None,
                    help="derive the orderings from THIS route file and evaluate them "
                         "on every --routes file. Same model, different run: the only "
                         "honest test of whether an order transfers")
    args = ap.parse_args()

    rng = random.Random(20260810)
    everything = {}

    donor = None
    donor_name = ""
    if args.fit_from:
        donor_routes = AR.Routes(pathlib.Path(args.fit_from))
        donor_name = pathlib.Path(args.fit_from).name
        donor_spans = segments(donor_routes, args.generation_steps)
        donor_entries = single_token_entries(donor_routes, donor_spans["generation"])
        donor_stream = miss_stream(donor_routes, donor_spans["generation"])
        donor = {
            "route": affinity_from(donor_entries, donor_routes, "raw"),
            "lift": affinity_from(donor_entries, donor_routes, "lift"),
            "comiss": comiss_affinity(donor_stream, donor_routes),
        }
        print(f"orderings fitted on {donor_name} "
              f"(quota {donor_routes.quota}/{donor_routes.experts}, "
              f"{len(donor_entries)} callbacks)")
    for path in args.routes:
        routes = AR.Routes(pathlib.Path(path))
        name = pathlib.Path(path).name
        AR.check_cache_simulation(routes)
        spans = segments(routes, args.generation_steps)
        gen_entries = single_token_entries(routes, spans["generation"])
        print(f"\n=== {name}")
        print(f"  {routes.arch}, {routes.last_layer - routes.first_layer + 1} layers, "
              f"{routes.experts} experts, {routes.used} used, quota {routes.quota}, "
              f"{statistics.fmean(routes.records.values()) / 1e6:.2f} MB per record")
        print(f"  {len(gen_entries)} single token callbacks in generation")

        structure = report_structure(routes, gen_entries, rng)
        rows = structure["layers"]
        if rows:
            print("\n  -- structure, generation only, against a marginal matched null")
            print(f"  {'':4} {'entropy':>8} {'distinct':>9} {'top1%':>7} {'null':>7} "
                  f"{'top5%':>7} {'null':>7} {'gini':>6} {'null':>6} "
                  f"{'lift1%':>7} {'liftmax':>8}")
            for r in rows[:6] + ([{"layer": -1}] if len(rows) > 12 else []) + rows[-6:]:
                if r.get("layer", -1) < 0:
                    print("   ...")
                    continue
                print(f"  L{r['layer']:<3} {r['expert_entropy']:8.4f} "
                      f"{r['distinct_sets'] / r['sets']:9.3f} "
                      f"{r['top1pc']:7.3f} {r['null_top1pc']:7.3f} "
                      f"{r['top5pc']:7.3f} {r['null_top5pc']:7.3f} "
                      f"{r['gini']:6.3f} {r['null_gini']:6.3f} "
                      f"{r['lift_top1pc']:7.2f} {r['lift_max']:8.2f}")
            def mean(key):
                return statistics.fmean([r[key] for r in rows])
            print(f"  mean over layers: entropy {mean('expert_entropy'):.4f}, "
                  f"top1% {mean('top1pc'):.3f} vs null {mean('null_top1pc'):.3f}, "
                  f"top5% {mean('top5pc'):.3f} vs null {mean('null_top5pc'):.3f}, "
                  f"gini {mean('gini'):.3f} vs null {mean('null_gini'):.3f}, "
                  f"lift of the heaviest 1% {mean('lift_top1pc'):.2f}")
            print(f"  distinct top-k sets per callback: {mean('distinct_sets') if False else ''}"
                  f"{statistics.fmean([r['distinct_sets'] / r['sets'] for r in rows]):.3f} "
                  f"(1.000 means no set ever repeats), most common set carries "
                  f"{statistics.fmean([r['most_common_set_share'] for r in rows]):.4f}")

        # ---------------- layout
        quotas = [routes.quota] + [q for q in (args.quotas or []) if q != routes.quota]
        layout = {}
        for quota in quotas:
            streams = {key: miss_stream(routes, span, quota)
                       for key, span in spans.items()}
            entries = {key: single_token_entries(routes, span)
                       for key, span in spans.items()}

            # Every order is FITTED on one segment and EVALUATED on another. The
            # fit segments are named so that no number below can be quoted
            # without its provenance.
            fits = {
                "prompt": ("prompt", "generation"),
                "genA": ("gen_first_half", "gen_second_half"),
                "insample": ("generation", "generation"),
            }
            if donor is not None:
                fits = {"donor": (None, "generation"), **fits}
            record_bytes = statistics.fmean(routes.records.values())
            share = overhead_share(record_bytes)
            print(f"\n  -- layout at quota {quota}/{routes.experts}"
                  f"{', the one the engine ran' if quota == routes.quota else ', extrapolated'}"
                  f"; a record is {record_bytes / 1e6:.2f} MB, so one read request "
                  f"costs {share * 100:.3f}% of transferring it "
                  f"({PREAD_OVERHEAD_US:.2f} us against "
                  f"{record_bytes / DEVICE_BYTES_PER_US:.0f} us)")

            for fit_name, (fit_key, test_key) in fits.items():
                test_stream = streams[test_key]
                if fit_key is None:
                    # Fitted on ANOTHER RUN of the same model: a different token
                    # stream, a different cache budget, nothing shared but the
                    # weights. This is the only test in this file that answers
                    # whether an order is a property of the model or a property
                    # of one recording.
                    aff = donor
                else:
                    fit_stream = streams[fit_key]
                    aff = {
                        "route": affinity_from(entries[fit_key], routes, "raw"),
                        "lift": affinity_from(entries[fit_key], routes, "lift"),
                        "comiss": comiss_affinity(fit_stream, routes),
                    }
                candidates: dict[str, dict[int, list[int]]] = {
                    "index": build_orders(routes, aff["route"], "index"),
                    "frequency": build_orders(routes, aff["route"], "frequency"),
                }
                for src in ("route", "lift", "comiss"):
                    for order_name in ("greedy", "spectral", "rcm"):
                        candidates[f"{order_name}/{src}"] = build_orders(
                            routes, aff[src], order_name)

                for gap in args.gaps:
                    base = evaluate(routes, test_stream, candidates["index"], gap)
                    tag = ("IN SAMPLE, not to be believed" if fit_name == "insample"
                           else f"fit on ANOTHER RUN ({donor_name}), tested on {test_key}"
                           if fit_key is None
                           else f"fit on {fit_key}, tested on {test_key}")
                    print(f"\n  gap {gap}, {tag}"
                          f"   [{base['useful_records']} records needed, "
                          f"{base['useful_bytes'] / 1e9:.1f} GB]")
                    print(f"  {'ordering':<20} {'reads':>7} {'reads%':>7} "
                          f"{'waste':>7} {'waste%':>7} {'rescued':>7} "
                          f"{'breakeven':>10} {'nettime%':>9}")
                    for order_name, orders in candidates.items():
                        got = evaluate(routes, test_stream, orders, gap)
                        verdict = cost_verdict(base, got, share)
                        got["verdict"] = verdict
                        breakeven = verdict["break_even_records"]
                        breakeven_text = ("free" if breakeven == 0
                                          else "n/a" if breakeven == float("inf")
                                          else f"{breakeven:.3f}")
                        absolute_waste = got["fetched_records"] - got["useful_records"]
                        print(f"  {order_name:<20} {got['reads']:7d} "
                              f"{-verdict['reads_saved_pc']:+6.1f}% "
                              f"{absolute_waste:7d} "
                              f"{absolute_waste / got['useful_records'] * 100:+6.2f}% "
                              f"{got['rescued_records']:7d} "
                              f"{breakeven_text:>10} "
                              f"{verdict['net_time_pc']:+8.3f}%")
                        layout[(quota, gap, fit_name, order_name)] = got

        everything[name] = {
            "arch": routes.arch, "experts": routes.experts, "used": routes.used,
            "quota": routes.quota,
            "record_bytes_mean": statistics.fmean(routes.records.values()),
            "structure": structure,
            "layout": {f"q{q}/g{g}/{f}/{o}": v for (q, g, f, o), v in layout.items()},
        }

    if args.json:
        pathlib.Path(args.json).write_text(json.dumps(everything, indent=1),
                                           encoding="utf-8")
        print(f"\nwritten {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
