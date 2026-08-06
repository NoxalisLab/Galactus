#!/bin/bash
# Banc de paliers memoire gpt-oss-120b, calques sur la gamme Mac officielle
# (MacBook Pro M5 : 16/24/32 - M5 Pro : 24/48/64/128 - M5 Max : 36/48/64/128).
# Un run de 128 tokens par palier sur le chemin qualite certifie.
# cache experts = min(RAM - 9 Go, 61 Go) ; 61 Go = residence complete des
# 60,93 Go d'experts (les paliers 64 et 128 Go different par la marge systeme,
# pas par le cache une fois tout resident).
#   GALACTUS_MACHINES="16 24 32 36 48 64 128" (Go, defaut) pour changer.
set -u
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${ROOT}" || exit 1
OUT="${ROOT}/artifacts/h4/bench"
mkdir -p "${OUT}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CSV="${OUT}/goss-paliers-${STAMP}.csv"
MODEL="${ROOT}/models/gpt-oss-120b/gpt-oss-120b-F16.gguf"
PACK="${ROOT}/artifacts/h4/packs/gpt-oss-120b/gpt-oss-120b.pack"
MACHINES="${GALACTUS_MACHINES:-16 24 32 36 48 64 128}"
RECORD=13221888
LAYERS=36
PLEIN_GB=61   # residence complete (60,93 Go)

cd third_party/llama.cpp && cmake --build build --target llama-cli -j 2>&1 | grep -E "error|Built target" | tail -1
cd "${ROOT}"

echo "machine_gb,cache_gb,quota_par_couche,prompt_tps,gen_tps" > "${CSV}"
echo ""
echo "=== banc gamme Mac — gpt-oss-120b — ${STAMP} ==="
echo "(micro-lot physique 1, chemin qualite certifie : experts CPU, biais CPU)"
echo ""
for M in ${MACHINES}; do
  GB=$(( M - 9 ))
  [ "${GB}" -gt "${PLEIN_GB}" ] && GB=${PLEIN_GB}
  CACHE=$(( GB * 1000000000 ))
  QUOTA=$(( CACHE / (LAYERS * RECORD) ))
  [ "${QUOTA}" -gt 128 ] && QUOTA=128
  PROBATION=$(( QUOTA - (QUOTA * 3 / 4) ))
  if [ "${PROBATION}" -lt 4 ]; then
    echo "--- Mac ${M} Go (cache ${GB} Go, quota ${QUOTA}) : probation ${PROBATION} < 4 -> INSUFFISANT"
    echo "${M},${GB},${QUOTA},insuffisant,insuffisant" >> "${CSV}"
    continue
  fi
  echo "--- Mac ${M} Go -> cache ${GB} Go (quota ${QUOTA}/couche$( [ "${QUOTA}" -ge 128 ] && echo ", residence complete" )) ---"
  LOG="${OUT}/goss-mac${M}g-${STAMP}.log"
  GALACTUS_H4=1 \
  GALACTUS_PROFILE="${ROOT}/models/gpt-oss-120b/profile.engine.txt" \
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
echo " - 16/24/32 : MacBook Pro M5 ; 24-128 : M5 Pro ; 36-128 : M5 Max"
echo " - a 64 et 128 Go les experts tiennent presque/entierement residents ;"
echo "   sur 128 Go le stock natif reste plus rapide (le modele tient en RAM)"
echo " - chiffres mesures sur CE M5 Max : une machine de gamme inferieure"
echo "   (SSD/CPU plus lents) descendra en dessous, a valider sur machine reelle"
read -r -p "Entree pour fermer"
