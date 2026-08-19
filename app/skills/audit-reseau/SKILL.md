---
name: audit-reseau
description: "Cartographier la surface réseau d'une machine ou d'un segment que tu possèdes : ports exposés, connexions, pare-feu."
---

C'est un **inventaire de ta propre surface d'attaque, pas une reconnaissance offensive.** On distingue ce qui écoute localement de ce qui est réellement joignable de l'extérieur, et on ne balaie que des adresses que l'utilisateur possède, en TCP-connect, sans furtivité.

## 0. Établis le périmètre
Avant le moindre paquet, fixe noir sur blanc les cibles.
- Demande la liste explicite des IP ou plages que l'utilisateur possède, et fais-la confirmer.
- Une IP hors de cette liste, une plage « du voisinage », un hôte cloud partagé : hors périmètre, refuse.
- Note tes propres interfaces pour distinguer local et distant :
```
run_command("ip -brief addr 2>/dev/null || ifconfig | grep -E 'inet '")
```

## 1. Ce qui écoute localement ; loopback contre public
```
run_command("ss -tulpn 2>/dev/null || lsof -nP -i -sTCP:LISTEN 2>/dev/null")
```
Range chaque service en deux colonnes : lié à `127.0.0.1`/`::1` (loopback, invisible du réseau) contre lié à `0.0.0.0`/`::`/une IP d'interface (exposé). Seul le second groupe constitue la surface d'attaque. Pour chaque port exposé, note le processus : est-il censé être public (un serveur web) ou devrait-il rester en loopback (base de données, cache, tableau de bord d'admin) ?

## 2. Connexions établies et règles de pare-feu
```
run_command("ss -tnp state established 2>/dev/null | head -40 || lsof -nP -i -sTCP:ESTABLISHED 2>/dev/null | head -40")
```
Repère les connexions sortantes inattendues : une IP étrangère sur un port inhabituel depuis un processus qui ne devrait pas parler à l'extérieur. Puis les règles effectives, qui disent ce qui est réellement filtré :
```
run_command("(command -v ufw >/dev/null && sudo -n ufw status numbered) || (command -v firewall-cmd >/dev/null && sudo -n firewall-cmd --list-all) || (command -v pfctl >/dev/null && sudo -n pfctl -sr 2>/dev/null) || sudo -n iptables -S 2>/dev/null | head -40")
```
Confronte les ports exposés de l'étape 1 aux règles : un port ouvert que le pare-feu ne restreint pas est la vraie surface joignable.

## 3. Découverte depuis l'extérieur ; ciblée et plafonnée
Vérifie ce qui répond réellement depuis un autre point de vue, sur les seules cibles confirmées. Avec `nmap` s'il est présent, en TCP-connect :
```
run_command("command -v nmap >/dev/null && nmap -sT -Pn --top-ports 100 -T3 HOTE_POSSEDE || echo 'nmap absent, boucle nc'")
```
Sans `nmap`, une boucle `nc` bornée sur une liste de ports explicite, jamais sur une plage entière :
```
run_command("for p in 22 80 443 3306 5432 6379 8080 9000; do nc -z -w1 HOTE_POSSEDE $p 2>/dev/null && echo \"ouvert  $p\"; done")
```
Garde le balayage court : les 100 ports les plus courants suffisent à l'inventaire. Un scan des 65535 ports d'un `/24` entier n'est ni utile ni proportionné à un inventaire.

## Restitution
La surface exposée en un tableau : port, service, portée (loopback / LAN / public), état pare-feu, verdict. Pour chaque port qui ne devrait pas être public : la recommandation concrète (le lier à `127.0.0.1`, le placer derrière un tunnel SSH, ajouter une règle de pare-feu). Termine par ce qui est sain et confirmé fermé, pour que la liste des actions ne noie pas l'essentiel.

## Garde-fous
- UNIQUEMENT les IP et plages que l'utilisateur possède, confirmées à l'étape 0. Jamais un tiers, jamais un hôte partagé, jamais « le reste du sous-réseau pour voir ».
- TCP-connect (`-sT`, `nc -z`) seulement. Pas de SYN furtif, pas de balayage de plage massif, pas de détection agressive de version ou d'OS non demandée.
- Plafonne : une liste de ports explicite ou les 100 plus courants, pas les 65535. C'est un inventaire, pas une reconnaissance offensive.
- Ne teste jamais un service découvert en tentant de s'y connecter avec des identifiants ou une charge utile : tu constates l'ouverture, tu n'entres pas.
- Masque toute donnée sensible croisée (IP internes de tiers, identifiants dans une connexion établie) ; cite par nature.
- Restitution finale : le périmètre confirmé, le tableau de la surface exposée, les ports à fermer ou passer en loopback avec la commande, et ce qui est déjà sain.
