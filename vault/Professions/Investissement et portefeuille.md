---
title: Investissement et portefeuille
tags: [métier, finance, portefeuille]
description: Tenir un portefeuille en local avec un journal de décisions, et la limite qui ne bouge pas.
---

# Investissement et portefeuille

> [!warning] La limite
> Suivi et analyse uniquement. Aucun conseil en investissement personnalisé,
> aucun ordre exécuté. [[Skill suivi-portefeuille]] termine chaque session par
> cette mention, et c'est volontaire.

## Ce que ça fait bien

Un fichier local `~/Documents/Galactus/portefeuille.json`, des cours récupérés à
la demande, tous les calculs par script, et surtout un **journal de décisions**
avec un motif obligatoire à chaque opération. Le journal vaut plus que la
performance : il rend tes décisions relisibles un an plus tard.

## Routine mensuelle

1. **Enregistrer les opérations du mois**

```
/suivi-portefeuille Achat de 12 MC.PA à 645,20 EUR le 2026-03-04, frais
4,90 EUR, motif "renforcement luxe après correction". Puis vente de 30 AAPL à
232,10 EUR le 2026-03-18, frais 3,20 EUR, motif "allègement, poids > 12 %".
```

2. **Recalculer la position**

```
Recalcule tout : valeur par ligne, plus ou moins-value latente en euros et en
pourcentage, poids par ligne et par classe, puis l'écart avec l'allocation
cible. Tableau trié par poids décroissant.
```

3. **Rééquilibrage chiffré**, écarts de plus de 5 points d'abord, présenté
   comme une proposition, jamais comme une instruction.

4. **Consigner la décision** dans le journal, avec son motif, même quand la
   décision est de ne rien faire.

## Vérifications

| Contrôle | Comment |
|---|---|
| Le JSON reste valide | `python3 -m json.tool` après chaque écriture, la skill le fait |
| Les cours sont réels | Un cours manquant se dit, ne s'invente jamais |
| Le prix de revient est juste | Recalcule une ligne à la main après un achat partiel |
| La devise est cohérente | Ligne en USD dans un portefeuille en EUR : le taux doit apparaître dans le calcul |

## Pièges

- **Cours différés** : l'API publique peut avoir un quart d'heure de retard. Sans
  importance pour un suivi mensuel, rédhibitoire pour autre chose.
- **Frais oubliés** : ils entrent dans le prix de revient, sinon la performance
  est flattée.
- **Le modèle qui glisse vers le conseil** : le tell est une phrase du type « tu
  devrais alléger ». Recadre, la skill le fait aussi.

## Un cran plus loin

Pour la modélisation, le backtest et la réconciliation, voir
[[Finance quantitative et corporate]].

## Voir aussi

[[Skill suivi-portefeuille]] · [[Finance quantitative et corporate]] ·
[[Data et IA]] · [[Administratif et gestion documentaire]] ·
[[Vérifier avant de croire]]
