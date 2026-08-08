---
title: Base de connaissances locale
tags: [pratique, recherche, local]
description: L'index BM25 sur tes dossiers, ce qu'il indexe vraiment et comment l'interroger utilement.
---

# Base de connaissances locale

Tu désignes des dossiers dans les réglages, l'application les indexe en local,
et l'assistant gagne l'outil `search_knowledge`. Tout est en Rust, hors ligne,
sans dépendance externe.

## Ce que l'index fait exactement

- Classement **BM25** sur le texte, pas de recherche sémantique. Cherche les
  **mots qui figurent dans le document**, pas une paraphrase.
- Découpage en morceaux d'environ **1400 caractères** avec 200 de recouvrement.
  Un résultat rend un extrait de 700 caractères au plus, avec chemin et ligne.
- Extensions indexées : `txt md markdown rst csv json yaml yml toml ini conf
  html htm tex log`, plus le code `rs py js ts tsx swift c cpp h hpp java kt go
  rb sh sql`.
- Ignorés : fichiers de plus de 2 Mo, profondeur au delà de 8 niveaux, et les
  dossiers `node_modules .git target build dist __pycache__ venv`.
- L'index est un fichier JSON dans le dossier de l'application, reconstruit à la
  demande.

> [!warning] Les PDF ne sont pas indexés
> BM25 ne lit que du texte. Pour un corpus de PDF, convertis-les d'abord en
> markdown ou en txt dans un dossier indexé, puis réindexe. Voir
> [[Documents et OCR]].

## Bien s'en servir

```
Cherche dans ma base "clause de résiliation anticipée", prends 8 résultats,
puis ouvre les 2 fichiers les plus pertinents avec read_file et cite les
passages avec leur chemin et leur ligne.
```

- Emploie le **vocabulaire du document**, pas le tien. BM25 ne devine pas les
  synonymes.
- Deux requêtes précises valent mieux qu'une requête vague.
- L'extrait n'est pas la source : fais toujours ouvrir le fichier avant de
  citer ([[Vérifier avant de croire]]).

## Convertir un corpus PDF pour l'index

```
Dans /Users/moi/docs, liste les PDF. Pour chacun, lis-le avec read_document et
écris le texte dans /Users/moi/docs-texte/<même nom>.md avec, en tête, le
chemin du PDF d'origine. Ne saute aucun fichier, dis-moi ceux qui échouent.
```

Ajoute ensuite `/Users/moi/docs-texte` aux dossiers indexés.

## Complémentarité

- `search_knowledge` : tes dossiers de référence, stables, volumineux.
- `obsidian_search` : ce coffre, ta méthode et tes notes
  ([[Coffre et Constellation]]).
- `search_workspace` : le code ouvert ([[Vue Code]]).
- `search_conversations` : ce que tu as déjà dit dans un fil précédent.

## Suite

[[Veille et sourcing]] · [[Documents et OCR]] · [[Recherche scientifique]] ·
[[Administratif et gestion documentaire]] · [[Outils de l'assistant]]
