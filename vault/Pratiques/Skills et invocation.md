---
title: Skills et invocation
tags: [pratique, skills]
description: Ce qu'est une skill, comment l'appeler et comment en écrire une pour ton propre métier.
---

# Skills et invocation

Une skill est un fichier `SKILL.md` : un frontmatter (`name`, `description`) et
un mode d'emploi que le modèle suit pour la tâche en cours. C'est une procédure
métier, pas un personnage.

## Appeler une skill

- Dans le composeur, tape `/` puis le nom : `/dev-senior corrige le crash au
  démarrage de src/main.rs`.
- Ou demande-le en clair : « utilise la skill analyse-documents ».
- Le modèle peut aussi la charger seul avec `use_skill` quand la tâche
  correspond.

Le contenu complet de la skill entre dans la fenêtre. Une skill de 3 Ko coûte
environ 800 tokens sur 8192 : n'en charge pas trois à la fois
([[Fenêtre de contexte]]).

## Les skills livrées

Métier logiciel et système : [[Skill dev-senior]], [[Skill serveurs-distants]],
[[Skill data-ia]], [[Skill automatisation-mac]].

Documents et écrit : [[Skill analyse-documents]], [[Skill redaction-pro]],
[[Skill donnees-sensibles]].

Recherche et décision : [[Skill recherche-sourcee]],
[[Skill suivi-portefeuille]], [[Skill ui-ux]].

## Où elles vivent

- Globales :
  `~/Library/Application Support/Galactus/skills/<nom>/SKILL.md`. Les skills
  livrées y sont copiées au premier lancement, sans jamais écraser un dossier
  existant.
- Par projet : `<projet>/.galactus/skills/` ou `<projet>/.claude/skills/`,
  visibles seulement quand ce dossier est ouvert.

## Écrire la tienne

Un `SKILL.md` utile tient en une page et suit ce plan :

1. **Frontmatter** : `name` en minuscules avec tirets, `description` qui dit
   *quand* déclencher, pas ce que la skill est.
2. **Garde-fous en tête** si le domaine est sensible.
3. **Étapes numérotées**, chacune nommant l'outil exact à utiliser.
4. **Commandes recopiables** dans des blocs de code.
5. **Restitution** : le format attendu de la réponse finale.

Prompt pour la faire écrire :

```
Lis ~/Library/Application Support/Galactus/skills/dev-senior/SKILL.md pour le
format, puis écris une skill "revue-securite" au même format : 5 étapes
numérotées, chaque étape nomme l'outil, une section garde-fous, moins de 4 Ko.
Écris-la dans
~/Library/Application Support/Galactus/skills/revue-securite/SKILL.md
```

## Suite

[[Outils de l'assistant]] · [[Bien demander]] · [[Fenêtre de contexte]] ·
[[Développement logiciel]] · [[Accueil]]
