"""Student vs heuristic on held-out real traces. numpy only; the model is passed in as a callable.

The heuristic's answers come from the app (detectTask() is never re-implemented here). The gate
itself is decided by the app; `gate_advisory` restates the spec's rule for humans and tests.
"""
from __future__ import annotations

import time
from collections.abc import Callable

import numpy as np

from labeling import Labelled
from task_detection import TASKS, ece

GATE_MIN_N = 60
GATE_MIN_GAIN = 0.03
GATE_MAX_ECE = 0.10

Predict = Callable[[dict[str, str]], tuple[str, float]]


def evaluate(rows: list[Labelled], heuristic: dict[str, str], predict: Predict,
             state_of: Callable[[Labelled], dict[str, str]],
             progress: Callable[[int, int], None] = lambda i, n: None) -> dict:
    """Score both systems on the same rows: those the heuristic answered (app file first,
    then the answer recorded in the trace). Rows without any heuristic answer are skipped."""
    scored = [(r, heuristic.get(r.id) or r.heuristic_task) for r in rows]
    scored = [(r, h) for r, h in scored if h in TASKS]
    y, s_pred, s_conf, h_pred, ms = [], [], [], [], []
    for i, (r, h) in enumerate(scored):
        t0 = time.perf_counter()
        task, conf = predict(state_of(r))
        ms.append((time.perf_counter() - t0) * 1000)
        y.append(r.label)
        s_pred.append(task)
        s_conf.append(float(conf))
        h_pred.append(h)
        progress(i + 1, len(scored))
    n = len(y)
    ya = np.array(y)
    s_ok = (np.array(s_pred) == ya).astype(float) if n else np.zeros(0)
    h_ok = (np.array(h_pred) == ya).astype(float) if n else np.zeros(0)
    s_acc = round(float(s_ok.mean()), 4) if n else 0.0
    h_acc = round(float(h_ok.mean()), 4) if n else 0.0
    s_ece = round(ece(np.array(s_conf), s_ok), 4) if n else 1.0
    labels = {src: sum(r.source == src for r, _ in scored) for src in ("teacher", "outcome", "hand")}
    by_task = {t: {"n": int((ya == t).sum()),
                   "student": round(float(s_ok[ya == t].mean()), 4) if (ya == t).any() else None,
                   "heuristic": round(float(h_ok[ya == t].mean()), 4) if (ya == t).any() else None}
               for t in TASKS}
    gate = {"n_test_ok": n >= GATE_MIN_N,
            "accuracy_gain_ok": n > 0 and s_acc >= h_acc + GATE_MIN_GAIN - 1e-9,
            "ece_ok": n > 0 and s_ece <= GATE_MAX_ECE}
    gate["accepted"] = all(gate.values())
    lat = np.array(ms) if ms else np.zeros(1)
    return {"student": {"acc": s_acc, "ece": s_ece, "n": n,
                        "latency_ms_p50": round(float(np.median(lat)), 2),
                        "latency_ms_p95": round(float(np.percentile(lat, 95)), 2)},
            "heuristic": {"acc": h_acc, "n": n},
            "labels": labels,
            "skipped_no_heuristic": len(rows) - n,
            "by_task": by_task,
            "gate_advisory": gate}
