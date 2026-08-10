#!/usr/bin/env python3
"""The C++ slot allocator must agree with the Python one, place for place.

WHY THIS TEST EXISTS

Every number published about the non uniform quota came from the Python
allocator in scripts/replay-cache.py, replayed against real routing traces.
The engine runs a C++ allocator instead, because the budget is only known when
the store is built. Two implementations of one rule drift; when this one
drifts, the engine stops being the thing that was measured and no reader could
tell. So the C++ allocator is run against the same plans, at several budgets,
and a single slot of disagreement fails the test.

WHAT IS COMPARED

The whole allocation, layer by layer, plus the bytes it spends. Not a summary:
a checksum of the two vectors would hide which layer moved, and which layer
moved is the entire subject.

The probe binary comes from the build:
  GALACTUS_CACHE_PLAN_PROBE=<path to galactus-h4-cache-plan-probe>
"""
from __future__ import annotations

import importlib.util
import os
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
PLANS = ROOT / "cache-plans"

_SPEC = importlib.util.spec_from_file_location(
    "galactus_replay_cache", ROOT / "scripts" / "replay-cache.py")
replay_cache = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(replay_cache)


def read_plan(path: pathlib.Path) -> dict:
    """The same file the engine reads, parsed the same way."""
    plan = {"curves": [], "experts": 0, "first_layer": 0, "last_layer": 0}
    for line in path.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if not parts:
            continue
        if parts[0] in ("first_layer", "last_layer", "experts", "used"):
            plan[parts[0]] = int(parts[1])
        elif parts[0] == "curve":
            plan["curves"].append([int(v) for v in parts[2:]])
    return plan


def probe(binary: str, plan_path: pathlib.Path, record_bytes: int, budget: int,
          floor: int, ceiling: int) -> tuple[list[int], int]:
    result = subprocess.run(
        [binary, "--plan", str(plan_path), "--record-bytes", str(record_bytes),
         "--budget", str(budget), "--floor", str(floor), "--ceiling", str(ceiling)],
        capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise SystemExit(f"ECHEC: the probe failed on {plan_path.name}: {result.stderr}")
    quotas: list[int] = []
    spent = 0
    for line in result.stdout.splitlines():
        parts = line.split()
        if parts[0] == "quota":
            quotas.append(int(parts[2]))
        elif parts[0] == "bytes":
            spent = int(parts[1])
    return quotas, spent


def test_engine_wiring(replay_binary: str) -> list[str]:
    """The plan must reach the cache, and one variable must send it back.

    The allocator agreeing with Python proves nothing if the engine never asks
    it anything. This runs the real ExpertCache twice on the real qwen3
    profile, once with the plan and once with GALACTUS_H4_CACHE_POLICY=uniform,
    and checks that the first reallocates, that the second is the policy that
    shipped before this work, and that neither asks for one byte more of arena
    than the uniform quota buys.
    """
    problems: list[str] = []
    profile = ROOT / "models" / "qwen3-30b-a3b" / "profile.engine.txt"
    plan = PLANS / "qwen3moe.txt"
    if not profile.exists() or not plan.exists():
        return [f"missing {profile} or {plan}"]
    # The replay binary wants a trace directory. An empty one is enough here:
    # what is under test is what the cache decides at construction, before a
    # single key is replayed.
    empty = pathlib.Path(tempfile.mkdtemp(prefix="galactus-cache-plan-"))
    capacity = "9071259188"

    def run(extra: dict[str, str]) -> str:
        env = dict(os.environ)
        env["GALACTUS_PROFILE"] = str(profile)
        env["GALACTUS_H4_CACHE_PLAN"] = str(plan)
        env.update(extra)
        result = subprocess.run(
            [replay_binary, "--trace-directory", str(empty),
             "--capacity-bytes", capacity],
            capture_output=True, text=True, check=False, env=env)
        if result.returncode != 0:
            problems.append(f"the cache replay binary failed: {result.stderr}")
            return ""
        return result.stdout + result.stderr

    planned = run({})
    uniform = run({"GALACTUS_H4_CACHE_POLICY": "uniform"})
    if not planned or not uniform:
        return problems
    if "plan actif" not in planned:
        problems.append("with a plan present the cache did not apply it:\n" + planned)
    if "plan absent" not in uniform:
        problems.append("GALACTUS_H4_CACHE_POLICY=uniform did not disable the plan:\n"
                        + uniform)
    if "couche 0 a 37 places" not in uniform:
        problems.append("forced uniform must give layer 0 the uniform quota of 37:\n"
                        + uniform)
    if "couche 0 a 37 places" in planned:
        problems.append("the plan left layer 0 at the uniform quota, so nothing moved:\n"
                        + planned)
    # The arena is the thing that must not grow. The line reports what the
    # allocation spends and what it was allowed to spend; they have to match
    # the uniform arena exactly.
    #
    # The arena the uniform quota buys is computed HERE, from the profile and
    # the capacity, and not read back from the line the cache prints. A cache
    # that quietly gave itself a bigger budget would print a spend and a
    # budget that agree with each other and with nothing else.
    records = [int(line.split()[3]) for line in
               profile.read_text(encoding="utf-8").splitlines()
               if line.startswith("layer ")]
    uniform_quota = int(capacity) // sum(records)
    uniform_arena = uniform_quota * sum(records)
    spend = re.search(r"(\d+) octets sur (\d+)", planned)
    if spend is None:
        problems.append("the cache never said what the plan spends")
    else:
        if int(spend.group(1)) > uniform_arena:
            problems.append(f"the plan spends {spend.group(1)} bytes of arena where the "
                            f"uniform quota of {uniform_quota} buys {uniform_arena}")
        if int(spend.group(2)) != uniform_arena:
            problems.append(f"the allocator was handed a budget of {spend.group(2)} bytes "
                            f"where the uniform quota of {uniform_quota} buys "
                            f"{uniform_arena}")
    return problems



ROUTES = ROOT / "artifacts" / "h4" / "routes"
PLAN_FOR_ARCH = {"qwen3moe": "qwen3moe.txt", "phimoe": "phimoe.txt", "olmoe": "olmoe.txt"}
PROFILE_FOR_ARCH = {"qwen3moe": "qwen3-30b-a3b", "phimoe": "phi35-moe", "olmoe": "olmoe-1b-7b"}


def python_hits(routes, steps, plan_path: pathlib.Path | None, capacity: int,
                use_plan: bool, frequency: bool) -> tuple[int, int]:
    """What the Python replay says the engine should do, at this capacity.

    Every step here mirrors src/h4/h4-expert-cache.cpp in order: the uniform
    quota comes from the capacity, the probation floor is raised to `used` when
    the new policy is on, the plan spends the arena the uniform quota buys, and
    the frequency victim is off in full residency because no eviction ever
    happens there.
    """
    record_bytes = routes.record_bytes()
    per_layer = sum(record_bytes)
    quota = min(capacity // per_layer, routes.experts)
    natural = replay_cache.segment_split(quota, routes.protected_fraction,
                                         routes.experts)[1]
    floor_probation = natural
    if (use_plan or frequency) and quota < routes.experts and natural < routes.used:
        floor_probation = min(quota - 1, routes.used)
    quotas = [quota] * routes.layer_count
    if use_plan and plan_path is not None and quota < routes.experts:
        curves = replay_cache.read_plan_curves(plan_path, routes.first_layer)
        quotas = replay_cache.greedy_allocation(
            curves, record_bytes, routes.first_layer, quota * per_layer,
            floor_probation + 1, routes.experts)
    victim = "lfu" if (frequency and quota < routes.experts) else "lru"
    policy = replay_cache.Policy("x", quotas, routes, victim=victim,
                                 decay_period=4096, probation_floor=floor_probation)
    result = replay_cache.replay(routes, policy, steps, 256)
    return result.total_hits, result.total_accesses


def test_policy_differential(replay_binary: str) -> list[str]:
    """The C++ cache and the Python replay, key for key, on every real trace.

    The allocator differential above proves the two agree on how many slots a
    layer gets. It says nothing about what the cache then DOES with them, and
    the frequency victim is a change to exactly that. This replays every
    recorded trace through the real ExpertCache under all four values of
    GALACTUS_H4_CACHE_POLICY and compares the hit count to the simulation that
    produced every published number. One hit of disagreement fails.
    """
    problems: list[str] = []
    combinations = {"uniform": (False, False), "plan": (True, False),
                    "frequency": (False, True), "auto": (True, True)}
    traces = sorted(ROUTES.glob("*.routes"))
    if not traces:
        return [f"no trace under {ROUTES}: this differential has nothing to run on"]
    checked = 0
    for trace in traces:
        routes = replay_cache.Routes(trace)
        steps = replay_cache.steps_of(routes)
        plan_name = PLAN_FOR_ARCH.get(routes.arch)
        profile_name = PROFILE_FOR_ARCH.get(routes.arch)
        if plan_name is None or profile_name is None:
            problems.append(f"{trace.name}: no plan or profile known for arch {routes.arch}")
            continue
        plan_path = PLANS / plan_name
        profile = ROOT / "models" / profile_name / "profile.engine.txt"
        if not profile.is_file():
            problems.append(f"{profile} is missing")
            continue
        # Two capacities. The one the trace was recorded at, and the smallest
        # one that can compute a token at all: `used` experts must be resident
        # at once, so the arena of used+1 slots per layer is the bottom of the
        # curve and the regime the product is for. The two disagree about more
        # than a quota, because at the bottom the probation floor is what makes
        # the configuration runnable at all.
        capacities = [routes.cache_bytes,
                      (routes.used + 1) * sum(routes.record_bytes())]
        for capacity in capacities:
            for name, (use_plan, frequency) in combinations.items():
                env = dict(os.environ)
                env["GALACTUS_PROFILE"] = str(profile)
                env["GALACTUS_H4_CACHE_PLAN"] = str(plan_path)
                env["GALACTUS_H4_CACHE_POLICY"] = name
                result = subprocess.run(
                    [replay_binary, "--routes", str(trace),
                     "--capacity-bytes", str(capacity)],
                    capture_output=True, text=True, check=False, env=env)
                label = f"{trace.name} at {capacity} bytes under policy {name}"
                if result.returncode != 0:
                    problems.append(f"{label}: {result.stderr}")
                    continue
                got = re.search(r"hits (\d+) accesses (\d+)", result.stdout)
                if got is None:
                    problems.append(f"{label}: no result line")
                    continue
                want_hits, want_accesses = python_hits(
                    routes, steps, plan_path, capacity, use_plan, frequency)
                checked += 1
                if int(got.group(2)) != want_accesses:
                    problems.append(f"{label}: the engine saw {got.group(2)} accesses, "
                                    f"the replay {want_accesses}")
                if int(got.group(1)) != want_hits:
                    problems.append(f"{label}: the engine hit {got.group(1)} times, "
                                    f"the replay {want_hits} "
                                    f"({int(got.group(1)) - want_hits:+d})")
    if not problems and checked == 0:
        problems.append("nothing was compared")
    return problems


def main() -> int:
    binary = os.environ.get("GALACTUS_CACHE_PLAN_PROBE")
    if not binary or not pathlib.Path(binary).exists():
        print("ECHEC: GALACTUS_CACHE_PLAN_PROBE is not set to an existing binary",
              file=sys.stderr)
        return 2
    plans = sorted(PLANS.glob("*.txt"))
    if not plans:
        print(f"ECHEC: no plan under {PLANS}. This test compares two allocators on "
              f"real plans; with none there is nothing to compare and passing would "
              f"mean nothing.", file=sys.stderr)
        return 2

    cases = 0
    for plan_path in plans:
        plan = read_plan(plan_path)
        curves = {plan["first_layer"] + i: row for i, row in enumerate(plan["curves"])}
        count = len(plan["curves"])
        record_bytes = 5_013_504
        records = [record_bytes] * count
        ceiling = plan["experts"]
        # Several budgets, because the allocator's whole point is that it
        # answers differently on a small machine and on a large one, and an
        # agreement at one budget says nothing about the other.
        for uniform in (max(3, ceiling // 8), ceiling // 4, ceiling // 2,
                        max(3, (ceiling * 3) // 4)):
            budget = uniform * record_bytes * count
            floor = min(uniform, max(2, uniform // 2))
            expected = replay_cache.greedy_allocation(
                curves, records, plan["first_layer"], budget, floor, ceiling)
            got, spent = probe(binary, plan_path, record_bytes, budget, floor, ceiling)
            cases += 1
            if got != expected:
                for layer, (a, b) in enumerate(zip(got, expected)):
                    if a != b:
                        print(f"ECHEC: {plan_path.name}, uniform quota {uniform}: the C++ "
                              f"allocator gives layer {layer + plan['first_layer']} {a} "
                              f"slots, the Python allocator gives {b}", file=sys.stderr)
                        return 1
                print(f"ECHEC: {plan_path.name}: allocations of different length "
                      f"({len(got)} against {len(expected)})", file=sys.stderr)
                return 1
            if spent > budget:
                print(f"ECHEC: {plan_path.name}, uniform quota {uniform}: the allocation "
                      f"spends {spent} bytes for a budget of {budget}", file=sys.stderr)
                return 1
            if min(got) < floor or max(got) > ceiling:
                print(f"ECHEC: {plan_path.name}, uniform quota {uniform}: allocation "
                      f"outside [{floor}, {ceiling}] ({min(got)}..{max(got)})",
                      file=sys.stderr)
                return 1
    replay_binary = os.environ.get("GALACTUS_EXPERT_CACHE_REPLAY")
    if not replay_binary or not pathlib.Path(replay_binary).exists():
        print("ECHEC: GALACTUS_EXPERT_CACHE_REPLAY is not set to an existing binary. "
              "Without it the allocator is compared to Python but never shown to reach "
              "the engine, which is the half that matters.", file=sys.stderr)
        return 2
    problems = test_engine_wiring(replay_binary) + test_policy_differential(replay_binary)
    if problems:
        for problem in problems:
            print(f"ECHEC: {problem}", file=sys.stderr)
        return 1
    print(f"OK: {len(plans)} plan(s), {cases} budgets, the two allocators agree slot "
          f"for slot, the engine and the replay agree hit for hit on every trace "
          f"under every policy, and one variable sends the engine back to the one "
          f"that shipped before")
    return 0


if __name__ == "__main__":
    sys.exit(main())
