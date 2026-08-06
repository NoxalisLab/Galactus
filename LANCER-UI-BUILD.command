#!/bin/bash
# Construit le .app / .dmg Galactus distribuable.
set -u
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "${ROOT}/app" || exit 1
# Node fonctionnel ? (un Homebrew casse abort avec "libllhttp...dylib" manquante)
if ! node --version >/dev/null 2>&1; then
  echo ""
  echo "Node ne demarre pas sur cette machine."
  echo "Cause probable : Homebrew a mis a jour llhttp sans reconstruire Node."
  echo "Correctif (une ligne, ~1 min) :"
  echo "    brew reinstall node"
  echo "  (ou : brew reinstall llhttp node)"
  echo "Puis relance ce script."
  echo ""
  read -r -p "Entree pour fermer"
  exit 1
fi

command -v cargo >/dev/null 2>&1 || { echo "Rust manquant (https://rustup.rs)"; read -r -p "Entree"; exit 1; }
[ -d node_modules ] || npm install --no-audit --no-fund
# Embarque le moteur (llama-server relocalise) et les scripts dans le bundle.
bash src-tauri/prepare-engine.sh || { echo "Echec de l'embarquement du moteur"; read -r -p "Entree"; exit 1; }
npm run tauri build
echo ""
echo "Artefacts dans app/src-tauri/target/release/bundle/"
read -r -p "Entree pour fermer"
