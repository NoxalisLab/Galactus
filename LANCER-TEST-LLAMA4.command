#!/bin/bash
# ALLUMAGE Llama-4 Scout sur le moteur generique : profil + pack mono-volume.
# Quatrieme architecture (llama4 : 48 couches MoE, 16 experts, top-1,
# expert partage resident, records de 76 Mo).
set -u
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "${ROOT}" || exit 1
MODEL="${ROOT}/models/llama4-scout/Llama-4-Scout-17B-16E-Instruct-Q4_K_M-00001-of-00002.gguf"
PACK="${ROOT}/artifacts/h4/packs/llama4-scout/llama4-scout.pack"
export GALACTUS_H4=${GALACTUS:-1}   # GALACTUS=0 = stock pur (A/B)
export GALACTUS_PROFILE="${ROOT}/models/llama4-scout/profile.engine.txt"
export GALACTUS_H4_INTERNAL="${PACK}"
export GALACTUS_H4_EXTERNAL="${PACK}"
export GALACTUS_H4_CPU_MOE=1
export GALACTUS_H4_CACHE_BYTES=${GALACTUS_CACHE_BYTES:-33000000000}  # quota ~9/couche (records 76 Mo)
export GALACTUS_H4_QD=32
cd "${ROOT}/third_party/llama.cpp" && cmake --build build --target llama-cli -j 2>&1 | grep -E "error|Built target" | tail -1
cd "${ROOT}"
echo ""
echo "=== Llama-4 Scout [GALACTUS=${GALACTUS:-1}] — cache $(( ${GALACTUS_H4_CACHE_BYTES} / 1000000000 )) Go, experts CPU ==="
third_party/llama.cpp/build/bin/llama-cli \
    --model "${MODEL}" \
    -p "Explain in two sentences why the sky is blue." \
    --predict 128 --ctx-size 4096 \
    --n-gpu-layers 99 --no-repack --fit off $( [ "${GALACTUS:-1}" = "1" ] && echo "--no-mmap --n-cpu-moe 99" ) \
    --batch-size 2 --ubatch-size "${GALACTUS_UB:-2}" \
    --seed 42 --temp 0 \
    --single-turn --simple-io --show-timings --log-colors off 2>&1 \
  | grep -avE "^[0-9]+\.[0-9]+\.[0-9]+" | tail -30
echo ""
read -r -p "Entree pour fermer"
