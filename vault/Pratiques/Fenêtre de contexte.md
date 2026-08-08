---
title: Fenêtre de contexte
tags: [pratique, contexte]
description: 8192 tokens par conversation, ce qui déborde vers les fichiers scratch et ce que le résumé automatique change.
---

# Fenêtre de contexte

## Les chiffres réels

- **8192 tokens par slot** de conversation. Le moteur démarre avec 2 slots par
  défaut (réglable de 1 à 4), et chaque slot garde ses 8192 tokens.
- À **75 % de remplissage**, l'assistant résume lui-même les plus anciens tours
  avant que la fenêtre déborde, sous consigne stricte : faits, chiffres,
  chemins, sources, rien d'inventé. Le résumé rejoint le prompt système.
- Une sortie d'outil de plus de **20 000 caractères** part entièrement dans un
  fichier scratch ; l'historique ne garde que les 8 000 premiers caractères et
  le chemin du fichier. La réponse d'un coéquipier a droit à 40 000.
- `read_file` lit **200 000 octets** au maximum par appel, avec `offset`.
- `run_command` : **120 secondes**, sortie tronquée à 200 Ko.

## Ce que cela implique

1. **Ne fais jamais lire un gros fichier d'un coup.** Demande une lecture par
   sections, ou un `grep` ciblé en amont.
2. **Une conversation = un objectif.** Ouvrir un nouveau fil coûte moins cher
   qu'un résumé qui perd la moitié du fil.
3. **Le scratch est une ressource, pas une panne.** Quand une sortie a débordé,
   la bonne suite est : « relis le fichier scratch à partir de l'offset 8000 et
   extrais uniquement les lignes contenant ERROR ».
4. **Après un résumé, requalifie.** Redonne le chemin du fichier en cours et le
   but ; le modèle a gardé les faits, pas la texture.

## Prompts qui économisent le contexte

```
Ne me montre pas le contenu des fichiers. Lis-les et rends-moi seulement un
tableau : fichier | rôle | 1 risque.
```

```
Grep d'abord, lis ensuite : run_command("grep -rn 'createUser' src/ | head -40")
puis ouvre uniquement les 3 fichiers les plus pertinents.
```

```
Cette sortie est trop grosse. Écris-la dans un fichier avec
run_command("... > /tmp/out.txt"), puis lis-la par tranches de 40 Ko.
```

## Quand déléguer plutôt que compresser

Une tâche qui demande de lire dix documents ne tient pas dans une fenêtre. Un
coéquipier lit, distille et renvoie une synthèse : le détail reste dans son fil,
pas dans le tien. Voir [[Équipes de sous-agents]].

## Suite

[[Bien demander]] · [[Équipes de sous-agents]] · [[Outils de l'assistant]] ·
[[Choisir un modèle]] · [[Conventions du coffre]]
