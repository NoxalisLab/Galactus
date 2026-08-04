#!/usr/bin/env python3
"""Materialize the pinned Galactus H1 Stage 1 corpus.

This script is deterministic. It selects source records with SHA-256 rankings,
renders immutable prompt files, counts tokens with the exact GGUF tokenizer,
and writes a manifest containing all source and renderer provenance.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import subprocess
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


LONG_BENCH_REVISION = "5e628be450b7e67fb7ae6e201bd6d8f7056f7672"
MMMLU_REVISION = "325a01dc3e173cac1578df94120499aaca2e2504"
ULTRACHAT_REVISION = "8049631c405ae6576f93f445c6b8166f76f5505a"
SELECTION_NAMESPACE = "galactus-h1-v1"
RUNTIME_IMPLICIT_SPECIAL_TOKENS = 0
CHAT_TEMPLATE_PREFIX = "[gMASK]<sop>"


@dataclass(frozen=True)
class RenderedCandidate:
    source_index: int
    source_id: str | None
    prompt: str
    source_reported_length: int | None = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--mmmlu-directory", required=True, type=Path)
    parser.add_argument("--ultrachat-parquet", required=True, type=Path)
    parser.add_argument("--render-lock", required=True, type=Path)
    parser.add_argument("--generation-lock", required=True, type=Path)
    parser.add_argument("--proposal", required=True, type=Path)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--tokenizer", required=True, type=Path)
    parser.add_argument("--output-directory", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    return parser.parse_args()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def rank(key: str) -> str:
    return sha256_bytes(f"{SELECTION_NAMESPACE}:{key}".encode())


def seed_for_document(doc_index: int) -> int:
    return int.from_bytes(hashlib.sha256(f"galactus-h1-v1:{doc_index}".encode()).digest()[:4], "big")


def load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as source:
        return json.load(source)


def count_runtime_tokens(tokenizer: Path, model: Path, prompt_path: Path) -> int:
    result = subprocess.run(
        [
            str(tokenizer),
            "--model",
            str(model),
            "--file",
            str(prompt_path),
            "--show-count",
            "--no-escape",
            "--log-disable",
        ],
        check=True,
        capture_output=True,
    )
    marker = b"Total number of tokens:"
    lines = [line for line in result.stdout.splitlines() if line.startswith(marker)]
    if len(lines) != 1:
        raise RuntimeError(f"tokenizer emitted no unique count for {prompt_path}")
    # --no-escape is essential for source code: route-trace reads prompt files
    # byte-for-byte, whereas the tokenizer CLI otherwise interprets backslashes.
    return int(lines[0].split(b":", 1)[1]) + RUNTIME_IMPLICIT_SPECIAL_TOKENS


def write_candidate_for_count(output_directory: Path, key: str, prompt: str) -> tuple[Path, int]:
    path = output_directory / ".selection" / f"{key}.txt"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(prompt, encoding="utf-8")
    return path, len(prompt.encode())


def read_longbench_rows(archive: Path, member: str) -> list[dict[str, Any]]:
    with zipfile.ZipFile(archive) as bundle:
        with bundle.open(member) as source:
            return [json.loads(raw) for raw in source]


def render_longbench_row(row: dict[str, Any], template: str) -> str:
    return template.format(context=row["context"], input=row["input"])


def choose_longbench(
    *,
    archive: Path,
    member: str,
    template: str,
    count_key: str,
    count: int,
    tokenizer: Path,
    model: Path,
    scratch: Path,
    excluded: set[int] | None = None,
) -> list[tuple[RenderedCandidate, int]]:
    excluded = excluded or set()
    rows = read_longbench_rows(archive, member)
    approximate = []
    for index, row in enumerate(rows):
        if index in excluded:
            continue
        reported = int(row.get("length") or 0)
        if reported and not 1400 <= reported <= 10000:
            continue
        approximate.append((rank(f"{count_key}:{index}"), index, row))
    approximate.sort()

    selected: list[tuple[RenderedCandidate, int]] = []
    for _, index, row in approximate:
        prompt = render_longbench_row(row, template)
        candidate = RenderedCandidate(index, row.get("_id"), prompt, row.get("length"))
        temp_path, _ = write_candidate_for_count(scratch, f"{count_key}-{index}", prompt)
        token_count = count_runtime_tokens(tokenizer, model, temp_path)
        if 2000 <= token_count <= 8000:
            selected.append((candidate, token_count))
            if len(selected) == count:
                return selected
    raise RuntimeError(f"only {len(selected)} valid candidates found for {count_key}")


def choose_probe(
    *,
    archive: Path,
    member: str,
    template: str,
    key: str,
    tokenizer: Path,
    model: Path,
    scratch: Path,
    aggregate_pair: bool = False,
) -> tuple[RenderedCandidate, int, list[int]]:
    rows = read_longbench_rows(archive, member)
    approximate = sorted(
        rows,
        key=lambda row: (
            abs(int(row.get("length") or 0) - 32000),
            rank(f"probe:{key}:{row.get('_id', '')}"),
        ),
    )[:128]
    measured: list[tuple[int, str, RenderedCandidate, int]] = []
    index_by_identity = {id(row): index for index, row in enumerate(rows)}
    for row in approximate:
        index = index_by_identity[id(row)]
        prompt = render_longbench_row(row, template)
        candidate = RenderedCandidate(index, row.get("_id"), prompt, row.get("length"))
        temp_path, _ = write_candidate_for_count(scratch, f"probe-{key}-{index}", prompt)
        token_count = count_runtime_tokens(tokenizer, model, temp_path)
        measured.append((abs(token_count - 32000), rank(f"probe:{key}:{index}"), candidate, token_count))
    if not aggregate_pair:
        _, _, candidate, token_count = min(measured, key=lambda item: (item[0], item[1]))
        return candidate, token_count, [candidate.source_index]

    pair_candidates = []
    for left_index, left in enumerate(measured):
        for right in measured[left_index + 1 :]:
            left_candidate, left_tokens = left[2], left[3]
            right_candidate, right_tokens = right[2], right[3]
            pair_candidates.append((
                abs(left_tokens + right_tokens - 32000),
                rank(f"probe-pair:{key}:{left_candidate.source_index}:{right_candidate.source_index}"),
                left_candidate,
                right_candidate,
            ))
    pair_candidates.sort(key=lambda item: (item[0], item[1]))
    exact_pairs = []
    separator = "\n\n--- INDEPENDENT TASK 2 ---\n\n"
    for _, pair_rank, left, right in pair_candidates[:32]:
        prompt = left.prompt + separator + right.prompt
        temp_path, _ = write_candidate_for_count(
            scratch,
            f"probe-{key}-pair-{left.source_index}-{right.source_index}",
            prompt,
        )
        token_count = count_runtime_tokens(tokenizer, model, temp_path)
        exact_pairs.append((abs(token_count - 32000), pair_rank, left, right, prompt, token_count))
    _, _, left, right, prompt, token_count = min(exact_pairs, key=lambda item: (item[0], item[1]))
    source_id = sha256_bytes(f"{left.source_id},{right.source_id}".encode())
    candidate = RenderedCandidate(
        -1,
        source_id,
        prompt,
        (left.source_reported_length or 0) + (right.source_reported_length or 0),
    )
    return candidate, token_count, [left.source_index, right.source_index]


def mmmlu_prompt(locale: str, rows: Iterable[dict[str, str]]) -> str:
    instructions = {
        "FR-FR": "Répondez à chaque question par la lettre choisie et une justification concise.",
        "ZH-CN": "请回答每个问题，给出所选字母和简短理由。",
        "AR-XY": "أجب عن كل سؤال بالحرف المختار مع تبرير موجز.",
        "SW-KE": "Jibu kila swali kwa herufi uliyochagua na sababu fupi.",
    }
    blocks = [instructions[locale]]
    for number, row in enumerate(rows, 1):
        blocks.append(
            f"\n[{number}] ({row['Subject']}) {row['Question']}\n"
            f"A. {row['A']}\nB. {row['B']}\nC. {row['C']}\nD. {row['D']}"
        )
    return "\n".join(blocks) + "\n"


def choose_mmmlu(
    *,
    csv_path: Path,
    locale: str,
    tokenizer: Path,
    model: Path,
    scratch: Path,
) -> tuple[RenderedCandidate, int, list[int]]:
    with csv_path.open(encoding="utf-8-sig", newline="") as source:
        rows = list(csv.DictReader(source))
    ordered = sorted(range(len(rows)), key=lambda index: rank(f"mmmlu:{locale}:{index}"))
    cache: dict[int, tuple[str, int]] = {}

    def measured(prefix_length: int) -> tuple[str, int]:
        if prefix_length not in cache:
            prompt = mmmlu_prompt(locale, (rows[index] for index in ordered[:prefix_length]))
            temp_path, _ = write_candidate_for_count(scratch, f"mmmlu-{locale}-{prefix_length}", prompt)
            cache[prefix_length] = (prompt, count_runtime_tokens(tokenizer, model, temp_path))
        return cache[prefix_length]

    low, high = 1, min(32, len(rows))
    while measured(high)[1] < 4096 and high < len(rows):
        low = high + 1
        high = min(high * 2, len(rows))
    while low < high:
        middle = (low + high) // 2
        _, token_count = measured(middle)
        if token_count < 4096:
            low = middle + 1
        else:
            high = middle
    options = range(max(1, low - 3), min(len(rows), low + 3) + 1)
    prefix_length = min(options, key=lambda length: abs(measured(length)[1] - 4096))
    prompt, token_count = measured(prefix_length)
    if not 2000 <= token_count <= 8000:
        raise RuntimeError(f"MMMLU {locale} aggregation has {token_count} tokens")
    source_indices = ordered[:prefix_length]
    source_id = sha256_bytes(",".join(str(index) for index in source_indices).encode())
    return RenderedCandidate(-1, source_id, prompt), token_count, source_indices


def extract_chat_template(model: Path, repo_root: Path) -> str:
    sys.path.insert(0, str(repo_root / "third_party" / "llama.cpp" / "gguf-py"))
    from gguf import GGUFReader  # type: ignore[import-not-found]

    reader = GGUFReader(str(model), "r")
    return reader.fields["tokenizer.chat_template"].parts[-1].tobytes().decode()


def render_chat(template: str, messages: list[dict[str, str]]) -> str:
    from jinja2 import Environment

    environment = Environment()
    rendered = environment.from_string(template).render(
        messages=messages,
        tools=[],
        add_generation_prompt=True,
    )
    if not rendered.startswith(CHAT_TEMPLATE_PREFIX):
        raise RuntimeError("GLM chat template no longer has the locked implicit prefix")
    return rendered


def choose_ultrachat(
    *,
    parquet_path: Path,
    chat_template: str,
    tokenizer: Path,
    model: Path,
    scratch: Path,
) -> list[tuple[RenderedCandidate, int, int]]:
    import pyarrow.parquet as pq

    rows = pq.read_table(parquet_path, columns=["prompt_id", "messages"]).to_pylist()
    candidates = []
    for index, row in enumerate(rows):
        messages = row["messages"]
        if not messages or messages[-1]["role"] != "assistant":
            continue
        history = messages[:-1]
        if not history or history[-1]["role"] != "user":
            continue
        character_count = sum(len(message["content"]) for message in history)
        if 5000 <= character_count <= 40000:
            candidates.append((rank(f"ultrachat:{index}"), index, row, history))
    candidates.sort()

    selected: list[tuple[RenderedCandidate, int, int]] = []
    for _, index, row, history in candidates[:512]:
        prompt = render_chat(chat_template, history)
        temp_path, _ = write_candidate_for_count(scratch, f"ultrachat-{index}", prompt)
        token_count = count_runtime_tokens(tokenizer, model, temp_path)
        if 2000 <= token_count <= 8000:
            selected.append((RenderedCandidate(index, row["prompt_id"], prompt), token_count, len(history)))
            if len(selected) == 4:
                return selected
    raise RuntimeError(f"only {len(selected)} valid UltraChat candidates found")


def store_document(
    *,
    output_directory: Path,
    document_id: str,
    prompt: str,
    expected_tokens: int,
    tokenizer: Path,
    model: Path,
) -> tuple[Path, str, int]:
    output_path = output_directory / f"{document_id}.txt"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    encoded = prompt.encode()
    output_path.write_bytes(encoded)
    token_count = count_runtime_tokens(tokenizer, model, output_path)
    if token_count != expected_tokens:
        raise RuntimeError(f"token count changed for {document_id}: {expected_tokens} -> {token_count}")
    return output_path, sha256_bytes(encoded), token_count


def main() -> None:
    args = parse_args()
    repo_root = Path(__file__).resolve().parent.parent
    render_lock = load_json(args.render_lock)
    generation_lock = load_json(args.generation_lock)
    proposal = load_json(args.proposal)
    seeds = proposal["objective"]["seed_table"]
    templates = render_lock["templates"]
    args.output_directory.mkdir(parents=True, exist_ok=True)

    documents: list[dict[str, Any]] = []

    def append_document(
        *,
        doc_index: int,
        document_id: str,
        stratum: str,
        candidate: RenderedCandidate,
        token_count: int,
        source_repository: str,
        source_revision: str,
        source_subset: str,
        source_split: str,
        renderer: str,
        generation_tokens: int,
        source_indices: list[int] | None = None,
        chat_history_messages: int | None = None,
    ) -> None:
        output_path, prompt_sha256, verified_tokens = store_document(
            output_directory=args.output_directory,
            document_id=document_id,
            prompt=candidate.prompt,
            expected_tokens=token_count,
            tokenizer=args.tokenizer,
            model=args.model,
        )
        entry: dict[str, Any] = {
            "doc_index": doc_index,
            "document_id": document_id,
            "stratum": stratum,
            "prompt_id": f"stage1/{stratum}/{doc_index:02d}/{document_id}/" +
                ("assistant-boundary" if stratum == "chat" else "continuation"),
            "prompt_path": str(output_path.resolve().relative_to(repo_root)),
            "prompt_sha256": prompt_sha256,
            "prompt_tokens": verified_tokens,
            "generation_tokens": generation_tokens,
            "seed": seeds[doc_index] if doc_index < len(seeds) else seed_for_document(doc_index),
            "source_repository": source_repository,
            "source_revision": source_revision,
            "source_subset": source_subset,
            "source_split": source_split,
            "source_row_index": candidate.source_index,
            "source_row_id": candidate.source_id,
            "source_reported_length": candidate.source_reported_length,
            "renderer": renderer,
            "sampling": generation_lock["sampling"],
        }
        if source_indices is not None:
            entry["source_row_indices"] = source_indices
        if chat_history_messages is not None:
            entry["chat_history_messages"] = chat_history_messages
            entry["chat_held_out_final_assistant"] = True
            entry["embedded_glm_template_prefix"] = CHAT_TEMPLATE_PREFIX
        documents.append(entry)

    coding_rows = read_longbench_rows(args.archive, "data/repobench-p_e.jsonl")
    coding_zero_row = coding_rows[48]
    coding_zero = RenderedCandidate(
        48,
        coding_zero_row.get("_id"),
        render_longbench_row(coding_zero_row, templates["repobench-p"]),
        coding_zero_row.get("length"),
    )
    zero_path, _ = write_candidate_for_count(args.output_directory, "coding-zero", coding_zero.prompt)
    zero_tokens = count_runtime_tokens(args.tokenizer, args.model, zero_path)
    coding = [(coding_zero, zero_tokens)] + choose_longbench(
        archive=args.archive,
        member="data/repobench-p_e.jsonl",
        template=templates["repobench-p"],
        count_key="coding",
        count=3,
        tokenizer=args.tokenizer,
        model=args.model,
        scratch=args.output_directory,
        excluded={48},
    )
    for doc_index, (candidate, token_count) in enumerate(coding):
        append_document(
            doc_index=doc_index,
            document_id=f"coding-repobench-p-e-{candidate.source_index:04d}",
            stratum="coding",
            candidate=candidate,
            token_count=token_count,
            source_repository="zai-org/LongBench",
            source_revision=LONG_BENCH_REVISION,
            source_subset="repobench-p_e",
            source_split="test",
            renderer=f"LongBench/{render_lock['source']['revision']}:repobench-p",
            generation_tokens=256,
        )

    for doc_index, locale in enumerate(("FR-FR", "ZH-CN", "AR-XY", "SW-KE"), 4):
        candidate, token_count, source_indices = choose_mmmlu(
            csv_path=args.mmmlu_directory / f"mmlu_{locale}.csv",
            locale=locale,
            tokenizer=args.tokenizer,
            model=args.model,
            scratch=args.output_directory,
        )
        append_document(
            doc_index=doc_index,
            document_id=f"reasoning-mmmlu-{locale.lower()}",
            stratum="multilingual_reasoning",
            candidate=candidate,
            token_count=token_count,
            source_repository="openai/MMMLU",
            source_revision=MMMLU_REVISION,
            source_subset=locale,
            source_split="test",
            renderer="galactus-mmmlu-v1-no-reference-answers",
            generation_tokens=256,
            source_indices=source_indices,
        )

    long_context_specs = (
        ("qasper_e", "qasper"),
        ("multifieldqa_zh", "multifieldqa_zh"),
        ("gov_report_e", "gov_report"),
        ("passage_retrieval_en_e", "passage_retrieval_en"),
    )
    for doc_index, (subset, renderer_key) in enumerate(long_context_specs, 8):
        candidate, token_count = choose_longbench(
            archive=args.archive,
            member=f"data/{subset}.jsonl",
            template=templates[renderer_key],
            count_key=f"long-context:{subset}",
            count=1,
            tokenizer=args.tokenizer,
            model=args.model,
            scratch=args.output_directory,
        )[0]
        append_document(
            doc_index=doc_index,
            document_id=f"long-context-{subset.replace('_', '-')}-{candidate.source_index:04d}",
            stratum="long_context",
            candidate=candidate,
            token_count=token_count,
            source_repository="zai-org/LongBench",
            source_revision=LONG_BENCH_REVISION,
            source_subset=subset,
            source_split="test",
            renderer=f"LongBench/{render_lock['source']['revision']}:{renderer_key}",
            generation_tokens=256,
        )

    chat_template = extract_chat_template(args.model, repo_root)
    chat_template_sha256 = sha256_bytes(chat_template.encode())
    ultrachat = choose_ultrachat(
        parquet_path=args.ultrachat_parquet,
        chat_template=chat_template,
        tokenizer=args.tokenizer,
        model=args.model,
        scratch=args.output_directory,
    )
    for doc_index, (candidate, token_count, history_messages) in enumerate(ultrachat, 12):
        append_document(
            doc_index=doc_index,
            document_id=f"chat-ultrachat-{candidate.source_index:05d}",
            stratum="chat",
            candidate=candidate,
            token_count=token_count,
            source_repository="HuggingFaceH4/ultrachat_200k",
            source_revision=ULTRACHAT_REVISION,
            source_subset="default",
            source_split="test_sft",
            renderer=f"GLM-5.2-GGUF-chat-template:{chat_template_sha256}",
            generation_tokens=256,
            chat_history_messages=history_messages,
        )

    probe_specs = (
        ("narrativeqa", "narrativeqa"),
        ("passage_retrieval_en", "passage_retrieval_en"),
    )
    for probe_offset, (subset, renderer_key) in enumerate(probe_specs):
        candidate, token_count, source_indices = choose_probe(
            archive=args.archive,
            member=f"data/{subset}.jsonl",
            template=templates[renderer_key],
            key=subset,
            tokenizer=args.tokenizer,
            model=args.model,
            scratch=args.output_directory,
            aggregate_pair=subset == "passage_retrieval_en",
        )
        probe_suffix = "aggregate-2" if candidate.source_index < 0 else f"{candidate.source_index:04d}"
        append_document(
            doc_index=16 + probe_offset,
            document_id=f"probe-{subset.replace('_', '-')}-{probe_suffix}",
            stratum="long_context_probe",
            candidate=candidate,
            token_count=token_count,
            source_repository="zai-org/LongBench",
            source_revision=LONG_BENCH_REVISION,
            source_subset=subset,
            source_split="test",
            renderer=f"LongBench/{render_lock['source']['revision']}:{renderer_key}" +
                ("+galactus-independent-task-pair-v1" if candidate.source_index < 0 else ""),
            generation_tokens=256,
            source_indices=source_indices,
        )

    manifest = {
        "schema_version": 1,
        "status": "materialized",
        "selection_namespace": SELECTION_NAMESPACE,
        "tokenizer_model": str(args.model.resolve().relative_to(repo_root)),
        "token_count_contract": {
            "tool": str(args.tokenizer.resolve().relative_to(repo_root)),
            "route_trace_add_special": True,
            "implicit_special_token_count": RUNTIME_IMPLICIT_SPECIAL_TOKENS,
        },
        "chat_template_sha256": chat_template_sha256,
        "documents": documents,
        "main_prompt_tokens": sum(item["prompt_tokens"] for item in documents[:16]),
        "probe_prompt_tokens": [item["prompt_tokens"] for item in documents[16:]],
    }
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
