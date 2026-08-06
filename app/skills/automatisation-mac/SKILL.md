---
name: automatisation-mac
description: "À utiliser quand tu dois automatiser une tâche sur le Mac de l'utilisateur : script zsh, tâche planifiée (launchd/cron) ou pilotage d'apps via AppleScript."
---

## Règles d'or ; aucune exception
- Montre TOUJOURS le script complet et résume ce qu'il fait AVANT de l'exécuter.
- JAMAIS de `rm -rf` sans avoir listé la cible juste avant (`ls -la "cible"`) et fait valider. Préfère `mv` vers `~/.Trash/`.
- Jamais de `sudo` ni de `/Library/LaunchDaemons` : reste en espace utilisateur (`~/Library/LaunchAgents`).
- Avant toute modif de config : `cp "$f" "$f.bak.$(date +%Y%m%d%H%M%S)"`.
- Tout script : `#!/bin/zsh` + `set -euo pipefail`, chemins et variables TOUJOURS entre guillemets (`"$var"`) ; les chemins Mac contiennent des espaces (`Application Support`).

## 1. Cadre la demande
- Identifie : quoi automatiser, quels fichiers/apps, ponctuel ou récurrent.
- Vérifie que les cibles existent : `list_directory` sur les dossiers, `read_file` sur les configs. Ne suppose jamais un chemin.

## 2. Écris le script
- Variables en tête, chemins absolus, pas de `cd` implicite.
- Sauvegarde via `write_file` (ex. `~/Scripts/nom.sh`) puis `chmod +x` via `run_command` ; write_file ne pose pas les droits d'exécution.

## 3. Test à blanc ; obligatoire avant toute action réelle
- Préfixe les commandes qui modifient/suppriment par `echo`, ou utilise le dry-run natif : `rsync -n`, `--dry-run`.
- Lance via `run_command`, montre la liste exacte des fichiers touchés, fais valider.

## 4. Exécution réelle
- Seulement après validation du dry-run. Timeout 120 s ; sortie longue → fichier scratch, relis-le par sections avec `read_file(offset)`.
- Prouve le résultat : code retour, `ls` du dossier cible, relecture du fichier modifié.

## 5. Piloter les apps : AppleScript
- Action courte : `osascript -e 'tell application "Mail" to activate'`. Multi-lignes : écris un `.applescript` via `write_file` puis `osascript "fichier.applescript"` ; évite l'échappement des quotes dans `-e`.
- Teste d'abord une action inoffensive (`activate`, `get name`) avant une action qui modifie des données.
- Première exécution : macOS demandera une autorisation (Réglages > Confidentialité et sécurité > Automatisation). Préviens l'utilisateur.

## 6. Tâches récurrentes : launchd (préféré) ou cron
- AVANT d'installer : explique fréquence, fichier créé, désinstallation. Attends l'accord.
- Plist dans `~/Library/LaunchAgents/com.user.nom.plist` ; redirige stdout/stderr du job vers `~/Library/Logs/nom.log`.
- Valide avec `plutil -lint "chemin.plist"`, puis charge : `launchctl bootstrap gui/$(id -u) "chemin.plist"` (si déjà chargé : `bootout` d'abord). Vérifie : `launchctl list | grep com.user`.
- Teste sans attendre l'horaire : `launchctl kickstart -k "gui/$(id -u)/com.user.nom"` puis lis le log. Si `Operation not permitted` dedans : dossier protégé (Bureau/Documents), explique le blocage TCC.
- cron : lis l'existant (`crontab -l`), sauvegarde-le dans un fichier, puis ajoute ; jamais d'écrasement aveugle.

## 7. Vérifie et conclus
- Preuve vérifiable par tes outils : fichier créé, job listé, log rempli.
- Job récurrent : donne la commande exacte de désinstallation (`launchctl bootout gui/$(id -u) "chemin.plist"`).
- Propose `remember(...)` pour les choix durables (dossier de scripts, labels launchd).
