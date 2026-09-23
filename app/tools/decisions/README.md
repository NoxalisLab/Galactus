# decisions: System-1 typed decisions for Galactus (Laya)

A local, calibrated classifier for the decisions Galactus currently makes with regexes. It covers only
the first target, **task detection** (`detectTask()` in `app/src/autotask.ts`). Phase 1 (below)
measured it offline; phase 2 turns it into the app's opt-in pipeline (`learn.py`), in which the
app collects its own traces, labels them, trains, and only switches when the gate passes.

## Phase 1 result (held-out test split, n = 105, 65 FR / 40 EN, 2026-09-23, Apple M-series, MPS)

| system | accuracy | ECE (10 bins) | latency p50 | p95 |
|---|---|---|---|---|
| `detectTask()` heuristic (node) | 0.648 | 0.264* | 0.004 ms | 0.015 ms |
| Laya multilingual base, zero-shot | 0.695 | 0.083 | 12.0 ms | 15.2 ms |
| **Laya multilingual fine-tuned** | **0.933** | **0.050** | **11.8 ms** | 13.0 ms |
| fine-tuned + fallback to heuristic below 0.5 | 0.933 | 0.043 | 11.8 ms | 13.0 ms |

Accuracy per task, heuristic vs fine-tuned: general 0.95/1.00, code 0.81/0.95, scripting 0.57/0.81,
writing 0.57/0.95, reasoning 0.33/0.95. By language, fine-tuned: FR 0.954, EN 0.900.

**Gate: passed**. The student beats the heuristic on accuracy (+28.6 pts) and its ECE is below 0.10.
Full numbers are in `results/eval.json`.

\* The heuristic's `confidence` is a score, not a probability, so its ECE only says the score cannot be
used as one.

**Read these numbers carefully.** The labels are **hand-written**, not teacher-labelled (see
*Labels*). The same author wrote the train and test prompts, with one clear intent per prompt, so the
test split has the same distribution as the training data. Real traffic (multi-turn, mixed intents,
pasted logs) will score lower. At n = 105 the 95 % interval is about ±5 pts. The latency is measured
per request, one question, warm, on a shared Mac. The first HTTP call through the service measured
96 ms (cold MPS kernels).

## Labels

`data/prompts_handwritten.txt`: 340 prompts (204 FR, 136 EN, 68 per task), format
`label|lang|text`. They are **hand-written by the agent**, because no Galactus server was reachable
on 127.0.0.1:8737 on 2026-09-23. An unrelated `mlx_lm server` (Qwen3-4B) was running on :8080; it
was deliberately not used because the spec asks for the Galactus teacher. `labeling.py` (`learn.py label`) is
the teacher path: it probes the server, never starts one, and asks each prompt with a JSON-schema-
constrained answer.

`data/split.json` holds the stratified (label × lang) split: train 185 / calib 50 / test 105, seed
20260923. Do not regenerate it between comparisons.

## Phase 2: the app's pipeline (`learn.py`)

The app runs one entry point, with the venv it builds from its bundled Python
(`<venv>/bin/python -E -s learn.py ...`, cwd = this folder). Nothing here downloads anything:
`HF_HUB_OFFLINE=1` is the default, and the base checkpoint comes from `--base` or
`$GALACTUS_LAYA_BASE`, with the local Hugging Face cache as the last resort.

```
learn.py            CLI: status | serve | label | train | evaluate  (JSON lines on stdout)
task_detection.py   the typed question, state_for(), hash split, hand-set loader, ECE
labeling.py         trace parsing, teacher client, outcome-over-teacher labels (stdlib only)
trainer.py          fine-tune (proper score) + temperature fit + atomic checkpoint write
evaluation.py       student vs heuristic on held-out real traces, advisory gate
serving.py          loopback POST /decide, GET /health (stdlib http.server)
heuristic.mjs       dev tool: detectTask() answers for the hand set (--heuristic-json)
lock_requirements.py  regenerates requirements-learning.txt (pins + sha256, macOS arm64 cp312)
tests/              pytest, fake tokenizer and tiny model: no checkpoint is downloaded
```

### Subcommands

| command | arguments | last stdout line (`"event": "result"`) |
|---|---|---|
| `status` | `[--checkpoint DIR] [--base DIR]` | `python, packages, toolkit_ok, device, base{path,ok}, checkpoint{path,ok,training}` |
| `serve` | `--port P --checkpoint DIR [--host 127.0.0.1] [--device D]` | first line `{"event":"ready","port":P,...}`, then serves until SIGTERM |
| `label` | `--traces F --out F [--teacher-url URL]` | `labels{teacher,outcome,hand}, labelled, unlabelled, teacher_errors, teacher_model, splits` |
| `train` | `--out DIR [--data F] [--base DIR] [--no-hand] [--hand-holdout] [--epochs 5] [--batch 8] [--lr] [--head-lr] [--seed] [--device]` | `checkpoint, labels{teacher,outcome,hand}, train, calib, test_held_out, temperature, calib_acc, losses, seconds, device` |
| `evaluate` | `--checkpoint DIR (--test F \| --hand-test) [--heuristic-json F] [--out F] [--device]` | `student{acc,ece,n,latency_ms_p50,latency_ms_p95}, heuristic{acc,n}, labels, by_task, gate_advisory{n_test_ok,accuracy_gain_ok,ece_ok,accepted}` |

Every stdout line is one JSON object: `{"event":"progress","phase","pct","message"}` while
working, then `result` on success or `{"event":"error","phase","code","message"}` on failure.
Readable diagnostics go to stderr. Exit codes: 0 ok, 1 internal error, 2 usage, 3 toolkit
missing, 4 bad input (missing or malformed file, no checkpoint or base, fewer than 20 training
rows), 5 teacher unreachable, 130 cancelled (SIGTERM or SIGINT; the checkpoint is written to a
temporary sibling and renamed at the end, so a cancel leaves nothing half-written).

### Data rules

- **Trace row** (written by the app, already redacted): `{"id", "ts", "heuristic": {"task"},
  "state": {"message", "previous_task"}, "outcome"?: {"task"}}`. `text`/`message` at the top
  level are accepted too. A repeated id keeps its last row, so the app can append a late outcome.
- **Split**: `sha256("galactus-learning-split:v1" + id)` mod 100: `[0,60)` train, `[60,75)`
  calib, `[75,100)` test. It depends on the id only, so a trace never moves between splits.
  Test rows are never trained on.
- **Labels**: an outcome label (the user's real choice) always wins and skips the teacher call.
  Otherwise the teacher (the running primary engine, OpenAI-compatible, `temperature 0`, JSON
  schema when the server accepts it, text parsing when it answers 400) labels the row. Rows
  neither can label are dropped and counted.
- **Training data**: the 340 hand-written prompts (phase-1 calib ids go to calibration, the
  rest to training) + labelled traces (train split trains, calib split calibrates). The hand
  rows get a fixed, label-independent `previous_task`, so the student sees the same state
  shape as in the app and learns no shortcut from it.
- **Evaluation**: only test-split traces, scored for both systems on the rows the heuristic
  answered (`--heuristic-json` `{"<id>": "<task>"}` from the app, else the answer recorded in
  the trace). The app decides the gate; `gate_advisory` restates it: n >= 60, student accuracy
  >= heuristic + 3 pts, ECE <= 0.10.

### Toolkit

`requirements-learning.txt` pins all 35 packages with sha256 for CPython 3.12 on macOS arm64
(wheels only, `# download-bytes:` header). Install into the app's venv only:
`pip install --only-binary=:all: --require-hashes -r requirements-learning.txt`. Checked on
2026-09-23 in a fresh venv: installs and imports.

### End-to-end check on the hand set (2026-09-23, MPS)

`learn.py train --hand-holdout` (185 train / 50 calib, phase-1 split, 5 epochs, 72 s, fitted
temperature 2.19), then `learn.py evaluate --hand-test` on the 105 phase-1 test prompts. Both
systems see the same `previous_task` per row (`hand_previous_task`), so the heuristic's
continuity bonus now works against it on some rows: it scores 0.571 here against 0.648 in
phase 1, where `previous` was always `general`. Report: `results/eval-v2.json`.

| system | accuracy | ECE | latency p50 / p95 |
|---|---|---|---|
| `detectTask()` (app, via `heuristic.mjs`) | 0.571 | n/a | n/a |
| student `task-detection-v2` | **0.924** | **0.048** | 12.2 / 14.9 ms |

Per task, student / heuristic: general 0.95/0.24, code 0.81/0.71, scripting 0.90/0.67, writing
1.00/0.67, reasoning 0.95/0.57. The advisory gate passes (n 105, +35 pts, ECE 0.048). This still
only proves the pipeline: same author, same distribution, no real traces. Through `serve`, the
first calls after the warm-up took 22-28 ms. SIGTERM during `train` exits 130 and leaves no
checkpoint.

## Commands (development)

```bash
cd app/tools/decisions
.venv/bin/python -m pytest -q                        # unit tests, no model download
.venv/bin/python learn.py status
.venv/bin/python learn.py train --out checkpoints/task-detection-v2 --hand-holdout
../../node_modules/.bin/tsc ../../src/autotask.ts --outDir .build --target ES2022 \
    --module ESNext --lib ES2022,DOM --skipLibCheck
.venv/bin/python -c "import json,learn
for r in learn.hand_test_rows(learn.DATA):
    print(json.dumps({'id': r.id, 'text': r.text, 'previous': r.previous_task}))" \
  | node heuristic.mjs > results/heuristic_hand.jsonl
.venv/bin/python learn.py evaluate --checkpoint checkpoints/task-detection-v2 --hand-test \
    --heuristic-json results/heuristic_hand.jsonl --out results/eval-v2.json
.venv/bin/python learn.py serve --port 8739 --checkpoint checkpoints/task-detection-v2
curl -s 127.0.0.1:8739/decide -d '{"state":{"message":"Automatise la sauvegarde du NAS",
  "previous_task":"general"},"questions":"task-detection"}'
```

## Where the spec differs from the real Laya API (checked in laya 0.3.7 source and model card)

- **Checkpoint layout.** `convaiinnovations/laya` is a *bundle*: English at the root, and
  `multilingual/` and `typed-decisions/` as subfolders. The standalone repos
  `laya-multilingual` and `laya-typed-decisions` also exist. The API is
  `laya.load(repo, subfolder=...)`, or `Router`.
- **`questions` is a dict** `{question_id: {type, instructions, criteria}}`, not a list. `choice`
  criteria are a dict (label -> description) or a list. `score` criteria are a list of levels.
  `noul` criteria are optional `{true, false}`.
- **`Router(preload=True)` loads all three checkpoints** (about 1.16 B params). Its routing only
  looks at the script (English vs non-English), so it would send English Galactus prompts to the
  English checkpoint, which is not our fine-tuned one. **Use `laya.load(<our checkpoint>)`
  directly, not `Router`.**
- **Checkpoint sizes.** Multilingual is 322 M params (mmBERT-base), 1024 ctx, `head_max_len` 256, and
  644 MB fp16 on disk. English is 421 M params (ModernBERT-large), 512 ctx.
- **No fine-tuning code in the package.** The pip wheel is inference only. Upstream fine-tuning is
  a Kaggle notebook (GitHub `NandhaKishorM/laya`, `notebooks/laya_finetune_typed_decisions_2xT4_kaggle.ipynb`),
  which was not read. `trainer.py` rebuilds the path from the package's public pieces.
- **Temperatures are clamped to [0.5, 5.0]** at load (`clamp_temperature`), per
  `(qtype, option count)` bucket. Our fit (2.36) is inside that range.
- **A built-in server already exists.** `laya-serve` (FastAPI/uvicorn, not installed) implements
  Jev's `/v1/systemone` wire protocol and binds 0.0.0.0 by default. We use our own stdlib loopback
  service instead. The Jev-compatible protocol means a future opt-in Jev adapter needs no new
  schema.
- The model card's own figures confirm the spec: bases are near chance on custom decisions
  (typed-decisions zero-shot 0.352 multilingual), and they ship over-confident (ECE 0.314 → 0.106
  after temperature fit for multilingual). On our task the zero-shot multilingual base did better
  than "chance" (0.695), because five plainly described options are an easy schema.
- MLX port (`aac6fef/laya-mlx`): not verified (no page read). We measured torch-MPS at 12 ms p50,
  which is already inside the budget.

## Known limits

- The fine-tune specialises the whole encoder on one question. Other questions put to the *same*
  checkpoint (for example a `noul`) still answer, but are no longer backed by Laya's general
  training. Phase 2 should either train one checkpoint per decision family with a mix of Laya's
  generic data, or freeze the encoder (`detach_encoder=True`) and train only the head.
- Probabilities are still sharp in-distribution (0.9998 on an obvious prompt), even though the ECE
  is low. A threshold only matters for real, ambiguous traffic.
- The state is only the last message. `detectTask(text, previous)` also uses the previous task
  (continuity bonus), which the student does not see yet.

## Phase 2 needs (written after phase 1; items 3-5 are now built, see above)

1. **Serving from the app.** Galactus is a Tauri app, so the calls go through Rust. A Tauri
   command `decide(state, questions)` calls the local service (a sidecar started and stopped by
   the app like the model server, on a port next to `SERVER_PORT_BASE`, loopback only). The
   alternative is to embed the model in Rust (candle/ort). The encoder is mmBERT, so an ONNX
   export is the likely route.
2. **Wiring into `autotask.ts`.** `detectTask` stays synchronous and is the fallback. An async
   `detectTaskLearned(text, previous)` asks `decide`, uses the student answer when
   `confidence >= threshold`, and otherwise uses the heuristic. It also uses the heuristic on any
   timeout (for example 50 ms) or when the service is absent. `mayAutoSwap`'s 0.55 threshold must
   be re-fitted on the student's calibrated probabilities, not reused.
3. **Trace collection in the agent loop.** Write one JSONL row per turn with state (redacted with
   `app/src/redact.ts` `redact()` and the `sensitive.ts` rules), question, options, student answer,
   heuristic answer, and outcome (swap accepted, refused, or undone; the user re-picked a task by
   hand). Keep it local only, add a retention cap, and give the user an opt-out.
4. **Teacher labelling.** Run `learn.py label` against a running `galactus serve`. Measure
   teacher-vs-hand agreement on these 340 prompts before trusting teacher labels. Outcome signals
   should override teacher labels when they conflict.
5. **A real held-out set.** Build it from collected traces (multi-turn, pasted code or logs, mixed
   intents) and re-run the gate there. The current 0.933 does not transfer on its own.
6. **Next decisions.** `learned.ts assessTurn()` (skill admission, 11 refusal rules → `noul`
   questions) and tool-call risk (`sensitive.ts` → `score`). Each gets its own question, labels,
   gate and fallback.
7. **Distribution.** A 644 MB checkpoint download on first use, pinned by hash. Try MLX or ONNX
   int8 to cut size and cold-start time.
