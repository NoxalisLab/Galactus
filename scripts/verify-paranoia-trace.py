#!/usr/bin/env python3
"""Juge la trace paranoia : chaque (couche, expert, empreinte) capturee dans
le run VIVANT est comparee a l'empreinte du meme enregistrement reconstruit
depuis les DEUX packs (la verite deja prouvee conforme au GGUF)."""
import json
import sys

# Base FNV-1a 64 bits reelle, la meme que le moteur (llama-galactus-h4.cpp).
# Elle portait un chiffre en moins des deux cotes : coherent entre eux, mais
# incomparable avec un FNV-1a calcule par n'importe quel autre outil.
FNV_OFFSET = 14695981039346656037
FNV_PRIME = 1099511628211
MASK = (1 << 64) - 1

def fnv1a64(data: bytes) -> int:
    h = FNV_OFFSET
    for b in data:
        h = ((h ^ b) * FNV_PRIME) & MASK
    return h

trace_path, plan_path, internal_path, external_path = sys.argv[1:5]
plan = json.load(open(plan_path))
by_key = {(r["layer"], r["expert"]): r for r in plan["records"]}
internal = open(internal_path, "rb")
external = open(external_path, "rb")

cache = {}
def expected(layer: int, expert: int) -> int:
    if (layer, expert) not in cache:
        p0 = by_key[(layer, expert)]["p0"]
        internal.seek(p0["internal_offset"])
        payload = internal.read(p0["internal_length"])
        external.seek(p0["external_offset"])
        payload += external.read(p0["external_length"])
        cache[(layer, expert)] = fnv1a64(payload)
    return cache[(layer, expert)]

# Echantillonnage : le fnv en Python pur vaut ~8 Mo/s ; 100 triplets
# uniques (~1 Go) jugent en ~2 min. Deterministe : un pas constant.
unique = []
seen_keys = set()
for line in open(trace_path):
    layer, expert, slot, digest = line.split()
    if (layer, expert, digest) not in seen_keys:
        seen_keys.add((layer, expert, digest))
        unique.append(line)
step = max(1, len(unique) // 100)
sample = unique[::step][:100]
print(f"{len(unique)} triplets uniques dans la trace, {len(sample)} echantillonnes")

checked = failed = 0
seen = set()
for line in sample:
    layer, expert, slot, digest = line.split()
    layer, expert = int(layer), int(expert)
    if (layer, expert, digest) in seen:
        continue
    seen.add((layer, expert, digest))
    checked += 1
    want = expected(layer, expert)
    if int(digest, 16) != want:
        failed += 1
        print(f"ECHEC L{layer} E{expert} slot {slot} : arene {digest} != pack {want:016x}")
        if failed >= 10:
            print("(arret apres 10 echecs)")
            break
print(f"{checked} triplets uniques verifies, {failed} en echec")
sys.exit(1 if failed else 0)
