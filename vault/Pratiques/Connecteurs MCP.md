---
title: Connecteurs MCP
tags: [pratique, mcp, intégration]
description: Brancher des outils externes sur l'agent, ce que contient le catalogue et ce que cela coûte.
---

# Connecteurs MCP

Un connecteur MCP ajoute des outils à l'agent. Ils s'activent dans les réglages,
avec un ou deux champs à remplir, jamais du JSON à la main. Chaque appel à un
outil MCP passe par la barrière de permission, et une règle permanente porte sur
le **serveur**, pas sur le web entier.

## Le catalogue livré

| Connecteur | Ce qu'il apporte | À fournir |
|---|---|---|
| Fichiers | un dossier de travail supplémentaire pour l'assistant | le dossier |
| GitHub | dépôts, issues, pull requests | un token personnel |
| Web | récupération et lecture de pages | nécessite `uv` (`uvx`) installé |
| Raisonnement structuré | réflexion étape par étape | rien |
| Graphe de connaissances | une mémoire persistante en graphe | rien |

Un serveur personnalisé s'ajoute avec sa commande et ses arguments.

> [!warning] Ces connecteurs ne sont pas hors ligne
> Ils sont lancés via `npx` ou `uvx` : ils téléchargent leur paquet et, pour
> GitHub, sortent sur le réseau. Le reste de l'application fonctionne sans
> réseau ; un connecteur, non. Voir [[Tout reste en local]].

## Quand un connecteur vaut le coût

- **GitHub** : triage d'issues, lecture d'une pull request sans la cloner. Voir
  [[CI-CD et livraison]].
- **Graphe de connaissances** : suivre des entités au fil des sessions, par
  exemple des clients, des serveurs, des tickets.
- **Fichiers** : donner accès à un dossier hors de l'espace de travail ouvert.

## Quand il n'en vaut pas la peine

Chaque connecteur actif ajoute ses schémas d'outils au prompt, donc consomme du
contexte à chaque tour ([[Fenêtre de contexte]]). Trois connecteurs actifs « au
cas où » réduisent la place utile pour ton travail. Active, utilise, désactive.

## Vérification

Un outil MCP est du code tiers. Demande toujours la sortie brute :

```
Appelle l'outil MCP, puis montre-moi exactement ce qu'il a renvoyé avant de
l'interpréter.
```

## Suite

[[Outils de l'assistant]] · [[Tout reste en local]] · [[Systèmes et DevOps]] ·
[[Développement logiciel]] · [[Niveaux d'autonomie]]
