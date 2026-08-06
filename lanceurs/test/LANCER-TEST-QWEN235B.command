#!/bin/bash
# ALLUMAGE Qwen3-235B-A22B sur le moteur generique : profil + pack mono-volume.
# Le vaisseau amiral (qwen3moe : 94 couches, 128 experts, 8 actifs,
# 137 Go d experts : ne tient dans AUCUN Mac nativement).
set -u
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${ROOT}" || exit 1
MODEL="${ROOT}/models/qwen3-235b-a22b/Qwen3-235B-A22B-Instruct-2507-Q4_K_M-00001-of-00003.gguf"
PACK="${ROOT}/artifacts/h4/packs/qwen3-235b-a22b/qwen3-235b-a22b.pack"
export GALACTUS_H4=${GALACTUS:-1}   # GALACTUS=0 = stock pur (A/B)
export GALACTUS_PROFILE="${ROOT}/models/qwen3-235b-a22b/profile.engine.txt"
export GALACTUS_H4_INTERNAL="${PACK}"
export GALACTUS_H4_EXTERNAL="${PACK}"
export GALACTUS_H4_CPU_MOE=1
export GALACTUS_H4_CACHE_BYTES=${GALACTUS_CACHE_BYTES:-80000000000}  # quota ~74/couche
export GALACTUS_H4_QD=32
cd "${ROOT}/third_party/llama.cpp" && cmake --build build --target llama-cli -j 2>&1 | grep -E "error|Built target" | tail -1
cd "${ROOT}"
echo ""
echo "=== Qwen3-235B-A22B [GALACTUS=${GALACTUS:-1}] — cache $(( ${GALACTUS_H4_CACHE_BYTES} / 1000000000 )) Go, experts CPU ==="
third_party/llama.cpp/build/bin/llama-cli \
    --model "${MODEL}" \
    -p "Explain in two sentences why the sky is blue." \
    --predict 128 --ctx-size 4096 \
    --n-gpu-layers 99 --no-repack --fit off $( [ "${GALACTUS:-1}" = "1" ] && echo "--no-mmap --n-cpu-moe 99" ) \
    --batch-size 2 --ubatch-size "${GALACTUS_UB:-2}" \
    --seed 42 --temp 0 \
    --single-turn --simple-io --show-timings --log-colors off 2>&1 \
  | tee "${ROOT}/artifacts/h4/integration/dernier-test-qwen235.log" \
  | grep -avE "^[0-9]+\.[0-9]+\.[0-9]+" | tail -30
echo ""
if [ "${GALACTUS_H4_AUTOVERIF:-0}" = "1" ]; then
  L="${ROOT}/artifacts/h4/integration/dernier-test-qwen235.log"
  OK=$(grep -ac "galactus_autoverif.*IDENTIQUE" "${L}")
  KO=$(grep -ac "galactus_autoverif.*DIFFERENT" "${L}")
  echo "=== AUTOVERIFICATION : ${OK} IDENTIQUE, ${KO} DIFFERENT ==="
  grep -a "galactus_autoverif.*DIFFERENT" "${L}" | head -10
fi
read -r -p "Entree pour fermer"
