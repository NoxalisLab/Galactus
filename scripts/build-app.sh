#!/bin/bash
# Construit l'app de bout en bout, dans le bon ordre et avec la bonne signature.
#
# Trois choses que `npm run tauri build` seul ne fait pas, et qui ont chacune
# deja coute une livraison :
#
#  1. prepare-engine.sh n'est PAS declenche par le build Tauri. Un build lance
#     sans lui a deja livre un bundle avec zero note de coffre et sept skills
#     au lieu de dix, sans le moindre avertissement.
#  2. Sans identite de signature, l'app est signee ad hoc : son exigence
#     designee est le cdhash de son binaire, qui change a chaque compilation.
#     macOS voit alors une application differente et redemande toutes les
#     autorisations. Avec l'identite locale, elles sont accordees une fois.
#  3. Un volume dmg reste monte apres un build interrompu et fait echouer
#     silencieusement l'empaquetage suivant.
#
# Usage : scripts/build-app.sh [--no-dmg]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
CN="${GALACTUS_SIGN_CN:-Galactus Local Signing}"

# ---------------------------------------------------------------- signature
if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$CN"; then
  export APPLE_SIGNING_IDENTITY="$CN"
  echo "signature : $CN (identite stable, autorisations conservees)"
else
  echo "signature : ad hoc (lance scripts/make-signing-identity.sh pour la rendre stable)"
fi

# ------------------------------------------------------- volumes residuels
for d in $(hdiutil info 2>/dev/null | grep -oE '/dev/disk[0-9]+' | sort -u); do
  if hdiutil info 2>/dev/null | grep -A5 "$d" | grep -qi galactus; then
    echo "demontage du volume residuel $d"
    hdiutil detach "$d" -force >/dev/null 2>&1 || true
  fi
done
rm -f "$ROOT/app/src-tauri/target/release/bundle/macos/rw."*.dmg 2>/dev/null || true
rm -f "$ROOT/app/src-tauri/target/release/bundle/dmg/rw."*.dmg 2>/dev/null || true

# ------------------------------------------------------------------ contenu
"$ROOT/app/src-tauri/prepare-engine.sh"

# -------------------------------------------------------------------- build
cd "$ROOT/app"
npm run tauri build

# ------------------------------------------------------------ verification
APP="$ROOT/app/src-tauri/target/release/bundle/macos/Galactus.app"
[ -d "$APP" ] || { echo "ECHEC: pas de bundle produit" >&2; exit 1; }
echo
echo "verification du bundle"
echo "  version : $(defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString)"
echo "  skills  : $(ls "$APP/Contents/Resources/packaged/skills" | wc -l | tr -d ' ')"
echo "  notes   : $(find "$APP/Contents/Resources/packaged/vault" -name '*.md' | wc -l | tr -d ' ')"
echo "  moteur  : $(strings "$APP/Contents/Resources/engine/libllama.0.dylib" | grep -c 'galactus_h4:') marqueurs H4"
codesign --verify --strict "$APP" && echo "  signature valide"
codesign -d -r- "$APP" 2>&1 | grep designated | sed 's/^/  /'
