#!/bin/bash
# Telecharge Qwen3-Next-80B-A3B-Instruct (GGUF Q4_K_M, 1 fichier, ~48,5 Go).
# LE modele quotidien : 80B de qualite, 3B actifs -> vitesse d'un petit modele.
# Ne tient pas dans 24/32/36 Go nativement. Reprise : curl -C -.
set -u
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="${ROOT}/models/qwen3-next-80b"
mkdir -p "${DEST}"
BASE="https://huggingface.co/unsloth/Qwen3-Next-80B-A3B-Instruct-GGUF/resolve/main"
FICHIERS="Qwen3-Next-80B-A3B-Instruct-Q4_K_M.gguf"
echo "=== Qwen3-Next-80B-A3B Q4_K_M -> ${DEST} (~48,5 Go, reprise automatique) ==="
LIBRE=$(df -g "${ROOT}" | awk 'NR==2 {print $4}')
if [ "${LIBRE}" -lt 110 ]; then
  echo "ATTENTION: ${LIBRE} Go libres, 110 Go recommandes (GGUF + pack)."
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
