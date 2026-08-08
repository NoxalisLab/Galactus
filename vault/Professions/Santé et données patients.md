---
title: Santé et données patients
tags: [métier, santé, confidentialité]
description: Documentation, anonymisation, extraction et recherche pour professionnels de santé, sur une machine qui ne transmet rien.
---

# Santé et données patients

L'argument n'est pas la performance du modèle, c'est le **traitement local** :
les données patient ne transitent nulle part, il n'y a pas de sous-traitant, pas
de transfert, pas d'hébergeur à qualifier pour ce traitement précis
([[Tout reste en local]]). C'est ce que ne peut offrir aucun assistant en ligne.

> [!warning] Le jugement clinique n'est pas délégué
> Aucun diagnostic, aucun triage, aucune conduite thérapeutique ne se demande à
> ce modèle : il produit du texte plausible, pas une évaluation clinique, et la
> responsabilité reste entière chez le professionnel.

Tout ce qui suit est du travail documentaire, méthodologique et administratif,
et c'est une surface large.

## Deux types de sessions, à ne jamais mélanger

| Session | Données patient | Réseau |
|---|---|---|
| Traitement de dossiers | oui | **coupé** : ni `fetch_url`, ni `curl`, ni MCP |
| Littérature et recommandations | non | autorisé |

Ouvre deux conversations distinctes. C'est la précaution la plus simple et la
plus efficace.

## Workflow 1 : structurer des notes de consultation

```
/donnees-sensibles Aucun accès réseau. Lis /Users/moi/notes/consult-brutes.txt
et restructure chaque entrée selon ce plan : motif, antécédents pertinents,
examen, conclusion, suivi. Ne complète aucun champ absent, écris "non
renseigné". Ne reformule pas les termes cliniques. Écris le résultat dans
consult-structure.md.
```

**Vérification** : le nombre d'entrées en sortie doit être égal au nombre en
entrée. Fais afficher les deux comptes. Puis relis deux entrées au hasard
contre l'original.

## Workflow 2 : pseudonymisation d'une base pour la recherche

```
/donnees-sensibles Fichier cohorte.csv. Étape 1 seulement : inventorie les
colonnes en identifiant direct, quasi-identifiant, donnée de santé, donnée
neutre, et propose un traitement par colonne. N'applique rien.
```

Après validation, la skill applique : pseudonymes stables `PAT-0001`, table de
correspondance dans un fichier séparé, date de naissance réduite à l'année,
code postal au département, âge par tranche de 5 ans.

**Vérification obligatoire** : le contrôle de fuite sur le fichier produit
(recherche de motifs d'identifiants et des noms de la table), recompté après
correction, avec les deux résultats annoncés.

## Workflow 3 : statistiques de cohorte

```
/data-ia Sur cohorte-pseudo.csv : effectifs par groupe, âge médian et
intervalle interquartile, répartition par sexe, taux de données manquantes par
colonne. Script python3 visible, sortie brute. Signale toute cellule
d'effectif inférieur à 5, elle ne doit pas être publiée telle quelle.
```

Le seuil de petits effectifs est une règle de réidentification, pas une
préférence de style.

## Workflow 4 : littérature et recommandations, dans une session sans données

```
/recherche-sourcee Recommandations en vigueur sur X chez l'adulte. Priorité :
autorités sanitaires et sociétés savantes. Pour chaque source : organisme,
date de publication, URL, et la phrase exacte qui porte la recommandation.
Signale toute source de plus de 5 ans et ce que tu n'as pas trouvé.
```

La date est ici décisive : le modèle ignore toute recommandation postérieure à
son entraînement et n'a aucune notion du jour ([[Ce que le modèle rate]]).

## Workflow 5 : extraction et codage

```
/analyse-documents Extrais de ces 30 comptes rendus (dossier fourni) : date,
type d'acte, code, durée, praticien. Un CSV, une ligne par compte rendu, avec
une colonne source indiquant le fichier et la page. Champ absent = vide,
jamais deviné. Liste à la fin les fichiers où un champ manquait.
```

Le codage proposé est une **proposition à valider** par un humain, comme toute
donnée destinée à une facturation ou à un registre.

## Workflow 6 : protocole et paperasse

Protocole de recherche, note d'information, formulaire de consentement,
courriers types, réponses à un comité : `/redaction-pro` avec la matière
source lue en premier, et un `[À COMPLÉTER]` partout où l'information manque
plutôt qu'une formulation inventée ([[Skill redaction-pro]]).

## Faiblesse honnête

Pas de connexion à un logiciel métier, pas de terminologie médicale
structurée embarquée, pas de vérification des codes contre un référentiel : le
modèle peut proposer un code plausible et faux. Vérifie chaque code contre ton
référentiel officiel.

## Voir aussi

[[Skill donnees-sensibles]] · [[Tout reste en local]] · [[Documents et OCR]] ·
[[Recherche scientifique]] · [[Skill analyse-documents]] · [[Data et IA]] ·
[[Administratif et gestion documentaire]] · [[Niveaux d'autonomie]]
