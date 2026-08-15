# Galactus Desktop v0.1.14

A native macOS app for the Galactus MoE engine: run certified open-weight
Mixture-of-Experts models fully on-device, including models several times
larger than your RAM.

Designed and developed by Noxalis Lab.

A thirteenth model, and it is the first one the engine does nothing for.

## Qwen3.8 27B, dense, and labelled as such

Qwen3.8 27B has no routed experts. There is nothing to repack, nothing to
cache, nothing to stream: the engine that makes a 65 GB model fit in 16 GB of
RAM simply does not apply to it. It is in the catalogue because it is worth
running, not because it benefits from any of this, and its card says so.

Three parts of the app had to learn that a model can be dense. The installer
stops after the download, because the profiler refuses a dense checkpoint
outright and running it would fail the install of a model that is, in fact,
complete. The engine starts without the streaming layer, which would otherwise
point at a pack that does not exist. And the regime it reports is named
stock-llamacpp, because every other name in that field is a claim about expert
numerics and this one has no experts to make a claim about.

It carries a new status rather than borrowing an existing one. With no expert
tensors to substitute, the differential probe has nothing to compare, so the
bit-exactness claim every other card makes cannot be made here. Its badge reads
"stock, not accelerated" and its note explains why. Wearing the certified badge
would have been the one unverifiable square inch on a page whose entire argument
is that its claims can be checked.

Measured on an M5 Max: 114 tok/s prompt, 30 tok/s generation, 17.1 GB on disk,
32 GB of RAM required because nothing streams and the weights are resident from
the first token.

## Also in 0.1.13, if you skipped it

GLM-5.2 could not be installed from the app at all: its entry carried no
download block, and two absolute paths from the machine it was first packed on,
which shipped to every user and were consulted before the standard pack store.
Both fixed, and two tests now read the shipped catalogue on every run: every
entry must be downloadable, and none may carry a path from one machine.

## Install

Download the dmg, drag it to Applications. The build is signed but not notarized,
so the first launch needs a right-click and Open.
