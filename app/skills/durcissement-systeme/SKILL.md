---
name: durcissement-systeme
description: "Passer en revue la posture de sécurité d'un hôte Linux ou macOS que tu possèdes : comptes, SUID, services, pare-feu."
---

Tu dresses l'état des lieux d'une machine de l'utilisateur. **On agrège, on ne rapatrie pas des arborescences.** Chaque commande produit un compte ou une liste courte, jamais un dump. Le durcissement se propose, il ne s'applique pas seul.

## 0. Détecte l'OS et adapte
```
run_command("uname -s; sw_vers 2>/dev/null || cat /etc/os-release 2>/dev/null | head -3")
```
Linux et macOS ne partagent ni les mêmes commandes ni les mêmes protections. Choisis la branche correspondante ; ne lance jamais une commande `systemctl` sur macOS ni `spctl` sur Linux.

## 1. Comptes ; qui peut devenir root
```
run_command("awk -F: '$3==0{print \"UID0: \"$1}' /etc/passwd; echo '== sans mot de passe avec shell =='; awk -F: '($2==\"\"||$2==\"!\"||$2==\"*\")?0:1' /etc/passwd 2>/dev/null | head; echo '== sudoers =='; sudo -n grep -rhE 'NOPASSWD|ALL\\s*=\\s*\\(ALL' /etc/sudoers /etc/sudoers.d/ 2>/dev/null")
```
Signale : tout compte autre que `root` avec UID 0 (porte dérobée classique), tout compte doté d'un shell et sans mot de passe, toute entrée `sudoers` en `NOPASSWD` ou trop large (`ALL=(ALL) ALL` pour un groupe étendu). Sur macOS, les administrateurs se lisent par `dscl . -read /Groups/admin GroupMembership`.

## 2. Binaires SUID/SGID et fichiers world-writable
```
run_command("find / -xdev -perm -4000 -type f 2>/dev/null | head -60")
```
Compare à la liste attendue (`sudo`, `su`, `passwd`, `mount`, `ping`, `sudo`). Tout SUID inhabituel (dans un home, `/tmp`, `/opt`, un interpréteur comme `python` ou `bash` en SUID) est une élévation de privilèges potentielle : signale-le. Puis les fichiers modifiables par tous dans les emplacements sensibles :
```
run_command("find /etc /usr/local/bin /usr/local/sbin -xdev -perm -0002 -type f 2>/dev/null | head -40")
```

## 3. Services en écoute ; loopback ou public
```
run_command("ss -tulpn 2>/dev/null || lsof -nP -i -sTCP:LISTEN 2>/dev/null")
```
Classe chaque port : lié à `127.0.0.1` ou `::1` (loopback, non exposé, sain) contre lié à `0.0.0.0`, `::` ou une IP d'interface (joignable depuis le réseau). Un service de base de données, un cache ou un tableau de bord d'administration exposé au-delà du loopback est le constat le plus fréquent et le plus important : il devrait écouter en loopback et passer par un tunnel.

## 4. Mises à jour, pare-feu, et protections plateforme
```
run_command("(command -v apt >/dev/null && apt list --upgradable 2>/dev/null | grep -i secur | head) || (command -v dnf >/dev/null && dnf updateinfo list security 2>/dev/null | head) || (command -v brew >/dev/null && brew outdated | head)")
```
Puis le pare-feu selon la plateforme :
```
run_command("(command -v ufw >/dev/null && sudo -n ufw status verbose) || (command -v firewall-cmd >/dev/null && sudo -n firewall-cmd --list-all) || (command -v pfctl >/dev/null && sudo -n pfctl -s info 2>/dev/null)")
```
Sur macOS, vérifie les trois protections natives, chacune en un appel :
```
run_command("csrutil status; echo '== gatekeeper =='; spctl --status; echo '== filevault =='; fdesetup status")
```
SIP désactivé, Gatekeeper désactivé ou FileVault éteint sont des affaiblissements majeurs de la posture macOS : signale-les avec la commande de réactivation.

## Restitution
Une liste hiérarchisée par risque (critique en premier), et pour chaque point : le constat, la commande de remédiation exacte, et si elle exige un redémarrage ou une déconnexion. Ne noie pas les priorités : trois constats critiques valent mieux qu'une liste de trente broutilles.

## Garde-fous
- Uniquement les machines de l'utilisateur. Confirme l'hôte à l'étape 0.
- Agrège systématiquement : `head`, un compte, une liste courte. Ne rapatrie jamais une arborescence entière ni le contenu de `/etc` complet.
- Ne modifie rien sans confirmation. Tu proposes la commande de durcissement, l'utilisateur l'exécute.
- Masque les données personnelles croisées en chemin : noms de home, e-mails dans la conf, chemins de fichiers privés ; cite par nature.
- Ne recopie jamais un hash de mot de passe (`/etc/shadow`) ni un secret dans le fil.
- Restitution finale : l'hôte et l'OS, la liste hiérarchisée constat / commande de remédiation, et ce qui exige un redémarrage ou une action humaine.
