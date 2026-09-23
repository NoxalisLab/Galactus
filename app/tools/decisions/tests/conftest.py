"""Fixtures: a fake tokenizer and a tiny decision model, so no checkpoint is ever downloaded."""
from __future__ import annotations

import sys
import zlib
from pathlib import Path

import pytest
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


class FakeTokenizer:
    mask_token, mask_token_id, cls_token_id, sep_token_id, pad_token_id = "[MASK]", 1, 2, 3, 0

    def __call__(self, text: str, add_special_tokens: bool = False) -> dict:
        return {"input_ids": [4 + zlib.crc32(w.encode()) % 500 for w in text.lower().split()]}


class TinyDecisionModel(torch.nn.Module):
    """Same call signature and output shape as laya's DecisionModel."""

    def __init__(self) -> None:
        super().__init__()
        self.encoder = torch.nn.Embedding(510, 16)
        self.head = torch.nn.Linear(16, 16)

    def forward(self, ids, att, mpos, mmask, qtype):
        h = self.encoder(ids) * att.unsqueeze(-1)
        ctx = self.head(h.sum(1) / att.sum(1, keepdim=True).clamp(min=1))
        opt = self.encoder(ids.gather(1, (mpos + 1).clamp(max=ids.shape[1] - 1)))
        logits = (opt * ctx.unsqueeze(1)).sum(-1)
        return logits.masked_fill(~mmask, -1e4), None


class FakeAgent:
    """What `laya.load()` returns, as far as learn.py and serving.py use it."""

    def __init__(self, answer: str = "code", conf: float = 0.9) -> None:
        self.model, self.tok = TinyDecisionModel(), FakeTokenizer()
        self.cfg, self.device = {"max_len": 128, "head_max_len": 96}, torch.device("cpu")
        self.answer, self.conf, self.calls = answer, conf, []

    def predict(self, state, questions):
        self.calls.append(state)
        rest = (1 - self.conf) / 4
        probs = {t: (self.conf if t == self.answer else rest)
                 for t in ("general", "code", "scripting", "writing", "reasoning")}
        return {"answers": {qid: {"type": "choice", "choice": self.answer,
                                  "probabilities": probs, "confidence": self.conf}
                            for qid in questions}}


@pytest.fixture
def fake_agent() -> FakeAgent:
    return FakeAgent()


@pytest.fixture
def base_dir(tmp_path: Path) -> Path:
    """A directory shaped like a Laya checkpoint (contents are placeholders)."""
    d = tmp_path / "base"
    for sub in ("tokenizer", "encoder"):
        (d / sub).mkdir(parents=True)
        (d / sub / "config.json").write_text("{}")
    (d / "rl_agent_config.json").write_text("{}")
    (d / "model.safetensors").write_bytes(b"")
    return d
