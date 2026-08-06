#!/bin/bash
# Telecharge gpt-oss-120b (GGUF MXFP4, ~65,4 Go, un seul fichier, experts MXFP4 natifs) depuis Hugging Face.
# Reprise sur coupure : relancer ce script reprend ou il s'est arrete (curl -C -).
set -u
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="${ROOT}/models/gpt-oss-120b"
mkdir -p "${DEST}"
BASE="https://huggingface.co/unsloth/gpt-oss-120b-GGUF/resolve/main"
FICHIERS="gpt-oss-120b-F16.gguf"
echo "=== gpt-oss-120b -> ${DEST} (~65,4 Go, reprise automatique) ==="
LIBRE=$(df -g "${ROOT}" | awk 'NR==2 {print $4}')
if [ "${LIBRE}" -lt 70 ]; then
  echo "ATTENTION: ${LIBRE} Go libres sur le volume, 70 Go recommandes."
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
