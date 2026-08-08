# Galactus Desktop v0.1.2

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

## Speed, measured

On simulated Mac tiers, driven through the real code path, throughput read
from the server's own timings:

| model | weights | machine | generation | prompt |
|---|---|---|---|---|
| Qwen3-Next-80B | 48 GB | 8 GB | 3.8 tok/s | 4.2 |
| Qwen3-30B | 32 GB | 16 GB | 11.7 tok/s | 10.7 |
| gpt-oss-120b | 65 GB | 16 GB | 5.0 tok/s | 4.0 |
| GLM-5.2 744B | 202 GB | 64 GB | 3.1 tok/s | 3.0 |
| GLM-4.5-Air | 73 GB | 128 GB, resident | 14.4 tok/s | 26.0 |
| gpt-oss-120b | 65 GB | 128 GB, resident | 25.9 tok/s | 53.4 |

A model that fits entirely in cache stops paying the streaming regime's
safeguards: the expert cache never evicts when every expert owns a permanent
slot, so the prompt runs at llama.cpp's standard micro-batch instead of a few
tokens at a time. On a machine that cannot hold the model, the micro-batch
stays bounded by the cache, and prompt processing is the honest weak point:
ingesting a long prompt on a small Mac takes minutes.

What bit-exact means here, precisely: Galactus produces the same bits as stock
llama.cpp at equal settings. It is not, and cannot be, invariant to the
settings themselves, since llama.cpp's own reduction order depends on the
micro-batch. Within the expert block the guarantee is now verified end to end,
including the activation function, against a genuine CPU reference.

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


## Teams of sub-agents

A conversation can now be a team rather than a single assistant. The agent
creates named teammates with their own role, and **each one owns a full
conversation thread you can open and read**: every message, every command it
ran, every file it touched. A teammate's work shows in the main thread as its
own block; one click opens its thread, one click comes back.

Teammates talk to each other. The backend one can consult the reviewer on its
own initiative, without going through you, which is what makes it a team and
not a fan-out of isolated tasks. You can also address a teammate directly from
its own thread. Delegation depth is capped and a cycle is refused rather than
run, so A asking B asking A terminates. Every cross-agent call goes through the
permission dialog, which names who asked.

The team is stored with its conversation and comes back when you reopen it.
`run_workflow` is gone, folded into this: its sub-agents were anonymous,
unaddressable, died after one task and wrote their transcripts to files nobody
opened.

Settings gains a slot count, 1 to 4, deciding how many threads can generate at
once. Measured on this machine, more slots buy no aggregate throughput, the
engine is bound by the expert cache; what they buy is that no conversation is
frozen while another one answers. Each slot keeps a full 8192-token window, the
context is never silently divided.

## The model can read your past conversations

Two tools, both behind the permission gate: search across stored conversations,
and read one by id. Results are dated and attributed so an old thread is not
mistaken for the current one. Mirrored on the command line as
`galactus history search` and `galactus history read`.

## Fixed

- **Conversations lost their context.** Two causes, both closed. The app always
  opened a blank thread at launch instead of reopening the last one, so typing
  "carry on" after a restart talked to nothing. And the summary the model
  writes when a long thread no longer fits the window lived only in memory:
  reopening a digested conversation brought back its trimmed tail without the
  summary, hence an amnesic assistant.
- **The permission gate failed open.** Anything that was not an explicit deny
  counted as consent, so a dialog dismissed by other means, or a hook resolving
  nothing, authorised the action. Only an explicit approval proceeds now.
- Tool cards and teammate blocks left mid-flight by a quit came back
  permanently "running"; they are now settled as interrupted on load.
- Conversation files are written atomically.

## Changed since v0.1.0

- The expert cache no longer evicts when a layer is fully resident, so a
  resident model runs at llama.cpp's standard micro-batch and prompt
  processing is 5 to 13 times faster.
- The balanced footprint mode takes full residency when the machine affords
  it, instead of stopping at the knee of the generation curve. eco keeps its
  exact previous behaviour, it is the explicit minimum-footprint mode.
- The memory ceiling is derived from measured resident footprint instead of a
  flat constant that understated it, and leaves the machine 2 GB to run macOS.
  At its old declared threshold GLM-4.5-Air filled a 24 GB Mac to 23.5 GB.
- Machine thresholds corrected from measurement: GLM-5.2 744B drops from 96 GB
  to 64 GB, where it was measured at 3.1 tok/s. GLM-4.5-Air rises from 24 to
  32 GB, where 24 measured 1.5 tok/s. Llama-4 Scout rises to 24 GB.
- Benchmark curves re-measured for Qwen3-30B and Qwen3-Next-80B. The previous
  numbers overstated the low-cache end by up to 2x.
- The activation function of the expert block is now bit-exact with the CPU
  reference. Apple's expf is not correctly rounded, so matching it required
  replicating its algorithm with exact integer emulation of the binary64
  pipeline. Verified over all 2^32 float32 inputs, zero divergence.
- The bit-exact path warns instead of declining in silence when it cannot
  apply to a tensor.
- The model profile is mandatory once an install produced one, rather than
  silently falling back to the builtin GLM-5.2 geometry.
- The previous engine log is kept as llama-server.log.1 instead of being
  truncated at every start.

## Install

Download `Galactus_0.1.2_aarch64.dmg` and drag Galactus to Applications. The
build is not notarized: on first open, right-click then Open, or run
`xattr -dr com.apple.quarantine /Applications/Galactus.app`.

Requires macOS on Apple Silicon. Model weights are downloaded from Hugging Face
by the app itself.

## License

Apache License 2.0. If you use or redistribute this software, keep the NOTICE
file credit to Noxalis Lab (Apache 2.0, section 4).
