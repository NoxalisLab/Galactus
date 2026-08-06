#!/bin/bash
# Lance l'app desktop Galactus en mode developpement (fenetre native + rechargement a chaud).
# Prerequis : Node (npm), Rust (cargo). Au premier lancement, installe les deps npm.
set -u
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "${ROOT}/app" || { echo "dossier app introuvable"; exit 1; }

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

command -v cargo >/dev/null 2>&1 || { echo "Rust manquant. Installe : https://rustup.rs  (curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh)"; read -r -p "Entree"; exit 1; }
command -v npm   >/dev/null 2>&1 || { echo "Node manquant. Installe Node LTS : https://nodejs.org"; read -r -p "Entree"; exit 1; }

# Le serveur Galactus doit etre construit et a jour (sinon l'app reste sur "Demarrage").
echo "Construction de llama-server (moteur Galactus)..."
( cd "${ROOT}/../third_party/llama.cpp" 2>/dev/null || cd "${ROOT}/third_party/llama.cpp"; cmake --build build --target llama-server -j 2>&1 | grep -E "error|Built target" | tail -2 )

[ -d node_modules ] || { echo "Installation des dependances npm..."; npm install --no-audit --no-fund; }
echo "Compilation Rust + lancement (le premier build Rust peut prendre plusieurs minutes)..."
npm run tauri dev
