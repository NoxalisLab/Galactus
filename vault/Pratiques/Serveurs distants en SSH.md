---
title: Serveurs distants en SSH
tags: [pratique, ssh, ops]
description: Travailler sur une machine distante depuis l'assistant, avec les contraintes réelles de run_command.
---

# Serveurs distants en SSH

Galactus n'a pas de client SSH intégré. Il a `run_command`, qui lance un `zsh`
sur ton Mac : tout ce que ton terminal sait faire, il sait le faire, avec ta
configuration `~/.ssh/config`, tes clés et ton agent.

## Contraintes à connaître avant de commencer

- **120 secondes par commande.** Un déploiement long doit être lancé en tâche de
  fond avec un log, puis suivi. Voir plus bas.
- **Sortie tronquée à 200 Ko**, et au delà de 20 000 caractères elle part dans
  un fichier scratch relu par sections ([[Fenêtre de contexte]]).
- **Aucune interactivité.** Pas de mot de passe tapé, pas de `sudo` qui demande
  un mot de passe, pas de confirmation `yes/no`. Il faut des clés et du
  non interactif.
- Une commande contenant un shell imbriqué (`sh -c`) est traitée comme élevée et
  exigera un `ALLOW` tapé ([[Niveaux d'autonomie]]).

## Le préfixe qui rend tout fiable

```
ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new \
    prod01 'commande'
```

`BatchMode=yes` échoue proprement au lieu d'attendre un mot de passe pour
toujours. Mets tes hôtes dans `~/.ssh/config` et n'utilise que des alias dans
les prompts : un alias est vérifiable, une IP en dur ne l'est pas.

## Workflows

**État de santé d'une machine, en un appel**

```
Sur prod01, en une seule commande ssh en BatchMode, donne-moi : uptime,
df -h /, free -m, et systemctl --failed. Rends un tableau, une ligne par
métrique, et signale toute valeur au delà de 85 % d'occupation.
```

**Chasse dans les logs sans rapatrier le log**

```
Sur prod01 : journalctl -u api --since "1 hour ago" --no-pager | grep -c ERROR
puis les 20 dernières lignes ERROR avec leur horodatage. N'importe rien
d'autre, le fichier fait plusieurs Go.
```

Filtre **côté serveur**, toujours. Rapatrier 400 Mo de log pour en lire 20
lignes fait déborder ta fenêtre et prend une minute.

**Commande longue sans se faire couper à 120 s**

```
ssh prod01 'nohup ./deploy.sh > /tmp/deploy.log 2>&1 & echo $!'
```

puis, dans un message suivant :

```
ssh prod01 'tail -n 40 /tmp/deploy.log; pgrep -f deploy.sh || echo TERMINE'
```

**Copie de fichiers** : `scp`, et `rsync -avz --dry-run` d'abord, toujours. Lis
la liste des fichiers, puis relance sans `--dry-run`.

## Règles de sécurité

> [!warning] Sur une machine de production
> Reste en **assisté**, jamais en autonome. Une commande destructrice sur un
> serveur ne se récupère pas avec un `git checkout`.

- Lecture d'abord, écriture ensuite, jamais dans le même message.
- Toute commande qui modifie l'état est montrée avant exécution et exécutée
  seule.
- Ne colle jamais un secret dans le fil : passe par une variable d'environnement
  côté serveur ou un fichier déjà présent sur la machine.
- Interdis les jokers : `rm /chemin/precis/fichier.log`, jamais `rm *.log`.

## Suite

[[Systèmes et DevOps]] · [[Skill serveurs-distants]] · [[Observabilité et incidents]] ·
[[Réseau et infrastructure]] · [[CI-CD et livraison]] · [[Niveaux d'autonomie]]
