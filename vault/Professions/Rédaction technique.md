---
title: Rédaction technique
tags: [métier, écrit, documentation]
description: Documenter à partir du code réel, sans inventer, et faire vivre la documentation dans le coffre.
---

# Rédaction technique

La documentation est un des rares domaines où le modèle peut produire beaucoup
de valeur vite, à une condition : **écrire à partir du code lu, jamais de
mémoire**.

## Modèle à lancer

Un gros modèle est confortable ici (peu de tours, textes longs) : gpt-oss-120b
au delà de 48 Go. Sur une machine plus modeste, Qwen3-30B-A3B convient
([[Choisir un modèle]]).

## Workflow : documenter un module existant

```
Lis src/billing/ (liste d'abord, puis les 4 fichiers principaux). Écris
docs/billing.md : objectif du module, concepts, points d'entrée publics avec
leur signature exacte recopiée du code, un exemple d'utilisation tiré d'un
appel réel trouvé dans le dépôt, et les limites connues.
Aucune fonction que tu n'as pas lue. Cite le fichier pour chaque signature.
```

**Vérification** : ouvre deux signatures au hasard et compare au code. Une
signature approximative dans une doc est pire qu'une absence de doc.

## Workflow : un guide de démarrage qui marche vraiment

```
Écris docs/demarrage.md à partir du README et du fichier de build. Chaque
étape doit être une commande exécutable. Ensuite, exécute-les une par une avec
run_command dans /tmp/essai et corrige le guide à chaque écart entre ce qui est
écrit et ce qui se passe.
```

C'est la vérification la plus efficace de ce métier : le guide est valide quand
la machine l'a suivi.

## Workflow : documentation vivante dans le coffre

Le coffre est un bon support de documentation d'équipe : les wikilinks font la
navigation, la Constellation montre les zones oubliées
([[Coffre et Constellation]]).

```
Ajoute à Professions/Backend et API.md une section "Décisions" avec la date du
jour et la décision que nous venons de prendre, en 3 puces. obsidian_append,
pas obsidian_update.
```

Respecte [[Conventions du coffre]] : une note qui ne se résume pas en deux
lignes est deux notes.

## Style

`/redaction-pro` porte la typographie française, la structure par format et la
relecture systématique ([[Skill redaction-pro]]). Pour la documentation,
ajoute : impératif, une action par étape, exemples réels et jamais de
`foo`/`bar`.

## Pièges

- **La doc plausible** : des paramètres qui n'existent pas, décrits avec
  aplomb. Exiger la citation de la ligne de code.
- **La doc qui périme en silence** : redater chaque page et faire relire le
  code à chaque révision.
- **Le pavé** : au delà de deux écrans, découpe.

## Voir aussi

[[Skill redaction-pro]] · [[Coffre et Constellation]] ·
[[Développement logiciel]] · [[Produit et UX]] · [[Recherche scientifique]] ·
[[Conventions du coffre]]
