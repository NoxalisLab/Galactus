#!/usr/bin/env python3
"""GGUF tensor accounting for GLM-5.2 UD-IQ1_S.

Type traits are NOT typed from memory. They are the static_assert expressions
of third_party/llama.cpp/ggml/src/ggml-common.h evaluated with the QK_* macros
of that same file, and the enum values of ggml/include/ggml.h.

Self-check: for every shard, sum of aligned tensor sizes + data offset must
equal the shard size exactly. If that identity holds on all six shards, the
traits are right for every type present in this checkpoint -- no trust
required.
"""
import json, struct, sys, re
from pathlib import Path

H = 2          # sizeof(ggml_half)
QK_K = 256
K_SCALE_SIZE = 12
IQ3S_N_SCALE = QK_K // 64

# (blck_size, type_size) keyed by the enum value in ggml/include/ggml.h
TRAITS = {
    0:  (1, 4),                                     # F32
    1:  (1, 2),                                     # F16
    2:  (32, H + 32 // 2),                          # Q4_0
    3:  (32, 2 * H + 32 // 2),                      # Q4_1
    6:  (32, H + 4 + 32 // 2),                      # Q5_0
    7:  (32, 2 * H + 4 + 32 // 2),                  # Q5_1
    8:  (32, H + 32),                               # Q8_0
    9:  (32, 2 * H + 32),                           # Q8_1
    10: (QK_K, 2 * H + QK_K // 16 + QK_K // 4),     # Q2_K
    11: (QK_K, H + QK_K // 4 + QK_K // 8 + 12),     # Q3_K
    12: (QK_K, 2 * H + K_SCALE_SIZE + QK_K // 2),   # Q4_K
    13: (QK_K, 2 * H + K_SCALE_SIZE + QK_K // 2 + QK_K // 8),   # Q5_K
    14: (QK_K, H + QK_K // 16 + 3 * QK_K // 4),     # Q6_K
    15: (QK_K, 4 + QK_K + QK_K // 16 * 2),          # Q8_K
    16: (QK_K, H + QK_K // 8 * 2),                  # IQ2_XXS
    17: (QK_K, H + QK_K // 8 * 2 + QK_K // 32),     # IQ2_XS
    18: (QK_K, H + 3 * (QK_K // 8)),                # IQ3_XXS
    19: (QK_K, H + QK_K // 8 + QK_K // 16),         # IQ1_S
    20: (32, H + 32 // 2),                          # IQ4_NL
    21: (QK_K, H + 13 * (QK_K // 32) + IQ3S_N_SCALE),           # IQ3_S
    22: (QK_K, H + QK_K // 4 + QK_K // 16),         # IQ2_S
    23: (QK_K, H + 2 + QK_K // 64 + QK_K // 2),     # IQ4_XS
    24: (1, 1), 25: (1, 2), 26: (1, 4), 27: (1, 8), 28: (1, 8),
    29: (QK_K, QK_K // 8 + QK_K // 16 + QK_K // 32),            # IQ1_M
    30: (1, 2),                                     # BF16
    34: (QK_K, H + QK_K // 64 + (QK_K - 4 * QK_K // 64) // 5),  # TQ1_0
    35: (QK_K, H + QK_K // 4),                      # TQ2_0
    39: (32, 1 + 32 // 2),                          # MXFP4
    41: (128, H + 128 // 8),                        # Q1_0
    42: (64, H + 64 // 4),                          # Q2_0
}
NAMES = {
    0: "F32", 1: "F16", 8: "Q8_0", 10: "Q2_K", 11: "Q3_K", 12: "Q4_K",
    13: "Q5_K", 14: "Q6_K", 15: "Q8_K", 16: "IQ2_XXS", 17: "IQ2_XS",
    18: "IQ3_XXS", 19: "IQ1_S", 20: "IQ4_NL", 21: "IQ3_S", 22: "IQ2_S",
    23: "IQ4_XS", 29: "IQ1_M", 30: "BF16", 34: "TQ1_0", 35: "TQ2_0",
    39: "MXFP4", 41: "Q1_0", 42: "Q2_0",
}


class Reader:
    def __init__(self, f): self.f = f
    def u32(self): return struct.unpack("<I", self.f.read(4))[0]
    def u64(self): return struct.unpack("<Q", self.f.read(8))[0]
    def i32(self): return struct.unpack("<i", self.f.read(4))[0]
    def string(self):
        return self.f.read(self.u64()).decode("utf-8", "replace")
    def value(self, t):
        if t == 0:  return struct.unpack("<B", self.f.read(1))[0]
        if t == 1:  return struct.unpack("<b", self.f.read(1))[0]
        if t == 2:  return struct.unpack("<H", self.f.read(2))[0]
        if t == 3:  return struct.unpack("<h", self.f.read(2))[0]
        if t == 4:  return self.u32()
        if t == 5:  return self.i32()
        if t == 6:  return struct.unpack("<f", self.f.read(4))[0]
        if t == 7:  return struct.unpack("<?", self.f.read(1))[0]
        if t == 8:  return self.string()
        if t == 9:
            et = self.u32(); n = self.u64()
            return [self.value(et) for _ in range(n)]
        if t == 10: return self.u64()
        if t == 11: return struct.unpack("<q", self.f.read(8))[0]
        if t == 12: return struct.unpack("<d", self.f.read(8))[0]
        raise ValueError(f"unknown gguf value type {t}")


def nbytes(dims, ttype):
    n = 1
    for d in dims:
        n *= d
    block, size = TRAITS[ttype]
    if n % block:
        raise ValueError(f"element count {n} not a multiple of block {block}")
    return n // block * size


def read_shard(path):
    with open(path, "rb") as f:
        r = Reader(f)
        if f.read(4) != b"GGUF":
            raise ValueError(f"{path}: not GGUF")
        version = r.u32(); n_tensors = r.u64(); n_kv = r.u64()
        meta = {}
        for _ in range(n_kv):
            k = r.string(); meta[k] = r.value(r.u32())
        tensors = []
        for _ in range(n_tensors):
            name = r.string()
            nd = r.u32()
            dims = [r.u64() for _ in range(nd)]
            tt = r.u32()
            off = r.u64()
            tensors.append((name, dims, tt, off))
        return version, meta, tensors, f.tell(), path.stat().st_size


def main():
    root = Path(sys.argv[1])
    shards = sorted(root.glob("*.gguf"))
    all_tensors, meta0 = [], None
    identity_ok = True
    print("--- self-check: aligned tensor bytes + data offset == shard size ---")
    for s in shards:
        version, meta, tensors, header_end, file_size = read_shard(s)
        if meta0 is None:
            meta0 = meta
        align = meta.get("general.alignment", 32)
        data_start = (header_end + align - 1) // align * align
        total = 0
        for name, dims, tt, off in tensors:
            b = nbytes(dims, tt)
            total += (b + align - 1) // align * align
        ok = (data_start + total == file_size)
        identity_ok &= ok
        print(f"  {s.name}: tensors={len(tensors):4d} data_start={data_start:>10,} "
              f"sum_aligned={total:>15,} file={file_size:>15,} "
              f"delta={file_size - data_start - total:>+6d} {'OK' if ok else 'MISMATCH'}")
        all_tensors.extend(tensors)
    print(f"identity holds on all shards: {identity_ok}")
    if not identity_ok:
        print("=> the type traits do not describe this file; stop here.")
        return

    n_exp = meta0["glm-dsa.expert_count"]
    n_used = meta0["glm-dsa.expert_used_count"]
    n_block = meta0["glm-dsa.block_count"]
    n_dense = meta0["glm-dsa.leading_dense_block_count"]
    print(f"\nexpert_count={n_exp} expert_used_count={n_used} "
          f"block_count={n_block} leading_dense_block_count={n_dense}")

    types = {}
    routed = {}
    other = 0
    for name, dims, tt, off in all_tensors:
        b = nbytes(dims, tt)
        types[tt] = types.get(tt, 0) + b
        m = re.match(r"blk\.(\d+)\.ffn_(gate|up|down)_exps\.weight", name)
        if m:
            routed[int(m.group(1))] = routed.get(int(m.group(1)), 0) + b
        else:
            other += b

    print("\nbytes by ggml type:")
    for tt, v in sorted(types.items(), key=lambda kv: -kv[1]):
        print(f"  {NAMES.get(tt, tt):10s} {v:>15,}")

    print(f"\nnon-routed bytes (everything that is not blk.N.ffn_*_exps): {other:,}")
    moe = sorted(routed)
    print(f"layers carrying routed experts: {len(moe)} ({min(moe)}..{max(moe)})")
    total_routed = sum(routed.values())
    print(f"total routed-expert bytes (all layers): {total_routed:,}")

    # The runtime decodes with blocks 0..block_count-2; the last block is the
    # MTP head, present in the file and not on the decode path.
    decode_moe = [l for l in moe if l <= n_block - 2]
    routed_decode = sum(routed[l] for l in decode_moe)
    print(f"decode-path MoE layers: {len(decode_moe)} ({min(decode_moe)}..{max(decode_moe)})")
    print(f"routed-expert bytes on the decode path: {routed_decode:,}")

    per_token = routed_decode * n_used // n_exp
    print(f"\nrouted-expert bytes touched per token = routed_decode * {n_used}/{n_exp}"
          f" = {per_token:,}")

    CAPACITY = 15.077e9
    print(f"\n--- what -ncmoe N can do, at the sustained 15.077 GB/s ---")
    print("  N   resident routed bytes   streamed/token      max tok/s (streaming only)")
    for N in list(range(78, 39, -1)):
        resident = sum(routed[l] for l in decode_moe if l >= N)
        streamed = (routed_decode - resident) * n_used // n_exp
        tps = CAPACITY / streamed if streamed else float("inf")
        print(f"  {N:3d} {resident:>21,} {streamed:>16,} {tps:>14.2f}")


if __name__ == "__main__":
    main()
