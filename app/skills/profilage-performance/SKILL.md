---
name: profilage-performance
description: "Quelque chose est lent : mesurer, trouver le point chaud, prouver le gain."
---

Trois règles, et elles suffisent : **mesure d'abord**, **une seule cause à la fois**, **remesure**. Une optimisation non mesurée est une réécriture au hasard.

## 0. Définis la mesure avant de mesurer
Écris en trois lignes, et fais valider :
- **Quoi** : quelle opération exacte, avec quelle entrée. « L'application est lente » n'est pas mesurable ; « la page /orders avec 5000 lignes » l'est.
- **Quelle grandeur** : temps mural, temps CPU, mémoire crête, débit, ou latence au 95e centile. Une moyenne cache toujours la queue de distribution, et c'est la queue qui gêne les utilisateurs.
- **Quel objectif** : le seuil à partir duquel c'est acceptable. Sans seuil, tu optimiseras indéfiniment.

## 1. La mesure de référence
Elle doit être répétable et rapide. Trois exécutions minimum : une seule mesure ne distingue pas un gain d'une variation.
```
run_command("for i in 1 2 3; do /usr/bin/time -p COMMANDE 2>&1 | grep real; done")
```
```
run_command("curl -sS -o /dev/null -w 'dns=%{time_namelookup} connect=%{time_connect} ttfb=%{time_starttransfer} total=%{time_total}\\n' 'URL'")
```
La décomposition de `curl` est immédiatement diagnostique : un `ttfb` élevé avec un `connect` bas désigne le serveur, l'inverse désigne le réseau.
Note la valeur de référence par écrit. C'est le nombre auquel tu compareras à la fin, et il disparaîtra du contexte quand le fil sera résumé : mets-le dans un fichier avec `write_file` si la session doit durer.

## 2. Trouve le point chaud ; ne le devine pas
Ton intuition sur ce qui est lent est fausse plus d'une fois sur deux.
```
run_command("python3 -m cProfile -s cumtime SCRIPT.py 2>&1 | head -30")
```
`cProfile` et `tracemalloc` sont dans la stdlib du python3 embarqué : disponibles partout. `py-spy`, `perf`, `hyperfine` ne le sont pas, vérifie avant d'en dépendre (`which py-spy hyperfine`).
Sur macOS, un échantillonnage d'un processus déjà lancé, sans installation :
```
run_command("sample PID 5 -file /tmp/sample.txt >/dev/null 2>&1; head -60 /tmp/sample.txt")
```
Mémoire, en Python :
```
run_command("python3 -X tracemalloc=5 -c \"import tracemalloc, monmodule; monmodule.run(); print(tracemalloc.get_traced_memory())\"")
```
Sortie de profilage volumineuse : elle part dans un fichier scratch, relis-la par sections avec `read_file(chemin, offset)`.
Restitue un tableau : fonction, temps cumulé, part du total, nombre d'appels. **La colonne « nombre d'appels » est souvent plus parlante que le temps** : une fonction rapide appelée 400 000 fois est le vrai problème.

## 3. Classe la cause avant d'écrire du code
| Signe dans la mesure | Cause | Correction |
|---|---|---|
| Beaucoup d'appels courts, identiques | N+1 (requête ou appel réseau en boucle) | grouper en un seul appel |
| Temps mural élevé, CPU faible | attente : disque, réseau, verrou | paralléliser ou supprimer l'attente, pas optimiser le calcul |
| CPU saturé sur une fonction | algorithme quadratique, ou travail refait | meilleure structure de données, ou mémoïsation |
| Mémoire qui croît sans redescendre | tout chargé en mémoire, ou fuite | traitement en flux, générateurs |
| Lent seulement au premier appel | démarrage à froid, cache vide, import coûteux | préchauffage, import différé |
| Lent seulement en production | volumétrie réelle, index absent, latence réseau | reproduis avec un volume réaliste avant de conclure |

Une optimisation qui ne se rattache pas à une ligne de ce tableau n'est pas motivée.

## 4. Un changement, une remesure
1. Applique UNE correction.
2. Relance exactement la même mesure de référence, même nombre d'exécutions.
3. Donne les deux chiffres et le rapport : « 4,2 s avant, 0,9 s après, facteur 4,7 ». Un pourcentage sans les deux valeurs absolues ne veut rien dire.
4. Gain inférieur à 10 % : c'est du bruit de mesure, annule le changement. Tu as ajouté de la complexité pour rien.
5. Relance les tests. **Une optimisation qui change le résultat n'est pas une optimisation, c'est un bug.** Sans suite de tests sur la zone, refuse d'optimiser et dis pourquoi.
6. Puis seulement, correction suivante.

## 5. Cas du web ; les seuils à connaître
Quand la lenteur est perçue dans un navigateur, les grandeurs qui comptent sont normalisées :
- **LCP** (affichage du plus grand élément) : bon en dessous de 2,5 s, mauvais au delà de 4 s.
- **INP** (latence d'interaction) : bon en dessous de 200 ms, mauvais au delà de 500 ms.
- **CLS** (décalage de mise en page) : bon en dessous de 0,1.
Causes les plus fréquentes, dans l'ordre : CSS bloquant le rendu, image sans dimensions déclarées, police web sans `font-display`, JavaScript exécuté sur le fil principal pendant plus de 50 ms, image non dimensionnée pour l'affichage réel.
L'application n'a pas de navigateur piloté : tu ne peux pas mesurer ces grandeurs toi-même. Demande à l'utilisateur les valeurs de son outil de mesure, ou limite-toi à ce que `curl` mesure et à la lecture du code. Ne prétends jamais avoir mesuré un LCP.

## Garde-fous
- N'optimise jamais sans mesure de référence écrite. « Ça devrait être plus rapide » n'est pas un résultat.
- N'optimise jamais deux choses en même temps : tu ne sauras pas laquelle a produit le gain, ni laquelle a produit la régression.
- Ne sacrifie pas la lisibilité pour un gain non mesuré. Une micro-optimisation illisible qui gagne 2 % est une dette.
- Ne mesure pas sur une machine chargée par ailleurs, et dis-le si tu ne peux pas le garantir.
- Restitution finale : la grandeur mesurée et son protocole, la valeur de référence, le point chaud avec sa part du total, la correction appliquée, la valeur après, et ce qui reste lent sans explication.
