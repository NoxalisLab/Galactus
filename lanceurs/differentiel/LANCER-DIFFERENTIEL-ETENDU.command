#!/bin/bash
# DIFFERENTIEL ETENDU : deux runs de perplexite COMPLETS (512 tokens, 256
# micro-lots) avec dump de TOUS les tenseurs MoE de la couche choisie.
# Contenu innocente (768/768), eviction innocentee (epingle), deviation
# deterministe : la premiere ligne divergente nomme l'operation et le
# micro-lot ou nait la corruption.
#   GALACTUS_COUCHE=6 ./lanceurs/LANCER-DIFFERENTIEL-ETENDU.command
set -u
export LC_ALL=C
export LANG=C
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[ -f "${ROOT}/galactus.env" ] && . "${ROOT}/galactus.env"
cd "${ROOT}" || exit 1
OUT="${ROOT}/artifacts/h4/integration"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
COUCHE="${GALACTUS_COUCHE:-6}"
MODEL="${GALACTUS_MODEL:-${ROOT}/models/glm-5.2-ud-iq1-s/UD-IQ1_S/GLM-5.2-UD-IQ1_S-00001-of-00006.gguf}"
INTERNAL="${GALACTUS_INTERNAL_PACK:?definir GALACTUS_INTERNAL_PACK (voir galactus.env.example)}"
EXTERNAL="${GALACTUS_EXTERNAL_PACK:?definir GALACTUS_EXTERNAL_PACK (voir galactus.env.example)}"
export GALACTUS_H4_DUMP=1
export GALACTUS_H4_DUMP_LAYER="${COUCHE}"
export GALACTUS_H4_DUMP_CAP=4000
COMMUN=(--model "${MODEL}" --file "${ROOT}/corpus/materialized/stage1/coding-repobench-p-e-0048.txt"
        --ctx-size 512 --chunks 1
        --n-gpu-layers 12 --n-cpu-moe 78 --no-repack --fit off
        --batch-size 512 --ubatch-size 2 --seed 42 --log-colors off)
{
echo "=== differentiel etendu couche ${COUCHE} — ${STAMP} ==="
cd third_party/llama.cpp && cmake --build build --target llama-perplexity -j 2>&1 | grep -E "error|Built target" | tail -2
cd "${ROOT}"

echo ""
echo "--- run STOCK (sain) ---"
unset GALACTUS_H4 || true
third_party/llama.cpp/build/bin/llama-perplexity "${COMMUN[@]}" \
    > "${OUT}/${STAMP}-etendu-stock.out" 2>&1 || true
grep -a "galactus_dump" "${OUT}/${STAMP}-etendu-stock.out" > "${OUT}/${STAMP}-etendu-stock.txt"
wc -l "${OUT}/${STAMP}-etendu-stock.txt"
grep -aoE "Final estimate: PPL = [0-9.]+" "${OUT}/${STAMP}-etendu-stock.out" | tail -1

echo ""
echo "--- run CABLAGE (plage ${COUCHE}-${COUCHE}, experts CPU) ---"
export GALACTUS_H4=1
export GALACTUS_H4_CPU_MOE=1
export GALACTUS_H4_ONLY_LAYERS="${COUCHE}-${COUCHE}"
export GALACTUS_H4_INTERNAL="${INTERNAL}"
export GALACTUS_H4_EXTERNAL="${EXTERNAL}"
export GALACTUS_H4_CACHE_BYTES=62000000000
export GALACTUS_H4_QD=32
third_party/llama.cpp/build/bin/llama-perplexity "${COMMUN[@]}" \
    > "${OUT}/${STAMP}-etendu-cablage.out" 2>&1 || true
grep -a "galactus_dump" "${OUT}/${STAMP}-etendu-cablage.out" > "${OUT}/${STAMP}-etendu-cablage.txt"
wc -l "${OUT}/${STAMP}-etendu-cablage.txt"
grep -aoE "Final estimate: PPL = [0-9.]+" "${OUT}/${STAMP}-etendu-cablage.out" | tail -1

echo ""
echo "=== PREMIERE DIVERGENCE (topk_galactus ecarte : present d'un seul cote) ==="
diff <(grep -av "topk_galactus" "${OUT}/${STAMP}-etendu-stock.txt") \
     <(grep -av "topk_galactus" "${OUT}/${STAMP}-etendu-cablage.txt") | head -14 \
  || true
diff <(grep -av "topk_galactus" "${OUT}/${STAMP}-etendu-stock.txt") \
     <(grep -av "topk_galactus" "${OUT}/${STAMP}-etendu-cablage.txt") > /dev/null \
  && echo "AUCUNE DIVERGENCE sur ${COUCHE} (!) — chercher hors MoE" \
  || echo "(diff complet dans les .txt du dossier integration)"
} 2>&1 | tee "${OUT}/${STAMP}-differentiel-etendu-${COUCHE}.log"
echo ""
read -r -p "Entree pour fermer"
