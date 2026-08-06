#!/bin/bash
# Ecrit le pack GLM-4.5-Air (66 Go, mono-volume) : d'abord la fixture
# (3 enregistrements verifies octet a octet contre le GGUF), puis le complet.
# La confirmation est derivee du hash du plan.
set -u
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")" && pwd)"
PLAN="${ROOT}/models/glm-4.5-air/plan.json"
SHA=$(shasum -a 256 "${PLAN}" | cut -d' ' -f1)
DEST="${ROOT}/artifacts/h4/packs/glm-4.5-air"
mkdir -p "${DEST}"
echo "=== fixture qwen3-30b (3 enregistrements temoins) ==="
python3 "${ROOT}/scripts/galactus-pack-write.py" \
  --plan "${PLAN}" --expected-plan-sha256 "${SHA}" \
  --model-directory "${ROOT}/models/glm-4.5-air" \
  --mode fixture \
  --internal-output "${DEST}/fixture.pack" \
  --manifest "${DEST}/fixture-manifest.json" \
  --minimum-free-after-gib 100 \
  --confirm "WRITE-${SHA:0:12}" || exit 1
echo ""
echo "=== pack complet qwen3-30b -> ${DEST} (66 Go) ==="
python3 "${ROOT}/scripts/galactus-pack-write.py" \
  --plan "${PLAN}" --expected-plan-sha256 "${SHA}" \
  --model-directory "${ROOT}/models/glm-4.5-air" \
  --mode full \
  --internal-output "${DEST}/glm-4.5-air.pack" \
  --manifest "${DEST}/manifest.json" \
  --minimum-free-after-gib 100 \
  --confirm "WRITE-${SHA:0:12}"
echo ""
read -r -p "Entree pour fermer"
