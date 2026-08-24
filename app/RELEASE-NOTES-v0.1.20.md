# Galactus Desktop v0.1.20

A native macOS app for the Galactus MoE engine: run certified open-weight
Mixture-of-Experts models fully on-device, including models several times
larger than your RAM.

Designed and developed by Noxalis Lab.

This one is about moving pictures. The Images view becomes Images & video, and
the same machine that made stills now renders clips, with sound, without a
byte leaving it.

## Video generation, on this Mac

Four video models join the registry, behind the same rules the image models
live under: verified downloads, a per-machine verdict, and a measured time on
real hardware before anything is promised.

- **MiniMax-H3** (42.8 GB) — a 33B DiT that generates the picture and a
  32 kHz stereo soundtrack in the same pass. Measured at 234 s for 22 frames
  on a 128 GB Mac. Its licence excludes the EU, the UK, South Korea and the
  US, and the app says so on the card and again before the download starts,
  while refusing still costs nothing.
- **Wan 2.2 T2V A14B** and **I2V A14B** (37.1 GB each) — Wan's two-expert
  MoE, one expert for the noisy half of the schedule and one for the clean
  half. The I2V variant animates a starting picture, chosen with a native
  file panel. Apache 2.0.
- **Wan 2.2 TI2V 5B** (12.9 GB) — the small one, text or picture in, and the
  first to install to watch a video come out of your machine. Measured at
  873 s for 25 frames, of which 784 s are the VAE decode alone.

The verdict a video model carries is not a resolution but a duration: the
card says how many seconds of clip this machine can decode, and the length
selector opens on about one second, because the VAE decode grows with the
frame count and a first click that runs most of an hour reads as a hang.

## A player that actually plays

Clips render as looping tiles in the gallery and open full-size in the
viewer, with native controls. Two findings shipped as fixes along the way:
the page's security policy allowed images as data URLs but not media, which
left every clip a dead tile; and H3's soundtrack arrives as PCM inside the
WebM, which the spec forbids and WebKit refuses wholesale. Every clip is now
split on write into a spec-clean video-only WebM and a WAV beside it, and the
viewer plays the pair in step.

## The registry speaks both languages

Model notes and licences now ship as English/French pairs and the card picks
the user's language, instead of handing half the users a paragraph in the
wrong one.

## Engine

stable-diffusion.cpp advances to master-827 and is rebuilt with WebM output
(VP8, audio muxing). Still stock, still unpatched: the one behaviour Galactus
adds, the audio split, lives in the app.
