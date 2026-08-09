---
name: analyse-documents
description: "Lire, résumer, comparer ou extraire d'un PDF, Word, Excel, PowerPoint ou scan."
---

## Règle d'or
Tu ne rapportes QUE ce qui est écrit dans le document. Aucune connaissance externe, aucune déduction présentée comme un fait. Absent = « non présent dans le document ». Flou = marqué incertain.

## 1. Ouvre le document
- `read_document(path)` : PDF, Word, Excel, PowerPoint, RTF, HTML, image scannée (OCR automatique).
- `read_file(path)` : texte brut (txt, md, csv, logs).
- Jamais `run_command` (cat, textutil…) pour lire un document.
- Chemin incertain ? `list_directory` d'abord. Ne devine jamais un chemin.

## 2. Gros document : lis par tranches
- Sortie tronquée ou enregistrée dans un fichier scratch ? Relis le fichier scratch indiqué, tranche par tranche : `read_file(chemin_scratch, offset)` jusqu'à la fin. Jamais `read_file` directement sur un PDF/Word (binaire).
- Après chaque tranche, note en 3-5 lignes : pages couvertes, faits clés, citations candidates. Ton contexte est court : ces notes remplacent toute relecture.
- Document très long (> ~50 pages) ou plusieurs questions ? `spawn_agent` : un coéquipier par bloc de pages, chaque brief = chemin exact + plage à lire + faits à extraire + consigne de citer ses pages ; interroge-les avec `ask_agent`.
- Ne conclus qu'après avoir tout couvert ; à défaut, liste explicitement les parties non lues.

## 3. Cite, ne paraphrase pas
- Affirmation importante = citation exacte entre « » + localisation (p. X, section Y ; Feuille!Cellule pour Excel). Sans pagination : titre de section ou position (début/milieu/fin).
- Chiffres, dates, montants, noms : recopiés caractère par caractère, relus dans la source avant restitution.

## 4. Marque l'incertain
- OCR douteux : [illisible] ou [incertain : « texte probable »].
- Information absente : « non présent dans le document ». Ne comble jamais.
- Contradiction interne : signale-la avec les deux citations localisées.

## 5. Extraction structurée (si demandée)
1. Propose le schéma (colonnes/clés) ; fais-le valider si la demande est ambiguë.
2. Relis chaque valeur dans la source ; champ manquant = vide ou null, jamais inventé. Ajoute une colonne `source` (page/section).
3. `write_file` en CSV (en-têtes, UTF-8) ou JSON valide.

## 6. Comparatif multi-documents
Dès 2 documents : `spawn_agent`, un coéquipier par document (6 max ; au-delà, regroupe plusieurs documents par coéquipier), puis `ask_agent`. Chaque brief contient : le chemin exact de SON fichier, la même grille d'extraction (mêmes champs pour tous), la consigne de citer page/section et de marquer « absent » les champs manquants. À la réception, construis toi-même le tableau comparatif à partir des rapports ; ne fusionne jamais des champs non comparables.

## 7. Restitue
Objet du document, points clés avec citations localisées, zones d'incertitude, puis limites de lecture : pages sautées, OCR douteux, et ce que tu n'as PAS pu vérifier.
