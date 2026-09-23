"""Fine-tune a Laya checkpoint on the task-detection decision, fit its temperature, save it.

The pip package ships inference only; this rebuilds the training path from its public pieces
(build_sequence, collate_items, proper_reward), so a checkpoint written here loads with the
unmodified `laya.load(path)`.

Objective: maximise Laya's own strictly proper score (log + spherical) in expectation on the
reported distribution. With a known hard label this is the supervised limit of RLCD.
"""
from __future__ import annotations

import json
import random
import shutil
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import torch
from laya.common import QTYPES, build_sequence, collate_items, proper_reward

from task_detection import TASK_QUESTION, TASKS

Q_INTERNAL = {"t": "choice", "ins": TASK_QUESTION["instructions"], "crit": TASK_QUESTION["criteria"]}
TEMPERATURE_BUCKET = "choice:3-5"  # the (qtype, option count) bucket laya.Agent applies


@dataclass(frozen=True)
class Row:
    """One training or calibration example, whatever its origin."""
    id: str
    state: dict[str, str]
    label: str
    source: str  # "hand" | "teacher" | "outcome"


@dataclass
class TrainConfig:
    epochs: int = 5
    batch: int = 8
    lr: float = 3e-5
    head_lr: float = 1e-4
    seed: int = 0
    meta: dict[str, Any] = field(default_factory=dict)


def encode(tok: Any, cfg: dict, rows: list[Row]) -> list[dict]:
    max_len, head_max_len = cfg.get("max_len", 512), cfg.get("head_max_len", 192)
    items = []
    for r in rows:
        ids, markers = build_sequence(tok, r.state, Q_INTERNAL, max_len, head_max_len)
        if len(markers) != len(TASKS):
            raise ValueError(f"{r.id}: options truncated by head_max_len")
        items.append({"ids": ids, "markers": markers, "qtype": QTYPES["choice"],
                      "target": [1.0 if t == r.label else 0.0 for t in TASKS],
                      "label": TASKS.index(r.label)})
    return items


def forward(model: torch.nn.Module, batch: dict, device: torch.device) -> torch.Tensor:
    logits, _ = model(batch["input_ids"].to(device), batch["attention_mask"].to(device),
                      batch["marker_pos"].to(device), batch["marker_mask"].to(device),
                      batch["qtype"].to(device))
    return logits


@torch.no_grad()
def all_logits(model: torch.nn.Module, items: list[dict], pad_id: int, device: torch.device,
               bs: int = 16) -> np.ndarray:
    model.eval()
    out = [forward(model, collate_items([items[i:i + bs]], pad_id), device)[:, :len(TASKS)]
           .float().cpu().numpy() for i in range(0, len(items), bs)]
    return np.concatenate(out) if out else np.zeros((0, len(TASKS)), dtype=np.float32)


def fit_temperature(logits: np.ndarray, labels: np.ndarray) -> float:
    """Grid-search the NLL-minimising temperature inside laya's clamp range [0.5, 5.0]."""
    if len(labels) == 0:
        return 1.0
    best_t, best_nll = 1.0, float("inf")
    for t in np.round(np.arange(0.5, 5.0001, 0.01), 2):
        z = logits / t
        z = z - z.max(1, keepdims=True)
        logp = z - np.log(np.exp(z).sum(1, keepdims=True))
        nll = -logp[np.arange(len(labels)), labels].mean()
        if nll < best_nll:
            best_t, best_nll = float(t), float(nll)
    return best_t


def train(model: torch.nn.Module, tok: Any, cfg: dict, device: torch.device,
          train_rows: list[Row], calib_rows: list[Row], tc: TrainConfig,
          progress: Callable[[float, str], None] = lambda pct, msg: None) -> dict[str, Any]:
    """Train in place; return {temperature, calib_acc, losses}. `progress` gets pct in [0, 100]."""
    random.seed(tc.seed)
    np.random.seed(tc.seed)
    torch.manual_seed(tc.seed)
    pad_id = tok.pad_token_id
    train_items, calib_items = encode(tok, cfg, train_rows), encode(tok, cfg, calib_rows)
    enc = [p for n, p in model.named_parameters() if n.startswith("encoder.")]
    head = [p for n, p in model.named_parameters() if not n.startswith("encoder.")]
    groups = [g for g in ({"params": enc, "lr": tc.lr}, {"params": head, "lr": tc.head_lr})
              if g["params"]]
    opt = torch.optim.AdamW(groups, weight_decay=0.01)
    per_epoch = (len(train_items) + tc.batch - 1) // tc.batch
    steps = max(1, tc.epochs * per_epoch)
    warm = max(1, steps // 10)
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt, lambda s: min(1.0, (s + 1) / warm) * max(0.0, (steps - s) / max(1, steps - warm)))

    calib_labels = np.array([it["label"] for it in calib_items], dtype=int)
    losses: list[float] = []
    calib_acc = float("nan")
    step = 0
    for epoch in range(tc.epochs):
        model.train()
        random.shuffle(train_items)
        epoch_losses = []
        for i in range(0, len(train_items), tc.batch):
            b = collate_items([train_items[i:i + tc.batch]], pad_id)
            logits = forward(model, b, device)
            q = torch.softmax(logits.float().masked_fill(~b["marker_mask"].to(device), -1e4), -1)
            reward = proper_reward(q, b["target"].to(device), b["qtype"].to(device),
                                   b["marker_mask"].to(device).float())
            loss = -reward.mean()
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            step += 1
            epoch_losses.append(float(loss.detach()))
            progress(100.0 * step / steps, f"epoch {epoch + 1}/{tc.epochs}")
        losses.append(float(np.mean(epoch_losses)) if epoch_losses else float("nan"))
        if len(calib_items):
            calib_acc = float((all_logits(model, calib_items, pad_id, device).argmax(1)
                               == calib_labels).mean())
        progress(100.0 * step / steps,
                 f"epoch {epoch + 1}/{tc.epochs} loss={losses[-1]:.4f} calib_acc={calib_acc:.3f}")
    temp = fit_temperature(all_logits(model, calib_items, pad_id, device), calib_labels)
    return {"temperature": temp, "calib_acc": calib_acc, "losses": losses}


def save_checkpoint(model: torch.nn.Module, cfg: dict, base_dir: Path, out: Path,
                    temperature: float, training: dict[str, Any]) -> None:
    """Write a laya-loadable checkpoint atomically: build in a sibling temp dir, then swap."""
    from safetensors.torch import save_file

    tmp = out.with_name(f".{out.name}.partial")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    try:
        for d in ("tokenizer", "encoder"):
            shutil.copytree(base_dir / d, tmp / d)
        new_cfg = dict(cfg)
        new_cfg["temperature_by_options"] = {TEMPERATURE_BUCKET: temperature}
        new_cfg["training"] = training
        (tmp / "rl_agent_config.json").write_text(json.dumps(new_cfg, indent=2) + "\n")
        state = {k: v.detach().to("cpu", torch.float16).contiguous().clone()
                 for k, v in model.state_dict().items()}
        save_file(state, str(tmp / "model.safetensors"))
        if out.exists():
            shutil.rmtree(out)
        tmp.rename(out)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def training_meta(train_rows: list[Row], calib_rows: list[Row], result: dict, tc: TrainConfig,
                  seconds: float) -> dict[str, Any]:
    def count(rows: list[Row]) -> dict[str, int]:
        return {s: sum(r.source == s for r in rows) for s in ("teacher", "outcome", "hand")}

    return {"decision": "task-detection", "objective": "proper_reward (log + spherical)",
            "labels": count(train_rows), "calib_labels": count(calib_rows),
            "train": len(train_rows), "calib": len(calib_rows), "epochs": tc.epochs,
            "seed": tc.seed, "temperature": result["temperature"],
            "calib_acc": None if np.isnan(result["calib_acc"]) else round(result["calib_acc"], 4),
            "seconds": round(seconds), "trained_at": time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                                                   time.gmtime()),
            **tc.meta}
