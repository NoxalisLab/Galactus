# Skills sources and provenance

Provenance record for `app/skills/**`. Every skill shipped with Galactus is
either original work by Noxalis Lab or adapted from a publicly available source
whose licence permits redistribution inside an Apache-2.0 product.

**Harvest date: 2026-08-08.** Commits below are the exact revisions read.

## Licence policy applied

Accepted: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, CC0-1.0, Unlicense,
CC-BY (with attribution).

Rejected, without exception: GPL / AGPL / LGPL, CC-BY-SA, CC-BY-NC, CC-BY-ND,
and any repository with **no licence file at all** (no licence means all rights
reserved, not public domain).

## Sources accepted and used

| Source | Commit read | SPDX | Files drawn from | What was taken | What was changed |
|---|---|---|---|---|---|
| [obra/superpowers](https://github.com/obra/superpowers) | `44c9b2d6e889982ac18c27d05a19fefe335194e1` | MIT | `skills/systematic-debugging/SKILL.md`, `skills/test-driven-development/SKILL.md`, `skills/verification-before-completion/SKILL.md`, `skills/requesting-code-review/SKILL.md` | The method layer: root cause before fix, the four debugging phases, the red-flag list of rationalisations, the "three failed fixes means an architectural problem" stop rule, the red-green ordering, and the principle that a completion claim requires fresh evidence. | Rewritten in French from scratch. The original targets a frontier model with a large window and names tools that do not exist here (`Bash`, `Read`, `Task`). Every step was re-anchored on `run_command`, `read_file`, `spawn_agent`, `ask_agent`, on the 120 s command ceiling, on the scratch-file spill at 20 000 characters, and on the stdlib-only bundled Python. The `dot` graph, the second-person coaching voice and the "your human partner" framing were dropped. Roughly 5:1 compression. |
| [github/awesome-copilot](https://github.com/github/awesome-copilot) | `ab7544d03d4c49fdd07f5958e1888ad39c4118e2` | MIT | `instructions/a11y.instructions.md`, `instructions/performance-optimization.instructions.md`, `instructions/code-review-generic.instructions.md`, `instructions/containerization-docker-best-practices.instructions.md`, `instructions/kubernetes-deployment-best-practices.instructions.md`, `instructions/terraform.instructions.md`, `skills/sql-optimization/SKILL.md`, `skills/sql-code-review/SKILL.md`, `skills/incident-postmortem/SKILL.md`, `skills/meeting-minutes/SKILL.md`, `skills/refactor/SKILL.md` | Domain facts and thresholds: the WCAG 2.2 AA criteria table and its severity classification; the Core Web Vitals thresholds (LCP 2.5 s / 4 s, INP 200 ms / 500 ms, CLS 0.1); the CRITICAL / IMPORTANT / SUGGESTION review triage; the SQL anti-pattern list (function in `WHERE`, correlated subquery, N+1, composite index ordering); the Dockerfile layer-ordering and multi-stage rules; the Kubernetes probe and resource-limit checklist; the blameless post-mortem structure with 5 Whys and contributing factors; the meeting-minutes schema (metadata, decisions, actions with owner and due date, parking lot). | Rewritten in French. The originals are unbounded reference documents (the a11y file alone is far larger than the whole Galactus skill budget); each was reduced to the decision content and reorganised as a numbered procedure with a named tool at every step. All Azure, GitHub Copilot and Visual Studio Code specifics were removed. Every check was given an executable command and a verification step, which the originals do not have. |
| [danielmiessler/Fabric](https://github.com/danielmiessler/Fabric) | `338b89cfe97ab2d12ce30ce8b5449857a841366d` | MIT | `data/patterns/review_code/system.md`, `data/patterns/analyze_logs/system.md`, `data/patterns/analyze_incident/system.md`, `data/patterns/improve_prompt/system.md`, `data/patterns/summarize_meeting/system.md`, `data/patterns/write_latex/system.md` | The code-review output structure (original snippet, suggested improvement, rationale); the "base every assumption on the log data, exclude personal opinion" restriction; the incident field list; the separation of a meeting into decisions, tasks with responsible party and deadline, and next steps; the LaTeX preamble constraints (no `fontspec` under `pdflatex`, close every environment, do not emit prose outside the code). | Heavily reworked. Fabric patterns are single-shot text transformers with no tool awareness, no verification and no failure modes; only the output shapes and a few hard constraints survived. Everything procedural, every command and every guard rail in the resulting skills is new. The "1500 years of experience" persona framing was dropped entirely. |
| [dair-ai/Prompt-Engineering-Guide](https://github.com/dair-ai/Prompt-Engineering-Guide) | `57673726396dd94acb23bdb1e67f27c78ee85a8e` | MIT | `guides/prompts-basic-usage.md`, `guides/prompts-intro.md` | The taxonomy of what makes an instruction specific: explicit inputs, named output format, stated constraints, worked examples. | Inverted for the target runtime. The guide assumes a large context and recommends few-shot examples and chain-of-thought; `prompts-locaux` states the opposite for an 8192-token local model and quantifies why (a 3 KB skill costs about 800 tokens, 800 reasoning tokens cost three minutes at 5 tok/s). Only the four-element decomposition of a good instruction is recognisably inherited. |
| [ziishaned/learn-regex](https://github.com/ziishaned/learn-regex) | `5a5252eb51fd9c49f194f73b4f85f649da96b463` | MIT | `README.md` | The greedy versus lazy quantifier explanation and the anchoring / word-boundary failure cases. | Converted into a symptom-to-cause table and paired with a runnable positive/negative test bench. The BSD-versus-GNU dialect table (`grep -P` absent on macOS, `sed -i ''`) is original and specific to this runtime. |

## Sources examined and rejected

| Source | Reason |
|---|---|
| [anthropics/skills](https://github.com/anthropics/skills) | **No licence file** at the repository root and no licence statement in the README. All rights reserved. This was the highest-quality source found and none of it was used. |
| [contains-studio/agents](https://github.com/contains-studio/agents) | No licence file. |
| [jlevy/the-art-of-command-line](https://github.com/jlevy/the-art-of-command-line) | No licence file. |
| [x1xhlol/system-prompts-and-models-of-ai-tools](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools) | GPL-3.0. |
| [ai-boost/awesome-prompts](https://github.com/ai-boost/awesome-prompts) | GPL-3.0. |
| [k88hudson/git-flight-rules](https://github.com/k88hudson/git-flight-rules) | CC-BY-SA-4.0. Would have been the natural source for `git-chirurgie`, which is therefore original work. |
| [stas00/ml-engineering](https://github.com/stas00/ml-engineering) | CC-BY-SA-4.0. |
| [e2b-dev/awesome-ai-agents](https://github.com/e2b-dev/awesome-ai-agents) | CC-BY-NC-SA-4.0. |
| [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) | CC-BY-NC-ND-4.0. |

## Sources licence-clean but not used

Checked, redistributable, and found to contain nothing worth adapting for this
product. Listed so the survey is reproducible.

| Source | Commit | SPDX | Why unused |
|---|---|---|---|
| [wshobson/agents](https://github.com/wshobson/agents) | `c4b82b0ad771190355eb8e204b1329732a18449a` | MIT | Agent persona files. Capability bullet lists ("Logic correctness", "Error handling") with no sequence, no commands and no verification. |
| [VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents) | `91810b33c707111e05e0988b12e7385d7b5cfe9d` | MIT | Same shape as above. The review category lists overlap entirely with what awesome-copilot states more precisely. |
| [PatrickJS/awesome-cursorrules](https://github.com/PatrickJS/awesome-cursorrules) | `b044f956f021b6e8877f16781bcfc466a6a120e9` | CC0-1.0 | Stack-specific style rules (React, Next.js, Tailwind). No trade procedure. |
| [f/prompts.chat](https://github.com/f/prompts.chat) (ex `f/awesome-chatgpt-prompts`) | `14d8fbf0f01294a86c5ea194edb43529773b122a` | CC0-1.0 for prompt content, MIT for code | Role-play prompts ("act as a ..."). Nothing procedural. |
| [learnbyexample/py_regular_expressions](https://github.com/learnbyexample/py_regular_expressions) | `b2c5735f5ba4e07b55cc455945474581e8d78858` | MIT | A book on Python `re`. Superseded by the shorter dialect table already written. |
| [promptslab/Awesome-Prompt-Engineering](https://github.com/promptslab/Awesome-Prompt-Engineering) | `6bbc3e0f8b2e1e9bbd3e9d6139608a1e8a441df9` | Apache-2.0 | A link list, not content. |
| [microsoft/prompts-for-edu](https://github.com/microsoft/prompts-for-edu) | `508567d4008b17dc1df98cbb89f88708c250f666` | MIT | Education-sector prompts, out of scope. |

## Per-skill provenance

Ten skills predate this harvest and are original Noxalis Lab work:
`analyse-documents`, `automatisation-mac`, `data-ia`, `dev-senior`,
`donnees-sensibles`, `recherche-sourcee`, `redaction-pro`, `serveurs-distants`,
`suivi-portefeuille`, `ui-ux`.

Twenty skills were added on 2026-08-08:

| Skill | Provenance |
|---|---|
| `revue-de-code` | Adapted from obra/superpowers (`requesting-code-review`), github/awesome-copilot (`code-review-generic.instructions.md`) and danielmiessler/Fabric (`review_code`). The six-pass ordering, the git-diff bounding, the line-number re-verification step and all commands are original. |
| `debogage-methodique` | Adapted from obra/superpowers (`systematic-debugging`). The `git bisect` sequence, the bounded reproduction loop under the 120 s ceiling and the scratch-file handling are original. |
| `refactoring` | Adapted from github/awesome-copilot (`skills/refactor`). The code-smell table with measurable thresholds, the mandatory test oracle at step 0 and the one-step-one-test-one-commit discipline are original. |
| `ecrire-des-tests` | Adapted from obra/superpowers (`test-driven-development`). The characterisation-test procedure for untested legacy code, the stdlib-versus-pytest availability check and the partial-suite honesty rule are original. |
| `conception-api` | **Original work.** The status-code table, the error envelope, the cursor-pagination rationale and the OpenAPI validation fallback were written for this product. |
| `sql-et-requetes` | Adapted from github/awesome-copilot (`skills/sql-optimization`, `skills/sql-code-review`). The plan-signal-to-correction table is a restructuring of their anti-pattern list. The non-interactive client constraints and the count-before-update barrier are original. |
| `expressions-regulieres` | Adapted from ziishaned/learn-regex. The BSD-versus-GNU dialect table, the positive/negative test bench and the mass-replacement procedure are original. |
| `git-chirurgie` | **Original work.** The natural source (git-flight-rules) is CC-BY-SA and was rejected. The return-branch safety net, the "is it pushed" decision command and the note that interactive rebase is impossible under `run_command` are specific to this runtime. |
| `conteneurs-docker` | Adapted from github/awesome-copilot (`containerization-docker-best-practices.instructions.md`). The secret-in-layer detection commands, the background-build pattern for the 120 s ceiling and the exit-code diagnostic table are original. |
| `kubernetes` | Adapted from github/awesome-copilot (`kubernetes-deployment-best-practices.instructions.md`). The pod-state decision table, the empty-endpoints diagnosis and the non-interactive constraints (`--request-timeout`, no `exec -it`, no `port-forward`) are original. |
| `terraform` | Adapted from github/awesome-copilot (`terraform.instructions.md`). Their content is AWS security guidance; the plan-reading procedure, the `-input=false` requirement and the JSON plan decomposition are original. |
| `incident-production` | Adapted from github/awesome-copilot (`skills/incident-postmortem`) and danielmiessler/Fabric (`analyze_incident`). The during-versus-after split, the running log file as a defence against context summarisation, and the SSH diagnostic command are original. |
| `analyse-de-logs` | Adapted from danielmiessler/Fabric (`analyze_logs`), which supplied only the "no conclusion beyond the data" restriction. The normalisation pipeline that collapses distinct lines into patterns, the per-minute histogram and the correlation procedure are original. |
| `profilage-performance` | Adapted from github/awesome-copilot (`performance-optimization.instructions.md`) for the Core Web Vitals thresholds. The measurement protocol, the `cProfile` and macOS `sample` commands, the cause table and the 10 % noise floor are original. |
| `accessibilite` | Adapted from github/awesome-copilot (`a11y.instructions.md`) for the WCAG 2.2 AA criteria and severity model. The seven detection passes with their grep commands, the contrast script and the explicit statement of what cannot be verified without a browser are original. |
| `traduction-technique` | **Original work.** Fabric's `translate` pattern was read and found too thin to adapt. The glossary-first workflow and the four mechanical checks (interpolation markers, structure, URLs, glossary consistency) were written for this product. |
| `notes-de-reunion` | Adapted from github/awesome-copilot (`skills/meeting-minutes`) for the minutes schema. The chunked reading procedure for transcripts that exceed the context window, the four-category triage and the two-entry spot check are original. |
| `tableurs-et-csv` | **Original work.** The five-trap table (encoding, decimal separator, column separator, numbers as text, ambiguous dates) reflects French-locale exports specifically. |
| `latex-et-sciences` | Adapted from danielmiessler/Fabric (`write_latex`) for the preamble constraints. The toolchain-availability check, the `-interaction=nonstopmode` requirement, the error table and the bibliography cross-check are original. |
| `prompts-locaux` | Adapted from dair-ai/Prompt-Engineering-Guide for the four elements of a specific instruction; its few-shot and chain-of-thought advice was deliberately inverted. The runtime budget figures, the symptom-to-cause table and the five-step procedure for porting a frontier prompt are original. |

## Validation

`app/skills/**/SKILL.md` is checked by a script that verifies three things:

1. every identifier used in a tool-shaped position exists in the agent's tool
   surface, and no tool name from another runtime appears anywhere (notably
   `run_workflow`, which was removed from the shipped skills and must not
   return);
2. no em dash or en dash;
3. frontmatter is exactly `name` and `description`, with `name` matching the
   directory.

Last run over all 30 skills: 0 unknown tools, 0 foreign tool names, 0 dashes,
0 frontmatter problems.
