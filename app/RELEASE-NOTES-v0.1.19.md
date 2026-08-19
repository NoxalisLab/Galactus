# Galactus Desktop v0.1.19

A native macOS app for the Galactus MoE engine: run certified open-weight
Mixture-of-Experts models fully on-device, including models several times
larger than your RAM.

Designed and developed by Noxalis Lab.

This one is about image generation growing up: the picture models now answer to
the machine the way the language models already do.

## Image models sized to the machine

Every image model now carries a per-machine verdict. Before a download starts,
Galactus weighs the model against the RAM it can actually use and says whether
it will run, at what resolution, and how many steps are realistic, instead of
letting you pull gigabytes for a generation that would swap itself to death. It
is the same reasoning the model list has always used for the LLMs, now applied
under the pictures.

The request you make is then clamped to what the verdict allows: a machine that
can hold 768 pixels is not handed 1024, and the VAE is moved to the CPU when
keeping it on the GPU is what tips a generation over the edge.

## Flux comes out in colour

Flux decoded its VAE on Metal and returned a white square. It decodes on the
CPU now, slower by a few seconds and right instead of blank.

## An uncensored option

Qwen3.8 27B is available in its abliterated build, for the work the aligned
weights will not touch. It sits beside the standard model rather than replacing
it.

## Install

Download the dmg, drag it to Applications. The build is signed but not
notarized, so the first launch needs a right-click and Open.
