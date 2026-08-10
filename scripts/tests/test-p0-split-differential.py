#!/usr/bin/env python3
"""Differential: the packer and the engine must cut every record identically.

WHAT THIS PROVES

A dual pack cuts every record at round(blocks * ratio) blocks, ties to even.
The packer computes that number in Python and writes the bytes; the engine
recomputes it in C++ and reads them back. If the two disagree by one 16 KiB
block on one record, the engine reads that record's tail from the wrong offset
on one of the two volumes, and the model produces plausible garbage. No test
that exercises only one side can see that.

So this runs BOTH. scripts/galactus-pack-plan.py's internal_blocks() is
imported directly, the C++ plan_p0_split is reached through
galactus-h4-split-probe, and every (record size, ratio) pair must produce the
same internal_bytes on both sides.

WHERE THE TWO IMPLEMENTATIONS CAN DIVERGE, AND WHY THE CASES BELOW EXIST

  1. Ties. Python round() is half-to-even; C round() is half-away-from-zero,
     and only std::nearbyint under FE_TONEAREST matches Python. A tie is the
     ONLY input where the wrong C function still looks right on everything
     else, so the tie cases are generated deliberately rather than hoped for:
     ratio 0.5 with an odd block count, 0.25 / 0.75 with the right residue,
     and so on down to 0.0625 steps. TIE_MINIMUM below is a floor on how many
     of them the sweep must actually contain.
  2. The value itself. A ratio only survives the trip Rust -> plan JSON ->
     .split sidecar -> strtod if its decimal spelling round-trips, which is
     why producers quantise to 4 decimals. The sweep feeds ratios through
     their text form, exactly as the real chain does.
  3. Block counts. Small records (1, 2, 3 blocks) are where a cut can collapse
     to zero on one side, and huge ones are where a double starts losing
     integers.

Usage:
  GALACTUS_SPLIT_PROBE=build/galactus-h4-split-probe python3 \
      scripts/tests/test-p0-split-differential.py
"""
from __future__ import annotations

import importlib.util
import os
import pathlib
import subprocess
import sys
from fractions import Fraction

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
ALIGN = 16384
# The sweep must actually contain ties, or it proves nothing about the one
# input where the two rounding rules differ.
TIE_MINIMUM = 40


def load_planner():
    """The real planner module, imported from its hyphenated filename."""
    path = ROOT / "scripts" / "galactus-pack-plan.py"
    spec = importlib.util.spec_from_file_location("galactus_pack_plan", path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot import {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def find_probe() -> pathlib.Path:
    env = os.environ.get("GALACTUS_SPLIT_PROBE")
    if env:
        p = pathlib.Path(env)
        if p.is_file():
            return p
        raise SystemExit(f"GALACTUS_SPLIT_PROBE={env} is not a file")
    for candidate in (ROOT / "build" / "galactus-h4-split-probe",):
        if candidate.is_file():
            return candidate
    raise SystemExit(
        "galactus-h4-split-probe not found: build it with\n"
        "  cmake --build build --target galactus-h4-split-probe -j")


def ratio_text(value: float) -> str:
    """The one spelling a ratio ever travels as: at most 4 fractional digits.

    Trailing zeros are stripped so this produces the same characters whether
    the value came from Rust's {:.4} or Python's repr(); both spell the same
    double, and strtod recovers it either way.
    """
    return f"{value:.4f}".rstrip("0").rstrip(".") or "0"


def tie_ratios_and_blocks() -> list[tuple[int, str]]:
    """Inputs where blocks * ratio lands EXACTLY on .5.

    Built with exact rationals rather than floats: asking a float whether it is
    exactly a tie is how a test convinces itself it covered the case it did
    not. Only ratios that are exactly representable in binary AND on the
    4-decimal grid can produce an exact tie, which is what the divisors of 16
    below are.
    """
    out: list[tuple[int, str]] = []
    for denominator in (2, 4, 8, 16):
        for numerator in range(1, denominator):
            r = Fraction(numerator, denominator)
            if r < Fraction(5, 100) or r > Fraction(95, 100):
                continue
            text = ratio_text(float(r))
            # Guard the premise: the decimal spelling must be the same number.
            if Fraction(text) != r:
                continue
            # blocks * num/den == k + 1/2  <=>  blocks * 2 * num == den * (2k+1)
            for blocks in range(1, 4096):
                doubled = Fraction(blocks * 2) * r
                if doubled.denominator == 1 and doubled.numerator % 2 == 1:
                    out.append((blocks, text))
                if len([b for b, t in out if t == text]) >= 12:
                    break
    return out


def cases() -> list[tuple[int, str]]:
    ratios = [
        # The historical cut, which existing packs were written at.
        "0.7157",
        # Two identical NVMe drives, the commonest dual setup.
        "0.5",
        # A fast internal with a slow USB SSD, and the reverse.
        "0.8571", "0.1429", "0.6284", "0.3716",
        # The bounds themselves.
        "0.05", "0.95",
        # Values whose 4-decimal spelling is not exactly representable in
        # binary: the trip through text must still land on one double.
        "0.1", "0.2", "0.3", "0.7", "0.9001", "0.0501", "0.9499",
    ]
    blocks = [
        # Degenerate and near-degenerate records.
        1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17,
        # Real per-expert record sizes seen in this project.
        594, 690, 804,          # GLM-5.2 classes A, B, C
        232, 233, 240, 256,     # olmoe, qwen3-30b
        1024, 1025, 2048, 4096,
        # Big enough that the product stops being exactly representable in a
        # double is far out of reach here, but go where the arithmetic is at
        # least large.
        65536, 131072, 1_000_003,
    ]
    out = [(b, r) for r in ratios for b in blocks]
    out.extend(tie_ratios_and_blocks())
    # Deduplicate, keep a stable order so a failure is reproducible.
    return sorted(set(out))


def main() -> int:
    planner = load_planner()
    probe = find_probe()
    pairs = cases()

    ties = 0
    for blocks, text in pairs:
        if (Fraction(blocks) * Fraction(text) * 2).denominator == 1 and \
                (Fraction(blocks) * Fraction(text) * 2).numerator % 2 == 1:
            ties += 1
    if ties < TIE_MINIMUM:
        print(f"ECHEC: only {ties} exact ties in the sweep, {TIE_MINIMUM} required: "
              f"the case that separates the two rounding rules is not covered",
              file=sys.stderr)
        return 2

    stdin = "".join(f"{b * ALIGN} {r}\n" for b, r in pairs)
    result = subprocess.run([str(probe)], input=stdin, capture_output=True,
                            text=True, check=False)
    if result.returncode != 0:
        print(f"ECHEC: {probe} exited {result.returncode}\n{result.stderr}", file=sys.stderr)
        return 2
    lines = [l for l in result.stdout.splitlines() if l.strip()]
    if len(lines) != len(pairs):
        print(f"ECHEC: {len(lines)} lines back for {len(pairs)} cases", file=sys.stderr)
        return 2

    failures = []
    for (blocks, text), line in zip(pairs, lines):
        fields = line.split()
        record_bytes = blocks * ALIGN
        if fields[2] == "ERROR":
            failures.append(f"{record_bytes} @ {text}: engine refused: {' '.join(fields[3:])}")
            continue
        engine_internal = int(fields[2])
        engine_external = int(fields[3])
        packer_internal = planner.internal_blocks(blocks, float(text)) * ALIGN
        packer_external = record_bytes - packer_internal
        if (engine_internal, engine_external) != (packer_internal, packer_external):
            failures.append(
                f"{record_bytes} o ({blocks} blocs) @ {text}: "
                f"packeur {packer_internal}/{packer_external}, "
                f"moteur {engine_internal}/{engine_external}")

    if failures:
        print(f"ECHEC: {len(failures)} of {len(pairs)} cases diverge", file=sys.stderr)
        for f in failures[:20]:
            print(f"  {f}", file=sys.stderr)
        return 1

    print(f"OK: {len(pairs)} cases, {ties} of them exact ties, "
          f"packer and engine agree on every internal_bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
