---
title: Recherche scientifique
tags: [métier, recherche, reproductibilité]
description: Revue de littérature sourcée, analyse reproductible et rédaction LaTeX, avec la réplication comme critère.
---

# Recherche scientifique

Deux forces ici : la lecture massive de PDF en local et l'exécution de scripts
qui rendent une analyse reproductible. Une faiblesse assumée : pas d'accès aux
bases bibliographiques payantes.

## Workflow : revue de littérature sourcée

```
/recherche-sourcee Question : quelle est l'efficacité mesurée de X sur Y chez
l'adulte, publications 2023 à 2026 ? Priorité aux revues systématiques.
Pour chaque étude : titre, année, design, taille d'échantillon, résultat
principal avec son intervalle de confiance, DOI. Dis explicitement ce que tu
n'as pas trouvé.
```

Les sources accessibles sans abonnement : PubMed et son API, arXiv, HAL, les
dépôts institutionnels, Crossref pour les métadonnées.

```
run_command("curl -s 'https://api.crossref.org/works/10.1000/xyz' | python3 -c \"import sys,json;m=json.load(sys.stdin)['message'];print(m['title'][0], m.get('issued'))\"")
```

**Vérification** : chaque DOI doit résoudre. Fais-les vérifier un par un ; un
DOI inventé est l'erreur la plus fréquente et la plus embarrassante.

## Workflow : dépouiller un corpus de PDF

Un coéquipier par article, même grille d'extraction pour tous
([[Équipes de sous-agents]]), puis tu fusionnes. Grille type : question,
population, méthode, n, mesure principale, résultat, limites déclarées, page de
chaque valeur ([[Skill analyse-documents]]).

## Workflow : analyse reproductible

```
/data-ia Analyse /Users/moi/etude/mesures.csv : n par groupe, moyenne, écart
type, et test de comparaison adapté (justifie le choix). Écris le script dans
analyse.py, avec une graine fixée. Montre le script et la sortie.
Puis relance-le et confirme que les nombres sont identiques.
```

Deux exécutions identiques : c'est le seuil minimal de reproductibilité, et il
attrape les analyses dépendantes d'un ordre de lecture ou d'un aléa non fixé.

## Workflow : LaTeX et figures

L'application écrit du LaTeX, elle ne le compile pas sauf si tu as une
distribution installée. Vérifie :

```
run_command("which pdflatex latexmk 2>&1")
```

Sans distribution, le rendu ne peut pas être contrôlé : fais produire le `.tex`
et compile de ton côté. Pour une figure rapide, un SVG calculé par script
s'affiche dans le panneau d'aperçu.

## Workflow : relecture par les pairs

```
Lis mon manuscrit /Users/moi/papier/main.tex par sections. Pour chaque section :
une affirmation non étayée, une faiblesse méthodologique, une clarté à
améliorer. Cite la ligne. Ne réécris rien.
```

## Pièges

| Piège | Tell | Parade |
|---|---|---|
| Référence inventée | un titre plausible sans DOI vérifiable | Résoudre chaque DOI |
| p-value calculée de tête | un nombre sans script | Script obligatoire |
| Comparaisons multiples ignorées | dix tests, un seul significatif mis en avant | Le faire expliciter |
| Corpus partiellement lu | conclusion sans page citée | Exiger la couverture déclarée |

## Voir aussi

[[Skill recherche-sourcee]] · [[Skill analyse-documents]] · [[Data et IA]] ·
[[Documents et OCR]] · [[Santé et données patients]] · [[Veille et sourcing]] ·
[[Rédaction technique]]
