#!/bin/bash
# Telecharge Qwen3-30B-A3B-Instruct-2507 (GGUF Q8_0, ~32,5 Go, un seul fichier)
# depuis Hugging Face. Architecture qwen3moe : 128 experts, 8 actifs, sans
# biais d'experts. Reprise sur coupure : relancer reprend (curl -C -).
set -u
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="${ROOT}/models/qwen3-30b-a3b"
mkdir -p "${DEST}"
BASE="https://huggingface.co/unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF/resolve/main"
FICHIERS="Qwen3-30B-A3B-Instruct-2507-Q8_0.gguf"
echo "=== Qwen3-30B-A3B-Instruct-2507 Q8_0 -> ${DEST} (~32,5 Go, reprise automatique) ==="
LIBRE=$(df -g "${ROOT}" | awk 'NR==2 {print $4}')
if [ "${LIBRE}" -lt 70 ]; then
  echo "ATTENTION: ${LIBRE} Go libres sur le volume, 70 Go recommandes (GGUF + pack)."
  read -r -p "Continuer quand meme ? (o/N) " REP
  [ "${REP}" = "o" ] || exit 1
fi
for F in ${FICHIERS}; do
  echo ""
  echo "--- ${F} ---"
  curl -L -C - --fail --retry 8 --retry-delay 5 -o "${DEST}/${F}" "${BASE}/${F}"
done
echo ""
echo "=== verification des tailles ==="
ls -lh "${DEST}"
echo ""
echo "Telechargement termine. Etape suivante : le profil (je m'en charge des que c'est la)."
read -r -p "Entree pour fermer"
