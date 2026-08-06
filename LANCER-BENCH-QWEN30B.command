#!/bin/bash
# Banc de paliers memoire qwen3-30b, calques sur la gamme Mac officielle
# (paliers pertinents : 16/24/32/36/48 - au-dela le stock natif gagne).
# Un run de 128 tokens par palier sur le chemin qualite certifie.
# cache experts = min(RAM - 7 Go, 61 Go) ; 61 Go = residence complete des
# 30,8 Go d'experts (au-dela de ~40 Go de RAM le modele tient nativement,
# le stock est alors plus rapide).
#   GALACTUS_MACHINES="16 24 32 36 48 64 128" (Go, defaut) pour changer.
set -u
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "${ROOT}" || exit 1
OUT="${ROOT}/artifacts/h4/bench"
mkdir -p "${OUT}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CSV="${OUT}/qwen30-paliers-${STAMP}.csv"
MODEL="${ROOT}/models/qwen3-30b-a3b/Qwen3-30B-A3B-Instruct-2507-Q8_0.gguf"
PACK="${ROOT}/artifacts/h4/packs/qwen3-30b-a3b/qwen3-30b-a3b.pack"
MACHINES="${GALACTUS_MACHINES:-16 24 32 36 48}"
RECORD=5013504
LAYERS=48
PLEIN_GB=31   # residence complete (30,8 Go)

cd third_party/llama.cpp && cmake --build build --target llama-cli -j 2>&1 | grep -E "error|Built target" | tail -1
cd "${ROOT}"

echo "machine_gb,cache_gb,quota_par_couche,prompt_tps,gen_tps" > "${CSV}"
echo ""
echo "=== banc gamme Mac — qwen3-30b — ${STAMP} ==="
echo "(micro-lot physique 1, chemin qualite certifie : experts CPU, biais CPU)"
echo ""
for M in ${MACHINES}; do
  GB=$(( M - 7 ))
  [ "${GB}" -gt "${PLEIN_GB}" ] && GB=${PLEIN_GB}
  CACHE=$(( GB * 1000000000 ))
  QUOTA=$(( CACHE / (LAYERS * RECORD) ))
  [ "${QUOTA}" -gt 128 ] && QUOTA=128
  PROBATION=$(( QUOTA - (QUOTA * 3 / 4) ))
  if [ "${PROBATION}" -lt 8 ]; then
    echo "--- Mac ${M} Go (cache ${GB} Go, quota ${QUOTA}) : probation ${PROBATION} < 8 -> INSUFFISANT"
    echo "${M},${GB},${QUOTA},insuffisant,insuffisant" >> "${CSV}"
    continue
  fi
  echo "--- Mac ${M} Go -> cache ${GB} Go (quota ${QUOTA}/couche$( [ "${QUOTA}" -ge 128 ] && echo ", residence complete" )) ---"
  LOG="${OUT}/qwen30-mac${M}g-${STAMP}.log"
  GALACTUS_H4=1 \
  GALACTUS_PROFILE="${ROOT}/models/qwen3-30b-a3b/profile.engine.txt" \
  GALACTUS_H4_INTERNAL="${PACK}" \
  GALACTUS_H4_EXTERNAL="${PACK}" \
  GALACTUS_H4_CPU_MOE=1 \
  GALACTUS_H4_CACHE_BYTES="${CACHE}" \
  GALACTUS_H4_QD=32 \
  third_party/llama.cpp/build/bin/llama-cli \
    --model "${MODEL}" \
    -p "Write a detailed, well-structured explanation of how a modern solid state drive stores, reads and wears its flash cells, covering SLC caching, wear leveling and garbage collection, in about three hundred words." \
    --predict 128 --ctx-size 4096 \
    --n-gpu-layers 99 --no-repack --fit off --no-mmap --n-cpu-moe 99 \
    --batch-size 2 --ubatch-size 1 \
    --seed 42 --temp 0 \
    --single-turn --simple-io --show-timings --log-colors off \
    > "${LOG}" 2>&1 || true
  LINE=$(grep -aoE "Prompt: [0-9.]+ t/s \| Generation: [0-9.]+ t/s" "${LOG}" | tail -1)
  P=$(echo "${LINE}" | grep -aoE "Prompt: [0-9.]+" | grep -aoE "[0-9.]+")
  G=$(echo "${LINE}" | grep -aoE "Generation: [0-9.]+" | grep -aoE "[0-9.]+")
  if [ -z "${G:-}" ]; then
    echo "    ECHEC (voir ${LOG})"
    echo "${M},${GB},${QUOTA},echec,echec" >> "${CSV}"
    continue
  fi
  echo "    prompt ${P} t/s | generation ${G} t/s"
  echo "${M},${GB},${QUOTA},${P},${G}" >> "${CSV}"
done
echo ""
echo "=== TABLEAU FINAL (gamme Mac officielle) ==="
column -s, -t < "${CSV}"
echo ""
echo "CSV : ${CSV}"
echo "Notes :"
echo " - 16/24/32 : MacBook Pro M5 ; 36/48 : M5 Max — au-dela, stock natif"
echo " - a 64 et 128 Go les experts tiennent presque/entierement residents ;"
echo "   sur 128 Go le stock natif reste plus rapide (le modele tient en RAM)"
echo " - chiffres mesures sur CE M5 Max : une machine de gamme inferieure"
echo "   (SSD/CPU plus lents) descendra en dessous, a valider sur machine reelle"
read -r -p "Entree pour fermer"
