#!/bin/bash
# ALLUMAGE GLM-4.5-Air sur le moteur generique : profil + pack mono-volume.
# Sixieme architecture (glm4moe : 45 couches MoE 1..45, 128 experts,
# 8 actifs, expert partage : 66 Go, hors de portee des Mac <96 Go).
set -u
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "${ROOT}" || exit 1
MODEL="${ROOT}/models/glm-4.5-air/GLM-4.5-Air-Q4_K_M-00001-of-00002.gguf"
PACK="${ROOT}/artifacts/h4/packs/glm-4.5-air/glm-4.5-air.pack"
export GALACTUS_H4=${GALACTUS:-1}   # GALACTUS=0 = stock pur (A/B)
export GALACTUS_PROFILE="${ROOT}/models/glm-4.5-air/profile.engine.txt"
export GALACTUS_H4_INTERNAL="${PACK}"
export GALACTUS_H4_EXTERNAL="${PACK}"
export GALACTUS_H4_CPU_MOE=1
export GALACTUS_H4_CACHE_BYTES=${GALACTUS_CACHE_BYTES:-35000000000}  # quota ~67/couche
export GALACTUS_H4_QD=32
cd "${ROOT}/third_party/llama.cpp" && cmake --build build --target llama-cli -j 2>&1 | grep -E "error|Built target" | tail -1
cd "${ROOT}"
echo ""
echo "=== GLM-4.5-Air [GALACTUS=${GALACTUS:-1}] — cache $(( ${GALACTUS_H4_CACHE_BYTES} / 1000000000 )) Go, experts CPU ==="
third_party/llama.cpp/build/bin/llama-cli \
    --model "${MODEL}" \
    -p "Explain in two sentences why the sky is blue." \
    --predict 128 --ctx-size 4096 \
    --n-gpu-layers 99 --no-repack --fit off $( [ "${GALACTUS:-1}" = "1" ] && echo "--no-mmap --n-cpu-moe 99" ) \
    --batch-size 2 --ubatch-size "${GALACTUS_UB:-2}" \
    --seed 42 --temp 0 \
    --single-turn --simple-io --show-timings --log-colors off 2>&1 \
  | tee "${ROOT}/artifacts/h4/integration/dernier-test-glmair.log" \
  | grep -avE "^[0-9]+\.[0-9]+\.[0-9]+" | tail -30
echo ""
if [ "${GALACTUS_H4_AUTOVERIF:-0}" = "1" ]; then
  L="${ROOT}/artifacts/h4/integration/dernier-test-glmair.log"
  OK=$(grep -ac "galactus_autoverif.*IDENTIQUE" "${L}")
  KO=$(grep -ac "galactus_autoverif.*DIFFERENT" "${L}")
  echo "=== AUTOVERIFICATION : ${OK} IDENTIQUE, ${KO} DIFFERENT ==="
  grep -a "galactus_autoverif.*DIFFERENT" "${L}" | head -10
fi
read -r -p "Entree pour fermer"
