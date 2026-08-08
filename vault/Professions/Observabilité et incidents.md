---
title: Observabilité et incidents
tags: [métier, incident, logs]
description: Conduire un incident avec un assistant local, en gardant les logs hors de la fenêtre et la décision chez l'humain.
---

# Observabilité et incidents

En incident, l'ennemi est le volume. La fenêtre fait 8192 tokens
([[Fenêtre de contexte]]) et un log de production fait des gigaoctets. Toute la
méthode consiste à **compter avant de lire**.

## Les cinq minutes qui comptent

1. **Figer les faits.**

```
Ouvre une note dans le coffre : Incidents/2026-08-08 api 502.md, avec heure de
début, symptôme observé, périmètre, et ce que nous savons de sûr. Utilise
obsidian_append pour chaque nouvel élément, jamais obsidian_update.
```

Le coffre devient le journal d'incident, horodaté, et il servira au post mortem.

2. **Compter, pas lire.**

```
Sur prod01 : journalctl -u api --since "30 min ago" --no-pager | grep -c ERROR
puis les 10 motifs d'erreur les plus fréquents avec leur nombre :
| sed 's/[0-9]\{2,\}/N/g' | sort | uniq -c | sort -rn | head -10
```

La normalisation des nombres regroupe les erreurs identiques à un identifiant
près. C'est ce qui transforme 4000 lignes en 6 motifs.

3. **Corréler avec le changement.**

```
Qu'est-ce qui a changé avant 14 h 05 ? Sur prod01 : les 5 derniers
déploiements (ls -lt du dossier de releases), et en local
git log --since="1 day ago" --oneline. Mets les deux sur une frise.
```

4. **Formuler une hypothèse testable**, une seule, avec le test qui la réfute.

```
Donne UNE hypothèse et la commande qui la réfuterait si elle était fausse.
Pas trois pistes, une seule, la plus probable.
```

5. **Agir**, en assisté, action par action, chacune suivie de sa preuve.

## Post mortem

```
Lis la note Incidents/2026-08-08 api 502.md et rends un post mortem :
chronologie horodatée, cause racine avec la preuve qui l'établit, ce qui a
prolongé la panne, et 3 actions correctives avec un responsable proposé.
Ne mets aucune cause qui ne soit appuyée par une ligne du journal d'incident.
```

## Le piège majeur

**La causalité inventée.** Le modèle relie volontiers un déploiement à une
panne parce que c'est une histoire plausible. Le tell : aucune ligne de log ne
relie les deux. Exige toujours la preuve du lien, pas la coïncidence
temporelle.

Second piège : les 20 000 caractères de log qui partent en fichier scratch et
que le modèle conclut sans relire. Le tell : une conclusion qui ne cite aucune
ligne précise.

## Faiblesse honnête

Aucune métrique, aucune alerte, aucun tableau de bord : l'application ne se
connecte ni à Prometheus, ni à Grafana, ni à un agrégateur de logs sauf via un
connecteur MCP que tu écris. Elle travaille sur ce que `ssh` et `curl` ramènent.

## Voir aussi

[[Systèmes et DevOps]] · [[Serveurs distants en SSH]] ·
[[Réseau et infrastructure]] · [[Conteneurs et orchestration]] ·
[[Coffre et Constellation]] · [[Équipes de sous-agents]] ·
[[Skill serveurs-distants]]
