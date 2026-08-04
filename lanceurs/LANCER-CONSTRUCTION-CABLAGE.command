#!/bin/bash
# Construire llama.cpp avec le cablage Galactus H4, puis verifier que le
# binaire NON ACTIVE est resté sain (le cablage entier est garde par
# GALACTUS_H4=1 ; sans elle, comportement identique a l'amont).
set -u
export LC_ALL=C
export LANG=C
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "${ROOT}/galactus.env" ] && . "${ROOT}/galactus.env"
cd "${ROOT}/third_party/llama.cpp" || exit 1
OUT="${ROOT}/artifacts/h4/integration"
mkdir -p "${OUT}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
{
echo "=== construction cablage — ${STAMP} ==="
cmake -S . -B build 2>&1 | tail -2
echo "--- construction (les erreurs eventuelles ci-dessous) ---"
cmake --build build --target llama-cli -j 2>&1 | grep -E "error|Error|warning: unused|Built target|\.cpp\.o" | tail -30
echo "--- statut construction = $? ---"
ls -la build/bin/llama-cli
echo ""
echo "--- verification binaire non active (GALACTUS_H4 absent) ---"
unset GALACTUS_H4
./build/bin/llama-cli --version 2>&1 | tail -3
echo "--- statut version = $? ---"
} 2>&1 | tee "${OUT}/${STAMP}-construction.log"
echo ""
read -r -p "Entree pour fermer"
