#!/bin/bash
# Autoverification gpt-oss : deux runs PPL cables, avec puis sans F_NOCACHE.
# Chaque enregistrement servi est relu du pack par un descripteur neuf et
# compare a l'arene AU MOMENT du service. Trois issues possibles :
#   A propre                  -> la course d'eviction corrigee etait le defaut
#   A faux, B propre          -> F_NOCACHE est le coupable
#   A faux, B faux            -> le defaut est ailleurs (offsets, longueurs)
set -u
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "${ROOT}" || exit 1
OUT="${ROOT}/artifacts/h4/integration"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
MODEL="${ROOT}/models/gpt-oss-120b/gpt-oss-120b-F16.gguf"
PACK="${ROOT}/artifacts/h4/packs/gpt-oss-120b/gpt-oss-120b.pack"
COMMUN=(--model "${MODEL}" --file "${ROOT}/corpus/materialized/stage1/coding-repobench-p-e-0048.txt"
        --ctx-size 512 --chunks 1
        --n-gpu-layers 99 --no-repack --fit off
        --batch-size 512 --ubatch-size 2 --seed 42 --log-colors off --no-mmap)
export GALACTUS_H4=1
export GALACTUS_PROFILE="${ROOT}/models/gpt-oss-120b/profile.engine.txt"
export GALACTUS_H4_INTERNAL="${PACK}"
export GALACTUS_H4_EXTERNAL="${PACK}"
export GALACTUS_H4_CPU_MOE=1
export GALACTUS_H4_CACHE_BYTES=24000000000
export GALACTUS_H4_QD=32
export GALACTUS_H4_AUTOVERIF=1
{
echo "=== autoverification gpt-oss — ${STAMP} (reference stock : PPL 142.8669) ==="
cd third_party/llama.cpp && cmake --build build --target llama-perplexity -j 2>&1 | grep -E "error|Built target" | tail -2
cd "${ROOT}"
echo ""
echo "--- run A : cable, F_NOCACHE actif ---"
unset GALACTUS_H4_NOCACHE || true
third_party/llama.cpp/build/bin/llama-perplexity "${COMMUN[@]}" \
    > "${OUT}/${STAMP}-autoverif-A.out" 2>&1 || true
grep -a "galactus_autoverif" "${OUT}/${STAMP}-autoverif-A.out" | head -50
grep -aoE "Final estimate: PPL = [0-9.]+" "${OUT}/${STAMP}-autoverif-A.out" | tail -1
A_FAUX=$(grep -ac "DIFFERENT" "${OUT}/${STAMP}-autoverif-A.out" || true)
echo ""
echo "--- run B : cable, F_NOCACHE DESACTIVE ---"
export GALACTUS_H4_NOCACHE=0
third_party/llama.cpp/build/bin/llama-perplexity "${COMMUN[@]}" \
    > "${OUT}/${STAMP}-autoverif-B.out" 2>&1 || true
grep -a "galactus_autoverif" "${OUT}/${STAMP}-autoverif-B.out" | head -50
grep -aoE "Final estimate: PPL = [0-9.]+" "${OUT}/${STAMP}-autoverif-B.out" | tail -1
B_FAUX=$(grep -ac "DIFFERENT" "${OUT}/${STAMP}-autoverif-B.out" || true)
echo ""
echo "=== VERDICT ==="
echo "run A (F_NOCACHE actif)    : ${A_FAUX} enregistrement(s) faux sur 48 verifies"
echo "run B (F_NOCACHE desactive): ${B_FAUX} enregistrement(s) faux sur 48 verifies"
if [ "${A_FAUX}" = "0" ] && [ "${B_FAUX}" = "0" ]; then
  echo "-> lectures propres : la course d'eviction corrigee etait le defaut restant."
elif [ "${A_FAUX}" != "0" ] && [ "${B_FAUX}" = "0" ]; then
  echo "-> F_NOCACHE est le coupable : les lectures sans lui sont fideles."
else
  echo "-> le defaut persiste sans F_NOCACHE : chercher cote offsets/longueurs."
fi
} 2>&1 | tee "${OUT}/${STAMP}-autoverif.log"
echo ""
read -r -p "Entree pour fermer"
