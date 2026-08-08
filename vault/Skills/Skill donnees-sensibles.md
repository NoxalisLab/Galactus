---
title: Skill donnees-sensibles
tags: [skill, confidentialité, conformité]
description: Procédure de traitement strictement local de données personnelles, avec pseudonymisation, contrôle de fuite et traçabilité.
---

# Skill donnees-sensibles

`/donnees-sensibles` sert dès qu'un fichier contient des données personnelles,
de santé, RH, juridiques ou financières confidentielles.

## Ce qu'elle force

- **Zéro réseau** pendant la session : ni `fetch_url`, ni `curl`, ni outil MCP.
- Un inventaire des champs validé avant toute transformation : identifiant
  direct, quasi-identifiant, donnée sensible, donnée neutre.
- Pseudonymisation par script, avec la table de correspondance dans un fichier
  séparé, jamais affichée dans le fil.
- Généralisation des quasi-identifiants : année de naissance, département,
  tranche d'âge.
- Un **contrôle de fuite** obligatoire sur le fichier produit, recompté après
  correction.
- Un fichier `traitement.md` à côté du livrable : entrées, script,
  transformations, comptages, contrôles. C'est ce qui rend le traitement
  défendable.
- Aucun jugement professionnel délégué au modèle.

## Exemple

```
/donnees-sensibles Fichier /Users/moi/etude/cohorte.csv. Inventorie les champs
et propose un traitement par colonne. N'applique rien avant ma validation.
```

## Ses limites

Elle protège le traitement, pas la machine. Le chiffrement du disque, les
sauvegardes et les accès restent ta responsabilité ([[Tout reste en local]]).

## Voir aussi

[[Santé et données patients]] · [[Tout reste en local]] ·
[[Administratif et gestion documentaire]] · [[Skill data-ia]] ·
[[Recherche scientifique]] · [[Skills et invocation]]
