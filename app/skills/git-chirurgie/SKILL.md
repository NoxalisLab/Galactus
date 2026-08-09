---
name: git-chirurgie
description: "Git délicat : annuler, réécrire l'historique, récupérer du perdu, conflit, bisect."
---

Git perd très peu de choses, mais il en cache beaucoup. Deux règles : **pose un point de retour avant chaque opération**, et **ne réécris jamais un historique déjà poussé et partagé**.

## 0. État des lieux ; obligatoire, avant la première manipulation
```
run_command("git status --short --branch; echo '---'; git log --oneline -10; echo '---'; git stash list")
```
- Travail non commité présent : sauvegarde-le AVANT tout, sinon la moindre opération peut l'effacer.
```
run_command("git stash push -u -m 'avant-operation-$(date +%s)'")
```
- Pose l'étiquette de retour, c'est ta bouée :
```
run_command("git branch retour-$(date +%Y%m%d%H%M%S)")
```
Cette branche pointe sur l'état actuel. Tant qu'elle existe, aucune opération n'est irréversible.
- Annonce à l'utilisateur ce que tu vas faire, sur quel commit, et comment revenir. Attends l'accord pour toute opération de la section 3.

## 1. La question qui oriente tout : est-ce poussé ?
```
run_command("git log --oneline origin/$(git branch --show-current)..HEAD")
```
- Sortie vide : rien de local en avance, tout est partagé. **Réécriture interdite.** On corrige par un nouveau commit (`git revert`).
- Sortie non vide : ces commits ne sont qu'à toi, tu peux les réécrire.
Ne devine jamais. Cette commande décide entre `revert` et `reset`.

## 2. Opérations de lecture ; sans risque, à faire en premier
| Besoin | Commande |
|---|---|
| Qui a modifié cette ligne | `git log -L 42,50:chemin/fichier.py` |
| Quand un texte est apparu ou disparu | `git log -S 'texte' --oneline` |
| Ce que contenait un fichier à un commit | `git show SHA:chemin/fichier.py` |
| Différence entre deux branches | `git diff main...ma-branche --stat` |
| Retrouver un commit « perdu » | `git reflog --date=iso \| head -40` |
| Un commit est-il déjà dans main | `git branch --contains SHA` |

`git reflog` est la réponse à la quasi-totalité des « j'ai tout perdu ». Il garde les positions de HEAD pendant environ 90 jours. Trouve le SHA, puis `git branch recuperation SHA`.

## 3. Opérations qui réécrivent ; accord explicite obligatoire
- **Annuler un commit déjà poussé** : `git revert SHA`. Crée un commit inverse, ne réécrit rien, ne casse personne. C'est le défaut sur une branche partagée.
- **Annuler des commits locaux en gardant le travail** : `git reset --soft SHA` (tout revient en index) ou `git reset --mixed SHA` (tout revient en modifications non indexées).
- **`git reset --hard`** : détruit les modifications non commitées. C'est une action élevée, l'application demandera un `ALLOW` tapé. Ne la propose que si le stash de l'étape 0 est fait, et dis-le.
- **Corriger le dernier commit** : `git commit --amend`. Uniquement s'il n'est pas poussé.
- **Réordonner ou fusionner des commits locaux** : le rebase interactif n'est **pas disponible** ici, `run_command` n'a aucune interactivité et l'éditeur ne s'ouvrira pas. Deux contournements : construire la séquence non interactivement (`git reset --soft SHA` puis recommit en une fois), ou donner à l'utilisateur la commande `git rebase -i SHA` à taper lui-même dans son terminal.
- **Extraire un commit vers une autre branche** : `git cherry-pick SHA`, puis vérifier que le résultat compile.

## 4. Conflits
```
run_command("git status --short | grep '^UU\\|^AA\\|^DU\\|^UD'")
```
- Traite les conflits **un fichier à la fois**. Lis le fichier entier avec `read_file`, pas seulement les marqueurs : le contexte autour décide.
- Comprends les deux côtés avant de choisir. `git log --oneline --left-right MERGE_HEAD...HEAD` te dit d'où vient chaque côté.
- Ne garde jamais les deux versions « pour ne pas choisir ». Ne supprime jamais un côté sans avoir lu ce qu'il apportait.
- Après résolution, vérifie qu'aucun marqueur ne reste :
```
run_command("grep -rn '<<<<<<<\\|>>>>>>>\\|=======' CHEMIN | head")
```
Puis compile et lance les tests AVANT `git add` et `git commit`. Un merge qui ne compile pas casse la branche pour tout le monde.
- Merge à abandonner : `git merge --abort` tant que rien n'est commité.

## 5. Trouver le commit fautif ; bisect
```
run_command("git bisect start && git bisect bad && git bisect good SHA_BON_CONNU")
```
Puis, à chaque étape, lance le test (timeout 120 s) et réponds `git bisect good` ou `git bisect bad`. Si un test unique tient sous 120 s, automatise :
```
run_command("git bisect run sh -c 'COMMANDE_DE_TEST'")
```
**Termine toujours par `git bisect reset`**, même en cas d'échec : sinon le dépôt reste en tête détachée et toutes les opérations suivantes partent de travers.

## Garde-fous
- Jamais de `push --force` sur une branche partagée. Si c'est vraiment nécessaire sur une branche personnelle, `--force-with-lease` et jamais `--force`. `git push` est toujours confirmé explicitement par l'utilisateur.
- Jamais de `git clean` ni de `git checkout -- fichier` sans avoir listé ce qui va disparaître (`git clean -nd`, `git diff -- fichier`) et fait valider.
- Ne supprime jamais une branche sans avoir vérifié qu'elle est fusionnée : `git branch --merged main`.
- Ne réécris jamais l'historique de `main` ou `master`. Pas d'exception négociable.
- Une manipulation qui tourne mal : `git reflog`, puis `git reset --hard` vers la branche de retour posée à l'étape 0. Dis-le à l'utilisateur au lieu d'empiler les tentatives.
- Restitution finale : l'état avant, l'opération exacte exécutée, l'état après (`git log --oneline -5` et `git status`), le nom de la branche de retour, et la commande précise pour revenir en arrière.
