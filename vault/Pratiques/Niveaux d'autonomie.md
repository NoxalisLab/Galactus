---
title: Niveaux d'autonomie
tags: [pratique, sécurité]
description: Ce que changent réellement les modes manuel, assisté et autonome, et la barrière de permission.
---

# Niveaux d'autonomie

Trois modes, cyclés avec `Maj+Tab` dans le composeur, ou choisis dans les
réglages de l'agent.

| Mode | Comportement | Boucle d'outils | Autorisations |
|---|---|---|---|
| **Manuel** | Répond, agit peu, revient vers toi | 12 appels max par tour | Chaque action demandée |
| **Assisté** | Mode agent : plan puis exécution | 30 appels max par tour | Chaque action demandée |
| **Autonome** | Mode agent, actions ordinaires pré-approuvées | 30 appels max par tour | Seules les actions élevées demandent |

En mode agent (assisté et autonome), le modèle publie d'abord une checklist via
`update_plan` puis la fait avancer, et il exécute au lieu d'expliquer.

## La barrière de permission

Chaque action sensible ouvre une boîte : lecture de fichier, écriture, shell,
web, note du coffre, mémoire, appel MCP, délégation. La boîte montre le détail,
et pour une écriture **le diff complet avant application**.

Trois réponses : une fois, toujours, refuser. « Toujours » crée une règle
permanente, et sa portée est volontairement étroite :

- lecture de fichier : le **dossier** parent
- URL : l'**origine** du site, pas le web entier
- shell, écriture, note du coffre, mémoire : la chaîne **exacte**, rien de plus
  large

Les règles permanentes se listent et se révoquent dans les réglages.

## Les actions élevées demandent toujours

Même en mode autonome, même avec une règle permanente :

- `rm` avec `-r` ou `-f` sous toutes ses formes, `shred`, `dd of=/dev/…`,
  `find -delete`, `git reset --hard`, `git clean`, `git checkout -- `
- un shell imbriqué (`sh -c`, `zsh -lc`, `bash -c`) dont le contenu est opaque
  au filtre
- une écriture dans `/System`, `/Library`, `/usr`, `/bin`, `/sbin`, `/etc`,
  `/private`, dans `~/.ssh/`, dans `LaunchAgents`, dans `.zshrc` et consorts, ou
  dans un dossier `bin` du PATH

Ces boîtes exigent de taper `ALLOW`. `git push` est toujours confirmé
explicitement et ne peut jamais devenir silencieux.

## Quel mode quand

- **Manuel** : exploration d'un dépôt inconnu, sujet sensible, tu veux lire
  chaque étape. Voir [[Santé et données patients]].
- **Assisté** : le défaut. Refactor, analyse, rédaction, tu vois passer chaque
  écriture avec son diff.
- **Autonome** : tâche longue et répétitive dont le périmètre est clair, par
  exemple une passe de tests sur un dossier, un inventaire, une migration de
  notes. À éviter sur une machine de production distante, voir
  [[Serveurs distants en SSH]].

> [!tip] Combinaison qui marche
> Autonome et [[Vue Code]] : le modèle travaille vite, mais rien n'atteint le
> disque sans que tu acceptes le diff, bloc par bloc.

## Suite

[[Bien demander]] · [[Vue Code]] · [[Serveurs distants en SSH]] ·
[[Outils de l'assistant]] · [[Équipes de sous-agents]]
