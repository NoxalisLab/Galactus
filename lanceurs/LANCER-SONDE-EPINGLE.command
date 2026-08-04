#!/bin/bash
# SONDE ZERO-EVICTION : comme la bissection, mais chaque couche cablee recoit
# ses 256 experts A DEMEURE (GALACTUS_H4_PIN=1) : aucune eviction possible.
# Si la PPL claque exactement sur 2,6373, le chemin d''eviction est coupable ;
# si elle reste deviee, il est innocente. Limite : 21 couches cablees max.
# les autres couches passent par la voie stock -ncmoe (mmap). Reference de
# la config : 2,6373 (ncmoe ngl12 ub2). Toute plage qui rend ~2,6 est saine ;
# toute plage qui degrade contient la corruption. Dichotomie.
#   GALACTUS_PLAGE="3-40" ./LANCER-SONDE-EPINGLE.command   (par exemple)
set -u
export LC_ALL=C
export LANG=C
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "${ROOT}/galactus.env" ] && . "${ROOT}/galactus.env"
cd "${ROOT}" || exit 1
OUT="${ROOT}/artifacts/h4/integration"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
PLAGE="${GALACTUS_PLAGE:-3-77}"
MODEL="${GALACTUS_MODEL:-${ROOT}/models/glm-5.2-ud-iq1-s/UD-IQ1_S/GLM-5.2-UD-IQ1_S-00001-of-00006.gguf}"
INTERNAL="${GALACTUS_INTERNAL_PACK:?definir GALACTUS_INTERNAL_PACK (voir galactus.env.example)}"
EXTERNAL="${GALACTUS_EXTERNAL_PACK:?definir GALACTUS_EXTERNAL_PACK (voir galactus.env.example)}"
export GALACTUS_H4=1
export GALACTUS_H4_PIN=1
export GALACTUS_H4_CPU_MOE="${GALACTUS_CPU_MOE:-1}"   # 1 = experts CPU (defaut) ; GALACTUS_CPU_MOE=0 = experts Metal
                               # l'invariance experts Metal/CPU est PROUVEE
export GALACTUS_H4_ONLY_LAYERS="${PLAGE}"
export GALACTUS_H4_INTERNAL="${INTERNAL}"
export GALACTUS_H4_EXTERNAL="${EXTERNAL}"
export GALACTUS_H4_CACHE_BYTES=62000000000
export GALACTUS_H4_QD=32
export GALACTUS_GUARD_MAX_SWAP_DELTA_BYTES=4294967296
export GALACTUS_GUARD_MAX_OUTPUT_BYTES=268435456
export GALACTUS_GUARD_MIN_VOLUME_FREE_MB=10240
{
echo "=== sonde epinglee couches ${PLAGE} — ${STAMP} ==="
cd third_party/llama.cpp && cmake --build build --target llama-perplexity -j 2>&1 | grep -E "error|Built target" | tail -2
cd "${ROOT}"
scripts/run-benchmark-guarded-mmap.sh \
    --min-free-percent 2 --max-footprint-gib 118 \
    --max-preexisting-swap-mb 16384 --swap-policy capture \
    --free-percent-policy telemetry --poll-seconds 0.25 --max-wall-seconds 5400 \
    --log "${OUT}/${STAMP}-epingle-memory.csv" --output "${OUT}/${STAMP}-epingle.out" \
    -- third_party/llama.cpp/build/bin/llama-perplexity \
        --model "${MODEL}" --file "${ROOT}/corpus/materialized/stage1/coding-repobench-p-e-0048.txt" \
        --ctx-size 512 --chunks 1 \
        --n-gpu-layers 12 --n-cpu-moe 78 --no-repack --fit off \
        --batch-size 512 --ubatch-size 2 --seed 42 --log-colors off
echo "statut garde = $?"
echo ""
echo "=== VERDICT EPINGLE plage ${PLAGE} ==="
echo "sain = ~2,64 (reference ncmoe ngl12 ub2)"
printf "mesure = "; grep -aoE "PPL = [0-9.]+" "${OUT}/${STAMP}-epingle.out" | tail -1
grep -a "couches sous cablage" "${OUT}/${STAMP}-epingle.out" | head -1
} 2>&1 | tee "${OUT}/${STAMP}-epingle-${PLAGE}.log"
echo ""
read -r -p "Entree pour fermer"
