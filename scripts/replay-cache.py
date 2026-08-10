#!/usr/bin/env python3
"""Replay real routing traces through candidate expert cache policies.

WHAT THIS ANSWERS

The SSD is the bottleneck by construction, so every expert record the cache
keeps out of the read path is throughput. Two things decide how many records
reach the device: how many slots each MoE layer gets, and which expert occupies
a slot. Both are policy, both are cheap to change, and both were chosen once
and never compared against an alternative on real data.

A cache policy is a pure function of the access sequence. The engine already
writes that sequence down: artifacts/h4/routes/*.routes holds the expert ids
every layer selected, token by token, from real runs. So a policy can be
replayed offline, deterministically, with no engine, no model and no device.
This script is that replay.

WHAT IT REPORTS

For every policy, on the generation phase only (the prompt phase warms the
cache and is not counted):

  hit rate        resident accesses over all accesses
  reads per token records that reach the SSD per decode step

both overall and layer by layer, always against the current engine policy as
the baseline.

THE ROW THAT DECIDES IS THE SMALLEST QUOTA, NOT THE AVERAGE

The product is throughput on a machine that does not have the RAM: eight
percent of the experts in cache buys about ten percent of the full residency
speed, and that is the configuration people actually run. At a quota where the
whole model fits, no eviction ever happens and no cache policy can change
anything. A policy judged on an average over quotas is therefore judged mostly
on the regime where it cannot matter. --sweep replays every candidate at every
quota from the smallest one that can run to full residency, and the number
that counts is the first row.

WHAT THE SWEEP SAID, records reaching the SSD per token against the uniform
quota at identical arena bytes (plan plus frequency victim, the shipped
policy):

                        smallest quota that runs        quota shipped today
  qwen3-30b-a3b          9 slots,  2.2 GB,  -3.8 %      37 slots,  -8.5 %
  phi35-moe              3 slots,  4.6 GB,  -2.4 %       6 slots,  -5.3 %
  olmoe-1b-7b            9 slots,  0.5 GB,  -7.7 %      31 slots, -34.0 %

and it is never worse than the baseline at any quota of any model, with an
exact tie at full residency where nothing can be gained.

THE BASELINE IS NOT ASSUMED, IT IS CHECKED

The engine recorded, for every id it looked up, whether the cache already held
it. The baseline policy here is replayed against those bits one by one and a
single disagreement is fatal. Without that check every number below would be a
statement about a cache that does not exist. Run with --verify.

WHAT THE ALLOCATION IS ALLOWED TO DEPEND ON

The arena is laid out once, at store construction: layer L's three expert
tensors are 3D views with ne[2] equal to that layer's slot count and nb[2]
equal to the record size, backed at a fixed address. Slots of one layer are
therefore contiguous and their number is frozen before the first token. No
online scheme can move a slot from one layer to another; only WHICH expert
sits in a slot can be learned during the run. So a non uniform allocation has
to come from something known before the run: the layer index, the record
sizes, or a calibration file produced by an earlier run of the same model.
That constraint is not a simplification here, it is the shape of the problem,
and every candidate below respects it.

WHAT ADMISSION CANNOT DO HERE

A frequency filter on ADMISSION is the textbook answer to a skewed workload,
and it is not available in this engine. A missing expert has to enter a slot
for the layer to compute; there is no bypass in an arena. Rejecting admission
therefore means putting the record in a rejection ring, and that ring has to
hold every expert of one micro-batch, which is `used` slots. At nine slots per
layer for eight active experts that is nearly the whole cache. Measured
anyway, and it costs 4 to 28 percent more reads everywhere. Frequency on
EVICTION costs no slot at all and is what this ships.

Usage:
  python3 scripts/replay-cache.py --routes artifacts/h4/routes/<file>.routes --verify
  python3 scripts/replay-cache.py --routes <file> --sweep --plan cache-plans/<arch>.txt
  python3 scripts/replay-cache.py --routes <file> --policy slru,shaped,tinylfu
  python3 scripts/replay-cache.py --routes <file> --per-layer
"""
from __future__ import annotations

import argparse
import collections
import json
import math
import pathlib
import sys

# --------------------------------------------------------------------------
# The route file. Only the fields a cache policy can see.


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
        self.entries: list[dict] = []
        self._parse(path)

    def _parse(self, path: pathlib.Path) -> None:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("#"):
                    self._header(line[1:].split())
                elif line.startswith("e "):
                    self._entry(line.split())

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

    def _entry(self, parts: list[str]) -> None:
        ids: list[int] = []
        resident: list[int] = []
        for token in parts[10:]:
            left, right = token.split(":")
            ids.append(int(left))
            resident.append(int(right))
        self.entries.append({
            "seq": int(parts[1]), "layer": int(parts[2]), "tokens": int(parts[3]),
            "bytes_read": int(parts[9]), "ids": ids, "resident": resident,
        })

    @property
    def layer_count(self) -> int:
        return self.last_layer - self.first_layer + 1

    def record_bytes(self) -> list[int]:
        return [self.records[layer]
                for layer in range(self.first_layer, self.last_layer + 1)]


def steps_of(routes: Routes) -> list[list[dict]]:
    """Group the callbacks into decode steps.

    One step is one micro-batch: the wired layers fire in increasing order, so
    a layer index that does not increase opens a new step. A step does not
    always hold every layer, because llama.cpp gathers the rows that need
    logits before the last layer's FFN.
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
# The policies. One object per layer, because the engine's cache is one
# independent SLRU per layer and nothing crosses that boundary.


def segment_split(quota: int, protected_fraction: float, experts: int,
                  probation_floor: int = 0) -> tuple[int, int]:
    """The two segment sizes of src/h4/h4-expert-cache.cpp, exactly.

    Full residency (quota at or above the model's expert count) carries both
    segments up to the quota, which is what makes a large cache stop evicting.

    probation_floor is what a non uniform allocation needs and the uniform one
    does not. The engine bounds a micro-batch by the SMALLER of the layer
    quota and its probation segment, because a cold batch only ever inserts
    into probation: shrink a layer and that bound shrinks with it, and a batch
    shape that ran yesterday throws today. Holding probation at the floor the
    uniform configuration already provides makes the bound invariant under
    reallocation, and the protected segment absorbs the whole variation. With
    probation_floor at 0 this function is the shipped formula, unchanged.
    """
    if quota >= experts:
        return quota, quota
    protected = int(quota * protected_fraction)
    protected = max(1, min(protected, quota - 1))
    probation = quota - protected
    if probation < probation_floor:
        probation = min(quota - 1, probation_floor)
        protected = quota - probation
    return protected, probation


class LayerSlru:
    """The shipped policy for one layer: two segment SLRU, LRU victim.

    admission="always" and victim="lru" reproduce the engine byte for byte.
    The other settings are the candidates.
    """

    __slots__ = ("quota", "protected_quota", "probation_quota", "probation",
                 "protected", "victim", "admission", "bypass_quota", "bypass",
                 "freq", "decay_period", "since_decay", "experts", "epoch",
                 "seen_epoch")

    def __init__(self, quota: int, protected_fraction: float, experts: int,
                 victim: str = "lru", admission: str = "always",
                 bypass_quota: int = 0, decay_period: int = 0,
                 probation_floor: int = 0):
        self.experts = experts
        self.victim = victim
        self.admission = admission
        self.bypass_quota = bypass_quota
        main = quota - bypass_quota
        if main < 2:
            raise ValueError(f"quota {quota} minus bypass {bypass_quota} leaves {main} slots")
        self.quota = main
        self.protected_quota, self.probation_quota = segment_split(
            main, protected_fraction, experts, probation_floor)
        self.probation: collections.OrderedDict[int, bool] = collections.OrderedDict()
        self.protected: collections.OrderedDict[int, bool] = collections.OrderedDict()
        self.bypass: collections.OrderedDict[int, bool] = collections.OrderedDict()
        self.freq: collections.Counter[int] = collections.Counter()
        self.decay_period = decay_period
        self.since_decay = 0
        self.epoch = 0
        self.seen_epoch: dict[int, int] = {}

    def begin_batch(self) -> None:
        """Open a new micro-batch.

        THE INVARIANT THIS EXISTS FOR. Every expert a micro-batch selects has
        to be resident at the same instant, because one mul_mat_id consumes
        them all. So nothing brought in for this batch may be evicted by this
        batch. The shipped LRU gets that for free: a key just inserted sits at
        the tail of probation and the victim is taken from the head. Any other
        victim rule has to earn it, and a frequency rule does not: a cold
        expert admitted a moment ago has the lowest count in the layer and is
        exactly what a naive least frequent scan would pick. Marking the batch
        each key was last touched in is what lets the scan skip them, and
        without it the policy would read the wrong bytes, which is not a
        performance question.
        """
        self.epoch += 1

    def resident(self, expert: int) -> bool:
        return (expert in self.probation or expert in self.protected
                or expert in self.bypass)

    def _bump(self, expert: int) -> None:
        if self.admission == "always" and self.victim == "lru":
            return
        self.freq[expert] += 1
        if self.decay_period:
            self.since_decay += 1
            if self.since_decay >= self.decay_period:
                self.since_decay = 0
                for key in list(self.freq):
                    half = self.freq[key] >> 1
                    if half:
                        self.freq[key] = half
                    else:
                        del self.freq[key]

    def _evict_probation(self) -> None:
        """Drop one entry from probation, by the configured victim rule."""
        if self.victim == "lru":
            self.probation.popitem(last=False)
            return
        # Least frequent, oldest first on a tie, and never a key this
        # micro-batch brought in (see begin_batch). The scan is over the
        # probation segment only, which is a handful of entries.
        worst = None
        worst_count = None
        for key in self.probation:
            if self.seen_epoch.get(key) == self.epoch:
                continue
            count = self.freq[key]
            if worst_count is None or count < worst_count:
                worst, worst_count = key, count
        if worst is None:
            # Every entry belongs to this batch. The engine's guard makes this
            # unreachable (a batch may not hold more distinct experts than the
            # probation segment), and falling back to the oldest keeps the
            # replay defined rather than silently wrong if it ever is.
            self.probation.popitem(last=False)
            return
        del self.probation[worst]

    def _insert_probation(self, expert: int) -> None:
        self.probation[expert] = True
        if len(self.probation) > self.probation_quota:
            self._evict_probation()

    def access(self, expert: int) -> bool:
        """Update the layer and report whether the expert was already there."""
        self._bump(expert)
        if self.victim != "lru":
            self.seen_epoch[expert] = self.epoch
        if expert in self.protected:
            self.protected.move_to_end(expert)
            return True
        if expert in self.probation:
            del self.probation[expert]
            self.protected[expert] = True
            if len(self.protected) > self.protected_quota:
                demoted, _ = self.protected.popitem(last=False)
                self._insert_probation(demoted)
            return True
        if expert in self.bypass:
            # The record is physically resident, so this is a hit. It is also
            # the second access that the admission filter was waiting for, so
            # the entry graduates into the main cache.
            del self.bypass[expert]
            self._insert_probation(expert)
            return True
        # Absent. The record has to land in a slot no matter what the policy
        # thinks of it, because the layer cannot compute without it. Rejecting
        # admission therefore means "put it in the bypass ring", never "do not
        # cache it": there is no bypass in an arena.
        if self.admission == "tinylfu" and len(self.probation) >= self.probation_quota:
            victim = next(iter(self.probation), None)
            if victim is not None and self.freq[victim] >= self.freq[expert]:
                self.bypass[expert] = True
                if len(self.bypass) > self.bypass_quota:
                    self.bypass.popitem(last=False)
                return False
        self._insert_probation(expert)
        return False


class Policy:
    """A cache: one LayerSlru per layer, plus the slot accounting."""

    def __init__(self, name: str, quotas: list[int], routes: Routes,
                 victim: str = "lru", admission: str = "always",
                 bypass_quota: int = 0, decay_period: int = 0,
                 overhead_bytes: int = 0, probation_floor: int = 0):
        self.name = name
        self.quotas = quotas
        self.first_layer = routes.first_layer
        self.overhead_bytes = overhead_bytes
        self.layers = [
            LayerSlru(quota, routes.protected_fraction, routes.experts,
                      victim=victim, admission=admission,
                      bypass_quota=bypass_quota, decay_period=decay_period,
                      probation_floor=probation_floor)
            for quota in quotas
        ]

    def resident(self, layer: int, expert: int) -> bool:
        return self.layers[layer - self.first_layer].resident(expert)

    def access(self, layer: int, expert: int) -> bool:
        return self.layers[layer - self.first_layer].access(expert)

    def begin_batch(self, layer: int) -> None:
        self.layers[layer - self.first_layer].begin_batch()

    def bytes_used(self, record_bytes: list[int]) -> int:
        return sum(q * b for q, b in zip(self.quotas, record_bytes)) + self.overhead_bytes

    def min_probation(self) -> int:
        return min(layer.probation_quota for layer in self.layers)


# --------------------------------------------------------------------------
# The replay itself


class Result:
    def __init__(self, name: str, layers: list[int]):
        self.name = name
        self.layers = layers
        self.hits: dict[int, int] = collections.defaultdict(int)
        self.accesses: dict[int, int] = collections.defaultdict(int)
        self.tokens = 0

    @property
    def total_hits(self) -> int:
        return sum(self.hits.values())

    @property
    def total_accesses(self) -> int:
        return sum(self.accesses.values())

    @property
    def hit_rate(self) -> float:
        return self.total_hits / self.total_accesses if self.total_accesses else 0.0

    @property
    def reads_per_token(self) -> float:
        misses = self.total_accesses - self.total_hits
        return misses / self.tokens if self.tokens else 0.0

    def layer_hit_rate(self, layer: int) -> float:
        accesses = self.accesses.get(layer, 0)
        return self.hits.get(layer, 0) / accesses if accesses else 0.0

    def layer_reads_per_token(self, layer: int) -> float:
        if not self.tokens:
            return 0.0
        return (self.accesses.get(layer, 0) - self.hits.get(layer, 0)) / self.tokens


def replay(routes: Routes, policy: Policy, steps: list[list[dict]],
           generation_steps: int) -> Result:
    """Run every step through the policy, count only the generation phase.

    The prompt phase is replayed too, and silently: it is what leaves the
    cache in the state the generation phase inherits. Counting it would mix
    the cost of filling an empty cache into the steady state number.
    """
    boundary = len(steps) - generation_steps
    result = Result(policy.name, list(range(routes.first_layer, routes.last_layer + 1)))
    for index, step in enumerate(steps):
        counted = index >= boundary
        for entry in step:
            layer = entry["layer"]
            ids = entry["ids"]
            policy.begin_batch(layer)
            if counted:
                # One miss is one read, counted in serve order. The engine
                # serves the keys of a micro-batch one after another and a
                # repeated id finds the record its own earlier copy brought
                # in, so residency is asked for immediately before each
                # access and never sampled for the whole batch in advance.
                hits = 0
                for expert in ids:
                    if policy.access(layer, expert):
                        hits += 1
                result.accesses[layer] += len(ids)
                result.hits[layer] += hits
            else:
                for expert in ids:
                    policy.access(layer, expert)
        if counted:
            result.tokens += 1
    return result


def verify_baseline(routes: Routes, steps: list[list[dict]]) -> tuple[int, int]:
    """Replay the shipped policy against what the engine actually did.

    Two independent checks, because either one alone can pass on a wrong
    replay:

    RESIDENCY BITS. The engine sampled, for every id, whether the cache held
    it, and sampled the whole micro-batch before serving any of it. Matching
    those bits proves the replayed state machine is the engine's.

    BYTES READ. The engine also counted the bytes the reader actually pulled
    from the device, per callback. That is the number this whole study is
    about, and it is not the same as the residency bits: serving a key can
    evict a key that appears LATER in the same micro-batch, so a key sampled
    resident can still be read. Matching it to the byte proves the replay
    counts reads the way the device sees them and not the way the sample
    flatters them.

    One disagreement and every number this script prints is about a cache that
    does not exist, so this raises instead of warning.
    """
    policy = Policy("slru baseline", [routes.quota] * routes.layer_count, routes)
    checked = 0
    replayed_bytes = 0
    recorded_bytes = 0
    for entry in routes.entries:
        layer = entry["layer"]
        record = routes.records[layer]
        for expert, recorded in zip(entry["ids"], entry["resident"]):
            simulated = policy.resident(layer, expert)
            if simulated != bool(recorded):
                raise SystemExit(
                    f"ECHEC: the replayed baseline disagrees with the engine at callback "
                    f"{entry['seq']}, layer {layer}, expert {expert}: replay says "
                    f"{'resident' if simulated else 'absent'}, the engine recorded "
                    f"{'resident' if recorded else 'absent'}.")
            checked += 1
        for expert in entry["ids"]:
            if not policy.access(layer, expert):
                replayed_bytes += record
        recorded_bytes += entry["bytes_read"]
    if replayed_bytes != recorded_bytes:
        raise SystemExit(
            f"ECHEC: the replay reads {replayed_bytes} bytes where the engine read "
            f"{recorded_bytes} ({replayed_bytes - recorded_bytes:+d}). The replayed "
            f"policy is not the one that produced this trace.")
    return checked, recorded_bytes


# --------------------------------------------------------------------------
# Allocation: how many slots each layer should get


def smallest_viable_quota(routes: Routes, probation_floor: int) -> int:
    """The smallest quota a layer can be given and still compute a token.

    Every expert a micro-batch selects has to be resident at once, and a cold
    batch only inserts into probation, so the probation segment can never be
    smaller than the number of distinct experts in a batch. At one token per
    batch that is `used`. One protected slot on top of that is the floor, and
    anything below it is not a slower configuration, it is one that throws.
    """
    return max(2, probation_floor + 1)


def sweep_quotas(routes: Routes, floor: int) -> list[int]:
    """The quotas worth reporting, from the smallest that runs to full residency.

    Logarithmic, because that is how the interesting region is shaped: the
    difference between 12 slots and 16 is the whole product, the difference
    between 96 and 112 is nothing at all.
    """
    quotas: list[int] = []
    value = floor
    while value < routes.experts:
        quotas.append(value)
        step = max(1, value // 2)
        value += step
    quotas.append(routes.experts)
    return quotas


def miss_curves(routes: Routes, steps: list[list[dict]], generation_steps: int,
                max_quota: int, probation_floor: int) -> dict[int, list[int]]:
    """Generation misses of every layer at every quota from 2 to max_quota.

    Layers are independent SLRUs, so this is exact and not an approximation:
    replaying one layer alone gives the same residency it would have inside
    the full cache at the same quota.
    """
    boundary = len(steps) - generation_steps
    sequences: dict[int, list[tuple[bool, list[int]]]] = collections.defaultdict(list)
    for index, step in enumerate(steps):
        counted = index >= boundary
        for entry in step:
            sequences[entry["layer"]].append((counted, entry["ids"]))

    curves: dict[int, list[int]] = {}
    for layer, sequence in sequences.items():
        row = [0] * (max_quota + 1)
        for quota in range(2, max_quota + 1):
            cache = LayerSlru(quota, routes.protected_fraction, routes.experts,
                              probation_floor=probation_floor)
            misses = 0
            for counted, ids in sequence:
                if counted:
                    for expert in ids:
                        if not cache.resident(expert):
                            misses += 1
                        cache.access(expert)
                else:
                    for expert in ids:
                        cache.access(expert)
            row[quota] = misses
        curves[layer] = row
    return curves


def greedy_allocation(curves: dict[int, list[int]], record_bytes: list[int],
                      first_layer: int, budget: int, floor: int,
                      ceiling: int) -> list[int]:
    """Spend the byte budget where a slot removes the most reads.

    Start every layer at the floor, then hand out slots one at a time to
    whichever layer gains the most misses avoided per byte. Miss curves are
    not exactly convex, so each candidate is the best AVERAGE slope over a run
    of consecutive slots rather than the next single step: that is the concave
    envelope, and it is what stops a layer from being starved by one flat step
    in front of a cliff.
    """
    layers = sorted(curves)
    quotas = {layer: floor for layer in layers}
    spent = sum(floor * record_bytes[layer - first_layer] for layer in layers)
    if spent > budget:
        raise SystemExit(f"ECHEC: the floor of {floor} slots per layer already costs "
                         f"{spent} bytes, over the budget of {budget}")

    def best_step(layer: int) -> tuple[float, int]:
        """Best (gain per byte, slots taken) from the layer's current quota."""
        row = curves[layer]
        here = quotas[layer]
        cost = record_bytes[layer - first_layer]
        best = (0.0, 0)
        for take in range(1, min(ceiling, len(row) - 1) - here + 1):
            gain = row[here] - row[here + take]
            slope = gain / (take * cost)
            if slope > best[0]:
                best = (slope, take)
        return best

    pending = {layer: best_step(layer) for layer in layers}
    while True:
        candidate = None
        for layer in layers:
            slope, take = pending[layer]
            if take == 0:
                continue
            cost = take * record_bytes[layer - first_layer]
            if spent + cost > budget:
                continue
            if candidate is None or slope > candidate[0]:
                candidate = (slope, layer, take, cost)
        if candidate is None:
            break
        _, layer, take, cost = candidate
        quotas[layer] += take
        spent += cost
        pending[layer] = best_step(layer)
    return [quotas[layer] for layer in layers]


def shaped_allocation(routes: Routes, record_bytes: list[int], budget: int,
                      floor: int, ceiling: int, weight_fn) -> list[int]:
    """Distribute the budget by a weight that depends only on the layer index.

    Nothing here looks at the trace. The weight is a closed form of the layer
    position, which is knowable before the first token and identical for every
    run of every model, and the result is rounded down to whole slots and then
    topped up in weight order until the budget is exhausted.
    """
    count = routes.layer_count
    weights = [weight_fn(index, count) for index in range(count)]
    total_weight = sum(weights)
    quotas = [floor] * count
    spent = sum(floor * record_bytes[index] for index in range(count))
    room = budget - spent
    if room < 0:
        raise SystemExit("ECHEC: the floor already exceeds the budget")
    # First pass: proportional share of what is left, rounded down.
    for index in range(count):
        share = int(room * weights[index] / total_weight / record_bytes[index])
        extra = min(share, ceiling - floor)
        quotas[index] += extra
        spent += extra * record_bytes[index]
    # Second pass: hand out the remainder to the heaviest layers that still
    # have room, so the budget is used rather than rounded away.
    order = sorted(range(count), key=lambda i: -weights[i])
    progress = True
    while progress:
        progress = False
        for index in order:
            if quotas[index] >= ceiling:
                continue
            if spent + record_bytes[index] > budget:
                continue
            quotas[index] += 1
            spent += record_bytes[index]
            progress = True
    return quotas


def read_plan_curves(path: pathlib.Path, first_layer: int) -> dict[int, list[int]]:
    """The miss curves of a plan file, the same bytes the engine reads.

    Replaying a plan through this function and the allocator above is what
    makes the published numbers a statement about the file that ships, and not
    about a curve that only ever existed in memory.
    """
    curves: dict[int, list[int]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if parts and parts[0] == "curve":
            curves[int(parts[1])] = [int(value) for value in parts[2:]]
    if not curves:
        raise SystemExit(f"ECHEC: {path} holds no curve")
    if min(curves) != first_layer:
        raise SystemExit(f"ECHEC: {path} starts at layer {min(curves)}, the trace at "
                         f"{first_layer}")
    return curves


def head_weight(depth: int, amplitude: float, span: float) -> float:
    """The shape the traces show: a few early layers need much more room.

    Layer 0 has no residual history behind it, so its router sees the least
    differentiated input of the whole stack and spreads its choices almost
    uniformly over the experts; the deeper a layer sits, the more its routing
    concentrates and the smaller its working set. The weight therefore decays
    with depth and flattens out. Two knobs only, both of them properties of
    the stack and not of any prompt: how much extra the very first layer gets,
    and how fast that extra dies away.
    """
    return 1.0 + amplitude * math.exp(-depth / span)


def weights_of(quotas: list[int], record_bytes: list[int]) -> list[float]:
    """Turn an absolute allocation into a budget free shape.

    A calibration run gives slot counts for the budget it happened to run
    with. What transfers to another budget, and to another machine, is the
    RELATIVE share of the arena each layer took, which is what this returns.
    """
    total = sum(q * b for q, b in zip(quotas, record_bytes))
    return [q * b / total for q, b in zip(quotas, record_bytes)]


# --------------------------------------------------------------------------
# Reporting


def summarise(routes: Routes, record_bytes: list[int], baseline: Result,
              rows: list[tuple[Result, Policy]], per_layer: bool) -> dict:
    payload = {
        "routes": str(routes.path),
        "arch": routes.arch,
        "experts": routes.experts,
        "used": routes.used,
        "layers": routes.layer_count,
        "cache_bytes": routes.cache_bytes,
        "engine_quota": routes.quota,
        "tokens": baseline.tokens,
        "policies": [],
    }
    budget = routes.quota * sum(record_bytes)
    for result, policy in rows:
        used = policy.bytes_used(record_bytes)
        payload["policies"].append({
            "name": result.name,
            "hit_rate": result.hit_rate,
            "reads_per_token": result.reads_per_token,
            "reads_delta": result.reads_per_token - baseline.reads_per_token,
            "reads_delta_pct": (100.0 * (result.reads_per_token - baseline.reads_per_token)
                                / baseline.reads_per_token) if baseline.reads_per_token else 0.0,
            "bytes_used": used,
            "budget": budget,
            "over_budget": used > budget,
            "min_probation": policy.min_probation(),
            "quotas": policy.quotas,
            "layer_hit_rate": {str(layer): result.layer_hit_rate(layer)
                               for layer in result.layers} if per_layer else None,
            "layer_reads_per_token": {str(layer): result.layer_reads_per_token(layer)
                                      for layer in result.layers} if per_layer else None,
        })
    return payload


def print_report(payload: dict, per_layer: bool) -> None:
    print(f"=== {pathlib.Path(payload['routes']).name} ===")
    print(f"  {payload['arch']}, {payload['layers']} MoE layers, "
          f"{payload['experts']} experts, {payload['used']} used per token")
    print(f"  cache {payload['cache_bytes'] / 1e9:.2f} GB, engine quota "
          f"{payload['engine_quota']}/{payload['experts']}, "
          f"{payload['tokens']} generation tokens measured")
    print()
    header = (f"  {'policy':<34} {'hit rate':>9} {'reads/tok':>10} {'vs base':>9} "
              f"{'budget':>9} {'min prob':>9}")
    print(header)
    for row in payload["policies"]:
        fit = "OVER" if row["over_budget"] else f"{100.0 * row['bytes_used'] / row['budget']:.1f}%"
        print(f"  {row['name']:<34} {row['hit_rate'] * 100:8.2f}% "
              f"{row['reads_per_token']:10.2f} {row['reads_delta_pct']:+8.1f}% "
              f"{fit:>9} {row['min_probation']:9d}")
    print("  vs base  = change in records reaching the SSD per token, negative is better")
    print("  budget   = arena bytes used over the arena bytes the uniform quota buys")
    print("  min prob = smallest probation segment, the engine's micro-batch bound")
    if not per_layer:
        return
    print()
    names = [row["name"] for row in payload["policies"]]
    print("  reads per token, layer by layer")
    line = f"  {'layer':>5}"
    for name in names:
        line += f" {name[:15]:>16}"
    print(line)
    layers = sorted(int(k) for k in payload["policies"][0]["layer_reads_per_token"])
    for layer in layers:
        line = f"  {layer:>5}"
        for row in payload["policies"]:
            line += f" {row['layer_reads_per_token'][str(layer)]:16.2f}"
        print(line)


# --------------------------------------------------------------------------


def build_policies(routes: Routes, steps: list[list[dict]], generation_steps: int,
                   wanted: list[str], allocation_files: list[str],
                   shapes: list[tuple[float, float]],
                   plan_files: list[str]) -> list[Policy]:
    record_bytes = routes.record_bytes()
    budget = routes.quota * sum(record_bytes)
    count = routes.layer_count
    # The probation segment of the uniform configuration is the engine's
    # micro-batch bound today. Every candidate keeps it, so no reallocation
    # can make a batch shape that ran yesterday throw, and the smallest quota
    # a layer may be cut to is that floor plus one protected slot.
    _, probation_floor = segment_split(routes.quota, routes.protected_fraction,
                                       routes.experts)
    floor = probation_floor + 1
    ceiling = routes.experts
    policies: list[Policy] = []

    if "slru" in wanted:
        policies.append(Policy("slru uniform (engine)", [routes.quota] * count, routes))
    if "lfu-victim" in wanted:
        policies.append(Policy("slru uniform, lfu victim", [routes.quota] * count,
                               routes, victim="lfu", decay_period=4096))
    if "tinylfu" in wanted:
        bypass = max(1, routes.used)
        policies.append(Policy(f"slru uniform, tinylfu w{bypass}", [routes.quota] * count,
                               routes, admission="tinylfu", bypass_quota=bypass,
                               decay_period=4096,
                               overhead_bytes=count * routes.experts * 2))
    if "shaped" in wanted:
        for amplitude, span in shapes:
            quotas = shaped_allocation(
                routes, record_bytes, budget, floor, ceiling,
                lambda index, total, a=amplitude, s=span: head_weight(index, a, s))
            policies.append(Policy(f"slru shaped a{amplitude:g} s{span:g}", quotas,
                                   routes, probation_floor=probation_floor))
    if "optimal" in wanted:
        curves = miss_curves(routes, steps, generation_steps, ceiling, probation_floor)
        quotas = greedy_allocation(curves, record_bytes, routes.first_layer,
                                   budget, floor, ceiling)
        policies.append(Policy("slru optimal on this trace", quotas, routes,
                               probation_floor=probation_floor))
    for path in plan_files:
        # Exactly what the engine does at startup: read the curves the plan
        # carries, then spend THIS machine's budget against them.
        curves = read_plan_curves(pathlib.Path(path), routes.first_layer)
        quotas = greedy_allocation(curves, record_bytes, routes.first_layer,
                                   budget, floor, ceiling)
        policies.append(Policy(f"plan {pathlib.Path(path).stem}", quotas, routes,
                               probation_floor=probation_floor))
    for path in allocation_files:
        loaded = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
        if len(loaded["quotas"]) != count:
            raise SystemExit(f"ECHEC: {path} holds {len(loaded['quotas'])} layers, "
                             f"the trace has {count}")
        # Read as a SHAPE, not as slot counts: the file was calibrated at
        # whatever budget its own run had, and the point of replaying it here
        # is to see whether the shape survives a different budget and a
        # different prompt.
        weights = weights_of(loaded["quotas"], loaded.get("record_bytes", record_bytes))
        quotas = shaped_allocation(routes, record_bytes, budget, floor, ceiling,
                                   lambda index, total, w=weights: w[index])
        policies.append(Policy(f"slru shaped by {pathlib.Path(path).stem[:18]}",
                               quotas, routes, probation_floor=probation_floor))
    return policies


def sweep(routes: Routes, steps: list[list[dict]], generation_steps: int,
          plan_path: str | None, quotas: list[int]) -> dict:
    """The comparison that decides, taken across the whole quota range.

    WHY A SWEEP AND NOT A NUMBER

    The product is throughput on a machine that does not have the RAM. At a
    quota where the whole model fits, no eviction ever happens and no cache
    policy can change anything; at a quota where almost nothing fits, every
    eviction is paid for immediately in a device read. A policy judged on one
    configuration, or on an average over configurations, is judged mostly on
    the regime where it cannot matter. So every candidate is replayed at every
    quota from the smallest one that can run to full residency, and the row
    that decides is the smallest quota, not the mean.

    WHAT COUNTS AS BUDGET

    The budget of a row is the arena its uniform quota buys, and every
    candidate on that row gets the same number of bytes. Memory a policy takes
    for its own bookkeeping is subtracted from that budget before it is
    allocated, in whole slots, because at four slots per layer a policy that
    quietly keeps a table on the side is spending cache.
    """
    record_bytes = routes.record_bytes()
    per_layer_bytes = sum(record_bytes)
    curves = read_plan_curves(pathlib.Path(plan_path), routes.first_layer) if plan_path else None
    # One exact count per (layer, expert), two bytes each. No sketch: the key
    # space of this cache is the expert count of one layer, a hundred odd
    # entries, not the millions a web cache faces, so the approximation a
    # count min sketch buys would cost accuracy and save nothing.
    counter_bytes = routes.layer_count * routes.experts * 2
    rows = []
    for quota in quotas:
        budget = quota * per_layer_bytes
        # THE PROBATION FLOOR, and why it is what the engine uses and not
        # something convenient. The engine bounds a micro-batch by the smaller
        # of a layer's quota and its probation segment. Two things push on it:
        # a batch needs at least `used` distinct experts resident at once, and
        # a reallocation must not shrink the bound the uniform quota already
        # provided, or a batch shape that ran yesterday throws today. The
        # floor is therefore the larger of the two, identical for every policy
        # on the row, and the smallest quota a layer may be cut to is that
        # plus one protected slot. Using anything smaller here would report
        # gains the engine cannot take.
        natural = segment_split(quota, routes.protected_fraction, routes.experts)[1]
        probation_floor = min(quota - 1, max(natural, routes.used))
        # CHARGED: the counter table comes out of the arena before a single
        # slot is allocated, so the policy runs on strictly less cache than
        # the baseline. The row budget is the tightest capacity that yields
        # this uniform quota, which is the worst case for the charge: a
        # capacity one byte above an exact multiple loses a whole slot per
        # layer to twelve kilobytes. Any real capacity has a remainder of
        # roughly half an arena row, so the charge normally comes out of that
        # and costs nothing, but the strict number is the one in the table.
        charged_quota = max(1, (budget - counter_bytes) // per_layer_bytes)
        charged_floor = (min(charged_quota - 1,
                             max(segment_split(int(charged_quota), routes.protected_fraction,
                                               routes.experts)[1], routes.used))
                         if charged_quota > 1 else 0)
        candidates: list[Policy] = [
            Policy("uniform slru", [quota] * routes.layer_count, routes,
                   probation_floor=probation_floor),
            Policy("uniform, freq victim", [quota] * routes.layer_count, routes,
                   victim="lfu", decay_period=4096, probation_floor=probation_floor,
                   overhead_bytes=counter_bytes),
        ]
        if curves is not None:
            floor = min(quota, probation_floor + 1)
            planned = greedy_allocation(curves, record_bytes, routes.first_layer,
                                        budget, floor, routes.experts)
            candidates.append(Policy("planned slru", planned, routes,
                                     probation_floor=probation_floor))
            # THE SHIPPED POLICY: both halves, and the counters outside the
            # arena, where they actually live. They sit in the per layer node
            # array the SLRU already allocates, four bytes wider per node, so
            # not one expert slot is lost and the arena does not move by a
            # byte. The next column is what it would cost if it did.
            candidates.append(Policy("planned + freq victim", planned, routes,
                                     victim="lfu", decay_period=4096,
                                     probation_floor=probation_floor,
                                     overhead_bytes=counter_bytes))
            if charged_quota >= 2:
                charged_budget = budget - counter_bytes
                planned_floor = min(int(charged_quota), charged_floor + 1)
                planned_charged = greedy_allocation(
                    curves, record_bytes, routes.first_layer, charged_budget,
                    planned_floor, routes.experts)
                candidates.append(Policy("same, charged to the arena", planned_charged,
                                         routes, victim="lfu", decay_period=4096,
                                         probation_floor=charged_floor,
                                         overhead_bytes=counter_bytes))
        row = {"quota": quota, "budget": budget, "policies": []}
        base_reads = None
        for policy in candidates:
            result = replay(routes, policy, steps, generation_steps)
            if base_reads is None:
                base_reads = result.reads_per_token
            row["policies"].append({
                "name": policy.name,
                "hit_rate": result.hit_rate,
                "reads_per_token": result.reads_per_token,
                "delta_pct": (100.0 * (result.reads_per_token - base_reads) / base_reads)
                             if base_reads else 0.0,
                "overhead_bytes": policy.overhead_bytes,
                "overhead_slots": policy.overhead_bytes / (per_layer_bytes / routes.layer_count),
                # Slot bytes only. The bookkeeping is reported beside the
                # table because it is not arena: it lives in the per layer
                # node array the SLRU already allocates. Folding it in here
                # would flag every frequency row as over budget and hide the
                # one thing this column is for, which is whether a policy
                # quietly gave itself more expert slots than the baseline.
                "bytes_used": sum(q * b for q, b in zip(policy.quotas, record_bytes)),
                "over_budget": sum(q * b for q, b in zip(policy.quotas,
                                                         record_bytes)) > budget,
            })
        rows.append(row)
    return {"routes": str(routes.path), "arch": routes.arch, "experts": routes.experts,
            "used": routes.used, "layers": routes.layer_count,
            "record_bytes": record_bytes[0], "plan": plan_path, "rows": rows}


def print_sweep(payload: dict) -> None:
    print(f"=== {pathlib.Path(payload['routes']).name} : quota sweep ===")
    print(f"  {payload['arch']}, {payload['layers']} MoE layers, {payload['experts']} "
          f"experts, {payload['used']} used per token, "
          f"{payload['record_bytes'] / 1e6:.2f} MB per record")
    print(f"  plan {payload['plan'] or 'none'}")
    print("  Read the FIRST rows. They are the machine that does not have the RAM,")
    print("  which is the one this is for. The last rows are full residency, where no")
    print("  cache policy can change anything and every candidate must tie.")
    print()
    names = [p["name"] for p in payload["rows"][0]["policies"]]
    header = f"  {'quota':>5} {'arena':>8}"
    for name in names:
        header += f" {name[:24]:>26}"
    print(header)
    print(f"  {'':>5} {'':>8}" + "".join(f" {'hit%   reads/tok  vs base':>26}" for _ in names))
    for row in payload["rows"]:
        line = f"  {row['quota']:>5} {row['budget'] / 1e9:7.1f}G"
        for policy in row["policies"]:
            flag = "!" if policy["over_budget"] else " "
            line += (f" {policy['hit_rate'] * 100:6.2f} {policy['reads_per_token']:9.2f} "
                     f"{policy['delta_pct']:+7.1f}%{flag}")
        print(line)
    print()
    print("  vs base = change in records reaching the SSD per token against the uniform")
    print("            slru of the SAME row, negative is better")
    print("  !       = this policy took more expert slots than the row's budget buys")
    for policy in payload["rows"][0]["policies"]:
        if policy["overhead_bytes"]:
            print(f"  {policy['name']}: {policy['overhead_bytes']} bytes of frequency "
                  f"counters, which is {policy['overhead_slots']:.4f} of ONE expert slot. "
                  f"They live in the per layer node array the SLRU already allocates, not "
                  f"in the arena, so no slot is lost. The last column is what it would "
                  f"cost if they were taken out of the arena at a capacity that is an "
                  f"exact multiple of one arena row, which is the worst case for the "
                  f"charge and loses a whole slot per layer to a few kilobytes.")
            break


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Replay real MoE routing traces through candidate cache policies.")
    ap.add_argument("--routes", required=True, help="a file written by GALACTUS_H4_ROUTES")
    ap.add_argument("--generation-steps", type=int, default=256,
                    help="how many trailing steps are the generation phase (default 256)")
    ap.add_argument("--policy", default="slru,shaped,optimal,lfu-victim,tinylfu",
                    help="comma separated: slru, shaped, optimal, lfu-victim, tinylfu")
    ap.add_argument("--allocation", action="append", default=[],
                    help="also replay the SHAPE of an allocation read from a JSON file, "
                         "rescaled to this trace's budget. May be repeated")
    ap.add_argument("--shape", action="append", default=[],
                    help="a closed form shape as amplitude:span, may be repeated "
                         "(default 1:2, 1:4, 1:8)")
    ap.add_argument("--emit-allocation", default=None,
                    help="write the trace optimal allocation to a JSON file")
    ap.add_argument("--plan", action="append", default=[],
                    help="a plan written by scripts/derive-cache-plan.py, allocated at "
                         "this trace's budget exactly as the engine does. May be repeated")
    ap.add_argument("--sweep", action="store_true",
                    help="replay every candidate at every quota from the smallest that "
                         "runs to full residency. This is the comparison that decides")
    ap.add_argument("--sweep-quotas", default=None,
                    help="comma separated quotas for --sweep (default: logarithmic)")
    ap.add_argument("--verify", action="store_true",
                    help="check the baseline against the residency bits the engine recorded")
    ap.add_argument("--per-layer", action="store_true", help="add the layer by layer table")
    ap.add_argument("--json", action="store_true", help="machine readable output")
    args = ap.parse_args()

    routes = Routes(pathlib.Path(args.routes))
    if not routes.entries:
        print(f"ECHEC: no entries in {args.routes}", file=sys.stderr)
        return 2
    steps = steps_of(routes)
    if args.generation_steps >= len(steps):
        print(f"ECHEC: {len(steps)} steps in {routes.path.name}, which is not more than "
              f"the {args.generation_steps} asked for", file=sys.stderr)
        return 2

    if args.verify:
        checked, device_bytes = verify_baseline(routes, steps)
        if not args.json:
            print(f"baseline verified against {checked} recorded residency bits and "
                  f"against {device_bytes} bytes the reader really pulled\n")

    if args.sweep:
        floor = smallest_viable_quota(routes, routes.used)
        quotas = ([int(v) for v in args.sweep_quotas.split(",")] if args.sweep_quotas
                  else sweep_quotas(routes, floor))
        too_small = [q for q in quotas if q < floor]
        if too_small:
            print(f"ECHEC: quota {too_small} cannot run on this model: {routes.used} "
                  f"experts must be resident at once, so the smallest quota that "
                  f"computes a token is {floor}", file=sys.stderr)
            return 2
        payload = sweep(routes, steps, args.generation_steps,
                        args.plan[0] if args.plan else None, quotas)
        if args.json:
            print(json.dumps(payload, indent=2))
        else:
            print_sweep(payload)
        return 0

    wanted = [name.strip() for name in args.policy.split(",") if name.strip()]
    if args.emit_allocation and "optimal" not in wanted:
        wanted.append("optimal")
    shapes = [(1.0, 2.0), (1.0, 4.0), (1.0, 8.0)]
    if args.shape:
        shapes = []
        for text in args.shape:
            amplitude, _, span = text.partition(":")
            shapes.append((float(amplitude), float(span)))
    policies = build_policies(routes, steps, args.generation_steps, wanted,
                              args.allocation, shapes, args.plan)
    if not policies:
        print("ECHEC: no policy selected", file=sys.stderr)
        return 2

    results = [(replay(routes, policy, steps, args.generation_steps), policy)
               for policy in policies]
    baseline = results[0][0]
    payload = summarise(routes, routes.record_bytes(), baseline, results, args.per_layer)

    if args.emit_allocation:
        for result, policy in results:
            if policy.name.startswith("slru optimal"):
                pathlib.Path(args.emit_allocation).write_text(json.dumps({
                    "source": str(routes.path),
                    "arch": routes.arch,
                    "first_layer": routes.first_layer,
                    "experts": routes.experts,
                    "uniform_quota": routes.quota,
                    "record_bytes": routes.record_bytes(),
                    "quotas": policy.quotas,
                }, indent=2) + "\n", encoding="utf-8")
                break

    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print_report(payload, args.per_layer)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
