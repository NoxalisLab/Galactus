from __future__ import annotations

import json
from collections import Counter

import numpy as np
import pytest

from evaluation import evaluate
from labeling import (
    InputError,
    Labelled,
    Trace,
    label_traces,
    parse_answer,
    parse_trace,
    read_heuristic,
    read_labelled,
    read_traces,
    teacher_base,
    write_labelled,
)
from task_detection import TASKS, hand_previous_task, split_of, state_for


def test_split_is_deterministic_and_proportioned():
    ids = [f"t-{i}" for i in range(4000)]
    first = [split_of(i) for i in ids]
    assert first == [split_of(i) for i in ids]
    c = Counter(first)
    assert abs(c["train"] / 4000 - 0.60) < 0.03
    assert abs(c["calib"] / 4000 - 0.15) < 0.03
    assert abs(c["test"] / 4000 - 0.25) < 0.03


def test_state_for_keeps_only_known_previous_task():
    assert state_for("hi") == {"message": "hi"}
    assert state_for("hi", "code") == {"message": "hi", "previous_task": "code"}
    assert state_for("hi", "bogus") == {"message": "hi"}
    assert hand_previous_task("hw-0001") in TASKS
    assert hand_previous_task("hw-0001") == hand_previous_task("hw-0001")


def test_parse_trace_shapes():
    t = parse_trace({"id": "a", "state": {"message": "m", "previous_task": "code"},
                     "heuristic": {"task": "writing", "confidence": 0.4},
                     "outcome": {"kind": "manual", "task": "reasoning"}}, "x")
    assert t == Trace("a", "m", "code", "writing", "reasoning")
    t = parse_trace({"id": "b", "text": "m", "heuristic": "code", "outcome": "general"}, "x")
    assert (t.heuristic_task, t.outcome_label, t.previous_task) == ("code", "general", None)
    assert parse_trace({"id": "c", "message": "m", "outcome": {"label": "code"}}, "x"
                       ).outcome_label == "code"
    assert parse_trace({"id": "d", "text": "m", "outcome": {"kind": "refused"}}, "x"
                       ).outcome_label is None
    for bad in ({"text": "m"}, {"id": "e"}, {"id": "e", "text": "  "}, []):
        with pytest.raises(InputError):
            parse_trace(bad, "x")


def test_read_traces_last_row_wins_and_bad_json(tmp_path):
    p = tmp_path / "t.jsonl"
    p.write_text('{"id":"a","text":"x"}\n\n{"id":"a","text":"x","outcome":"code"}\n')
    assert [t.outcome_label for t in read_traces(p)] == ["code"]
    p.write_text('{"id":"a"\n')
    with pytest.raises(InputError, match="t.jsonl:1"):
        read_traces(p)
    with pytest.raises(InputError):
        read_traces(tmp_path / "missing.jsonl")


def test_outcome_overrides_teacher_and_skips_the_call():
    traces = [Trace("a", "x", None, "code", "writing"), Trace("b", "y", None, "code", None),
              Trace("c", "z", None, None, None)]
    asked = []

    def ask(text):
        asked.append(text)
        if text == "z":
            raise OSError("boom")
        return "reasoning"

    rows, counts = label_traces(traces, ask)
    assert asked == ["y", "z"]
    assert [(r.id, r.label, r.source) for r in rows] == [("a", "writing", "outcome"),
                                                         ("b", "reasoning", "teacher")]
    assert counts == {"outcome": 1, "teacher": 1, "unlabelled": 1, "teacher_errors": 1}
    rows, counts = label_traces(traces, None)
    assert counts["outcome"] == 1 and counts["unlabelled"] == 2


def test_labelled_roundtrip_and_override(tmp_path):
    p = tmp_path / "l.jsonl"
    write_labelled([Labelled("a", "x", "code", "train", "code", "teacher", "code", None, "code")], p)
    raw = json.loads(p.read_text())
    raw.update(outcome_label="writing", split="test")  # hand edit: outcome and wrong split
    p.write_text(json.dumps(raw) + "\n")
    (row,) = read_labelled(p)
    assert (row.label, row.source, row.split) == ("writing", "outcome", split_of("a"))
    p.write_text('{"id": "a", "text": "x", "label": "nope"}\n')
    with pytest.raises(InputError):
        read_labelled(p)


@pytest.mark.parametrize("content,want", [
    ('{"task": "code"}', "code"), ("<think>code or writing</think>{\"task\":\"writing\"}", "writing"),
    ("I think this is scripting.", "scripting"), ("code or writing", None), ("", None),
    ('{"task": "other"}', None)])
def test_parse_answer(content, want):
    assert parse_answer(content) == want


def test_teacher_base_and_heuristic_formats(tmp_path):
    assert teacher_base("http://127.0.0.1:9/v1/") == "http://127.0.0.1:9"
    assert teacher_base("http://127.0.0.1:9") == "http://127.0.0.1:9"
    p = tmp_path / "h.json"
    p.write_text('{"a": "code", "b": {"task": "writing"}, "c": "nope"}')
    assert read_heuristic(p) == {"a": "code", "b": "writing"}
    p.write_text('{"id": "a", "task": "code", "confidence": 1}\n{"id": "b", "task": "general"}\n')
    assert read_heuristic(p) == {"a": "code", "b": "general"}
    p.write_text("[1, 2]")
    assert read_heuristic(p) == {}


def _rows(n, labels):
    return [Labelled(f"r{i}", f"text {i}", None, "test", labels[i % len(labels)], "teacher",
                     None, None, None) for i in range(n)]


def test_evaluate_gate_and_skips():
    rows = _rows(80, ["code", "writing"])
    rows.append(Labelled("nohr", "t", None, "test", "code", "outcome", None, "code", None))
    heur = {r.id: "code" for r in rows[:80]}  # 50 % right
    truth = {r.id: r.label for r in rows}

    def perfect(state):
        return truth[state["id"]], 0.99

    rep = evaluate(rows, heur, perfect, lambda r: {"id": r.id})
    assert rep["student"]["n"] == rep["heuristic"]["n"] == 80
    assert rep["skipped_no_heuristic"] == 1
    assert rep["student"]["acc"] == 1.0 and rep["heuristic"]["acc"] == 0.5
    assert rep["student"]["ece"] == pytest.approx(0.01, abs=1e-6)
    assert rep["gate_advisory"]["accepted"] is True
    small = evaluate(rows[:40], heur, perfect, lambda r: {"id": r.id})
    assert small["gate_advisory"] == {"n_test_ok": False, "accuracy_gain_ok": True,
                                      "ece_ok": True, "accepted": False}
    overconf = evaluate(rows[:80], heur, lambda s: ("code", 0.99), lambda r: {"id": r.id})
    assert overconf["gate_advisory"]["accuracy_gain_ok"] is False
    assert overconf["gate_advisory"]["ece_ok"] is False
    assert overconf["by_task"]["code"] == {"n": 40, "student": 1.0, "heuristic": 1.0}


def test_evaluate_uses_recorded_heuristic_when_app_file_lacks_it():
    rows = [Labelled("a", "t", None, "test", "code", "teacher", None, None, "code")]
    rep = evaluate(rows, {}, lambda s: ("writing", 0.6), lambda r: {})
    assert rep["heuristic"]["acc"] == 1.0 and rep["student"]["acc"] == 0.0
    assert np.isfinite(rep["student"]["ece"])
