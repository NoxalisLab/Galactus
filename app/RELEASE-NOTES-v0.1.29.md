# Galactus Desktop v0.1.29

A native macOS app for the Galactus MoE engine: run open-weight
Mixture-of-Experts models fully on-device, including models several times
larger than your RAM.

Designed and developed by Noxalis Lab.

This release adds one model, and the engine learns the architecture it needs.

## GLM-5.3-Flash

| model | on disk | what it is for |
|---|---|---|
| GLM-5.3-Flash (UD-IQ1_S) | 93 GB | a large reasoning and code model with a 1M token window, 288 experts |

GLM-5.3 comes in two shapes. The 744B keeps GLM-5.2's architecture. The
Flash is a new one, `glm5next`, which no released llama.cpp can load yet: it
mixes linear attention on most layers with sparse attention on the rest, and
routes each token to 8 of 288 experts. The engine now carries it, taken from
the upstream pull request that produced these GGUF files and rebased on the
engine's pinned llama.cpp.

It is certified bit-transparent like the rest of the catalogue: 5397 tensors
identical between the Galactus wiring and stock llama.cpp, perplexity 8.9656
on both sides.

Measured on a 128 GB M5 Max, fully resident on Metal: 29 tok/s on a short
prompt. On a 19,948 token prompt it found a code hidden in the middle and
where it sat, exactly, reading the prompt at 190 tok/s and answering at
18 tok/s.

## Fixed

- Installing a model whose first GGUF shard holds only metadata failed at the
  profile step with "trait identity MISMATCH". GLM-5.3-Flash is shipped that
  way. Such a shard is accepted now; every other shard is checked exactly as
  before.

## Known limits

- GLM-5.3-Flash is measured on a 128 GB Mac only. Smaller Macs wait for its
  speed curve.
- UD-IQ1_S is a 1.56 bit quantization, the only one that fits beside the
  system on 128 GB. It reasons and retrieves correctly in the tests above, but
  it is not the full model's quality.
- The model's vision tower and its multi-token prediction head are not used
  by the app yet: it runs as a text model.
- The `glm5next` graph is not merged upstream yet. It will be replaced by the
  upstream version once it is.
