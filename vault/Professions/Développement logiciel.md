---
title: Développement logiciel
tags: [métier, code]
description: Le hub du travail sur du code, ce que la Vue Code apporte réellement et les quatre boucles qui marchent.
---

# Développement logiciel

C'est le métier le mieux servi par l'application aujourd'hui : un éditeur, un
agent dans le même fil, des diffs à accepter bloc par bloc, la recherche projet
en Rust et le vrai `git`.

## Modèle à lancer

- Session interactive : **Qwen3-Coder-30B** ou **Qwen3-30B-A3B** (32 Go de
  GGUF, 11,7 tok/s à 16 Go de RAM, 25 tok/s à 24 Go). En dessous de 10 tok/s,
  la boucle outil par outil devient pénible.
- Revue d'architecture, gros raisonnement : **gpt-oss-120b** si tu as 48 Go ou
  plus. Détail dans [[Choisir un modèle]].

## Boucle 1 : comprendre un dépôt inconnu

```
Ouvre /Users/moi/proj. Sans rien modifier : liste la racine, lis README et le
fichier de build, puis dis-moi en 10 lignes maximum le point d'entrée, la
commande de test, la commande de build et les 3 dossiers qui portent la
logique. Cite un fichier pour chaque affirmation.
```

**Vérification** : ouvre les fichiers cités. Un point d'entrée non cité est une
supposition ([[Vérifier avant de croire]]).

## Boucle 2 : corriger un bug

`/dev-senior`, puis le symptôme exact et la commande qui le reproduit. La skill
exige la reproduction avant le correctif et le test qui passe après
([[Skill dev-senior]]).

**Vérification** : le test qui échouait doit échouer avant et passer après.
Relance-le toi-même, ne te contente pas du rapport.

## Boucle 3 : refactor borné

```
Dans src/, remplace tous les appels à formatDate(x) par formatDate(x, tz).
Trouve d'abord toutes les occurrences avec search_workspace, montre-moi la
liste, et attends mon accord avant de proposer le moindre diff.
```

**Vérification** : le nombre d'occurrences trouvées doit être égal au nombre de
diffs proposés. Un écart signale un oubli ou un excès de zèle.

## Boucle 4 : revue de code

```
Voici le diff de ma branche : run_command("git diff main...HEAD").
Relis-le hunk par hunk. Pour chaque problème : fichier:ligne, gravité,
correction en une phrase. Ignore le style, cible correction et sécurité.
```

## Pièges de ce métier

| Piège | Tell | Parade |
|---|---|---|
| API inventée | signature élégante, aucune citation | Exiger l'ouverture du fichier source |
| Refactor rampant | des diffs sur des fichiers hors sujet | Refuser ces blocs, la Vue Code le permet |
| Test affaibli | une assertion supprimée dans le diff | Relire chaque hunk de test |
| Boucle de 30 appels atteinte | il s'arrête au milieu | Redécouper en deux messages |

## Faiblesse honnête

**Rust et C sont en niveau syntaxe** : ni rust-analyzer ni clangd dans le
bundle. Le modèle peut affirmer une signature fausse sans que rien ne le
contredise. Sur ces langages, compile après chaque proposition, c'est la seule
preuve.

## Voir aussi

[[Vue Code]] · [[Skill dev-senior]] · [[Web full-stack]] · [[Tests et qualité]] ·
[[Sécurité applicative]] · [[CI-CD et livraison]] · [[Choisir un modèle]] ·
[[Ce que le modèle rate]]
