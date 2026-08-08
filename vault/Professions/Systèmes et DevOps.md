---
title: Systèmes et DevOps
tags: [métier, ops, ssh]
description: Le hub du travail système, du Mac local aux serveurs distants, et les quatre routines qui reviennent chaque semaine.
---

# Systèmes et DevOps

Tout passe par `run_command`, un `zsh` sur ce Mac. Cela couvre le local et, via
`ssh`, tout ce que ta configuration SSH atteint ([[Serveurs distants en SSH]]).

## Les contraintes structurantes

120 secondes par commande, aucune interactivité, sortie tronquée à 200 Ko. Elles
dictent la forme de chaque routine ci-dessous.

## Routine 1 : tour de parc matinal

```
/serveurs-distants Pour prod01, prod02 et db01 : une seule commande ssh par
machine en BatchMode, avec uptime, df -h /, charge, et systemctl --failed.
Rends un tableau unique, une ligne par machine, colonne verdict.
Signale toute partition au delà de 85 %.
```

Sur plus de trois machines, un coéquipier par machine
([[Équipes de sous-agents]]) : chacun garde son propre contexte, tu ne reçois
que les tableaux.

## Routine 2 : un service ne répond plus

Ordre imposé, jamais l'inverse : constater, lire, comprendre, agir.

```
Sur prod01, sans rien redémarrer : systemctl status api, les 30 dernières
lignes ERROR du journal de l'heure, l'espace disque, et les connexions en
écoute sur le port. Puis dis-moi ce que tu recommandes et pourquoi.
```

Ensuite seulement, l'action, montrée avant exécution, suivie d'un test
fonctionnel.

## Routine 3 : automatiser une tâche locale

`/automatisation-mac` : script `zsh` avec `set -euo pipefail`, test à blanc
obligatoire, tâche `launchd` en espace utilisateur, log dans
`~/Library/Logs/`, et la commande de désinstallation
([[Skill automatisation-mac]]).

## Routine 4 : audit d'une configuration

```
Lis /etc/nginx/nginx.conf et les fichiers inclus (liste-les d'abord).
Rends un tableau : directive, valeur, risque ou remarque. Ne propose aucune
modification tant que je n'ai pas vu ce tableau.
```

## Vérifications non négociables

| Action | Preuve exigée |
|---|---|
| Service redémarré | `systemctl status` plus un appel fonctionnel réussi |
| Fichier copié | `ls -l` et une somme de contrôle des deux côtés |
| Configuration modifiée | le test natif (`nginx -t`, `sshd -t`) avant de recharger |
| Espace libéré | `df -h` avant et après |

## Faiblesse honnête

Pas de `sudo` interactif, pas de session persistante : chaque `run_command` est
un shell neuf, un `cd` ne survit pas d'un appel à l'autre. Écris des commandes
à chemin absolu, ou chaîne-les dans un seul appel.

## Voir aussi

[[Serveurs distants en SSH]] · [[Skill serveurs-distants]] ·
[[Observabilité et incidents]] · [[Réseau et infrastructure]] ·
[[Conteneurs et orchestration]] · [[Infrastructure as code]] ·
[[Skill automatisation-mac]] · [[Niveaux d'autonomie]]
