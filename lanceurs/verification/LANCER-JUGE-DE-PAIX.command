#!/bin/bash
# LE JUGE DE PAIX : la correction du cablage, avant toute optimisation.
#
# Pourquoi pas une identite token-pour-token contre -ncmoe ? Parce qu'elle ne
# peut pas exister : avec le cablage, les mul_mat_id des experts tournent sur
# Metal ; avec -ncmoe ils tournent sur le CPU. Deux ordres de sommation
# flottante differents, divergence legitime au fil des tokens, meme a
# temperature zero. Les deux verdicts honnetes sont :
#
#   A. DETERMINISME  deux executions du cablage, memes reglages -> les textes
#      doivent etre IDENTIQUES A L'OCTET. Un cache qui servirait des octets
#      instables echouerait ici.
#   B. PERPLEXITE    la mesure standard de correction numerique, robuste au
#      reordonnancement flottant : cablage vs -ncmoe sur le meme texte.
#      Attendu : ecart < ~1 %. Un expert mal adresse ou un octet corrompu
#      fait exploser la perplexite -- c'est un detecteur tres sensible.
set -u
export LC_ALL=C
export LANG=C
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[ -f "${ROOT}/galactus.env" ] && . "${ROOT}/galactus.env"
cd "${ROOT}" || exit 1
OUT="${ROOT}/artifacts/h4/integration"
mkdir -p "${OUT}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
MODEL="${GALACTUS_MODEL:-${ROOT}/models/glm-5.2-ud-iq1-s/UD-IQ1_S/GLM-5.2-UD-IQ1_S-00001-of-00006.gguf}"
INTERNAL="${GALACTUS_INTERNAL_PACK:?definir GALACTUS_INTERNAL_PACK (voir galactus.env.example)}"
EXTERNAL="${GALACTUS_EXTERNAL_PACK:?definir GALACTUS_EXTERNAL_PACK (voir galactus.env.example)}"
PPLTEXT="${ROOT}/corpus/materialized/stage1/coding-repobench-p-e-0048.txt"
export GALACTUS_GUARD_MAX_OUTPUT_BYTES=268435456
export GALACTUS_GUARD_MIN_VOLUME_FREE_MB=10240

galactus_env () {
  export GALACTUS_H4=1
  export GALACTUS_H4_INTERNAL="${INTERNAL}"
  export GALACTUS_H4_EXTERNAL="${EXTERNAL}"
  export GALACTUS_H4_CACHE_BYTES=92000000000
  export GALACTUS_H4_QD=32
}

{
echo "=== juge de paix — ${STAMP} ==="
/usr/bin/memory_pressure -Q | grep -i "free percentage"; /usr/sbin/sysctl -n vm.swapusage
echo "--- reconstruction (correctif eviction-sur-succes) ---"
( cd third_party/llama.cpp && cmake --build build --target llama-cli llama-perplexity -j 2>&1 | grep -E "error|Built target" | tail -4 )

echo ""
echo "########## A. determinisme : deux executions du cablage ##########"
for R in 1 2; do
  galactus_env
  scripts/run-benchmark-guarded-mmap.sh \
      --min-free-percent 5 --max-footprint-gib 118 \
      --max-preexisting-swap-mb 8192 --swap-policy capture \
      --free-percent-policy telemetry --poll-seconds 0.25 --max-wall-seconds 1800 \
      --log "${OUT}/${STAMP}-det${R}-memory.csv" \
      --output "${OUT}/${STAMP}-det${R}.out" \
      -- third_party/llama.cpp/build/bin/llama-cli \
          --model "${MODEL}" --file "${ROOT}/corpus/demo-prompt.txt" \
          --ctx-size 4096 --predict 128 \
          --n-gpu-layers 99 --no-repack --fit off --no-mmap \
          --batch-size 2 --ubatch-size 2 --seed 42 --temp 0 \
          --single-turn --no-conversation --simple-io --show-timings --log-colors off \
          --log-file "${OUT}/${STAMP}-det${R}-llama.log"
  echo "  execution ${R} : statut garde = $?"
done
if cmp -s "${OUT}/${STAMP}-det1.out" "${OUT}/${STAMP}-det2.out"; then
  echo "VERDICT A : DETERMINISTE — sorties identiques a l'octet"
else
  echo "VERDICT A : ECHEC — les deux executions divergent :"
  diff <(tr -d '\0' < "${OUT}/${STAMP}-det1.out") <(tr -d '\0' < "${OUT}/${STAMP}-det2.out") | head -10
fi

echo ""
echo "########## B. perplexite : cablage vs -ncmoe, meme texte ##########"
echo "(un chunk de 512 tokens ; la reference -ncmoe lira par mmap, c'est lent, ~10-20 min)"
galactus_env
scripts/run-benchmark-guarded-mmap.sh \
    --min-free-percent 5 --max-footprint-gib 118 \
    --max-preexisting-swap-mb 8192 --swap-policy capture \
    --free-percent-policy telemetry --poll-seconds 0.25 --max-wall-seconds 3600 \
    --log "${OUT}/${STAMP}-ppl-h4-memory.csv" \
    --output "${OUT}/${STAMP}-ppl-h4.out" \
    -- third_party/llama.cpp/build/bin/llama-perplexity \
        --model "${MODEL}" --file "${PPLTEXT}" \
        --ctx-size 512 --chunks 1 \
        --n-gpu-layers 99 --no-repack --fit off --no-mmap \
        --batch-size 512 --ubatch-size 2 --seed 42 --log-colors off
echo "  perplexite cablage : statut garde = $?"
unset GALACTUS_H4
scripts/run-benchmark-guarded-mmap.sh \
    --min-free-percent 5 --max-footprint-gib 118 \
    --max-preexisting-swap-mb 8192 --swap-policy capture \
    --free-percent-policy telemetry --poll-seconds 0.25 --max-wall-seconds 3600 \
    --log "${OUT}/${STAMP}-ppl-ncmoe-memory.csv" \
    --output "${OUT}/${STAMP}-ppl-ncmoe.out" \
    -- third_party/llama.cpp/build/bin/llama-perplexity \
        --model "${MODEL}" --file "${PPLTEXT}" \
        --ctx-size 512 --chunks 1 \
        --n-gpu-layers 12 --n-cpu-moe 78 --no-repack \
        --batch-size 512 --ubatch-size 512 --seed 42 --log-colors off
echo "  perplexite -ncmoe : statut garde = $?"
echo ""
echo "=== VERDICT B ==="
printf "cablage : "; grep -aoE "PPL = [0-9.]+|Final estimate: PPL = [0-9.]+[^,]*" "${OUT}/${STAMP}-ppl-h4.out" | tail -1
printf "ncmoe   : "; grep -aoE "PPL = [0-9.]+|Final estimate: PPL = [0-9.]+[^,]*" "${OUT}/${STAMP}-ppl-ncmoe.out" | tail -1
} 2>&1 | tee "${OUT}/${STAMP}-juge-de-paix.log"
echo ""
read -r -p "Entree pour fermer"
