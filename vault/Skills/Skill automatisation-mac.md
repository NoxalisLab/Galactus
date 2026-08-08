---
title: Skill automatisation-mac
tags: [skill, mac, automatisation]
description: Écrire un script zsh, une tâche launchd ou un AppleScript sur ce Mac, avec test à blanc obligatoire.
---

# Skill automatisation-mac

`/automatisation-mac` sert à automatiser une tâche locale : script, tâche
planifiée, pilotage d'une application.

## Ce qu'elle force

- Le script complet montré et résumé **avant** exécution.
- Pas de `rm -rf` sans avoir listé la cible juste avant ; préférence pour un
  déplacement vers la corbeille.
- Jamais de `sudo`, jamais de `/Library/LaunchDaemons` : espace utilisateur
  seulement.
- Sauvegarde horodatée avant toute modification de configuration.
- `#!/bin/zsh`, `set -euo pipefail`, chemins entre guillemets car les chemins
  Mac contiennent des espaces.
- Un **test à blanc obligatoire** (`echo`, `rsync -n`, `--dry-run`) avec la
  liste exacte des fichiers touchés, validée avant l'exécution réelle.
- Pour une tâche récurrente : plist validée par `plutil -lint`, chargée par
  `launchctl bootstrap`, testée par `kickstart`, et la commande de
  désinstallation donnée.

## Exemple

```
/automatisation-mac Chaque jour à 19 h, sauvegarde ~/Documents/Contrats vers
/Volumes/Backup/Contrats en rsync incrémental, log dans
~/Library/Logs/backup-contrats.log. Dry-run d'abord.
```

## Voir aussi

[[Systèmes et DevOps]] · [[Administratif et gestion documentaire]] ·
[[Serveurs distants en SSH]] · [[Outils de l'assistant]] ·
[[Skills et invocation]]
