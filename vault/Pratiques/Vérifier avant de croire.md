---
title: Vérifier avant de croire
tags: [pratique, vérification]
description: L'habitude unique qui sépare un assistant utile d'un assistant dangereux, exiger la source de chaque affirmation.
---

# Vérifier avant de croire

Le modèle n'a aucun moyen de distinguer ce qu'il a lu de ce qu'il a produit.
Toi si : **tout ce qu'il affirme sur un fichier, un chiffre ou une API doit être
rattaché à une preuve qu'il vient de produire avec un outil**.

## La règle en une phrase

> [!warning] Règle
> Pas de citation de source, pas d'affirmation. Une phrase sans `fichier:ligne`,
> sans URL, sans sortie de commande, est une hypothèse, même quand elle est
> écrite avec assurance.

## Trois demandes qui coûtent dix secondes

```
Pour chaque point, donne le fichier et la ligne exacts, et recopie la ligne.
```

```
Ne te fie pas à ta mémoire de cette API. Ouvre le fichier ou la doc et cite le
passage. Si tu ne le trouves pas, écris « non vérifié ».
```

```
Refais ce calcul avec python3 via run_command et montre-moi le script et sa
sortie brute.
```

La troisième est la plus rentable : voir [[Ce que le modèle rate]], section
arithmétique.

## Vérifier selon le type d'affirmation

| Affirmation | Preuve à exiger | Ton contrôle |
|---|---|---|
| « Le fichier X contient Y » | `read_file` avec offset, ligne recopiée | Ouvre le fichier |
| « Cette fonction est appelée 3 fois » | `search_workspace` ou `grep -rn`, sortie brute | Relis la sortie |
| « Le total est de 412 300 EUR » | script `python3` visible et sa sortie | Recalcule une ligne à la main |
| « L'API expose /v2/orders » | Extrait de la doc ou du code, avec URL ou chemin | Ouvre la source |
| « Le service est démarré » | `systemctl status`, ou `curl -sS -o /dev/null -w '%{http_code}'` | Lis le code retour |
| « J'ai corrigé le bug » | Test qui échouait avant et passe après | Relance le test toi-même |

## Le piège du résumé

Quand un fil est long, l'assistant résume les anciens tours
([[Fenêtre de contexte]]). Ce qui a été vérifié à l'appel 4 devient une phrase
au tour 20. Redemander une preuve fraîche sur un point critique n'est jamais du
gaspillage.

## Dans le code

La [[Vue Code]] rend cette règle mécanique : le modèle ne modifie rien, il
propose un diff que tu acceptes bloc par bloc. Le patch est la preuve, et tu le
lis avant qu'il touche le disque.

## Suite

[[Bien demander]] · [[Ce que le modèle rate]] · [[Vue Code]] ·
[[Niveaux d'autonomie]] · [[Recherche scientifique]] ·
[[Finance quantitative et corporate]]
