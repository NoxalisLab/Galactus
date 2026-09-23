"""Loopback decision service: POST /decide -> typed answers + probabilities, GET /health.

Stdlib HTTP server, one resident Laya checkpoint, one forward pass at a time.

Request : {"state": {"message": str, "previous_task": TaskId | null} | str | object,
           "questions": "task-detection"
                      | [{"id", "type": "choice"|"score"|"noul", "instructions", "criteria"}]
                      | {"<id>": {"type", "instructions", "criteria"}}}
Response: {"model", "answers": {"<id>": {type, choice|score|noul, probabilities?, confidence}},
           "usage"?, "latency_ms"}
With the preset, a task-detection state is normalised by `state_for` exactly as in training.
"""
from __future__ import annotations

import json
import os
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from task_detection import QUESTION_ID, TASK_QUESTION, state_for

MAX_BODY = 256 * 1024
LOOPBACK = {"127.0.0.1", "::1", "localhost"}
PRESET = "task-detection"


class DecisionError(ValueError):
    pass


def normalise_questions(raw: Any) -> dict[str, dict]:
    if raw == PRESET:
        return {QUESTION_ID: TASK_QUESTION}
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, list):
        out: dict[str, dict] = {}
        for i, q in enumerate(raw):
            if not isinstance(q, dict):
                raise DecisionError(f"questions[{i}] must be an object")
            q = dict(q)
            qid = str(q.pop("id", f"q{i}"))
            if qid in out:
                raise DecisionError(f"duplicate question id {qid!r}")
            out[qid] = q
        return out
    raise DecisionError(f"'questions' must be a list, an object or {PRESET!r}")


def normalise_state(state: Any, preset: bool) -> Any:
    if preset and isinstance(state, dict):
        msg = state.get("message")
        if not isinstance(msg, str):
            raise DecisionError("state.message must be a string")
        return state_for(msg, state.get("previous_task"))
    return state


class Engine:
    """Holds the agent. `agent` needs only `.predict(state, questions)` and `.device`."""

    def __init__(self, agent: Any, name: str) -> None:
        self.agent = agent
        self.name = name
        self.lock = threading.Lock()  # torch/MPS modules are not re-entrant across threads

    def decide(self, state: Any, questions: dict[str, dict]) -> dict:
        t0 = time.perf_counter()
        with self.lock:
            out = self.agent.predict(state, questions)
        out["model"] = self.name
        out["latency_ms"] = round((time.perf_counter() - t0) * 1000, 2)
        return out


def make_handler(engine: Engine) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "galactus-decisions/0.2"

        def _send(self, status: int, body: dict) -> None:
            data = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            if self.path == "/health":
                self._send(HTTPStatus.OK, {"ok": True, "model": engine.name,
                                           "device": str(getattr(engine.agent, "device", "?"))})
            else:
                self._send(HTTPStatus.NOT_FOUND, {"error": "not found"})

        def do_POST(self) -> None:
            if self.path != "/decide":
                self._send(HTTPStatus.NOT_FOUND, {"error": "not found"})
                return
            try:
                n = int(self.headers.get("Content-Length") or 0)
                if n <= 0 or n > MAX_BODY:
                    raise DecisionError(f"body must be 1..{MAX_BODY} bytes")
                req = json.loads(self.rfile.read(n))
                if not isinstance(req, dict) or "state" not in req or "questions" not in req:
                    raise DecisionError("expected {state, questions}")
                questions = normalise_questions(req["questions"])
                state = normalise_state(req["state"], req["questions"] == PRESET)
                self._send(HTTPStatus.OK, engine.decide(state, questions))
            except (DecisionError, json.JSONDecodeError) as e:
                self._send(HTTPStatus.BAD_REQUEST, {"error": str(e)})
            except ValueError as e:  # laya rejects malformed question definitions by name
                self._send(HTTPStatus.UNPROCESSABLE_ENTITY, {"error": str(e)})

        def log_message(self, fmt: str, *args: Any) -> None:
            # Never log bodies or paths with user text; opt-in access log only.
            if os.environ.get("DECISIONS_LOG"):
                super().log_message(fmt, *args)

    return Handler


def make_server(engine: Engine, host: str, port: int) -> ThreadingHTTPServer:
    if host not in LOOPBACK:
        raise DecisionError("refusing to bind a non-loopback address: decisions stay local")
    srv = ThreadingHTTPServer((host, port), make_handler(engine))
    srv.daemon_threads = True
    return srv
