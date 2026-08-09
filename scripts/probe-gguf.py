#!/usr/bin/env python3
"""Read a GGUF's header over HTTP, before downloading the weights.

WHY THIS EXISTS

A 26 GB download finished, and only then did the profiler report that the file
was unusable: TheBloke's 2023 Mixtral quantization stores experts as 768
separate per-expert tensors, from before llama.cpp merged them into fused
`*_exps` tensors, and the engine intercepts the fused ones. Nothing about the
repository page says which layout a file uses. The answer was in the first few
megabytes the whole time.

A GGUF puts its magic, its metadata and its full tensor directory at the very
start of the file, weights afterwards. Servers that support range requests,
which Hugging Face does, will hand back just that prefix. So the question "can
the engine use this file" costs a few megabytes and a second, instead of an
hour and a full disk.

WHAT IT ANSWERS

  usable      the tensor directory contains fused `blk.N.ffn_*_exps` tensors
  legacy      it contains per-expert `blk.N.ffn_*.K.weight` tensors instead,
              a pre-2024 quantization the engine cannot wire
  dense       no expert tensors at all, so there is nothing to stream

Usage:
  python3 scripts/probe-gguf.py https://huggingface.co/.../model.gguf
  python3 scripts/probe-gguf.py --json <url> [<url> ...]
"""
from __future__ import annotations

import argparse
import json
import re
import struct
import subprocess
import sys

# How much of the head to pull. The directory of a 1000-tensor model is well
# under a megabyte; 8 covers a large sharded checkpoint with room to spare, and
# is still three thousand times smaller than the file.
HEAD_BYTES = 8 * 1024 * 1024

GGUF_MAGIC = b"GGUF"
# Value type sizes, indexed by the GGUF type enum. Strings and arrays are
# variable and handled separately.
FIXED = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}


class Head:
    """A cursor over the downloaded prefix that refuses to read past it.

    Running out of prefix is a normal outcome, not a crash: a checkpoint with
    an unusually large directory simply needs a bigger window, and the caller
    is told that rather than shown a traceback.
    """

    def __init__(self, buf: bytes) -> None:
        self.b, self.i = buf, 0

    def take(self, n: int) -> bytes:
        if self.i + n > len(self.b):
            raise EOFError("the downloaded head stops before the tensor directory does")
        out = self.b[self.i : self.i + n]
        self.i += n
        return out

    def u32(self) -> int:
        return struct.unpack("<I", self.take(4))[0]

    def u64(self) -> int:
        return struct.unpack("<Q", self.take(8))[0]

    def s(self) -> str:
        return self.take(self.u64()).decode("utf-8", "replace")

    def skip_value(self, vt: int) -> None:
        if vt == 8:
            self.s()
        elif vt == 9:
            et = self.u32()
            for _ in range(self.u64()):
                self.skip_value(et)
        else:
            self.take(FIXED[vt])


def fetch_head(url: str) -> bytes:
    out = subprocess.run(
        ["curl", "-sL", "--max-time", "90", "-r", f"0-{HEAD_BYTES - 1}", url],
        capture_output=True,
    )
    if out.returncode != 0 or not out.stdout:
        raise RuntimeError(f"cannot fetch the head of {url}")
    return out.stdout


def read_local(path: str) -> bytes:
    with open(path, "rb") as fh:
        return fh.read(HEAD_BYTES)


def inspect(buf: bytes) -> dict:
    h = Head(buf)
    if h.take(4) != GGUF_MAGIC:
        return {"ok": False, "verdict": "not-gguf", "reason": "the file does not start with GGUF"}
    version = h.u32()
    n_tensors = h.u64()
    n_kv = h.u64()

    arch = ""
    experts = None
    for _ in range(n_kv):
        key = h.s()
        vt = h.u32()
        if key == "general.architecture" and vt == 8:
            arch = h.s()
        elif key.endswith(".expert_count") and vt in FIXED:
            raw = h.take(FIXED[vt])
            experts = int.from_bytes(raw, "little")
        else:
            h.skip_value(vt)

    names: list[str] = []
    for _ in range(n_tensors):
        nm = h.s()
        nd = h.u32()
        h.take(8 * nd)
        h.take(4)  # ggml type
        h.take(8)  # offset
        names.append(nm)

    fused = [n for n in names if re.search(r"ffn_(gate|up|down)_exps", n)]
    per_expert = [n for n in names if re.search(r"ffn_(gate|up|down)\.\d+\.weight$", n)]

    res = {
        "ok": True,
        "gguf_version": version,
        "arch": arch,
        "tensors": n_tensors,
        "declared_experts": experts,
        "fused_expert_tensors": len(fused),
        "per_expert_tensors": len(per_expert),
    }
    if fused:
        res.update(verdict="usable",
                   reason=f"{len(fused)} fused expert tensors: the engine can wire this")
    elif per_expert:
        res.update(verdict="legacy",
                   reason=f"{len(per_expert)} per-expert tensors and no fused ones: a "
                          f"pre-2024 quantization, requantize with a current llama.cpp")
    else:
        res.update(verdict="dense",
                   reason="no expert tensors: a dense model, nothing to stream")
    return res


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("target", nargs="+", help="an https URL or a local .gguf path")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    results = []
    for target in args.target:
        try:
            buf = fetch_head(target) if target.startswith("http") else read_local(target)
            r = inspect(buf)
        except Exception as e:  # a probe that fails must say so, not guess
            r = {"ok": False, "verdict": "unknown", "reason": str(e)}
        r["target"] = target
        results.append(r)
        if not args.json:
            short = target.rsplit("/", 1)[-1]
            print(f"{r['verdict'].upper():7} {short}")
            print(f"        {r['reason']}")
            if r.get("ok"):
                print(f"        arch {r['arch']}, {r['tensors']} tensors, "
                      f"{r.get('declared_experts')} declared experts")
    if args.json:
        print(json.dumps(results, indent=2))
    return 0 if all(r.get("verdict") == "usable" for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
