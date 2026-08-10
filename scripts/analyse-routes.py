#!/usr/bin/env python3
"""Would prefetching expert records have paid, and by how much.

WHAT THIS ANSWERS

The engine reads an expert record from SSD at the moment a layer asks for it, so
the read latency sits on the critical path. A prefetch can only remove it if the
experts a layer is about to need can be named before the layer asks, and the
router of layer L+1 consumes the output of layer L, so nothing can name them
exactly. Every prefetch is a guess. A guess is worth its bandwidth only if it
hides more reads than it wastes, on a device that is already the bottleneck.

This reads a route file written by GALACTUS_H4_ROUTES (see
scripts/route-observe.py) and reports, per predictor and per layer:

  coverage        of the reads that actually reached the SSD, the fraction the
                  predictor would have named in advance
  amplification   records fetched speculatively per record that turned out to be
                  needed. 1.0 is perfect, 4.0 means four reads for one useful one

Both are NET OF THE EXISTING CACHE. An expert the SLRU already holds costs
nothing to "predict" and saves nothing, so it is excluded from both the numerator
and the denominator. Only reads that would really have reached the SSD count.

THE CACHE IS SIMULATED, AND THE SIMULATION IS CHECKED

To know whether a predicted expert was already resident, the SLRU of
src/h4/h4-expert-cache.cpp is replayed here. That would be an assumption, so it
is verified: the engine also recorded the residency bit of every id it actually
looked up, and this script compares the simulation to those bits one by one. A
single disagreement is fatal, because every number below would then be a
statement about a cache that does not exist.

WHAT IS DELIBERATELY NOT MODELLED

A prefetch inserts into the cache, which evicts something else, which changes
what is resident later. That feedback is not simulated. Ignoring it can only
flatter a predictor: the wasted records are free here and would not be in a real
engine. Every coverage figure below is therefore an upper bound.

Usage:
  python3 scripts/analyse-prefetch.py --routes artifacts/h4/routes/<file>.routes
"""
from __future__ import annotations

import argparse
import collections
import json
import pathlib
import statistics
import sys


# --------------------------------------------------------------------------
# The route file


class Routes:
    """A parsed route file: the header, and one entry per layer per step."""

    def __init__(self, path: pathlib.Path):
        self.path = path
        self.arch = ""
        self.first_layer = 0
        self.last_layer = 0
        self.experts = 0
        self.used = 0
        self.cache_bytes = 0
        self.protected_fraction = 0.0
        self.quota = 0
        self.probation = 0
        self.slots = 0
        self.records: dict[int, int] = {}
        self.truncated = False
        self.extended_refused = ""
        # one dict per callback
        self.entries: list[dict] = []
        self.ranks: dict[int, tuple[int, list[int]]] = {}
        self._parse(path)

    def _parse(self, path: pathlib.Path) -> None:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("#"):
                    self._header(line[1:].split())
                elif line.startswith("e "):
                    self._entry(line.split())
                elif line.startswith("r "):
                    parts = line.split()
                    self.ranks[int(parts[1])] = (int(parts[2]),
                                                 [int(v) for v in parts[3:]])

    def _header(self, parts: list[str]) -> None:
        if not parts:
            return
        if parts[0] == "arch":
            self.arch = parts[1]
        elif parts[0] == "first_layer":
            self.first_layer = int(parts[1])
            self.last_layer = int(parts[3])
            self.experts = int(parts[5])
            self.used = int(parts[7])
        elif parts[0] == "cache_bytes":
            self.cache_bytes = int(parts[1])
            self.protected_fraction = float(parts[3])
            self.quota = int(parts[5])
            self.probation = int(parts[7])
            self.slots = int(parts[9])
        elif parts[0] == "record":
            self.records[int(parts[1])] = int(parts[2])
        elif parts[0] == "entries":
            self.truncated = parts[3] == "1"
        elif parts[0] == "extended_ranks_refused":
            self.extended_refused = " ".join(parts[1:])

    def _entry(self, parts: list[str]) -> None:
        seq = int(parts[1])
        layer = int(parts[2])
        tokens = int(parts[3])
        k = int(parts[4])
        ids: list[int] = []
        resident: list[int] = []
        for token in parts[10:]:
            left, right = token.split(":")
            ids.append(int(left))
            resident.append(int(right))
        self.entries.append({
            "seq": seq, "layer": layer, "tokens": tokens, "k": k,
            "enter_ns": int(parts[5]), "serve_start_ns": int(parts[6]),
            "serve_end_ns": int(parts[7]), "gap_ns": int(parts[8]),
            "bytes_read": int(parts[9]), "ids": ids, "resident": resident,
        })


def steps_of(routes: Routes) -> list[list[dict]]:
    """Group the callbacks into decode steps.

    One step is one micro-batch: the wired layers fire in increasing order, so a
    layer index that does not increase opens a new step.

    A step does not always hold every layer. llama.cpp gathers the rows that
    need logits before the last layer's FFN, so during prompt processing the
    last MoE layer runs on zero tokens and never reaches the callback. That is
    not a gap in the record, it is the model not doing that work, and dropping
    those steps would throw away the whole prompt.
    """
    steps: list[list[dict]] = []
    current: list[dict] = []
    previous = None
    for entry in routes.entries:
        if previous is not None and entry["layer"] <= previous:
            steps.append(current)
            current = []
        current.append(entry)
        previous = entry["layer"]
    if current:
        steps.append(current)
    return steps


# --------------------------------------------------------------------------
# The cache, replayed exactly


class Slru:
    """The per layer SLRU of src/h4/h4-expert-cache.cpp, segment for segment.

    Only the parts that decide residency are here: two lists per layer,
    admission into probation, promotion on the second access, demotion when the
    protected segment overflows, eviction from the head of probation. Full
    residency carries both segments up to the quota, exactly as the engine does,
    which is what makes a large cache stop evicting.
    """

    def __init__(self, quota: int, protected_fraction: float, experts: int,
                 first_layer: int, layer_count: int):
        self.quota = quota
        if quota >= experts:
            self.protected_quota = quota
            self.probation_quota = quota
        else:
            protected = int(quota * protected_fraction)
            protected = max(1, min(protected, quota - 1))
            self.protected_quota = protected
            self.probation_quota = quota - protected
        self.first_layer = first_layer
        # per layer: ordered dicts used as LRU lists, oldest first
        self.probation = [collections.OrderedDict() for _ in range(layer_count)]
        self.protected = [collections.OrderedDict() for _ in range(layer_count)]

    def resident(self, layer: int, expert: int) -> bool:
        index = layer - self.first_layer
        return expert in self.probation[index] or expert in self.protected[index]

    def access(self, layer: int, expert: int) -> bool:
        """Update the cache and report whether the expert was already there."""
        index = layer - self.first_layer
        probation = self.probation[index]
        protected = self.protected[index]
        if expert in protected:
            protected.move_to_end(expert)
            return True
        if expert in probation:
            del probation[expert]
            protected[expert] = True
            if len(protected) > self.protected_quota:
                demoted, _ = protected.popitem(last=False)
                probation[demoted] = True
                if len(probation) > self.probation_quota:
                    probation.popitem(last=False)
            return True
        probation[expert] = True
        if len(probation) > self.probation_quota:
            probation.popitem(last=False)
        return False


def check_cache_simulation(routes: Routes) -> tuple[Slru, int, int]:
    """Replay every access and refuse to continue if a residency bit disagrees.

    The engine wrote down what it found in the cache. If the simulation says
    something else, the simulation is wrong and so is everything built on it.
    """
    layer_count = routes.last_layer - routes.first_layer + 1
    cache = Slru(routes.quota, routes.protected_fraction, routes.experts,
                 routes.first_layer, layer_count)
    checked = 0
    for entry in routes.entries:
        layer = entry["layer"]
        for expert, recorded in zip(entry["ids"], entry["resident"]):
            simulated = cache.resident(layer, expert)
            if simulated != bool(recorded):
                raise SystemExit(
                    f"ECHEC: the simulated cache disagrees with the engine at callback "
                    f"{entry['seq']}, layer {layer}, expert {expert}: simulated "
                    f"{'resident' if simulated else 'absent'}, engine recorded "
                    f"{'resident' if recorded else 'absent'}. Every hit rate below "
                    f"would be a statement about a cache that does not exist.")
            checked += 1
        # The engine samples every residency bit of the micro-batch BEFORE it
        # serves any of them, then serves them in order. Same order here.
        for expert in entry["ids"]:
            cache.access(layer, expert)
    return cache, checked, layer_count


def replay_to(routes: Routes, upto: int) -> Slru:
    """A cache warmed by every callback strictly before index `upto`."""
    layer_count = routes.last_layer - routes.first_layer + 1
    cache = Slru(routes.quota, routes.protected_fraction, routes.experts,
                 routes.first_layer, layer_count)
    for entry in routes.entries[:upto]:
        for expert in entry["ids"]:
            cache.access(entry["layer"], expert)
    return cache


# --------------------------------------------------------------------------
# The predictors


def predictors(k: int, history: list[list[int]], counts: collections.Counter,
               ranks_previous: list[int], previous_layer_ids: list[int],
               cooccurrence: dict[int, collections.Counter]) -> dict:
    """Every candidate set, from what is knowable before the layer runs.

    history[0] is the previous step at this layer, history[1] the one before,
    and so on. counts is the frequency of every expert of this layer since the
    run started. ranks_previous is the argsort of this layer at the previous
    step, deeper than the top-k cut, when it was recorded. previous_layer_ids is
    what layer L-1 selected at the SAME step, which is the only signal that is
    both causal and fresh.
    """
    out: dict[str, set[int]] = {}
    if history:
        out["P1 previous token"] = set(history[0])
    for window in (2, 4, 8):
        if len(history) >= window:
            union: set[int] = set()
            for step in history[:window]:
                union.update(step)
            out[f"P2 union of last {window}"] = union
    if counts:
        out["P3 k most frequent"] = {e for e, _ in counts.most_common(k)}
    for margin in (1, 2, 4):
        if len(ranks_previous) >= k + margin:
            out[f"P4 top-k+{margin} previous token"] = set(ranks_previous[:k + margin])
    # P5, what the data suggests once the shape of P1 is visible.
    if history:
        for depth in (1, 2, 4):
            if depth < k:
                out[f"P5a top-{depth} of previous token"] = set(history[0][:depth])
    if len(history) >= 2:
        out["P5b stable across two tokens"] = set(history[0]) & set(history[1])
    if previous_layer_ids:
        out["P5c same token, layer L-1"] = set(previous_layer_ids)
        # The only signal that is both causal and fresh: layer L-1 has already
        # run for THIS token, so its top choice is known before layer L's
        # router exists. Learned online, no training pass.
        table = cooccurrence.get(previous_layer_ids[0])
        if table:
            out["P5d learned from layer L-1 top-1"] = {e for e, _ in table.most_common(k)}
    return out


def analyse(routes: Routes, generation_steps: int) -> dict:
    steps = steps_of(routes)
    layer_count = routes.last_layer - routes.first_layer + 1
    if generation_steps >= len(steps):
        raise SystemExit(f"ECHEC: {len(steps)} complete steps in {routes.path.name}, "
                         f"which is not more than the {generation_steps} asked for")
    boundary = len(steps) - generation_steps

    k = routes.used
    # Per layer state, built over the whole run so the generation phase inherits
    # a realistic history and a realistic cache.
    history: dict[int, list[list[int]]] = collections.defaultdict(list)
    counts: dict[int, collections.Counter] = collections.defaultdict(collections.Counter)
    cache = Slru(routes.quota, routes.protected_fraction, routes.experts,
                 routes.first_layer, layer_count)

    # name -> layer -> [covered, missing, speculative_reads, useful_reads]
    tally: dict[str, dict[int, list[int]]] = collections.defaultdict(
        lambda: collections.defaultdict(lambda: [0, 0, 0, 0, 0]))
    cache_hits = collections.defaultdict(int)
    cache_accesses = collections.defaultdict(int)
    misses_per_step: list[int] = []

    ranks_history: dict[int, list[int]] = {}
    # layer -> top-1 expert of layer L-1 at the same step -> what layer L chose
    cooccurrence: dict[int, dict[int, collections.Counter]] = collections.defaultdict(
        lambda: collections.defaultdict(collections.Counter))

    for index, step in enumerate(steps):
        evaluated = index >= boundary
        step_misses = 0
        previous_layer_ids: list[int] = []
        for entry in step:
            layer = entry["layer"]
            ids = entry["ids"]
            need = set(ids)
            absent = {e for e in need if not cache.resident(layer, e)}
            if evaluated:
                cache_accesses[layer] += len(ids)
                cache_hits[layer] += len(ids) - len(absent)
                step_misses += len(absent)
                candidates = predictors(k, history[layer], counts[layer],
                                        ranks_history.get(layer, []), previous_layer_ids,
                                        cooccurrence[layer])
                for name, predicted in candidates.items():
                    # Net of the cache on both sides: an expert the SLRU
                    # already holds is neither a saved read nor a wasted one.
                    speculative = {e for e in predicted if not cache.resident(layer, e)}
                    useful = speculative & absent
                    slot = tally[name][layer]
                    slot[0] += len(useful)
                    slot[1] += len(absent)
                    slot[2] += len(speculative)
                    slot[3] += len(useful)
                    slot[4] += len(predicted)
            # State advances for every step, evaluated or not.
            history[layer].insert(0, list(ids))
            del history[layer][8:]
            counts[layer].update(ids)
            entry_ranks = routes.ranks.get(entry["seq"])
            if entry_ranks is not None and entry["tokens"] == 1:
                # THE CROSS-CHECK on the ranks. They come from a different
                # place than the ids: the argsort node, read by the eval
                # callback, against the top-k copy the remap callback was
                # handed. If the two ever disagreed, the run that produced them
                # would not be the run whose routes are being studied.
                head = entry_ranks[1][:len(ids)]
                if head != ids:
                    raise SystemExit(
                        f"ECHEC: at callback {entry['seq']}, layer {layer}, the argsort "
                        f"head {head} is not the top-k the layer used {ids}. The ranks "
                        f"and the ids do not describe the same decode.")
                ranks_history[layer] = entry_ranks[1]
            if previous_layer_ids:
                cooccurrence[layer][previous_layer_ids[0]].update(ids)
            for expert in ids:
                cache.access(layer, expert)
            previous_layer_ids = list(ids)
        if evaluated:
            misses_per_step.append(step_misses)

    return {
        "steps": len(steps),
        "generation_steps": generation_steps,
        "prompt_steps": boundary,
        "tally": tally,
        "cache_hits": cache_hits,
        "cache_accesses": cache_accesses,
        "misses_per_step": misses_per_step,
        "layers": list(range(routes.first_layer, routes.last_layer + 1)),
    }


# --------------------------------------------------------------------------
# Timing


def timing(routes: Routes, generation_steps: int) -> dict:
    """The window a prefetch would have to fill, and what a read costs.

    gap_ns is the wall time between the end of one layer's callback and the
    start of the next one: everything the machine does between two routers, so
    exactly the lead a prefetch issued at layer L would have before layer L+1
    asks. It is measured only between consecutive layers of the same step; the
    gap that straddles two tokens also contains sampling and graph setup.

    serve_ns is the time inside serve_layer, which is the cache lookup plus the
    reads. Grouped by how many records the layer actually had to read, it gives
    the cost of one record and how much of a second one is hidden by the first.
    """
    steps = steps_of(routes)
    layer_count = routes.last_layer - routes.first_layer + 1
    boundary = max(0, len(steps) - generation_steps)
    gaps: list[int] = []
    boundary_gaps: list[int] = []
    serve: dict[int, list[int]] = collections.defaultdict(list)
    per_step_serve: list[int] = []
    per_step_gap: list[int] = []
    per_step_total: list[int] = []
    cache = Slru(routes.quota, routes.protected_fraction, routes.experts,
                 routes.first_layer, layer_count)
    for index, step in enumerate(steps):
        counted = index >= boundary
        total_serve = 0
        total_gap = 0
        total_boundary = 0
        for position, entry in enumerate(step):
            absent = {e for e in entry["ids"] if not cache.resident(entry["layer"], e)}
            for expert in entry["ids"]:
                cache.access(entry["layer"], expert)
            if not counted:
                continue
            duration = entry["serve_end_ns"] - entry["serve_start_ns"]
            serve[len(absent)].append(duration)
            total_serve += duration
            if position > 0:
                gaps.append(entry["gap_ns"])
                total_gap += entry["gap_ns"]
            else:
                boundary_gaps.append(entry["gap_ns"])
                total_boundary += entry["gap_ns"]
        if counted:
            per_step_serve.append(total_serve)
            per_step_gap.append(total_gap)
            per_step_total.append(total_serve + total_gap + total_boundary)
    return {
        "gaps": gaps,
        "boundary_gaps": boundary_gaps,
        "serve_by_misses": {n: v for n, v in sorted(serve.items())},
        "per_step_serve": per_step_serve,
        "per_step_gap": per_step_gap,
        "per_step_total": per_step_total,
    }


def marginal_read_ns(serve_by_misses: dict[int, list[int]]) -> tuple[float, float]:
    """What one more record costs, and what a call costs before any record.

    A straight line through the median time inside serve_layer against the
    number of records that call actually had to read, weighted by how often each
    count occurs. The slope is the marginal cost of a record on this machine,
    which is the number a prefetch has to beat; the intercept is the bookkeeping
    that no prefetch can remove.
    """
    points = [(count, statistics.median(v), len(v))
              for count, v in serve_by_misses.items() if count >= 1 and v]
    if len(points) < 2:
        return 0.0, 0.0
    weight = sum(p[2] for p in points)
    mean_x = sum(p[0] * p[2] for p in points) / weight
    mean_y = sum(p[1] * p[2] for p in points) / weight
    variance = sum(p[2] * (p[0] - mean_x) ** 2 for p in points)
    if variance == 0:
        return 0.0, 0.0
    slope = sum(p[2] * (p[0] - mean_x) * (p[1] - mean_y) for p in points) / variance
    return slope, mean_y - slope * mean_x


def quantiles(values: list[int]) -> dict:
    if not values:
        return {}
    ordered = sorted(values)
    def at(fraction: float) -> float:
        return ordered[min(len(ordered) - 1, int(fraction * len(ordered)))]
    return {"n": len(ordered), "p05": at(0.05), "median": statistics.median(ordered),
            "mean": statistics.fmean(ordered), "p95": at(0.95), "max": ordered[-1]}


# --------------------------------------------------------------------------


def report(routes: Routes, result: dict, times: dict, as_json: bool) -> None:
    layers = result["layers"]
    record = statistics.fmean(routes.records.values())
    accesses = sum(result["cache_accesses"].values())
    hits = sum(result["cache_hits"].values())
    misses = accesses - hits

    rows = []
    for name, per_layer in sorted(result["tally"].items()):
        covered = sum(v[0] for v in per_layer.values())
        missing = sum(v[1] for v in per_layer.values())
        speculative = sum(v[2] for v in per_layer.values())
        useful = sum(v[3] for v in per_layer.values())
        named = sum(v[4] for v in per_layer.values())
        coverage = covered / missing if missing else 0.0
        # None, not infinity: a predictor that issues no read at all has no
        # amplification to report. It is a no-op, which is a different verdict
        # from a wasteful predictor and has to read as one.
        amplification = (speculative / useful) if useful else (None if not speculative else None)
        by_layer = {}
        for layer in layers:
            slot = per_layer.get(layer)
            if slot and slot[1]:
                by_layer[layer] = slot[0] / slot[1]
        rows.append({
            "predictor": name,
            "coverage": coverage,
            "amplification": amplification,
            "records_named_per_step": named / max(1, result["generation_steps"]),
            "already_resident_share": (named - speculative) / named if named else 0.0,
            "speculative_records_per_step": speculative / max(1, result["generation_steps"]),
            "wasted_bytes_per_step": (speculative - useful) * record
                                     / max(1, result["generation_steps"]),
            "coverage_by_layer": by_layer,
        })
    rows.sort(key=lambda r: -r["coverage"])

    payload = {
        "routes": str(routes.path),
        "arch": routes.arch,
        "experts": routes.experts,
        "used": routes.used,
        "layers": len(layers),
        "cache_gb": routes.cache_bytes / 1e9,
        "quota": routes.quota,
        "probation": routes.probation,
        "protected_fraction": routes.protected_fraction,
        "mean_record_bytes": record,
        "steps": result["steps"],
        "prompt_steps": result["prompt_steps"],
        "generation_steps": result["generation_steps"],
        "cache_hit_rate": hits / accesses if accesses else 0.0,
        "misses_per_step": statistics.fmean(result["misses_per_step"])
                           if result["misses_per_step"] else 0.0,
        "bytes_read_per_step": (statistics.fmean(result["misses_per_step"]) * record)
                               if result["misses_per_step"] else 0.0,
        "predictors": rows,
        "gap_ns_between_layers": quantiles(times["gaps"]),
        "gap_ns_at_token_boundary": quantiles(times["boundary_gaps"]),
        "serve_ns_by_miss_count": {str(n): quantiles(v)
                                   for n, v in times["serve_by_misses"].items()},
        "serve_ns_per_step": quantiles(times["per_step_serve"]),
        "gap_ns_per_step": quantiles(times["per_step_gap"]),
        "token_ns": quantiles(times["per_step_total"]),
    }
    slope, intercept = marginal_read_ns(times["serve_by_misses"])
    token_ns = payload["token_ns"]["mean"] if payload["token_ns"] else 0.0
    read_ns = payload["misses_per_step"] * slope
    payload["marginal_read_ns"] = slope
    payload["serve_overhead_ns"] = intercept
    payload["read_ns_per_token"] = read_ns
    payload["ceiling_share"] = read_ns / token_ns if token_ns else 0.0
    window = payload["gap_ns_between_layers"].get("median", 0) or 0
    for row in rows:
        saved = row["coverage"] * read_ns
        cost = row["speculative_records_per_step"] * slope
        row["gain_share"] = saved / token_ns if token_ns else 0.0
        row["device_share_after"] = (read_ns + cost - saved) / token_ns if token_ns else 0.0
        per_layer_reads = row["speculative_records_per_step"] / max(1, len(layers))
        row["window_fit"] = (per_layer_reads * slope / window) if window else 0.0
    if as_json:
        print(json.dumps(payload, indent=2))
        return

    print(f"=== {routes.path.name} ===")
    print(f"  {routes.arch}, {len(layers)} MoE layers, {routes.experts} experts, "
          f"{routes.used} used, {record / 1e6:.2f} MB per record")
    print(f"  cache {routes.cache_bytes / 1e9:.2f} GB, quota {routes.quota}/{routes.experts}, "
          f"probation {routes.probation}, protected {routes.protected_fraction:.2f}")
    print(f"  {result['steps']} steps, {result['prompt_steps']} prompt, "
          f"{result['generation_steps']} generation (the ones measured)")
    if routes.truncated:
        print("  AVERTISSEMENT: the route file was truncated by its own entry cap")
    if routes.extended_refused:
        print(f"  AVERTISSEMENT: extended ranks refused ({routes.extended_refused}), "
              f"P4 cannot be computed")
    print()
    print(f"  cache hit rate on generation           {payload['cache_hit_rate'] * 100:6.2f}%")
    print(f"  records reaching the SSD per token     {payload['misses_per_step']:6.2f} "
          f"({payload['bytes_read_per_step'] / 1e6:.1f} MB)")
    print()
    print(f"  {'predictor':<32} {'coverage':>9} {'amplif.':>9} {'named':>7} {'to read':>8}"
          f" {'waste/tok':>11}")
    for row in rows:
        amplification = ("-" if row["amplification"] is None
                         else f"{row['amplification']:.2f}x")
        print(f"  {row['predictor']:<32} {row['coverage'] * 100:8.2f}% {amplification:>9} "
              f"{row['records_named_per_step']:7.2f} "
              f"{row['speculative_records_per_step']:8.2f} "
              f"{row['wasted_bytes_per_step'] / 1e6:10.1f}MB")
    print("  named    = records the predictor names per token")
    print("  to read  = of those, the ones the cache does not already hold, so real SSD reads")
    print("  coverage = share of the reads on the critical path the predictor would have hidden")
    print("  amplif.  = speculative reads issued per read that turned out to be needed")
    print()
    gap = payload["gap_ns_between_layers"]
    if gap:
        print(f"  window between two consecutive layers  median {gap['median'] / 1000:9.1f} us"
              f"  mean {gap['mean'] / 1000:9.1f} us  p95 {gap['p95'] / 1000:9.1f} us")
    boundary = payload["gap_ns_at_token_boundary"]
    if boundary:
        print(f"  window across the token boundary       median "
              f"{boundary['median'] / 1000:9.1f} us  mean {boundary['mean'] / 1000:9.1f} us")
    print("  time inside serve_layer, by records actually read:")
    for count, stats in sorted(payload["serve_ns_by_miss_count"].items(), key=lambda x: int(x[0])):
        print(f"    {count:>3} record(s)  n={stats['n']:<6} median {stats['median'] / 1000:9.1f} us"
              f"  mean {stats['mean'] / 1000:9.1f} us  p95 {stats['p95'] / 1000:9.1f} us")
    step_serve = payload["serve_ns_per_step"]
    step_gap = payload["gap_ns_per_step"]
    step_total = payload["token_ns"]
    if step_serve and step_gap and step_total:
        share = step_serve["mean"] / step_total["mean"]
        print(f"  per token: {step_total['mean'] / 1e6:.2f} ms in total, of which "
              f"{step_serve['mean'] / 1e6:.2f} ms inside serve_layer "
              f"({share * 100:.1f}%) and {step_gap['mean'] / 1e6:.2f} ms of compute "
              f"between layers")
    slope, intercept = payload["marginal_read_ns"], payload["serve_overhead_ns"]
    print(f"  one more record costs {slope / 1000:.0f} us, a serve call costs "
          f"{intercept / 1000:.0f} us before any record")
    print()
    print("  WHAT A PERFECT PREFETCH COULD BUY, AND WHAT EACH PREDICTOR ACTUALLY BUYS")
    print("  A prefetch can only remove read time. The ceiling is the whole read time of a")
    print("  token; nothing hides compute. Gain assumes the speculative read is issued early")
    print("  enough and completes in time, and ignores the experts it evicts, so it is an")
    print("  upper bound in two ways at once.")
    print(f"  ceiling: {payload['read_ns_per_token'] / 1e6:.2f} ms of read per token out of "
          f"{step_total['mean'] / 1e6:.2f} ms, so no prefetch can save more than "
          f"{payload['ceiling_share'] * 100:.1f}%")
    print()
    print(f"  {'predictor':<32} {'gain':>7} {'device time':>12} {'fits window':>12}")
    for row in rows:
        if row["speculative_records_per_step"] == 0:
            print(f"  {row['predictor']:<32} {'0.0%':>7} {'unchanged':>12} {'no read':>12}")
            continue
        print(f"  {row['predictor']:<32} {row['gain_share'] * 100:6.1f}% "
              f"{row['device_share_after'] * 100:11.0f}% "
              f"{row['window_fit']:11.2f}x")
    print("  gain        = share of token time removed, at best")
    print("  device time = read time per token after prefetching, as a share of token time")
    print("                (it was " + f"{payload['ceiling_share'] * 100:.0f}%" + " before)")
    print("  fits window = speculative read time for one layer over the compute window")
    print("                available before that layer runs. Above 1.00 it does not fit")


def per_layer_table(routes: Routes, result: dict, best: list[str]) -> None:
    """The same question, layer by layer.

    A predictor can be worth building for the deep half of a model and useless
    for the first few layers, and an average hides that. The cache hit rate is
    here too, because a layer whose experts are all resident has no read to hide
    no matter how well it is predicted.
    """
    steps = max(1, result["generation_steps"])
    print()
    header = f"  {'layer':>5} {'cache hit':>10} {'reads/tok':>10}"
    for name in best:
        header += f" {name[:18]:>19}"
    print(header)
    for layer in result["layers"]:
        accesses = result["cache_accesses"].get(layer, 0)
        if not accesses:
            continue
        hits = result["cache_hits"].get(layer, 0)
        reads = (accesses - hits) / steps
        line = f"  {layer:>5} {hits / accesses * 100:9.1f}% {reads:10.2f}"
        for name in best:
            slot = result["tally"].get(name, {}).get(layer)
            share = (slot[0] / slot[1] * 100) if slot and slot[1] else 0.0
            line += f" {share:18.1f}%"
        print(line)


def main() -> int:
    ap = argparse.ArgumentParser(description="Prefetch predictability of MoE routes.")
    ap.add_argument("--routes", required=True, help="a file written by GALACTUS_H4_ROUTES")
    ap.add_argument("--generation-steps", type=int, default=256,
                    help="how many trailing steps are the generation phase (default 256)")
    ap.add_argument("--json", action="store_true", help="machine readable output")
    ap.add_argument("--per-layer", action="store_true",
                    help="add the layer by layer table for the three best predictors")
    ap.add_argument("--skip-cache-check", action="store_true",
                    help="do not verify the simulated cache against the recorded residency "
                         "bits. Only for a file whose header is known to be incomplete")
    args = ap.parse_args()

    routes = Routes(pathlib.Path(args.routes))
    if not routes.entries:
        print(f"ECHEC: no entries in {args.routes}", file=sys.stderr)
        return 2
    if not args.skip_cache_check:
        _, checked, _ = check_cache_simulation(routes)
        if not args.json:
            print(f"cache simulation verified against {checked} recorded residency bits\n")
    result = analyse(routes, args.generation_steps)
    times = timing(routes, args.generation_steps)
    report(routes, result, times, args.json)
    if args.per_layer and not args.json:
        ranked = sorted(result["tally"].items(),
                        key=lambda item: -sum(v[0] for v in item[1].values()))
        per_layer_table(routes, result, [name for name, _ in ranked[:3]])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
