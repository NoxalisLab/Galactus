#!/usr/bin/env python3
"""Refuse em dashes and en dashes anywhere on the shipped surface.

Why a script and not a grep: `grep -o $'—\\|–'` silently matches
nothing under some shells, which is worse than no check at all. It reported a
clean tree while `cli.rs` was printing an em dash in the CLI banner. A check
that can fail open is not a check, so this one reads bytes and counts.

Usage: python3 scripts/check-dashes.py [root ...]
Roots are relative to the repository, not to the working directory, so the
check reports on the same tree wherever it is called from.
Exit code 1 when anything is found, so it can gate a build. Exit code 2 when
the run itself is not trustworthy: the self-test failed, or not a single file
was read.
"""
from __future__ import annotations

import pathlib
import sys
import tempfile

DASHES = {"—": "em dash", "–": "en dash"}

# Roots are resolved against the repository, never against the caller's working
# directory. Resolved relatively, a run from anywhere but the repository root
# printed six `[skip]` lines and exited 0: a clean bill of health for a tree it
# had never opened.
REPO = pathlib.Path(__file__).resolve().parent.parent

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
    # The build and release pipeline. Not a user surface, but this check is the
    # thing that gates it, and a check that does not cover the file it runs from
    # is an invitation.
    ".github",
]

SKIP_PARTS = {"node_modules", "out", "dist", "target", "third_party", ".git"}


def scan(root: pathlib.Path) -> tuple[dict[str, list[tuple[int, str]]], int]:
    """Return the hits under `root`, and how many files were actually read.

    The file count is half the answer. Without it a run that opened nothing
    looks exactly like a run that opened everything and found it clean.
    """
    found: dict[str, list[tuple[int, str]]] = {}
    read = 0
    files = [root] if root.is_file() else sorted(root.rglob("*"))
    for f in files:
        if not f.is_file() or any(s in f.parts for s in SKIP_PARTS):
            continue
        try:
            text = f.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        read += 1
        lines = [
            (i, line.strip()[:100])
            for i, line in enumerate(text.splitlines(), 1)
            if any(d in line for d in DASHES)
        ]
        if lines:
            found[str(f)] = lines
    return found, read


def selftest() -> bool:
    """Run the real scan over a file that really contains an em dash.

    The previous self-test compared two literals of this same file and could
    only fail if Python itself was broken. This one exercises the code path
    that the check depends on, so a regression in `scan` is caught here rather
    than reported as a clean tree.
    """
    with tempfile.TemporaryDirectory() as tmp:
        probe = pathlib.Path(tmp) / "probe.md"
        probe.write_text("clean line\na — b\n", encoding="utf-8")
        found, read = scan(probe)
        return read == 1 and found.get(str(probe)) == [(2, "a — b")]


def main(argv: list[str]) -> int:
    # Self-test first: a broken scanner must not get the chance to print a
    # reassuring zero.
    if not selftest():
        print("BROKEN: scan() did not find an em dash in a file that contains one")
        return 2

    roots = argv[1:] or DEFAULT_ROOTS
    total = 0
    scanned = 0
    for r in roots:
        p = REPO / r
        if not p.exists():
            print(f"[skip]  {r} does not exist")
            continue
        found, read = scan(p)
        scanned += read
        for path, lines in found.items():
            for num, snippet in lines:
                print(f"{path}:{num}: {snippet}")
                total += 1
    label = "occurrence" if total == 1 else "occurrences"
    print(f"\nscanned {scanned} file(s) across {len(roots)} root(s): {total} {label}")
    if scanned == 0:
        print("FAIL: no file was read, so this run proves nothing about the tree")
        return 2
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
