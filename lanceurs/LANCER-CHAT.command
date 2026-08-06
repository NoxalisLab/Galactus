#!/bin/bash
# CHAT LIVE : GLM-5.2 integral, cablage H4, session interactive.
#   ./lanceurs/LANCER-CHAT.command                        experts Metal (rapide, ~5,9 tok/s,
#                                                derive qualite mesuree : A -0,2% B +1,3% C +1,8% par couche)
#   GALACTUS_CPU_MOE=1 ./lanceurs/LANCER-CHAT.command     experts CPU (bit-transparent, plus lent — a mesurer)
#   GALACTUS_CACHE_BYTES=... pour changer la taille du cache (defaut 92 Go).
# Quitter : /exit ou Ctrl+C.
set -u
export LC_ALL=C
export LANG=C
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "${ROOT}/galactus.env" ] && . "${ROOT}/galactus.env"
cd "${ROOT}" || exit 1
MODEL="${GALACTUS_MODEL:-${ROOT}/models/glm-5.2-ud-iq1-s/UD-IQ1_S/GLM-5.2-UD-IQ1_S-00001-of-00006.gguf}"
INTERNAL="${GALACTUS_INTERNAL_PACK:?definir GALACTUS_INTERNAL_PACK (voir galactus.env.example)}"
EXTERNAL="${GALACTUS_EXTERNAL_PACK:?definir GALACTUS_EXTERNAL_PACK (voir galactus.env.example)}"
export GALACTUS_H4=1
export GALACTUS_H4_INTERNAL="${INTERNAL}"
export GALACTUS_H4_EXTERNAL="${EXTERNAL}"
export GALACTUS_H4_CACHE_BYTES="${GALACTUS_CACHE_BYTES:-92000000000}"
export GALACTUS_H4_QD=32
if [ "${GALACTUS_CPU_MOE:-0}" = "1" ]; then export GALACTUS_H4_CPU_MOE=1; fi
cd third_party/llama.cpp && cmake --build build --target llama-cli -j 2>&1 | grep -E "error|Built target" | tail -2
cd "${ROOT}"
echo ""
echo "=== chat GLM-5.2 — experts $( [ "${GALACTUS_CPU_MOE:-0}" = "1" ] && echo CPU || echo Metal ), cache $(( ${GALACTUS_H4_CACHE_BYTES} / 1000000000 )) Go ==="
echo "(premiers tokens lents : cache froid ; le regime chaud s'installe en ~1 min)"
echo ""
third_party/llama.cpp/build/bin/llama-cli \
    --model "${MODEL}" \
    --ctx-size 4096 \
    --n-gpu-layers 99 --no-repack --fit off --no-mmap \
    --batch-size 2 --ubatch-size 2 \
    --temp 0.7 --show-timings --log-colors off \
    $( [ "${GALACTUS_NOTHINK:-0}" = "1" ] && echo "--chat-template-kwargs {\"enable_thinking\":false}" )
