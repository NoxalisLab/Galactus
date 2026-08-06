#!/bin/bash
# La reference de perplexite -ncmoe seule (la partie tuee du juge de paix).
# Exception assumee et bornee : la voie mmap fait thrasher le cache de pages
# par construction — tolerance de swap portee a 1 Gio POUR CETTE MESURE, tout
# le reste des gardes inchange. Le cablage a deja rendu PPL = 8.8940.
set -u
export LC_ALL=C
export LANG=C
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[ -f "${ROOT}/galactus.env" ] && . "${ROOT}/galactus.env"
cd "${ROOT}" || exit 1
OUT="${ROOT}/artifacts/h4/integration"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
MODEL="${GALACTUS_MODEL:-${ROOT}/models/glm-5.2-ud-iq1-s/UD-IQ1_S/GLM-5.2-UD-IQ1_S-00001-of-00006.gguf}"
PPLTEXT="${ROOT}/corpus/materialized/stage1/coding-repobench-p-e-0048.txt"
unset GALACTUS_H4
export GALACTUS_GUARD_MAX_SWAP_DELTA_BYTES=1073741824
export GALACTUS_GUARD_MAX_OUTPUT_BYTES=268435456
export GALACTUS_GUARD_MIN_VOLUME_FREE_MB=10240
{
echo "=== reference ppl -ncmoe — ${STAMP} (tolerance swap 1 Gio, assumee) ==="
/usr/bin/memory_pressure -Q | grep -i "free percentage"; /usr/sbin/sysctl -n vm.swapusage
scripts/run-benchmark-guarded-mmap.sh \
    --min-free-percent 2 --max-footprint-gib 118 \
    --max-preexisting-swap-mb 8192 --swap-policy capture \
    --free-percent-policy telemetry --poll-seconds 0.25 --max-wall-seconds 3600 \
    --log "${OUT}/${STAMP}-ppl-ncmoe-memory.csv" \
    --output "${OUT}/${STAMP}-ppl-ncmoe.out" \
    -- third_party/llama.cpp/build/bin/llama-perplexity \
        --model "${MODEL}" --file "${PPLTEXT}" \
        --ctx-size 512 --chunks 1 \
        --n-gpu-layers 12 --n-cpu-moe 78 --no-repack \
        --batch-size 512 --ubatch-size 512 --seed 42 --log-colors off
echo "--- statut garde = $? ---"
echo ""
echo "=== VERDICT B (complet) ==="
echo "cablage : PPL = 8.8940 +/- 1.65257   (mesure 20260803T092657Z)"
printf "ncmoe   : "; grep -aoE "Final estimate: PPL = [0-9.]+ \+/- [0-9.]+" "${OUT}/${STAMP}-ppl-ncmoe.out" | tail -1
} 2>&1 | tee "${OUT}/${STAMP}-reference-ppl.log"
echo ""
read -r -p "Entree pour fermer"
