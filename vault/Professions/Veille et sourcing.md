---
title: Veille et sourcing
tags: [métier, recherche, sources]
description: Chercher sur le web sans navigateur, croiser les sources et dater chaque fait.
---

# Veille et sourcing

Il n'y a pas de navigateur intégré. Tout passe par `fetch_url` ou `curl` via
`run_command`, ce qui impose une discipline utile : on récupère des pages
précises, pas des sessions de navigation.

## La règle

Aucun fait sans URL précise **et** sans date de publication. La connaissance
interne du modèle sert à formuler les requêtes, jamais de source
([[Skill recherche-sourcee]]).

## Workflow : question factuelle

```
run_command("date")
/recherche-sourcee Question : quel est le taux de TVA applicable à X en France
au jour d'aujourd'hui ? Sources officielles en priorité, date de publication
pour chacune, deux sources indépendantes minimum, et dis ce que tu n'as pas
trouvé.
```

## Techniques qui économisent la fenêtre

- Point d'entrée léger :
  `curl -sL -m 20 -A "Mozilla/5.0" "https://lite.duckduckgo.com/lite/?q=REQUETE"`.
- Préférer les API JSON aux pages HTML : Wikipedia REST, API GitHub, portails
  open data.
- Toujours borner : `| head -c 20000`, `grep`, `python3` pour extraire.
- Au delà de 20 000 caractères, la sortie part en fichier scratch ; relis par
  sections plutôt que de relancer la requête ([[Fenêtre de contexte]]).

## Workflow : veille récurrente

```
Récupère les 10 derniers billets du blog https://exemple.fr/blog (titre, date,
URL) et compare-les à la liste dans le coffre : Veille/Blog exemple.md.
Ajoute uniquement les nouveaux, en une ligne chacun, avec obsidian_append.
```

Combiné à `/automatisation-mac`, cela devient une tâche hebdomadaire, mais
souviens-toi que le script planifié ne fait que collecter : l'analyse reste
dans une conversation.

## Vérifications

- Deux sources **indépendantes** : deux articles reprenant le même communiqué
  comptent pour une.
- Date de publication, pas date de consultation.
- Étiquetage `[FAIT]`, `[ESTIMATION]`, `[OPINION]`.
- Toute contradiction entre sources est signalée, jamais arbitrée en silence.

## Pièges

- **URL inventée.** Le tell : une URL trop propre, jamais récupérée par un
  appel. Fais-la ouvrir.
- **403 et pages dynamiques.** Beaucoup de sites bloquent `curl` ou n'ont pas
  de contenu sans JavaScript. Après deux échecs, note la limite et change de
  source.
- **Paywall.** Le résumé d'une page bloquée est une invention. Le tell : un
  contenu détaillé alors que la réponse HTTP faisait 2 Ko.

## Voir aussi

[[Skill recherche-sourcee]] · [[Recherche scientifique]] ·
[[Équipes de sous-agents]] · [[Base de connaissances locale]] ·
[[Ce que le modèle rate]] · [[Fenêtre de contexte]]
