#!/bin/bash
# Embarque le moteur Galactus (llama-server + dylibs + OpenSSL) dans le bundle
# de l'app, entierement relocalise : aucun Homebrew ni checkout requis chez
# l'utilisateur. A lancer avant `npm run tauri build` (LANCER-UI-BUILD le fait).
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
for f in models-registry.json moe-profile.py galactus-pack-plan.py galactus-pack-write.py; do
  cp "$ROOT/scripts/$f" "$HERE/packaged/scripts/$f"
done
echo "Scripts embarques dans $HERE/packaged/scripts"
