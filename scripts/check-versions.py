#!/usr/bin/env python3
"""The three version numbers must agree, and the release notes must exist.

Only tauri.conf.json reaches the user: it becomes CFBundleShortVersionString,
which the app reports and which release-manifest.sh reads. A Cargo.toml left
behind therefore produces no symptom at all, which guarantees the drift is only
discovered the day somebody relies on it. This makes it a build error instead.

Run with --release to also require app/RELEASE-NOTES-v<version>.md, which
release-manifest.sh refuses to work without.
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def read_versions() -> dict[str, str]:
    package = json.loads((ROOT / "app/package.json").read_text())["version"]
    tauri = json.loads((ROOT / "app/src-tauri/tauri.conf.json").read_text())["version"]
    cargo_text = (ROOT / "app/src-tauri/Cargo.toml").read_text()
    match = re.search(r'^version\s*=\s*"([^"]+)"', cargo_text, re.M)
    cargo = match.group(1) if match else "?"
    return {"package.json": package, "tauri.conf.json": tauri, "Cargo.toml": cargo}


def main() -> int:
    versions = read_versions()
    unique = set(versions.values())
    if len(unique) != 1:
        print("FAIL: the version numbers disagree", file=sys.stderr)
        for name, value in versions.items():
            print(f"  {name}: {value}", file=sys.stderr)
        return 1
    version = unique.pop()
    print(f"version {version} in all three files")

    if "--release" in sys.argv:
        notes = ROOT / f"app/RELEASE-NOTES-v{version}.md"
        if not notes.is_file():
            print(f"FAIL: {notes.relative_to(ROOT)} does not exist", file=sys.stderr)
            print("  release-manifest.sh refuses to build a manifest without it.", file=sys.stderr)
            return 1
        print(f"release notes present ({notes.name})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
