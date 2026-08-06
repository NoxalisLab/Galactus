#!/bin/bash
# Ecrit le pack complet gpt-oss-120b (59,2 Go, mono-volume, Lexar).
# La confirmation est derivee du hash du plan : impossible de packer le
# mauvais plan par accident.
set -u
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PLAN="${ROOT}/models/gpt-oss-120b/plan.json"
SHA=$(shasum -a 256 "${PLAN}" | cut -d' ' -f1)
DEST="${ROOT}/artifacts/h4/packs/gpt-oss-120b"
mkdir -p "${DEST}"
echo "=== pack gpt-oss-120b -> ${DEST} (59,2 Go) ==="
python3 "${ROOT}/scripts/galactus-pack-write.py" \
  --plan "${PLAN}" --expected-plan-sha256 "${SHA}" \
  --model-directory "${ROOT}/models/gpt-oss-120b" \
  --mode full \
  --internal-output "${DEST}/gpt-oss-120b.pack" \
  --manifest "${DEST}/manifest.json" \
  --minimum-free-after-gib 40 \
  --confirm "WRITE-${SHA:0:12}"
echo ""
read -r -p "Entree pour fermer"
