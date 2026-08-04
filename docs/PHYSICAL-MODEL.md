# The physical model of the machine

This document closes the performance question with measurements. It states what this MacBook Pro (M5 Max, 128 GB) can and cannot do with the full GLM-5.2 checkpoint, and why. An earlier internal revision claimed 15 tok/s was reachable; that claim credited a compute/IO overlap that does not exist and was refuted by the measurements below.

**Question.** Run the full GLM-5.2 (744B-A40B, more than 500B effective parameters) locally at 20 tok/s nominal, 15 tok/s acceptable, with two SSDs and no pruned variant.

**Answer.** The physical maximum of this machine is 8.04 tok/s. This is not an engineering shortfall: 15 tok/s would require a 200 GB unified-memory machine, and 20 tok/s is out of reach of this architecture at any memory size. The 8.04 figure comes from a three-constant model verified to 0.1% on four independent capacities.

## 1. The closed model

Three quantities, measured separately, predict throughput to better than 1%:

```
routed expert bytes touched per token      6,175,850,496
effective storage throughput               15.227 GB/s   (8 runs, stddev 0.55%)
compute, 75-layer schedule                 62.024 ms     (p50, 7 repetitions)

IO ms        = 405.6 * (1 - hit rate)
ms per token = 405.6 * (1 - hit rate) + 62.024
```

The first line is verified directly: on the four capacities measured with real reads on the real packs, bytes actually read per token match the formula within 0.07%, 0.08%, 0.09% and 0.10%. The second is verified on effective throughput, flat at 15.427 / 15.230 / 14.843 / 15.456 / 15.174 / 15.316 / 15.147 / 15.174 GB/s regardless of cache size: storage is saturated at all times, there is no IO margin to recover at any capacity. The 62.024 ms of compute are not waste either: they correspond to reading the 15.58 GB of non-routed weights from unified memory at about 250 GB/s, including 39.4 ms for the attention chain alone. Irreducible without rewriting kernels.

Consequence: throughput depends on exactly one variable, the cache hit rate.

## 2. The hit-rate curve over capacity

Policy replay runs the policy alone, no arena, no reads, no memory, so capacities beyond the machine can be evaluated before being attempted.

| arena | experts/layer | hit rate | IO | total | tok/s | total memory | tenable? |
|---:|---:|---:|---:|---:|---:|---:|---|
| 46 GB | 59 | 0.6395 | 146.2 ms | 208.2 ms | 4.80 | 61.6 GB | yes |
| 54 GB | 69 | 0.6798 | 129.9 ms | 191.9 ms | 5.21 | 69.6 GB | yes |
| 62 GB | 80 | 0.7183 | 114.3 ms | 176.3 ms | 5.67 | 77.6 GB | yes |
| 69 GB | 89 | 0.7468 | 102.7 ms | 164.7 ms | 6.07 | 84.6 GB | yes |
| 77 GB | 99 | 0.7752 | 91.2 ms | 153.2 ms | 6.53 | 92.6 GB | yes |
| 85 GB | 110 | 0.8036 | 79.7 ms | 141.7 ms | 7.06 | 100.6 GB | yes |
| 92 GB | 119 | 0.8246 | 71.1 ms | 133.2 ms | 7.51 | 107.6 GB | yes |
| **99.87 GB** | **129** | **0.8463** | **62.3 ms** | **124.4 ms** | **8.04** | **115.45 GB** | **yes, exactly on the Metal ceiling** |
| 108 GB | 139 | 0.8662 | 54.3 ms | 116.3 ms | 8.60 | 123.6 GB | beyond Metal ceiling |
| 116 GB | 150 | 0.8863 | 46.1 ms | 108.2 ms | 9.25 | 131.6 GB | beyond physical RAM |
| 139 GB | 180 | 0.9322 | 27.5 ms | 89.5 ms | 11.17 | 154.6 GB | beyond physical RAM |
| 185 GB | 239 | 0.9916 | 3.4 ms | 65.5 ms | 15.28 | 200.6 GB | beyond physical RAM |

The retained point lands exactly on the Metal ceiling: a 99.87 GB arena plus 15.58 GB of non-routed weights equals 115.45 GB, which is recommendedMaxWorkingSetSize read directly from the MTLDevice by a project binary. Not a coincidence: that ceiling set the budget.

The last rows answer the original question. 15 tok/s would require 200.6 GB of unified memory, 1.46 times this machine. Even with a perfect cache (all 197 GB of experts resident, absurd but bounding) the ceiling would be 16.12 tok/s, because the 62.024 ms of compute remain. 20 tok/s is closed at any memory size. Keeping 22 GB for other services brings the arena to about 92 GB, or 7.51 tok/s instead of 8.04: the exact and modest price of cohabitation.

## 3. What was built and measured

**The policy.** slru_per_layer_0.75: one independent SLRU per MoE layer, equal quota in expert count, 75% protected, promotion on second access. O(1), no counters, no sketches. The C++ implementation reproduces the simulation to the byte: hits 2,079,947 / 2,457,600, rate 0.846332601, cold bytes 3,890,512,429,056, expected and obtained identical, fail-closed check.

Four competing policies were measured and are dominated. W-TinyLFU yields 9.61 tok/s against 15.13 for a plain LRU: its frequency admission filter targets one-hit objects and this workload has none. Windowed LFU is worse at every period tested. Global SLRU and quota-only are dominated by their combination. Recency dominates frequency here.

**The reader.** DualVolumeReader: F_NOCACHE on both volumes, one thread pool per volume, pread, queue depth 32, each request carrying its destination so the reader writes straight into the arena slot.

**The store.** ExpertStore owns a 16 KiB-aligned arena of quota x record_size(layer) slots, maps key to slot, and can warm the cache from the prompt phase through the policy alone, without IO.

**The packs.** 200 GB expert-major, 19,200 records, 141.4 GB on the internal drive and 56.2 GB on the Lexar NM790, each record split across both volumes.

**Memory behavior.** 100 GB of Metal buffers held for 60 s, zero swap-out. Three-way cohabitation: +0.97% interference, two replications.

## 4. What is closed, and why

**Route lookahead.** Measured unobtainable: 25.98% overlap with t-1, and 4.11% against a 4.09% marginal baseline for cross-layer co-occurrence. Layer n's router reads the hidden state after layer n's attention; there is nothing earlier to read.

**Compute/IO overlap.** Attention precedes the router within each layer, and layer n+1's attention depends on layer n's FFN. The chain is strictly serial, which is why the total is a sum and not a max.

**Speculative prefetch.** With 6.2 GB/s of margin, about one extra expert per layer could be prefetched, against a predictor recall of 4% at K=8. Bandwidth spent, nothing gained.

**Read splitting.** Measured: split 1 yields 15.406 GB/s, split 4 yields 15.148 GB/s, bytes read strictly identical (549,158,092,800 both ways). Storage was already at 100% of its qualified capacity.

**Layer-granular placement (-ncmoe).** No locality benefit by construction: the resident byte fraction is exactly the saved fraction. Ceiling 4.94 tok/s, and its best point measured untenable (516,423,680 bytes swapped at 2% free memory).

Also closed earlier: speculative decoding and draft trees (by expected accepted tokens), adding SSDs (the fabric tops out near 40 GB/s while 15.227 suffices), and 32k context (the corrected Metal ceiling leaves a 3.09 GiB deficit).

## 5. Errors the project carries

These are kept because the numbers above are only as credible as the process that produced them.

- A 6.15 tok/s figure was published from a swap-contaminated run: same configuration, 121.18 ms per token at 19:08 and 69.62 ms at 19:18, factor 1.74, with the memory CSVs showing the system reclaiming arena pages mid-measurement. No replication had been run.
- A 7.14 tok/s deliverable figure was announced from one of three compute readings, the most favorable one. The three give 0.240 / 0.434 / 0.211 ms per submission; the honest figure was 6.9, range 6.4 to 7.1.
- A parallelism problem was diagnosed that did not exist, from that same contaminated point; the corrective read-splitting patch was applied, measured, and changed nothing. The thesis was refuted by the project's own measurement.
- An earlier revision announced 15 tok/s reachable with about 2% margin, crediting a compute/IO overlap that does not exist. Wrong by nearly a factor of two.
- A benchmark sweep never actually executed because a hard-coded preflight rule (zero pre-existing swap) had been revoked but remained written in two places; it was then fixed in only one of them.
- Earlier still: an expert-bytes-per-token figure wrong by 2.82x, refutable in ten seconds by a bits-per-weight division; a unit confusion reading the driver's decimal megabytes as mebibytes, which shifted every memory budget by 5.22 GiB and reversed the 32k-context verdict.

## 6. Addendum: the wiring exists and is measured

The runtime that was missing when this model was first written now exists: the resident expert cache is wired into llama.cpp and is both correct and fast, with both properties measured.

**Quality.** Full 75-layer wiring: perplexity 2.6439 against 2.6373 stock, +0.25%. That figure cost a day of bisection: the initial wiring gave 13.74, and the cause was neither the pack (768/768 spans byte-identical), nor eviction (a zero-eviction pinned mode gave the same number), nor the kernels. It was a linear read of a non-contiguous ggml view in the id remap: every token after the first of each micro-batch was wired to the first token's experts, ranks 9 and up. The earlier suspicion against Metal mv_id kernels is withdrawn: the Metal/CPU invariance (8.89 identical) pointed to a common upstream cause, which was this bug. Metal experts were then requalified separately on a clean machine.

**Throughput.** Final measurement on a rebooted machine (96% free, zero swap), 92 GB cache, CPU experts, 256 tokens: generation 5.9 tok/s (prompt 4.8), average including the cold-cache ramp, consistent with the 5.82 steady-state marginal. The remap fix costs nothing. Reference bounds from the closed model: 7.51 tok/s expected at 92 GB in a perfect warm regime, machine ceiling 8.04.

**Delivered state.** Six times the mmap baseline (1.0 tok/s), quality within 0.25% of stock on the full checkpoint, while cohabiting with 22 GB of services. Remaining margin, identified and non-blocking: arena capacity, Metal requalification, and the +0.25% residual to bound.
