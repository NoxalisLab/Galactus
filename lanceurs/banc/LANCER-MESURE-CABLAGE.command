#!/bin/bash
# LA mesure : le regime stationnaire du cablage H4, 256 tokens.
#
# Attentes ecrites avant la mesure (courbe succes(capacite) + calcul mesure) :
#   cache 92 Go -> succes ~0,825 -> ~7,5 tok/s en regime chaud.
# Les premiers tokens seront plus lents (cache froid) ; le chiffre qui compte
# est celui de llama-cli en fin de generation, moyenne sur les 256.
set -u
export LC_ALL=C
export LANG=C
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[ -f "${ROOT}/galactus.env" ] && . "${ROOT}/galactus.env"
cd "${ROOT}" || exit 1
OUT="${ROOT}/artifacts/h4/integration"
mkdir -p "${OUT}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
MODEL="${GALACTUS_MODEL:-${ROOT}/models/glm-5.2-ud-iq1-s/UD-IQ1_S/GLM-5.2-UD-IQ1_S-00001-of-00006.gguf}"
INTERNAL="${GALACTUS_INTERNAL_PACK:?definir GALACTUS_INTERNAL_PACK (voir galactus.env.example)}"
EXTERNAL="${GALACTUS_EXTERNAL_PACK:?definir GALACTUS_EXTERNAL_PACK (voir galactus.env.example)}"

export GALACTUS_H4=1
export GALACTUS_H4_INTERNAL="${INTERNAL}"
export GALACTUS_H4_EXTERNAL="${EXTERNAL}"
export GALACTUS_H4_CACHE_BYTES=${GALACTUS_CACHE_BYTES:-92000000000}
export GALACTUS_H4_QD=32
export GALACTUS_GUARD_MAX_OUTPUT_BYTES=268435456
export GALACTUS_GUARD_MIN_VOLUME_FREE_MB=10240
{
echo "=== mesure du cablage, 256 tokens — ${STAMP} ==="
/usr/bin/memory_pressure -Q | grep -i "free percentage"; /usr/sbin/sysctl -n vm.swapusage
cd third_party/llama.cpp
cmake --build build --target llama-cli -j 2>&1 | grep -E "error|Built target" | tail -4
cd "${ROOT}"
scripts/run-benchmark-guarded-mmap.sh \
    --min-free-percent 5 --max-footprint-gib 118 \
    --max-preexisting-swap-mb 8192 --swap-policy capture \
    --free-percent-policy telemetry --poll-seconds 0.25 --max-wall-seconds 1800 \
    --log "${OUT}/${STAMP}-mesure-memory.csv" \
    --output "${OUT}/${STAMP}-mesure.out" \
    -- third_party/llama.cpp/build/bin/llama-cli \
        --model "${MODEL}" \
        --file "${ROOT}/corpus/demo-prompt.txt" \
        --ctx-size 4096 --predict 256 \
        --n-gpu-layers 99 --no-repack --fit off --no-mmap \
        --batch-size 2 --ubatch-size 2 \
        --seed 42 --temp 0 \
        --single-turn --no-conversation --simple-io --show-timings --log-colors off \
        --log-file "${OUT}/${STAMP}-mesure-llama.log"
echo "--- statut garde = $? ---"
echo ""
echo "=== TEXTE GENERE (fin) ==="
tail -c 1600 "${OUT}/${STAMP}-mesure.out"
} 2>&1 | tee "${OUT}/${STAMP}-mesure.log"
echo ""
read -r -p "Entree pour fermer"
