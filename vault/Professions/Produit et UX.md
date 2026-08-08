---
title: Produit et UX
tags: [métier, produit, ux]
description: Cadrer, spécifier et critiquer, avec la maquette autonome comme support de discussion.
---

# Produit et UX

## Ce qui marche vraiment

- Transformer une intention floue en spécification testable.
- Produire une maquette HTML autonome en quelques minutes pour discuter d'un
  écran ([[Skill ui-ux]]), affichée dans le panneau d'aperçu.
- Dépouiller des retours utilisateurs en local, ce qui compte quand ils
  contiennent des données nominatives ([[Tout reste en local]]).

## Workflow : de l'intention à la spécification

```
Intention : "les utilisateurs perdent leur panier". Transforme-la en spec :
problème observé, hypothèse de cause, périmètre inclus et exclu, 3 critères
d'acceptation formulés comme des tests observables, et ce qu'on ne fera pas.
Pose-moi une question si un élément manque, pas trois.
```

**Vérification** : chaque critère d'acceptation doit être vérifiable par une
action et une observation. « L'expérience est fluide » n'en est pas un.

## Workflow : maquette pour trancher

```
/ui-ux Maquette de l'écran panier vide : message, action principale unique,
suggestion de 3 produits. Cible : mobile web. États hover, focus, chargement
inclus. Un seul fichier autonome dans /Users/moi/maquettes/panier-vide.html.
```

Puis itère sur le **même fichier**, jamais un nouveau, en trois puces de
changements par tour.

## Workflow : dépouiller des retours

```
/analyse-documents Lis /Users/moi/retours/verbatims.csv. Regroupe les
verbatims en thèmes, un thème par ligne : intitulé, nombre de verbatims,
2 citations exactes avec leur numéro de ligne. Ne crée pas de thème
en dessous de 3 occurrences, mets le reste dans "divers".
```

**Vérification** : la somme des occurrences par thème doit être égale au nombre
de verbatims. Fais afficher les deux nombres.

## Workflow : arbitrage priorisé

```
Voici 12 demandes (liste ci-dessous). Classe-les en tableau : demande, effort
estimé (S/M/L) avec la raison de l'estimation, impact sur la tâche clé,
dépendances. N'invente aucune donnée d'usage : marque "inconnu" quand tu ne
sais pas.
```

La colonne « inconnu » est le point important : c'est ce qui empêche un
arbitrage fondé sur des chiffres inventés.

## Faiblesse honnête

Aucune donnée d'usage, aucun outil d'analytics, aucun test utilisateur, aucun
rendu réel. Le modèle ne sait rien de tes utilisateurs. Tout ce qui ressemble à
une statistique d'usage sortie de nulle part est inventé
([[Ce que le modèle rate]]).

## Voir aussi

[[Skill ui-ux]] · [[Frontend]] · [[Web full-stack]] · [[Rédaction technique]] ·
[[Skill analyse-documents]] · [[Développement logiciel]]
