#!/usr/bin/env python3
"""Refuse em dashes and en dashes anywhere on the shipped surface.

Why a script and not a grep: `grep -o $'—\\|–'` silently matches
nothing under some shells, which is worse than no check at all. It reported a
clean tree while `cli.rs` was printing an em dash in the CLI banner. A check
that can fail open is not a check, so this one reads bytes and counts.

Usage: python3 scripts/check-dashes.py [root ...]
Exit code 1 when anything is found, so it can gate a build.
"""
from __future__ import annotations

import pathlib
import sys

DASHES = {"—": "em dash", "–": "en dash"}

# The shipped surface: what a user receives or reads. Archives and historical
# reports are deliberately out of scope; rewriting them would falsify a record.
DEFAULT_ROOTS = [
    "app/src",
    "app/src-tauri/src",
    "app/skills",
    "app/index.html",
    "vault",
    "README.md",
    "NOTICE",
]

SKIP_PARTS = {"node_modules", "out", "dist", "target", "third_party", ".git"}


def scan(root: pathlib.Path) -> dict[str, list[tuple[int, str]]]:
    found: dict[str, list[tuple[int, str]]] = {}
    files = [root] if root.is_file() else sorted(root.rglob("*"))
    for f in files:
        if not f.is_file() or any(s in f.parts for s in SKIP_PARTS):
            continue
        try:
            text = f.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        lines = [
            (i, line.strip()[:100])
            for i, line in enumerate(text.splitlines(), 1)
            if any(d in line for d in DASHES)
        ]
        if lines:
            found[str(f)] = lines
    return found


def main(argv: list[str]) -> int:
    roots = argv[1:] or DEFAULT_ROOTS
    total = 0
    for r in roots:
        p = pathlib.Path(r)
        if not p.exists():
            print(f"[skip]  {r} does not exist")
            continue
        for path, lines in scan(p).items():
            for num, snippet in lines:
                print(f"{path}:{num}: {snippet}")
                total += 1
    label = "occurrence" if total == 1 else "occurrences"
    print(f"\nscanned {len(roots)} root(s): {total} {label}")
    # Self-test: the checker must be able to see what it looks for.
    probe = "a — b"
    if not any(d in probe for d in DASHES):
        print("BROKEN: the checker cannot detect its own probe string")
        return 2
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
