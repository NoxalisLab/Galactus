# Study: running the full GLM-5.2 (744B) on a MacBook Pro M5 Max

Every value in this document was measured, not extrapolated. Each figure comes from a logged run and can be replayed with a script from `lanceurs/`.

## 1. Goal and constraints

Run the complete GLM-5.2 checkpoint (744B-A40B, Unsloth UD-IQ1_S quantization at 1.5625 bpw, 202 GB across 6 GGUF shards) on a MacBook Pro M5 Max with 128 GB of unified memory. No pruned variant, no dropped experts, exactly two SSDs, while about 22 GB of resident services keep running on the same machine.

The arithmetic of the problem: routed experts alone weigh 197.6 GB (19,200 records: 75 MoE layers times 256 experts). Each token routes 8 experts per layer, which touches 6,175,850,496 bytes per token when nothing is resident. Memory cannot hold them, so storage has to serve them.

## 2. Hardware under test

| | |
|---|---|
| Machine | MacBook Pro, Apple M5 Max, 128 GB unified memory |
| SSD 1 | Apple internal |
| SSD 2 | Lexar NM790 (external NVMe) |
| Sustained pack throughput | 15.227 GB/s effective, 0.55% standard deviation over 8 measurements (F_NOCACHE reads spread across both volumes) |
| Real GPU memory ceiling | recommended_max_working_set_bytes = 115,448,725,504 bytes, read from the driver |

## 3. The closed model of the machine

Three measured constants predict throughput to better than 1%:

```
expert bytes per token          6,175,850,496
effective storage throughput    15.227 GB/s
compute (75 layers, schedule)   62.024 ms
ms per token = 405.6 * (1 - cache hit rate) + 62.024
```

Verification: across four independent cache capacities, bytes actually read per token match the formula within 0.07% to 0.10%, and storage throughput stays flat. The disk is saturated at all times; there is no hidden I/O margin.

Closed consequences: the ceiling of this machine is 8.04 tok/s (largest tenable cache). 15 tok/s would require about 200 GB of unified memory. 20 tok/s is out of reach of the architecture at any memory size (16.12 tok/s with absurd perfect residency, since the 62.024 ms of compute remain). At 92 GB of cache, the cohabitation configuration, the perfect warm regime is worth 7.51 tok/s. The full capacity curve is in `docs/PHYSICAL-MODEL.md`.

## 4. The P0 packs: storage as a serving tier

GGUFs store tensors matrix by matrix; serving one expert from them would cost three scattered reads. The packer rewrites the 19,200 records as contiguous blocks (down, gate, up, in frozen order, 16 KiB aligned, a requirement of F_NOCACHE) into two pack files, one per SSD, cut at the point that equalizes service times given each drive's measured throughput (profile P0v2, 71.57/28.43). Three record size classes:

| class | layers | record | quants |
|---|---|---|---|
| A | 53 | 9,732,096 B | gate/up iq1_s, down iq3_xxs |
| B | 18 | 11,304,960 B | gate/up iq2_xxs, down iq3_xxs |
| C | 4 | 13,172,736 B | down iq4_xs |

The pack plan (JSON, produced by `scripts/h4-pack-plan.py`) traces every GGUF source span to its pack offset, and served as the reference for all content verifications.

## 5. The resident store and its policy

A pinned arena (posix_memalign, 16 KiB) holds an equal per-layer quota of expert slots (92 GB gives 119 experts per layer out of 256). A per-layer SLRU (probation plus protected, promotion on second access) decides who stays resident.

Competing policies were measured and dominated. W-TinyLFU, the state of the art, yields 9.61 tok/s against 15.13 for a plain LRU on the same traces: its frequency-based admission filter is designed against one-hit objects, and this workload has none. Windowed LFU is worse at every period tested. Global SLRU and quota-only are dominated by their combination. Recency dominates frequency in this workload: the reuse distance is one token for any reselected expert, so the question is not how often it comes back but whether it comes back.

llama.cpp's own layer-granular placement (-ncmoe) was measured as a baseline: no locality benefit by construction (the resident fraction is exactly the saved fraction), a 4.94 tok/s ceiling, and its best real point not tenable in memory. Per-expert granularity is where the gain lives.

## 6. The llama.cpp integration: 2 files plus about 130 lines

Everything is gated behind GALACTUS_H4=1; without it the binary is byte-identical to upstream.

- Expert tensors are created with ne[2] = quota and nb[2] = record size (the inter-expert stride is the pack record), marked TENSOR_SKIP: the GGUF is never read for them.
- After loading, they are backed onto the arena without any copy (ggml_backend_cpu_buffer_from_ptr, or a Metal host-pointer buffer whose split overlap equals a full layer slab).
- A ggml_map_custom1 node inserted after the router remaps expert ids to slot ids and serves the layer synchronously (cache accesses, pread with F_NOCACHE for misses, wait) before mul_mat_id runs.
- Fail-closed guards: batch bounded by the SLRU probation segment (which enforces -ub 2), role-sum assert against the frozen record, slot-leak detection, and an external memory guard (swap, footprint, free-disk floors).

## 7. The perplexity bug hunt

The wired build generated fluent text from day one, with a perplexity of 13.74 against a reference of 2.64. The hunt took one day and four instruments:

1. Layer bisection (GALACTUS_H4_ONLY_LAYERS): 3-77 gave 13.74; 3-3 gave 2.6518; 6-6 gave 2.5993; 8-8 gave 2.7476. The decisive signal: no single layer landed exactly on 2.6373, and a bit-exact wiring cannot move the number in either direction. The "better" 2.5993 was as anomalous as the worst reading.
2. A pinned probe (zero eviction: 256 slots for each wired layer): 2.5993, identical to the SLRU run. Eviction exonerated; the mechanism is deterministic.
3. An exhaustive content audit: all 256 experts of layer 6, 768 spans compared byte by byte against the GGUF through the real store. Zero failures. Pack and reader exonerated.
4. A full-run differential probe: every MoE tensor of one layer dumped over all 257 micro-batches, fnv1a64 fingerprint of all bytes, stock against wired. The first version of this probe (capped at 4,096 elements per tensor) reported "no divergence" alongside two different perplexities, a logical impossibility that exposed its own blind spot: l_out holds 6144 x 2 = 12,288 elements, so the second token of every micro-batch was never compared. The extended probe found the divergence in the very first micro-batch, on ffn_moe_gate, second token only, with routing and weights identical.

The cause: selected_experts is a non-contiguous ggml view (ggml_top_k: ne=[8, n_tokens], but nb[1] spans the full 256-integer argsort row). The remap read it linearly. The first token of each micro-batch was correct; elements 8 to 15 are ranks 9 to 16 of token 1, so every subsequent token was wired to its neighbor's experts. Deterministic, cache-independent, and invisible to every content check (the served bytes were right; they were the wrong experts).

The fix reads and writes through strides (nb[]). Result: 13.7376 became 2.6439 across all 75 layers, and the post-fix differential probe shows zero divergence with a perplexity of exactly 2.6373 on a wired layer. Bit-level transparency, demonstrated.

## 8. Metal kernels, quantified per class

Post-fix, pinned Metal probes (2.9 GB of buffer, one class at a time):

| class | quants | Metal PPL | delta vs 2.6373 |
|---|---|---|---|
| A | iq1_s + iq3_xxs | 2.6310 | -0.24% |
| B | iq2_xxs | 2.6711 | +1.28% |
| C | iq4_xs | 2.6846 | +1.79% |

Metal mv_id kernels are not bit-equivalent to CPU and drift per quantization class. Compounded over 75 layers this is a real degradation. Decision: CPU experts by default (bit-transparent), Metal available as a documented option.

## 9. Benchmark summary

| measurement | value | run |
|---|---|---|
| mmap baseline | 1.0 tok/s | project journal |
| -ncmoe ceiling | 4.94 tok/s | placement sweep |
| Generation, 256 tokens, clean machine | 5.9 tok/s (prompt 4.8) | 20260804T065243Z |
| Warm regime, live chat | 6.4 tok/s (prompt 8.8) | interactive session |
| Steady-state marginal | 5.82 tok/s | throughput run |
| Machine ceiling | 8.04 tok/s | closed model, section 3 |
| Reference PPL, stock | 2.6373 | fit-off, ncmoe, ngl12, ub2 |
| Wired PPL, 75 layers, CPU | 2.6439 (+0.25%) | 20260803T183655Z |
| Wired PPL, single layer, CPU | 2.6373 (bit-identical) | 20260804T070122Z |
| Pack read throughput under load | 15.2 GB/s sustained | guard CSVs |

PPL corpus: coding-repobench-p-e-0048, 512-token chunk, seed 42, greedy, identical for every row.

## 10. What it cost, recorded without makeup

The project journal keeps every mistake next to its correction. Among them: reading the driver's "115448.73 MB" as mebibytes (a 5.22 GiB ceiling error that survived six cross-checks; the resulting rule: verify the unit before the operation). A throughput point published from a swap-contaminated run (the resulting rule: three repetitions, individual values published). Probes that validated NaN against NaN. An eviction-on-hit slot leak. The linear read of a view described in section 7 (the resulting rule: a ggml tensor is a view until proven otherwise; read through nb[], never linearly). And the late discovery of -ncmoe inside the very tool the project had frozen, which earned its own note: before building, look at what the tool already does.

## 11. Reproducibility

Every figure in this study maps to a launcher in `lanceurs/` (bisection, pinned probe, differential probe, exhaustive audit, throughput measurement) and to timestamped logs under `artifacts/` (not versioned, regenerable). The llama.cpp patch lives in `patches/`, pinned to the upstream commit, applicable with one command.
