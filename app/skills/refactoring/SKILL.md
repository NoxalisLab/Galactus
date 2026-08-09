---
name: refactoring
description: "Améliorer la structure d'un code sans changer son comportement."
---

Définition stricte : refactorer, c'est changer la forme **sans changer le comportement observable**. Si le comportement change, ce n'est pas un refactoring, c'est un changement, et il se traite autrement.

## 0. Le filet de sécurité ; obligatoire avant la première ligne
- `run_command("git status")` : l'arbre doit être propre. Sale, tu t'arrêtes et tu le dis ; sans point de retour, un refactoring est un pari.
- Trouve et lance la suite de tests couvrant la zone (README, Makefile, package.json). Note le nombre de tests verts. **C'est ton oracle.**
- Aucun test sur la zone ? Tu n'as pas le droit de refactorer. Deux options, à faire valider : écrire d'abord des tests de caractérisation (skill `ecrire-des-tests`), ou renoncer. Dis-le clairement, ne refactore pas à l'aveugle.
- Test trop lent pour 120 s : identifie le sous-ensemble qui couvre la zone et utilise-le comme oracle, en annonçant la limite.

## 1. Mesure avant de décider
Ne refactore pas sur une impression. Chiffre :
```
run_command("wc -l CHEMIN; grep -c 'def \\|function \\|fn ' CHEMIN")
run_command("grep -rn 'NOM_DE_SYMBOLE' --include='*.py' . | wc -l")
```
Dans un espace de travail ouvert, `search_workspace` remplace `grep` et `find_files` remplace `find` : pas de shell, pas de barrière à franchir.
Rends un tableau : fichier, lignes, nombre de fonctions, plus longue fonction, nombre d'appelants du symbole visé. Ce tableau justifie le périmètre.

## 2. Nomme le défaut, pas l'envie
Un refactoring se rattache à un défaut identifié :

| Défaut | Signe mesurable | Transformation |
|---|---|---|
| Fonction trop longue | > 60 lignes, ou > 3 responsabilités | extraire des fonctions nommées |
| Duplication | même bloc en 3 endroits ou plus | extraire vers un module partagé |
| Imbrication profonde | plus de 4 niveaux | clauses de garde, retour anticipé |
| Paramètres trop nombreux | plus de 5 | objet de paramètres ou structure |
| Nommage trompeur | le nom ment sur ce que fait le code | renommage, avec tous les appelants |
| Code mort | 0 appelant trouvé par recherche | suppression |

Aucun défaut de cette table ne s'applique ? Ne refactore pas. Dis pourquoi.

## 3. Un pas, un test, un commit
La discipline entière tient ici :
1. UNE transformation, sur UN fichier.
2. Relance l'oracle. Même nombre de tests verts qu'à l'étape 0, ou tu reviens en arrière.
3. `run_command("git diff")` et relis le hunk : y a-t-il un changement de comportement caché (ordre modifié, condition inversée, valeur par défaut ajoutée) ?
4. Point d'étape sûr : propose un commit avec un message `refactor(scope): …`.
5. Seulement alors, transformation suivante.

Jamais deux transformations avant un test vert. C'est ce qui permet de savoir laquelle a cassé quoi.

## 4. Les gestes qui trompent le plus
- **Renommage** : un renommage manuel oublie toujours un appelant. Compte AVANT (`search_workspace` ou `grep -rn`), renomme, recompte : le total doit être identique, réparti différemment. Attention aux occurrences en chaîne de caractères, dans les templates et dans les tests.
- **Extraction de fonction** : vérifie ce que le bloc extrait capturait de son contexte (variables mutables, `self`, exceptions, `return` précoce). Un `return` dans le bloc extrait ne sort plus de la fonction appelante.
- **Suppression de code mort** : la recherche textuelle ne voit pas la réflexion, les chaînes, les points d'entrée dynamiques. Cherche aussi le nom en tant que texte avant de supprimer.
- `write_file` réécrit le fichier ENTIER : interdit sans avoir lu tout son contenu dans cette session. Fichier trop gros pour ta fenêtre : remplacement ciblé via `run_command` (python3 ou sed sur la zone lue), jamais de réécriture intégrale.

## 5. Preuve de non-régression
Avant de conclure, produis les trois éléments, sans quoi le refactoring n'est pas terminé :
- La sortie de la suite de tests, avant et après, avec le même total.
- `run_command("git diff --stat")` : le nombre de fichiers touchés doit correspondre au plan annoncé.
- Le build, s'il existe : un refactoring qui ne compile pas est un refactoring raté.

## Garde-fous
- Jamais de refactoring et de correction de bug dans le même patch. Si tu trouves un bug en refactorant, note-le et continue ; il fera l'objet d'un autre passage.
- Ne touche pas à une interface publique (API, signature exportée, schéma) sans annoncer le plan et obtenir l'accord.
- Un test qui casse pendant un refactoring signale presque toujours un changement de comportement, pas un test à corriger. Ne modifie jamais le test pour le faire passer.
- Deux transformations d'affilée sans test vert : arrête, reviens au dernier point sûr.
- Restitution finale : les défauts corrigés avec leur mesure avant et après, les fichiers touchés, la preuve de non-régression, et ce qui reste à faire.
