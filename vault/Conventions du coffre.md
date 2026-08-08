---
title: Conventions du coffre
tags: [meta, méthode]
description: Règles d'écriture des notes, imposées par la fenêtre de 8192 tokens.
---

# Conventions du coffre

Ces règles ne sont pas esthétiques. L'assistant lit ce coffre dans une fenêtre
de 8192 tokens partagée avec la conversation, les schémas d'outils et les
résultats d'outils (voir [[Fenêtre de contexte]]). Une note trop longue force un
résumé, et un résumé perd des faits.

## Taille

- **Une note = deux lignes de résumé.** Si tu ne peux pas résumer la note en
  deux lignes, elle contient deux sujets : coupe-la.
- Cible : 40 à 130 lignes, moins de 6 Ko. Au delà, `obsidian_read` mange un
  quart du budget de la conversation pour une seule note.
- Pas de note fourre-tout. Un fourre-tout est illisible pour le modèle comme
  pour toi.

## Structure

- Frontmatter YAML obligatoire : `title`, `tags`, `description` en une ligne.
  `obsidian_search` classe sur le texte, une description précise fait remonter
  la bonne note.
- Un titre `#` unique, puis des sections `##` courtes.
- Les blocs de commandes et de prompts sont en blocs de code. L'assistant les
  recopie tels quels, une commande approximative devient une commande fausse.
- Callouts `> [!note]`, `> [!warning]`, `> [!tip]` uniquement quand ils portent
  une information qui doit sauter aux yeux, jamais pour décorer.

## Liens

- Les liens entre doubles crochets sont la structure de navigation, pas de
  la décoration.
  Chaque note pointe vers 3 à 8 notes voisines et est pointée par au moins une.
- Pas de note orpheline. Une note sans lien entrant n'est jamais retrouvée, ni
  par toi dans [[Coffre et Constellation]], ni par le modèle.
- Les hubs sont les pratiques transverses : elles sont citées par tous les
  métiers, c'est ce qui donne au graphe sa forme d'étoiles multiples plutôt que
  de liste.

## Contenu

- Une note décrit ce que l'application **fait aujourd'hui**. Une promesse fausse
  coûte plus cher qu'une absence de note : le modèle la lira comme un fait et
  bâtira dessus.
- Toute limite connue est écrite en une ligne, avec le contournement.
- Français, termes techniques et identifiants de code en anglais.

Retour à l'[[Accueil]].
