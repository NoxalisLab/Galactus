#!/usr/bin/env python3
"""Turn a recorded route trace into a cache plan the engine can read.

WHAT A PLAN IS, AND WHY IT IS A CURVE AND NOT A SLOT COUNT

The expert cache gives every MoE layer the same number of slots. The layers
are not the same: on qwen3-30b-a3b, layer 0 serves 45.7 percent of its
accesses from RAM and layer 10 serves 84.3 percent, so a slot handed to layer
0 removes several times more device reads than the same slot handed to layer
10. Distributing a scarce resource uniformly when the need varies that much
leaves throughput on the table.

The arena is laid out once, before the first token: layer L's expert tensors
are 3D views whose ne[2] is that layer's slot count, at a fixed address. No
online scheme can move a slot from one layer to another. So the allocation has
to be decided from something known before the run.

What a run can be told in advance is how each layer's miss count falls as its
quota grows. That curve is a property of the MODEL, not of the machine and not
of the budget: routing is bit exact and does not depend on the cache, so the
same trace answers the question at every quota at once. This script measures
that curve, layer by layer, from a trace the engine already wrote, and stores
it. The engine then runs the allocator itself, at startup, against the budget
the machine actually has, which is the part a stored slot count could never
get right.

HOW MUCH IT IS WORTH, measured by scripts/replay-cache.py on real traces
(records reaching the SSD per token, against the uniform quota, same arena
bytes to the byte):

  qwen3-30b-a3b  9.1 GB   58.29 -> 55.47   -4.8 %   curve from another prompt
  qwen3-30b-a3b 16.8 GB   11.71 ->  9.21  -21.4 %   curve from another prompt
  phi35-moe     16.8 GB    5.31 ->  4.08  -23.1 %   curve from another budget
  olmoe-1b-7b    1.9 GB   26.22 -> 21.23  -19.0 %   curve from its own trace

Usage:
  python3 scripts/derive-cache-plan.py --routes <file>.routes --out cache-plan.txt
"""
from __future__ import annotations

import argparse
import importlib.util
import pathlib
import sys

# One implementation of the miss curve, not two. replay-cache.py is the tool
# that measured every number in the docstring above, and a plan derived by a
# second copy of that code would be a plan nobody validated. The file name
# carries a dash, so it is loaded by path rather than imported by name.
_SPEC = importlib.util.spec_from_file_location(
    "galactus_replay_cache", pathlib.Path(__file__).with_name("replay-cache.py"))
replay_cache = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(replay_cache)

PLAN_MAGIC = "galactus-cache-plan"
PLAN_VERSION = 1


def derive(routes_path: pathlib.Path, generation_steps: int) -> str:
    routes = replay_cache.Routes(routes_path)
    if not routes.entries:
        raise SystemExit(f"ECHEC: no entries in {routes_path}")
    steps = replay_cache.steps_of(routes)
    if generation_steps >= len(steps):
        raise SystemExit(f"ECHEC: {len(steps)} steps in {routes_path.name}, which is not "
                         f"more than the {generation_steps} asked for")
    # The plan must describe the policy the engine will actually run, so the
    # curves are measured with the same probation floor the engine holds when
    # it reallocates.
    _, probation_floor = replay_cache.segment_split(
        routes.quota, routes.protected_fraction, routes.experts)
    curves = replay_cache.miss_curves(routes, steps, generation_steps,
                                      routes.experts, probation_floor)

    lines = [f"{PLAN_MAGIC} {PLAN_VERSION}",
             f"arch {routes.arch}",
             f"first_layer {routes.first_layer}",
             f"last_layer {routes.last_layer}",
             f"experts {routes.experts}",
             f"used {routes.used}",
             f"source {routes_path.name}",
             f"tokens {generation_steps}"]
    # An SLRU is not a stack algorithm, so a bigger quota can cost MORE misses
    # on a given trace. Those inversions are a real measurement of a real
    # policy and are written down as measured: smoothing them here would hand
    # the allocator a curve nobody observed. The allocator answers them with a
    # concave envelope, which is why they are counted and reported rather than
    # treated as an error.
    inversions = 0
    worst = 0
    for layer in range(routes.first_layer, routes.last_layer + 1):
        row = curves.get(layer)
        if row is None:
            raise SystemExit(f"ECHEC: layer {layer} never appears in {routes_path.name}")
        # Quota 0 and 1 are not reachable (the engine refuses a quota below 2),
        # but the curve is written from 0 so the index IS the quota and the
        # reader needs no offset arithmetic to get that wrong.
        values = [row[2]] * 2 + row[2:]
        for index in range(1, len(values)):
            if values[index] > values[index - 1]:
                inversions += 1
                worst = max(worst, values[index] - values[index - 1])
        lines.append(f"curve {layer} " + " ".join(str(v) for v in values))
    lines.append("end")
    total = routes.layer_count * routes.experts
    print(f"{inversions} of {total} curve steps go the wrong way (worst {worst} misses), "
          f"which is what a non stack policy does and what the concave envelope is for",
          file=sys.stderr)
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Derive an expert cache plan from a recorded route trace.")
    ap.add_argument("--routes", required=True, help="a file written by GALACTUS_H4_ROUTES")
    ap.add_argument("--out", required=True, help="where to write the plan")
    ap.add_argument("--generation-steps", type=int, default=256,
                    help="how many trailing steps are the generation phase (default 256)")
    args = ap.parse_args()
    text = derive(pathlib.Path(args.routes), args.generation_steps)
    pathlib.Path(args.out).write_text(text, encoding="utf-8")
    print(f"plan written to {args.out} ({len(text)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
