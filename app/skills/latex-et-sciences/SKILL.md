---
name: latex-et-sciences
description: "Document scientifique LaTeX : article, thèse, BibTeX, équations, compilation."
---

Un document LaTeX se juge sur une seule chose : **il compile**. Un `.tex` élégant qui échoue au premier `pdflatex` ne vaut rien.

## 0. Vérifie la chaîne de compilation ; avant d'écrire une ligne
LaTeX **n'est pas fourni** avec l'application. Il faut une installation TeX sur le Mac.
```
run_command("which pdflatex xelatex latexmk biber bibtex 2>&1")
```
- Aucun binaire : dis-le tout de suite, propose l'installation (MacTeX, ou BasicTeX plus léger) et demande si tu dois quand même produire le `.tex` sans pouvoir le vérifier. Dans ce cas, annonce clairement que le fichier n'est **pas** validé.
- `latexmk` présent : préfère-le, il gère les passes multiples et la bibliographie tout seul.
- Une compilation peut dépasser 120 s sur un gros document. Lance-la en fond avec un log (§3).

## 1. Le préambule ; sobre et compilable
```latex
\documentclass[11pt,a4paper]{article}
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\usepackage[french]{babel}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage[hidelinks]{hyperref}
\usepackage[backend=biber,style=numeric,sorting=none]{biblatex}
\addbibresource{references.bib}
\begin{document}
\end{document}
```
Règles qui évitent les échecs les plus fréquents :
- **N'utilise pas `fontspec`** sauf compilation explicite par `xelatex` ou `lualatex` ; avec `pdflatex` il fait échouer le document.
- Charge `hyperref` en dernier, sauf `cleveref` qui vient après lui. Aucun paquet « au cas où » : un paquet inutilisé est un risque d'incompatibilité.
- Labels et noms de fichiers en ASCII : un caractère accentué y casse la compilation.
- Échappe `& % $ # _ { } ~ ^ \` dans le texte. Un `%` non échappé transforme la fin de la ligne en commentaire, silencieusement : c'est l'erreur la plus difficile à voir.

## 2. Structure, figures, tableaux, équations
- Sections avec `\label{sec:nom}` juste après le `\section`, références par `\ref`. Jamais un numéro écrit en dur.
- **Figures** : `\includegraphics[width=0.8\linewidth]{fig/nom}` sans extension, `\caption` AVANT `\label`. L'inverse produit une référence vers le mauvais numéro, sans erreur. Vérifie que le fichier existe : `run_command("ls -la fig/")`.
- **Tableaux** : `booktabs` (`\toprule`, `\midrule`, `\bottomrule`), jamais de barres verticales.
- **Équations** : `equation` pour une seule, `align` pour plusieurs, jamais `eqnarray` (obsolète). Toute équation référencée porte un `\label{eq:nom}`.
- **Unités** : espace insécable entre la valeur et l'unité (`10~kg`). Chiffres significatifs cohérents avec la précision de la mesure.

## 3. Compiler et lire les erreurs
```
run_command("cd /chemin && nohup latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex > /tmp/tex-$(date +%s).log 2>&1 & echo LOG=/tmp/tex-...log")
```
Puis, dans un appel SÉPARÉ :
```
run_command("grep -nE '^!|Undefined control|Missing|Runaway|LaTeX Warning: (Reference|Citation)' /tmp/tex-….log | head -30")
```
`-interaction=nonstopmode` est **indispensable** : sans lui, LaTeX s'arrête sur une invite qui n'arrivera jamais ici et la commande meurt à 120 s sans rien dire.
| Message | Cause | Correction |
|---|---|---|
| `! Undefined control sequence` | commande inconnue, paquet manquant | ajoute le paquet, ou corrige la faute de frappe |
| `! Missing $ inserted` | symbole mathématique hors mode math | entoure de `$…$` |
| `! LaTeX Error: File 'x.sty' not found` | paquet non installé | `tlmgr install x`, ou retire le paquet |
| `Runaway argument` | accolade non fermée | cherche l'accolade orpheline près du numéro de ligne |
| `Reference ... undefined` | label absent, ou une seule passe | vérifie le label, puis recompile deux fois |
| `Citation ... undefined` | clé absente du `.bib`, ou biber non lancé | vérifie la clé, relance `latexmk` |
Preuve de réussite : le PDF existe et a la bonne taille.
```
run_command("ls -la main.pdf; pdfinfo main.pdf 2>/dev/null | head -5")
```
Sans cette vérification, tu n'as pas compilé, tu as espéré.

## 4. Bibliographie
- Un fichier `references.bib`, une entrée par source, clé au format `auteur2026motcle`.
- **Ne fabrique JAMAIS une référence.** Ni un DOI, ni un numéro de page, ni une année. Une référence inventée est une faute grave dans un travail scientifique et elle sera détectée.
- Récupère les métadonnées à la source, jamais de mémoire :
```
run_command("curl -sS -m 20 -H 'Accept: application/x-bibtex' 'https://doi.org/10.XXXX/YYYY'")
```
- Contrôle avant de rendre : toute clé citée a-t-elle son entrée, toute entrée est-elle citée ?
```
run_command("grep -ohE '\\\\cite[a-z]*\\{[^}]*\\}' *.tex | tr -d '\\\\citep[a-z]{}' | tr ',' '\\n' | sort -u > /tmp/c.txt; grep -oE '^@[a-z]+\\{[^,]+' references.bib | sed 's/.*{//' | sort -u > /tmp/k.txt; echo '== cite sans entree'; comm -23 /tmp/c.txt /tmp/k.txt; echo '== entree non citee'; comm -13 /tmp/c.txt /tmp/k.txt")
```

## 5. Écriture scientifique ; le fond
- Sépare ce qui est **mesuré** de ce qui est **interprété**. Les résultats ne contiennent pas de conclusions, la discussion pas de nouveaux chiffres.
- Tout chiffre du texte se retrouve dans une figure, un tableau ou un jeu de données cité. Recalcule les valeurs dérivées avec `python3` : un pourcentage recopié à la main est faux une fois sur cinq.
- Donne la dispersion avec la moyenne (écart type, taille de l'échantillon). Une moyenne seule n'est pas un résultat.
- Reproductibilité : version des outils, graine aléatoire, chemin des données. Les limites de l'étude sont une section, pas une phrase de politesse.

## Garde-fous
- N'invente jamais une référence, un chiffre, une valeur de p ou un résultat. Manquant : `[À COMPLÉTER : …]`, signalé en fin de réponse.
- Ne prétends jamais que le document compile sans avoir montré la sortie de la compilation et l'existence du PDF.
- `write_file` réécrit le fichier entier : relis-le d'abord si tu n'as plus son contenu en contexte. Sur un `.tex` long, préfère un remplacement ciblé via `run_command`.
- Ne modifie pas le gabarit imposé par une revue ou une université sans le dire ; ces gabarits sont contraignants.
- Restitution finale : le chemin du `.tex` et du PDF, la sortie de la dernière compilation, les références manquantes ou non citées, les `[À COMPLÉTER]` restants, et ce que tu n'as pas pu vérifier.
