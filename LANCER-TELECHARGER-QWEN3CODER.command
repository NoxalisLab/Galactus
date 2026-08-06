#!/bin/bash
# Telecharge Qwen3-Coder-30B-A3B-Instruct (GGUF Q8_0, ~32,5 Go). MoE dedie code,
# 3B actifs -> vitesse d'un petit modele. Reprise : curl -C -.
set -u
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="${ROOT}/models/qwen3-coder-30b"
mkdir -p "${DEST}"
BASE="https://huggingface.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF/resolve/main"
F="Qwen3-Coder-30B-A3B-Instruct-Q8_0.gguf"
echo "=== Qwen3-Coder-30B-A3B Q8_0 -> ${DEST} (~32,5 Go, reprise automatique) ==="
LIBRE=$(df -g "${ROOT}" | awk 'NR==2 {print $4}')
[ "${LIBRE}" -lt 70 ] && { echo "ATTENTION: ${LIBRE} Go libres, 70 recommandes."; read -r -p "Continuer ? (o/N) " R; [ "$R" = "o" ] || exit 1; }
curl -L -C - --fail --retry 8 --retry-delay 5 -o "${DEST}/${F}" "${BASE}/${F}"
echo ""; ls -lh "${DEST}"
echo "Telechargement termine. Etape suivante : profil -> plan -> pack -> certification (chaine qwen3moe existante)."
read -r -p "Entree pour fermer"
