# Galactus Desktop v0.1.28

A native macOS app for the Galactus MoE engine: run open-weight
Mixture-of-Experts models fully on-device, including models several times
larger than your RAM.

Designed and developed by Noxalis Lab.

This release moves the engine forward by two months of llama.cpp, adds four
models, lets several models work as one team, and teaches the app to learn one
of its own decisions. Every model in the catalogue was recertified on the new
engine, and the built app was driven end to end before this was tagged.

## Four new models, and one faster

| model | on disk | what it is for |
|---|---|---|
| DeepSeek-V4-Flash 284B-A13B (UD-Q4_K_XL) | 155 GB | the strongest model in the catalogue, streamed from SSD on a 128 GB Mac |
| Qwen3-Coder-Next 80B-A3B (UD-Q4_K_XL) | 50 GB | a coder built for agents: SWE-bench Verified 70.6 %, no thinking, fast |
| Nemotron-3.5 Lightning 30B-A3B (UD-Q4_K_M) | 25 GB | a hybrid Mamba and attention model |
| gpt-oss-20b (Q4_K_M) | 12 GB | a small reasoning model, 85 tok/s once resident |

Each one is certified bit-transparent like the rest: the Galactus wiring
changes no number against stock llama.cpp.

Qwen3.6 35B-A3B moves to its MTP build. A multi-token prediction head drafts
the next token and the model checks it in the same step: measured +35 % on
code, +32 % on reasoning, +7 % on French prose. On a Mac too small to hold the
draft's batch, it starts without it rather than not at all.

## The engine, two months newer

The wiring now runs on llama.cpp b1ff4ca2, 960 upstream commits later. That is
what brings DeepSeek-V4's Metal kernels, MoE fusions and a series of Metal
fixes. The bit-exact expert kernels moved to their own library and were
re-verified: all 11 expert quantization types bit-identical to the CPU, 286 of
286 cases.

Hybrid architectures, where MoE layers sit between Mamba or attention layers,
can now be wired. Nemotron-3.5 is the first.

## Models that work together

A team gives each role its own model. Qwen3.8 27B plans and reviews while
Qwen3-Coder-Next writes the code, both resident side by side. Five teams ship,
and every one is editable in Settings > Model teams: a model per role, roles
added or removed, and a memory estimate that says whether the team fits this
Mac before anything starts. When a model does not fit beside the others, it is
refused with the missing gigabytes and the name of what holds them. Teammate
engines stop when the team is turned off. Teams are off until you pick one.

Two models generating at the same moment share the GPU, so each runs slower
than it would alone.

## Cloud models, only if you want them

A role in a team can also be a model reached through an API: OpenRouter,
Anthropic or OpenAI. It is off by default, and nothing changes for anyone who
leaves it off. When you turn a provider on:

- your key goes to the macOS Keychain and never to the interface;
- a daily spending cap is checked before the provider is contacted, and a
  model with no known price is refused rather than run uncapped;
- secrets are masked from what leaves the Mac, tool-call arguments included;
- every call appears in the thread with its tokens and its cost.

Tested live against OpenRouter: a teammate on openai/gpt-oss-20b answered
from the cloud, and the two calls were billed from the provider's own figure,
$0.00016.

## Galactus learns one of its own decisions

Which task a message is, and so which model and persona answer it, was decided
by hand-written rules. Settings > Learning lets Galactus learn that decision
from how you use it: it keeps redacted traces on this Mac, labels them with
the local model you are running, trains a small Laya decision model, and
switches to it only if it beats the rules on traces it never trained on. A
rejected model is kept with its numbers; one click rolls back. Nothing is
collected, downloaded or trained until you turn it on, and one button erases
the traces and every learned model. The toolkit is about 850 MB to download
and 1.6 GB on disk, installed into a private environment, never into the
system Python.

## Fixed

- The agent could answer with a summary of the conversation instead of your
  question. The default window was too small for its own tools, so history was
  summarised from the second turn, and the question in progress could end up
  inside the summary. The question in progress is never summarised now, and
  the default window per slot is 16K.
- `galactus serve` and the speed benchmark ran the slow bit-exact kernels
  while the app ran the fast ones; all three agree now. gpt-oss-20b's speed
  curve is measured on the kernels the app ships; Qwen3-Coder-Next's is
  provisional, and DeepSeek-V4-Flash and Nemotron-3.5 have none yet.
- The README said every regime was bit-exact. The wiring is; the GPU kernels
  are a setting.

## Known limits

- Llama-4 Scout cannot call tools: llama.cpp's own parser rejects its calls,
  before and after this update. The app detects it at startup and keeps it to
  plain chat. OLMoE and Phi-3.5-MoE cannot call tools either.
- Models streamed from SSD read long prompts slowly, around 5 tok/s: the batch
  is kept small so a batch's experts stay inside the cache.
- Most speed curves in the catalogue were taken on the bit-exact kernels and
  understate the app. They are being re-measured.
- Anthropic and OpenAI were tested against a local stand-in, not the live
  services.
