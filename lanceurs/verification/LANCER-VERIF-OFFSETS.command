#!/bin/bash
# Verdict natif (sans pont) : le pack sur disque, le GGUF et la trace du
# moteur, compares sur la machine elle-meme.
set -u
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${ROOT}" || exit 1
python3 - << 'PYEOF'
import json, pathlib
ROOT = pathlib.Path(".").resolve()
plan = json.loads((ROOT/"models/gpt-oss-120b/plan.json").read_text())
records = {r["key"]: r for r in plan["records"]}
order = sorted(records); off = 0; pack_offset = {}
for k in order: pack_offset[k] = off; off += records[k]["record_bytes"]
def fnv(data):
    # Base FNV-1a 64 bits standard, la meme que le moteur : les trois
    # empreintes comparees ici doivent venir de la meme base, sinon la
    # comparaison repond NON sur des octets pourtant identiques.
    h = 14695981039346656037; M = (1<<64)-1
    for b in data: h = ((h ^ b) * 1099511628211) & M
    return h
pack = open(ROOT/"artifacts/h4/packs/gpt-oss-120b/gpt-oss-120b.pack", "rb")
gguf = open(ROOT/"models/gpt-oss-120b/gpt-oss-120b-F16.gguf", "rb")
trace = {}
for line in open(ROOT/"artifacts/h4/integration/goss-trace3.txt"):
    parts = line.split()
    key = (int(parts[0])<<8)|int(parts[1])
    if key not in trace: trace[key] = int(parts[3], 16)   # empreinte 16 KiB
for expert in (83, 84, 7):
    key = expert  # couche 0
    r = records[key]
    pack.seek(pack_offset[key]); head = pack.read(16384)
    s0 = r["source_spans"][0]  # down, record_offset 0
    gguf.seek(s0["source_offset"]); ghead = gguf.read(16384)
    print(f"expert {expert}:")
    print(f"  pack tete == gguf tete      : {'OUI' if head == ghead else 'NON'}")
    print(f"  trace tete == pack tete     : {'OUI' if fnv(head) == trace.get(key) else 'NON'}")
    print(f"  trace tete == gguf tete     : {'OUI' if fnv(ghead) == trace.get(key) else 'NON'}")
PYEOF
read -r -p "Entree pour fermer"
