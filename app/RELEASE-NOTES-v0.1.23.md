# Galactus Desktop v0.1.23

A native macOS app for the Galactus MoE engine: run certified open-weight
Mixture-of-Experts models fully on-device, including models several times
larger than your RAM.

Designed and developed by Noxalis Lab.

This one opens the machine up: the local API stops being text-only, and
the Images view stops fighting the person using it.

## Your Mac serves pictures and clips, not only text

Server mode could answer chat completions and nothing else, while sitting
on the diffusion models that are the reason the machine has that much
memory. Three routes now answer on the same port, behind the same key:

    POST /v1/images/generations   OpenAI's shape, so an SDK needs no
                                  Galactus-specific code
    POST /v1/videos/generations   plus seconds or frames, and a starting
                                  picture and a WAV, as a path on this
                                  Mac or inline base64
    GET  /v1/images/models        the catalogue with this Mac's verdict
                                  on each entry

They answer whether or not a language model is running, so a Mac whose
job is diffusion no longer has to load one it will never be asked
anything. A chat request on such a machine gets a 503 that names the
reason instead of an opaque gateway error.

Half-compatibility is refused rather than papered over: `n` other than 1,
`response_format: "url"`, and clip fields on a model that makes stills
all come back as a sentence saying so.

## One click opens one panel

Choosing a starting picture asked for the file again and again, and the
viewer's close button appeared to do nothing. Both were the same defect:
a click listener was added on every repaint, so one click ran as many
handlers as the view had been repainted since it opened. Fixed at the
root, with a guard so the viewer cannot open in duplicate either.

## The Images view stops burying its own form

The model is chosen from a list now, not from eleven cards of measured
prose that pushed the prompt and the gallery below the fold; the chosen
one explains itself underneath. Generation and download carry a bar with
a percentage, travelling rather than showing a frozen zero while a video
model loads. A starting picture can be one this app already made, offered
as a strip beside the file panel. And pictures and clips save to
Downloads in one click, from the tile or from the viewer, with a clip's
soundtrack alongside it.

## Housekeeping

The relay still refuses to listen without a key, the engine still binds
127.0.0.1 and nothing else, and the new routes pass the same door as the
old ones: the key is checked before any work begins.
