#!/usr/bin/env python3
"""Write deterministic H4 real-record fixtures or the jointly frozen P0/P1 packs.

This writer deliberately does not parse GGUF metadata.  It consumes a plan by
an explicitly supplied SHA-256, then uses raw pread/pwrite calls for a second,
small and auditable data path.  Full packing is fail-closed behind an exact
confirmation token and disk-space checks on both target volumes.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, BinaryIO


EXPECTED_RECORDS = 19_200
EXPECTED_TOTAL_BYTES = 197_627_215_872
EXPECTED_P0_INTERNAL = 118_405_201_920
EXPECTED_P0_EXTERNAL = 79_222_013_952
EXPECTED_P0V2_INTERNAL = 141_436_125_184
EXPECTED_P0V2_EXTERNAL = 56_191_090_688
EXPECTED_P1_INTERNAL = 118_379_053_056
EXPECTED_P1_EXTERNAL = 79_248_162_816
EXPECTED_ROLE_ORDER = ("down", "gate", "up")
FIXTURE_KEYS = (768, 1536, 2048)  # layer 3/6/8, expert 0: one per size class.
COPY_CHUNK_BYTES = 4 * 1024 * 1024
FULL_PACK_CONFIRMATION = "WRITE-FROZEN-H4-P0-P1-19200"
P0V2_PACK_CONFIRMATION = "WRITE-CONTRESIGNED-H4-P0V2-19200"
P0_BLOCK_SPLITS = {
    "p0v1-599-401": {
        9_732_096: (356, 238),
        11_304_960: (413, 277),
        13_172_736: (482, 322),
    },
    "p0v2-7157-2843": {
        9_732_096: (425, 169),
        11_304_960: (494, 196),
        13_172_736: (576, 228),
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", required=True, choices=("fixture", "full"))
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--expected-plan-sha256", required=True)
    parser.add_argument("--model-directory", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--progress", type=Path)
    parser.add_argument("--fixture-output-directory", type=Path)
    parser.add_argument("--internal-output-directory", type=Path)
    parser.add_argument("--external-output-directory", type=Path)
    parser.add_argument("--minimum-free-after-gib", type=int, default=128)
    parser.add_argument("--confirm-full-pack")
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb", buffering=0) as source:
        while chunk := source.read(COPY_CHUNK_BYTES):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_file_f_nocache(path: Path) -> tuple[str, bool]:
    descriptor = os.open(path, os.O_RDONLY)
    applied = False
    try:
        command = getattr(fcntl, "F_NOCACHE", None)
        if command is None:
            raise RuntimeError("F_NOCACHE is unavailable on this platform")
        fcntl.fcntl(descriptor, command, 1)
        applied = True
        digest = hashlib.sha256()
        while chunk := os.read(descriptor, COPY_CHUNK_BYTES):
            digest.update(chunk)
        return digest.hexdigest(), applied
    finally:
        os.close(descriptor)


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(value, output, indent=2, ensure_ascii=False)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def load_and_validate_plan(path: Path, expected_sha256: str) -> tuple[dict[str, Any], str]:
    if len(expected_sha256) != 64 or any(char not in "0123456789abcdef" for char in expected_sha256):
        raise RuntimeError("expected plan SHA-256 must be 64 lowercase hexadecimal characters")
    actual_sha256 = sha256_file(path)
    if actual_sha256 != expected_sha256:
        raise RuntimeError(f"pack plan SHA mismatch: {actual_sha256} != {expected_sha256}")
    with path.open("r", encoding="utf-8") as source:
        plan = json.load(source)
    accepted_statuses = {
        "metadata-plan-complete-awaiting-joint-record-order-freeze",
        "metadata-plan-p0v2-complete-awaiting-cutpoint-counter-read",
        "metadata-plan-p0v2-authorized-after-joint-cutpoint-counter-read",
    }
    if plan.get("status") not in accepted_statuses:
        raise RuntimeError("pack plan status is not an accepted counter-read metadata plan")
    contract = plan.get("record_contract", {})
    if tuple(contract.get("proposed_role_order", ())) != EXPECTED_ROLE_ORDER:
        raise RuntimeError("record role order is not the jointly frozen down/gate/up order")
    records = plan.get("records")
    if not isinstance(records, list) or len(records) != EXPECTED_RECORDS:
        raise RuntimeError("pack plan does not contain exactly 19,200 records")
    if [record.get("key") for record in records] != list(range(768, 19_968)):
        raise RuntimeError("pack plan keys are not in canonical contiguous order")
    layouts = plan.get("layouts", {})
    p0_layout = layouts.get("p0", {})
    p0_profile = p0_layout.get("profile", "p0v1-599-401")
    if p0_profile == "p0v1-599-401":
        expected_p0 = (EXPECTED_P0_INTERNAL, EXPECTED_P0_EXTERNAL)
    elif p0_profile == "p0v2-7157-2843":
        expected_p0 = (EXPECTED_P0V2_INTERNAL, EXPECTED_P0V2_EXTERNAL)
    else:
        raise RuntimeError("pack plan has an unknown P0 profile")
    observed_totals = (
        p0_layout.get("internal_bytes"),
        p0_layout.get("external_bytes"),
        layouts.get("p1", {}).get("internal_bytes"),
        layouts.get("p1", {}).get("external_bytes"),
    )
    expected_totals = (
        *expected_p0,
        EXPECTED_P1_INTERNAL,
        EXPECTED_P1_EXTERNAL,
    )
    if observed_totals != expected_totals:
        raise RuntimeError("pack plan layout totals differ from the frozen values")
    validate_p0_layout(records, p0_profile, expected_p0)
    return plan, actual_sha256


def validate_record(record: dict[str, Any]) -> None:
    spans = record.get("source_spans")
    record_bytes = record.get("record_bytes")
    if not isinstance(record_bytes, int) or record_bytes <= 0:
        raise RuntimeError("record byte size is invalid")
    if not isinstance(spans, list) or tuple(span.get("role") for span in spans) != EXPECTED_ROLE_ORDER:
        raise RuntimeError("record spans do not use the frozen role order")
    expected_offset = 0
    for span in spans:
        length = span.get("length")
        source_offset = span.get("source_offset")
        if span.get("record_offset") != expected_offset:
            raise RuntimeError("record source spans are not contiguous")
        if not isinstance(length, int) or length <= 0 or not isinstance(source_offset, int) or source_offset < 0:
            raise RuntimeError("record source span is invalid")
        shard = span.get("source_shard")
        if not isinstance(shard, str) or Path(shard).name != shard or not shard.endswith(".gguf"):
            raise RuntimeError("source shard name is unsafe")
        expected_offset += length
    if expected_offset != record_bytes:
        raise RuntimeError("record source spans do not cover the record")


def validate_p0_layout(
    records: list[dict[str, Any]],
    profile: str,
    expected_totals: tuple[int, int],
) -> None:
    splits = P0_BLOCK_SPLITS[profile]
    internal_offset = 0
    external_offset = 0
    for record in records:
        record_bytes = record.get("record_bytes")
        blocks = splits.get(record_bytes)
        if blocks is None:
            raise RuntimeError("record size has no literal split in the selected P0 profile")
        internal_length = blocks[0] * 16_384
        external_length = blocks[1] * 16_384
        expected = {
            "internal_offset": internal_offset,
            "internal_length": internal_length,
            "external_offset": external_offset,
            "external_length": external_length,
        }
        if record.get("p0") != expected:
            raise RuntimeError(f"P0 layout mismatch for key {record.get('key')}")
        if internal_length + external_length != record_bytes:
            raise RuntimeError("P0 split does not cover the record")
        internal_offset += internal_length
        external_offset += external_length
    if (internal_offset, external_offset) != expected_totals:
        raise RuntimeError("reconstructed P0 totals differ from the selected profile")


class ShardDescriptors:
    def __init__(self, model_directory: Path) -> None:
        self.model_directory = model_directory.resolve()
        self.descriptors: dict[str, int] = {}

    def descriptor(self, shard_name: str) -> int:
        descriptor = self.descriptors.get(shard_name)
        if descriptor is not None:
            return descriptor
        path = (self.model_directory / shard_name).resolve()
        if path.parent != self.model_directory or not path.is_file():
            raise RuntimeError(f"missing or unsafe source shard: {shard_name}")
        descriptor = os.open(path, os.O_RDONLY)
        self.descriptors[shard_name] = descriptor
        return descriptor

    def close(self) -> None:
        for descriptor in self.descriptors.values():
            os.close(descriptor)
        self.descriptors.clear()

    def __enter__(self) -> "ShardDescriptors":
        return self

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        self.close()


def pread_exact(descriptor: int, offset: int, length: int) -> bytes:
    output = bytearray(length)
    completed = 0
    while completed < length:
        requested = min(COPY_CHUNK_BYTES, length - completed)
        chunk = os.pread(descriptor, requested, offset + completed)
        if not chunk:
            raise RuntimeError("short read while assembling a record")
        output[completed : completed + len(chunk)] = chunk
        completed += len(chunk)
    return bytes(output)


def sha256_ranges(ranges: list[tuple[int, int, int]]) -> str:
    digest = hashlib.sha256()
    for descriptor, offset, length in ranges:
        completed = 0
        while completed < length:
            requested = min(COPY_CHUNK_BYTES, length - completed)
            chunk = os.pread(descriptor, requested, offset + completed)
            if not chunk:
                raise RuntimeError("short read while verifying a packed record")
            digest.update(chunk)
            completed += len(chunk)
    return digest.hexdigest()


def assemble_record(record: dict[str, Any], shards: ShardDescriptors) -> tuple[bytes, str]:
    validate_record(record)
    payload = bytearray(record["record_bytes"])
    for span in record["source_spans"]:
        data = pread_exact(
            shards.descriptor(span["source_shard"]),
            span["source_offset"],
            span["length"],
        )
        start = span["record_offset"]
        payload[start : start + span["length"]] = data
    digest = hashlib.sha256(payload).hexdigest()
    return bytes(payload), digest


def write_all(descriptor: int, payload: memoryview, offset: int) -> None:
    completed = 0
    while completed < len(payload):
        written = os.pwrite(descriptor, payload[completed:], offset + completed)
        if written <= 0:
            raise RuntimeError("short write while materializing a pack")
        completed += written


def write_fixture_record(path: Path, payload: bytes, expected_sha256: str) -> tuple[str, bool]:
    partial = path.with_name(path.name + ".partial")
    if path.exists() or partial.exists():
        raise RuntimeError(f"refusing to overwrite fixture output: {path}")
    descriptor = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        write_all(descriptor, memoryview(payload), 0)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    verified_sha256, f_nocache_applied = sha256_file_f_nocache(partial)
    if partial.stat().st_size != len(payload) or verified_sha256 != expected_sha256:
        raise RuntimeError("fixture record failed post-write size/SHA verification")
    os.replace(partial, path)
    return verified_sha256, f_nocache_applied


def disk_snapshot(path: Path, required_bytes: int, minimum_free_after_bytes: int) -> dict[str, int | str]:
    path.mkdir(parents=True, exist_ok=True)
    usage = shutil.disk_usage(path)
    if usage.free < required_bytes + minimum_free_after_bytes:
        raise RuntimeError(
            f"insufficient free space on {path}: free={usage.free}, required={required_bytes}, "
            f"minimum_after={minimum_free_after_bytes}"
        )
    return {
        "path": str(path.resolve()),
        "device": os.stat(path).st_dev,
        "total_bytes": usage.total,
        "used_bytes": usage.used,
        "free_bytes_before": usage.free,
        "required_pack_bytes": required_bytes,
        "minimum_free_after_bytes": minimum_free_after_bytes,
    }


def run_fixture(args: argparse.Namespace, plan: dict[str, Any], plan_sha256: str) -> dict[str, Any]:
    if args.fixture_output_directory is None:
        raise RuntimeError("fixture mode requires --fixture-output-directory")
    output_directory = args.fixture_output_directory
    selected = {record["key"]: record for record in plan["records"] if record["key"] in FIXTURE_KEYS}
    if set(selected) != set(FIXTURE_KEYS):
        raise RuntimeError("fixture keys are missing from the plan")
    # Each fixture publishes the full record plus its two P0 slices.
    required_bytes = 2 * sum(selected[key]["record_bytes"] for key in FIXTURE_KEYS)
    minimum_free_after_bytes = args.minimum_free_after_gib * 1024**3
    disk_preflight = disk_snapshot(output_directory, required_bytes, minimum_free_after_bytes)
    results = []
    with ShardDescriptors(args.model_directory) as shards:
        for key in FIXTURE_KEYS:
            record = selected[key]
            payload, assembled_sha256 = assemble_record(record, shards)
            stem = f"record-{record['layer']:02d}-{record['expert']:03d}"
            output = output_directory / f"{stem}.bin"
            post_write_sha256, f_nocache_applied = write_fixture_record(
                output, payload, assembled_sha256
            )
            p0 = record["p0"]
            internal_payload = payload[:p0["internal_length"]]
            external_payload = payload[p0["internal_length"]:]
            internal_sha256 = hashlib.sha256(internal_payload).hexdigest()
            external_sha256 = hashlib.sha256(external_payload).hexdigest()
            internal_output = output_directory / f"{stem}-p0-internal.bin"
            external_output = output_directory / f"{stem}-p0-external.bin"
            internal_post_sha256, internal_f_nocache = write_fixture_record(
                internal_output, internal_payload, internal_sha256
            )
            external_post_sha256, external_f_nocache = write_fixture_record(
                external_output, external_payload, external_sha256
            )
            results.append({
                "key": key,
                "layer": record["layer"],
                "expert": record["expert"],
                "record_bytes": record["record_bytes"],
                "source_spans": record["source_spans"],
                "assembled_sha256": assembled_sha256,
                "post_write_sha256": post_write_sha256,
                "post_write_f_nocache": f_nocache_applied,
                "output": str(output),
                "p0": {
                    **p0,
                    "internal_sha256": internal_sha256,
                    "internal_post_write_sha256": internal_post_sha256,
                    "internal_post_write_f_nocache": internal_f_nocache,
                    "internal_output": str(internal_output),
                    "external_sha256": external_sha256,
                    "external_post_write_sha256": external_post_sha256,
                    "external_post_write_f_nocache": external_f_nocache,
                    "external_output": str(external_output),
                    "recombined_sha256": hashlib.sha256(internal_payload + external_payload).hexdigest(),
                },
            })
    return {
        "schema_version": 1,
        "status": "fixture-records-written-awaiting-independent-extraction",
        "mode": "fixture",
        "p0_profile": plan["layouts"]["p0"].get("profile", "p0v1-599-401"),
        "plan": str(args.plan),
        "plan_sha256": plan_sha256,
        "writer": str(Path(__file__)),
        "writer_sha256": sha256_file(Path(__file__)),
        "role_order": list(EXPECTED_ROLE_ORDER),
        "disk_preflight": disk_preflight,
        "records": results,
    }


def create_pack_file(path: Path, size: int) -> int:
    if path.exists():
        raise RuntimeError(f"refusing to overwrite pack target: {path}")
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.ftruncate(descriptor, size)
    except BaseException:
        os.close(descriptor)
        raise
    return descriptor


def run_full(args: argparse.Namespace, plan: dict[str, Any], plan_sha256: str) -> dict[str, Any]:
    p0_profile = plan["layouts"]["p0"].get("profile", "p0v1-599-401")
    p0v2 = p0_profile == "p0v2-7157-2843"
    if p0v2 and plan.get("status") != "metadata-plan-p0v2-authorized-after-joint-cutpoint-counter-read":
        raise RuntimeError("P0v2 full pack is blocked pending independent cutpoint counter-read")
    expected_confirmation = P0V2_PACK_CONFIRMATION if p0v2 else FULL_PACK_CONFIRMATION
    if args.confirm_full_pack != expected_confirmation:
        raise RuntimeError("full pack confirmation token is absent or incorrect")
    if args.internal_output_directory is None or args.external_output_directory is None:
        raise RuntimeError("full mode requires both output directories")
    if args.minimum_free_after_gib < 64:
        raise RuntimeError("minimum free space after packing cannot be below 64 GiB")
    reserve = args.minimum_free_after_gib * 1024**3
    expected_p0_internal = EXPECTED_P0V2_INTERNAL if p0v2 else EXPECTED_P0_INTERNAL
    expected_p0_external = EXPECTED_P0V2_EXTERNAL if p0v2 else EXPECTED_P0_EXTERNAL
    internal_required = expected_p0_internal + (0 if p0v2 else EXPECTED_P1_INTERNAL)
    external_required = expected_p0_external + (0 if p0v2 else EXPECTED_P1_EXTERNAL)
    internal_disk = disk_snapshot(args.internal_output_directory, internal_required, reserve)
    external_disk = disk_snapshot(args.external_output_directory, external_required, reserve)
    if internal_disk["device"] == external_disk["device"]:
        raise RuntimeError("P0/P1 internal and external outputs must be on distinct devices")

    started = time.monotonic()

    def publish_progress(
        phase: str,
        completed_records: int,
        source_bytes_read: int,
        pack_bytes_written: int,
        verification_bytes_read: int,
    ) -> None:
        if args.progress is None:
            return
        write_json_atomic(args.progress, {
            "schema_version": 1,
            "status": "running" if phase != "complete" else "complete",
            "phase": phase,
            "completed_records": completed_records,
            "total_records": EXPECTED_RECORDS,
            "source_bytes_read": source_bytes_read,
            "pack_bytes_written": pack_bytes_written,
            "verification_bytes_read": verification_bytes_read,
            "elapsed_seconds": time.monotonic() - started,
        })

    source_bytes_read = 0
    pack_bytes_written = 0
    verification_bytes_read = 0
    publish_progress("write", 0, 0, 0, 0)

    if p0v2:
        targets = {
            "p0_internal": (
                args.internal_output_directory / "h4-p0v2-internal.pack.partial",
                EXPECTED_P0V2_INTERNAL,
            ),
            "p0_external": (
                args.external_output_directory / "h4-p0v2-external.pack.partial",
                EXPECTED_P0V2_EXTERNAL,
            ),
        }
    else:
        targets = {
            "p0_internal": (args.internal_output_directory / "h4-p0-internal.pack.partial", EXPECTED_P0_INTERNAL),
            "p0_external": (args.external_output_directory / "h4-p0-external.pack.partial", EXPECTED_P0_EXTERNAL),
            "p1_internal": (args.internal_output_directory / "h4-p1-internal.pack.partial", EXPECTED_P1_INTERNAL),
            "p1_external": (args.external_output_directory / "h4-p1-external.pack.partial", EXPECTED_P1_EXTERNAL),
        }
    descriptors: dict[str, int] = {}
    record_hashes = []
    try:
        for partial, _size in targets.values():
            final = partial.with_name(partial.name.removesuffix(".partial"))
            if partial.exists() or final.exists():
                raise RuntimeError(f"refusing to overwrite pack target: {final}")
        for name, (path, size) in targets.items():
            descriptors[name] = create_pack_file(path, size)
        with ShardDescriptors(args.model_directory) as shards:
            for index, record in enumerate(plan["records"], start=1):
                payload, digest = assemble_record(record, shards)
                view = memoryview(payload)
                p0 = record["p0"]
                split = p0["internal_length"]
                write_all(descriptors["p0_internal"], view[:split], p0["internal_offset"])
                write_all(descriptors["p0_external"], view[split:], p0["external_offset"])
                if not p0v2:
                    p1 = record["p1"]
                    write_all(descriptors[f"p1_{p1['volume']}"], view, p1["offset"])
                record_hashes.append({"key": record["key"], "source_sha256": digest})
                source_bytes_read += record["record_bytes"]
                pack_bytes_written += (1 if p0v2 else 2) * record["record_bytes"]
                if index % 64 == 0 or index == EXPECTED_RECORDS:
                    publish_progress(
                        "write", index, source_bytes_read, pack_bytes_written, 0
                    )
        for descriptor in descriptors.values():
            os.fsync(descriptor)
    finally:
        for descriptor in descriptors.values():
            os.close(descriptor)

    verification_descriptors: dict[str, int] = {}
    verification_f_nocache: dict[str, bool] = {}
    try:
        command = getattr(fcntl, "F_NOCACHE", None)
        if command is None:
            raise RuntimeError("F_NOCACHE is unavailable on this platform")
        for name, (path, _size) in targets.items():
            descriptor = os.open(path, os.O_RDONLY)
            verification_descriptors[name] = descriptor
            fcntl.fcntl(descriptor, command, 1)
            verification_f_nocache[name] = True
        publish_progress(
            "verify", 0, source_bytes_read, pack_bytes_written, verification_bytes_read
        )
        for index, (record, hashes) in enumerate(
            zip(plan["records"], record_hashes, strict=True), start=1
        ):
            p0 = record["p0"]
            p0_sha256 = sha256_ranges([
                (
                    verification_descriptors["p0_internal"],
                    p0["internal_offset"],
                    p0["internal_length"],
                ),
                (
                    verification_descriptors["p0_external"],
                    p0["external_offset"],
                    p0["external_length"],
                ),
            ])
            p1_sha256 = None
            if not p0v2:
                p1 = record["p1"]
                p1_sha256 = sha256_ranges([
                    (
                        verification_descriptors[f"p1_{p1['volume']}"],
                        p1["offset"],
                        p1["length"],
                    ),
                ])
            if p0_sha256 != hashes["source_sha256"] or (
                p1_sha256 is not None and p1_sha256 != hashes["source_sha256"]
            ):
                raise RuntimeError(f"post-fsync pack verification failed for key {record['key']}")
            hashes["p0_sha256"] = p0_sha256
            if p1_sha256 is not None:
                hashes["p1_sha256"] = p1_sha256
            verification_bytes_read += (1 if p0v2 else 2) * record["record_bytes"]
            if index % 64 == 0 or index == EXPECTED_RECORDS:
                publish_progress(
                    "verify",
                    index,
                    source_bytes_read,
                    pack_bytes_written,
                    verification_bytes_read,
                )
    finally:
        for descriptor in verification_descriptors.values():
            os.close(descriptor)

    final_files: dict[str, dict[str, Any]] = {}
    for name, (partial, expected_size) in targets.items():
        if partial.stat().st_size != expected_size:
            raise RuntimeError(f"pack target size mismatch: {partial}")
        final = partial.with_name(partial.name.removesuffix(".partial"))
        if final.exists():
            raise RuntimeError(f"refusing to overwrite final pack: {final}")
        os.replace(partial, final)
        final_files[name] = {"path": str(final), "bytes": expected_size}
    publish_progress(
        "complete",
        EXPECTED_RECORDS,
        source_bytes_read,
        pack_bytes_written,
        verification_bytes_read,
    )
    return {
        "schema_version": 1,
        "status": (
            "full-p0v2-pack-written-record-hashes-complete"
            if p0v2 else "full-p0-p1-pack-written-record-hashes-complete"
        ),
        "mode": "full",
        "p0_profile": p0_profile,
        "pack_set": "p0-only" if p0v2 else "p0-p1",
        "plan": str(args.plan),
        "plan_sha256": plan_sha256,
        "writer": str(Path(__file__)),
        "writer_sha256": sha256_file(Path(__file__)),
        "role_order": list(EXPECTED_ROLE_ORDER),
        "disk_preflight": {"internal": internal_disk, "external": external_disk},
        "files": final_files,
        "verification": (
            "all-records-post-fsync-p0-sha256-equal-source"
            if p0v2 else "all-records-post-fsync-p0-and-p1-sha256-equal-source"
        ),
        "verification_descriptors": "fresh-read-only",
        "verification_f_nocache": verification_f_nocache,
        "records": record_hashes,
    }


def main() -> None:
    args = parse_args()
    if args.manifest.exists():
        raise RuntimeError(f"refusing to overwrite manifest: {args.manifest}")
    if args.progress is not None and args.progress.exists():
        raise RuntimeError(f"refusing to overwrite progress artifact: {args.progress}")
    if args.minimum_free_after_gib < 64:
        raise RuntimeError("minimum free space after writing cannot be below 64 GiB")
    result: dict[str, Any]
    try:
        plan, plan_sha256 = load_and_validate_plan(args.plan, args.expected_plan_sha256)
        if args.mode == "fixture":
            result = run_fixture(args, plan, plan_sha256)
        else:
            result = run_full(args, plan, plan_sha256)
        write_json_atomic(args.manifest, result)
        print(json.dumps({
            "status": result["status"],
            "mode": result["mode"],
            "manifest": str(args.manifest),
            "record_count": len(result["records"]),
        }, ensure_ascii=False))
    except BaseException as error:
        failure = {
            "schema_version": 1,
            "status": "failed",
            "mode": args.mode,
            "error": f"{type(error).__name__}: {error}",
        }
        try:
            write_json_atomic(args.manifest, failure)
        except BaseException:
            pass
        print(json.dumps(failure, ensure_ascii=False), file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
