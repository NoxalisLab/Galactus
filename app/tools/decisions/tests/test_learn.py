from __future__ import annotations

import json
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import laya
import pytest
from conftest import FakeAgent

import learn
import serving
from task_detection import TASKS, split_of


def run(capsys, *argv):
    code = learn.main(list(argv))
    lines = [json.loads(x) for x in capsys.readouterr().out.splitlines()]
    return code, lines


class FakeTeacher:
    """An OpenAI-compatible server on loopback; rejects json_schema to exercise the fallback."""

    def __init__(self, answer="writing"):
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _json(self, code, body):
                data = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                self._json(200, {"data": [{"id": "teacher-model"}]})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.bodies.append(body)
                if "response_format" in body:
                    self._json(400, {"error": "no schema"})
                else:
                    self._json(200, {"choices": [{"message": {"content": f"<think>x</think>"
                                                              f'{{"task": "{answer}"}}'}}]})

        self.bodies = []
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}/v1"

    def close(self):
        self.srv.shutdown()


def write_traces(path, n):
    with path.open("w") as f:
        for i in range(n):
            row = {"id": f"tr-{i}", "ts": i, "state": {"message": f"message {i}",
                                                       "previous_task": "general"},
                   "heuristic": {"task": "code", "confidence": 0.7}}
            if i % 3 == 0:
                row["outcome"] = {"kind": "manual", "task": TASKS[i % 5]}
            f.write(json.dumps(row) + "\n")


def test_label_end_to_end(tmp_path, capsys):
    traces, out = tmp_path / "traces.jsonl", tmp_path / "labels.jsonl"
    write_traces(traces, 30)
    teacher = FakeTeacher()
    try:
        code, lines = run(capsys, "label", "--traces", str(traces), "--out", str(out),
                          "--teacher-url", teacher.url)
    finally:
        teacher.close()
    assert code == 0
    assert all(line["event"] == "progress" for line in lines[:-1])
    res = lines[-1]
    assert res["event"] == "result" and res["phase"] == "label"
    assert res["labels"] == {"teacher": 20, "outcome": 10, "hand": 0}
    assert res["teacher_model"] == "teacher-model"
    # one schema attempt, then plain prompts only
    assert sum("response_format" in b for b in teacher.bodies) == 1
    rows = [json.loads(x) for x in out.read_text().splitlines()]
    assert {r["split"] for r in rows} <= {"train", "calib", "test"}
    assert all(r["split"] == split_of(r["id"]) for r in rows)
    assert rows[0]["label"] == "general" and rows[0]["source"] == "outcome"
    assert rows[1]["label"] == "writing" and rows[1]["source"] == "teacher"


def test_label_exit_codes(tmp_path, capsys):
    traces = tmp_path / "traces.jsonl"
    write_traces(traces, 4)
    code, lines = run(capsys, "label", "--traces", str(traces), "--out", str(tmp_path / "o"),
                      "--teacher-url", "http://127.0.0.1:9/v1")
    assert code == learn.EXIT_TEACHER and lines[-1]["event"] == "error"
    code, lines = run(capsys, "label", "--traces", str(tmp_path / "nope"), "--out", "x")
    assert code == learn.EXIT_INPUT and lines[-1]["code"] == 4
    code, lines = run(capsys, "label", "--traces", str(traces), "--out", str(tmp_path / "o"))
    assert code == 0 and lines[-1]["labels"]["outcome"] == 2 and lines[-1]["unlabelled"] == 2


def test_splits_counts_without_model(tmp_path, capsys):
    traces = tmp_path / "traces.jsonl"
    write_traces(traces, 200)
    code, lines = run(capsys, "splits", "--traces", str(traces))
    assert code == 0 and len(lines) == 1
    res = lines[-1]
    assert res["event"] == "result" and res["phase"] == "splits"
    want = {s: sum(split_of(f"tr-{i}") == s for i in range(200)) for s in ("train", "calib", "test")}
    assert res["splits"] == want and res["traces"] == 200
    assert res["with_outcome"] == len(range(0, 200, 3))
    code, lines = run(capsys, "splits", "--traces", str(tmp_path / "missing"))
    assert code == learn.EXIT_INPUT


def test_usage_error_is_2():
    with pytest.raises(SystemExit) as e:
        learn.main(["train"])
    assert e.value.code == learn.EXIT_USAGE


def test_toolkit_missing_is_3(monkeypatch, tmp_path, capsys):
    def missing():
        raise learn.ToolkitMissing("no torch")

    monkeypatch.setattr(learn, "load_toolkit", missing)
    code, lines = run(capsys, "train", "--out", str(tmp_path / "c"))
    assert code == learn.EXIT_TOOLKIT and lines[-1]["message"] == "no torch"


def test_train_then_evaluate_with_fake_model(tmp_path, base_dir, monkeypatch, capsys):
    agent = FakeAgent(answer="code", conf=0.9)
    monkeypatch.setattr(laya, "load", lambda path, device=None: agent)
    monkeypatch.setenv(learn.BASE_ENV, str(base_dir))
    traces, labels, ckpt = tmp_path / "t.jsonl", tmp_path / "l.jsonl", tmp_path / "ckpt"
    write_traces(traces, 90)
    assert run(capsys, "label", "--traces", str(traces), "--out", str(labels))[0] == 0

    code, lines = run(capsys, "train", "--data", str(labels), "--out", str(ckpt),
                      "--epochs", "1", "--batch", "64")
    assert code == 0, lines[-1]
    res = lines[-1]
    assert res["phase"] == "train"
    n_train = sum(split_of(f"tr-{i}") == "train" for i in range(0, 90, 3))
    assert res["labels"]["outcome"] == n_train and res["labels"]["hand"] > 200
    assert res["labels"]["teacher"] == 0
    assert res["test_held_out"] == sum(split_of(f"tr-{i}") == "test" for i in range(0, 90, 3))
    assert (ckpt / "model.safetensors").exists()
    trained_on = {s["message"] for s in agent.calls}  # predict() is not called by training
    assert not trained_on

    heur = tmp_path / "h.json"
    heur.write_text(json.dumps({f"tr-{i}": "code" for i in range(90)}))
    code, lines = run(capsys, "evaluate", "--checkpoint", str(ckpt), "--test", str(labels),
                      "--heuristic-json", str(heur), "--out", str(tmp_path / "rep.json"))
    assert code == 0
    res = lines[-1]
    assert set(res) >= {"student", "heuristic", "policy", "gate_advisory", "labels"}
    assert res["policy"]["threshold"] == 0.6 and res["policy"]["min_chars"] == 8
    assert res["policy"]["student_share"] == 1.0  # conf 0.9, messages >= 8 chars
    n_test = res["student"]["n"]
    assert n_test == res["heuristic"]["n"] > 0
    assert res["student"]["acc"] == res["heuristic"]["acc"]  # both always answer "code"
    assert res["gate_advisory"]["accepted"] is False
    assert json.loads((tmp_path / "rep.json").read_text())["student"]["n"] == n_test
    # only held-out rows were asked, with the serving-time state shape
    assert all(set(s) == {"message", "previous_task"} for s in agent.calls)
    assert len(agent.calls) == n_test + 1  # + warm-up


def test_train_refuses_too_little_data(tmp_path, base_dir, monkeypatch, capsys):
    monkeypatch.setattr(laya, "load", lambda path, device=None: FakeAgent())
    code, lines = run(capsys, "train", "--no-hand", "--out", str(tmp_path / "c"),
                      "--base", str(base_dir))
    assert code == learn.EXIT_INPUT and "training rows" in lines[-1]["message"]
    code, lines = run(capsys, "train", "--out", str(tmp_path / "c"),
                      "--base", str(tmp_path / "nobase"))
    assert code == learn.EXIT_INPUT and "not a Laya checkpoint" in lines[-1]["message"]


def test_evaluate_missing_checkpoint_is_4(tmp_path, capsys):
    code, _ = run(capsys, "evaluate", "--checkpoint", str(tmp_path), "--test", "x")
    assert code == learn.EXIT_INPUT


def test_status_reports_checkpoint(tmp_path, base_dir, capsys):
    code, lines = run(capsys, "status", "--checkpoint", str(base_dir), "--base", str(base_dir))
    assert code == 0
    res = lines[-1]
    assert res["toolkit_ok"] and res["base"]["ok"] and res["checkpoint"]["ok"]
    assert res["device"] in {"cpu", "mps", "cuda"}
    code, lines = run(capsys, "status", "--checkpoint", str(tmp_path / "x"),
                      "--base", str(tmp_path / "x"))
    assert code == 0 and not lines[-1]["checkpoint"]["ok"] and not lines[-1]["base"]["ok"]


def _post(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_serve_contract(fake_agent):
    srv = serving.make_server(serving.Engine(fake_agent, "ckpt"), "127.0.0.1", 0)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        with urllib.request.urlopen(base + "/health", timeout=5) as r:
            assert r.status == 200 and json.loads(r.read())["ok"] is True
        code, body = _post(base + "/decide", {"state": {"message": "écris un script",
                                                        "previous_task": None},
                                              "questions": "task-detection"})
        assert code == 200
        assert body["answers"]["task"]["choice"] == "code"
        assert body["answers"]["task"]["confidence"] == 0.9
        assert fake_agent.calls[-1] == {"message": "écris un script"}
        _post(base + "/decide", {"state": {"message": "x", "previous_task": "writing"},
                                 "questions": "task-detection"})
        assert fake_agent.calls[-1] == {"message": "x", "previous_task": "writing"}
        assert _post(base + "/decide", {"state": {}, "questions": "task-detection"})[0] == 400
        assert _post(base + "/decide", {"questions": "task-detection"})[0] == 400
        assert _post(base + "/nope", {})[0] == 404
    finally:
        srv.shutdown()
        srv.server_close()
    with pytest.raises(serving.DecisionError):
        serving.make_server(serving.Engine(fake_agent, "c"), "0.0.0.0", 0)
