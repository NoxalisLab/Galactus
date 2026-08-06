#!/bin/bash
# Ecrit le pack Llama-4 Scout (58,5 Go, mono-volume) : d'abord la fixture
# (3 enregistrements verifies octet a octet contre le GGUF), puis le complet.
# La confirmation est derivee du hash du plan.
set -u
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PLAN="${ROOT}/models/llama4-scout/plan.json"
SHA=$(shasum -a 256 "${PLAN}" | cut -d' ' -f1)
DEST="${ROOT}/artifacts/h4/packs/llama4-scout"
mkdir -p "${DEST}"
echo "=== fixture llama4-scout (3 enregistrements temoins) ==="
python3 "${ROOT}/scripts/galactus-pack-write.py" \
  --plan "${PLAN}" --expected-plan-sha256 "${SHA}" \
  --model-directory "${ROOT}/models/llama4-scout" \
  --mode fixture \
  --internal-output "${DEST}/fixture.pack" \
  --manifest "${DEST}/fixture-manifest.json" \
  --minimum-free-after-gib 40 \
  --confirm "WRITE-${SHA:0:12}" || exit 1
echo ""
echo "=== pack complet llama4-scout -> ${DEST} (58,5 Go) ==="
python3 "${ROOT}/scripts/galactus-pack-write.py" \
  --plan "${PLAN}" --expected-plan-sha256 "${SHA}" \
  --model-directory "${ROOT}/models/llama4-scout" \
  --mode full \
  --internal-output "${DEST}/llama4-scout.pack" \
  --manifest "${DEST}/manifest.json" \
  --minimum-free-after-gib 40 \
  --confirm "WRITE-${SHA:0:12}"
echo ""
read -r -p "Entree pour fermer"
