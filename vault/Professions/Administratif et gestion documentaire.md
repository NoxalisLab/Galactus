---
title: Administratif et gestion documentaire
tags: [métier, administratif, documents]
description: Trier, extraire, classer et rédiger sur des documents administratifs, avec le recomptage comme contrôle.
---

# Administratif et gestion documentaire

Métier sous-estimé et très bien servi : OCR local, extraction structurée,
rédaction, automatisation de classement, et rien qui sorte de la machine
([[Tout reste en local]]).

## Workflow : inventorier une pile de PDF

```
Liste /Users/moi/Documents/Factures2026 (list_directory). Pour chaque PDF,
read_document et extrais : émetteur, date, numéro, montant TTC, TVA.
Écris /tmp/factures.csv avec une colonne fichier. Champ illisible = vide plus
une colonne "remarque". Ne saute aucun fichier, liste ceux qui échouent.
```

**Vérification qui rattrape l'OCR** :

```
Avec python3 : somme de la colonne TTC, nombre de lignes, nombre de champs
vides par colonne. Puis vérifie ligne à ligne que TTC est cohérent avec HT
plus TVA, et liste les incohérences avec leur fichier.
```

Cette double somme attrape la plupart des confusions de chiffres de l'OCR
([[Documents et OCR]]).

## Workflow : classer automatiquement

```
/automatisation-mac Script zsh qui déplace les PDF de ~/Downloads vers
~/Documents/Factures2026/<AAAA-MM>/ quand le nom contient "facture".
Dry-run d'abord avec la liste exacte des fichiers, puis exécution après mon
accord. Ne renomme rien.
```

Le test à blanc est imposé par la skill, et c'est ce qui évite de disperser
trente fichiers.

## Workflow : répondre à un courrier

```
/redaction-pro Lis /Users/moi/Documents/mise-en-demeure.pdf avec read_document.
Rédige une réponse : ton ferme et courtois, reprise des faits datés du
document uniquement, question précise en conclusion. Aucun engagement que je
n'ai pas validé. Marque [À COMPLÉTER] pour toute information manquante.
```

> [!warning] Contenu sensible
> Sur un litige, un dossier RH ou un sujet juridique, l'assistant rédige, mais
> une relecture humaine est nécessaire avant tout envoi. Il n'envoie rien
> lui-même de toute façon.

## Workflow : recherche dans les archives

Indexe ton dossier d'archives converti en texte, puis interroge-le avec
`search_knowledge`. Rappel : les PDF ne sont pas indexés directement, il faut
les convertir ([[Base de connaissances locale]]).

## Workflow : suivi récurrent

Un tableau markdown dans le coffre, mis à jour par `obsidian_append`, suffit
pour un suivi d'échéances. La Constellation te montre les dossiers oubliés
([[Coffre et Constellation]]).

## Pièges

| Piège | Tell | Parade |
|---|---|---|
| Montant mal lu par l'OCR | le total ne tombe pas juste | Recompter par script |
| Date au mauvais format | des mois vides dans le récapitulatif | Compter les formats distincts |
| Fichier sauté en silence | moins de lignes que de PDF | Comparer les deux comptes |
| Engagement inventé dans un courrier | une promesse que tu n'as pas faite | Relire, la skill le proscrit |

## Voir aussi

[[Skill analyse-documents]] · [[Skill redaction-pro]] ·
[[Skill automatisation-mac]] · [[Documents et OCR]] ·
[[Base de connaissances locale]] · [[Finance quantitative et corporate]] ·
[[Skill donnees-sensibles]] · [[Tout reste en local]]
