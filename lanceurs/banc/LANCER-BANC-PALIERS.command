#!/bin/bash
# BANC DES PALIERS MEMOIRE, pour n'importe quel modele du registre.
#
# Remplace les six lanceurs par modele (QWEN30B, QWEN235B, QWEN3NEXT, GLMAIR,
# GPTOSS, LLAMA4) : chacun portait en dur le chemin du GGUF, celui du pack, la
# taille d'enregistrement, le nombre de couches et la taille de residence
# complete. Ajouter un modele voulait dire copier un fichier et corriger six
# constantes, et c'est exactement pour cela que les trois modeles certifies les
# plus recents n'avaient aucune courbe. Ici tout vient du registre et du disque.
#
# Usage :
#   ./lanceurs/banc/LANCER-BANC-PALIERS.command qwen3-coder-30b
#   ./lanceurs/banc/LANCER-BANC-PALIERS.command          (demande l'identifiant)
#
# Variables :
#   GALACTUS_TOKENS=192   tokens generes par palier
#   GALACTUS_REGISTRE=1   ecrit la courbe dans scripts/models-registry.json
#                         ET dans la copie packagee de l'application
#   GALACTUS_APERCU=1     affiche seulement le plan des paliers, ne mesure rien
set -u
export LC_ALL=C
export LANG=C
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[ -f "${ROOT}/galactus.env" ] && . "${ROOT}/galactus.env"
cd "${ROOT}" || exit 1

MODELE="${1:-}"
if [ -z "${MODELE}" ]; then
  echo "=== banc des paliers memoire ==="
  echo ""
  echo "Modeles du registre :"
  /usr/bin/python3 -c 'import json,sys
for m in json.load(open(sys.argv[1]))["models"]:
    n = len(m.get("measured") or [])
    print("  %-18s %s" % (m["id"], ("%d point%s mesure%s" % (n, "s"[:n>1], "s"[:n>1])) if n else "AUCUNE COURBE"))' \
    "${ROOT}/scripts/models-registry.json"
  echo ""
  read -r -p "Identifiant du modele a mesurer : " MODELE
  [ -z "${MODELE}" ] && { echo "Aucun identifiant, arret."; exit 1; }
fi

# Le banc mesure le moteur cable : il faut qu'il soit a jour, sinon la courbe
# decrit une version du code qui n'existe plus.
cd third_party/llama.cpp && cmake --build build --target llama-cli -j 2>&1 \
  | grep -E "error|Built target" | tail -1
cd "${ROOT}" || exit 1

ARGS=(--model "${MODELE}" --predict "${GALACTUS_TOKENS:-192}")
[ "${GALACTUS_APERCU:-0}" = "1" ] && ARGS+=(--dry-run)
[ "${GALACTUS_REGISTRE:-0}" = "1" ] && ARGS+=(--update-registry)

echo ""
/usr/bin/python3 "${ROOT}/scripts/bench-curve.py" "${ARGS[@]}"
STATUT=$?
echo ""
echo "Notes :"
echo " - chiffres mesures sur CE Mac : une machine de gamme inferieure"
echo "   (SSD ou CPU plus lents) descendra en dessous, a valider sur machine reelle"
echo " - la courbe s'arrete a la residence complete : au-dela le modele tient"
echo "   nativement en RAM et llama.cpp d'origine est plus rapide"
echo " - un palier refuse par le moteur reste vide, aucun chiffre n'est invente"
echo ""
read -r -p "Entree pour fermer"
exit ${STATUT}
