#!/usr/bin/env python3
"""Verify local model shards against a pinned Galactus manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def sha256_file(path: Path, chunk_size: int = 16 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb", buffering=0) as stream:
        while chunk := stream.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="verify every local shard size and SHA-256 against a pinned manifest"
    )
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--model-root", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifest_path = args.manifest.resolve(strict=True)
    model_root = args.model_root.resolve(strict=True)
    manifest: dict[str, Any] = json.loads(manifest_path.read_text(encoding="utf-8"))

    results: list[dict[str, Any]] = []
    actual_total = 0
    all_valid = True

    for expected in manifest["shards"]:
        candidate = (model_root / expected["path"]).resolve()
        try:
            candidate.relative_to(model_root)
        except ValueError as error:
            raise ValueError(f"manifest path escapes model root: {expected['path']}") from error

        result: dict[str, Any] = {
            "path": expected["path"],
            "expected_size_bytes": expected["size_bytes"],
            "expected_sha256": expected["sha256"],
        }
        if not candidate.is_file():
            result.update({"status": "missing", "size_ok": False, "sha256_ok": False})
            all_valid = False
            results.append(result)
            continue

        actual_size = candidate.stat().st_size
        actual_sha256 = sha256_file(candidate)
        size_ok = actual_size == expected["size_bytes"]
        sha256_ok = actual_sha256 == expected["sha256"]
        actual_total += actual_size
        result.update(
            {
                "actual_size_bytes": actual_size,
                "actual_sha256": actual_sha256,
                "size_ok": size_ok,
                "sha256_ok": sha256_ok,
                "status": "verified" if size_ok and sha256_ok else "mismatch",
            }
        )
        all_valid = all_valid and size_ok and sha256_ok
        results.append(result)

    total_ok = actual_total == manifest["total_size_bytes"]
    all_valid = all_valid and total_ok and len(results) == len(manifest["shards"])
    report = {
        "schema_version": 1,
        "verified_at": datetime.now(timezone.utc).isoformat(),
        "repository": manifest["repository"],
        "revision": manifest["revision"],
        "quantization": manifest["quantization"],
        "manifest": str(manifest_path),
        "model_root": str(model_root),
        "expected_total_size_bytes": manifest["total_size_bytes"],
        "actual_total_size_bytes": actual_total,
        "total_size_ok": total_ok,
        "all_valid": all_valid,
        "shards": results,
    }
    json.dump(report, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0 if all_valid else 1


if __name__ == "__main__":
    raise SystemExit(main())
