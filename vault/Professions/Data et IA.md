---
title: Data et IA
tags: [métier, données, ia]
description: Profiler, nettoyer et réconcilier des données en local, avec la règle qui tient tout, aucun chiffre sans script.
---

# Data et IA

## Ce dont tu disposes réellement

- Un **Python 3.12 embarqué**, en tête du PATH, avec la stdlib : `csv`, `json`,
  `sqlite3`, `statistics`, `zipfile`. Il fonctionne même sur un Mac sans
  Command Line Tools.
- **pandas, numpy, polars, duckdb ne sont pas garantis.** Fais vérifier avant
  d'en dépendre.
- `sqlite3` en ligne de commande, présent sur macOS.
- Pas de GPU exposé pour ton propre entraînement : le Metal de la machine sert
  l'inférence du modèle.

```
run_command("python3 -c 'import sys;print(sys.version)'; python3 -c 'import pandas' 2>&1 | tail -1")
```

## Modèle à lancer

Qwen3-30B-A3B pour l'écriture de scripts en boucle (rapide, 25 tok/s à 24 Go).
gpt-oss-120b pour concevoir un schéma ou raisonner sur une modélisation.

## Workflow : d'un CSV de 40 Mo à un rapport mensuel réconcilié

1. **Profil, sans charger le fichier.**

```
/data-ia Profile /Users/moi/data/ventes.csv : nombre de lignes, colonnes,
type inféré, taux de vide, min/max des colonnes numériques, 3 exemples par
colonne. Écris le script dans /tmp/profil.py, en streaming, sans monter le
fichier en mémoire. Montre la sortie.
```

2. **Contrat de données.** Fais écrire, puis valide : clé, colonnes
   obligatoires, format de date, séparateur décimal, devise. Un CSV français à
   virgule décimale lu comme un point donne des totaux faux sans aucune erreur.

3. **Nettoyage traçable.**

```
Applique le contrat. À chaque étape, affiche lignes avant et après. Écris les
lignes rejetées dans /tmp/rejets.csv avec une colonne "raison". Ne supprime
jamais une ligne en silence.
```

4. **Agrégation mensuelle**, puis la vérification qui rattrape tout :

```
Prouve la conservation : somme des montants du fichier source ==
somme des montants du rapport + somme des rejets. Affiche les trois nombres
et l'écart. Si l'écart n'est pas nul, arrête-toi et explique.
```

5. **Rapport** en markdown ou CSV, écrit dans un fichier, pas déversé dans le
   fil ([[Fenêtre de contexte]]).

**Là où ça casse, à l'étape 2** : les dates. Un fichier qui mélange
`31/01/2026` et `2026-01-31` produit un mois vide sans erreur. Le tell est un
mois à zéro dans le rapport. Fais compter les formats de date distincts avant
tout parsing.

## Workflow : évaluer un modèle ou une heuristique

```
Jeu de test figé : /Users/moi/data/test.csv, colonne cible "churn".
Donne d'abord la baseline classe majoritaire, puis la métrique du modèle,
toutes deux calculées par le même script, avec la taille de l'échantillon.
Un modèle qui ne bat pas la baseline est un échec, dis-le.
```

## Workflow : recherche dans un corpus

`search_knowledge` indexe déjà tes dossiers en BM25
([[Base de connaissances locale]]). Ne construis un index maison que si tu peux
mesurer qu'il fait mieux sur un jeu de questions écrit d'avance.

## Faiblesse honnête

Pas d'entraînement lourd, pas de notebook, pas de graphique rendu. Pour une
visualisation, fais produire un HTML autonome avec un SVG calculé, et regarde-le
dans le panneau d'aperçu.

## Voir aussi

[[Skill data-ia]] · [[Bases de données]] · [[Recherche scientifique]] ·
[[Finance quantitative et corporate]] · [[Skill donnees-sensibles]] ·
[[Base de connaissances locale]] · [[Choisir un modèle]]
