# Galactus Desktop v0.1.22

A native macOS app for the Galactus MoE engine: run certified open-weight
Mixture-of-Experts models fully on-device, including models several times
larger than your RAM.

Designed and developed by Noxalis Lab.

This one is about time and memory: the same clips, several times faster,
on smaller machines, and as long as your voice file.

## The clip lasts as long as the WAV

The speech model no longer stops at one second. Give it six seconds of
voice and the engine chains autoregressive segments, each seeded with the
motion of the last - the seam between segments measures SMOOTHER than the
clip's own normal motion. The duration selector disappears on those cards:
the WAV decides.

## Nine times faster when you ask

A "Fast" checkbox appears on the cards that earned it. It decodes through
a tiny VAE: measured 95 seconds instead of 873 on Wan TI2V-5B for the
same clip, at the price of slightly watercolour colours. The speech model
also gains EasyCache, which skips the diffusion steps that barely change
anything: 872 seconds instead of 1208, indistinguishable to the eye.

## A speech model for 32 GB Macs

"Wan 2.2 S2V 14B léger": the Q4 profile with a segmented compute budget,
measured at a 20.1 GB peak. It fits where the full card cannot, and the
card system already refuses both variants on machines that cannot carry
them - before the download, not after.

## Housekeeping

Every quality and speed claim above is a measured run on real hardware,
recorded in the registry next to the model it describes.
