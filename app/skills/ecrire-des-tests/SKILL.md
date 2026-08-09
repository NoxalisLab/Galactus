---
name: ecrire-des-tests
description: "Écrire des tests : fonctionnalité neuve, verrouiller un bug, code sans filet."
---

Principe unique : **un test que tu n'as pas vu échouer ne prouve rien**. Le cycle est rouge, puis vert, dans cet ordre, toujours.

## 0. Trouve le harnais existant ; n'en invente pas un
- `list_directory` sur la racine, puis lis le fichier de build : `pyproject.toml`, `package.json`, `Makefile`, `Cargo.toml`, `CMakeLists.txt`.
- Repère le dossier de tests et lis UN test existant en entier : il te donne le framework, les conventions de nommage, les fixtures, la façon de lancer.
- Note la commande exacte de lancement et vérifie-la tout de suite sur un test unique :
```
run_command("pytest CHEMIN/test_x.py::test_y -q 2>&1 | tail -20")
```
- Aucun harnais dans le projet : ne l'installe pas de ta propre initiative. Propose-le, et en attendant écris un script `python3` autonome en stdlib (`unittest` est dans la stdlib, `pytest` ne l'est pas).

## 1. Le cycle, sans exception
1. **Rouge** : écris UN test qui décrit le comportement attendu. Lance-le. Il DOIT échouer.
2. **Lis le message d'échec.** Il échoue pour la bonne raison (assertion non satisfaite) ou pour une mauvaise (import manquant, faute de frappe, fixture absente) ? Une mauvaise raison, c'est un test cassé, pas un test rouge : corrige le test avant d'écrire la moindre ligne de production.
3. **Vert** : écris le minimum de code pour le faire passer. Relance.
4. **Nettoie**, en restant vert.
5. Test suivant.

Un test écrit après le code doit quand même être vu rouge : commente la correction, relance, constate l'échec, restaure. C'est le seul moyen de savoir que le test teste quelque chose.

## 2. Ce qu'un bon test contient
- **Un comportement par test.** Deux assertions sur deux comportements = deux tests.
- **Un nom qui décrit le comportement**, pas la fonction : `test_retourne_zero_quand_la_liste_est_vide`, pas `test_calcul`.
- **Trois blocs visibles** : préparation, action, vérification.
- **Des valeurs réelles**, pas des mocks qui se testent eux-mêmes. Un test qui vérifie qu'un mock a été appelé teste le mock, pas ton code. Ne mocke que ce qui sort du processus : réseau, horloge, aléa, système de fichiers si nécessaire.
- **Déterminisme** : pas de `datetime.now()`, pas de `random` sans graine, pas de dépendance à l'ordre des tests, pas de `sleep` arbitraire.

## 3. Quoi couvrir, dans cet ordre
1. Le cas nominal, une fois.
2. Les bornes : vide, un seul élément, valeur nulle, zéro, négatif, maximum, chaîne vide, unicode, très grand.
3. Les erreurs attendues : la fonction doit-elle lever ? Vérifie le type ET le message.
4. Les régressions : chaque bug corrigé mérite un test qui échoue sur le code d'avant.
Ne cherche pas un pourcentage de couverture. Vise les chemins qui, s'ils cassent, coûtent cher.

## 4. Code existant sans test ; tests de caractérisation
Quand tu dois poser un filet avant de refactorer :
1. N'écris pas ce que le code DEVRAIT faire ; écris ce qu'il FAIT.
2. Appelle la fonction avec des entrées représentatives, observe la sortie réelle via `run_command`, et fige-la dans une assertion.
3. Une sortie qui te paraît fausse se fige quand même, avec un commentaire `# comportement actuel, à confirmer`. Signale-la à l'utilisateur, ne la corrige pas dans le même passage.
4. Ces tests protègent le refactoring ; ensuite seulement on discute du bon comportement.

## 5. Contraintes de cette machine
- `run_command` s'arrête à 120 s. Suite complète plus longue : lance par sous-ensembles (`pytest tests/unit -q`) et dis-le explicitement, ne prétends jamais que « tout passe » après une exécution partielle.
- Sortie > 20 000 caractères : elle part dans un fichier scratch ; relis la FIN avec `read_file(chemin, offset)`, c'est là que sont les échecs. Pour éviter le débordement : `-q`, `--tb=short`, `| tail -40`.
- Le python3 embarqué n'a que la stdlib. Vérifie avant de dépendre d'un paquet :
```
run_command("python3 -c 'import pytest' 2>&1 | tail -1")
```
Absent : `unittest`, ou propose à l'utilisateur un venv local (`python3 -m venv .venv && source .venv/bin/activate && pip install pytest`), jamais d'installation dans le Python global.
- `write_file` est une proposition que l'utilisateur accepte : écris un fichier de test complet et cohérent, pas un fragment.

## Garde-fous
- N'affaiblis jamais un test existant, ne le passe jamais en `skip`, ne relâche jamais une assertion pour faire passer une suite.
- Ne teste pas la bibliothèque des autres. Teste ton code.
- Un test qui passe du premier coup sans avoir été vu rouge est suspect : rends-le rouge avant de le garder.
- Suite volumineuse à écrire sur plusieurs modules : `spawn_agent` un coéquipier par module (2 à 6 max), chaque brief donnant le chemin du module, le chemin du fichier de test à créer, la commande de lancement et l'exigence rouge-puis-vert, puis `ask_agent`.
- Restitution finale : tests ajoutés avec leur chemin, ce que chacun verrouille, la sortie brute de la dernière exécution, et les chemins volontairement non couverts.
