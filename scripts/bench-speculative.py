#!/usr/bin/env python3
"""Measure what speculative decoding buys, against the same server without it.

A draft head (MTP, dspark, ...) proposes N tokens, the model verifies them in
one batch. It pays when the verifier is compute-bound per token and the draft
is accepted often; it costs when acceptance is low or when the verification
batch has to wait on the SSD. docs/PHYSICAL-MODEL.md closed speculation for
GLM-5.2 streamed from SSD. This script asks the question again, per model and
per regime, and answers with numbers only: the same prompts, greedy sampling,
the same server binary, with and without the draft, N passes each.

Usage:
  python3 scripts/bench-speculative.py --gguf <model.gguf> --spec-type draft-mtp \
      --n-max 1 2 3 [--passes 3] [--label qwen36-mtp] [-- extra llama-server args]
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import statistics
import subprocess
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
SERVER = ROOT / "third_party" / "llama.cpp" / "build" / "bin" / "llama-server"
OUT_DIR = ROOT / "artifacts" / "h4" / "bench" / "speculative"
PORT = 18123

# Three kinds of text, because acceptance depends on how predictable the
# continuation is: code is repetitive, French prose is not, reasoning is between.
PROMPTS = {
    "code": "Write a Python function that parses an ISO-8601 duration string such as "
            "P3DT4H12M into a datetime.timedelta, with type hints, docstring and tests.",
    "prose-fr": "Rédige un paragraphe de 200 mots expliquant à un dirigeant non technique "
                "pourquoi une IA locale peut protéger les données de son entreprise.",
    "reasoning": "A train leaves at 14:05 at 92 km/h, another at 14:35 at 118 km/h on the "
                 "same track from the same station. When and where does the second catch up? "
                 "Show the steps.",
}
PREDICT = 256


def post(path: str, body: dict) -> dict:
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=900) as r:
        return json.loads(r.read())


def wait_ready(proc: subprocess.Popen, log: pathlib.Path) -> None:
    for _ in range(600):
        if proc.poll() is not None:
            sys.exit(f"server exited, see {log}")
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=2) as r:
                if b"ok" in r.read():
                    return
        except OSError:
            pass
        time.sleep(1)
    sys.exit(f"server never became ready, see {log}")


def run(label: str, gguf: str, spec: list[str], passes: int, extra: list[str]) -> dict:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    log = OUT_DIR / f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{label}.server.log"
    args = [str(SERVER), "--model", gguf, "--host", "127.0.0.1", "--port", str(PORT),
            "--ctx-size", "8192", "--n-gpu-layers", "99", "--parallel", "1",
            "--jinja", "--reasoning-format", "none", *spec, *extra]
    with log.open("wb") as fh:
        proc = subprocess.Popen(args, stdout=fh, stderr=subprocess.STDOUT,
                                env={**os.environ, "LC_ALL": "C"})
    try:
        wait_ready(proc, log)
        rows = {}
        for name, prompt in PROMPTS.items():
            tps, acc = [], []
            post("/completion", {"prompt": prompt, "n_predict": 16, "temperature": 0})  # warm
            for _ in range(passes):
                r = post("/completion", {"prompt": prompt, "n_predict": PREDICT,
                                         "temperature": 0, "cache_prompt": False})
                t = r.get("timings", {})
                tps.append(t.get("predicted_per_second", 0.0))
                if t.get("draft_n"):
                    acc.append(t.get("draft_n_accepted", 0) / t["draft_n"])
            rows[name] = {"gen_tps_median": round(statistics.median(tps), 2),
                          "gen_tps": [round(x, 2) for x in tps],
                          "draft_acceptance": round(statistics.mean(acc), 3) if acc else None}
        return {"label": label, "spec": spec, "rows": rows, "log": str(log)}
    finally:
        proc.terminate()
        proc.wait(timeout=60)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gguf", required=True)
    ap.add_argument("--spec-type", required=True)
    ap.add_argument("--n-max", type=int, nargs="+", default=[1, 2, 3])
    ap.add_argument("--passes", type=int, default=3)
    ap.add_argument("--label", default="model")
    ap.add_argument("extra", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    extra = [x for x in a.extra if x != "--"]
    results = [run(f"{a.label}-baseline", a.gguf, [], a.passes, extra)]
    for n in a.n_max:
        results.append(run(f"{a.label}-{a.spec_type}-n{n}", a.gguf,
                           ["--spec-type", a.spec_type, "--spec-draft-n-max", str(n)],
                           a.passes, extra))
    base = results[0]["rows"]
    print(f"\n{'config':<34}" + "".join(f"{k:>22}" for k in PROMPTS))
    for r in results:
        cells = []
        for k in PROMPTS:
            row = r["rows"][k]
            gain = row["gen_tps_median"] / base[k]["gen_tps_median"] if base[k]["gen_tps_median"] else 0
            acc = f" a{row['draft_acceptance']:.2f}" if row["draft_acceptance"] is not None else ""
            cells.append(f"{row['gen_tps_median']:7.1f} x{gain:4.2f}{acc:>6}")
        print(f"{r['label']:<34}" + "".join(f"{c:>22}" for c in cells))
    out = OUT_DIR / f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{a.label}.json"
    out.write_text(json.dumps(results, indent=2) + "\n")
    print(f"\nresults {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
