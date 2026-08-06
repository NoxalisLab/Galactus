#!/bin/bash
# Telecharge Qwen3-235B-A22B-Instruct-2507 (GGUF Q4_K_M, 3 fichiers, ~142,2 Go)
# depuis Hugging Face. Reprise sur coupure : relancer reprend (curl -C -).
set -u
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="${ROOT}/models/qwen3-235b-a22b"
mkdir -p "${DEST}"
BASE="https://huggingface.co/unsloth/Qwen3-235B-A22B-Instruct-2507-GGUF/resolve/main/Q4_K_M"
FICHIERS="Qwen3-235B-A22B-Instruct-2507-Q4_K_M-00001-of-00003.gguf Qwen3-235B-A22B-Instruct-2507-Q4_K_M-00002-of-00003.gguf Qwen3-235B-A22B-Instruct-2507-Q4_K_M-00003-of-00003.gguf"
echo "=== Qwen3-235B-A22B Q4_K_M -> ${DEST} (~142,2 Go, reprise automatique) ==="
LIBRE=$(df -g "${ROOT}" | awk 'NR==2 {print $4}')
if [ "${LIBRE}" -lt 290 ]; then
  echo "ATTENTION: ${LIBRE} Go libres, 290 Go recommandes (GGUF + pack)."
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
