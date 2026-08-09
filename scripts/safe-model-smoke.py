#!/usr/bin/env python3
"""Smoke-test one Galactus model while enforcing a macOS memory stop gate.

The harness starts exactly one ``galactus serve`` process group, waits for its
local health endpoint, performs a short OpenAI-compatible generation, records
memory pressure/RSS/swap samples, then always tears the process group down.
It has no third-party dependencies.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


FREE_RE = re.compile(r"System-wide memory free percentage:\s*(\d+)%")
SWAP_RE = re.compile(r"used\s*=\s*([0-9.]+)M")


def capture(*args: str) -> str:
    return subprocess.run(args, check=False, capture_output=True, text=True).stdout


def free_percent() -> int | None:
    match = FREE_RE.search(capture("memory_pressure", "-Q"))
    return int(match.group(1)) if match else None


def swap_used_mb() -> float | None:
    match = SWAP_RE.search(capture("sysctl", "vm.swapusage"))
    return float(match.group(1)) if match else None


def galactus_servers(root: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    root_text = str(root)
    for line in capture("ps", "ax", "-o", "pid=,ppid=,rss=,command=").splitlines():
        fields = line.strip().split(None, 3)
        if len(fields) != 4:
            continue
        pid_text, ppid_text, rss_text, command = fields
        if "llama-server" not in command or root_text not in command:
            continue
        try:
            rows.append(
                {
                    "pid": int(pid_text),
                    "ppid": int(ppid_text),
                    "rss_bytes": int(rss_text) * 1024,
                    "command": command,
                }
            )
        except ValueError:
            continue
    return rows


def health(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as response:
            return response.status == 200
    except (OSError, urllib.error.URLError):
        return False


def generate(port: int, prompt: str, max_tokens: int, result: dict[str, Any]) -> None:
    payload = json.dumps(
        {
            "model": "galactus-local",
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0,
            "max_tokens": max_tokens,
            "stream": False,
        }
    ).encode()
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/v1/chat/completions",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            body = json.loads(response.read())
        result.update({"ok": True, "response": body, "wall_seconds": time.monotonic() - started})
    except Exception as error:  # the result is serialized for the audit report
        result.update({"ok": False, "error": str(error), "wall_seconds": time.monotonic() - started})


def warm_and_generate(port: int, prompt: str, max_tokens: int, result: dict[str, Any]) -> None:
    warmup: dict[str, Any] = {}
    generate(port, "Réponds uniquement par OK.", 4, warmup)
    if not warmup.get("ok"):
        result.update({"ok": False, "error": f"warm-up failed: {warmup.get('error', 'unknown error')}"})
        return
    generate(port, prompt, max_tokens, result)


def stop_group(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=8)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("model")
    parser.add_argument("--ram", choices=("eco", "balanced", "perf"), default="eco")
    parser.add_argument("--slots", type=int, default=1)
    parser.add_argument("--port", type=int, default=8091)
    parser.add_argument("--max-tokens", type=int, default=24)
    parser.add_argument("--prompt", default="Réponds uniquement par OK.")
    parser.add_argument("--startup-timeout", type=int, default=900)
    parser.add_argument("--danger-free-percent", type=int, default=5)
    parser.add_argument("--danger-seconds", type=int, default=10)
    parser.add_argument("--hard-rss-gib", type=float, default=125.0)
    parser.add_argument("--swap-growth-mib", type=float, default=2048.0)
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[1]
    cli = root / "app/src-tauri/target/release/galactus"
    if not cli.is_file():
        parser.error(f"release CLI missing: {cli}")
    existing = galactus_servers(root)
    if existing:
        parser.error(f"refusing to overlap {len(existing)} existing Galactus server(s)")

    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = root / ".gstack/model-smoke"
    out_dir.mkdir(parents=True, exist_ok=True)
    log_path = out_dir / f"{stamp}-{args.model}.server.log"
    report_path = out_dir / f"{stamp}-{args.model}.json"
    command = [
        str(cli), "serve", args.model, "--ram", args.ram,
        "--slots", str(max(1, min(args.slots, 4))), "--port", str(args.port),
    ]
    swap_start = swap_used_mb()
    started = time.monotonic()
    samples: list[dict[str, Any]] = []
    danger_since: float | None = None
    stop_reason: str | None = None
    generation: dict[str, Any] = {}
    generation_thread: threading.Thread | None = None

    with log_path.open("w", encoding="utf-8") as log:
        process = subprocess.Popen(
            command,
            cwd=root,
            stdout=log,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
        try:
            while True:
                now = time.monotonic()
                servers = galactus_servers(root)
                free = free_percent()
                swap = swap_used_mb()
                rss = sum(row["rss_bytes"] for row in servers)
                sample = {
                    "elapsed_seconds": round(now - started, 2),
                    "free_percent": free,
                    "swap_used_mb": swap,
                    "server_rss_bytes": rss,
                    "server_pids": [row["pid"] for row in servers],
                }
                samples.append(sample)
                print(json.dumps(sample), flush=True)

                swap_growth = 0.0 if swap is None or swap_start is None else swap - swap_start
                dangerous = free is not None and free <= args.danger_free_percent
                if dangerous:
                    danger_since = danger_since or now
                else:
                    danger_since = None
                if free is not None and free <= 1:
                    stop_reason = f"hard memory pressure: {free}% free"
                elif rss >= args.hard_rss_gib * 1024**3:
                    stop_reason = f"Galactus RSS exceeded {args.hard_rss_gib:.1f} GiB"
                elif danger_since is not None and now - danger_since >= args.danger_seconds:
                    stop_reason = f"memory pressure stayed at or below {args.danger_free_percent}% for {args.danger_seconds}s"
                elif swap_growth >= args.swap_growth_mib and free is not None and free <= 10:
                    stop_reason = f"swap grew by {swap_growth:.0f} MiB under memory pressure"
                elif process.poll() is not None:
                    stop_reason = f"server exited with code {process.returncode}"
                elif now - started >= args.startup_timeout and generation_thread is None:
                    stop_reason = f"startup exceeded {args.startup_timeout}s"

                if stop_reason:
                    break
                if generation_thread is None and health(args.port):
                    generation_thread = threading.Thread(
                        target=warm_and_generate,
                        args=(args.port, args.prompt, args.max_tokens, generation),
                        daemon=True,
                    )
                    generation_thread.start()
                if generation_thread is not None and not generation_thread.is_alive():
                    if not generation.get("ok"):
                        stop_reason = f"generation failed: {generation.get('error', 'unknown error')}"
                    break
                time.sleep(2)
        finally:
            stop_group(process)
            if generation_thread is not None:
                generation_thread.join(timeout=2)

    response = generation.get("response", {})
    usage = response.get("usage", {}) if isinstance(response, dict) else {}
    timings = response.get("timings", {}) if isinstance(response, dict) else {}
    content = None
    reasoning_content = None
    finish_reason = None
    try:
        choice = response["choices"][0]
        content = choice["message"].get("content")
        reasoning_content = choice["message"].get("reasoning_content")
        finish_reason = choice.get("finish_reason")
    except (KeyError, IndexError, TypeError):
        pass
    completion_tokens = usage.get("completion_tokens")
    valid_generation = bool(generation.get("ok")) and isinstance(completion_tokens, int) and completion_tokens > 0
    report = {
        "schema": "galactus-safe-model-smoke-v1",
        "timestamp_utc": stamp,
        "model": args.model,
        "ram_mode": args.ram,
        "slots": args.slots,
        "port": args.port,
        "prompt": args.prompt,
        "command": command,
        "success": stop_reason is None and valid_generation and bool(content or reasoning_content),
        "stop_reason": stop_reason,
        "generation": {
            "content": content,
            "reasoning_content": reasoning_content,
            "finish_reason": finish_reason,
            "completion_tokens": completion_tokens,
            "prompt_tokens": usage.get("prompt_tokens"),
            "predicted_per_second": timings.get("predicted_per_second"),
            "prompt_per_second": timings.get("prompt_per_second"),
            "wall_seconds": generation.get("wall_seconds"),
        },
        "memory": {
            "initial_swap_mb": swap_start,
            "minimum_free_percent": min((s["free_percent"] for s in samples if s["free_percent"] is not None), default=None),
            "peak_server_rss_bytes": max((s["server_rss_bytes"] for s in samples), default=0),
            "peak_swap_mb": max((s["swap_used_mb"] for s in samples if s["swap_used_mb"] is not None), default=None),
        },
        "samples": samples,
        "server_log": str(log_path),
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"report": str(report_path), **{k: report[k] for k in ("success", "stop_reason", "generation", "memory")}}, ensure_ascii=False, indent=2))
    return 0 if report["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
