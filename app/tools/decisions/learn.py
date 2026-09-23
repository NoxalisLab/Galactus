"""Galactus learned decisions: the single entry point the app runs (task detection first).

    learn.py status   [--checkpoint DIR] [--base DIR]
    learn.py serve    --port P --checkpoint DIR [--host 127.0.0.1] [--device D]
    learn.py splits   --traces traces.jsonl
    learn.py label    --traces traces.jsonl --out labels.jsonl [--teacher-url URL]
    learn.py train    --data labels.jsonl --out DIR [--base DIR] [--no-hand] [--epochs N] ...
    learn.py evaluate --checkpoint DIR --test labels.jsonl [--heuristic-json FILE] [--out FILE]
                      [--threshold 0.6] [--min-chars 8]

stdout carries JSON lines only, one object per line:
    progress  {"event": "progress", "phase", "pct": 0..100, "message"}
    ready     {"event": "ready", "phase": "serve", "pct": 100, "message", "port", "model"}
    result    {"event": "result", "phase", ...}           always the last line on success
    error     {"event": "error", "phase", "code", "message"}  last line on failure
Human-readable diagnostics go to stderr.

Exit codes: 0 ok; 1 internal error; 2 usage error; 3 toolkit missing (torch/laya not importable);
4 bad input (missing or malformed file, missing checkpoint or base, too little data);
5 teacher unreachable; 130 cancelled (SIGINT or SIGTERM; no partial output is left behind).
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time
import traceback
from pathlib import Path
from typing import Any

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

from evaluation import DEFAULT_MIN_CHARS, DEFAULT_THRESHOLD
from labeling import (
    InputError,
    Labelled,
    Teacher,
    TeacherUnavailable,
    label_traces,
    read_heuristic,
    read_labelled,
    read_traces,
    write_labelled,
)
from task_detection import (
    DATA,
    DEFAULT_BASE,
    QUESTION_ID,
    SPLIT,
    TASK_QUESTION,
    load_examples,
    make_split,
    split_of,
    state_for,
)

EXIT_OK, EXIT_INTERNAL, EXIT_USAGE, EXIT_TOOLKIT, EXIT_INPUT, EXIT_TEACHER, EXIT_CANCELLED = (
    0, 1, 2, 3, 4, 5, 130)
BASE_ENV = "GALACTUS_LAYA_BASE"
MIN_TRAIN_ROWS = 20
CHECKPOINT_FILES = ("rl_agent_config.json", "model.safetensors", "tokenizer", "encoder")


class ToolkitMissing(RuntimeError):
    pass


class Cancelled(Exception):
    pass


def emit(obj: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


class Progress:
    """Throttled progress lines: at most one per whole percent, plus every message change."""

    def __init__(self, phase: str) -> None:
        self.phase, self.last = phase, (-1, "")

    def __call__(self, pct: float, message: str) -> None:
        key = (int(pct), message)
        if key != self.last:
            self.last = key
            emit({"event": "progress", "phase": self.phase, "pct": round(min(100.0, pct), 1),
                  "message": message})


def load_toolkit() -> tuple[Any, Any]:
    try:
        import laya
        import torch
    except ImportError as e:
        raise ToolkitMissing(f"learning toolkit not installed ({e.name}): install it from "
                             "Settings > Apprentissage") from e
    return laya, torch


def check_checkpoint(path: Path, what: str) -> Path:
    missing = [f for f in CHECKPOINT_FILES if not (path / f).exists()]
    if missing:
        raise InputError(f"{what} {path} is not a Laya checkpoint (missing {', '.join(missing)})")
    return path


def resolve_base(arg: Path | None) -> Path:
    """--base, else $GALACTUS_LAYA_BASE, else the multilingual base in the local HF cache."""
    if arg is not None:
        return check_checkpoint(arg, "base")
    if os.environ.get(BASE_ENV):
        return check_checkpoint(Path(os.environ[BASE_ENV]), f"${BASE_ENV}")
    try:
        from huggingface_hub import snapshot_download

        root = Path(snapshot_download(DEFAULT_BASE[0], local_files_only=True,
                                      allow_patterns=[f"{DEFAULT_BASE[1]}/*"]))
    except Exception as e:
        raise InputError(f"no base checkpoint: pass --base or set ${BASE_ENV} ({e})") from e
    return check_checkpoint(root / DEFAULT_BASE[1], "base")


def hand_rows(path: Path, holdout_test: bool) -> tuple[list, list]:
    """The hand-written set: phase-1 calib ids calibrate, everything else trains (the phase-1
    test ids too, unless held out to reproduce the phase-1 comparison)."""
    from task_detection import hand_previous_task
    from trainer import Row

    examples = load_examples(path)
    split = (json.loads(SPLIT.read_text(encoding="utf-8")) if path == DATA and SPLIT.is_file()
             else make_split(examples))
    calib, test = set(split["calib"]), set(split["test"])
    train_rows, calib_rows = [], []
    for e in examples:
        if holdout_test and e.id in test:
            continue
        row = Row(e.id, state_for(e.text, hand_previous_task(e.id)), e.label, "hand")
        (calib_rows if e.id in calib else train_rows).append(row)
    return train_rows, calib_rows


def hand_test_rows(path: Path) -> list[Labelled]:
    from task_detection import hand_previous_task

    examples = load_examples(path)
    split = (json.loads(SPLIT.read_text(encoding="utf-8")) if path == DATA and SPLIT.is_file()
             else make_split(examples))
    test = set(split["test"])
    return [Labelled(e.id, e.text, hand_previous_task(e.id), "test", e.label, "hand", None, None,
                     None) for e in examples if e.id in test]


def trace_rows(rows: list[Labelled]) -> tuple[list, list, int]:
    from trainer import Row

    train_rows, calib_rows, test = [], [], 0
    for r in rows:
        row = Row(r.id, state_for(r.text, r.previous_task), r.label, r.source)
        if r.split == "train":
            train_rows.append(row)
        elif r.split == "calib":
            calib_rows.append(row)
        else:
            test += 1  # never trained on: the gate's held-out set
    return train_rows, calib_rows, test


# ---------------------------------------------------------------- subcommands


def cmd_status(args: argparse.Namespace) -> dict:
    from importlib import metadata

    packages = {}
    for p in ("torch", "laya", "transformers", "safetensors", "numpy", "huggingface_hub"):
        try:
            packages[p] = metadata.version(p)
        except metadata.PackageNotFoundError:
            packages[p] = None
    out: dict[str, Any] = {"python": sys.version.split()[0], "packages": packages,
                           "toolkit_ok": all(packages.values())}
    if not out["toolkit_ok"]:
        raise ToolkitMissing("missing packages: " + ", ".join(k for k, v in packages.items()
                                                              if v is None))
    import torch

    out["device"] = ("cuda" if torch.cuda.is_available() else
                     "mps" if torch.backends.mps.is_available() else "cpu")
    try:
        out["base"] = {"path": str(resolve_base(args.base)), "ok": True}
    except InputError as e:
        out["base"] = {"path": None, "ok": False, "message": str(e)}
    if args.checkpoint is not None:
        ck: dict[str, Any] = {"path": str(args.checkpoint), "ok": False, "training": None}
        try:
            check_checkpoint(args.checkpoint, "checkpoint")
            cfg = json.loads((args.checkpoint / "rl_agent_config.json").read_text())
            ck.update(ok=True, training=cfg.get("training"))
        except (InputError, ValueError) as e:
            ck["message"] = str(e)
        out["checkpoint"] = ck
    return out


def cmd_splits(args: argparse.Namespace) -> dict:
    """Count traces per split, without teacher or model (the app checks n_test first)."""
    traces = read_traces(args.traces)
    splits = {"train": 0, "calib": 0, "test": 0}
    with_outcome = {"train": 0, "calib": 0, "test": 0}
    for t in traces:
        s = split_of(t.id)
        splits[s] += 1
        with_outcome[s] += t.outcome_label is not None
    return {"traces": len(traces), "splits": splits,
            "with_outcome": sum(with_outcome.values()), "with_outcome_by_split": with_outcome}


def cmd_label(args: argparse.Namespace) -> dict:
    progress = Progress("label")
    traces = read_traces(args.traces)
    need_teacher = any(t.outcome_label is None for t in traces)
    teacher = Teacher(args.teacher_url) if args.teacher_url and need_teacher else None
    progress(0, f"{len(traces)} traces" + (f", teacher {teacher.model}" if teacher else ""))
    rows, counts = label_traces(traces, teacher.ask if teacher else None,
                                lambda i, n: progress(100.0 * i / max(1, n), f"{i}/{n}"))
    write_labelled(rows, args.out)
    splits = {s: sum(r.split == s for r in rows) for s in ("train", "calib", "test")}
    return {"out": str(args.out), "traces": len(traces), "labelled": len(rows),
            "labels": {"teacher": counts["teacher"], "outcome": counts["outcome"], "hand": 0},
            "unlabelled": counts["unlabelled"], "teacher_errors": counts["teacher_errors"],
            "teacher_model": teacher.model if teacher else None, "splits": splits}


def cmd_train(args: argparse.Namespace) -> dict:
    laya, _ = load_toolkit()
    import trainer

    progress = Progress("train")
    base = resolve_base(args.base)
    rows = read_labelled(args.data) if args.data is not None else []
    tr_train, tr_calib, n_test = trace_rows(rows)
    hd_train, hd_calib = ([], []) if args.no_hand else hand_rows(args.hand, args.hand_holdout)
    train_rows, calib_rows = hd_train + tr_train, hd_calib + tr_calib
    if len(train_rows) < MIN_TRAIN_ROWS:
        raise InputError(f"only {len(train_rows)} training rows (need {MIN_TRAIN_ROWS})")
    progress(0, f"loading base {base.name}; train={len(train_rows)} calib={len(calib_rows)} "
                f"held-out test traces={n_test}")
    t0 = time.time()
    agent = laya.load(str(base), device=args.device)
    tc = trainer.TrainConfig(epochs=args.epochs, batch=args.batch, lr=args.lr,
                             head_lr=args.head_lr, seed=args.seed,
                             meta={"base": str(base), "test_traces_held_out": n_test})
    result = trainer.train(agent.model, agent.tok, agent.cfg, agent.device, train_rows,
                           calib_rows, tc, lambda pct, msg: progress(pct * 0.97, msg))
    meta = trainer.training_meta(train_rows, calib_rows, result, tc, time.time() - t0)
    progress(98, "saving checkpoint")
    trainer.save_checkpoint(agent.model, agent.cfg, base, args.out, result["temperature"], meta)
    return {"checkpoint": str(args.out), "labels": meta["labels"], "train": len(train_rows),
            "calib": len(calib_rows), "test_held_out": n_test,
            "temperature": result["temperature"], "calib_acc": meta["calib_acc"],
            "losses": [round(x, 4) for x in result["losses"]], "seconds": meta["seconds"],
            "device": str(agent.device)}


def cmd_evaluate(args: argparse.Namespace) -> dict:
    laya, _ = load_toolkit()
    from evaluation import evaluate

    progress = Progress("evaluate")
    ckpt = check_checkpoint(args.checkpoint, "checkpoint")
    if args.hand_test:
        rows = hand_test_rows(args.hand)
    else:
        if args.test is None:
            raise InputError("--test is required (or --hand-test)")
        rows = [r for r in read_labelled(args.test) if r.split == "test"]
    heuristic = read_heuristic(args.heuristic_json) if args.heuristic_json else {}
    progress(0, f"loading {ckpt.name}; {len(rows)} test rows")
    agent = laya.load(str(ckpt), device=args.device)
    questions = {QUESTION_ID: TASK_QUESTION}

    def predict(state: dict[str, str]) -> tuple[str, float]:
        a = agent.predict(state, questions)["answers"][QUESTION_ID]
        return a["choice"], max(a["probabilities"].values())

    if rows:
        predict(state_for(rows[0].text, rows[0].previous_task))  # warm-up, not timed
    report = evaluate(rows, heuristic, predict, lambda r: state_for(r.text, r.previous_task),
                      lambda i, n: progress(100.0 * i / max(1, n), f"{i}/{n}"),
                      threshold=args.threshold, min_chars=args.min_chars)
    report.update(checkpoint=str(ckpt), device=str(agent.device),
                  test_set="hand-written phase-1 test split" if args.hand_test
                  else "real traces, hash split")
    if args.out:
        args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def cmd_serve(args: argparse.Namespace) -> None:
    from serving import LOOPBACK, Engine, make_server

    if args.host not in LOOPBACK:
        raise InputError("refusing to bind a non-loopback address: decisions stay local")
    laya, _ = load_toolkit()
    ckpt = check_checkpoint(args.checkpoint, "checkpoint")
    engine = Engine(laya.load(str(ckpt), device=args.device), str(ckpt))
    engine.decide(state_for("warm-up", "general"), {QUESTION_ID: TASK_QUESTION})
    srv = make_server(engine, args.host, args.port)
    emit({"event": "ready", "phase": "serve", "pct": 100, "message": "ready",
          "port": srv.server_address[1], "model": engine.name,
          "device": str(engine.agent.device)})
    try:
        srv.serve_forever()
    except (KeyboardInterrupt, Cancelled):
        pass
    finally:
        srv.server_close()


# ---------------------------------------------------------------- CLI


def parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="learn.py", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("status", help="toolkit, device, base and checkpoint state")
    p.add_argument("--checkpoint", type=Path)
    p.add_argument("--base", type=Path)

    p = sub.add_parser("serve", help="loopback decision service")
    p.add_argument("--port", type=int, required=True, help="0 picks a free port")
    p.add_argument("--checkpoint", type=Path, required=True)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--device")

    p = sub.add_parser("splits", help="count traces per train/calib/test split (no model)")
    p.add_argument("--traces", type=Path, required=True)

    p = sub.add_parser("label", help="label traces: outcome first, else the teacher")
    p.add_argument("--traces", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--teacher-url", default="", help="OpenAI-compatible root or /v1 URL; "
                   "empty keeps outcome labels only")

    p = sub.add_parser("train", help="fine-tune on hand set + labelled traces")
    p.add_argument("--data", type=Path, help="labelled JSONL from `label` (optional)")
    p.add_argument("--out", type=Path, required=True, help="checkpoint dir (replaced)")
    p.add_argument("--base", type=Path, help=f"base checkpoint dir (default ${BASE_ENV})")
    p.add_argument("--hand", type=Path, default=DATA)
    p.add_argument("--no-hand", action="store_true")
    p.add_argument("--hand-holdout", action="store_true",
                   help="keep the phase-1 hand test split out of training")
    p.add_argument("--epochs", type=int, default=5)
    p.add_argument("--batch", type=int, default=8)
    p.add_argument("--lr", type=float, default=3e-5)
    p.add_argument("--head-lr", type=float, default=1e-4)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--device")

    p = sub.add_parser("evaluate", help="student vs heuristic on the held-out test traces")
    p.add_argument("--checkpoint", type=Path, required=True)
    p.add_argument("--test", type=Path, help="labelled JSONL; only its hash-split test rows count")
    p.add_argument("--heuristic-json", type=Path, help='{"<id>": "<task>"} from detectTask()')
    p.add_argument("--hand-test", action="store_true",
                   help="evaluate on the phase-1 hand test split instead of traces")
    p.add_argument("--hand", type=Path, default=DATA)
    p.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD,
                   help="policy: student answers at or above this confidence")
    p.add_argument("--min-chars", type=int, default=DEFAULT_MIN_CHARS,
                   help="policy: shorter messages go to the heuristic")
    p.add_argument("--out", type=Path, help="also write the report to this file")
    p.add_argument("--device")
    return ap


def _on_sigterm(signum: int, frame: Any) -> None:
    raise Cancelled()


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    signal.signal(signal.SIGTERM, _on_sigterm)
    phase = args.cmd
    commands = {"status": cmd_status, "splits": cmd_splits, "label": cmd_label,
                "train": cmd_train, "evaluate": cmd_evaluate}
    try:
        if phase == "serve":
            cmd_serve(args)
            return EXIT_OK
        emit({"event": "result", "phase": phase, **commands[phase](args)})
        return EXIT_OK
    except (Cancelled, KeyboardInterrupt):
        code, msg = EXIT_CANCELLED, "cancelled"
    except ToolkitMissing as e:
        code, msg = EXIT_TOOLKIT, str(e)
    except (InputError, FileNotFoundError) as e:
        code, msg = EXIT_INPUT, str(e)
    except TeacherUnavailable as e:
        code, msg = EXIT_TEACHER, str(e)
    except Exception as e:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        code, msg = EXIT_INTERNAL, f"{type(e).__name__}: {e}"
    print(f"learn.py {phase}: {msg}", file=sys.stderr)
    emit({"event": "error", "phase": phase, "code": code, "message": msg})
    return code


if __name__ == "__main__":
    sys.exit(main())
