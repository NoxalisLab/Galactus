#!/bin/bash
# Embarque le moteur Galactus (llama-server + dylibs + OpenSSL) dans le bundle
# de l'app, entierement relocalise : aucun Homebrew ni checkout requis chez
# l'utilisateur. A lancer avant `npm run tauri build`
# (lanceurs/app/LANCER-UI-BUILD.command le fait).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SRC="$ROOT/third_party/llama.cpp/build/bin"
DEST="$HERE/engine"

[ -x "$SRC/llama-server" ] || { echo "llama-server introuvable dans $SRC (construis le moteur d'abord)"; exit 1; }

rm -rf "$DEST"
mkdir -p "$DEST"

# Le binaire + chaque soname reference en @rpath (copie en dereferencant les
# liens symboliques, sous le nom exact attendu par le linker).
cp "$SRC/llama-server" "$DEST/"
DYLIBS=(
  libllama-server-impl.dylib
  libllama-common.0.dylib
  libmtmd.0.dylib
  libllama.0.dylib
  libggml.0.dylib
  libggml-cpu.0.dylib
  libggml-blas.0.dylib
  libggml-metal.0.dylib
  libggml-base.0.dylib
)
for d in "${DYLIBS[@]}"; do
  cp -L "$SRC/$d" "$DEST/$d"
done

# OpenSSL de Homebrew : reference en chemin absolu -> il faut l'embarquer.
SSL_DIR="$(brew --prefix openssl@3 2>/dev/null)/lib"
cp -L "$SSL_DIR/libssl.3.dylib" "$DEST/"
cp -L "$SSL_DIR/libcrypto.3.dylib" "$DEST/"

SSL_ABS="$(otool -L "$DEST/llama-server" | awk '/libssl.3.dylib/ {print $1}' | head -1)"
CRYPTO_ABS="$(otool -L "$DEST/llama-server" | awk '/libcrypto.3.dylib/ {print $1}' | head -1)"

fix_ssl_refs() {
  local f="$1"
  [ -n "$SSL_ABS" ] && install_name_tool -change "$SSL_ABS" @rpath/libssl.3.dylib "$f" 2>/dev/null || true
  [ -n "$CRYPTO_ABS" ] && install_name_tool -change "$CRYPTO_ABS" @rpath/libcrypto.3.dylib "$f" 2>/dev/null || true
  # Les copies OpenSSL elles-memes referencent libcrypto en absolu.
  local own_crypto
  own_crypto="$(otool -L "$f" | awk '/\/libcrypto.3.dylib/ && $1 !~ /@rpath/ {print $1}' | head -1)"
  [ -n "$own_crypto" ] && install_name_tool -change "$own_crypto" @rpath/libcrypto.3.dylib "$f" 2>/dev/null || true
}

chmod +w "$DEST"/*
for f in "$DEST"/*; do
  fix_ssl_refs "$f"
  case "$f" in
    *.dylib) install_name_tool -id "@rpath/$(basename "$f")" "$f" 2>/dev/null || true ;;
  esac
done

# rpath du binaire : uniquement le dossier du binaire (l'ancien rpath pointe
# vers le dossier de build du developpeur).
OLD_RPATH="$(otool -l "$DEST/llama-server" | awk '/LC_RPATH/{getline;getline; sub(/^ *path /,""); sub(/ \(offset.*/,""); print; exit}')"
[ -n "$OLD_RPATH" ] && install_name_tool -delete_rpath "$OLD_RPATH" "$DEST/llama-server" 2>/dev/null || true
install_name_tool -add_rpath "@executable_path" "$DEST/llama-server"

# Toute modification invalide la signature : re-signer (ad hoc).
for f in "$DEST"/*; do codesign -f -s - "$f" >/dev/null 2>&1; done

# Verification : le binaire relocalise doit demarrer hors du dossier de build.
"$DEST/llama-server" --version >/dev/null 2>&1 || { echo "ECHEC: le llama-server embarque ne demarre pas"; exit 1; }
echo "Moteur embarque dans $DEST ($(du -sh "$DEST" | cut -f1))"

# Scripts + registre embarques (racine auto-provisionnee sans checkout).
mkdir -p "$HERE/packaged/scripts"
for f in models-registry.json image-models.json moe-profile.py galactus-pack-plan.py galactus-pack-write.py galactus_pylang.py; do
  cp "$ROOT/scripts/$f" "$HERE/packaged/scripts/$f"
done
echo "Scripts embarques dans $HERE/packaged/scripts"

# Les licences voyagent avec la copie redistribuee. MIT (llama.cpp,
# stable-diffusion.cpp, CodeMirror, Lezer) exige que son texte accompagne le
# binaire, et Apache-2.0 que le NOTICE suive l oeuvre : un DMG telecharge par
# un tiers n en contenait aucun. Copies ici plutot que listes dans
# tauri.conf.json, qui enterre un chemin relatif sous Resources/_up_/_up_/.
cp "$ROOT/LICENSE" "$HERE/packaged/LICENSE"
cp "$ROOT/NOTICE" "$HERE/packaged/NOTICE"
echo "Licences embarquees"

# Skills livrees avec l'app (semees dans Application Support au premier lancement).
if [ -d "$ROOT/app/skills" ]; then
  rm -rf "$HERE/packaged/skills"
  cp -R "$ROOT/app/skills" "$HERE/packaged/skills"
  echo "Skills embarquees : $(ls "$HERE/packaged/skills" | tr '\n' ' ')"
fi

# Outillage Rust embarque : rust-analyzer + sources de la stdlib. Sans les
# sources, le serveur ne resout pas `std::` et signale des erreurs partout ;
# la chaine de compilation complete (1,2 Go) n'est pas necessaire pour
# l'analyse. Script separe car il telecharge et verifie des empreintes.
"$ROOT/scripts/fetch-rust-tooling.sh" "$HERE/rust-tooling"

# Coffre Obsidian livre avec l'app (seme au premier lancement, jamais ecrase).
if [ -d "$ROOT/vault" ]; then
  rm -rf "$HERE/packaged/vault"
  cp -R "$ROOT/vault" "$HERE/packaged/vault"
  echo "Coffre embarque : $(find "$HERE/packaged/vault" -name '*.md' | wc -l | tr -d ' ') notes"
fi

# Runtime Python isole (sandbox locale) : CPython autonome embarque dans le
# bundle. Sur un macOS vierge, /usr/bin/python3 n'existe pas sans les Command
# Line Tools ; l'app doit fonctionner sans rien installer.
PY_URL="https://github.com/astral-sh/python-build-standalone/releases/download/20250723/cpython-3.12.11+20250723-aarch64-apple-darwin-install_only_stripped.tar.gz"
PY_SHA="ba814d8d611898aee3c6daed53a535a93345a6b4984ebe62f9aa38646255a5bf"
PY_CACHE="$ROOT/.tmp-python-cache/py.tar.gz"
if [ ! -d "$HERE/python/bin" ]; then
  mkdir -p "$(dirname "$PY_CACHE")"
  [ -f "$PY_CACHE" ] || curl -sL "$PY_URL" -o "$PY_CACHE"
  echo "$PY_SHA  $PY_CACHE" | shasum -a 256 -c - >/dev/null || { echo "ECHEC: empreinte Python inattendue"; exit 1; }
  rm -rf "$HERE/python" "$HERE/.py-unpack"
  mkdir -p "$HERE/.py-unpack"
  tar -xzf "$PY_CACHE" -C "$HERE/.py-unpack"
  mv "$HERE/.py-unpack/python" "$HERE/python"
  rm -rf "$HERE/.py-unpack"
  # Allegement : modules inutiles au pipeline (stdlib pure suffit).
  PYLIB="$HERE/python/lib/python3.12"
  rm -rf "$PYLIB/test" "$PYLIB/idlelib" "$PYLIB/tkinter" "$PYLIB/turtledemo" \
         "$PYLIB/ensurepip" "$PYLIB/pydoc_data" 2>/dev/null || true
fi
"$HERE/python/bin/python3" -I -c "import json,hashlib,struct,zipfile;print('ok')" >/dev/null || { echo "ECHEC: python embarque ne demarre pas"; exit 1; }
echo "Python embarque : $("$HERE/python/bin/python3" -V) ($(du -sh "$HERE/python" | cut -f1))"

# Helper documents precompile : sur un Mac sans swiftc (pas de CLT), la
# compilation a la volee est impossible — on livre le binaire.
if command -v swiftc >/dev/null 2>&1; then
  swiftc -O -o "$HERE/packaged/galactus-doc" "$HERE/helpers/galactus-doc.swift"
  codesign -f -s - "$HERE/packaged/galactus-doc" >/dev/null 2>&1 || true
  echo "Helper documents precompile"
  swiftc -O -o "$HERE/packaged/galactus-voice" "$HERE/helpers/galactus-voice.swift"
  codesign -f -s - "$HERE/packaged/galactus-voice" >/dev/null 2>&1 || true
  echo "Helper voix precompile"
  # Le selecteur de dossier. Sans ce binaire, swift_helper se rabat sur swiftc
  # (absent d'un Mac vierge) puis sur osascript, qui repond "annule par
  # l'utilisateur" depuis une app durcie : l'utilisateur ne peut plus choisir
  # son dossier Galactus et rien ne lui dit pourquoi. Il etait dans le bundle
  # par un artefact reste d'un ancien build, pas par ce script.
  swiftc -O -o "$HERE/packaged/galactus-pick" "$HERE/helpers/galactus-pick.swift"
  codesign -f -s - "$HERE/packaged/galactus-pick" >/dev/null 2>&1 || true
  echo "Helper selecteur de dossier precompile"
else
  echo "ECHEC: swiftc absent, les helpers ne peuvent pas etre precompiles." >&2
  echo "  Un build livre sans eux perd le selecteur de dossier, la lecture de" >&2
  echo "  documents et la dictee sur toute machine sans Command Line Tools." >&2
  echo "  Installe-les : xcode-select --install" >&2
  exit 1
fi

# ---------------------------------------------------------------- moteur image
# sd-cli (stable-diffusion.cpp) : un binaire statique, Metal compris, qui n'est
# lance que le temps d'une image. Absent du checkout -> l'app le dit et la vue
# Images reste fermee, plutot que d'echouer au lancement pour une fonction que
# tout le monde n'utilise pas.
SD_SRC="$ROOT/third_party/stable-diffusion.cpp/build/bin/sd-cli"
SD_DEST="$HERE/image-engine"
rm -rf "$SD_DEST"
if [ -x "$SD_SRC" ]; then
  mkdir -p "$SD_DEST"
  cp "$SD_SRC" "$SD_DEST/sd-cli"
  # Sans les symboles de debug : 57 Mo deviennent 53, et rien dans l'app ne les
  # lit jamais.
  strip -S -x "$SD_DEST/sd-cli" 2>/dev/null || true
  chmod 755 "$SD_DEST/sd-cli"
  codesign -f -s - "$SD_DEST/sd-cli" >/dev/null 2>&1 || true
  echo "Moteur image embarque ($(du -sh "$SD_DEST" | cut -f1))"
elif [ "${GALACTUS_ALLOW_NO_IMAGE_ENGINE:-0}" = "1" ]; then
  echo "AVERTISSEMENT: sd-cli absent, generation d'images indisponible (opt-out explicite)"
else
  echo "ECHEC: sd-cli absent, la generation d'images serait livree morte." >&2
  echo "  construis-le : cd third_party/stable-diffusion.cpp && \\" >&2
  echo "    cmake -B build -DCMAKE_BUILD_TYPE=Release -DSD_METAL=ON -DSD_WEBP=OFF -DSD_WEBM=OFF && \\" >&2
  echo "    cmake --build build -j" >&2
  echo "  ou, pour un build volontairement sans images : GALACTUS_ALLOW_NO_IMAGE_ENGINE=1" >&2
  exit 1
fi
