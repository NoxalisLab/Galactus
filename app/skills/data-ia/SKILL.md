---
name: data-ia
description: "À utiliser pour un travail de données ou d'IA : explorer un CSV/Parquet/JSON, nettoyer et réconcilier un jeu de données, écrire un pipeline reproductible, évaluer un modèle ou construire un index de recherche local."
---

Règle absolue : **aucun chiffre qui ne sorte d'un script exécuté**. Pas d'estimation de tête, pas de moyenne « à peu près », pas de total recopié depuis un extrait.

## 0. Environnement
- `python3` est garanti (runtime embarqué en tête du PATH), avec la **stdlib seulement** : `csv`, `json`, `sqlite3`, `statistics`, `datetime`, `zipfile`. pandas/numpy/duckdb ne sont PAS garantis.
- Vérifie avant d'en dépendre : `run_command("python3 -c 'import pandas' 2>&1 | tail -1")`. Absent : reste en stdlib, ou propose à l'utilisateur de créer un venv (`python3 -m venv .venv && source .venv/bin/activate && pip install …`) sans jamais installer dans le Python global.
- Écris tes scripts dans un fichier (`write_file` vers `/tmp/…py` ou le dossier du projet) puis lance-les. Un heredoc de 60 lignes est illisible dans le fil et impossible à rejouer.

## 1. Profile avant de toucher
Ne charge jamais un gros fichier en entier. Trois commandes, dans cet ordre :
```
run_command("ls -la FICHIER; wc -l FICHIER; head -3 FICHIER")
```
Puis un profilage en streaming (ne monte jamais tout en mémoire) : nombre de lignes, colonnes, type inféré, taux de vide, nombre de valeurs distinctes, min/max sur les colonnes numériques, 3 exemples par colonne. Restitue un tableau une ligne par colonne.

## 2. Contrat de données ; avant tout nettoyage
Écris explicitement, et fais valider : clé primaire, colonnes obligatoires, types attendus, plages valides, format de date, devise et unité. Sans contrat, « nettoyer » veut dire « supprimer des lignes au hasard ».

## 3. Nettoyage traçable
- Une transformation = une étape nommée, avec le nombre de lignes AVANT et APRÈS. Une étape qui perd des lignes sans que tu saches pourquoi est un bug, pas un nettoyage.
- Ne supprime jamais une ligne en silence : écris les rejets dans un fichier `rejets.csv` avec une colonne `raison`.
- Dédoublonnage : montre 3 exemples de doublons avant de trancher, la clé de dédoublonnage est une décision de l'utilisateur.
- Dates et nombres : format explicite (`%Y-%m-%d`), séparateur décimal explicite. Un CSV français avec virgule décimale mal lu donne des totaux faux sans erreur.

## 4. Réconciliation ; le contrôle qui rattrape tout
Après chaque agrégation, prouve la conservation :
```
somme des lignes source == somme des lignes de sortie (+ somme des rejets)
```
Affiche les deux nombres et leur écart. Écart non nul non expliqué = pipeline invalide, tu le dis et tu t'arrêtes.

## 5. Pipeline reproductible
- Un script, des chemins en paramètres, aucune valeur en dur, et il s'exécute deux fois de suite avec le même résultat (idempotent).
- Journalise dans stdout : version d'entrée, nombre de lignes à chaque étape, horodatage.
- Sortie volumineuse : écris dans un fichier, ne la déverse pas dans la conversation.
- Gros volumes : `sqlite3` sur un fichier temporaire bat une lecture Python ligne à ligne pour joindre et agréger, et tient sur disque.

## 6. Modèles et évaluation
- Jeu d'évaluation figé et séparé, décrit avant toute mesure. Une métrique sans jeu de test nommé ne veut rien dire.
- Donne toujours la baseline triviale (classe majoritaire, dernière valeur connue) : un modèle qui ne la bat pas n'a rien prouvé.
- Rapporte la métrique AVEC la taille de l'échantillon et la date d'exécution. Pas de score arrondi sans script visible.
- Fuite de données : vérifie qu'aucune colonne d'entraînement ne contient l'information cible (corrélation parfaite = suspect, dis-le).

## 7. Recherche et RAG en local
- L'application indexe déjà des dossiers en BM25 : `search_knowledge` avant de construire quoi que ce soit. BM25 est lexical, cherche les mots du document.
- Un index maison ne se justifie que si tu peux mesurer qu'il fait mieux, sur un jeu de questions écrit à l'avance.

## Garde-fous
- Aucun calcul mental, aucune extrapolation : script + sortie brute, systématiquement.
- Ne modifie JAMAIS le fichier source ; écris dans un nouveau fichier et garde l'original intact.
- Données personnelles ou sensibles dans le jeu : bascule sur la skill `donnees-sensibles` avant d'aller plus loin, et n'envoie rien sur le réseau.
- Plusieurs jeux de données indépendants à profiler : `spawn_agent` une fois par jeu, brief autonome (chemin exact, mêmes colonnes de sortie), puis fusionne les tableaux.
- Restitution finale : ce qui a été mesuré, avec quel script, sur combien de lignes, et ce qui reste non vérifié.
