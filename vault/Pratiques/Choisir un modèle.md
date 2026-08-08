---
title: Choisir un modèle
tags: [pratique, modèle, performance]
description: Le compromis taille, vitesse et RAM, avec les débits mesurés du catalogue.
---

# Choisir un modèle

Le catalogue affiche pour chaque modèle ce qui tient sur **ce** Mac, avec des
vitesses estimées à partir de mesures réelles, pas de promesses. Le bouton
Mesurer relance un bench sur le modèle chargé et remplace l'estimation par ta
valeur.

## Débits mesurés, en tokens par seconde

| Modèle | GGUF | RAM mini | 16 Go | 24 Go | 48 Go | 64 Go | 128 Go |
|---|---|---|---|---|---|---|---|
| Qwen3-30B-A3B (Q8_0) | 32 Go | 16 Go | 11,7 | 25,0 | 28,7 | | |
| Qwen3-Coder-30B (Q8_0) | 32 Go | 16 Go | proche du précédent, certification en cours | | | | |
| Qwen3-Next-80B (Q4_K_M) | 48 Go | 16 Go | | | | | 22,6 mesuré à 96 Go |
| gpt-oss-120b | 65 Go | 16 Go | 4,6 | 7,2 | 17,6 | 18,7 | 19,4 |
| Llama-4 Scout 17B-16E | 65 Go | 24 Go | | 3,7 | 10,1 | 10,7 | 14,4 |
| GLM-4.5-Air 106B-A12B | 73 Go | 32 Go | | 2,7 | 4,8 | 6,6 | 8,2 à 96 Go |
| Qwen3-235B-A22B | 142 Go | 24 Go | | 1,1 | 2,2 | 3,5 | 7,0 |
| GLM-5.2 744B (UD-IQ1_S) | 202 Go | 64 Go | | | | | ~6 sur M5 Max 128 Go |

La RAM minimale est un plancher de fonctionnement, pas un confort : en dessous
de 24 Go, les gros modèles tournent en streaming depuis le SSD et le débit
s'effondre.

## Règles de choix

- **Travail interactif** (code, refactor, va-et-vient, [[Vue Code]]) : prends le
  plus rapide qui reste correct, Qwen3-30B-A3B ou Qwen3-Coder-30B. En dessous de
  10 tok/s, une session de code devient pénible.
- **Synthèse de documents, rédaction longue, raisonnement** : un gros modèle
  lent est acceptable, tu envoies peu de tours. gpt-oss-120b offre le meilleur
  rapport vitesse/qualité au delà de 48 Go, GLM-5.2 744B est le plafond de
  qualité si tu as 128 Go et deux SSD.
- **Agents et outils en boucle** : la vitesse compte double, chaque appel
  d'outil est un aller-retour. Reste sur un modèle rapide.
- **Un modèle à la fois.** Changer de modèle redémarre le moteur.

## Certification

Chaque modèle du catalogue passe par le chemin numérique certifié de Galactus,
jamais par un repli natif. Les étiquettes des cartes : `certifié
bit-transparent` (identique à llama.cpp d'origine), `certifié`, `certifié par
composition`, et `certification en cours` pour Qwen3-Coder-30B.

## Contexte, quel que soit le modèle

8192 tokens par conversation. Un modèle plus gros ne donne pas une fenêtre plus
grande, voir [[Fenêtre de contexte]].

## Suite

[[Fenêtre de contexte]] · [[Développement logiciel]] · [[Data et IA]] ·
[[Outils de l'assistant]] · [[Ce que le modèle rate]]
