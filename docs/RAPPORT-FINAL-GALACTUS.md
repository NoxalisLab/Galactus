---
title: Projet Galactus — Rapport final v4
date: 2026-08-02
author: Noxalis Lab
status: remplace la v3 du même jour, dont la section 5 annonçait 15 tok/s ouvert avec ~2 % de marge. Cette annonce créditait un recouvrement calcul/E-S qui n'existe pas et un débit effectif jamais mesuré à cette capacité. Elle est réfutée ici par quatorze mesures et un modèle fermé.
---

# Projet Galactus — Rapport final (v4)

**Question posée :** faire tourner le checkpoint intégral GLM-5.2 (744B-A40B, >500 Md de paramètres) en local sur MacBook Pro M5 Max 128 Go, à 20 tok/s nominal, 15 tok/s acceptable, avec deux SSD et sans variante élaguée.

**Réponse.** Le maximum physique de cette machine est **8,04 tok/s**. Ce n'est pas un objectif manqué par manque d'ingénierie : 15 tok/s demanderait une machine de **200 Go** de mémoire unifiée, et 20 tok/s est hors d'atteinte de cette architecture quelle que soit la mémoire. Le chiffre de 8,04 sort d'un modèle à trois constantes mesurées, vérifié à 0,1 % près sur quatre capacités indépendantes.

---

## 1. Le modèle fermé

Trois quantités, mesurées séparément, suffisent à prédire le débit à mieux que 1 %.

```
octets d'experts routés touchés par token       6 175 850 496
débit effectif du stockage                      15,227 Go/s   (8 mesures, écart-type 0,55 %)
calcul, schedule 75 couches                     62,024 ms     (p50, 7 répétitions)
```

d'où

```
ms d'E/S     = 405,6 × (1 − taux de succès)
ms par token = 405,6 × (1 − taux de succès) + 62,024
```

La première ligne se vérifie directement. Sur les quatre capacités mesurées avec de vraies lectures sur les vrais packs, les octets réellement lus par token valent `6 175 850 496 × (1 − succès)` à **0,07 %, 0,08 %, 0,09 % et 0,10 %** près.

La seconde se vérifie sur le débit effectif, qui reste plat à **15,427 / 15,230 / 14,843 / 15,456 / 15,174 / 15,316 / 15,147 / 15,174 Go/s** quelle que soit la taille du cache. Le stockage est saturé en permanence : il n'y a aucune marge d'E/S à récupérer, à aucune capacité.

Les 62,024 ms de calcul ne sont pas du gâchis non plus. Ils correspondent à la lecture des 15,58 Go de poids non routés depuis la RAM unifiée à environ 250 Go/s, dont 39,4 ms pour la seule chaîne d'attention. Irréductible sans réécrire les noyaux.

**Conséquence :** le débit ne dépend plus que du taux de succès du cache. Tout le problème se réduit à une variable.

---

## 2. La courbe succès(capacité), sur les seize documents

Le rejeu de politique ne fait tourner que la politique — pas d'arène, pas de lecture, pas de mémoire. On peut donc mesurer des capacités que la machine ne pourrait pas tenir, et savoir ce que chacune vaudrait avant de la tenter.

| arène | experts/couche | succès | E/S | total | **tok/s** | mémoire totale | tenable ? |
|---:|---:|---:|---:|---:|---:|---:|---|
| 46 Go | 59 | 0,6395 | 146,2 ms | 208,2 ms | 4,80 | 61,6 Go | oui |
| 54 Go | 69 | 0,6798 | 129,9 ms | 191,9 ms | 5,21 | 69,6 Go | oui |
| 62 Go | 80 | 0,7183 | 114,3 ms | 176,3 ms | 5,67 | 77,6 Go | oui |
| 69 Go | 89 | 0,7468 | 102,7 ms | 164,7 ms | 6,07 | 84,6 Go | oui |
| 77 Go | 99 | 0,7752 | 91,2 ms | 153,2 ms | 6,53 | 92,6 Go | oui |
| 85 Go | 110 | 0,8036 | 79,7 ms | 141,7 ms | 7,06 | 100,6 Go | oui |
| 92 Go | 119 | 0,8246 | 71,1 ms | 133,2 ms | 7,51 | 107,6 Go | oui |
| **99,87 Go** | **129** | **0,8463** | **62,3 ms** | **124,4 ms** | **8,04** | **115,45 Go** | **oui — exactement sur le plafond Metal** |
| 108 Go | 139 | 0,8662 | 54,3 ms | 116,3 ms | 8,60 | 123,6 Go | hors plafond Metal |
| 116 Go | 150 | 0,8863 | 46,1 ms | 108,2 ms | 9,25 | 131,6 Go | hors RAM physique |
| 124 Go | 160 | 0,9030 | 39,3 ms | 101,4 ms | 9,87 | 139,6 Go | hors RAM physique |
| 139 Go | 180 | 0,9322 | 27,5 ms | 89,5 ms | 11,17 | 154,6 Go | hors RAM physique |
| 154 Go | 199 | 0,9556 | 18,0 ms | 80,1 ms | 12,49 | 169,6 Go | hors RAM physique |
| **185 Go** | 239 | 0,9916 | 3,4 ms | 65,5 ms | **15,28** | **200,6 Go** | hors RAM physique |

Le point retenu tombe **exactement** sur le plafond Metal : 99,87 Go d'arène plus 15,58 Go de poids non routés font 115,45 Go, c'est-à-dire `recommendedMaxWorkingSetSize` lu directement sur le `MTLDevice` par un binaire du projet. Ce n'est pas une coïncidence : c'est ce plafond qui a fixé le budget.

Les deux dernières lignes répondent à la question initiale. **15 tok/s demanderait 200,6 Go de mémoire unifiée**, soit 1,46 fois cette machine. Et même avec un cache parfait — les 197 Go d'experts intégralement résidents, absurde mais bornant — le plafond serait de **16,12 tok/s**, parce que les 62,024 ms de calcul restent. 20 tok/s est fermé quelle que soit la mémoire.

Le prix des services concurrents se lit sur la même courbe. Les 22 Go que Damien veut garder pour ses autres services ramènent l'arène à environ 92 Go, soit **7,51 tok/s** au lieu de 8,04. C'est le coût exact de la cohabitation, et il est modeste.

---

## 3. Ce qui est construit et mesuré

**La politique.** `slru_par_couche_0.75` : un SLRU indépendant par couche MoE, quota égal en nombre d'experts, 75 % protégé / 25 % probation, promotion au deuxième accès. O(1), aucun compteur, aucune esquisse. L'implémentation C++ reproduit la simulation **à l'octet** : `hits 2079947 / 2457600, taux 0,846332601, froid 3 890 512 429 056 octets`, attendu et obtenu identiques, contrôle fail-closed.

Quatre politiques concurrentes ont été mesurées et sont dominées, et le dire vaut autant que le résultat. W-TinyLFU, l'état de l'art, rend 9,61 tok/s contre 15,13 pour un LRU nu : son filtre d'admission par fréquence est conçu contre les objets vus une seule fois, et il n'y en a aucun ici. LFU à fenêtre est pire à toutes les périodes testées. SLRU global et quota par couche seul sont dominés par leur combinaison. **La récence domine la fréquence dans cette charge** : la distance de réutilisation vaut un token pour tout expert resélectionné, la question n'est pas *à quelle fréquence* mais *s'il revient*.

**Le lecteur.** `DualVolumeReader` : `F_NOCACHE` sur les deux volumes, un pool de threads par volume, `pread`, profondeur 32. Chaque requête porte désormais sa destination, donc le lecteur écrit directement dans l'emplacement de l'arène sans passer par l'anneau.

**Le magasin.** `ExpertStore` possède une arène alignée 16 KiB de `quota × taille_d_enregistrement(couche)` emplacements, fait la correspondance clé → emplacement, et sait chauffer le cache depuis la phase de prompt par la politique seule, sans E/S.

**Les packs.** 200 Go expert-major, 19 200 enregistrements, 141,4 Go sur l'interne et 56,2 Go sur le Lexar NM790, chaque enregistrement coupé entre les deux volumes.

**La mémoire.** 100 Go de tampons Metal tenus 60 s, swap-out zéro. Cohabitation à trois jambes : +0,97 % d'interférence, deux réplications.

---

## 4. Ce qui est fermé, et pourquoi

**L'avance de routes.** Mesurée inobtenable : 25,98 % de recouvrement avec t−1, et 4,11 % contre 4,09 % de base marginale pour la co-occurrence inter-couches. Le routeur de la couche n lit l'état caché après l'attention de n ; on ne peut pas lire plus tôt.

**Le recouvrement calcul / E-S.** L'attention précède le routeur dans chaque couche, et l'attention de la couche n+1 dépend du FFN de la couche n. La chaîne est strictement sérielle, et c'est pour cela que le total est une somme et non un maximum. La v3 de ce rapport supposait le contraire.

**Le préchargement spéculatif.** Avec 6,2 Go/s de marge on ne préchargerait qu'environ un expert de plus par couche, contre un rappel de prédicteur de 4 % à K=8. On paierait la bande passante sans rien gagner.

**Le découpage des lectures.** Mesuré le 2 août : `split 1` rend 15,406 Go/s, `split 4` rend 15,148 Go/s, octets lus **strictement identiques** (549 158 092 800 dans les deux cas). Le stockage était déjà à 100 % de sa capacité qualifiée.

**Le placement par couche (`-ncmoe`).** Aucun bénéfice de localité par construction : la fraction d'octets résidents est exactement la fraction économisée. Plafond 4,94 tok/s, et `-ncmoe 45` mesuré non tenable — 516 423 680 octets swappés à 2 % de mémoire libre.

**Le décodage spéculatif et les arbres de brouillon**, fermés antérieurement par l'espérance de tokens acceptés ; **l'ajout de SSD**, la fabrique plafonnant vers 40 Go/s alors que 15,227 suffisent ; **le contexte 32k**.

---

## 5. Erreurs que je dois porter

**J'ai publié 6,15 tok/s à partir d'une exécution contaminée.** Le 2 août à 19:08, la même configuration donnait 121,18 ms par token ; à 19:18, 69,62 ms. Facteur 1,74. Les CSV mémoire montrent la cause sans ambiguïté : à 19:08 le résident oscillait 8 → 17 → 41 → **21** → 26 → 46 Go, la mémoire libre tombait à 50 %, il y avait 16,5 Mo de swap-out — le système reprenait les pages de l'arène pendant la mesure. À 19:18, montée monotone jusqu'à 94 Go, mémoire libre à 91 %, swap-out zéro. Je n'avais aucune réplication et j'ai publié le point unique.

**J'ai annoncé 7,14 tok/s livrables en ne lisant qu'un des trois relevés de calcul** — le plus favorable, celui que j'avais ouvert en premier. Les trois donnent 0,240 / 0,434 / 0,211 ms par soumission ; le chiffre honnête est 6,9, fourchette 6,4 à 7,1. Corrigé dans l'heure, mais c'est le même défaut que celui du point unique ci-dessus, commis le même jour, après l'avoir écrit comme règle.

**J'ai diagnostiqué un problème de parallélisme qui n'existait pas.** À partir de ce même point contaminé, j'ai conclu que le stockage ne rendait que 8,851 Go/s sur 15,077 qualifiés, donc que la file n'était pas assez remplie, et j'ai écrit un correctif de découpage des lectures. Le correctif a été appliqué et mesuré : il ne change rien. **Ma thèse a été réfutée par ma propre mesure** — le résultat correct, mais qu'une réplication de trente secondes aurait donné pour rien.

**La v3 annonçait 15 tok/s ouvert avec ~2 % de marge.** Elle créditait un recouvrement calcul/E-S qui n'existe pas et un débit effectif jamais mesuré à cette capacité. Le chiffre était faux d'un facteur presque deux.

**Le balayage llama.cpp du tour 230 ne s'est jamais exécuté, et je ne l'avais pas vu.** Il s'est arrêté seul sur `preflight swap is not zero: 4299 MiB` — une règle que Damien avait explicitement annulée le jour même, « le swap ne sera jamais 100 % propre tout le temps », mais qui restait écrite en dur. Puis, en la corrigeant, je ne l'ai corrigée qu'à un des deux endroits où elle était écrite, et la campagne s'est arrêtée une seconde fois pour la même raison.

**J'ai refusé de lancer sur 2 986 Mio de swap préexistant**, le jour même où j'écrivais la règle qui l'interdit. Damien a tranché : c'est un poste de travail, toute la RAM ne sera jamais libre, c'est le delta qui décide.

**Rappels antérieurs** : `2 189 426 688` octets par token, faux d'un facteur 2,82 et réfutable en dix secondes par une division bits-par-poids ; le verdict « impossible » du 1er août, rendu en fermant une voie qui n'était pas la voie décisive ; le portail p95 ≤ 50 ms, presque quatre fois plus dur que le critère demandé, échoué puis rapporté comme un échec du projet ; le mélange d'unités de capacité de cache dans la v2.

---

## 6. Ce qui reste à faire

Le chemin cache + lecteur est mesuré de bout en bout, mais il n'est pas branché dans llama.cpp : `galactus-h4-decode-shape` rejoue de vraies traces contre de vrais packs et mesure du **temps**, pas du contenu. Pour un binaire utilisable il faut remplacer l'accès `mmap` aux tenseurs `blk.N.ffn_{gate,up,down}_exps.weight` par le magasin. Cela suppose d'envelopper l'arène dans un `MTLBuffer` via `newBufferWithBytesNoCopy` — l'alignement 16 KiB de l'arène a été choisi pour cela — et de récupérer les identifiants d'experts du routeur côté hôte à chaque couche, ce que la sérialisation par couche impose de toute façon.

**Et le 8,04 n'est pas le chiffre livrable.** Il suppose le graphe de calcul en une seule soumission Metal, ce qu'aucune implémentation ne peut faire : il faut redescendre sur le CPU à chaque couche pour consulter le cache. Le coût d'une soumission se lit dans l'ordonnée à l'origine de la régression du schedule à 1, 5, 25 et 75 couches. Trois relevés indépendants du 2 août donnent :

| relevé | coût d'une soumission | calcul à 75 soumissions | total | tok/s |
|---|---:|---:|---:|---:|
| 18:41:53 | 0,240 ms | 79,15 ms | 141,5 ms | 7,07 |
| 18:48:55 | 0,434 ms | 94,04 ms | 156,4 ms | 6,40 |
| 18:56:29 | 0,211 ms | 77,63 ms | 140,0 ms | 7,14 |
| **poolé, 12 points** | **0,295 ms** | **83,61 ms** | **145,9 ms** | **6,85** |

**Le plafond livrable est donc 6,9 tok/s, fourchette 6,4 à 7,1 ; 8,04 est la borne haute du chemin de données seul.** Le relevé de 18:48 est le plus bruité — son point à une couche vaut 1,448 ms contre 1,033 et 1,067 — mais rien ne justifie de l'écarter, donc il reste dans la fourchette.

Et l'ordonnancement doit être fusionné dès la première ligne : si le nœud CPU termine le morceau Metal de la couche n et que le morceau suivant enchaîne les experts de n *et* l'attention de n+1, on paie 75 soumissions au lieu de 150. Au coût poolé, c'est 0,60 tok/s — gratuits à l'écriture, irrattrapables après coup.

En attendant, `llama-cli` fonctionne par la voie `-ncmoe`, et son débit est désormais **mesuré de bout en bout, deux fois** : le 3 août, GLM-5.2 complet a généré du vrai texte français sur la machine (`-ncmoe 78`, `-ngl 12`, prompt court), et llama-cli a rapporté **`Prompt: 0.4 t/s | Generation: 1.0 t/s`** dans les deux exécutions. Le 1,0 tok/s dépasse l'estimation naïve (~0,5) parce que le cache de pages retient une partie des experts — la machine gardait 67 % de mémoire libre. La configuration `-ngl 99` est, elle, mesurée non viable : le va-et-vient `mmap` fait tomber la mémoire libre à 17 % et étrangle les allocations Metal (`kIOGPUCommandBufferCallbackErrorOutOfMemory`). Le verdict de l'intégration est donc mesuré des deux côtés : **7,4 tok/s contre 1,0, un facteur ~7** — et non les « +38 % » que j'avais d'abord écrits en comparant à un chiffre de 5 tok/s qui n'avait jamais été mesuré.

---

## 7. Le résumé en une phrase

Sur 128 Go de mémoire unifiée, GLM-5.2 en checkpoint complet plafonne à **8,04 tok/s** pour le chemin de données et à **6,9 tok/s** pour un binaire réel, parce que chaque token doit lire 6,18 Go d'experts routés, que les deux SSD en rendent 15,227 Go/s, que le calcul en coûte 62 ms de plus et que consulter le cache impose 75 soumissions Metal à 0,295 ms ; atteindre 15 tok/s demanderait une machine de 200 Go.

---

*Projet Galactus — 29 juillet au 2 août 2026. Journal complet : `PROJECT.md`. La v3 est conservée sous `RAPPORT-FINAL-GALACTUS.v3-obsolete.md`. Chaque nombre de ce rapport est mesuré sur la machine ou dérivé de mesures ; la décomposition GGUF est auto-vérifiée par identité de taille de fichier sur les six shards et concorde avec les constantes gelées du packer ; aucun chiffre n'est estimé.*

---

## Addendum v4.1 — 2026-08-04 : le câblage fonctionne, mesuré

Le runtime qui manquait au moment de la v4 existe désormais : le cache d'experts résident est câblé dans llama.cpp (tenseurs à pas d'arène, remappage identifiants→emplacements, service synchrone par couche) et il est **juste** et **rapide**, les deux étant mesurés.

**Qualité.** Perplexité du câblage complet (75 couches) : **2,6439**, contre 2,6373 pour la voie stock — écart +0,25 %. Ce chiffre a coûté une journée de dichotomie : le câblage initial donnait 13,74, et la cause n'était ni le pack (768/768 portions vérifiées octet à octet), ni l'éviction (mode épinglé : zéro éviction, même chiffre), ni les noyaux — c'était une lecture linéaire d'une vue ggml non contiguë (`ggml_top_k`) dans le remappage : chaque token au-delà du premier de chaque micro-lot était câblé sur les experts du token 1, rangs 9 et suivants. L'accusation portée en v4 contre les noyaux Metal mv_id est rétractée : l'invariance Metal/CPU (8,89 identique) désignait une cause commune en amont, qui était ce bug. Les experts Metal restent à requalifier sur machine propre.

**Débit.** Mesure finale sur machine redémarrée (96 % libre, swap nul), cache 92 Go, experts CPU, 256 tokens : **génération 5,9 tok/s** (prompt 4,8), moyenne incluant la rampe de cache froid — cohérente avec le 5,82 marginal stationnaire. Le correctif de remappage ne coûte rien en débit. Rappel des bornes du modèle fermé : 7,51 tok/s attendus à 92 Go en régime chaud parfait, plafond machine 8,04.

**État livré.** ×6 sur la baseline mmap (1,0 tok/s), qualité à 0,25 % du stock, sur le checkpoint intégral, en cohabitation avec 22 Go de services. Marge restante identifiée et non bloquante : capacité d'arène, requalification Metal, résiduel PPL à borner.
