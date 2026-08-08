#!/bin/bash
# Approvisionne l'outillage Rust embarque dans l'app : rust-analyzer et les
# sources de la bibliotheque standard.
#
# Meme motif que le runtime CPython de prepare-engine.sh : telechargement a la
# CONSTRUCTION, empreinte epinglee, rien dans le depot. Un binaire de 36 Mo
# versionne polluerait l'historique a chaque mise a jour, et une archive non
# verifiee ferait dependre le contenu de l'app de ce qu'un serveur renvoie ce
# jour-la.
#
# Pourquoi les deux et pas seulement le serveur : rust-analyzer sans sysroot
# resout la navigation a l'interieur du projet mais pas `std::`, et signale
# alors des erreurs partout. Les sources suffisent, la chaine de compilation
# complete (1,2 Go) n'est pas necessaire pour l'analyse.
#
# Usage : scripts/fetch-rust-tooling.sh [dossier-destination]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DEST="${1:-$ROOT/app/src-tauri/rust-tooling}"
CACHE="$ROOT/.tmp-rust-cache"

# Versions epinglees. Les mettre a jour ensemble : rust-analyzer lit les
# sources, une derive majeure entre les deux se voit en diagnostics faux.
RA_TAG="2026-08-03"
RA_URL="https://github.com/rust-lang/rust-analyzer/releases/download/${RA_TAG}/rust-analyzer-aarch64-apple-darwin.gz"
RA_SHA="bba6cd8209643cd781f3ee5474fa232d3ee1b77a57f2e77982806e3c80a65207"

SRC_VER="1.97.1"
SRC_URL="https://static.rust-lang.org/dist/rust-src-${SRC_VER}.tar.xz"
SRC_SHA="e9a1e616d04c6845895c827a178b9227f7c7199f3f4a80af81ab3aff7b80156b"

mkdir -p "$CACHE" "$DEST"

verify() {
  local file="$1" want="$2" label="$3"
  local got
  got="$(shasum -a 256 "$file" | cut -d' ' -f1)"
  if [ -z "$want" ]; then
    echo "ATTENTION: empreinte $label non epinglee, observee = $got" >&2
    return 0
  fi
  [ "$got" = "$want" ] || { echo "ECHEC: empreinte $label inattendue ($got)" >&2; exit 1; }
}

# ---------------------------------------------------------------- serveur
if [ ! -x "$DEST/rust-analyzer" ]; then
  echo "telechargement rust-analyzer ${RA_TAG}"
  curl -sL "$RA_URL" -o "$CACHE/ra.gz"
  verify "$CACHE/ra.gz" "$RA_SHA" "rust-analyzer"
  gunzip -c "$CACHE/ra.gz" > "$DEST/rust-analyzer"
  chmod +x "$DEST/rust-analyzer"
  # Un binaire telecharge n'a pas de signature valide pour ce Mac : sans
  # signature ad hoc, Gatekeeper refuse de le lancer depuis le bundle.
  codesign -f -s - "$DEST/rust-analyzer" >/dev/null 2>&1 || true
fi
"$DEST/rust-analyzer" --version >/dev/null || { echo "ECHEC: rust-analyzer embarque ne demarre pas" >&2; exit 1; }

# ------------------------------------------------- sources de la stdlib
# Seul library/ sert a l'analyse : le reste de l'archive (compilateur, tests,
# outils) represente l'essentiel du poids et n'est jamais lu par le serveur.
if [ ! -d "$DEST/rust-src/library/std" ]; then
  echo "telechargement rust-src ${SRC_VER}"
  curl -sL "$SRC_URL" -o "$CACHE/rust-src.tar.xz"
  verify "$CACHE/rust-src.tar.xz" "$SRC_SHA" "rust-src"
  rm -rf "$CACHE/unpack" "$DEST/rust-src"
  mkdir -p "$CACHE/unpack" "$DEST/rust-src"
  tar -xJf "$CACHE/rust-src.tar.xz" -C "$CACHE/unpack"
  LIB="$(find "$CACHE/unpack" -type d -path "*/lib/rustlib/src/rust/library" | head -1)"
  [ -n "$LIB" ] || { echo "ECHEC: library/ introuvable dans l'archive rust-src" >&2; exit 1; }
  cp -R "$LIB" "$DEST/rust-src/library"
  # Tests et bancs ne sont jamais analyses et pesent pour rien.
  find "$DEST/rust-src/library" -type d \( -name tests -o -name benches \) -prune -exec rm -rf {} + 2>/dev/null || true
  rm -rf "$CACHE/unpack"
fi
[ -f "$DEST/rust-src/library/std/src/lib.rs" ] || { echo "ECHEC: sources std incompletes" >&2; exit 1; }

# Licences : Apache-2.0 et MIT des deux cotes, a livrer avec le binaire.
cat > "$DEST/LICENSE-NOTICE.txt" <<EOF
rust-analyzer ${RA_TAG} and the Rust standard library sources ${SRC_VER} are
bundled with Galactus unmodified.

rust-analyzer: Copyright rust-analyzer contributors, dual licensed under
Apache License 2.0 and MIT.  https://github.com/rust-lang/rust-analyzer

Rust standard library sources: Copyright The Rust Project Developers, dual
licensed under Apache License 2.0 and MIT.  https://github.com/rust-lang/rust
EOF

echo "outillage Rust pret dans $DEST ($(du -sh "$DEST" | cut -f1))"
