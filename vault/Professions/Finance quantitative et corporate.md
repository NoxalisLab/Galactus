---
title: Finance quantitative et corporate
tags: [métier, finance, modélisation]
description: Valorisation, backtest, données de marché et reporting, avec la réconciliation comme contrôle systématique.
---

# Finance quantitative et corporate

Deux atouts réels ici : le calcul passe par des scripts exécutés et montrés, et
rien ne quitte la machine, ce qui rend l'outil utilisable sur des données non
publiques ([[Tout reste en local]]).

> [!warning] La ligne
> Analyse, modélisation, suivi et reporting : oui. Conseil en investissement
> personnalisé : non, jamais, cohérent avec
> [[Skill suivi-portefeuille]].

## Règle de méthode

Aucun chiffre qui ne sorte d'un script visible. Un modèle qui annonce un TRI
sans script est en train de deviner ([[Ce que le modèle rate]]).

## Workflow : récupérer et nettoyer des données de marché

```
Pour AAPL, MC.PA et EURUSD=X, une seule commande curl par ticker, extraction
en python3, jamais le JSON brut dans la conversation :
curl -s -m 15 -H "User-Agent: Mozilla/5.0" \
 "https://query1.finance.yahoo.com/v8/finance/chart/TICKER?interval=1d&range=1y" \
 | python3 -c "import sys,json;r=json.load(sys.stdin)['chart']['result'][0];..."
Écris un CSV par ticker dans /Users/moi/data/marche/, colonnes date, close,
volume. Puis dis-moi, par fichier : nombre de lignes, première et dernière
date, nombre de jours manquants par rapport au calendrier ouvré.
```

**Vérification** : le comptage des jours manquants est le contrôle qui compte.
Une série trouée fausse toute volatilité calculée dessus, sans jamais lever
d'erreur.

## Workflow : modèle de valorisation

1. Faire écrire les **hypothèses** dans un fichier séparé (`hypotheses.json`) :
   taux de croissance, marge, WACC, valeur terminale, horizon.
2. Faire écrire le calcul dans un script qui lit ce fichier, aucune valeur en
   dur.
3. Exiger une **analyse de sensibilité** sur les deux hypothèses les plus
   sensibles, en tableau.

```
Écris /tmp/dcf.py qui lit hypotheses.json et sort : flux par année, valeur
actuelle, valeur terminale, valeur d'entreprise, valeur des fonds propres.
Puis une table de sensibilité WACC (de 7 % à 11 %) contre croissance terminale
(de 1 % à 3 %). Montre le script et sa sortie.
```

**Vérification** : recalcule une cellule de la table à la main. Et fais vérifier
que la valeur terminale ne dépasse pas une part absurde de la valeur totale, le
signe classique d'une erreur de formule.

## Workflow : backtest honnête

```
Backteste la règle "acheter quand la moyenne 20 jours croise au-dessus de la
moyenne 50 jours" sur le CSV de AAPL. Contraintes : pas de regard sur le
futur, signal exécuté à l'ouverture du lendemain, frais de 0,1 % par
transaction, et compare TOUJOURS au buy and hold sur la même période.
Sortie : rendement total, volatilité annualisée, perte maximale, nombre de
transactions.
```

**Le piège numéro un, à l'étape du signal** : le regard sur le futur. Le tell
est un résultat trop beau. Fais expliciter, ligne par ligne, quelle information
est disponible à quelle date.

## Workflow : réconciliation comptable

```
Deux fichiers : /Users/moi/compta/banque.csv et /Users/moi/compta/grand-livre.csv.
Rapproche par (date à plus ou moins 3 jours, montant exact). Rends trois
fichiers : rapproches.csv, banque_seule.csv, livre_seul.csv. Puis affiche les
trois totaux et prouve que somme(rapproches) + somme(banque_seule) ==
somme(banque.csv). Si l'égalité est fausse, arrête-toi.
```

## Workflow : reporting récurrent

Une fois le script stable, `/automatisation-mac` en fait une tâche `launchd`
mensuelle avec un log ([[Skill automatisation-mac]]).

## Faiblesse honnête

Pas de flux temps réel, pas de terminal de marché, pas de base de données
historique fiable : les cours récupérés par API publique sont indicatifs et
parfois différés. Pour un usage professionnel, ta source de données reste ta
source de données, l'application la nettoie et la calcule.

## Voir aussi

[[Investissement et portefeuille]] · [[Skill suivi-portefeuille]] ·
[[Data et IA]] · [[Bases de données]] · [[Administratif et gestion documentaire]] ·
[[Skill data-ia]] · [[Tout reste en local]] · [[Vérifier avant de croire]]
