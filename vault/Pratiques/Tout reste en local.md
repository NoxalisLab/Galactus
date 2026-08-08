---
title: Tout reste en local
tags: [pratique, confidentialité, conformité]
description: Ce qui ne quitte jamais le Mac, ce qui peut en sortir, et pourquoi c'est un argument professionnel.
---

# Tout reste en local

L'application est autonome et hors ligne : le moteur, ses bibliothèques, un
Python 3.12 privé, la dictée et les outils documents sont dans le bundle. Pas de
compte, pas de clé d'API, pas de télémétrie. Le modèle tourne sur ce Mac.

## Ce qui ne sort jamais

- Les conversations, les fichiers lus, les documents analysés, le contenu du
  coffre, l'index de la base de connaissances, la mémoire.
- L'inférence : le calcul se fait sur ce Mac, y compris pour un modèle de
  744 milliards de paramètres.
- La dictée : la reconnaissance vocale utilise le service de macOS, sur
  l'appareil.

## Ce qui peut sortir, et seulement sur une action

| Chemin de sortie | Déclenché par | Garde-fou |
|---|---|---|
| `fetch_url` | le modèle, pour une URL | autorisation, « toujours » limité à l'origine du site |
| `curl` via `run_command` | le modèle | barrière shell, commande visible |
| Connecteurs MCP | toi, en les activant | [[Connecteurs MCP]] |
| API locale compatible OpenAI | toi, si tu la consommes | écoute sur `127.0.0.1`, port 8737 par défaut |
| `git push` | toi | confirmation explicite, jamais silencieuse |

Pour un travail strictement confiné : n'active aucun connecteur, et refuse tout
appel `fetch_url` ou `curl`. Tu peux le poser en consigne :

```
Aucun accès réseau pour cette session. N'appelle ni fetch_url ni curl. Si une
information te manque, dis-le au lieu d'aller la chercher.
```

## Pourquoi c'est un argument, pas une commodité

Pour des données de santé, des dossiers clients, des pièces d'un litige, des
données financières non publiques, l'usage d'un assistant en ligne implique un
transfert vers un sous-traitant, un contrat, une base légale, souvent une
analyse d'impact. Un traitement entièrement local supprime le transfert. C'est
la différence qui rend l'outil utilisable là où un assistant cloud ne l'est pas.

Voir [[Santé et données patients]] pour le détail du cadre, et
[[Skill donnees-sensibles]] pour la procédure.

> [!note] Local ne veut pas dire conforme
> Le fichier reste sur un portable. Chiffrement du disque, sauvegardes,
> verrouillage de session et gestion des accès restent ta responsabilité.

## Suite

[[Santé et données patients]] · [[Skill donnees-sensibles]] ·
[[Administratif et gestion documentaire]] · [[Connecteurs MCP]] ·
[[Finance quantitative et corporate]]
