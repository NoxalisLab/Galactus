# Lanceurs

One-click runs (double-click in Finder, or run from a shell). Every script
locates the repository root by itself, so a folder can be moved as a whole but
a single script cannot be moved between folders without adjusting its root.

Heavy paths (model directory, pack store) come from `galactus.env` at the
repository root, never from a path baked into a script.

| | |
|---|---|
| `LANCER-CHAT.command` | interactive session on GLM-5.2, sane defaults |
| `LANCER-TOUT.command` | replays the full verification chain |
| `telechargement/` | download a certified model's GGUF shards |
| `packs/` | build the expert packs for a model (plan, then write) |
| `banc/` | throughput benches per memory tier, startup timing, reference perplexity |
| `differentiel/` | differential fingerprints against stock llama.cpp |
| `test/` | quick end-to-end check that a model serves |
| `verification/` | byte-level audits, kernel parity probes, offset checks, bisection |
| `construction/` | build llama.cpp with the Galactus wiring |
| `app/` | build or develop the desktop app |

`archive/` holds superseded scripts and is not versioned.
