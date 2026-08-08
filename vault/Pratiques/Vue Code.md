---
title: Vue Code
tags: [pratique, code]
description: L'éditeur intégré, les propositions de diff acceptées bloc par bloc et ce que chaque niveau d'intelligence donne par langage.
---

# Vue Code

Ouvre un dossier et l'application devient un éditeur, avec le même fil d'agent à
côté. La propriété essentielle : **tout ce que le modèle écrit dans ce dossier
est une proposition**, un diff en attente que tu acceptes ou refuses bloc par
bloc. Rien n'atteint le disque autrement.

## Les trois niveaux d'intelligence

L'en-tête du fichier affiche le niveau actif, en direct, par fichier.

| Niveau | Ce que tu obtiens | Langages |
|---|---|---|
| **Complet** | types, survol, aller à la définition, références, renommage | JavaScript, TypeScript |
| **Syntaxe** | plan du fichier, fil d'Ariane, erreurs de syntaxe, recherche projet, palette de symboles | Python, Rust, C, JSON, Markdown, HTML, CSS |
| **Simple** | numéros de ligne, recherche, annuler | tout le reste |

Python ajoute au niveau syntaxe une `SyntaxError` exacte et un plan exact,
produits par le CPython 3.12 embarqué.

> [!warning] Rust et C sont en niveau syntaxe
> Il n'y a ni rust-analyzer ni clangd dans le bundle, et l'application ne
> télécharge rien en douce. Sur ces langages, les affirmations du modèle sur les
> types ne sont vérifiées par aucun outil : compile, voir [[Tests et qualité]].

## Outils réservés à l'espace de travail

Quand un dossier est ouvert, deux outils supplémentaires apparaissent, confinés
à ce dossier et en lecture seule :

- `search_workspace` : recherche de chaîne littérale, retourne
  `chemin:ligne:colonne`
- `find_files` : recherche de chemin, respecte `.gitignore`

Préfère-les à `run_command("grep")` : pas de shell, pas de sortie du dossier,
pas de barrière shell à franchir.

Raccourcis : `Cmd+P` fichiers, `Maj+Cmd+O` symboles, `Maj+Cmd+F` recherche
projet.

## Git

Le panneau utilise ton vrai `git`. Le commit montre la liste exacte des fichiers
avant de partir. `push` et `pull` sont toujours confirmés explicitement et
aucune règle permanente ne peut les rendre silencieux. Si ce Mac n'a pas de
`git`, le panneau le dit et ne déclenche jamais l'installateur des Command Line
Tools d'Apple.

## Boucle de travail conseillée

1. Ouvre le dossier, mets-toi en assisté ou autonome ([[Niveaux d'autonomie]]).
2. `/dev-senior` puis la demande, avec chemins absolus.
3. Le modèle propose ses diffs, tu les lis. Refuse les blocs hors sujet.
4. Fais tourner les tests via `run_command` et exige la sortie brute.
5. Relis `git diff` avant de committer.

## Suite

[[Développement logiciel]] · [[Skill dev-senior]] · [[Tests et qualité]] ·
[[Niveaux d'autonomie]] · [[Vérifier avant de croire]] · [[Web full-stack]]
