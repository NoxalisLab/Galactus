#!/usr/bin/env python3
"""Build a metadata-only, deterministic H4 pack plan from frozen GGUF shards.

The planner never reads tensor payloads and never creates pack files.  It maps
the three contiguous per-expert GGUF spans to the frozen P0 and P1 layouts so
the byte order can be independently reviewed before a 197 GB pack is allowed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from gguf import GGUFReader


FIRST_LAYER = 3
LAST_LAYER = 77
EXPERTS = 256
EXPECTED_SHARDS = 6
EXPECTED_SOURCE_TENSORS = 225
EXPECTED_RECORDS = 19_200
ALIGNMENT = 16_384
EXPECTED_P0_INTERNAL = 118_405_201_920
EXPECTED_P0_EXTERNAL = 79_222_013_952
EXPECTED_P1_INTERNAL = 118_379_053_056
EXPECTED_P1_EXTERNAL = 79_248_162_816
EXPECTED_TOTAL = 197_627_215_872
PROPOSED_ROLE_ORDER = ("down", "gate", "up")
TENSOR_PATTERN = re.compile(r"^blk\.(\d+)\.ffn_(down|gate|up)_exps\.weight$")


@dataclass(frozen=True)
class TensorSource:
    shard: str
    tensor: str
    data_offset: int
    tensor_bytes: int
    expert_bytes: int
    quant_type: int
    quant_name: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-directory", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


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


def p0_split(record_bytes: int) -> tuple[int, int]:
    if record_bytes <= 0 or record_bytes % ALIGNMENT:
        raise RuntimeError("record size is not a positive multiple of 16 KiB")
    blocks = record_bytes // ALIGNMENT
    internal_blocks = (blocks * 599 + 500) // 1000
    return internal_blocks * ALIGNMENT, (blocks - internal_blocks) * ALIGNMENT


def read_sources(model_directory: Path) -> tuple[dict[tuple[int, str], TensorSource], list[str]]:
    shards = sorted(model_directory.glob("*.gguf"))
    if len(shards) != EXPECTED_SHARDS:
        raise RuntimeError(f"expected {EXPECTED_SHARDS} GGUF shards, found {len(shards)}")
    sources: dict[tuple[int, str], TensorSource] = {}
    for shard in shards:
        shard_size = shard.stat().st_size
        reader = GGUFReader(shard, "r")
        for tensor in reader.tensors:
            match = TENSOR_PATTERN.match(tensor.name)
            if match is None:
                continue
            layer = int(match.group(1))
            role = match.group(2)
            if not FIRST_LAYER <= layer <= LAST_LAYER:
                continue
            key = (layer, role)
            if key in sources:
                raise RuntimeError(f"duplicate routed tensor {tensor.name}")
            tensor_bytes = int(tensor.n_bytes)
            if tensor_bytes % EXPERTS:
                raise RuntimeError(f"{tensor.name}: byte size is not divisible by {EXPERTS}")
            expert_bytes = tensor_bytes // EXPERTS
            if expert_bytes % ALIGNMENT:
                raise RuntimeError(f"{tensor.name}: expert span is not 16 KiB aligned in length")
            if tensor.data.shape[0] != EXPERTS or not tensor.data.flags.c_contiguous:
                raise RuntimeError(f"{tensor.name}: expert dimension is not outermost contiguous")
            if int(tensor.data.strides[0]) != expert_bytes:
                raise RuntimeError(f"{tensor.name}: expert stride differs from expert byte size")
            data_offset = int(tensor.data_offset)
            if data_offset < 0 or data_offset + tensor_bytes > shard_size:
                raise RuntimeError(f"{tensor.name}: tensor span exceeds its shard")
            tensor_type = tensor.tensor_type
            sources[key] = TensorSource(
                shard=shard.name,
                tensor=tensor.name,
                data_offset=data_offset,
                tensor_bytes=tensor_bytes,
                expert_bytes=expert_bytes,
                quant_type=int(tensor_type),
                quant_name=tensor_type.name,
            )
    if len(sources) != EXPECTED_SOURCE_TENSORS:
        raise RuntimeError(
            f"expected {EXPECTED_SOURCE_TENSORS} routed source tensors, found {len(sources)}"
        )
    expected = {
        (layer, role)
        for layer in range(FIRST_LAYER, LAST_LAYER + 1)
        for role in PROPOSED_ROLE_ORDER
    }
    if set(sources) != expected:
        raise RuntimeError("routed tensor layer/role domain is incomplete")
    return sources, [shard.name for shard in shards]


def build_plan(sources: dict[tuple[int, str], TensorSource], shards: list[str]) -> dict[str, Any]:
    records: list[dict[str, Any]] = []
    p0_internal = 0
    p0_external = 0
    p1_internal = 0
    p1_external = 0
    class_counts: dict[str, int] = {}
    for layer in range(FIRST_LAYER, LAST_LAYER + 1):
        record_bytes = sum(sources[(layer, role)].expert_bytes for role in PROPOSED_ROLE_ORDER)
        internal_length, external_length = p0_split(record_bytes)
        class_counts[str(record_bytes)] = class_counts.get(str(record_bytes), 0) + EXPERTS
        for expert in range(EXPERTS):
            role_spans = []
            record_offset = 0
            for role in PROPOSED_ROLE_ORDER:
                source = sources[(layer, role)]
                role_spans.append({
                    "role": role,
                    "tensor": source.tensor,
                    "quant_type": source.quant_type,
                    "quant_name": source.quant_name,
                    "source_shard": source.shard,
                    "source_offset": source.data_offset + expert * source.expert_bytes,
                    "length": source.expert_bytes,
                    "record_offset": record_offset,
                })
                record_offset += source.expert_bytes
            if record_offset != record_bytes:
                raise RuntimeError("role spans do not cover the record exactly")

            next_internal = p1_internal + record_bytes
            next_external = p1_external + record_bytes
            if next_internal * 401 <= next_external * 599:
                p1_volume = "internal"
                p1_offset = p1_internal
                p1_internal = next_internal
            else:
                p1_volume = "external"
                p1_offset = p1_external
                p1_external = next_external

            records.append({
                "key": (layer << 8) | expert,
                "layer": layer,
                "expert": expert,
                "record_bytes": record_bytes,
                "record_sha256": None,
                "source_spans": role_spans,
                "p0": {
                    "internal_offset": p0_internal,
                    "internal_length": internal_length,
                    "external_offset": p0_external,
                    "external_length": external_length,
                },
                "p1": {
                    "volume": p1_volume,
                    "offset": p1_offset,
                    "length": record_bytes,
                },
            })
            p0_internal += internal_length
            p0_external += external_length

    if len(records) != EXPECTED_RECORDS:
        raise RuntimeError(f"expected {EXPECTED_RECORDS} records, built {len(records)}")
    observed = (p0_internal, p0_external, p1_internal, p1_external)
    expected = (
        EXPECTED_P0_INTERNAL,
        EXPECTED_P0_EXTERNAL,
        EXPECTED_P1_INTERNAL,
        EXPECTED_P1_EXTERNAL,
    )
    if observed != expected:
        raise RuntimeError(f"layout totals differ from the frozen lock: {observed} != {expected}")
    if p0_internal + p0_external != EXPECTED_TOTAL or p1_internal + p1_external != EXPECTED_TOTAL:
        raise RuntimeError("packed byte total differs from the frozen geometry")

    return {
        "schema_version": 1,
        "status": "metadata-plan-complete-awaiting-joint-record-order-freeze",
        "payload_bytes_read": 0,
        "pack_files_created": False,
        "model_loaded": False,
        "source_shards": shards,
        "record_contract": {
            "canonical_iteration": "layer-ascending-expert-ascending",
            "proposed_role_order": list(PROPOSED_ROLE_ORDER),
            "role_order_status": "proposed-awaiting-counter-read-and-joint-freeze",
            "alignment_bytes": ALIGNMENT,
            "record_sha256_status": "not-computed-metadata-only-plan",
        },
        "proofs": {
            "source_tensor_count": len(sources),
            "record_count": len(records),
            "expert_dimension_outermost_contiguous": True,
            "expert_stride_equals_expert_bytes": True,
            "all_expert_span_lengths_multiple_of_alignment": True,
            "record_size_distribution": class_counts,
            "physical_expert_bytes_total": EXPECTED_TOTAL,
        },
        "layouts": {
            "p0": {
                "internal_bytes": p0_internal,
                "external_bytes": p0_external,
            },
            "p1": {
                "internal_bytes": p1_internal,
                "external_bytes": p1_external,
            },
        },
        "records": records,
    }


def main() -> None:
    args = parse_args()
    sources, shards = read_sources(args.model_directory)
    result = build_plan(sources, shards)
    write_json_atomic(args.output, result)
    print(json.dumps({
        "status": result["status"],
        "output": str(args.output),
        "payload_bytes_read": result["payload_bytes_read"],
        "records": result["proofs"]["record_count"],
        "layouts": result["layouts"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
