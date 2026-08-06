#!/bin/bash
# Reproducteur brutal ARM : des milliers de motifs d'ids sur le mul_mat_id
# MXFP4, stock (ne02=128) contre arene (ne02=50, stride 13 221 888).
set -u
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${ROOT}" || exit 1
TMP="${ROOT}/artifacts/h4/integration"
LL="${ROOT}/third_party/llama.cpp"
if [ ! -f "${TMP}/noyau-rec82.bin" ]; then
  PACK="${ROOT}/artifacts/h4/packs/gpt-oss-120b/gpt-oss-120b.pack"
  dd if="${PACK}" of="${TMP}/noyau-rec82.bin" bs=13221888 skip=82 count=1 2>/dev/null
  dd if="${PACK}" of="${TMP}/noyau-rec83.bin" bs=13221888 skip=83 count=1 2>/dev/null
fi
clang++ -std=c++20 -O2 \
    -I"${LL}/ggml/include" \
    -o "${TMP}/kernel-noyau2" "${ROOT}/scripts/kernel-noyau2.cpp" \
    -L"${LL}/build/bin" -lggml -lggml-base -lggml-cpu \
    -Wl,-rpath,"${LL}/build/bin" || exit 1
"${TMP}/kernel-noyau2" "${TMP}/noyau-rec82.bin" "${TMP}/noyau-rec83.bin" 2000 8
echo ""
read -r -p "Entree pour fermer"
