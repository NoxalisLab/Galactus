#!/bin/bash
# Banc petites machines Qwen3-235B-A22B : LE test du principe Galactus —
# 137 Go d'experts sur des Mac de 24 a 128 Go. Fraction protegee ADAPTATIVE :
# pour chaque palier on prend la plus grande fraction (0.75, 0.5, 0.25) dont
# la probation accepte les 8 experts distincts d'un token (micro-lot 1).
#   GALACTUS_MACHINES="24 36 48 64 96 128" (defaut)
set -u
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${ROOT}" || exit 1
OUT="${ROOT}/artifacts/h4/bench"
mkdir -p "${OUT}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CSV="${OUT}/glmair-paliers-${STAMP}.csv"
MODEL="${ROOT}/models/glm-4.5-air/GLM-4.5-Air-Q4_K_M-00001-of-00002.gguf"
PACK="${ROOT}/artifacts/h4/packs/glm-4.5-air/glm-4.5-air.pack"
MACHINES="${GALACTUS_MACHINES:-24 36 48 64 96}"
RECORD=11462246
LAYERS=45
BESOIN=8   # experts distincts par token (8 actifs, micro-lot 1)

cd third_party/llama.cpp && cmake --build build --target llama-cli -j 2>&1 | grep -E "error|Built target" | tail -1
cd "${ROOT}"

echo "machine_gb,cache_gb,quota,fraction,probation,prompt_tps,gen_tps" > "${CSV}"
echo ""
echo "=== banc petites machines — GLM-4.5-Air (66 Go d'experts) — ${STAMP} ==="
echo ""
for M in ${MACHINES}; do
  GB=$(( M - 10 ))
  # plafond 70 % de la RAM simulee : au-dela, le compresseur memoire de macOS
  # mange le debit (mesure au palier 128 : gen 1,6 t/s a 100 Go d'arene)
  CAP=$(( M * 70 / 100 ))
  [ "${GB}" -gt "${CAP}" ] && GB=${CAP}
  CACHE=$(( GB * 1000000000 ))
  QUOTA=$(( CACHE / (LAYERS * RECORD) ))
  [ "${QUOTA}" -gt 128 ] && QUOTA=128
  FRACTION=""
  for F in 75 50 25; do
    PROT=$(( QUOTA * F / 100 ))
    [ "${PROT}" -lt 1 ] && PROT=1
    [ "${PROT}" -gt $(( QUOTA - 1 )) ] && PROT=$(( QUOTA - 1 ))
    PROBATION=$(( QUOTA - PROT ))
    if [ "${PROBATION}" -ge "${BESOIN}" ]; then FRACTION="0.${F}"; break; fi
  done
  if [ -z "${FRACTION}" ] || [ "${QUOTA}" -lt 2 ]; then
    echo "--- Mac ${M} Go (cache ${GB} Go, quota ${QUOTA}) : probation insuffisante meme a 0.25 -> INSUFFISANT"
    echo "${M},${GB},${QUOTA},aucune,${PROBATION:-0},insuffisant,insuffisant" >> "${CSV}"
    continue
  fi
  echo "--- Mac ${M} Go -> cache ${GB} Go (quota ${QUOTA}/couche, fraction ${FRACTION}, probation ${PROBATION}) ---"
  LOG="${OUT}/glmair-mac${M}g-${STAMP}.log"
  GALACTUS_H4=1 \
  GALACTUS_PROFILE="${ROOT}/models/glm-4.5-air/profile.engine.txt" \
  GALACTUS_H4_INTERNAL="${PACK}" \
  GALACTUS_H4_EXTERNAL="${PACK}" \
  GALACTUS_H4_CPU_MOE=1 \
  GALACTUS_H4_CACHE_BYTES="${CACHE}" \
  GALACTUS_H4_PROTECTED="${FRACTION}" \
  GALACTUS_H4_QD=32 \
  third_party/llama.cpp/build/bin/llama-cli \
    --model "${MODEL}" \
    -p "Write a detailed, well-structured explanation of how a modern solid state drive stores, reads and wears its flash cells, covering SLC caching, wear leveling and garbage collection, in about three hundred words." \
    --predict 192 --ctx-size 4096 \
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
    echo "${M},${GB},${QUOTA},${FRACTION},${PROBATION},echec,echec" >> "${CSV}"
    continue
  fi
  echo "    prompt ${P} t/s | generation ${G} t/s"
  echo "${M},${GB},${QUOTA},${FRACTION},${PROBATION},${P},${G}" >> "${CSV}"
done
echo ""
echo "=== TABLEAU FINAL — 235B sur petites machines ==="
column -s, -t < "${CSV}"
echo ""
echo "CSV : ${CSV}"
echo "(fraction adaptative : hit-rate moindre aux petites fractions, mais CA TOURNE ;"
echo " chiffres M5 Max, machines reelles plus lentes a valider)"
read -r -p "Entree pour fermer"
