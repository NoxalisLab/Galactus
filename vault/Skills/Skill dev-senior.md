---
title: Skill dev-senior
tags: [skill, code]
description: Procédure d'ingénieur senior pour corriger, ajouter ou relire du code dans un projet existant.
---

# Skill dev-senior

`/dev-senior` impose la discipline qui manque le plus souvent à un modèle sur du
code : comprendre avant de modifier, patcher au minimum, prouver par les tests.

## Ce qu'elle force

- `git status` en premier, et les modifications déjà présentes ne sont jamais
  annulées : elles appartiennent à l'utilisateur.
- Lecture ciblée, jamais l'arbre entier ; repérage du build, des tests et du
  linter dans README, `package.json`, `Makefile`, `pyproject.toml`.
- Reproduire le bug avant de le corriger.
- Patch minimal, style du projet respecté, pas de refactor opportuniste.
- Tests puis linter puis build, avec la sortie brute.
- Relecture du `git diff` hunk par hunk, chasse aux `print` de debug et aux
  secrets.
- Pas de commit sans demande explicite, pas de `git add -A`.

## Exemple

```
/dev-senior Le test tests/test_auth.py::test_refresh échoue depuis hier.
Reproduis-le, trouve la cause, corrige au minimum, relance ce seul test puis
la suite du dossier tests/auth. Ne committe pas.
```

## Ses limites

Deux tentatives de correction ratées et elle s'arrête pour te rendre le
diagnostic. C'est voulu : au troisième essai à l'aveugle, le modèle casse plus
qu'il ne répare.

## Voir aussi

[[Développement logiciel]] · [[Vue Code]] · [[Tests et qualité]] ·
[[Backend et API]] · [[Frontend]] · [[Skills et invocation]]
