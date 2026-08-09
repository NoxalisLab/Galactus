#!/usr/bin/env python3
"""Regression test for the bundled-vault link checker CLI contract."""

from __future__ import annotations

from pathlib import Path
import subprocess
import tempfile


REPO_ROOT = Path(__file__).resolve().parents[1]
CHECKER = REPO_ROOT / "scripts" / "verifier-liens-coffre.py"


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["python3", str(CHECKER), *args],
        text=True,
        capture_output=True,
        check=False,
    )


def main() -> None:
    default = run()
    assert default.returncode == 0, default.stdout + default.stderr
    assert "notes                : 50" in default.stdout
    assert "liens non resolus    : 0" in default.stdout
    assert "aucune note" not in default.stdout

    with tempfile.TemporaryDirectory(prefix="galactus-empty-vault-") as directory:
        empty = run(directory)
        assert empty.returncode == 1
        assert "aucune note trouvee" in empty.stdout

    print("bundled vault link checker CLI contract passed")


if __name__ == "__main__":
    main()
