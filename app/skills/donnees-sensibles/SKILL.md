---
name: donnees-sensibles
description: "Données personnelles, santé, RH ou juridiques : traitement local, anonymisation."
---

Le traitement est **entièrement local** et doit le rester. C'est la seule raison pour laquelle ce travail est possible ici plutôt que dans un assistant en ligne.

## Garde-fous ; aucune exception
- **Zéro réseau pendant la session** : n'appelle ni `fetch_url`, ni `curl`, ni aucun outil MCP. Si une information externe manque, dis-le et arrête-toi.
- Ne recopie jamais un identifiant direct (nom, adresse, numéro de sécurité sociale, IBAN, matricule) dans ta réponse : cite par pseudonyme ou par référence de position (« ligne 42 », « page 3 »).
- Aucun jugement professionnel n'est délégué au modèle : clinique, juridique, RH ou financier, la décision reste humaine. Tu structures, tu extrais, tu vérifies ; tu ne conclus pas à la place du professionnel.
- Écris les sorties dans un dossier dédié annoncé à l'utilisateur, jamais dans `/tmp` pour un livrable conservé.
- Ne lance jamais `remember(...)` avec une donnée personnelle.

## 1. Cadre avant d'ouvrir
Établis en trois lignes : quelles catégories de données sont présentes, quelle est la finalité du traitement, quel livrable est attendu (jeu anonymisé, extraction structurée, synthèse). Si la finalité n'est pas claire, pose UNE question avant de lire.

## 2. Inventaire des identifiants
Lis un échantillon (`read_document` ou `read_file` sur les 200 premières lignes) et rends un tableau : colonne ou champ, catégorie (identifiant direct, quasi-identifiant, donnée sensible, donnée neutre), traitement proposé (supprimer, pseudonymiser, généraliser, garder). Fais valider ce tableau AVANT toute transformation. C'est la pièce qui documente le traitement.

## 3. Pseudonymisation ; script, jamais à la main
- Écris un script `python3` (`write_file` puis `run_command`) qui remplace chaque identifiant par un pseudonyme stable : `PAT-0001`, `EMP-0007`.
- La table de correspondance part dans un fichier **séparé**, annoncé à l'utilisateur, jamais dans le même dossier que le jeu pseudonymisé, jamais affichée dans le fil.
- Généralise les quasi-identifiants : date de naissance → année, code postal → département, âge → tranche de 5 ans. Une date exacte plus un code postal réidentifient souvent une personne.
- Anonymisation réelle (irréversible) : pas de table de correspondance, et vérifie qu'aucune combinaison de colonnes restantes ne rend un enregistrement unique.

## 4. Contrôle de fuite ; obligatoire avant de livrer
Repasse sur le fichier produit et compte les motifs résiduels :
```
run_command("grep -Eic '[0-9]{13}|[A-Z]{2}[0-9]{2}[A-Z0-9]{10,}|@[a-z0-9.-]+\\.[a-z]{2,}' SORTIE.csv")
```
Ajoute une recherche des noms propres présents dans la table de correspondance. Tout compte non nul est un échec : corrige, puis recompte. Annonce le résultat des deux passes.

## 5. Extraction structurée
- Propose le schéma (colonnes ou clés), fais-le valider, puis extrais avec `read_document` en citant la position de chaque valeur.
- Champ absent = vide, jamais deviné. Ajoute une colonne `source` (page, section, ligne).
- Valeurs numériques issues d'un scan : recalcule les totaux avec `python3` et compare au total imprimé. Un écart se signale, il ne se corrige pas en silence.

## 6. Traçabilité
Écris à côté du livrable un fichier `traitement.md` : date, fichiers d'entrée, script utilisé, transformations appliquées, nombre d'enregistrements avant et après, emplacement de la table de correspondance, contrôles de fuite et leurs résultats. C'est ce document qui rend le traitement défendable.

## Restitution
Termine par : catégories traitées, ce qui a été supprimé ou pseudonymisé, où sont les fichiers, ce que le contrôle de fuite a trouvé, et ce qui reste à valider par un humain. Rappelle que le fichier reste sur cette machine et que sa protection (chiffrement du disque, sauvegardes, accès) n'est pas du ressort de l'application.
