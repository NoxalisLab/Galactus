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

# --------------------------------------------------- Developer ID hand over
# A Developer ID Application identity in the environment means the caller wants
# a build for other people's machines. That needs a different pipeline: the
# nested binaries have to be signed before Tauri seals the bundle, the
# entitlements have to be attached, and the result has to be notarized and
# stapled. Hand over to the script that does all of it, rather than quietly
# producing a half signed artifact here and calling it a release.
case "${APPLE_SIGNING_IDENTITY:-}" in
  "Developer ID Application:"*)
    echo "Developer ID identity detected, handing over to scripts/macos-release.sh"
    exec "$HERE/macos-release.sh" "$@"
    ;;
esac

# ---------------------------------------------------------------- signature
if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$CN"; then
  export APPLE_SIGNING_IDENTITY="$CN"
  echo "signature : $CN (identite stable, autorisations conservees)"
else
  echo "signature : ad hoc (lance scripts/make-signing-identity.sh pour la rendre stable)"
fi

# ------------------------------------------------------ cle de mise a jour
# tauri.conf.json porte desormais une cle publique de mise a jour et
# bundle.createUpdaterArtifacts=true : le bundler REFUSE de construire s'il
# voit la publique sans la privee. Elle vit hors du depot et n'est lue qu'ici.
# Le bundler veut le CONTENU de la cle, pas un chemin.
UPD_KEY="${GALACTUS_UPDATER_KEY:-$HOME/.galactus/updater/galactus-updater.key}"
if [ ! -f "$UPD_KEY" ]; then
  echo "ECHEC: cle privee de mise a jour absente ($UPD_KEY)" >&2
  echo "  sans elle le bundler refuse de construire. Deux issues :" >&2
  echo "   - restaurer la cle depuis ta sauvegarde" >&2
  echo "   - build local jetable : npm run tauri build -- --no-sign" >&2
  echo "     (--no-sign supprime AUSSI la signature macOS : les autorisations" >&2
  echo "      seront redemandees a chaque lancement)" >&2
  exit 1
fi
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$UPD_KEY")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
echo "mise a jour : archive signee avec $UPD_KEY"

# ------------------------------------------------------ distribution status
# The Tauri bundler prints one grey line about this, "Warn skipping app
# notarization", in the middle of a few hundred lines of cargo output. Nobody
# has ever read it. The decision is stated here instead, before anything is
# built, because it is the difference between an app that opens and an app that
# a stranger is told not to trust.
cat <<'BANNER'

======================================================================
 DISTRIBUTION: LOCAL BUILD. NOT NOTARIZED. NOT FOR RELEASE.
----------------------------------------------------------------------
 This build is deliberately not sent to Apple for notarization. Its
 signature is local: either ad hoc, or a certificate that exists on
 this machine and nowhere else.

 On any other Mac, Gatekeeper refuses the first launch. The user has
 to right click, choose Open, and confirm a dialog telling them the
 developer cannot be verified. That is correct for a development
 build. It disqualifies the artifact for distribution.

 To produce a notarized dmg instead:

     export APPLE_SIGNING_IDENTITY="Developer ID Application: ..."
     export APPLE_KEYCHAIN_PROFILE="<your notarytool profile>"
     scripts/macos-release.sh

 Full instructions, including how to obtain each value:
 docs/RELEASE-SIGNING.md
======================================================================

BANNER

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

# ------------------------------------------------------ distribution verdict
# codesign answers "is this signature intact". Only spctl answers "will this
# open on a Mac that has never seen it", and that is the question that decides
# whether an artifact can be shipped. Ask it, and print the answer, instead of
# assuming it. For a local build the expected answer is "rejected".
echo
echo "distribution verdict"
if codesign --verify --deep --strict "$APP" 2>/dev/null; then
  echo "  nested signatures : all valid"
else
  echo "  nested signatures : BROKEN"
fi
verdict="$(spctl --assess --type execute --verbose=4 "$APP" 2>&1 || true)"
printf '%s\n' "$verdict" | sed 's/^/  gatekeeper: /'
case "$verdict" in
  *"source=Notarized Developer ID"*)
    echo "  ship: yes, this build opens with a double click anywhere"
    ;;
  *)
    echo "  ship: NO. Gatekeeper refuses this build on any machine but this one."
    echo "        Expected for a local build. scripts/macos-release.sh produces"
    echo "        the notarized artifact. See docs/RELEASE-SIGNING.md."
    ;;
esac
