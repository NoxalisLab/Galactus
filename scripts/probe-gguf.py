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

A split checkpoint (`-00001-of-00003.gguf`) is judged as a whole. Its first
shard often carries the metadata and no tensor at all, and reading it alone
once reported DeepSeek-V4, GLM-5.3 and MiniMax-M3 as dense. When a shard
declares `split.count > 1` and holds no expert tensor, the probe moves on to
the next shard, and stops at the first one that answers.

A fused layout is not enough either: GLM-5.3-Flash ships as `glm5next`, an
architecture the pinned llama.cpp does not know, and a probe that stopped at
the tensor names called its 93 GB usable. The architecture is checked against
the pinned tree's `llama-arch.cpp` when the checkout is there:

  unsupported the engine's llama.cpp has no graph for this architecture

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
from pathlib import Path

# How much of the head to pull. The directory of a 1000-tensor model is well
# under a megabyte; 8 covers a large sharded checkpoint with room to spare, and
# is still three thousand times smaller than the file.
# Eight megabytes answered for every model until Qwen3.6-35B-A3B, whose 256
# experts over 40 layers push the tensor directory past that and made the probe
# report UNKNOWN on a file it could perfectly well have judged. The directory
# sits at the very start of a GGUF, so reading further costs one range request
# and nothing else; the point of this tool is to answer without downloading the
# weights, not to answer within a fixed budget.
HEAD_BYTES = 8 * 1024 * 1024


def head_bytes_for(attempt: int) -> int:
    """8 MB, then 32, then 128. A directory longer than that is a new question."""
    return HEAD_BYTES * (1, 4, 16)[min(attempt, 2)]

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
            raise EOFError("the downloaded head ends before the header does")
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


def fetch_head(url: str, want: int = HEAD_BYTES) -> bytes:
    out = subprocess.run(
        ["curl", "-sL", "--max-time", "180", "-r", f"0-{want - 1}", url],
        capture_output=True,
    )
    if out.returncode != 0 or not out.stdout:
        raise RuntimeError(f"cannot fetch the head of {url}")
    return out.stdout


def read_local(path: str, want: int = HEAD_BYTES) -> bytes:
    with open(path, "rb") as fh:
        return fh.read(want)


def inspect(buf: bytes) -> dict:
    h = Head(buf)
    if h.take(4) != GGUF_MAGIC:
        return {"ok": False, "verdict": "not-gguf", "reason": "the file does not start with GGUF"}
    version = h.u32()
    n_tensors = h.u64()
    n_kv = h.u64()

    arch = ""
    experts = None
    split_count = 1
    for _ in range(n_kv):
        key = h.s()
        vt = h.u32()
        if key == "general.architecture" and vt == 8:
            arch = h.s()
        elif key.endswith(".expert_count") and vt in FIXED:
            raw = h.take(FIXED[vt])
            experts = int.from_bytes(raw, "little")
        elif key == "split.count" and vt in FIXED:
            split_count = int.from_bytes(h.take(FIXED[vt]), "little")
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
        "split_count": split_count,
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


ARCH_TABLE = (Path(__file__).resolve().parent.parent
              / "third_party" / "llama.cpp" / "src" / "llama-arch.cpp")


def known_archs() -> set[str] | None:
    """Architecture names the pinned llama.cpp builds a graph for, or None
    when the checkout is absent and the question cannot be answered."""
    try:
        text = ARCH_TABLE.read_text()
    except OSError:
        return None
    return set(re.findall(r'\{\s*LLM_ARCH_\w+,\s*"([^"]+)"\s*\}', text))


def check_arch(r: dict) -> dict:
    archs = known_archs()
    if r.get("verdict") == "usable" and archs is not None and r.get("arch") not in archs:
        r["verdict"] = "unsupported"
        r["reason"] = (f"architecture {r.get('arch')!r} is unknown to the pinned llama.cpp "
                       f"checkout, the layout alone does not load")
    return r


SHARD_RE = re.compile(r"-(\d{5})-of-(\d{5})\.gguf$")


def probe_one(target: str) -> dict:
    """Judge one file. Raises instead of guessing when it cannot."""
    # Retry wider rather than answering UNKNOWN: the directory sits at
    # the start of the file, so a longer range request is the whole
    # cost, and answering "I could not tell" about a file that could
    # perfectly well be judged is the one outcome this tool must avoid.
    for attempt in range(3):
        want = head_bytes_for(attempt)
        buf = fetch_head(target, want) if target.startswith("http") else read_local(target, want)
        try:
            return inspect(buf)
        except EOFError:
            # inspect RAISES when the buffer ends mid header, it does not
            # return a verdict, so the retry has to catch it. Getting
            # this wrong meant the loop gave up on its first attempt and
            # reported UNKNOWN on a file three lines of code could read.
            continue
    raise EOFError(
        f"the header is longer than {want // (1024 * 1024)} MB, which is "
        "not a tensor directory any more, it is a new question")


def probe_split(target: str) -> dict:
    """Judge a split checkpoint by its shards, not by its metadata shard."""
    r = probe_one(target)
    m = SHARD_RE.search(target)
    if r.get("verdict") != "dense" or r.get("split_count", 1) <= 1 or not m:
        return r
    first, count = int(m.group(1)), int(m.group(2))
    for no in range(first + 1, count + 1):
        sibling = target[: m.start()] + f"-{no:05d}-of-{count:05d}.gguf"
        s = probe_one(sibling)
        if s.get("verdict") in ("usable", "legacy"):
            # Architecture and expert count live in the first shard only.
            s["arch"] = r["arch"]
            s["declared_experts"] = r["declared_experts"]
            s["split_count"] = count
            s["reason"] += f" (read from shard {no} of {count})"
            return s
    r["reason"] += f", in any of the {count} shards"
    return r


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("target", nargs="+", help="an https URL or a local .gguf path")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    results = []
    for target in args.target:
        try:
            r = check_arch(probe_split(target))
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
