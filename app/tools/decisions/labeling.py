"""Traces in, labelled rows out: parse app traces, ask the teacher, let user outcomes win.

Stdlib only, so `learn.py label` and the unit tests need neither torch nor laya.

Trace row (one JSON object per line, written by the app, already redacted):
    {"id": str, "ts": ..., "heuristic": {"task": TaskId, "confidence"?: float},
     "state": {"message": str, "previous_task"?: TaskId}   # or top-level "text"/"message"
     "outcome"?: {"task": TaskId, ...} | TaskId | null}   # "label" is accepted for "task"
Only "id", the message and "heuristic.task" are required; other keys are ignored.

Labelled row (one JSON object per line, read by train and evaluate):
    {"id", "text", "previous_task", "split", "label", "source": "outcome"|"teacher",
     "teacher_label", "outcome_label", "heuristic_task"}
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from task_detection import TASK_QUESTION, TASKS, split_of

SYSTEM = ("You classify a user's message for an assistant. Answer only with JSON "
          '{"task": <one of the ids>}. Options:\n' +
          "\n".join(f"- {k}: {v}" for k, v in TASK_QUESTION["criteria"].items()))
SCHEMA = {"type": "object", "properties": {"task": {"type": "string", "enum": list(TASKS)}},
          "required": ["task"], "additionalProperties": False}
THINK = re.compile(r"<think>.*?(</think>|$)", re.DOTALL)
TASK_WORD = re.compile(r"\b(" + "|".join(TASKS) + r")\b")


class InputError(ValueError):
    """A trace or labelled file is unreadable or malformed (exit code 4)."""


class TeacherUnavailable(RuntimeError):
    """No OpenAI-compatible server answers at the teacher URL (exit code 5)."""


@dataclass(frozen=True)
class Trace:
    id: str
    text: str
    previous_task: str | None
    heuristic_task: str | None
    outcome_label: str | None


@dataclass(frozen=True)
class Labelled:
    id: str
    text: str
    previous_task: str | None
    split: str
    label: str
    source: str
    teacher_label: str | None
    outcome_label: str | None
    heuristic_task: str | None


def _task(value: Any) -> str | None:
    return value if isinstance(value, str) and value in TASKS else None


def _outcome(raw: dict) -> str | None:
    out = raw.get("outcome")
    if isinstance(out, dict):
        return _task(out.get("task")) or _task(out.get("label"))
    return _task(out) or _task(raw.get("outcome_label"))


def parse_trace(raw: Any, where: str) -> Trace:
    if not isinstance(raw, dict):
        raise InputError(f"{where}: a trace must be a JSON object")
    tid = raw.get("id")
    if not isinstance(tid, str) or not tid:
        raise InputError(f"{where}: missing string 'id'")
    state = raw.get("state") if isinstance(raw.get("state"), dict) else {}
    text = state.get("message", raw.get("text", raw.get("message")))
    if not isinstance(text, str) or not text.strip():
        raise InputError(f"{where}: missing message text")
    prev = _task(state.get("previous_task")) or _task(raw.get("previous_task")) \
        or _task(raw.get("previous"))
    heur = raw.get("heuristic")
    heur_task = _task(heur.get("task")) if isinstance(heur, dict) else _task(heur)
    return Trace(tid, text, prev, heur_task, _outcome(raw))


def read_jsonl(path: Path) -> Iterator[tuple[str, Any]]:
    if not path.is_file():
        raise InputError(f"{path}: no such file")
    with path.open(encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            if line.strip():
                try:
                    yield f"{path.name}:{n}", json.loads(line)
                except json.JSONDecodeError as e:
                    raise InputError(f"{path.name}:{n}: invalid JSON ({e.msg})") from e


def read_traces(path: Path) -> list[Trace]:
    """Parse traces; a repeated id keeps its last row (the app may append a late outcome)."""
    by_id: dict[str, Trace] = {}
    for where, raw in read_jsonl(path):
        t = parse_trace(raw, where)
        by_id.pop(t.id, None)
        by_id[t.id] = t
    return list(by_id.values())


def read_labelled(path: Path) -> list[Labelled]:
    rows = []
    for where, raw in read_jsonl(path):
        try:
            row = Labelled(**{k: raw.get(k) for k in Labelled.__dataclass_fields__})
        except TypeError as e:
            raise InputError(f"{where}: {e}") from e
        # Outcome labels always override the teacher, even in a hand-edited file.
        label = _task(row.outcome_label) or _task(row.label)
        if not isinstance(row.id, str) or not isinstance(row.text, str) or label is None:
            raise InputError(f"{where}: labelled row needs id, text and a valid label")
        source = "outcome" if _task(row.outcome_label) else (row.source or "teacher")
        rows.append(Labelled(**{**asdict(row), "label": label, "source": source,
                                "split": split_of(row.id)}))
    return rows


def teacher_base(url: str) -> str:
    """Accept the server root or its /v1 URL; return the root."""
    url = url.rstrip("/")
    return url.removesuffix("/v1")


class Teacher:
    """The running primary engine, asked for a constrained answer. It never starts a server."""

    def __init__(self, url: str, timeout: float = 120.0) -> None:
        self.base = teacher_base(url)
        self.timeout = timeout
        self.use_schema = True
        try:
            with urllib.request.urlopen(f"{self.base}/v1/models", timeout=5) as r:
                data = json.loads(r.read()).get("data") or []
            self.model = str(data[0]["id"])
        except (urllib.error.URLError, OSError, KeyError, IndexError, ValueError,
                AttributeError) as e:
            raise TeacherUnavailable(f"no model served at {self.base}/v1/models ({e})") from e

    def _post(self, body: dict) -> str:
        req = urllib.request.Request(f"{self.base}/v1/chat/completions",
                                     data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            return str(json.loads(r.read())["choices"][0]["message"]["content"] or "")

    def ask(self, text: str) -> str | None:
        body: dict[str, Any] = {
            "model": self.model, "temperature": 0, "max_tokens": 64,
            "messages": [{"role": "system", "content": SYSTEM},
                         {"role": "user", "content": text}],
            "chat_template_kwargs": {"enable_thinking": False}}
        if self.use_schema:
            body["response_format"] = {"type": "json_schema", "json_schema": {
                "name": "task", "schema": SCHEMA, "strict": True}}
        try:
            content = self._post(body)
        except urllib.error.HTTPError as e:
            if e.code != 400 or not self.use_schema:
                raise
            self.use_schema = False  # server without structured output: parse the text
            return self.ask(text)
        return parse_answer(content)


def parse_answer(content: str) -> str | None:
    content = THINK.sub("", content).strip()
    try:
        value = json.loads(content)
        if isinstance(value, dict):
            return _task(value.get("task"))
    except ValueError:
        pass
    found = set(TASK_WORD.findall(content))
    return found.pop() if len(found) == 1 else None


def label_traces(traces: list[Trace], ask: Callable[[str], str | None] | None,
                 progress: Callable[[int, int], None] = lambda i, n: None
                 ) -> tuple[list[Labelled], dict[str, int]]:
    """Label every trace. An outcome label wins and skips the teacher call."""
    rows: list[Labelled] = []
    counts = {"outcome": 0, "teacher": 0, "unlabelled": 0, "teacher_errors": 0}
    for i, t in enumerate(traces):
        teacher = None
        if t.outcome_label is None and ask is not None:
            try:
                teacher = ask(t.text)
            except (urllib.error.URLError, OSError, ValueError, KeyError, IndexError):
                counts["teacher_errors"] += 1
        label = t.outcome_label or teacher
        if label is None:
            counts["unlabelled"] += 1
        else:
            source = "outcome" if t.outcome_label else "teacher"
            counts[source] += 1
            rows.append(Labelled(t.id, t.text, t.previous_task, split_of(t.id), label, source,
                                 teacher, t.outcome_label, t.heuristic_task))
        progress(i + 1, len(traces))
    return rows, counts


def write_labelled(rows: list[Labelled], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(asdict(r), ensure_ascii=False) + "\n")
    tmp.replace(path)


def read_heuristic(path: Path) -> dict[str, str]:
    """The app's detectTask() answers: {"<id>": "<task>"} (values may also be {"task": ...});
    a JSON list or JSON lines of {"id", "task"} are accepted too."""
    if not path.is_file():
        raise InputError(f"{path}: no such file")
    text = path.read_text(encoding="utf-8")
    try:
        data: Any = json.loads(text)
    except json.JSONDecodeError:
        data = [row for _, row in read_jsonl(path)]
    if isinstance(data, list):
        data = {r.get("id"): r for r in data if isinstance(r, dict)}
    if not isinstance(data, dict):
        raise InputError(f"{path}: expected an object keyed by trace id")
    out = {}
    for k, v in data.items():
        task = _task(v.get("task")) if isinstance(v, dict) else _task(v)
        if isinstance(k, str) and task:
            out[k] = task
    return out
