#!/usr/bin/env python3
"""The replay harness must reproduce the engine, not resemble it.

WHAT THIS PINS

scripts/replay-cache.py is the instrument every cache policy decision rests
on. If it drifts from the engine, the decisions rest on nothing, and it would
drift silently because a plausible hit rate looks exactly like a correct one.

Three properties, each of which has to be able to fail on its own:

  1. The replayed baseline agrees with the residency bit the engine recorded
     for every single id of a real trace.
  2. The replayed baseline reads exactly as many bytes as the reader really
     pulled from the device on that run. This is a different statement from
     the first: the engine samples residency for a whole micro-batch before
     serving any of it, and serving one key can evict a key that appears later
     in the same batch, so a key sampled resident can still be read. Only the
     byte counter says what the device saw.
  3. A hand written access sequence lands where an SLRU is supposed to land,
     with no trace involved, so a harness that has learned to agree with a
     trace by accident still fails here.

And one property of the allocator: it never spends more than the budget and
never puts a layer outside the floor and ceiling it was given.
"""
from __future__ import annotations

import importlib.util
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
ROUTES = ROOT / "artifacts" / "h4" / "routes"

_SPEC = importlib.util.spec_from_file_location(
    "galactus_replay_cache", ROOT / "scripts" / "replay-cache.py")
rc = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(rc)

FAILURES: list[str] = []


def check(condition: bool, message: str) -> None:
    if not condition:
        FAILURES.append(message)


def test_against_real_traces() -> int:
    traces = sorted(ROUTES.glob("*.routes"))
    if not traces:
        FAILURES.append(f"no trace under {ROUTES}: this test compares the harness to "
                        f"real recorded runs, and with none of them it proves nothing")
        return 0
    for path in traces:
        routes = rc.Routes(path)
        if not routes.entries:
            FAILURES.append(f"{path.name} holds no entry")
            continue
        steps = rc.steps_of(routes)
        try:
            checked, device_bytes = rc.verify_baseline(routes, steps)
        except SystemExit as error:
            FAILURES.append(f"{path.name}: {error}")
            continue
        check(checked > 0, f"{path.name}: nothing was checked")
        check(device_bytes > 0, f"{path.name}: the engine recorded no device read")
    return len(traces)


def test_slru_by_hand() -> None:
    """Two segments, promotion on the second access, eviction from probation.

    quota 4 with a protected fraction of 0.5 gives 2 protected and 2 in
    probation. The sequence is chosen so that every branch of the policy fires
    once and the answer can be worked out on paper.
    """
    layer = rc.LayerSlru(4, 0.5, experts=64)
    check(layer.protected_quota == 2 and layer.probation_quota == 2,
          f"segments of a quota 4 cache at 0.5: got {layer.protected_quota} protected "
          f"and {layer.probation_quota} in probation, expected 2 and 2")

    # First touch of anything is a miss and lands in probation.
    check(layer.access(1) is False, "the first access to expert 1 should be a miss")
    check(layer.access(2) is False, "the first access to expert 2 should be a miss")
    # Second touch promotes into protected and is a hit.
    check(layer.access(1) is True, "the second access to expert 1 should be a hit")
    check(1 in layer.protected, "expert 1 should be protected after two accesses")
    # Probation holds only 2. Admitting 3 and 4 pushes 2 out, oldest first.
    check(layer.access(3) is False, "expert 3 is new")
    check(layer.access(4) is False, "expert 4 is new")
    check(layer.resident(2) is False,
          "expert 2 should have been evicted from the head of probation")
    check(layer.resident(1) is True, "a protected expert must survive probation pressure")
    # Protected holds only 2. Promoting 3 and 4 demotes 1 back to probation.
    check(layer.access(3) is True, "expert 3 is in probation, so this is a hit")
    check(layer.access(4) is True, "expert 4 is in probation, so this is a hit")
    check(1 in layer.probation,
          "expert 1 should have been demoted to probation by the two promotions")
    check(sum((len(layer.protected), len(layer.probation))) <= 4,
          f"a quota 4 layer holds {len(layer.protected)} + {len(layer.probation)} keys")


def test_probation_floor_is_never_lowered() -> None:
    """A reallocated layer must keep the micro-batch bound it had.

    The engine refuses a micro-batch with more distinct experts than the
    probation segment. Shrinking a layer without this floor shrinks that bound
    with it, and a batch shape that ran yesterday throws today.
    """
    uniform_protected, uniform_probation = rc.segment_split(37, 0.75, 128)
    check((uniform_protected, uniform_probation) == (27, 10),
          f"the shipped split of quota 37 at 0.75 is 27 and 10, got "
          f"{uniform_protected} and {uniform_probation}")
    for quota in range(uniform_probation + 1, 129):
        _, probation = rc.segment_split(quota, 0.75, 128, uniform_probation)
        check(probation >= uniform_probation,
              f"quota {quota} with a floor of {uniform_probation} gives a probation "
              f"segment of {probation}")
    # With no floor asked for, the formula must be the shipped one, untouched.
    check(rc.segment_split(20, 0.75, 128) == (15, 5),
          f"the unfloored split of quota 20 at 0.75 must stay (15, 5), got "
          f"{rc.segment_split(20, 0.75, 128)}")


def test_allocator_respects_its_budget() -> None:
    """Two synthetic models, because one of them cannot pin both properties.

    STARVED: every layer's curve keeps paying all the way to the ceiling, so
    an allocator that forgot its budget would take every slot on offer and
    overspend by a wide margin. This is the case that makes the budget check
    mean something.

    ONE PAYER: a single layer has anything to gain and the rest are flat, so
    the slots have exactly one place to go. This is the case that shows the
    allocator sends them there and does not spread them evenly out of habit.
    """
    count = 8
    experts = 32
    records = [1_000_000] * count
    uniform = 8
    budget = uniform * sum(records)
    floor = 4

    starved = {layer: [max(0, 4000 - 100 * q) for q in range(experts + 1)]
               for layer in range(count)}
    quotas = rc.greedy_allocation(starved, records, 0, budget, floor, experts)
    spent = sum(q * b for q, b in zip(quotas, records))
    check(spent <= budget,
          f"every layer wants every slot and the allocation spends {spent} for a "
          f"budget of {budget}: {quotas}")
    check(min(quotas) >= floor, f"a layer fell below the floor: {quotas}")
    check(max(quotas) <= experts, f"a layer went above the ceiling: {quotas}")

    one_payer = {layer: ([max(0, 1000 - 30 * q) for q in range(experts + 1)]
                         if layer == 3 else [500] * (experts + 1))
                 for layer in range(count)}
    quotas = rc.greedy_allocation(one_payer, records, 0, budget, floor, experts)
    spent = sum(q * b for q, b in zip(quotas, records))
    check(spent <= budget, f"the allocation spends {spent} for a budget of {budget}")
    check(quotas[3] == max(quotas) and quotas[3] > uniform,
          f"the only layer whose curve pays should have taken the slots: {quotas}")
    check(all(q == floor for i, q in enumerate(quotas) if i != 3),
          f"a flat layer took slots it cannot use: {quotas}")

    # STEEPEST FIRST. Two layers pay, one three times better than the other,
    # and there is not enough budget for both. An allocator that took the
    # first candidate it found rather than the best one would fill layer 1,
    # and the whole point of the allocator is that it does not.
    two_payers = {layer: [500] * (experts + 1) for layer in range(count)}
    two_payers[1] = [max(0, 900 - 10 * q) for q in range(experts + 1)]
    two_payers[6] = [max(0, 900 - 30 * q) for q in range(experts + 1)]
    tight = (floor * count + 8) * records[0]
    quotas = rc.greedy_allocation(two_payers, records, 0, tight, floor, experts)
    check(quotas[6] > quotas[1],
          f"the steeper layer 6 should be served before the shallower layer 1: {quotas}")


def main() -> int:
    traces = test_against_real_traces()
    test_slru_by_hand()
    test_probation_floor_is_never_lowered()
    test_allocator_respects_its_budget()
    if FAILURES:
        for message in FAILURES:
            print(f"ECHEC: {message}", file=sys.stderr)
        return 1
    print(f"OK: {traces} real trace(s) reproduced to the byte, the SLRU lands where it "
          f"should by hand, the probation floor holds, the allocator stays in budget")
    return 0


if __name__ == "__main__":
    sys.exit(main())
