#!/usr/bin/env python3
"""Emit a model profile for the MoE acceleration engine, from any GGUF.

Generic successor to the frozen GLM-5.2 tables: reads a sharded GGUF
directory, self-checks the type traits against every shard size (the
analyze-gguf-layout identity), and emits a profile.json describing the
routed-expert geometry the engine needs: MoE layer range, experts per
layer, per-role matrix bytes and types, per-expert record sizes (raw and
16 KiB padded), and absolute source spans for the pack planner.

Fail-closed: any inconsistency (missing role, non-uniform expert count,
shard identity mismatch) aborts with a message instead of guessing.

Usage: moe-profile.py --model-directory DIR --output profile.json
"""
import argparse, json, re, struct, sys
from pathlib import Path

H = 2
QK_K = 256
K_SCALE_SIZE = 12
IQ3S_N_SCALE = QK_K // 64
RECORD_ALIGN = 16384

TRAITS = {
    0:(1,4),1:(1,2),2:(32,H+16),3:(32,2*H+16),6:(32,H+4+16),7:(32,2*H+4+16),
    8:(32,H+32),9:(32,2*H+32),10:(QK_K,2*H+QK_K//16+QK_K//4),
    11:(QK_K,H+QK_K//4+QK_K//8+12),12:(QK_K,2*H+K_SCALE_SIZE+QK_K//2),
    13:(QK_K,2*H+K_SCALE_SIZE+QK_K//2+QK_K//8),14:(QK_K,H+QK_K//16+3*QK_K//4),
    15:(QK_K,4+QK_K+QK_K//16*2),16:(QK_K,H+QK_K//8*2),17:(QK_K,H+QK_K//8*2+QK_K//32),
    18:(QK_K,H+3*(QK_K//8)),19:(QK_K,H+QK_K//8+QK_K//16),20:(32,H+16),
    21:(QK_K,H+13*(QK_K//32)+IQ3S_N_SCALE),22:(QK_K,H+QK_K//4+QK_K//16),
    23:(QK_K,H+2+QK_K//64+QK_K//2),24:(1,1),25:(1,2),26:(1,4),27:(1,8),28:(1,8),
    29:(QK_K,QK_K//8+QK_K//16+QK_K//32),30:(1,2),
    34:(QK_K,H+QK_K//64+(QK_K-4*QK_K//64)//5),35:(QK_K,H+QK_K//4),
    39:(32,1+16),41:(128,H+16),42:(64,H+16),
}
NAMES = {0:"F32",1:"F16",8:"Q8_0",10:"Q2_K",11:"Q3_K",12:"Q4_K",13:"Q5_K",
    14:"Q6_K",16:"IQ2_XXS",17:"IQ2_XS",18:"IQ3_XXS",19:"IQ1_S",20:"IQ4_NL",
    21:"IQ3_S",22:"IQ2_S",23:"IQ4_XS",29:"IQ1_M",30:"BF16",39:"MXFP4"}

class Reader:
    def __init__(self, f): self.f = f
    def u32(self): return struct.unpack("<I", self.f.read(4))[0]
    def u64(self): return struct.unpack("<Q", self.f.read(8))[0]
    def i32(self): return struct.unpack("<i", self.f.read(4))[0]
    def string(self): return self.f.read(self.u64()).decode("utf-8", "replace")
    def value(self, t):
        if t == 0: return struct.unpack("<B", self.f.read(1))[0]
        if t == 1: return struct.unpack("<b", self.f.read(1))[0]
        if t == 2: return struct.unpack("<H", self.f.read(2))[0]
        if t == 3: return struct.unpack("<h", self.f.read(2))[0]
        if t == 4: return self.u32()
        if t == 5: return self.i32()
        if t == 6: return struct.unpack("<f", self.f.read(4))[0]
        if t == 7: return struct.unpack("<?", self.f.read(1))[0]
        if t == 8: return self.string()
        if t == 9:
            et = self.u32(); n = self.u64()
            return [self.value(et) for _ in range(n)]
        if t == 10: return self.u64()
        if t == 11: return struct.unpack("<q", self.f.read(8))[0]
        if t == 12: return struct.unpack("<d", self.f.read(8))[0]
        raise ValueError(f"unknown gguf value type {t}")

def nbytes(dims, ttype):
    n = 1
    for d in dims: n *= d
    block, size = TRAITS[ttype]
    if n % block: raise ValueError(f"count {n} not multiple of block {block}")
    return n // block * size

def read_shard(path):
    with open(path, "rb") as f:
        r = Reader(f)
        if f.read(4) != b"GGUF": raise SystemExit(f"{path}: not GGUF")
        r.u32(); n_tensors = r.u64(); n_kv = r.u64()
        meta = {}
        for _ in range(n_kv):
            k = r.string(); meta[k] = r.value(r.u32())
        tensors = []
        for _ in range(n_tensors):
            name = r.string(); nd = r.u32()
            dims = [r.u64() for _ in range(nd)]
            tt = r.u32(); off = r.u64()
            tensors.append((name, dims, tt, off))
        return meta, tensors, f.tell(), path.stat().st_size

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-directory", required=True, type=Path)
    ap.add_argument("--output", required=True, type=Path)
    args = ap.parse_args()
    shards = sorted(args.model_directory.glob("*.gguf"))
    if not shards: raise SystemExit("no .gguf shard in directory")

    meta0, spans, shard_reports, non_routed = None, [], [], 0
    for s in shards:
        meta, tensors, header_end, file_size = read_shard(s)
        if meta0 is None: meta0 = meta
        align = meta.get("general.alignment", 32)
        data_start = (header_end + align - 1) // align * align
        total = 0
        for name, dims, tt, off in tensors:
            b = nbytes(dims, tt)
            total += (b + align - 1) // align * align
        ok = (data_start + total == file_size)
        shard_reports.append({"shard": s.name, "tensors": len(tensors),
                              "identity_ok": ok})
        if not ok:
            raise SystemExit(f"{s.name}: trait identity MISMATCH "
                             f"(delta {file_size - data_start - total:+d}); "
                             "the type traits do not describe this file")
        for name, dims, tt, off in tensors:
            b = nbytes(dims, tt)
            m = re.match(r"blk\.(\d+)\.ffn_([a-z_]+)_exps\.weight", name)
            if m:
                spans.append({"layer": int(m.group(1)), "role": m.group(2),
                              "shard": s.name, "abs_offset": data_start + off,
                              "bytes": b, "dims": dims, "type": tt})
            else:
                non_routed += b

    arch = meta0.get("general.architecture")
    if arch is None: raise SystemExit("general.architecture missing")
    def key(suffix):
        v = meta0.get(f"{arch}.{suffix}")
        if v is None: raise SystemExit(f"{arch}.{suffix} missing: not a routed-MoE checkpoint?")
        return v
    n_exp, n_used, n_block = key("expert_count"), key("expert_used_count"), key("block_count")

    by_layer = {}
    for sp in spans: by_layer.setdefault(sp["layer"], {})[sp["role"]] = sp
    if not by_layer: raise SystemExit("no blk.N.ffn_*_exps tensors found: dense model, engine not applicable")
    roles = sorted({sp["role"] for sp in spans})
    canonical = [r for r in ("down", "gate", "up") if r in roles] + [r for r in roles if r not in ("down", "gate", "up")]

    # Les couches de prediction multi-token (MTP / nextn) portent des experts
    # hors chemin de decodage : leur NOMBRE se lit dans les metadonnees, leur
    # position est en fin de pile. Zero par defaut (gpt-oss, qwen: aucune).
    n_mtp = meta0.get(f"{arch}.nextn_predict_layers", 0)
    excluded = sorted(l for l in by_layer if l >= n_block - n_mtp)
    for l in excluded: del by_layer[l]
    if not by_layer: raise SystemExit("all MoE layers are off the decode path?")

    layers, size_classes = [], {}
    for layer in sorted(by_layer):
        entry = by_layer[layer]
        missing = [r for r in canonical if r not in entry]
        if missing: raise SystemExit(f"layer {layer}: missing roles {missing}")
        experts = None
        rec_raw = 0
        role_out = {}
        for r in canonical:
            sp = entry[r]
            e = sp["dims"][2] if len(sp["dims"]) >= 3 else 1
            if experts is None: experts = e
            elif e != experts: raise SystemExit(f"layer {layer}: expert count differs across roles")
            if e != n_exp: raise SystemExit(f"layer {layer} role {r}: {e} experts, metadata says {n_exp}")
            per_expert = sp["bytes"] // e
            if per_expert * e != sp["bytes"]:
                raise SystemExit(f"layer {layer} role {r}: bytes not divisible by experts")
            rec_raw += per_expert
            role_out[r] = {"type": sp["type"], "type_name": NAMES.get(sp["type"], str(sp["type"])),
                           "per_expert_bytes": per_expert, "dims": sp["dims"],
                           "shard": sp["shard"], "abs_offset": sp["abs_offset"]}
        rec_padded = (rec_raw + RECORD_ALIGN - 1) // RECORD_ALIGN * RECORD_ALIGN
        layers.append({"layer": layer, "experts": experts, "roles": role_out,
                       "record_bytes_raw": rec_raw, "record_bytes_padded": rec_padded})
        size_classes[rec_padded] = size_classes.get(rec_padded, 0) + 1

    moe_layers = [l["layer"] for l in layers]
    total_padded = sum(l["record_bytes_padded"] * l["experts"] for l in layers)
    total_raw = sum(l["record_bytes_raw"] * l["experts"] for l in layers)
    per_token = sum(l["record_bytes_raw"] * n_used for l in layers)

    profile = {
        "schema_version": 1,
        "architecture": arch,
        "model_name": meta0.get("general.name", ""),
        "shards": shard_reports,
        "expert_count": n_exp,
        "expert_used_count": n_used,
        "block_count": n_block,
        "role_order": canonical,
        "record_align": RECORD_ALIGN,
        "moe_first_layer": min(moe_layers),
        "moe_last_layer": max(moe_layers),
        "moe_layer_count": len(moe_layers),
        "moe_layers_contiguous": moe_layers == list(range(min(moe_layers), max(moe_layers) + 1)),
        "layers": layers,
        "totals": {
            "routed_bytes_raw": total_raw,
            "routed_bytes_padded_pack": total_padded,
            "non_routed_bytes": non_routed,
            "expert_bytes_per_token": per_token,
        },
        "record_size_classes": {str(k): v for k, v in sorted(size_classes.items())},
        "excluded_layers_off_decode_path": excluded,
    }
    args.output.write_text(json.dumps(profile, indent=1), encoding="utf-8")

    # Engine sidecar: flat text the C++ loader parses without a JSON library.
    engine = args.output.with_suffix(".engine.txt")
    lines = ["galactus-profile 1", f"arch {arch}",
             f"first_layer {min(moe_layers)}", f"last_layer {max(moe_layers)}",
             f"experts {n_exp}", f"used {n_used}", f"align {RECORD_ALIGN}"]
    for l in layers:
        lines.append(f"layer {l['layer']} record {l['record_bytes_padded']} raw {l['record_bytes_raw']}")
    lines.append("end")
    engine.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"profil moteur: {engine}")
    print(f"architecture {arch}  layers MoE {len(moe_layers)} "
          f"({min(moe_layers)}..{max(moe_layers)})  experts {n_exp}  actifs {n_used}")
    print(f"pack (padded) {total_padded:,} B   experts/token {per_token:,} B   "
          f"classes de record {len(size_classes)}")
    print(f"profil ecrit: {args.output}")

if __name__ == "__main__":
    main()
