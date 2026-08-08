---
title: Skill suivi-portefeuille
tags: [skill, finance]
description: Suivre un portefeuille en local, enregistrer les opérations, calculer performance et allocation, proposer un rééquilibrage chiffré.
---

# Skill suivi-portefeuille

`/suivi-portefeuille` tient un portefeuille dans un fichier local
`~/Documents/Galactus/portefeuille.json`, avec un journal des décisions.

## Ce qu'elle force

- Un motif obligatoire à chaque opération : le journal des décisions vaut plus
  que la performance.
- Le prix de revient unitaire recalculé frais inclus, jamais de tête : tout
  passe par `python3`.
- Cours récupérés en une seule commande, extraits en Python, jamais le JSON brut
  dans la fenêtre.
- Vérification du JSON après chaque écriture (`python3 -m json.tool`).
- Un rééquilibrage est une **proposition chiffrée**, jamais un ordre.
- Cours indicatifs, parfois différés ; en cas d'échec réseau, elle le dit et
  n'invente jamais un cours.

## La ligne qu'elle ne franchit pas

Suivi et analyse uniquement. Aucun conseil en investissement personnalisé,
aucun ordre exécuté. Chaque session se termine par la mention explicite que ce
n'est pas un conseil en investissement.

## Exemple

```
/suivi-portefeuille Enregistre l'achat de 12 MC.PA à 645,20 EUR le 2026-03-04,
frais 4,90 EUR, motif "renforcement luxe après correction". Puis recalcule la
performance globale et l'écart par rapport à mon allocation cible.
```

## Voir aussi

[[Investissement et portefeuille]] · [[Finance quantitative et corporate]] ·
[[Vérifier avant de croire]] · [[Skills et invocation]]
