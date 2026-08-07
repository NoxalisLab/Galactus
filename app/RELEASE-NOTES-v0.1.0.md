# Galactus Desktop v0.1.0

First public build of the Galactus desktop assistant for macOS (Apple Silicon).
Designed and developed by Noxalis Lab.

A native app for the Galactus MoE engine: run certified open-weight
Mixture-of-Experts models fully on-device, including models several times
larger than your RAM, and let them work on your files, shell and notes behind a
strict permission gate. GLM-5.2 744B, 202 GB quantized, runs on a 128 GB laptop
at about 6 tokens/s with output bit-identical to stock llama.cpp.

## Self-contained

The 28 MB download carries everything it needs: the patched engine and its
libraries, a private Python 3.12 runtime, the on-device dictation and document
helpers, the model registry and the skills. No Homebrew, no Python install, no
checkout, no account. Nothing leaves your Mac.

## Certified models

Every model runs through the Galactus engine, never as a plain native
llama.cpp run: the app verifies the engine wiring is actually linked in before
starting anything, and refuses otherwise. Depending on your RAM the engine
picks its regime (all experts resident in cache, experts streamed from SSD, or
CPU experts for counter-verification). All three are bit-exact.

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

The GPU expert path is bit-exact too: the Metal `mul_mat_id` kernels replicate
the CPU integer pipeline for all eleven expert quant types, verified
32768/32768 identical bits per type, maximum absolute difference 0.0.

A model below the minimum memory for your Mac is refused, at install and at
start, rather than failing later. On a 24 GB Mac the catalog still runs a 235B
model from a 14 GB cache.

## Speed

On a 128 GB MacBook Pro, GLM-4.5-Air fully resident: prompt 31 tok/s,
generation 15.5 tok/s. GLM-5.2 744B, 202 GB streamed from two SSDs: about
6 tok/s. Speeds shown on each model card are interpolated from measured
benchmarks for your machine, not extrapolated from a spec sheet.

A model that fits entirely in cache no longer pays the streaming regime's
safeguards: the expert cache stops evicting when every expert owns a permanent
slot, so the prompt is processed with llama.cpp's standard micro-batch of 512
instead of a few tokens at a time.

What bit-exact means here, precisely: Galactus produces the same bits as stock
llama.cpp **at equal settings**. It is not, and cannot be, invariant to the
settings themselves. llama.cpp's own reduction order depends on the physical
micro-batch, so two micro-batch sizes can differ in the last bits and, under
greedy decoding, occasionally pick a different token when two candidates are
nearly tied. That is upstream behaviour, measured here at micro-batch 2, 7 and
512 on a fully resident model where the expert cache evicts nothing at all. The
resident regime now runs at llama.cpp's own default of 512.

## What it does

- **Chat that acts.** Three autonomy levels (manual, assisted, autonomous),
  streaming, live plan panel, Markdown with HTML / SVG / Mermaid preview. Every
  file write shows a git-style diff in its tool card, including auto-approved
  ones. Type a message while the model is writing and it queues for the next
  turn.
- **Permission gate on every action.** Allow once, always, or deny, with the
  diff shown before any write. System-modifying commands require typing
  `ALLOW` and never receive a standing rule.
- **Adaptive context.** Large tool outputs spill to scratch files the model
  re-reads on demand, and long threads are summarized by the model itself
  before the window overflows, so a conversation does not die at the context
  edge.
- **Two SSDs, measured.** Installing a large model offers a mono or dual-SSD
  layout: the app detects candidate volumes, measures each drive's real
  sequential throughput, and shows the verdict before you confirm. Deleting a
  model is symmetric and conservative.
- **Voice, knowledge, Obsidian.** On-device dictation and spoken answers, a
  local BM25 index over folders you pick, and vault notes read and written with
  the same diff discipline. The Constellation view renders the vault's wikilink
  graph as a navigable starfield.
- **Connectors and API.** MCP connectors plug external tools in; the running
  model is exposed as a local OpenAI-compatible endpoint for any other client.
- **Command line.** The same binary doubles as `galactus`: models, install,
  serve, bench, remove, status, stop, sharing the app's exact engine logic.
- Bilingual interface (Français / English), fonts bundled, fully offline.

## Hardening

This build follows two full audits of the app, frontend and Rust backend, with
every finding independently verified before being fixed. Roughly fifty
confirmed defects, among them: a path traversal that let an agent rewrite the
settings file and therefore the connector commands, a standing read grant that
could be widened to the whole disk, elevated-command detection bypassed by a
path-qualified command or by backticks, orphaned engine processes surviving app
exit, pipe deadlocks on outputs over 64 KB, a stuck generating state that
killed the chat, and a settings write that could wipe every key. Details in the
commit history.

## Install

Download `Galactus_0.1.0_aarch64.dmg` and drag Galactus to Applications. The
build is not notarized: on first open, right-click then Open, or run
`xattr -dr com.apple.quarantine /Applications/Galactus.app`.

Requires macOS on Apple Silicon. Model weights are downloaded from Hugging Face
by the app itself.

## License

Apache License 2.0. If you use or redistribute this software, keep the NOTICE
file credit to Noxalis Lab (Apache 2.0, section 4).
