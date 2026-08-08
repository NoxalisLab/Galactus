---
title: Web full-stack
tags: [métier, web]
description: Traverser une fonctionnalité de l'écran à la base, avec la seule chaîne où l'app vérifie vraiment les types.
---

# Web full-stack

Le full-stack est le cas où l'application est la plus utile, pour une raison
précise : **JavaScript et TypeScript sont les seuls langages où le niveau
Complet est disponible** (types, aller à la définition, références, renommage),
et c'est justement la chaîne du web moderne.

## Modèle à lancer

Qwen3-Coder-30B pour la frappe et l'itération, gpt-oss-120b pour concevoir un
modèle de données ou trancher une architecture.

## Workflow : une fonctionnalité de bout en bout

1. **Cadrer sans code.**

```
Fonctionnalité : un utilisateur archive une commande. Donne-moi, sans écrire
de code : le champ à ajouter en base, la migration, la route API, le contrat de
réponse, l'impact sur l'écran liste. Un tableau, une ligne par couche.
```

2. **Base d'abord.** Voir [[Bases de données]] : migration écrite, réversible,
   testée sur une copie.
3. **API ensuite.** Voir [[Backend et API]] : route, validation d'entrée, codes
   d'erreur, test.
4. **Écran en dernier.** Voir [[Frontend]] : états de chargement, d'erreur et
   vide inclus dès le premier jet.
5. **Test de traversée.**

```
Écris un test qui parcourt toute la chaîne : appel API, vérification en base,
puis rechargement de la liste. Lance-le et montre la sortie brute.
```

## La vérification qui compte ici

Le contrat entre les couches. Fais-le énoncer avant l'implémentation, puis
compare :

```
Relis le type de réponse déclaré côté API et le type consommé côté écran.
Cite les deux fichiers avec leurs lignes et dis-moi s'ils divergent.
```

Sur TypeScript, la Vue Code répond réellement à cette question : le service de
langage tourne dans un worker et connaît les types du projet.

## Pièges

- **Le modèle invente une version de framework.** Fais lire `package.json`
  d'abord, systématiquement.
- **Les états d'erreur oubliés.** Exige-les dans la demande, ils n'arrivent
  jamais spontanément.
- **La migration jouée sur la vraie base.** Interdis-le explicitement dans le
  message.

## Faiblesse honnête

Pas de navigateur piloté, pas de test end to end visuel, pas de capture de
rendu. Un composant peut compiler et être cassé à l'écran. Fais tourner ton
serveur de développement toi-même et regarde.

## Voir aussi

[[Frontend]] · [[Backend et API]] · [[Bases de données]] · [[Tests et qualité]] ·
[[Sécurité applicative]] · [[Développement logiciel]] · [[Vue Code]] ·
[[Produit et UX]]
