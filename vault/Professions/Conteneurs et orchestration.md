---
title: Conteneurs et orchestration
tags: [métier, docker, kubernetes]
description: Écrire et déboguer des images, des compose et des manifestes, avec la validation par outil comme seule preuve.
---

# Conteneurs et orchestration

L'application n'embarque ni Docker ni `kubectl`. Elle utilise **ceux que tu as
installés**, via `run_command`. Fais-le constater d'abord :

```
run_command("which docker kubectl helm 2>&1; docker version --format '{{.Server.Version}}' 2>&1 | head -1")
```

## Workflow : réduire une image

```
Lis Dockerfile. Propose une version multi-étages : dépendances de build isolées,
image finale sans compilateur, utilisateur non root, .dockerignore adapté.
Explique chaque changement en une ligne. Puis donne-moi la commande de build et
celle qui compare les tailles avant et après.
```

**Vérification** : `docker images` avant et après, et surtout un `docker run`
qui fait la chose que l'image est censée faire. Une image plus petite qui ne
démarre pas est un échec.

## Workflow : un conteneur redémarre en boucle

```
docker ps -a --filter name=api --format '{{.Names}} {{.Status}}'
puis docker logs --tail 50 api, puis docker inspect api | python3 -c
"import sys,json;d=json.load(sys.stdin)[0];print(d['State'])"
Diagnostique à partir de ces trois sorties uniquement.
```

Le code de sortie est la clé : 137 est un OOM kill, 1 vient de l'application.
Fais nommer le code, pas une intuition.

## Workflow : manifeste Kubernetes

```
Écris un Deployment et un Service pour l'image registry/api:1.4.2 :
2 réplicas, sondes de vivacité et de disponibilité sur /health, limites CPU et
mémoire, variables sensibles via secretKeyRef jamais en clair.
Puis valide : kubectl apply --dry-run=client -f - et montre la sortie.
```

**Vérification** : `--dry-run=client` valide la forme,
`--dry-run=server` valide contre le cluster. Sans l'un des deux, un manifeste
n'est qu'un texte plausible.

## Pièges

| Piège | Tell | Parade |
|---|---|---|
| Version d'API Kubernetes obsolète | `apiVersion` d'il y a trois ans | La faire prendre depuis un manifeste existant du dépôt |
| Secret en clair dans le YAML | une valeur lisible sous `env` | Relire le diff, voir [[Sécurité applicative]] |
| Limites de ressources inventées | des valeurs rondes sans mesure | Les tirer d'une observation réelle |
| Ordre de couches inefficace | le `COPY . .` avant l'installation | Le signaler à la relecture |

## Faiblesse honnête

La connaissance du modèle sur les versions d'API et les images de base est
figée. Sur tout ce qui est versionné, la source est ton dépôt ou la sortie de
ton outil, jamais sa mémoire ([[Ce que le modèle rate]]).

## Voir aussi

[[Systèmes et DevOps]] · [[Infrastructure as code]] · [[CI-CD et livraison]] ·
[[Réseau et infrastructure]] · [[Observabilité et incidents]] ·
[[Serveurs distants en SSH]]
