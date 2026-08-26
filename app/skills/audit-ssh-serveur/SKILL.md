---
name: audit-ssh-serveur
description: "Auditer et durcir la config SSH d'un serveur que tu administres : sshd_config, algos, clés autorisées."
---

Tu inspectes le service qui te donne l'accès. **Une erreur ici te verrouille dehors.** Donc : lecture d'abord, proposition ensuite, jamais de rechargement de `sshd` en autonomie, et toujours une session de secours ouverte avant toute modification.

## 0. Garde une porte ouverte
Avant tout, vérifie que tu es bien sur le bon serveur et que la connexion tient.
```
ssh -o BatchMode=yes -o ConnectTimeout=8 ALIAS 'hostname; whoami; uptime'
```
- Alias injoignable ou clé refusée : signale-le, n'essaie rien d'autre.
- Retiens : tant que l'audit dure, **ne ferme pas cette session** et ne recharge jamais `sshd`. Une config fautive n'expulse que les nouvelles connexions ; la session ouverte reste ton filet.

## 1. Config effective ; pas le fichier, la résolution réelle
`sshd -T` rend la configuration réellement appliquée (défauts inclus), ce que le fichier seul ne montre pas.
```
ssh -o BatchMode=yes -o ConnectTimeout=8 ALIAS 'sudo -n sshd -T 2>/dev/null | grep -iE "permitrootlogin|passwordauthentication|pubkeyauthentication|challengeresponse|x11forwarding|maxauthtries|logingracetime|allowusers|allowgroups|permitemptypasswords|clientaliveinterval" || (echo "== sudo indisponible, lecture du fichier =="; grep -ivE "^\\s*#|^\\s*$" /etc/ssh/sshd_config)'
```
Confronte à la cible et pour chaque écart donne la ligne à poser et l'impact :
| Réglage | Valeur sûre | Impact si faible |
|---|---|---|
| `PermitRootLogin` | `no` (ou `prohibit-password`) | root exposé au bruteforce direct |
| `PasswordAuthentication` | `no` | mots de passe devinables, bruteforce distant possible |
| `PubkeyAuthentication` | `yes` | seul mécanisme fort à conserver |
| `PermitEmptyPasswords` | `no` | accès sans secret, critique |
| `ChallengeResponseAuthentication` | `no` sauf MFA maîtrisée | voie d'auth secondaire souvent oubliée |
| `X11Forwarding` | `no` | surface inutile sur un serveur sans affichage |
| `MaxAuthTries` | `3` | ralentit le bruteforce par connexion |
| `LoginGraceTime` | `30` ou moins | sessions pré-auth qui saturent |
| `AllowUsers` / `AllowGroups` | liste explicite | sans liste, tout compte système est une porte |

## 2. Algorithmes ; ce que le serveur propose vraiment
```
ssh -o BatchMode=yes -o ConnectTimeout=8 ALIAS 'sudo -n sshd -T 2>/dev/null | grep -iE "^ciphers|^macs|^kexalgorithms|^hostkeyalgorithms"'
```
Repère et signale les faibles : chiffrements `arcfour`, `3des-cbc`, tout suffixe `-cbc` ; MAC `hmac-md5`, `hmac-sha1`, tout `-96` ; KEX `diffie-hellman-group1-sha1`, `group14-sha1`. Vise du `chacha20-poly1305` ou `aes256-gcm`, des MAC `hmac-sha2-512-etm`, des KEX `curve25519-sha256`. Compare au référentiel local des algos supportés par le client :
```
run_command("ssh -Q cipher; echo '--- mac'; ssh -Q mac; echo '--- kex'; ssh -Q kex")
```
Si `nmap` est présent en local, l'énumération distante confirme sans authentification :
```
run_command("command -v nmap >/dev/null && nmap -Pn -p 22 --script ssh2-enum-algos HOTE || echo 'nmap absent, on s en passe'")
```
`nmap` absent : ne l'installe pas, l'étape `sshd -T` suffit au constat.

## 3. Clés autorisées et permissions
```
ssh -o BatchMode=yes -o ConnectTimeout=8 ALIAS 'ls -ld ~/.ssh ~/.ssh/authorized_keys 2>/dev/null; echo "== cles =="; awk "{print \\$1, \\$2, substr(\\$3,1,20)}" ~/.ssh/authorized_keys 2>/dev/null; echo "== options en tete de ligne =="; grep -oE "^[^ ]*(command|no-pty|from|permitopen)[^ ]*" ~/.ssh/authorized_keys 2>/dev/null'
```
Analyse : type et taille de chaque clé (`ssh-rsa` de moins de 3072 bits est faible, `ssh-dss` est à retirer, préfère `ssh-ed25519`), présence de restrictions (`from=`, `command=`, `no-pty`) sur les clés de service, et surtout les permissions : `~/.ssh` doit être `700`, `~/.ssh/authorized_keys` `600`. Un dossier `755` fait rejeter les clés en mode strict et signale un relâchement. **Ne recopie jamais une clé privée** ; si tu en croises une hors de `~/.ssh` (dans un home, un dépôt), c'est un constat à remonter, pas à afficher.

## Restitution
Pour chaque faiblesse : le constat, la ligne exacte de `/etc/ssh/sshd_config` à changer (ancienne puis nouvelle valeur), et l'impact du changement. Rassemble les modifications en un bloc unique que l'utilisateur appliquera, suivi de la séquence sûre : éditer, `sudo sshd -t` pour valider la syntaxe, puis recharger seulement après confirmation et avec la session de secours ouverte.

## Garde-fous
- Uniquement les serveurs de l'utilisateur, via son alias. Confirme l'hôte à l'étape 0.
- Lecture d'abord, toujours. Toute modification de `/etc/ssh/sshd_config` est proposée, jamais appliquée en autonomie.
- Ne recharge ni ne redémarre jamais `sshd` toi-même. Ne coupe jamais l'accès : garde la session ouverte, valide par `sshd -t` avant tout rechargement humain.
- Ne recopie aucune clé privée ni aucun secret dans le fil.
- `nmap` sert au constat local seulement, sur l'hôte de l'utilisateur, et uniquement s'il est déjà installé.
- Restitution finale : l'hôte audité, les faiblesses avec la ligne de config corrective et son impact, le bloc de changements proposé, et la procédure de rechargement sûre laissée à l'humain.
