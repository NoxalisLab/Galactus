---
title: Réseau et infrastructure
tags: [métier, réseau, infra]
description: DNS, certificats, pare-feu et connectivité, diagnostiqués par des commandes dont la sortie fait foi.
---

# Réseau et infrastructure

Le réseau est un domaine où le modèle a beaucoup de connaissances générales et
zéro connaissance de **ton** réseau. Toute affirmation doit venir d'une commande.

## Diagnostic DNS

```
Pour exemple.fr, avec run_command en une seule commande :
dig +short exemple.fr A; dig +short exemple.fr AAAA;
dig +short exemple.fr MX; dig +short TXT exemple.fr;
dig +short NS exemple.fr; dig +trace exemple.fr | tail -5
Rends un tableau enregistrement / valeur / remarque.
```

**Vérification** : compare avec le serveur faisant autorité, pas seulement le
résolveur local : `dig @$(dig +short NS exemple.fr | head -1) exemple.fr`.
Un cache local qui répond faux est le grand classique.

## Certificats TLS

```
run_command("echo | openssl s_client -servername exemple.fr -connect exemple.fr:443 2>/dev/null | openssl x509 -noout -subject -issuer -dates -ext subjectAltName")
Dis-moi : émetteur, dates, domaines couverts, et le nombre de jours restants
calculé avec python3 à partir de la date de fin.
```

Le calcul des jours restants passe par un script, jamais par le modèle
([[Ce que le modèle rate]]).

## Connectivité et ports

```
Depuis ce Mac : nc -vz -w 5 db01 5432, puis le même test depuis prod01 en ssh.
Compare les deux résultats et dis-moi si le blocage est local ou distant.
```

Tester des deux côtés est ce qui distingue un pare-feu d'un service arrêté.

## Pare-feu

```
Sur prod01, en lecture seule : iptables -S ou nft list ruleset ou ufw status
numbered, selon ce qui existe (teste dans cet ordre). Rends les règles en
tableau : chaîne, action, source, port, commentaire. N'écris aucune règle.
```

> [!warning] Une règle de pare-feu peut te couper la main
> Ne fais jamais appliquer une règle par l'assistant sur une machine distante
> sans un filet : une tâche `at` qui restaure l'ancien jeu de règles dans
> 5 minutes, mise en place avant le changement.

## Ce que l'application ne peut pas faire

- Pas de capture de paquets interprétée, pas de topologie découverte.
- Pas d'accès à ta console cloud ni à ton fournisseur DNS : elle lit ce que le
  réseau public répond, elle ne modifie pas ta zone.
- Pas de VPN piloté.

Sur ces points, elle sert de copilote de diagnostic et de rédacteur de
commandes, pas d'exécutant.

## Voir aussi

[[Systèmes et DevOps]] · [[Serveurs distants en SSH]] ·
[[Conteneurs et orchestration]] · [[Observabilité et incidents]] ·
[[Sécurité applicative]] · [[Infrastructure as code]]
