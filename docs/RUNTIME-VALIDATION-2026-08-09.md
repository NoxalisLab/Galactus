# Galactus runtime validation — 2026-08-09

## Verdict

The seven certified models in the product registry start, answer through the
OpenAI-compatible local endpoint, and stop cleanly on the reference M5 Max
with 128 GiB unified memory. The pending Qwen3-Coder model fails closed before
an engine process is created.

No run increased swap usage. The most demanding run, GLM-5.2 744B in `perf`,
kept at least 12% system memory free and reached 4.78 generated tokens/s over
128 measured tokens after warm-up.

## Method

`scripts/safe-model-smoke.py` launches one model at a time with one decode
slot. It warms the Metal path, sends a measured request, samples macOS memory
pressure, process RSS and swap every two seconds, and always terminates the
exact process group.

The run is stopped automatically when any of these conditions is met:

- system memory stays at or below 5% free for 10 seconds;
- memory reaches 1% free;
- Galactus server RSS exceeds 125 GiB;
- swap grows by 2 GiB while memory is at or below 10% free.

Raw JSON samples and server logs live under `.gstack/model-smoke/` and are not
part of the distributable bundle.

## Measured `perf` results

Each throughput result below is a post-warm-up generation capped at 128 tokens.
Results are single-run measurements, not statistical confidence intervals.

| Model | Generated tok/s | Minimum memory free | Peak server RSS | Swap growth |
|---|---:|---:|---:|---:|
| Qwen3-30B-A3B | 23.99 | 66% | 22.27 GiB | 0 MiB |
| gpt-oss-120b | 19.15 | 43% | 48.11 GiB | 0 MiB |
| Qwen3-Next-80B | 18.53 | 55% | 18.40 GiB | 0 MiB |
| Llama-4 Scout | 16.79 | 42% | 51.21 GiB | 0 MiB |
| GLM-4.5-Air | 11.94 | 38% | 60.61 GiB | 0 MiB |
| Qwen3-235B-A22B | 6.09 | 21% | 86.04 GiB | 0 MiB |
| GLM-5.2 744B | 4.78 | 12% | 99.27 GiB | 0 MiB |

Process RSS and macOS memory pressure measure different views of unified Metal
allocations. The stop gate therefore uses both, plus swap growth.

## `eco` functional smoke tests

All seven models also passed a short generation in `eco`. These runs prove the
streamed path but are too short to use as a stable performance baseline.

| Model | Short-run tok/s | Minimum memory free | Peak server RSS |
|---|---:|---:|---:|
| Qwen3-Next-80B | 11.93 | 92% | 5.90 GiB |
| Qwen3-30B-A3B | 11.94 | 87% | 12.78 GiB |
| gpt-oss-120b | 3.83 | 87% | 13.88 GiB |
| Llama-4 Scout | 4.82 | 81% | 19.74 GiB |
| GLM-4.5-Air | 2.60 | 81% | 21.27 GiB |
| Qwen3-235B-A22B | 1.82 | 80% | 21.56 GiB |
| GLM-5.2 744B | 4.13 | 12% | 84.21 GiB |

## Memory policy

The runtime now reserves `max(2 GB, 6.25% of unified memory)` before planning
the expert cache. This leaves 2 GB on 16/24/32 GB Macs, 4 GB on a 64 GB Mac and
8 GB on a 128 GB Mac. The existing 70% hard ceiling on the expert cache remains
independent. The UI estimator mirrors the Rust formula.

Model selection still fails closed at all three surfaces:

1. the catalogue disables install and start actions;
2. the Rust backend rechecks certification and `min_ram_gb`;
3. the standalone CLI enforces the same policy.

GLM-5.2 744B requires 128 GB in the shipped registry. Qwen3-Coder remains
`pending_certification` and cannot be installed or started.

## Distribution evidence

- DMG: `app/src-tauri/target/release/bundle/dmg/Galactus_0.1.3_aarch64.dmg`
- SHA-256: `4fcaa0d185381f14ef60732beab4ca656d23c585cb1e1e22f3b765495143eed2`
- mounted app signature: valid ad hoc signature and designated requirement;
- packaged policy: GLM-5.2 minimum 128 GB;
- packaged content: 50 vault notes and 30 skills.

The final build passes 186 frontend tests and 46 Rust tests. A restored,
existing workspace was also exercised through the packaged application. The
startup path now reads the root tree before deciding whether TypeScript
intelligence is relevant, so a non-JavaScript workspace does not import the
9 MB TypeScript service on the cold path. A vanished saved workspace is
forgotten without blocking the application splash screen.

Three README demonstrations were captured from that installed build and
checked at multiple timestamps: the 31-second app tour, the 24-second hardware
policy tour, and the 27-second Agent/IDE flow. Each ships as a 1280×800 H.264
MP4 with a 960×600, 10 fps GIF preview.

Public distribution still requires a Developer ID signature and Apple
notarization. Those credentials were not available during this validation.
