#!/bin/bash
# Telecharge GLM-4.5-Air 106B-A12B (GGUF Q4_K_M, 2 fichiers, ~73 Go).
# Ne tient pas dans 24-64 Go nativement ; 12B actifs -> debit confortable.
# Reprise : curl -C -.
set -u
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="${ROOT}/models/glm-4.5-air"
mkdir -p "${DEST}"
BASE="https://huggingface.co/unsloth/GLM-4.5-Air-GGUF/resolve/main/Q4_K_M"
FICHIERS="GLM-4.5-Air-Q4_K_M-00001-of-00002.gguf GLM-4.5-Air-Q4_K_M-00002-of-00002.gguf"
echo "=== GLM-4.5-Air Q4_K_M -> ${DEST} (~73 Go, reprise automatique) ==="
LIBRE=$(df -g "${ROOT}" | awk 'NR==2 {print $4}')
if [ "${LIBRE}" -lt 160 ]; then
  echo "ATTENTION: ${LIBRE} Go libres, 160 Go recommandes (GGUF + pack)."
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
