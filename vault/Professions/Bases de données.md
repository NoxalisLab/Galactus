---
title: Bases de données
tags: [métier, données, sql]
description: Schémas, migrations et requêtes, avec la règle qui évite les catastrophes, jamais sur la base réelle.
---

# Bases de données

> [!warning] La règle qui prime sur tout
> Le modèle ne touche jamais une base de production. Aucune commande `psql`,
> `mysql` ou `sqlite3` en écriture sur une base réelle sans que tu aies lu la
> requête exacte. Une migration se joue d'abord sur une copie.

## Ce qui est réellement disponible

`sqlite3` est présent sur macOS et utilisable via `run_command`. Les clients
`psql` et `mysql` ne le sont que si tu les as installés : fais-le vérifier avant
de bâtir un workflow dessus.

```
run_command("which sqlite3 psql mysql duckdb 2>&1")
```

## Workflow : comprendre un schéma

```
Base SQLite /Users/moi/data/app.db. Avec run_command :
sqlite3 app.db ".schema" puis, pour les 5 plus grosses tables,
SELECT COUNT(*). Rends un tableau : table, colonnes clés, lignes, relations.
Aucune écriture.
```

Sur PostgreSQL, l'équivalent en lecture seule passe par `\d+` ou une requête
sur `information_schema`, dans une session `--read-only` quand elle existe.

## Workflow : écrire une requête juste

1. Faire énoncer le résultat attendu en français avant le SQL.
2. Faire écrire la requête **avec un `LIMIT 20`**.
3. Faire compter séparément : `SELECT COUNT(*)` de la même clause `WHERE`.
4. Comparer le compte à un ordre de grandeur que tu connais.

```
Écris la requête qui donne le chiffre d'affaires par mois sur 2026, hors
commandes annulées. Ajoute LIMIT 20. Donne aussi la requête de comptage des
lignes concernées. Explique en une phrase ce que chaque jointure ajoute.
```

**Vérification décisive** : recompute une seule ligne du résultat par un chemin
différent (un `WHERE` sur un mois précis). Si les deux nombres divergent, la
requête est fausse, pas la base.

## Workflow : migration

```
Écris la migration qui ajoute orders.archived_at (timestamp nullable), avec son
"down". Puis la procédure de test : copier la base vers /tmp/copie.db,
appliquer, vérifier le schéma, appliquer le down, revérifier. Exécute-la
uniquement sur la copie.
```

## Pièges

- **Jointure qui duplique des lignes** : le total explose. Le tell est un
  chiffre d'affaires deux fois trop grand. Compte les lignes avant et après la
  jointure.
- **`NULL` dans un `NOT IN`** : renvoie zéro ligne sans erreur.
- **Fuseaux horaires** : un `date_trunc` sans fuseau décale les fins de mois.
- **Index promis mais non vérifié** : demande `EXPLAIN`, pas une affirmation.

## Voir aussi

[[Backend et API]] · [[Data et IA]] · [[Web full-stack]] ·
[[Finance quantitative et corporate]] · [[Skill data-ia]] ·
[[Vérifier avant de croire]]
