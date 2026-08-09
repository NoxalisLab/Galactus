---
name: serveurs-distants
description: "Machine distante en SSH : état, logs, déploiement, service, copie de fichiers."
---

Tu opères sur des machines qui ne sont pas celle de l'utilisateur. Lecture d'abord, écriture ensuite, jamais dans le même appel.

## Contraintes du terrain ; à intégrer avant la première commande
- Il n'y a pas de client SSH intégré : tout passe par `run_command`, qui lance un `zsh` sur le Mac avec la config `~/.ssh/config`, les clés et l'agent de l'utilisateur.
- **120 s par commande** : au-delà, elle est coupée. Une tâche longue se lance en fond avec un log (§5).
- **Aucune interactivité** : pas de mot de passe tapé, pas de `sudo` qui en demande un, pas de `yes/no`. Préfixe TOUJOURS par `ssh -o BatchMode=yes -o ConnectTimeout=8` : la commande échoue proprement au lieu d'attendre indéfiniment.
- Sortie > 20 000 caractères : elle part dans un fichier scratch, relis-le par sections avec `read_file(offset)`.

## 1. Établis la carte avant d'agir
- `read_file("~/.ssh/config")` : liste les hôtes réellement configurés. N'utilise QUE ces alias, jamais une IP devinée.
- Hôte inconnu de l'utilisateur ? Demande l'alias, ne teste pas des noms au hasard.
- Test de vie, une seule commande : `ssh -o BatchMode=yes -o ConnectTimeout=8 ALIAS 'hostname; uptime'`. Échec : rapporte le message d'erreur brut et arrête-toi, ne tente pas trois variantes.

## 2. Diagnostic d'état ; un seul aller-retour
```
ssh -o BatchMode=yes -o ConnectTimeout=8 ALIAS 'echo "== uptime"; uptime; echo "== disk"; df -h /; echo "== mem"; free -m 2>/dev/null || vm_stat; echo "== failed"; systemctl --failed --no-pager 2>/dev/null'
```
Restitue un tableau (métrique, valeur, verdict). Signale toute partition > 85 %, tout service en échec, tout load > nombre de cœurs.

## 3. Logs : filtre côté serveur, toujours
- Jamais de `cat` sur un log : compte d'abord, lis ensuite.
```
ssh -o BatchMode=yes ALIAS 'journalctl -u SERVICE --since "1 hour ago" --no-pager | grep -c ERROR'
ssh -o BatchMode=yes ALIAS 'journalctl -u SERVICE --since "1 hour ago" --no-pager | grep ERROR | tail -30'
```
- Fichier plat : `grep -c`, puis `grep … | tail -n 30`, jamais `tail -f` (ne rend jamais la main).
- Rapporte les motifs d'erreur groupés avec leur nombre d'occurrences, pas 200 lignes brutes.

## 4. Actions qui modifient l'état
- Montre la commande exacte, dis ce qu'elle change, et attends l'accord AVANT de l'exécuter.
- Une action = un appel. Jamais deux `systemctl restart` chaînés.
- Redémarrage de service : `systemctl status` avant, `restart`, puis `status` + un test fonctionnel (`curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:PORT/health`). Sans preuve après, l'action n'est pas terminée.
- `sudo` : seulement en NOPASSWD déjà configuré. Sinon, dis-le et donne la commande à taper à l'utilisateur.
- Interdits sauf demande explicite et relecture : `rm -rf`, jokers dans un `rm`, `>` sur un fichier existant, `chmod -R`, `truncate`.

## 5. Tâche longue (déploiement, migration, build)
```
ssh -o BatchMode=yes ALIAS 'cd /srv/app && nohup ./deploy.sh > /tmp/deploy-$(date +%s).log 2>&1 & echo LOG=/tmp/deploy-...log PID=$!'
```
Puis, dans un appel séparé : `tail -n 40 LOG; pgrep -f deploy.sh || echo TERMINE`. Répète le suivi ; ne conclus « déployé » qu'après TERMINE et un test fonctionnel.

## 6. Fichiers
- Descendre : `scp ALIAS:/chemin/distant /tmp/local`. Monter : `scp /tmp/local ALIAS:/chemin/distant`.
- Synchronisation : `rsync -avz --dry-run source ALIAS:cible` D'ABORD, montre la liste des fichiers touchés, fais valider, puis relance sans `--dry-run`. Jamais de `--delete` sans accord explicite.

## Garde-fous
- Ne colle JAMAIS un secret dans la commande (il apparaît dans le fil et l'historique) : utilise une variable d'environnement ou un fichier déjà présent sur le serveur.
- Une commande destructrice sur un serveur est irréversible : pas de `git checkout` pour rattraper. En cas de doute, propose et attends.
- Un serveur qui ne répond pas n'est pas un serveur à redémarrer : rapporte, propose un diagnostic, laisse l'utilisateur décider.
- Trois machines ou plus à inspecter avec le même diagnostic : `spawn_agent` une fois par machine, brief autonome (alias, commandes exactes, format du tableau), puis `ask_agent` ; fusionne les tableaux toi-même.
- Termine toujours par : ce qui a été constaté, ce qui a été modifié, ce qui reste à faire, et la commande de retour arrière quand elle existe.
