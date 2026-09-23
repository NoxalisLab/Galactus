"""Shared definition of the task-detection decision: question, dataset, split, metrics.

The question below is the single source of truth for the typed decision the student (Laya)
answers and the teacher (a local Galactus LLM) is asked. Its option ids are autotask.ts TaskIds.
"""
from __future__ import annotations

import hashlib
import json
import math
import random
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path
from typing import Any

import numpy as np

HERE = Path(__file__).resolve().parent
DATA = HERE / "data" / "prompts_handwritten.txt"
SPLIT = HERE / "data" / "split.json"
DEFAULT_BASE = ("convaiinnovations/laya", "multilingual")
DEFAULT_CKPT = HERE / "checkpoints" / "task-detection"

TASKS: tuple[str, ...] = ("general", "code", "scripting", "writing", "reasoning")

TASK_QUESTION: dict[str, Any] = {
    "type": "choice",
    "instructions": (
        "Which kind of assistant work does the user's `message` ask for? "
        "The message may be in French or English."
    ),
    "criteria": {
        "general": "small talk, a factual question, advice or a recommendation; no program, "
        "no shell, no text to produce, no analysis",
        "code": "write, fix, explain, review or test program source code",
        "scripting": "shell commands, scripts, automation, CI/CD, Docker, servers, installing "
        "or configuring tools",
        "writing": "produce or edit prose: email, letter, article, story, translation, "
        "summary, proofreading, rephrasing",
        "reasoning": "analyse, compare, decide, estimate, prove or solve a logic, math or "
        "business problem",
    },
}
QUESTION_ID = "task"


SPLIT_SALT = "galactus-learning-split:v1"
# Buckets out of 100 for real traces: [0, 60) train, [60, 75) calib, [75, 100) test.
SPLIT_TRAIN, SPLIT_CALIB = 60, 75


def state_for(text: str, previous_task: str | None = None) -> dict[str, str]:
    """The state Laya sees: the user's message and, when known, the task already active.

    The app always sends `previous_task` (detectTask's continuity input); hand-written rows
    get one assigned by `hand_previous_task` so training matches what serving sees.
    """
    state = {"message": text}
    if previous_task in TASKS:
        state["previous_task"] = previous_task
    return state


def _bucket(key: str) -> int:
    digest = hashlib.sha256((SPLIT_SALT + key).encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") % 100


def split_of(trace_id: str) -> str:
    """Deterministic train / calib / test assignment of a real trace, from its id alone."""
    b = _bucket(trace_id)
    if b < SPLIT_TRAIN:
        return "train"
    return "calib" if b < SPLIT_CALIB else "test"


def hand_previous_task(example_id: str) -> str:
    """A fixed, label-independent previous task for a hand-written row (teaches: no shortcut)."""
    return TASKS[_bucket("prev:" + example_id) % len(TASKS)]


@dataclass(frozen=True)
class Example:
    id: str
    text: str
    lang: str
    label: str
    source: str


def load_examples(path: Path = DATA) -> list[Example]:
    out: list[Example] = []
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines()):
        if not line.strip() or line.startswith("#"):
            continue
        label, lang, text = line.split("|", 2)
        if label not in TASKS:
            raise ValueError(f"line {n + 1}: unknown label {label!r}")
        out.append(Example(f"hw-{n + 1:04d}", text.strip(), lang, label, "hand-written"))
    return out


def make_split(examples: list[Example], seed: int = 20260923, test: float = 0.30,
               calib: float = 0.15) -> dict[str, list[str]]:
    """Stratified by (label, lang): test is held out, calib fits the temperature, train trains."""
    rng = random.Random(seed)
    groups: dict[tuple[str, str], list[str]] = {}
    for e in examples:
        groups.setdefault((e.label, e.lang), []).append(e.id)
    split: dict[str, list[str]] = {"train": [], "calib": [], "test": []}
    for key in sorted(groups):
        ids = sorted(groups[key])
        rng.shuffle(ids)
        n_test = round(len(ids) * test)
        n_cal = round(len(ids) * calib)
        split["test"] += ids[:n_test]
        split["calib"] += ids[n_test:n_test + n_cal]
        split["train"] += ids[n_test + n_cal:]
    return split


def load_split(examples: list[Example]) -> dict[str, list[Example]]:
    if not SPLIT.exists():
        SPLIT.write_text(json.dumps(make_split(examples), indent=1) + "\n", encoding="utf-8")
    ids = json.loads(SPLIT.read_text(encoding="utf-8"))
    by_id = {e.id: e for e in examples}
    return {k: [by_id[i] for i in v] for k, v in ids.items()}


def ece(conf: np.ndarray, correct: np.ndarray, bins: int = 10) -> float:
    """Expected Calibration Error, equal-width bins over the top-1 confidence."""
    if len(conf) == 0:
        return math.nan
    edges = np.linspace(0.0, 1.0, bins + 1)
    total = 0.0
    for i, (lo, hi) in enumerate(pairwise(edges)):
        sel = ((conf >= lo) if i == 0 else (conf > lo)) & (conf <= hi)
        if sel.any():
            total += sel.mean() * abs(conf[sel].mean() - correct[sel].mean())
    return float(total)
