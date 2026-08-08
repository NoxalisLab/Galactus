---
title: CI-CD et livraison
tags: [métier, ci, livraison]
description: Écrire et déboguer un pipeline, préparer une release, et pourquoi l'app est un bon éditeur de pipeline mais pas un exécuteur.
---

# CI-CD et livraison

## Ce que l'application fait, et ce qu'elle ne fait pas

Elle est excellente pour **écrire, relire et expliquer** un fichier de pipeline,
et pour préparer une release depuis le dépôt local. Elle n'exécute aucun
pipeline : pas d'accès à ton runner, à tes secrets, à tes artefacts. Ce qui
tourne, tourne chez ton fournisseur.

Le connecteur GitHub ([[Connecteurs MCP]]) permet de lire une pull request ou
une issue sans cloner, mais il sort sur le réseau.

## Workflow : déboguer un pipeline qui échoue

1. Récupère le log d'échec **dans un fichier**, ne le colle pas dans le fil.

```
J'ai mis le log du job dans /tmp/ci.log (12 Mo). Ne le lis pas en entier :
run_command("grep -n -i -m 20 'error\|failed\|exit code' /tmp/ci.log")
puis lis 3000 octets autour de la première occurrence réelle et dis-moi la
cause. Cite les numéros de ligne.
```

2. Fais comparer avec le fichier de pipeline, cité ligne à ligne.
3. Fais proposer **un seul** changement, avec la raison.

**Vérification** : le changement doit expliquer l'erreur exacte du log. « Ça
vient probablement du cache » sans ligne de log correspondante est une
hypothèse.

## Workflow : écrire un pipeline

```
Lis .github/workflows/ existant pour les conventions, puis écris un job qui,
sur pull request : installe les dépendances avec le lockfile, lance le linter,
lance les tests, et échoue si la couverture baisse. Commente chaque étape en
une ligne. Ne touche pas aux workflows existants.
```

**Vérification** : `yamllint` ou `python3 -c "import yaml,sys;yaml.safe_load(open('f'))"`
via `run_command`. Un YAML invalide est l'échec le plus fréquent et le plus
bête.

## Workflow : préparer une release

```
run_command("git log --oneline $(git describe --tags --abbrev=0)..HEAD")
Regroupe ces commits en changelog : Ajouts, Corrections, Ruptures. Une ligne
par entrée, en français, sans jargon de commit. Écris-le dans CHANGELOG.md
sans toucher aux versions précédentes.
```

Le `git push` reste une confirmation explicite, jamais silencieuse
([[Vue Code]]).

## Pièges

- **Secret écrit en clair dans le pipeline.** Relis chaque diff, voir
  [[Sécurité applicative]].
- **Version d'action inventée.** Fais citer la version depuis un workflow
  existant du dépôt.
- **Log tronqué mal lu** : la vraie erreur est presque toujours dans les
  dernières lignes, pas la première ligne rouge.

## Voir aussi

[[Tests et qualité]] · [[Développement logiciel]] · [[Systèmes et DevOps]] ·
[[Conteneurs et orchestration]] · [[Serveurs distants en SSH]] ·
[[Sécurité applicative]] · [[Connecteurs MCP]]
