#!/bin/bash
# Chronometre le demarrage a froid d'un modele Galactus : temps du lancement
# jusqu'au PREMIER token (chargement + allocation arene + premiere lecture),
# puis le debit en regime etabli. C'est LA mesure qui dit si un lancement est
# "quasi transparent" ou pas.
#   GALACTUS_MODELE=qwen3-next-80b GALACTUS_CACHE_BYTES=... ./LANCER-CHRONO-DEMARRAGE.command
set -u
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "${ROOT}" || exit 1
ID="${GALACTUS_MODELE:-qwen3-next-80b}"
MDIR="${ROOT}/models/${ID}"
MODEL="$(ls "${MDIR}"/*.gguf 2>/dev/null | sort | head -1)"
PACK="${ROOT}/artifacts/h4/packs/${ID}/${ID}.pack"
[ -f "${MODEL}" ] || { echo "GGUF introuvable pour ${ID}"; read -r -p "Entree"; exit 1; }
[ -f "${PACK}" ]  || { echo "pack introuvable pour ${ID}"; read -r -p "Entree"; exit 1; }
export GALACTUS_H4=1
export GALACTUS_PROFILE="${MDIR}/profile.engine.txt"
export GALACTUS_H4_INTERNAL="${PACK}"
export GALACTUS_H4_EXTERNAL="${PACK}"
export GALACTUS_H4_CPU_MOE=1
export GALACTUS_H4_CACHE_BYTES="${GALACTUS_CACHE_BYTES:-18000000000}"
export GALACTUS_H4_QD=32
echo "=== chrono demarrage ${ID} — cache $(( GALACTUS_H4_CACHE_BYTES/1000000000 )) Go ==="
T0=$(python3 -c 'import time;print(time.time())')
third_party/llama.cpp/build/bin/llama-cli \
  --model "${MODEL}" -p "Bonjour." --predict 24 --ctx-size 2048 \
  --n-gpu-layers 99 --no-repack --fit off --no-mmap --n-cpu-moe 99 \
  --batch-size 2 --ubatch-size 1 --seed 42 --temp 0 \
  --single-turn --simple-io --show-timings --log-colors off 2>&1 \
  | grep -avE "^[0-9]+\.[0-9]+\.[0-9]+" | tail -20
T1=$(python3 -c 'import time;print(time.time())')
echo ""
echo "=== TEMPS TOTAL PROCESSUS (lancement -> fin des 24 tokens) : $(python3 -c "print(f'{${T1}-${T0}:.1f}')") s ==="
echo "(le prompt-eval affiche ci-dessus = temps jusqu'au 1er token ; compare avec/sans GALACTUS_H4_PREWARM plus tard)"
read -r -p "Entree pour fermer"
