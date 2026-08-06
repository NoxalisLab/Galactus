#!/bin/bash
# ALLUMAGE gpt-oss-120b sur le moteur generique : profil + pack mono-volume,
# generation courte avec timings. Premiere rencontre de l'interception
# generique avec une architecture etrangere.
set -u
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MODEL="${ROOT}/models/gpt-oss-120b/gpt-oss-120b-F16.gguf"
PACK="${ROOT}/artifacts/h4/packs/gpt-oss-120b/gpt-oss-120b.pack"
export GALACTUS_H4=${GALACTUS:-1}   # GALACTUS=0 = stock pur (A/B)
export GALACTUS_PROFILE="${ROOT}/models/gpt-oss-120b/profile.engine.txt"
export GALACTUS_H4_INTERNAL="${PACK}"
export GALACTUS_H4_EXTERNAL="${PACK}"   # mono-volume : l'externe n'est jamais lu
export GALACTUS_H4_CPU_MOE=1            # chemin qualite (bit-transparent sur GLM)
export GALACTUS_H4_CACHE_BYTES=${GALACTUS_CACHE_BYTES:-24000000000}   # 24 Go : ~50 emplacements/couche
export GALACTUS_H4_QD=32
cd "${ROOT}/third_party/llama.cpp" && cmake --build build --target llama-cli -j 2>&1 | grep -E "error|Built target" | tail -2
cd "${ROOT}"
echo ""
echo "=== gpt-oss-120b [GALACTUS=${GALACTUS:-1}] — cache $(( ${GALACTUS_H4_CACHE_BYTES} / 1000000000 )) Go, experts CPU ==="
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
