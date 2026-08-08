---
title: Équipes de sous-agents
tags: [pratique, délégation]
description: Quand recruter des coéquipiers vaut mieux qu'un seul fil, et quand cela ne fait que brûler des tokens.
---

# Équipes de sous-agents

En mode agent, l'assistant principal peut recruter une équipe : `spawn_agent`
crée un coéquipier nommé avec son propre fil, `list_agents` les liste,
`ask_agent` lui envoie une tâche et **attend sa réponse**.

## Ce que cela change vraiment

- Chaque coéquipier a **son propre contexte de 8192 tokens**. C'est le seul vrai
  moyen de traiter plus de matière que n'en contient une fenêtre.
- Un coéquipier ne voit **pas** ton fil. Sa consigne doit être autonome :
  chemins absolus, format de réponse attendu, critères de qualité.
- Son fil complet est visible dans l'application, tu peux l'ouvrir et le lire.
- La délégation est bornée : profondeur 2 (le principal interroge l'architecte,
  l'architecte interroge le relecteur, le relecteur n'interroge personne), et
  une chaîne circulaire est refusée. Une équipe termine toujours.
- Chaque délégation passe par la barrière de permission.

## Quand déléguer paie

- **Lire N sources et comparer** : un coéquipier par document, même grille
  d'extraction pour tous, puis tu fusionnes. Voir [[Documents et OCR]].
- **Rôles distincts** : architecte, implémenteur, relecteur. Le relecteur qui
  n'a pas écrit le code trouve ce que l'auteur ne voit plus.
- **Exploration parallèle** : trois pistes de diagnostic sur un incident,
  chacune bornée. Voir [[Observabilité et incidents]].

## Quand c'est du gaspillage

- Une question à laquelle tu réponds en une phrase.
- Une tâche séquentielle où l'étape 2 dépend entièrement de l'étape 1 : la
  délégation ajoute un aller-retour sans gagner de contexte.
- Sur un modèle lent (moins de 5 tok/s) : chaque coéquipier paie son propre
  prompt système. Trois coéquipiers, c'est trois fois le prix.

## Brief qui fonctionne

```
Recrute trois coéquipiers :
- "lecteur-a" : lit /Users/moi/docs/contrat-2025.pdf en entier
- "lecteur-b" : lit /Users/moi/docs/contrat-2026.pdf en entier
- "juriste" : compare les deux extractions

Chaque lecteur rend un tableau avec exactement ces colonnes : clause | page |
citation exacte | remarque. Champ absent = "absent", jamais deviné.
Le juriste ne lit aucun PDF, il travaille seulement sur les deux tableaux.
```

Le détail reste dans les trois fils, ta fenêtre ne reçoit que les tableaux.

## Vérification

Un rapport de coéquipier est une affirmation comme une autre. Demande les
citations et ouvre une source au hasard : voir [[Vérifier avant de croire]].
Deux rapports qui se contredisent doivent être signalés, jamais arbitrés en
silence.

## Suite

[[Fenêtre de contexte]] · [[Bien demander]] · [[Vérifier avant de croire]] ·
[[Veille et sourcing]] · [[Skill recherche-sourcee]]
