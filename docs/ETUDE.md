# Étude complète — GLM-5.2 intégral (744B) sur MacBook Pro M5 Max

*Projet « Galactus ». Toutes les valeurs de ce document sont mesurées, pas extrapolées ; chaque chiffre provient d'un run consigné dans le journal de bord du projet (non versionné) et rejouable par un lanceur de `lanceurs/`.*

## 1. Objectif et contraintes

Faire tourner le checkpoint **intégral** GLM-5.2 (744B-A40B, quantisation Unsloth UD-IQ1_S à 1,5625 bpw, 202 Go en 6 shards GGUF) sur un MacBook Pro M5 Max 128 Go — sans variante élaguée, sans experts supprimés, avec exactement deux SSD, en cohabitation avec ~22 Go de services résidents.

Le problème arithmétique : les experts routés pèsent **197,6 Go** à eux seuls (19 200 enregistrements : 75 couches MoE × 256 experts). Chaque token en route 8 par couche, soit **6 175 850 496 octets** touchés par token si rien n'est résident. La mémoire ne peut pas les contenir ; le stockage doit les servir.

## 2. Matériel testé

| | |
|---|---|
| Machine | MacBook Pro, Apple M5 Max, 128 Go de mémoire unifiée |
| SSD 1 | Apple interne |
| SSD 2 | Lexar NM790 (NVMe externe) |
| Débit packs soutenu | **15,227 Go/s** effectif, écart-type 0,55 % sur 8 mesures (lectures F_NOCACHE réparties sur les deux volumes) |
| Plafond mémoire GPU réel | `recommended_max_working_set_bytes` = 115 448 725 504 o (lu du pilote — voir §10, règle 23) |

## 3. Le modèle fermé de la machine

Trois constantes mesurées suffisent à prédire le débit à mieux que 1 % :

```
octets d'experts par token      6 175 850 496
débit de stockage effectif      15,227 Go/s
calcul (75 couches, schedule)   62,024 ms
ms/token = 405,6 × (1 − taux de succès du cache) + 62,024
```

Vérification : sur quatre capacités de cache indépendantes, les octets réellement lus par token collent à la formule à 0,07-0,10 % près, et le débit de stockage reste plat (le disque est saturé en permanence — il n'y a pas de marge d'E/S cachée).

Conséquences fermées : **plafond de cette machine 8,04 tok/s** (cache maximal tenable) ; 15 tok/s exigerait ~200 Go de mémoire unifiée ; 20 tok/s est hors d'atteinte de l'architecture, mémoire infinie comprise (16,12 tok/s avec résidence parfaite absurde). À 92 Go de cache — la config de cohabitation — le régime chaud parfait vaut 7,51 tok/s.

## 4. Les packs P0 : le stockage comme tier de service

Les GGUF rangent les tenseurs par matrice ; servir un expert y coûterait trois lectures dispersées. Le packer réécrit les 19 200 enregistrements en **records contigus** (`down`+`gate`+`up`, ordre gelé, alignés 16 KiB — condition de F_NOCACHE) dans deux fichiers pack, un par SSD, coupés au point qui égalise les temps de service selon les débits mesurés par volume (profil P0v2 71,57/28,43). Trois classes de tailles d'enregistrement :

| classe | couches | record | quants |
|---|---|---|---|
| A | 53 | 9 732 096 o | gate/up iq1_s, down iq3_xxs |
| B | 18 | 11 304 960 o | gate/up iq2_xxs, down iq3_xxs |
| C | 4 | 13 172 736 o | down iq4_xs |

Le plan (le plan de pack (JSON, non versionné)) trace chaque span source GGUF → offset pack, et a servi de référence à toutes les vérifications de contenu.

## 5. Le magasin résident et sa politique

Une **arène** épinglée (posix_memalign, 16 KiB) porte un quota égal d'emplacements par couche (92 Go → 119 experts/couche sur 256). Un **SLRU par couche** (probation + protégé, promotion au 2e accès) décide des résidents.

Politiques mesurées et dominées : W-TinyLFU (l'état de l'art) rend 9,61 tok/s contre 15,13 pour un LRU nu sur les mêmes traces — son filtre d'admission par fréquence combat des objets vus une seule fois, inexistants ici ; la LFU à fenêtre est pire à toutes les périodes ; SLRU global et quota-seul sont dominés par leur combinaison. **La récence domine la fréquence dans cette charge.**

Le placement par couche de llama.cpp (`-ncmoe`) a été mesuré comme point de comparaison : aucune localité exploitable par construction (la fraction résidente = la fraction économisée), plafond 4,94 tok/s, et son meilleur point réel non tenable en mémoire. La granularité **par expert** est le cœur du gain.

## 6. L'intégration llama.cpp : 2 fichiers + ~130 lignes

Tout est gardé par `GALACTUS_H4=1` (binaire identique à l'amont sinon) :

- les tenseurs d'experts naissent à `ne[2]=quota` avec `nb[2]=record` (pas inter-expert = l'enregistrement du pack), marqués `TENSOR_SKIP` — le GGUF n'est jamais lu pour eux ;
- après chargement, ils sont **adossés sans copie** à l'arène (`ggml_backend_cpu_buffer_from_ptr`, ou tampon Metal host-pointer avec chevauchement de découpe = la plaque d'une couche entière) ;
- un nœud `ggml_map_custom1` inséré après le routeur **remappe identifiants → emplacements** et sert la couche de façon synchrone (accès cache, `pread` F_NOCACHE des manquants, attente) avant le `mul_mat_id` ;
- gardes fail-closed : lot ≤ segment probation (impose `-ub 2`), assert de somme des rôles contre le record gelé, détection de fuite d'emplacements, garde mémoire externe (swap/empreinte/plancher disque).

## 7. La chasse au bug de perplexité (tours 234-238)

Le câblage a généré du texte fluide dès l'allumage — et une perplexité de **13,74** contre 2,64 de référence. Un jour de dichotomie, quatre instruments :

1. **Bissection par plages** (`GALACTUS_H4_ONLY_LAYERS`) : 3-77 → 13,74 ; 3-3 → 2,6518 ; 6-6 → 2,5993 ; 8-8 → 2,7476. Le signal décisif : *aucune* couche seule ne rend exactement 2,6373 — or un câblage bit-exact ne peut pas faire bouger le chiffre, même vers le bas. Le « meilleur » 2,5993 était une anomalie au même titre que le pire.
2. **Sonde épinglée** (zéro éviction : 256 emplacements/couche câblée) : 2,5993 identique au SLRU → éviction innocentée, mécanisme déterministe.
3. **Vérification exhaustive de contenu** : les 256 experts de la couche 6, 768 portions comparées octet à octet au GGUF via le vrai magasin — **0 échec** → pack et lecteur innocentés.
4. **Différentiel intégral** : dump de tous les tenseurs MoE d'une couche sur les 257 micro-lots, empreinte fnv1a64 de *tous* les octets, stock contre câblé. Le premier différentiel (borné à 4 096 éléments/tenseur) rendait « aucune divergence » avec deux PPL différentes — paradoxe logiquement impossible qui a révélé l'angle mort : `l_out` fait 6144×2 = 12 288 éléments, **le token 2 de chaque micro-lot n'était jamais comparé**. Sonde étendue : divergence dès le premier micro-lot, sur `ffn_moe_gate`, token 2 seulement, routage et poids identiques.

**La cause** : `selected_experts` est une **vue ggml non contiguë** (`ggml_top_k` : ne=[8, n_tokens], mais nb[1] = la rangée argsort complète de 256 entiers). Le remap la lisait linéairement : correct pour le premier token, mais les éléments 8..15 sont les rangs 9..16 du token 1 — **chaque token au-delà du premier était câblé sur les experts du voisin**. Déterministe, insensible au cache, invisible de tout contrôle de contenu (les octets servis étaient justes ; c'étaient les mauvais experts).

**Le correctif** : lecture et écriture par strides (`nb[]`) dans le remap. Résultat : 13,7376 → **2,6439** sur les 75 couches, et le différentiel intégral post-correctif rend **zéro divergence avec PPL identique à 2,6373** sur une couche câblée — transparence bit à bit démontrée.

## 8. Les noyaux Metal, quantifiés par classe

Post-correctif, sondes épinglées Metal (2,9 Go de tampon, une classe à la fois) :

| classe | quants | PPL Metal | écart vs 2,6373 |
|---|---|---|---|
| A | iq1_s + iq3_xxs | 2,6310 | −0,24 % |
| B | iq2_xxs | 2,6711 | +1,28 % |
| C | iq4_xs | 2,6846 | +1,79 % |

Les noyaux `mv_id` Metal ne sont pas bit-équivalents au CPU et dérivent par classe — composé sur 75 couches, dégradation réelle. **Décision : experts CPU par défaut (bit-transparents), Metal en option documentée.**

## 9. Benchmarks récapitulatifs

| mesure | valeur | run |
|---|---|---|
| Baseline mmap | 1,0 tok/s | consignée T237 |
| Plafond `-ncmoe` | 4,94 tok/s | balayage T225-228 |
| Génération Galactus, 256 tokens machine propre | **5,9 tok/s** (prompt 4,8) | 20260804T065243Z |
| Régime chaud observé en chat live | 6,4 tok/s (prompt 8,8) | session interactive |
| Marginal stationnaire | 5,82 tok/s | mesure T236 |
| Plafond physique machine | 8,04 tok/s | modèle fermé §3 |
| PPL référence stock | 2,6373 | fit-off, ncmoe, ngl12, ub2 |
| PPL câblage 75 couches (CPU) | 2,6439 (+0,25 %) | 20260803T183655Z |
| PPL câblage 1 couche (CPU) | 2,6373 (bit-identique) | 20260804T070122Z |
| Débit lu des packs en charge | 15,2 Go/s soutenu | CSV gardes |

Corpus PPL : `coding-repobench-p-e-0048`, chunk 512, seed 42, greedy — identique pour toutes les lignes.

## 10. Ce qui a coûté cher, consigné sans maquillage

Le journal de bord conserve chaque erreur et sa correction, dont : la lecture de « 115448.73 MB » du pilote en mébioctets (5,22 Gio d'écart de plafond, six contre-vérifications passées à côté — règle 23 : *vérifier l'unité avant l'opération*) ; un point de débit publié depuis une exécution contaminée par le swap (règle : trois répétitions, valeurs individuelles) ; des sondes vides qui validaient du NaN (règle 30) ; l'éviction-sur-succès qui fuyait des emplacements ; et le remap linéaire ci-dessus (règle 32 : *un tenseur ggml est une vue jusqu'à preuve du contraire*). La découverte tardive de `-ncmoe` dans l'outil que nous avions nous-mêmes figé a sa propre note : *avant de construire, regarder ce que l'outil sait déjà faire.*

## 11. Reproductibilité

Chaque chiffre de cette étude est adossé à un lanceur de `lanceurs/` (bissection, sonde épinglée, différentiel, vérification exhaustive, mesure) et aux logs horodatés d'`artifacts/` (non versionnés, régénérables). Le patch llama.cpp est dans `patches/`, épinglé au commit amont, applicable en une commande.
