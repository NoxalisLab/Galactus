---
name: conteneurs-docker
description: "Docker : Dockerfile, compose, conteneur qui redémarre, image trop lourde."
---

Une image se juge sur trois chiffres : sa taille, l'utilisateur qui y tourne, et le temps de reconstruction après un changement de code. Tout le reste en découle.

## 0. Vérifie le terrain avant de proposer
```
run_command("docker version --format '{{.Server.Version}}' 2>&1 | head -3; docker compose version 2>&1 | head -1")
```
- Docker absent ou daemon arrêté : dis-le et arrête-toi. Ne rédige pas un Dockerfile que personne ne peut construire.
- `docker build` dépasse très souvent 120 s. Lance-le en fond avec un log, puis suis-le dans un appel séparé (§4).
- Les commandes `docker` sortent sur le réseau (registre) : la barrière de permission s'appliquera.

## 1. Lis l'existant avant de réécrire
- `list_directory` sur la racine, puis `read_file` sur `Dockerfile`, `.dockerignore`, `docker-compose.yml`.
- Repère la stack réelle : `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`. Un Dockerfile générique pour un projet qu'on n'a pas lu ne sert à rien.
- Mesure le point de départ, sinon tu ne pourras rien prouver :
```
run_command("docker images --format '{{.Repository}}:{{.Tag}}\\t{{.Size}}' | head -20")
```

## 2. Le Dockerfile ; ce qui compte vraiment
```dockerfile
FROM python:3.12-slim AS build
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.12-slim
RUN useradd --system --uid 10001 app
WORKDIR /app
COPY --from=build /install /usr/local
COPY --chown=app:app . .
USER app
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD python3 -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/health')"
CMD ["python3", "-m", "app"]
```
Les points non négociables de cet exemple :
- **Build multi-étapes** : la chaîne de compilation, les paquets de développement et le cache ne partent pas en production.
- **Ordre des couches** : les dépendances (fichier de lock) AVANT le code source. Inversé, chaque modification d'une ligne de code réinstalle tout.
- **`USER` non root**, avec un UID fixe. Un conteneur qui tourne en root est un défaut bloquant, pas une suggestion.
- **`CMD` en forme exec** (tableau JSON) : en forme shell, le processus ne reçoit pas `SIGTERM` et l'arrêt se fait par `SIGKILL` après le délai.
- **Version d'image de base épinglée**, jamais `latest`. Idéalement par digest.
- `--no-cache-dir`, `apt-get clean`, `rm -rf /var/lib/apt/lists/*` dans le MÊME `RUN` que l'installation : un `RUN` séparé n'efface rien, la couche précédente contient toujours les fichiers.

`.dockerignore` d'abord, avant même le Dockerfile. Sans lui, `COPY . .` embarque `.git`, `node_modules`, `.venv`, les caches et parfois `.env` :
```
.git
node_modules
__pycache__
.venv
*.log
.env
```

## 3. Secrets ; la règle et son contrôle
Un secret copié puis supprimé dans un `RUN` ultérieur **reste dans la couche précédente** et se lit avec `docker history`. Jamais de secret dans un `ARG`, un `ENV`, ni un `COPY`.
Contrôle avant de pousser une image :
```
run_command("docker history --no-trunc IMAGE | grep -iE 'password|secret|token|key' | head")
run_command("docker run --rm IMAGE sh -c 'ls -la /app; env' 2>&1 | grep -iE 'password|secret|token' | head")
```
Toute occurrence est un échec : reconstruis, ne rustine pas. Pour un secret de build, `RUN --mount=type=secret`. Pour l'exécution, une variable passée au lancement ou un fichier monté.

## 4. Construire sans se faire couper à 120 s
```
run_command("cd /chemin/projet && nohup docker build -t mon-app:test . > /tmp/build-$(date +%s).log 2>&1 & echo LOG=/tmp/build-...log PID=$!")
```
Puis, dans un appel SÉPARÉ :
```
run_command("tail -n 40 /tmp/build-….log; pgrep -f 'docker build' >/dev/null || echo TERMINE")
```
Répète le suivi. Ne conclus « construite » qu'après `TERMINE` et une vérification de l'image. Sortie > 20 000 caractères : elle part dans un fichier scratch, relis la fin avec `read_file(chemin, offset)`.

## 5. Diagnostiquer un conteneur qui ne va pas
```
run_command("docker ps -a --format '{{.Names}}\\t{{.Status}}\\t{{.Image}}'")
run_command("docker logs --tail 60 NOM 2>&1")
run_command("docker inspect NOM --format '{{.State.ExitCode}} {{.State.OOMKilled}} {{.State.Error}}'")
```
| Signe | Cause la plus fréquente | Vérification |
|---|---|---|
| Redémarre en boucle | le processus principal sort tout de suite | lis les 20 dernières lignes de log, pas les 1000 |
| Code de sortie 137, `OOMKilled: true` | limite mémoire atteinte | `docker stats --no-stream`, augmente la limite ou corrige la fuite |
| Code de sortie 126 ou 127 | binaire absent ou non exécutable dans l'image | `docker run --rm --entrypoint sh IMAGE -c 'ls -la /app'` |
| `Permission denied` sur un volume | l'UID du conteneur ne correspond pas au propriétaire du dossier hôte | aligne l'UID, ou `--chown` au `COPY` |
| Le service ne répond pas depuis l'hôte | port non publié, ou service à l'écoute sur 127.0.0.1 dans le conteneur | écoute sur `0.0.0.0`, et `-p HOTE:CONTENEUR` |
| Un conteneur n'en joint pas un autre | mauvais nom de réseau | `docker network inspect RESEAU`, on se joint par nom de service |

Jamais `docker logs -f` : la commande ne rend pas la main et sera coupée à 120 s.

## Garde-fous
- Ne lance jamais `docker system prune`, `docker volume rm`, `docker rm -f` ni `docker rmi` sans avoir listé la cible juste avant et obtenu l'accord. Un volume supprimé est une base de données perdue.
- Ne construis ni ne pousse jamais vers un registre distant sans demande explicite.
- Pas de `--privileged`, pas de montage de `/var/run/docker.sock`, pas de `--network host` sans que l'utilisateur ait dit oui en connaissance de cause.
- Ne modifie jamais un `docker-compose.yml` de production sans montrer le diff et sans donner la commande de retour arrière.
- Restitution finale : taille de l'image avant et après, utilisateur d'exécution, résultat du contrôle de secrets, temps de reconstruction après changement de code seul, et ce qui reste à faire.
