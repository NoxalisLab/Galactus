# Galactus Desktop v0.1.7

A native macOS app for the Galactus MoE engine: run certified open-weight
Mixture-of-Experts models fully on-device, including models several times
larger than your RAM.

Designed and developed by Noxalis Lab.

This release is about the claim at the centre of the project, tested rather
than asserted: that adding a Mixture-of-Experts model to Galactus does not
require touching the engine.

## Two architectures the project had never seen, certified with no code change

The README used to say that porting to another MoE architecture meant
regenerating frozen constants and writing a fifteen-line branch in that
architecture's own file. It was measured instead of argued, and it was false.

**OLMoE 1B-7B (`olmoe`) and Phi-3.5-MoE (`phimoe`) each went from a download to
a certified model with no code change at all.** Profile, plan, pack, certify.
OLMoE: 5140 tensors identical, zero divergence, perplexity 3.988 on both sides.
Phi-3.5-MoE: 5140 tensors identical, zero divergence, perplexity 1.4584 on both
sides. The profiler found the geometry on its own in both cases, 16 MoE layers
with 64 experts for one and 32 layers with 16 experts for the other.

The hook lives in `llm_graph_context::build_moe_ffn`, the graph builder every
MoE architecture shares, plus an interception at tensor creation keyed on the
tensor name. No architecture file is touched: `glm-dsa.cpp` contains no
reference to Galactus at all.

The catalog is now ten models and none pending. `qwen3-coder-30b`, marked
awaiting certification since the day it was added, is certified: 5654 tensors
identical, perplexity 12.5312 on both sides.

## One certifier instead of thirteen launchers

`lanceurs/differentiel/` held one script per model and `lanceurs/banc/` another,
each with its own paths baked in. Adding a model meant copying a file and
editing six constants, which is exactly why the two most recent models had no
differential at all and one stayed pending from the start.

`scripts/certify.py` takes a model id and reads everything else from the
registry and from disk. The verdict is byte for byte: same corpus, same seed,
same batch shape, run twice, once wired and once stock, comparing the
fingerprint of every MoE tensor of one layer. One differing line fails. No
tolerance, because a tolerance is how a regression that moves the eighth
decimal ships as close enough and later moves the second.

It refuses one thing outright. llama.cpp offloads to the GPU once the batch
reaches `op_offload_min_batch_size`, which is 32, and above that `--n-cpu-moe`
stops being a CPU reference: the stock run goes partly through Metal and the
comparison measures nothing. That mistake invalidated a whole perplexity table
in this project once.

## Ask a GGUF whether it can be used, before downloading it

A 26 GB Mixtral download finished, and only then did the profiler report the
file was unusable. TheBloke's 2023 quantization stores experts as 768 separate
per-expert tensors, from before llama.cpp merged them into fused `*_exps`
tensors, and the engine intercepts the fused ones. Every Mixtral GGUF checked
afterwards, including a 2024 requantization, has the same layout, and nothing
on a repository page says which one a file uses.

A GGUF puts its magic, its metadata and its full tensor directory at the very
start of the file, weights after, and Hugging Face serves range requests. So
`scripts/probe-gguf.py` answers "can the engine use this file" in eight
megabytes and a second, instead of an hour and a full disk. It reports usable,
legacy or dense, and says why. It is what selected OLMoE and Phi-3.5-MoE and
rejected Mixtral, without downloading any of them.

## Server mode, completed

The relay shipped in 0.1.6 now comes with ready-to-paste settings for the
clients people actually use, generated from the live relay state so the host
and port are the ones actually listening: a curl call, the three plain values
for Cursor and Continue, the `language_models` block for Zed, and the two
environment variables any OpenAI SDK reads, which is how an Obsidian plugin is
configured. Showing a base URL and stopping there looked complete and was not.

## Install

Download `Galactus_0.1.7_aarch64.dmg` and drag Galactus to Applications.
Signed with a local identity, not notarized, so the first launch goes through
right-click then Open. Apple Silicon only.

## Verification

612 frontend tests and 111 Rust tests pass. Ten models certified
bit-transparent, verified by a differential run, not by declaration.

## Known, not fixed here

rust-analyzer starts at launch on a restored Rust workspace, before the user
has opened anything, and a cold index costs minutes of CPU for someone who
came back to write a paragraph in Chat. The fix is to arm it and let the first
Rust file opened fire it. It touches the Code view's startup path and could not
be verified against a cold index tonight, so it waits rather than shipping
unproven.

Two of the ten models carry no throughput curve yet. They are certified
bit-transparent, which is a different claim and the one that gates
availability.
