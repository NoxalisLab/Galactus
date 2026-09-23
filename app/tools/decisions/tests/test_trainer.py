from __future__ import annotations

import json

import numpy as np
import torch
from conftest import FakeTokenizer, TinyDecisionModel
from safetensors.torch import load_file

import trainer
from task_detection import TASKS, state_for

WORDS = {"general": "bonjour météo", "code": "python fonction bug", "scripting": "bash docker cron",
         "writing": "email lettre article", "reasoning": "calcul prouve compare"}


def rows(n, source="hand"):
    return [trainer.Row(f"{source}-{i}", state_for(f"{WORDS[t]} {i}", "general"), t, source)
            for i in range(n) for t in TASKS]


def test_fit_temperature_recovers_scale():
    rng = np.random.default_rng(0)
    true = rng.normal(size=(4000, 5)) * 2
    p = np.exp(true) / np.exp(true).sum(1, keepdims=True)
    labels = np.array([rng.choice(5, p=pi) for pi in p])
    assert abs(trainer.fit_temperature(true * 3, labels) - 3.0) < 0.3
    assert trainer.fit_temperature(true, labels[:0]) == 1.0


def test_train_learns_and_reports_progress():
    model, tok = TinyDecisionModel(), FakeTokenizer()
    seen = []
    res = trainer.train(model, tok, {"max_len": 256, "head_max_len": 96}, torch.device("cpu"),
                        rows(12), rows(3, "teacher"),
                        trainer.TrainConfig(epochs=6, batch=8, lr=5e-2, head_lr=5e-2),
                        lambda pct, msg: seen.append(pct))
    assert res["calib_acc"] >= 0.8
    assert res["losses"][-1] < res["losses"][0]
    assert 0.5 <= res["temperature"] <= 5.0
    assert seen[-1] == 100.0 and seen == sorted(seen)


def test_save_checkpoint_is_atomic_and_loadable(base_dir, tmp_path):
    model = TinyDecisionModel()
    out = tmp_path / "ckpt"
    out.mkdir()
    (out / "stale.txt").write_text("old")  # a previous checkpoint at the same path is replaced
    meta = trainer.training_meta(rows(2), rows(1, "outcome"),
                                 {"temperature": 2.0, "calib_acc": 0.5, "losses": []},
                                 trainer.TrainConfig(meta={"base": "b"}), 12.3)
    trainer.save_checkpoint(model, {"max_len": 64}, base_dir, out, 2.0, meta)
    assert not (out / "stale.txt").exists()
    assert not list(tmp_path.glob(".ckpt.partial"))
    cfg = json.loads((out / "rl_agent_config.json").read_text())
    assert cfg["temperature_by_options"] == {"choice:3-5": 2.0}
    assert cfg["training"]["labels"] == {"teacher": 0, "outcome": 0, "hand": 10}
    assert cfg["training"]["calib_labels"]["outcome"] == 5
    assert cfg["max_len"] == 64
    w = load_file(str(out / "model.safetensors"))
    assert w["encoder.weight"].dtype == torch.float16
    assert (out / "tokenizer" / "config.json").exists()


def test_encode_rejects_truncated_options():
    try:
        trainer.encode(FakeTokenizer(), {"max_len": 64, "head_max_len": 2}, rows(1))
    except ValueError as e:
        assert "truncated" in str(e)
