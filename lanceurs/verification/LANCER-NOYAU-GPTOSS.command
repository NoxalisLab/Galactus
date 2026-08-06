#!/bin/bash
# Test de noyau natif ARM : le stride d'enregistrement de l'arene change-t-il
# le resultat du mul_mat_id MXFP4 du fork, a octets identiques ?
set -u
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${ROOT}" || exit 1
PACK="${ROOT}/artifacts/h4/packs/gpt-oss-120b/gpt-oss-120b.pack"
TMP="${ROOT}/artifacts/h4/integration"
LL="${ROOT}/third_party/llama.cpp"
echo "extraction des enregistrements 82 et 83 (couche 0) du pack..."
dd if="${PACK}" of="${TMP}/noyau-rec82.bin" bs=13221888 skip=82 count=1 2>/dev/null
dd if="${PACK}" of="${TMP}/noyau-rec83.bin" bs=13221888 skip=83 count=1 2>/dev/null
ls -l "${TMP}/noyau-rec82.bin" "${TMP}/noyau-rec83.bin"
echo "compilation contre la libggml du fork..."
clang++ -std=c++20 -O2 \
    -I"${LL}/ggml/include" \
    -o "${TMP}/kernel-noyau" "${ROOT}/scripts/kernel-noyau.cpp" \
    -L"${LL}/build/bin" -lggml -lggml-base -lggml-cpu \
    -Wl,-rpath,"${LL}/build/bin" || exit 1
echo ""
"${TMP}/kernel-noyau" "${TMP}/noyau-rec82.bin" "${TMP}/noyau-rec83.bin"
echo ""
read -r -p "Entree pour fermer"
