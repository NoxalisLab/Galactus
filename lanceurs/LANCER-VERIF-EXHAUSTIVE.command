#!/bin/bash
# Verification EXHAUSTIVE de contenu d'UNE couche : les 256 experts, trois
# roles chacun (768 portions), servis par le vrai magasin (mode epingle :
# les 256 tiennent residents d'un coup), puis compares octet a octet au GGUF.
# Toute divergence = contenu de pack corrompu, et la ligne dit ou.
#   GALACTUS_COUCHE=6 ./LANCER-VERIF-EXHAUSTIVE.command
set -u
export LC_ALL=C
export LANG=C
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "${ROOT}/galactus.env" ] && . "${ROOT}/galactus.env"
cd "${ROOT}" || exit 1
OUT="${ROOT}/artifacts/h4/integration"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
COUCHE="${GALACTUS_COUCHE:-6}"
INTERNAL="${GALACTUS_INTERNAL_PACK:?definir GALACTUS_INTERNAL_PACK (voir galactus.env.example)}"
EXTERNAL="${GALACTUS_EXTERNAL_PACK:?definir GALACTUS_EXTERNAL_PACK (voir galactus.env.example)}"
ln -sfn "${ROOT}/models/glm-5.2-ud-iq1-s/UD-IQ1_S" /tmp/galactus-shards
CONTROLE="${OUT}/controle-exhaustif-${COUCHE}.txt"
{
echo "=== verif exhaustive couche ${COUCHE} — ${STAMP} ==="
python3 - "$(find "${ROOT}/artifacts/h4" -name "*p0v2-plan*.json" -type f 2>/dev/null | head -1)" "${COUCHE}" > "${CONTROLE}" << 'PYEOF'
import json, sys
plan = json.load(open(sys.argv[1]))
layer = int(sys.argv[2])
n = 0
for record in plan["records"]:
    if record["layer"] != layer:
        continue
    for s in record["source_spans"]:
        print(layer, record["expert"], s["role"],
              "/tmp/galactus-shards/" + s["source_shard"],
              s["source_offset"], s["length"], s["record_offset"])
        n += 1
assert n == 768, f"{n} portions, 768 attendues"
PYEOF
echo "controle genere : $(wc -l < "${CONTROLE}") lignes"
cmake --build build --target galactus-h4-serve-check 2>&1 | tail -2
GALACTUS_H4_PIN=1 GALACTUS_H4_ONLY_LAYERS="${COUCHE}-${COUCHE}" \
  build/galactus-h4-serve-check "${INTERNAL}" "${EXTERNAL}" 92000000000 "${CONTROLE}" \
  | grep -av ": OK " 
echo "--- statut = $? (les lignes OK sont tues, seuls echecs et bilan restent) ---"
} 2>&1 | tee "${OUT}/${STAMP}-verif-exhaustive-${COUCHE}.log"
echo ""
read -r -p "Entree pour fermer"
