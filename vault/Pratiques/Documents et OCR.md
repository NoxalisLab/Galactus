---
title: Documents et OCR
tags: [pratique, documents, ocr]
description: Lire des PDF, scans, Word, Excel et images de façon fiable, et gérer les gros documents.
---

# Documents et OCR

`read_document` lit PDF, images (png, jpg, heic, tiff), Word, PowerPoint, Excel,
RTF, HTML et texte. Les PDF scannés et les images passent par l'OCR de macOS, en
local. Trois modes : `auto` (couche texte puis OCR en repli), `ocr` forcé, et
`text` seul.

`read_file` sur un PDF ne donne rien d'exploitable : c'est du binaire. Ne mélange
pas les deux outils.

## Gros document, la bonne séquence

1. `read_document` une fois. Au delà de 20 000 caractères, la sortie part dans
   un fichier scratch et le chemin apparaît dans le fil.
2. Faire relire ce fichier scratch **par tranches** avec `read_file(offset)`.
3. Après chaque tranche, faire écrire 3 à 5 lignes de notes : pages couvertes,
   faits, citations candidates. Ces notes survivent au résumé du fil,
   contrairement au texte brut ([[Fenêtre de contexte]]).

```
Lis /Users/moi/docs/rapport.pdf avec read_document. Si la sortie part dans un
fichier scratch, relis-le par tranches de 40 000 octets. Après chaque tranche,
donne-moi 4 lignes : pages couvertes, faits chiffrés, citations exactes.
Ne conclus rien avant la dernière tranche.
```

Au delà d'une cinquantaine de pages, ou pour comparer plusieurs documents, un
coéquipier par document ([[Équipes de sous-agents]]).

## Qualité de l'OCR

- Un scan de travers ou à faible résolution produit des chiffres faux, pas une
  erreur. `1` et `7`, `0` et `O`, les séparateurs de milliers.
- Sur tout montant, toute date, tout identifiant issu d'un scan, exige une
  citation exacte et vérifie à l'oeil sur le document.
- Les tableaux perdent souvent leur structure. Faire produire un CSV et le
  recompter :

```
Extrais le tableau de la page 12 en CSV avec les colonnes date, libellé,
montant. Écris-le dans /tmp/extrait.csv. Puis, avec python3, calcule la somme
de la colonne montant et compare-la au total imprimé sur la page. Dis-moi si
les deux ne correspondent pas.
```

Ce dernier contrôle attrape la majorité des erreurs d'OCR sur les documents
comptables. Voir [[Administratif et gestion documentaire]].

## Limites connues

- Pas de mise en page conservée : ni colonnes, ni notes de bas de page fiables.
- Pas d'interprétation d'image : un graphique n'est pas lu, seul son texte est
  extrait.
- PDF protégés par mot de passe : non lus.

## Suite

[[Skill analyse-documents]] · [[Base de connaissances locale]] ·
[[Administratif et gestion documentaire]] · [[Santé et données patients]] ·
[[Recherche scientifique]] · [[Vérifier avant de croire]]
