---
title: Frontend
tags: [métier, web, ui]
description: Composants, états et accessibilité, avec la maquette autonome comme terrain d'essai.
---

# Frontend

## Ce que l'application fait bien

- TypeScript en niveau Complet : renommer un composant, trouver ses références,
  voir un type au survol ([[Vue Code]]).
- Une maquette HTML/CSS autonome ouvrable hors ligne, produite par
  [[Skill ui-ux]].
- Le panneau d'aperçu : quand la réponse contient un bloc HTML, SVG, Mermaid ou
  markdown, il se rend en direct dans un panneau latéral, dans un cadre isolé.

## Workflow : nouveau composant

```
Lis src/components/Table.tsx pour le style du projet, puis propose
src/components/EmptyState.tsx : props title, description, action optionnelle.
Respecte les conventions de Table.tsx. Donne aussi les trois états visuels dans
un fichier de démonstration séparé.
```

**Vérification** : `npx tsc --noEmit` via `run_command`, puis le linter du
projet. Un composant qui ne compile pas n'est pas un composant.

## Workflow : audit d'un écran

```
/ui-ux Audite src/pages/Checkout.tsx. Classe par gravité : bloquant, majeur,
mineur. Pour chaque point : fichier:ligne, pourquoi, correction. Dix maximum.
Ne modifie rien.
```

Puis applique les corrections **une par une**, chacune avec son diff.

## Workflow : accessibilité

```
Dans src/components/, cherche tous les <div onClick avec search_workspace,
liste-les, et pour chacun dis si un vrai <button> conviendrait. Ne modifie rien
avant que je choisisse.
```

C'est le type de recherche où `search_workspace` bat `grep` : confiné au
dossier, sans shell.

## Pièges

- **Le modèle juge une capture d'écran.** L'OCR ne rend que du texte : aucun
  avis sur les couleurs, les contrastes ou les espacements n'est fondé sans le
  code source.
- **Les classes utilitaires inventées.** Fais lire la configuration du framework
  CSS avant de générer des classes.

## Faiblesse honnête

Aucun rendu réel, aucune mesure de contraste automatique, aucun test
d'interaction. Le contraste annoncé est un calcul du modèle sur des valeurs
qu'il a lues : vérifie les couleurs critiques toi-même.

## Voir aussi

[[Web full-stack]] · [[Produit et UX]] · [[Skill ui-ux]] · [[Vue Code]] ·
[[Tests et qualité]] · [[Développement logiciel]]
