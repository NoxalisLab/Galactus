#!/bin/bash
# Differentiel gpt-oss : stock (ncmoe, experts CPU) contre cable (arene CPU),
# dumps integraux de la couche choisie, PPL des deux cotes. La premiere
# empreinte divergente nomme l'operation coupable.
#   GALACTUS_COUCHE=3 ./LANCER-DIFFERENTIEL-GPTOSS.command
set -u
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "${ROOT}" || exit 1
OUT="${ROOT}/artifacts/h4/integration"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
COUCHE="${GALACTUS_COUCHE:-3}"
MODEL="${ROOT}/models/qwen3-30b-a3b/Qwen3-30B-A3B-Instruct-2507-Q8_0.gguf"
PACK="${ROOT}/artifacts/h4/packs/qwen3-30b-a3b/qwen3-30b-a3b.pack"
export GALACTUS_H4_DUMP=1
export GALACTUS_H4_DUMP_LAYER="${COUCHE}"
export GALACTUS_H4_DUMP_CAP=4000
COMMUN=(--model "${MODEL}" --file "${ROOT}/corpus/materialized/stage1/coding-repobench-p-e-0048.txt"
        --ctx-size 512 --chunks 1
        --n-gpu-layers "${GALACTUS_NGL:-99}" --no-repack --fit off
        --batch-size 512 --ubatch-size 2 --seed 42 --log-colors off)
{
echo "=== differentiel qwen3-30b couche ${COUCHE} — ${STAMP} (ngl ${GALACTUS_NGL:-99}) ==="
cd third_party/llama.cpp && cmake --build build --target llama-perplexity -j 2>&1 | grep -E "error|Built target" | tail -2
cd "${ROOT}"
echo ""
echo "--- run STOCK (experts CPU via ncmoe) ---"
unset GALACTUS_H4 || true
third_party/llama.cpp/build/bin/llama-perplexity "${COMMUN[@]}" --n-cpu-moe 99 \
    > "${OUT}/${STAMP}-qwen30-stock.out" 2>&1 || true
grep -a "galactus_dump" "${OUT}/${STAMP}-qwen30-stock.out" > "${OUT}/${STAMP}-qwen30-stock.txt"
wc -l "${OUT}/${STAMP}-qwen30-stock.txt"; grep -aoE "Final estimate: PPL = [0-9.]+" "${OUT}/${STAMP}-qwen30-stock.out" | tail -1
echo ""
echo "--- run CABLE (arene mono-volume, experts CPU) ---"
export GALACTUS_H4=1
export GALACTUS_PROFILE="${ROOT}/models/qwen3-30b-a3b/profile.engine.txt"
export GALACTUS_H4_INTERNAL="${PACK}"
export GALACTUS_H4_EXTERNAL="${PACK}"
export GALACTUS_H4_CPU_MOE=1
export GALACTUS_H4_CACHE_BYTES=18000000000
export GALACTUS_H4_QD=32
third_party/llama.cpp/build/bin/llama-perplexity "${COMMUN[@]}" --no-mmap --n-cpu-moe 99 \
    > "${OUT}/${STAMP}-qwen30-cable.out" 2>&1 || true
grep -a "galactus_dump" "${OUT}/${STAMP}-qwen30-cable.out" > "${OUT}/${STAMP}-qwen30-cable.txt"
wc -l "${OUT}/${STAMP}-qwen30-cable.txt"; grep -aoE "Final estimate: PPL = [0-9.]+" "${OUT}/${STAMP}-qwen30-cable.out" | tail -1
echo ""
echo "=== PREMIERE DIVERGENCE ==="
diff <(grep -av "topk_galactus" "${OUT}/${STAMP}-qwen30-stock.txt") \
     <(grep -av "topk_galactus" "${OUT}/${STAMP}-qwen30-cable.txt") | head -14 || true
diff <(grep -av "topk_galactus" "${OUT}/${STAMP}-qwen30-stock.txt") \
     <(grep -av "topk_galactus" "${OUT}/${STAMP}-qwen30-cable.txt") > /dev/null \
  && echo "AUCUNE DIVERGENCE sur ${COUCHE}" || echo "(details dans les .txt)"
} 2>&1 | tee "${OUT}/${STAMP}-differentiel-qwen30-${COUCHE}.log"
echo ""
read -r -p "Entree pour fermer"
