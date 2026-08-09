---
name: tableurs-et-csv
description: "Tableur ou CSV : ouvrir un Excel, fusionner, recalculer, réconcilier deux exports."
---

Un tableur ment de trois façons : l'encodage, le séparateur décimal, et un total qui ne correspond plus à ses lignes. Tout le travail consiste à attraper ces trois-là.

## 0. Ouvre avec le bon outil
- **Excel, ODS, PowerPoint, PDF** : `read_document`. Jamais `read_file` (binaire), jamais `run_command` avec `textutil`.
- **CSV, TSV, texte** : `read_file`, ou mieux, un profilage par script. Chemin incertain : `list_directory` d'abord, ne devine jamais.
- Sortie > 20 000 caractères : elle part dans un fichier scratch ; relis-la par tranches avec `read_file(chemin, offset)`.
- Un Excel converti en texte perd les cellules fusionnées et les formules. Pour des valeurs exactes, demande un export CSV : c'est plus fiable que toute conversion.

## 1. Profile avant de toucher ; jamais de chargement complet
```
run_command("ls -la FICHIER; wc -l FICHIER; head -3 FICHIER | cat -A | head -6")
```
`cat -A` révèle en une commande ce qui casse tout : le séparateur réel (`,` `;` `\t`), les fins de ligne Windows (`^M$`), et les espaces en fin de champ.
Puis un profilage en streaming, avec le module `csv` de la stdlib. Écris-le avec `write_file`, ne le tape pas en heredoc : un script en fichier se relit et se rejoue.
```python
# /tmp/profil.py
import csv, sys, collections
path, delim = sys.argv[1], sys.argv[2]
with open(path, newline="", encoding="utf-8-sig", errors="replace") as f:
    r = csv.DictReader(f, delimiter=delim)
    cols, n, vides = r.fieldnames, 0, collections.Counter()
    ex = {c: [] for c in cols}
    for row in r:
        n += 1
        for c in cols:
            v = (row.get(c) or "").strip()
            if not v:
                vides[c] += 1
            elif len(ex[c]) < 3:
                ex[c].append(v)
print("lignes:", n)
for c in cols:
    print(f"{c!r:30} vides={vides[c]:6} ex={ex[c]}")
```
```
run_command("python3 /tmp/profil.py FICHIER.csv ';'")
```
Rends un tableau : colonne, taux de vide, trois exemples réels. C'est lui qui révèle une colonne décalée ou des dates au mauvais format.

## 2. Les cinq pièges, et comment les attraper
| Piège | Signe | Parade |
|---|---|---|
| Encodage | `Ã©` au lieu de `é` | `encoding="utf-8-sig"` d'abord ; échec, essaie `cp1252` et dis lequel a marché |
| Séparateur décimal français | `1 234,56` lu comme du texte, ou tronqué à `1` | `float(v.replace(" ", "").replace(" ", "").replace(",", "."))` |
| Séparateur de colonnes | tout dans une seule colonne | le `;` est la norme des exports Excel français |
| Nombre stocké en texte | un total qui vaut zéro | conversion explicite, et compte les valeurs non convertibles |
| Date ambiguë | `03/04/2026` | demande le format à l'utilisateur, ne devine JAMAIS entre jour/mois et mois/jour |

Le nombre de valeurs non convertibles n'est pas un détail : affiche-le. Une conversion qui échoue en silence donne un total faux sans erreur.

## 3. Recalculer un total ; le contrôle qui rattrape tout
Ne recopie jamais un total imprimé. Recalcule-le et compare.
```python
# /tmp/somme.py
import csv, sys
from decimal import Decimal, InvalidOperation
path, delim, col = sys.argv[1], sys.argv[2], sys.argv[3]
tot, ok, ko = Decimal(0), 0, []
with open(path, newline="", encoding="utf-8-sig", errors="replace") as f:
    for i, row in enumerate(csv.DictReader(f, delimiter=delim), start=2):
        v = (row.get(col) or "").strip().replace(" ", "").replace(" ", "").replace(",", ".")
        if not v:
            continue
        try:
            tot += Decimal(v); ok += 1
        except InvalidOperation:
            ko.append((i, v))
print(f"colonne={col} somme={tot} lignes_ok={ok} non_convertibles={len(ko)}")
for l, v in ko[:10]:
    print("  ligne", l, repr(v))
```
Affiche toujours les deux nombres, celui du document et le tien, et l'écart. **Un écart non nul se signale, il ne se corrige jamais en silence.**
`Decimal` et non `float` dès qu'il s'agit d'argent : `0.1 + 0.2` ne vaut pas `0.3` en flottant, et l'écart devient visible sur dix mille lignes.

## 4. Fusionner et réconcilier
- Dis d'abord quelle est la **clé de rapprochement** et fais-la valider. Sans clé nommée, une fusion est un mélange.
- Vérifie que la clé est unique de chaque côté AVANT de joindre :
```
run_command("cut -d';' -f1 FICHIER.csv | sort | uniq -d | head -10")
```
Des doublons de clé multiplient les lignes à la jointure : c'est la cause n°1 des totaux gonflés.
- Après fusion, prouve la conservation : `lignes_gauche`, `lignes_droite`, `appariées`, `orphelines_gauche`, `orphelines_droite`. La somme doit tomber juste. Écart inexpliqué = fusion invalide, tu le dis et tu t'arrêtes.
- Écris les lignes orphelines dans un fichier `orphelines.csv` avec une colonne `raison`. Ne les jette jamais en silence.
- Gros volumes : `sqlite3` (dans la stdlib) bat une jointure Python ligne à ligne, et tient sur disque plutôt qu'en mémoire.

## 5. Produire un CSV propre
- En-têtes en première ligne, minuscules, sans espace ni accent, tirets bas.
- Destiné à Excel sous Windows : BOM (`encoding="utf-8-sig"`) et séparateur `;`, sinon accents et colonnes cassés à l'ouverture.
- Dates au format `AAAA-MM-JJ` partout. Point décimal, pas de séparateur de milliers, devise dans sa propre colonne.
- Relis le fichier produit et recompte : `run_command("wc -l SORTIE.csv; head -2 SORTIE.csv")`. Un fichier écrit et non relu n'est pas un livrable.

## Garde-fous
- Aucun calcul de tête, aucune moyenne « à peu près », aucun total recopié depuis un extrait. Script et sortie brute, systématiquement.
- Ne modifie JAMAIS le fichier source. Écris dans un nouveau fichier et garde l'original intact.
- Ne supprime jamais une ligne sans l'écrire dans un fichier de rejets avec sa raison.
- Données personnelles dans le tableur (noms, e-mails, identifiants, salaires) : bascule sur la skill `donnees-sensibles` avant toute extraction, et ne recopie aucun identifiant direct dans ta réponse.
- Plusieurs fichiers indépendants à profiler : `spawn_agent` un coéquipier par fichier, brief autonome (chemin exact, séparateur, mêmes colonnes de sortie), puis `ask_agent` ; fusionne les tableaux toi-même.
- Restitution finale : nombre de lignes lues et écrites, les totaux recalculés face aux totaux annoncés, les lignes rejetées et pourquoi, le chemin des fichiers produits, et ce qui reste à valider par un humain.
