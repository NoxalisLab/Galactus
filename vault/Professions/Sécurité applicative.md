---
title: Sécurité applicative
tags: [métier, sécurité, code]
description: Revue de sécurité sur du code local, chasse aux secrets, et la limite claire, ce n'est pas un scanner.
---

# Sécurité applicative

> [!note] Ce que ce n'est pas
> Pas un scanner de vulnérabilités, pas de base CVE, pas d'analyse de
> dépendances à jour. La connaissance du modèle sur les CVE est figée et
> périmée ([[Ce que le modèle rate]]). Pour les dépendances, `npm audit`,
> `pip-audit` ou `cargo audit` via `run_command` restent la source.

Ce que l'application fait très bien, en revanche : une **revue de code
ciblée**, en local, sur du code que tu ne peux pas envoyer à un service en
ligne ([[Tout reste en local]]).

## Workflow : revue ciblée d'un diff

```
run_command("git diff main...HEAD") puis relis chaque hunk en cherchant
uniquement : entrée non validée, requête SQL concaténée, secret en dur,
autorisation manquante, chemin construit depuis une entrée utilisateur,
désérialisation non sûre. Pour chaque trouvaille : fichier:ligne, scénario
d'exploitation en une phrase, correction. Ignore le style.
```

Liste fermée de catégories : c'est ce qui évite le rapport générique.

## Workflow : chasse aux secrets

```
run_command("git grep -nEi '(api[_-]?key|secret|password|token|BEGIN [A-Z ]*PRIVATE KEY)' -- . ':!*.lock'")
Trie les résultats en trois groupes : vrai secret, exemple ou placeholder,
faux positif. Pour chaque vrai secret, dis-moi depuis quel commit il existe
avec git log -S.
```

**Vérification** : un secret trouvé dans l'historique n'est pas réglé par une
suppression du fichier. Il doit être révoqué.

## Workflow : surface d'exposition d'une API

```
Liste toutes les routes de src/api/ avec find_files et search_workspace, puis
pour chacune : méthode, chemin, middleware d'authentification appliqué,
validation d'entrée. Un tableau. Marque "AUCUN" en clair là où il n'y a rien.
```

Les lignes marquées AUCUN sont ta liste de travail.

## Workflow : dépendances

```
run_command("npm audit --json | python3 -c \"import sys,json;d=json.load(sys.stdin);print(d['metadata']['vulnerabilities'])\"")
puis les 5 avis les plus graves, avec le paquet, la version installée et la
version corrigée. N'exécute aucune mise à jour.
```

L'outil fait autorité, pas le modèle.

## Pièges

- **Rapport de sécurité générique** : dix conseils vrais partout et utiles
  nulle part. Le signe est l'absence de `fichier:ligne`. Redemande avec la
  liste fermée de catégories.
- **Fausse assurance** : « aucun problème trouvé » sur un diff de 800 lignes
  après trois appels d'outils. Redécoupe fichier par fichier.

## Voir aussi

[[Backend et API]] · [[Développement logiciel]] · [[CI-CD et livraison]] ·
[[Réseau et infrastructure]] · [[Tout reste en local]] ·
[[Vérifier avant de croire]] · [[Skill dev-senior]]
