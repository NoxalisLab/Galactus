![Galactus](docs/media/banner.png)

# Galactus, run the full GLM-5.2 (744B) on a MacBook Pro

![model](https://img.shields.io/badge/model-GLM--5.2%20744B--A40B-7c60e6) ![quant](https://img.shields.io/badge/quant-UD--IQ1__S%20·%201.58%20bpw-4a90d9) ![hw](https://img.shields.io/badge/hardware-M5%20Max%20·%20128%20GB-38b2ac) ![speed](https://img.shields.io/badge/measured-5.9–6.4%20tok%2Fs-2ea44f) ![app](https://img.shields.io/badge/app-macOS%20·%2030%20MB%20dmg-1a7f37)

The complete, unpruned GLM-5.2 checkpoint, 744 billion parameters, 202 GB quantized, running locally on a 128 GB laptop, at **~6 tokens/s**, with output **bit-identical** to stock llama.cpp.

The model is 1.6× larger than the machine's entire RAM. Its routed experts alone weigh 197.6 GB. Galactus treats two NVMe SSDs as an expert-serving tier behind a resident cache, wired into llama.cpp with zero copies between the cache and the compute graph.

It now ships two ways: a **desktop app** that wraps the whole thing (catalog, agent, voice, knowledge, connectors) in a 30 MB download, and the **engine** itself for people who want the raw llama.cpp patch and the numbers.

![Live demo](docs/media/demo.gif)

*Live chat, no cherry-picking, the timing lines are llama.cpp's own. Thinking mode works too: [demo (2.5× speed)](docs/media/demo-thinking.gif).*

---

## The app

A native macOS app (Apple Silicon), fully self-contained and fully offline: the patched engine, its libraries, a private Python 3.12 runtime, the on-device dictation and document helpers, the model registry and the skills all ship inside the bundle. No Homebrew, no Python install, no account, nothing ever leaves your Mac.

Grab `Galactus_x.y.z_aarch64.dmg` from the Releases page, drag, launch.

> *Video placeholder: two-minute tour of the app.*

### The Code view, and what it honestly knows

Open a folder and the app becomes an editor with the same agent thread beside it. Everything the model writes inside that folder is a **proposal**: a pending diff you accept or reject hunk by hunk. Nothing reaches the disk any other way.

Code intelligence ships in two tiers, and the file header says which one you are getting, per file, live:

| tier | what you get | where |
|---|---|---|
| **Full** | types, hover, go to definition, references, rename | JavaScript and TypeScript, from the TypeScript language service running inside the app, in a worker |
| **Syntax** | outline, breadcrumb, syntax errors, project search, symbol palette | Python, **Rust**, **C**, JSON, Markdown, HTML, CSS, from the bundled Lezer grammars. Python additionally gets exact `SyntaxError` and an exact outline from the bundled CPython 3.12 |
| **Plain** | line numbers, search, undo | anything with no bundled grammar |

**Rust and C get Syntax only.** There is no rust-analyzer and no clangd in the bundle, and there will not be one that the app downloads behind your back: a plug-and-play, fully offline app ships what it ships. The badge states the limit instead of hiding it.

Project search, the file palette (`⌘P`), the symbol palette (`⇧⌘O`) and project-wide search (`⇧⌘F`) are native Rust, no index daemon, no crate added. Version control runs through your real `git`; when this Mac has none, the panel says so and never raises Apple's Command Line Tools installer.

### Certified models

Every model in the catalog runs through the Galactus engine with a certified numeric path, never a plain native fallback. Depending on your RAM the engine picks its regime: every expert resident in cache, experts streamed from SSD behind the cache, or CPU experts for counter-verification. All three are bit-exact.

| model | size | certification |
|---|---|---|
| GLM-5.2 744B (UD-IQ1_S) | 202 GB | certified |
| Qwen3-235B-A22B-Instruct (Q4_K_M) | 142 GB | certified by composition |
| GLM-4.5-Air 106B-A12B (Q4_K_M) | 73 GB | certified, bit-transparent |
| OpenAI gpt-oss-120b | 65 GB | certified, bit-transparent |
| Llama-4 Scout 17B-16E (Q4_K_M) | 65 GB | certified, bit-transparent |
| Qwen3-Next-80B-A3B (Q4_K_M) | 48 GB | certified, bit-transparent |
| Qwen3-30B-A3B-Instruct (Q8_0) | 32 GB | certified, bit-transparent |
| Qwen3-Coder-30B (Q8_0) | 32 GB | pending certification |

Each model card shows what actually fits on your Mac, with speeds estimated from measured benchmarks, not marketing.

**Two SSDs, measured, not assumed.** Installing a large model offers a mono or dual-SSD layout. The app detects candidate volumes, measures each drive's real sequential throughput (cache-bypassing reads), and shows the verdict before you confirm: dual striping when both drives pull their weight, mono on the fast drive when the slow one would bottleneck the pair. Deleting a model from the UI is symmetric and conservative: packs living outside the app's own store are spared and reported.

> *Video placeholder: installing a model across two SSDs, bandwidth probe and verdict on screen.*

### An agent, not a textbox

The chat is a full agent loop with three autonomy levels (manual, assisted, autonomous, cycled with Shift+Tab). It reads and writes files, runs commands, browses documents, searches its local knowledge base, calls skills and fans work out to sub-agent workflows. Every file write shows a git-style diff in its tool card, including auto-approved ones, and permission prompts carry the diff before you allow anything.

While the model is writing you keep typing: messages queue up, appear in the thread immediately and run turn by turn. Context is managed adaptively, big tool outputs spill to scratch files the model re-reads on demand, and long threads are summarized by the model itself before the window overflows, so conversations do not die at the context edge.

Seven built-in skills (portfolio tracking, senior dev, UI/UX, document analysis, sourced research, professional writing, mac automation) are callable from the composer with `/`, plus a one-shot deep-research arm.

> *Video placeholder: the agent reading a folder, patching a file with visible diffs, then a multi-agent workflow.*

### Voice, knowledge, Obsidian

Dictation is on-device (macOS speech recognition, streaming partials into the composer) and answers can be spoken back. A local BM25 index turns any folders you pick into a searchable knowledge base. Connect an Obsidian vault and the agent reads and writes notes with the same diff discipline, while the Constellation view renders the vault's wikilink graph as a navigable 3D starfield, click a star to read or edit the note, or create a fresh vault from scratch.

> *Video placeholder: dictating a question, the answer spoken back, then the vault constellation.*

### Connectors and API

MCP connectors plug external tools into the agent (a knowledge-graph memory server ships preconfigured, custom servers are a form away). The running model is also exposed as a local OpenAI-compatible endpoint (`http://127.0.0.1:<port>/v1`), so any other client on your machine can use it while the app is up. Live RAM footprint and tokens/s sit in the header, and a one-click bench measures the running model with the server's own timings.

### The command line

The same binary doubles as a CLI, sharing the app's exact engine logic, regimes and pack resolution:

```bash
./galactus models                 # catalog with install status
./galactus install <model>        # download + profile + plan + pack
./galactus serve <model>          # local OpenAI-compatible API
./galactus bench                  # tok/s of the running server
./galactus remove <model>         # delete (typed-name confirmation)
./galactus status | stop
```

`serve` prints the chosen regime and the pack layout (mono or dual SSD) before the endpoint comes up.

---

## The engine

Everything below is the raw engine: what the app drives, measured and reproducible without it.

### Highlights

- **Full checkpoint.** Every layer, every expert. No pruning, no expert dropping, no distillation.
- **6× over naive streaming.** `mmap` streaming runs at 1.0 tok/s on this machine; Galactus reaches 5.9 tok/s measured end-to-end (6.4 warm), against a measured hardware ceiling of 8.04.
- **Bit-transparent quality.** A differential probe fingerprinting every MoE tensor over a full perplexity run finds *zero* divergence vs. stock llama.cpp on the CPU expert path.
- **Bit-exact Metal experts.** The GPU expert path replicates the CPU integer pipeline bit for bit for all 11 expert quant types in the catalog, verified 32768/32768 identical bits per type, maximum absolute difference 0.0.
- **Tiny integration surface.** Two source files plus a small patch over 8 llama.cpp files, everything gated behind env vars, without them the binary is byte-identical to upstream.
- **Every number is reproducible.** Each figure in this README maps to a script in `lanceurs/` that replays the measurement, guards included.

### Numbers

Measured on a MacBook Pro (Apple M5 Max, 128 GB unified memory), internal Apple SSD + Lexar NM790, packs striped across both at 15.2 GB/s sustained. Same corpus, same seed everywhere.

| configuration | throughput | perplexity |
|---|---|---|
| stock llama.cpp (reference) |, | 2.6373 |
| naive `mmap` streaming | 1.0 tok/s | 2.6373 |
| layer-granular offload (`-ncmoe`), ceiling | 4.94 tok/s | 2.6373 |
| **galactus, CPU experts** | **5.9 tok/s** (6.4 warm) | 2.6439 (75 layers) · 2.6373 bit-exact (per layer) |
| hardware ceiling (closed model) | 8.04 tok/s |, |

The 8.04 ceiling is not a guess: a three-constant model (expert bytes per token, storage throughput, compute time) predicts throughput within 1% across four independent cache sizes. It also proves 15 tok/s would need ~200 GB of RAM, see `docs/PHYSICAL-MODEL.md`.

The Metal expert path used to trade precision for speed (measured drift per quant class: −0.24% to +1.79%). That trade is gone: under `GALACTUS_METAL_BITEXACT=1` the `mul_mat_id` kernels replicate the CPU algorithm exactly (same Q8 activation quantization, same integer dot products, same summation order, fast-math reassociation fenced off), and a dedicated parity probe confirms bit-identity on every expert quant type. The app runs this path by default; without the env var the kernels are byte-identical to upstream.

### How it works

```
GGUF (202 GB, 6 shards)                    2 × NVMe packs (197.6 GB)
   │  non-expert weights (15.6 GB)            │  19,200 expert records,
   ▼                                          │  contiguous, 16 KiB-aligned
llama.cpp ──────────► RAM                     ▼
   │                              pinned arena (up to ~92 GB)
   │  router picks 8 experts         ▲ per-layer SLRU cache
   ▼                                 │ pread + F_NOCACHE on miss
remap node: expert id ──► arena slot ┘
   ▼
mul_mat_id reads the arena directly (nb[2] = pack record stride, zero copy)
```

1. **Packs.** The 19,200 routed experts (75 layers × 256) are repacked out of the GGUFs into two files, one per SSD, one contiguous record per expert. The cut point between volumes comes from each drive's measured throughput.
2. **Resident store.** A pinned arena holds a per-layer quota of expert slots. A per-layer SLRU decides who stays, benchmarked against W-TinyLFU, windowed LFU and global SLRU; recency dominates this workload and per-layer SLRU wins.
3. **Zero-copy wiring.** Expert tensors are created with the arena's record stride and backed directly onto it. The GGUF is never read for routed experts.
4. **Remap + serve.** A graph node after the router rewrites expert ids into slot ids and synchronously serves the layer, cache hits cost nothing, misses stream from the packs into their slots before `mul_mat_id` runs.

### Engine quickstart (without the app)

You need the GLM-5.2 UD-IQ1_S GGUFs (~202 GB) and two fast SSDs.

**1, Build llama.cpp with the patch**

```bash
git clone https://github.com/ggml-org/llama.cpp third_party/llama.cpp
cd third_party/llama.cpp && git checkout $(cat ../../patches/UPSTREAM-COMMIT.txt)
../../patches/appliquer.sh .
cmake -B build -DGGML_METAL=ON && cmake --build build -j
```

**2, Build the expert packs** (one-time, ~200 GB written; put each output on its own SSD)

```bash
# plan: maps every expert record to its GGUF source spans
python3 scripts/h4-pack-plan.py --model-directory /path/to/UD-IQ1_S --output plan.json

# packs: fixture mode first (3 records, seconds) to validate the chain end-to-end
python3 scripts/h4-pack-write.py --mode fixture --plan plan.json \
  --expected-plan-sha256 $(shasum -a 256 plan.json | cut -d' ' -f1) \
  --model-directory /path/to/UD-IQ1_S --manifest manifest.json \
  --fixture-output-directory /tmp/fixture

# then the real thing (the confirmation string is printed by the tool)
python3 scripts/h4-pack-write.py --mode full --plan plan.json \
  --expected-plan-sha256 $(shasum -a 256 plan.json | cut -d' ' -f1) \
  --model-directory /path/to/UD-IQ1_S --manifest manifest.json \
  --internal-output-directory /Volumes/InternalSSD/GalactusH4 \
  --external-output-directory /Volumes/ExternalSSD/GalactusH4 \
  --confirm-full-pack WRITE-CONTRESIGNED-H4-P0V2-19200
```

**3, Run**

```bash
GALACTUS_H4=1 \
GALACTUS_H4_INTERNAL=/Volumes/InternalSSD/GalactusH4/h4-p0v2-internal.pack \
GALACTUS_H4_EXTERNAL=/Volumes/ExternalSSD/GalactusH4/h4-p0v2-external.pack \
GALACTUS_H4_CACHE_BYTES=92000000000 \
build/bin/llama-cli --model GLM-5.2-UD-IQ1_S-00001-of-00006.gguf \
  --ctx-size 4096 -ngl 99 --no-repack --fit off --no-mmap -b 2 -ub 2
```

Or use `lanceurs/LANCER-CHAT.command` for an interactive session with sane defaults. Main knobs: `GALACTUS_H4_CACHE_BYTES` (resident cache size, throughput scales with it), `GALACTUS_METAL_BITEXACT=1` (bit-exact GPU experts, the app's default), `GALACTUS_H4_CPU_MOE=1` (bit-exact CPU experts, for counter-verification), `GALACTUS_H4_QD` (read queue depth, default 32).

### The bug worth reading about

The first wired build produced fluent text, and a perplexity of 13.74 instead of 2.64. The hunt took a full day and four purpose-built instruments: layer bisection, a zero-eviction probe, a byte-level audit of 768 expert records against the GGUF, and a full-run differential fingerprint of every MoE tensor. Each cleared a suspect. The breakthrough came from a paradox, identical tensor dumps, different perplexities, which exposed the probe's own blind spot, and behind it the real bug: `selected_experts` is a non-contiguous ggml view (`ggml_top_k`), and the remap read it linearly. Every token after the first in each micro-batch was silently routed to its neighbor's experts.

One stride-aware read later: 13.74 → 2.6439, and the differential probe now shows bit-identity. Full story in `docs/STUDY.md` §7. The takeaway is engraved as a rule: *a ggml tensor is a view until proven otherwise, read through `nb[]`, never linearly.*

### Documentation

| | |
|---|---|
| `docs/STUDY.md` | complete study: hardware, method, all benchmarks, the bug hunt |
| `docs/PHYSICAL-MODEL.md` | the machine's closed physical model and its ceilings |
| `patches/` | pinned llama.cpp diff + apply script |
| `lanceurs/` | the exact scripted runs behind every number above, by category |

### Porting to another MoE model

Galactus is currently wired for GLM-5.2 UD-IQ1_S, and honestly so: several pieces are frozen constants, not parameters. If you want to port it, this is the actual work list:

1. **Record geometry** (`src/h4/h4-core.*`), the per-layer record sizes are a frozen table generated from this checkpoint's GGUF layout. `scripts/analyze-gguf-layout.py` recomputes tensor geometry for any GGUF and self-checks against shard sizes; regenerate the table from its output.
2. **Pack plan and packer expectations** (`scripts/h4-pack-plan.py`, `scripts/h4-pack-write.py`), record count, total bytes and volume split are asserted against frozen values. Recompute the split from your drives' measured throughputs, update the constants.
3. **Cache key layout** (`src/h4/h4-expert-cache.hpp`), keys are `layer << 8 | expert`, which assumes ≤ 256 experts per layer; first/last MoE layer are constants.
4. **The architecture hook** (`patches/`), expert-tensor creation is intercepted in the model's build function (`glm-dsa.cpp` here). Other MoE archs need the same 15-line branch in their own file.
5. **Re-verify, don't trust.** The verification tools are model-agnostic once the plan exists: byte-level content audit (`LANCER-VERIF-EXHAUSTIVE`), zero-eviction probe, full-run differential fingerprints. Run all three before believing any perplexity number, this project's history shows why.

The economics also move: this approach pays when expert bytes dwarf RAM and your storage is fast relative to `(model_bytes_per_token × miss_rate)`. The closed model in `docs/PHYSICAL-MODEL.md` section 1 gives the formula, three measured constants and you know your ceiling before writing a line.

### Limitations

Engineering for one machine and one model: the method transfers, the frozen constants don't. Interactive batch is capped at 2 by the cache residency bound. And 0.25% of perplexity on the 75-layer run remains unexplained while each layer alone is bit-transparent, open item, documented.

---

## Credits and license

Built by **Noxalis Lab**. Apache 2.0, see `LICENSE` and `NOTICE`: if you use Galactus, keep the credit visible.
