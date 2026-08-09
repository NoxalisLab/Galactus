---
name: sql-et-requetes
description: "SQL : comprendre un schéma, requête lente, choisir un index, éviter les injections."
---

Deux règles qui décident de tout : **jamais de plan d'exécution deviné** (`EXPLAIN` ou rien), et **jamais une valeur concaténée dans une requête** (paramètres liés, toujours).

## 0. Ce qui existe sur cette machine
- `sqlite3` est dans la stdlib du python3 embarqué : disponible partout, sans installation.
- `psql`, `mysql`, `duckdb` ne sont PAS garantis. Vérifie avant d'en dépendre :
```
run_command("which psql mysql duckdb sqlite3 2>&1; python3 -c 'import sqlite3; print(\"sqlite3 ok\")'")
```
- Base distante : tu passes par `run_command` et un client en ligne de commande, en non interactif. Le mot de passe ne se tape pas : il vient de `~/.pgpass`, d'un fichier d'options, ou d'une variable d'environnement déjà posée. Ne colle JAMAIS un mot de passe dans la commande, il reste dans le fil et dans l'historique.
- 120 s par commande. Une requête plus longue se lance en fond avec une sortie fichier, ou se borne par `LIMIT`.

## 1. Lis le schéma avant d'écrire une ligne
```
run_command("sqlite3 base.db '.schema' | head -80")
run_command("psql -X -A -t -c '\\d+ ma_table' 2>&1 | head -60")
```
Rends un tableau : table, colonnes utiles, clé primaire, clés étrangères, index existants, volumétrie approximative. Sans la volumétrie, tu ne peux pas juger un plan : mille lignes et cent millions n'appellent pas la même requête.
```
run_command("sqlite3 base.db 'SELECT COUNT(*) FROM ma_table;'")
```

## 2. Écris la requête, protégée
- **Paramètres liés, sans exception.** `WHERE id = ?` en sqlite3, `%s` en psycopg, `:nom` en SQLAlchemy. Une valeur concaténée est une injection, même « juste pour tester ».
- Un nom de table ou de colonne ne peut pas être un paramètre lié : si le client le choisit, valide-le contre une liste blanche écrite en dur.
- Jamais de `SELECT *` dans du code applicatif : nomme les colonnes. `SELECT *` casse au premier `ALTER TABLE` et transporte des colonnes inutiles.
- Toute requête interactive commence bornée par `LIMIT 50` tant que tu ne connais pas la volumétrie.
- `NULL` ne se compare pas avec `=`. `IS NULL`, `IS NOT NULL`, et attention aux `NOT IN` sur une sous-requête qui peut contenir un `NULL` : le résultat est vide, silencieusement.

## 3. Une requête est lente ; la séquence
1. **Mesure d'abord.** Sans chiffre de départ, aucune optimisation n'est démontrable.
```
run_command("psql -X -c 'EXPLAIN (ANALYZE, BUFFERS) SELECT …' 2>&1 | head -40")
run_command("sqlite3 base.db 'EXPLAIN QUERY PLAN SELECT …'")
```
2. **Lis le plan en cherchant trois choses** : un `Seq Scan` (ou `SCAN TABLE`) sur une grosse table, une estimation de lignes très éloignée du réel, et le noeud qui porte l'essentiel du temps.
3. **Corrige la cause la plus fréquente d'abord** :

| Signe dans le plan | Cause | Correction |
|---|---|---|
| Seq Scan sur grosse table filtrée | pas d'index sur la colonne du WHERE | index sur cette colonne |
| Index présent mais ignoré | fonction appliquée à la colonne (`YEAR(d)=2024`, `LOWER(mail)=…`) | réécris en intervalle (`d >= '2024-01-01' AND d < '2025-01-01'`), ou index sur expression |
| Nested loop avec beaucoup d'itérations | jointure sans index côté clé étrangère | index sur la colonne de jointure |
| Sort coûteux | ORDER BY sans index utilisable | index composite (filtre, puis tri) |
| Estimation très fausse | statistiques périmées | `ANALYZE ma_table` |
| Plusieurs requêtes identiques en boucle | N+1 côté applicatif | une seule requête avec `IN` ou une jointure |

4. **Remesure** et donne les deux temps. Un gain non mesuré n'existe pas.

## 4. Index ; ce qui compte
- L'ordre des colonnes d'un index composite est décisif : égalité d'abord, intervalle ensuite, tri en dernier. Un index `(statut, cree_le)` sert `WHERE statut=? ORDER BY cree_le` ; l'inverse, non.
- Un index par colonne n'est pas un index composite. Trois index séparés ne remplacent presque jamais le bon index à trois colonnes.
- Chaque index coûte à l'écriture et en espace. Avant d'en ajouter un, cherche les index existants inutilisés.
- La création d'un index sur une grosse table verrouille : en production, `CREATE INDEX CONCURRENTLY` sous PostgreSQL, et hors heures de pointe. Annonce la durée probable.

## 5. Écritures ; la barrière
- Toute requête qui modifie l'état (`INSERT`, `UPDATE`, `DELETE`, `ALTER`, `DROP`, `TRUNCATE`) se montre à l'utilisateur AVANT exécution, avec ce qu'elle change, et attend l'accord.
- Avant un `UPDATE` ou un `DELETE`, exécute d'abord le `SELECT COUNT(*)` avec exactement le même `WHERE`. Montre le nombre de lignes touchées, fais-le valider, puis exécute.
- Transaction explicite sur toute modification multi-tables. En cas de doute, `BEGIN`, la requête, le contrôle, puis `COMMIT` ou `ROLLBACK`.
- Jamais d'`UPDATE` ou de `DELETE` sans `WHERE`. Jamais.
- Migration de schéma : sauvegarde d'abord, et donne la requête inverse. Sans retour arrière écrit, la migration n'est pas prête.

## Garde-fous
- Aucun chiffre issu de ta tête : tout total, tout temps, tout compte vient d'une requête exécutée dont tu montres la sortie brute.
- Ne lance jamais une requête non bornée sur une table dont tu ignores la taille.
- Résultat volumineux : écris-le dans un fichier (`> /tmp/res.csv`) et lis-le par tranches, ne le déverse pas dans la conversation.
- Données personnelles dans la base : bascule sur la skill `donnees-sensibles` avant d'extraire quoi que ce soit, et ne recopie aucun identifiant direct dans ta réponse.
- Restitution finale : la requête finale, le plan avant et après, les deux temps mesurés, les index proposés avec leur coût, et les requêtes d'écriture non exécutées laissées à la décision de l'utilisateur.
