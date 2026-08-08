---
title: Skill ui-ux
tags: [skill, design]
description: Auditer une interface par sévérité, ou produire une maquette HTML/CSS autonome avec états et accessibilité.
---

# Skill ui-ux

`/ui-ux` a deux modes : critique structurée d'un écran existant, ou maquette
autonome.

## Ce qu'elle force

- Un cadrage en trois lignes : utilisateur cible, tâche clé, plateforme,
  livrable.
- Une critique classée en bloquant, majeur, mineur, avec pour chaque constat :
  où (fichier:ligne ou zone), pourquoi, la correction concrète. Dix constats au
  maximum.
- Une maquette en **un seul fichier HTML autonome** : CSS en ligne, aucune
  dépendance, elle s'ouvre hors ligne.
- Échelle d'espacement fixe 4/8/12/16/24/32/48, une seule action primaire,
  quatre tailles de texte au plus.
- Les états visibles dans la maquette : survol, focus, vide, erreur, chargement.
- Contraste 4.5:1, cibles 44 px, vrais éléments interactifs navigables au
  clavier.
- Contenu réaliste, jamais de faux latin.

## Ce qu'elle ne peut pas juger

Une capture d'écran ne rend que du texte par OCR. Couleurs, contrastes et
espacements ne se jugent que sur le code source, elle le dit au lieu de deviner.

## Exemple

```
/ui-ux Maquette de l'écran de connexion : email, mot de passe, mot de passe
oublié, et l'état d'erreur « identifiants invalides » visible. Cible : web
desktop.
Écris-la dans /Users/moi/maquettes/login.html puis ouvre-la.
```

## Voir aussi

[[Produit et UX]] · [[Frontend]] · [[Web full-stack]] ·
[[Rédaction technique]] · [[Skills et invocation]]
