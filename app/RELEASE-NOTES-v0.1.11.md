# Galactus Desktop v0.1.11

A native macOS app for the Galactus MoE engine: run certified open-weight
Mixture-of-Experts models fully on-device, including models several times
larger than your RAM.

Designed and developed by Noxalis Lab.

Two architectures the engine had never seen are in the catalogue, both certified
bit-exact. A model that thinks before it answers now shows you the thinking. And
a handful of faults that only appeared while the app was being used for real,
each of which made something look broken that was not.

## Two new architectures, twelve models

**Qwen3.6 35B-A3B** and **Mellum2 12B-A2.5B Thinking** are the first `qwen35moe`
and `mellum` checkpoints the engine has run. Both were held to the same standard
as the rest: every MoE tensor compared against stock llama.cpp over a full
perplexity run, zero divergence.

Qwen3.6 owns 256 experts and reads 8 of them per token: 32 bytes held for every
byte touched, the widest ratio in the catalogue and exactly the shape SSD
streaming exploits. Its prompt throughput climbs 5.3x across the measured curve,
from 37.7 tok/s on a 2.45 GB cache to 199.5 with every expert resident.

Mellum2 had been dropped once on a diagnosis made in eight seconds, mixed
quantization, which was wrong. The real cause was graph sizing: the engine
substitutes every expert tensor and inserts a remap node per MoE layer, so the
graph carries more nodes than the model's own tensor count predicts. On mellum,
whose 339 tensors gave only 2712 nodes, the fused-op probe overflowed the
scheduler hash set and aborted before any inference ran.

Two entries that claimed bit-exactness with no perplexity recorded against them,
gpt-oss-120b and qwen3-coder-30b, were re-run. Both are clean, and the numbers
are now in the registry: a claim nobody can check is not a claim.

## Thinking, on screen

llama-server already separated a model's reasoning from its answer. The app read
the answer and dropped the rest, so a model that thought for thirty seconds
looked like an application that had hung.

The reasoning now appears as it arrives, greyed, from the first thought token.
When the answer starts the block folds to a single line and the answer takes the
space; a click reopens it. It never enters the message history, so it does not
travel back into the model's context, and a model that emits no reasoning leaves
nothing behind, not even an empty container.

## Tool calling on a model that thinks

The probe that decides whether a model can drive tools gave it 64 tokens to
answer. A reasoning model spends its opening tokens reasoning, so it was cut off
before it ever reached the call and was recorded as unable to drive tools. The
Code and Runs tabs locked against it, and the agent was handed no tools at all,
which meant asking one to write a file could only ever produce prose about
writing a file.

A truncated answer is no longer read as a verdict. The budget is 512 tokens with
one retry at 4096, and the probe asks the chat template to skip thinking where
the template honours it.

## Faults that made working things look broken

**A download rebuilt the whole application on every progress event.** Several
times a second, for minutes, and each rebuild threw away the scroll position, so
the card whose download you were watching was the one that scrolled away. A tick
now repaints one bar.

**A command that outlived its 120-second deadline reported nothing.** `uvicorn`
had already printed the address it was serving on, which is the proof it worked,
and the model was handed the words "(timed out)" instead: it read that as failure
and ran the same command again. The report now carries what the command printed
and names the one thing that would make a retry differ. Standard input is closed,
so nothing can wait for an answer that cannot come.

**The models page crashed on ordinary data.** The planner answers null when it
has nothing to say about a model, and the code that drew the summary read a field
off it without looking.

**The terminal pane stayed open after its last tab closed**, spending a third of
the editor on a sentence about its own emptiness.

**An empty warning drew a red box with no text** in the volume dialog, in the
normal case where the chosen drives have room.

## Measurement

The bench can now name the small diagnostic tiers, which have no Mac size to be
called by and so could never be re-measured on their own. A curve whose single
doubtful point was one of them used to force a re-run of every tier, and
re-measuring a tier that already agreed with itself is how a settled point stops
being settled. Three points of the Qwen3.6 curve moved once measured properly,
and the curve became monotonic on both columns.

## Install

Download the dmg, drag it to Applications. The build is signed but not notarized,
so the first launch needs a right-click and Open.
