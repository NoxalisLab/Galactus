---
title: Coffre et Constellation
tags: [pratique, obsidian, coffre]
description: Comment l'assistant lit et écrit ce coffre, et ce que la vue Constellation montre réellement.
---

# Coffre et Constellation

## Les quatre outils du coffre

| Outil | Effet | Garde-fou |
|---|---|---|
| `obsidian_search` | cherche des notes correspondant à une requête | lecture |
| `obsidian_read` | lit une note, chemin relatif au coffre | lecture |
| `obsidian_append` | ajoute à la fin d'une note, la crée si absente | autorisation |
| `obsidian_update` | réécrit la note **entièrement** | autorisation, avec diff |

Tous refusent les chemins qui sortent du coffre. Ils n'apparaissent que si un
coffre est configuré dans les réglages, ou créé depuis l'application.

> [!warning] `obsidian_update` remplace tout
> Il faut avoir lu la note avant. Pour ajouter, `obsidian_append` est plus sûr.
> La demande d'autorisation montre le diff : lis-le.

## La Constellation

La vue rend le graphe des wikilinks en 3D : une étoile par note, une arête par
lien, la taille suivant le nombre de liens. Clique une étoile pour lire ou
éditer la note.

Ce que la vue ignore, et qui explique les surprises :

- Elle résout les liens sur le **nom de fichier**, sans extension et sans tenir
  compte de la casse. `[[Vue Code]]` et `[[vue code]]` pointent la même note.
- Un lien écrit sous la forme `dossier/Note` est résolu sur le dernier
  segment.
- Un lien vers une note inexistante **n'affiche aucune arête**. Une note isolée
  dans la vue est presque toujours un lien mal orthographié.
- Les notes sont plafonnées à 2500, la profondeur à 8 niveaux, la lecture de
  chaque note à 200 Ko pour l'extraction des liens.
- Deux notes de même nom dans deux dossiers : la première rencontrée gagne.
  Évite les doublons de nom.

## Faire entretenir le coffre par l'assistant

```
Cherche dans le coffre les notes qui parlent de déploiement, liste-les avec
leur chemin, puis dis-moi lesquelles ne sont citées par aucune autre note.
```

```
Ajoute à la fin de Professions/Systèmes et DevOps.md une section "Journal" avec
la date du jour et ce que nous venons de faire, en 4 puces maximum.
Utilise obsidian_append, pas obsidian_update.
```

Toute note ajoutée doit respecter [[Conventions du coffre]], sinon elle devient
un orphelin invisible.

## Suite

[[Conventions du coffre]] · [[Base de connaissances locale]] ·
[[Rédaction technique]] · [[Outils de l'assistant]] · [[Accueil]]
