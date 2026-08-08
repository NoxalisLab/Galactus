---
title: Ce que le modèle rate
tags: [pratique, limites]
description: Les six erreurs récurrentes d'un modèle local, leur signe distinctif et la parade.
---

# Ce que le modèle rate

Aucune de ces erreurs n'est un défaut de l'application. Ce sont des propriétés
des modèles de langage. Ce qui change tout, c'est de connaître leur **signe**.

## 1. API et fonctions inventées

**Signe** : un nom d'API parfaitement plausible, une signature élégante, aucune
citation. Souvent la version d'une bibliothèque que tu n'utilises pas.

**Parade** : imposer la source.

```
Avant d'écrire la moindre ligne, ouvre le fichier ou la doc qui définit cette
fonction et recopie sa signature exacte. Si tu ne la trouves pas, dis-le.
```

Sur un projet TypeScript, la [[Vue Code]] vérifie les types pour toi ; en Rust
et en C, elle ne le fait pas, la compilation est la seule preuve.

## 2. Chemins de fichiers inventés

**Signe** : un chemin en `src/utils/helpers.py` qui ressemble à une convention
plutôt qu'à ton projet.

**Parade** : `find_files` ou `list_directory` avant toute lecture, et refuser
tout chemin qui ne vient pas d'une sortie d'outil.

## 3. Arithmétique confiante

**Signe** : des totaux propres, arrondis, jamais recalculés. C'est l'erreur la
plus coûteuse en finance, en santé et en science.

**Parade** : interdire le calcul mental.

```
Aucun calcul de tête. Écris un script python3, lance-le avec run_command,
montre le script et sa sortie brute.
```

Voir [[Finance quantitative et corporate]] et [[Recherche scientifique]].

## 4. Connaissance périmée

**Signe** : une version, un prix, un taux, une réglementation cités sans date.
Le modèle est figé à son entraînement et n'a aucune notion du jour.

**Parade** : `run_command("date")` en début de session, et toute donnée mouvante
récupérée via `fetch_url` ou `curl`, datée de sa source. Voir
[[Veille et sourcing]].

## 5. Complaisance

**Signe** : « tu as raison, je corrige » alors que tu avais tort. Le modèle suit
ton affirmation plutôt que la preuve.

**Parade** : poser la question neutre. « Vérifie si X est vrai et montre-moi la
preuve » plutôt que « X est faux, non ? ».

## 6. Il dit avoir fait ce qu'il n'a pas fait

**Signe** : « j'ai mis à jour le fichier » sans carte d'outil correspondante
dans le fil.

**Parade** : le fil montre chaque appel d'outil. Pas de carte, pas d'action.
Redemande une preuve : `run_command("git diff --stat")` ou `read_file`.

## Suite

[[Vérifier avant de croire]] · [[Bien demander]] · [[Choisir un modèle]] ·
[[Vue Code]] · [[Fenêtre de contexte]]
