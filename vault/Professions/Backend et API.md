---
title: Backend et API
tags: [métier, web, api]
description: Concevoir et faire évoluer une API sans casser ses consommateurs, avec les vérifications par curl.
---

# Backend et API

## Workflow : concevoir une route

```
Lis src/api/orders.ts pour les conventions du projet, puis propose la route
POST /v2/orders/:id/archive : validation d'entrée, codes de retour (200, 400,
404, 409), forme exacte de la réponse et du corps d'erreur. Écris d'abord le
contrat en markdown, je valide, tu implémentes ensuite.
```

Le contrat avant le code : c'est ce qui empêche l'écran et l'API de diverger
([[Web full-stack]]).

## Workflow : faire évoluer sans casser

```
Avec search_workspace, trouve tous les appelants de /v1/orders dans ce dépôt.
Liste-les avec fichier:ligne. Puis dis-moi lesquels casseraient si le champ
"status" devenait un objet. Ne modifie rien.
```

**Vérification** : le nombre d'appelants trouvés doit correspondre à ce que tu
connais du projet. Zéro appelant sur une route utilisée signale une recherche
mal formulée, pas une route morte.

## Workflow : vérifier une route qui tourne

```
Mon serveur de développement tourne déjà sur le port 3000. Avec run_command :
curl -sS -o /dev/null -w '%{http_code} %{time_total}\n' \
  -X POST localhost:3000/v2/orders/42/archive
puis le même appel avec un id inexistant. Montre les deux codes bruts.
```

Trois codes à toujours exiger : le cas nominal, le cas invalide, le cas absent.

## Workflow : lire des logs d'API en production

Voir [[Serveurs distants en SSH]]. Filtre côté serveur, compte avant de lire.

## Pièges

| Piège | Tell | Parade |
|---|---|---|
| Middleware d'authentification oublié | la route marche en curl sans token | Le demander explicitement, puis tester sans token |
| Codes d'erreur inventés | un 422 dans un projet qui n'en utilise jamais | Faire lire un handler existant d'abord |
| N+1 sur une jointure | une boucle avec une requête dedans | Voir [[Bases de données]] |
| Secret en dur | une clé dans le diff | Relire chaque hunk, voir [[Sécurité applicative]] |

## Faiblesse honnête

L'application ne connaît pas ton runtime : elle ne démarre pas ton serveur, ne
lit pas ta variable d'environnement, ne voit pas ton conteneur. Tout ce qui est
« ça marche » doit venir d'un `curl` ou d'un test que tu as vu passer.

## Voir aussi

[[Web full-stack]] · [[Bases de données]] · [[Tests et qualité]] ·
[[Sécurité applicative]] · [[Serveurs distants en SSH]] ·
[[Développement logiciel]] · [[Observabilité et incidents]]
