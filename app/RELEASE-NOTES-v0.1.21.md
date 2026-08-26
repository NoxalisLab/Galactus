# Galactus Desktop v0.1.21

A native macOS app for the Galactus MoE engine: run certified open-weight
Mixture-of-Experts models fully on-device, including models several times
larger than your RAM.

Designed and developed by Noxalis Lab.

This one makes a picture speak. Give the new model a WAV file and a face,
and it renders the face saying the words - entirely on this Mac.

## Speech to video, ported by Noxalis Lab

Wan 2.2 S2V 14B did not exist in any C++ engine. It does now: Noxalis Lab
ported it - a ggml wav2vec2 speech encoder, the S2V diffusion transformer
with its audio injection layers, and the full pipeline - with every stage
verified numerically against the PyTorch reference (final output cosine
0.999996 in the shipped Q8 quantisation). The card asks for a WAV and a
starting picture, both chosen with native panels, and renders about a
second of speech per run for now: longer audio is refused with a clear
sentence rather than half-rendered.

Measured on a 128 GB Mac: 1077 seconds for 17 frames at 16 steps, on
Metal, photorealistic.

## The engine becomes a Noxalis Lab fork

Until now the bundled stable-diffusion.cpp was stock. It is now the
NoxalisLab fork, and the registry says so where it used to say unpatched.
Two additions beyond S2V itself, both upstream-worthy: a 64-bit fix for
Metal kernels that overflowed on tensors past two billion elements (the
attention of a 14B video model at render size - rendering was 56x slower
on CPU before this), and a loud warning when a Wan render is missing its
text encoder, a mistake that otherwise fails silently by ignoring the
prompt.

## Housekeeping

The audio picker joins the image picker as a native panel; registry notes
stay bilingual; the whole video path from 0.1.20 is unchanged.
