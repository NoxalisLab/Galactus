#!/bin/bash
# Telecharge Llama-4 Scout 17B-16E Instruct (GGUF Q4_K_M, 2 fichiers, ~65,4 Go)
# depuis Hugging Face. Architecture llama4 : 16 experts + expert partage.
# Reprise sur coupure : relancer reprend (curl -C -).
set -u
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="${ROOT}/models/llama4-scout"
mkdir -p "${DEST}"
BASE="https://huggingface.co/unsloth/Llama-4-Scout-17B-16E-Instruct-GGUF/resolve/main/Q4_K_M"
FICHIERS="Llama-4-Scout-17B-16E-Instruct-Q4_K_M-00001-of-00002.gguf Llama-4-Scout-17B-16E-Instruct-Q4_K_M-00002-of-00002.gguf"
echo "=== Llama-4 Scout Q4_K_M -> ${DEST} (~65,4 Go, reprise automatique) ==="
LIBRE=$(df -g "${ROOT}" | awk 'NR==2 {print $4}')
if [ "${LIBRE}" -lt 140 ]; then
  echo "ATTENTION: ${LIBRE} Go libres, 140 Go recommandes (GGUF + pack)."
  read -r -p "Continuer quand meme ? (o/N) " REP
  [ "${REP}" = "o" ] || exit 1
fi
for F in ${FICHIERS}; do
  echo ""
  echo "--- ${F} ---"
  curl -L -C - --fail --retry 8 --retry-delay 5 -o "${DEST}/${F}" "${BASE}/${F}"
done
echo ""
ls -lh "${DEST}"
echo "Telechargement termine. Etape suivante : le profil."
read -r -p "Entree pour fermer"
