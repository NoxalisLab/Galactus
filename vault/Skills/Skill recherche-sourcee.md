---
title: Skill recherche-sourcee
tags: [skill, recherche, sources]
description: Recherche d'information vérifiée, sources croisées, synthèse avec URL datées.
---

# Skill recherche-sourcee

`/recherche-sourcee` sert quand la réponse doit être défendable. Le bouton
Recherche approfondie du composeur déclenche la même procédure pour un message.

## Ce qu'elle force

- Aucun fait sans URL précise **et** sans date de publication.
- La date du jour récupérée via `run_command("date")` pour repérer le périmé.
- Découpage en 2 à 6 sous-questions, un coéquipier par sous-question, chaque
  brief répétant les consignes car un coéquipier part d'un contexte vierge.
- Deux sources indépendantes minimum par affirmation importante ; deux articles
  reprenant le même communiqué comptent pour une.
- Étiquetage `[FAIT]`, `[ESTIMATION]`, `[OPINION]`.
- Une section « Limites » et une liste de sources numérotées, chaque fait
  renvoyant à un numéro.
- La connaissance interne du modèle sert à formuler les requêtes, jamais de
  source.

## Exemple

```
/recherche-sourcee Quelles obligations de conservation s'appliquent aux
factures électroniques en France en 2026 ? Sources officielles en priorité,
date de publication pour chacune, et dis-moi explicitement ce que tu n'as pas
trouvé.
```

## Voir aussi

[[Veille et sourcing]] · [[Recherche scientifique]] ·
[[Équipes de sous-agents]] · [[Vérifier avant de croire]] ·
[[Skills et invocation]]
