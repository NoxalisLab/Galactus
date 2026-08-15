# Galactus Desktop v0.1.15

A native macOS app for the Galactus MoE engine: run certified open-weight
Mixture-of-Experts models fully on-device, including models several times
larger than your RAM.

Designed and developed by Noxalis Lab.

Two fixes finishing the work 0.1.14 started. Take this one instead of 0.1.14.

## A dense model can now actually be installed and started

0.1.14 added Qwen3.8 27B, a dense model, and the app was not ready for it in
two places that only show once someone tries.

**It could never count as installed.** The test was "the weights are here AND
the pack is here". A dense model has no pack and never will, so the flag went
false the moment the download finished and stayed there: the file was on disk,
complete and runnable, and the card went on offering to download it again with
no button able to change that. An MoE model still needs both, because the engine
reads its experts out of the pack and weights alone are a job half done.

**The backend refused to start it.** The execution gate accepts a list of
certification regimes, and a dense model carries none of them: with no expert
tensors to substitute there is no Galactus path to compare against stock
llama.cpp, so there is nothing to certify. The gate exists to stop a modified
execution path whose fidelity is unproven, and an unmodified one carries no such
risk. It now says so explicitly rather than rejecting the model with a message
about an unsupported status.

Both halves are tested, including the ones that must keep failing: a model
awaiting certification, a status nobody recognises, and an entry with no status
at all are all still refused.

## Everything in 0.1.14

Qwen3.8 27B itself, dense, labelled "stock, not accelerated" rather than
borrowing the certified badge, since there is nothing here for the differential
probe to compare. 114 tok/s prompt and 30 tok/s generation on an M5 Max, 17.1 GB
on disk, 32 GB of RAM required because nothing streams.

## Install

Download the dmg, drag it to Applications. The build is signed but not notarized,
so the first launch needs a right-click and Open.
