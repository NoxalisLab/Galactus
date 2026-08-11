# Galactus Desktop v0.1.12

A native macOS app for the Galactus MoE engine: run certified open-weight
Mixture-of-Experts models fully on-device, including models several times
larger than your RAM.

Designed and developed by Noxalis Lab.

One fix, and it is the reason to take this release rather than 0.1.11.

## An upgraded install kept the catalogue it was born with

The model catalogue, the profiler and the two pack scripts are refreshed from
the app bundle on launch. That refresh lived inside the code path that runs when
no Galactus folder is configured yet, which is to say: only on a first
installation. Anyone who had ever launched an older build already had a folder
recorded in their settings, so the app found it, accepted it, and returned
immediately. The branch that keeps the catalogue current was exactly the branch
every existing user never took.

The effect was invisible until the catalogue actually changed. Upgrading to
0.1.11 brought two newly certified models, Qwen3.6 35B-A3B and Mellum2
12B-A2.5B, and existing installs did not show them: their model list, and the
measured throughput curves behind it, were frozen at whatever shipped the day
they first installed the app.

The refresh now runs for a configured folder as well, once per launch, unless
that folder is a git checkout. A checkout is somebody's working tree: the
registry inside it is edited, measured into and committed, and copying the
bundled copy over it would destroy work between two launches. The test is the
presence of a `.git` entry, file or directory, because a linked worktree carries
it as a file and a check for a directory alone would have written straight into
one.

If you are on 0.1.11 and your catalogue is missing Qwen3.6 and Mellum2, this
release fixes it on the next launch. Nothing else is needed, and no model you
have already downloaded is touched.

## Everything in 0.1.11

This release carries all of it: the two new certified architectures, reasoning
shown on screen as it arrives, tool calling restored on models that think, and
the handful of interface faults that made working things look broken. See the
0.1.11 notes for the detail.

## Install

Download the dmg, drag it to Applications. The build is signed but not notarized,
so the first launch needs a right-click and Open.
