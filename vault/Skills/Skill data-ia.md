---
title: Skill data-ia
tags: [skill, data, ia]
description: Procédure pour profiler, nettoyer, réconcilier un jeu de données et évaluer un modèle, sans jamais estimer un chiffre.
---

# Skill data-ia

`/data-ia` applique la règle qui rend un travail de données défendable : aucun
chiffre qui ne sorte d'un script exécuté et montré.

## Ce qu'elle force

- Vérifier ce qui est installé avant d'en dépendre : le Python embarqué a la
  stdlib, pas pandas ni numpy.
- Profiler en streaming avant de charger quoi que ce soit : lignes, colonnes,
  types, taux de vide, min et max.
- Écrire un contrat de données validé avant tout nettoyage : clé, colonnes
  obligatoires, types, plages, format de date, devise.
- Compter les lignes avant et après chaque étape, et écrire les rejets dans un
  fichier avec leur raison.
- Prouver la conservation après agrégation : somme source contre somme sortie
  plus rejets.
- Baseline triviale obligatoire avant d'annoncer une métrique de modèle.

## Exemple

```
/data-ia Profil complet de /Users/moi/data/ventes-2026.csv : lignes, colonnes,
types, taux de vide, doublons sur (date, client, produit). Écris le script dans
/tmp/profil.py, lance-le, montre la sortie. Ne modifie pas le fichier source.
```

## Ses limites

Pas de GPU, pas d'entraînement lourd, pas de bibliothèque scientifique
garantie. Elle sert l'ingénierie des données et l'évaluation, pas
l'entraînement de modèles.

## Voir aussi

[[Data et IA]] · [[Bases de données]] · [[Finance quantitative et corporate]] ·
[[Recherche scientifique]] · [[Skill donnees-sensibles]] ·
[[Skills et invocation]]
