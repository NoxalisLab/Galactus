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

## Perplexity and where it may be quoted

The launchers in `differentiel/` and `scripts/certify.py` do not read the same
corpus file: the launchers read `coding-repobench-p-e-0048.txt`, the certifier
reads `long-context-multifieldqa-zh-0029.txt`, and on the same model the two
differ by more than a factor of three. Only `certify.py` writes into
`scripts/models-registry.json`, and it stores the corpus path, that file's
sha256, the seed, the context and the batch shape next to the number. A
perplexity read off a launcher's console is a local check, not a registry
value, and copying one into the registry by hand is how four entries there
ended up with no provenance at all.
