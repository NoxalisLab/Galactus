#!/bin/bash
# Applique le cablage Galactus H4 sur un clone amont de llama.cpp.
#   ./patches/appliquer.sh <chemin-du-clone-llama.cpp>
# Le clone doit etre au commit epingle dans UPSTREAM-COMMIT.txt.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
CIBLE="${1:?usage: appliquer.sh <clone-llama.cpp>}"
cd "${CIBLE}"
ATTENDU="$(cat "${HERE}/UPSTREAM-COMMIT.txt")"
ACTUEL="$(git rev-parse --short=8 HEAD)"
if [ "${ACTUEL}" != "${ATTENDU}" ]; then
  echo "attention: HEAD=${ACTUEL}, patch produit sur ${ATTENDU}" >&2
fi
git apply --check "${HERE}/galactus-h4-llamacpp.diff"
git apply "${HERE}/galactus-h4-llamacpp.diff"
echo "cablage applique. Construire ensuite avec cmake (voir README)."
