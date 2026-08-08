---
title: Skill serveurs-distants
tags: [skill, ops, ssh]
description: Procédure pour agir sur une machine distante en SSH, du diagnostic au déploiement suivi.
---

# Skill serveurs-distants

`/serveurs-distants` encadre le travail sur des machines qui ne sont pas ce Mac.
Elle part des contraintes réelles de `run_command` : 120 secondes, aucune
interactivité, sortie tronquée.

## Ce qu'elle force

- Lecture de `~/.ssh/config` d'abord, et uniquement des alias existants, jamais
  une IP devinée.
- Préfixe `ssh -o BatchMode=yes -o ConnectTimeout=8` sur chaque appel, pour
  échouer proprement au lieu d'attendre un mot de passe.
- Diagnostic d'état en un seul aller-retour, restitué en tableau avec verdict.
- Logs filtrés côté serveur : compter d'abord, lire ensuite, jamais `tail -f`.
- Toute action qui modifie l'état est montrée, validée, exécutée seule, puis
  prouvée par un test fonctionnel.
- Tâche longue lancée en `nohup` avec un log, puis suivie dans un appel séparé.
- `rsync --dry-run` avant toute synchronisation.

## Exemple

```
/serveurs-distants Sur prod01, l'API répond en 502 depuis 20 minutes.
Diagnostique sans rien redémarrer : état du service, 30 dernières lignes
d'erreur, espace disque, et dis-moi ce que tu recommandes.
```

## Ses limites

Pas de `sudo` interactif, pas de mot de passe tapé. Sur une machine sans clé
configurée, elle te le dit au lieu d'essayer.

## Voir aussi

[[Serveurs distants en SSH]] · [[Systèmes et DevOps]] ·
[[Observabilité et incidents]] · [[CI-CD et livraison]] ·
[[Réseau et infrastructure]] · [[Skills et invocation]]
