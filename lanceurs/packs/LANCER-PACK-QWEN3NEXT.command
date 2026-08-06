#!/bin/bash
# Ecrit le pack Qwen3-Next-80B (46,9 Go, mono-volume) : d'abord la fixture
# (3 enregistrements verifies octet a octet contre le GGUF), puis le complet.
# La confirmation est derivee du hash du plan.
set -u
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PLAN="${ROOT}/models/qwen3-next-80b/plan.json"
SHA=$(shasum -a 256 "${PLAN}" | cut -d' ' -f1)
DEST="${ROOT}/artifacts/h4/packs/qwen3-next-80b"
mkdir -p "${DEST}"
echo "=== fixture qwen3-30b (3 enregistrements temoins) ==="
python3 "${ROOT}/scripts/galactus-pack-write.py" \
  --plan "${PLAN}" --expected-plan-sha256 "${SHA}" \
  --model-directory "${ROOT}/models/qwen3-next-80b" \
  --mode fixture \
  --internal-output "${DEST}/fixture.pack" \
  --manifest "${DEST}/fixture-manifest.json" \
  --minimum-free-after-gib 100 \
  --confirm "WRITE-${SHA:0:12}" || exit 1
echo ""
echo "=== pack complet qwen3-30b -> ${DEST} (46,9 Go) ==="
python3 "${ROOT}/scripts/galactus-pack-write.py" \
  --plan "${PLAN}" --expected-plan-sha256 "${SHA}" \
  --model-directory "${ROOT}/models/qwen3-next-80b" \
  --mode full \
  --internal-output "${DEST}/qwen3-next-80b.pack" \
  --manifest "${DEST}/manifest.json" \
  --minimum-free-after-gib 100 \
  --confirm "WRITE-${SHA:0:12}"
echo ""
read -r -p "Entree pour fermer"
