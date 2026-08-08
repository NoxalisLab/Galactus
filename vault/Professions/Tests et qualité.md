---
title: Tests et qualité
tags: [métier, tests]
description: Faire écrire des tests qui prouvent quelque chose, et se servir de la sortie brute comme seule vérité.
---

# Tests et qualité

Le test est la seule chose qui transforme une affirmation du modèle en fait.
C'est pour cela que cette note est courte et rigide.

## La règle

> [!warning] Sortie brute ou rien
> « Les tests passent » n'est pas une preuve. La preuve est la sortie de la
> commande, collée dans le fil. Un modèle peut affirmer un succès qu'il n'a pas
> constaté ([[Ce que le modèle rate]]).

## Workflow : caractériser avant de corriger

```
Le bug : POST /orders accepte une quantité négative. Écris d'abord un test qui
échoue à cause de ce bug, lance-le, montre la sortie de l'échec. Ne corrige
rien tant que je n'ai pas vu ce test échouer.
```

Un test écrit après le correctif prouve seulement que le code fait ce qu'il
fait.

## Workflow : lancer la bonne commande

```
Trouve la commande de test dans README, Makefile, package.json ou
pyproject.toml, cite le fichier et la ligne, puis lance uniquement les tests du
dossier tests/orders avec run_command. Timeout 120 s : si la suite complète est
plus longue, découpe par dossier.
```

## Workflow : couverture utile

```
Liste les fonctions de src/pricing.py sans aucun test associé. Pour chacune,
propose UN test qui vérifie un comportement métier, pas la syntaxe. Classe-les
par risque décroissant. N'en écris aucun avant mon choix.
```

## Interdits

- Affaiblir une assertion existante pour faire passer un patch. Le tell : une
  assertion supprimée ou un `assert True` dans le diff.
- Un `try/except` autour du code testé.
- Marquer un test en `skip` pour verdir la suite.

Relis chaque hunk de test dans le diff, c'est là que ça se joue.

## Le cas Rust et C

Le niveau Complet n'existe pas pour ces langages ([[Vue Code]]). La compilation
est ta vérification de type :

```
Après chaque proposition, lance cargo check (ou make) et montre la sortie
complète, y compris les warnings. N'enchaîne pas sur la suite tant qu'elle
n'est pas propre.
```

## Voir aussi

[[Développement logiciel]] · [[Skill dev-senior]] · [[CI-CD et livraison]] ·
[[Backend et API]] · [[Vérifier avant de croire]] · [[Vue Code]]
