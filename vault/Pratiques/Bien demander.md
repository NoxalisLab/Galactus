---
title: Bien demander
tags: [pratique, prompt]
description: Ce qui fait réussir ou échouer une instruction donnée à un modèle local à petite fenêtre.
---

# Bien demander

Un modèle local n'a ni ton historique, ni ton projet en tête, ni une fenêtre de
200 000 tokens. Il a 8192 tokens et tes outils. Une bonne instruction est donc
**située, bornée et vérifiable**.

## Les quatre éléments d'une bonne demande

1. **Le point de départ exact** : un chemin absolu, un identifiant, un nom de
   fichier. Pas « le fichier de config ».
2. **Le résultat attendu**, sous une forme nommée : un tableau markdown, un
   patch, un fichier CSV à tel chemin, trois puces.
3. **La borne** : jusqu'où aller, combien de fichiers, quel budget de temps.
4. **La vérification** : comment tu sauras que c'est juste.

## Comparatif

Mauvais :

```
Analyse mon projet et dis-moi ce qui ne va pas.
```

Bon :

```
Ouvre /Users/moi/proj/src/api/, liste les fichiers, puis lis uniquement
routes.ts et auth.ts. Donne-moi au maximum 8 problèmes, classés par gravité,
chacun avec fichier:ligne et la correction en une phrase. Ne modifie rien.
```

La seconde version borne la lecture, fixe le format, interdit l'écriture et rend
chaque affirmation vérifiable en ouvrant le fichier cité.

## Réflexes qui paient

- **Une tâche par message.** Deux tâches dans un message donnent deux moitiés.
- **Nommer l'outil** quand tu sais lequel : « avec `read_document` », « avec
  `search_workspace`, pas `grep` ». Voir [[Outils de l'assistant]].
- **Interdire explicitement** ce que tu ne veux pas : « ne modifie aucun
  fichier », « ne lance aucune commande réseau ».
- **Demander le plan d'abord** sur les tâches longues : « donne-moi ton plan en
  5 étapes avant d'agir ». En mode agent, le modèle appelle `update_plan` de
  lui-même et tu vois la checklist avancer.
- **Charger une skill** quand la tâche correspond à un métier : `/dev-senior`,
  `/analyse-documents`. Voir [[Skills et invocation]].

## Ce qui fait échouer

| Symptôme | Cause | Correctif |
|---|---|---|
| Réponse générique | Aucun chemin ni fichier cité dans la demande | Donne le chemin absolu |
| Il décrit au lieu de faire | Mode manuel, ou verbe vague | Passe en assisté, dis « fais-le » |
| Il repart de zéro à mi-parcours | Le fil a été résumé | Voir [[Fenêtre de contexte]] |
| Il invente une API | Aucune source imposée | Voir [[Vérifier avant de croire]] |
| Il s'arrête après 30 appels d'outils | Limite de boucle atteinte | Redécoupe en 2 messages |

## Suite

[[Vérifier avant de croire]] · [[Fenêtre de contexte]] · [[Niveaux d'autonomie]] ·
[[Ce que le modèle rate]] · [[Équipes de sous-agents]]
