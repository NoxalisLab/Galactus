---
title: Skill analyse-documents
tags: [skill, documents]
description: Lire, résumer, comparer ou extraire des données d'un document avec citations localisées et rien d'inventé.
---

# Skill analyse-documents

`/analyse-documents` sert dès qu'il faut tirer de l'information d'un PDF, d'un
Word, d'un Excel, d'un PowerPoint ou d'un scan.

## Ce qu'elle force

- `read_document` pour tout ce qui n'est pas du texte brut, jamais `cat` ni
  `read_file` sur un binaire.
- Ne rapporter **que** ce qui est écrit : absent devient « non présent dans le
  document », jamais une déduction présentée comme un fait.
- Une citation exacte entre guillemets, avec sa localisation (page, section,
  `Feuille!Cellule`) pour chaque affirmation importante.
- Lecture par tranches du fichier scratch pour les gros documents, avec des
  notes après chaque tranche.
- OCR douteux marqué `[incertain]`, contradiction interne signalée avec les deux
  citations.
- Extraction structurée : schéma validé, colonne `source`, champ manquant vide
  et jamais deviné.

## Exemple

```
/analyse-documents Compare /Users/moi/docs/offre-A.pdf et
/Users/moi/docs/offre-B.pdf sur : prix total, durée, pénalités, clause de
sortie. Un tableau, une ligne par critère, citation et page pour chaque
valeur, "absent" si le point n'est pas traité.
```

## Voir aussi

[[Documents et OCR]] · [[Administratif et gestion documentaire]] ·
[[Recherche scientifique]] · [[Santé et données patients]] ·
[[Équipes de sous-agents]] · [[Skills et invocation]]
