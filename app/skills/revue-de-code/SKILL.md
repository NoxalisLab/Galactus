---
name: revue-de-code
description: "Relire le code d'un autre : diff, pull request, fichier. Constats, pas de réécriture."
---

Tu relis, tu ne répares pas. Le livrable est une liste de constats vérifiables, pas un patch.

## 0. Borne le périmètre avant de lire
- Diff local : `run_command("git diff --stat")` puis `run_command("git diff")`. Plus de 400 lignes de diff : découpe par fichier avec `git diff -- CHEMIN`.
- Branche : `run_command("git log --oneline origin/main..HEAD")` pour la liste des commits, puis `git diff origin/main...HEAD --stat`.
- Fichier ou dossier hors git : `list_directory`, puis `read_file` par sections (`offset`).
- Diff > 20 000 caractères : il part dans un fichier scratch. Relis-le par tranches avec `read_file(chemin, offset)`. Ne conclus pas avant la dernière tranche.
- Annonce en une ligne ce que tu vas relire et ce que tu laisses de côté.

## 1. Comprends l'intention avant de juger
- Lis le message de commit ou la description de la PR : `run_command("git log -3 --format='%s%n%b'")`.
- Intention absente ou incompréhensible : c'est ton premier constat, et pose UNE question. Un code correct qui ne fait pas ce qui était demandé reste un défaut.
- Repère le style du projet (nommage, gestion d'erreurs, langue des commentaires). Une remarque qui contredit la convention locale n'est pas un constat, c'est une préférence.

## 2. Les six passes ; dans cet ordre
1. **Correction** : cas limites non traités, valeur nulle, collection vide, division, index hors bornes, ordre des opérations, concurrence.
2. **Sécurité** : entrée non validée, concaténation SQL ou shell, secret en dur, chemin construit depuis une entrée, contrôle d'accès manquant. Cherche-les : `run_command("grep -rnE 'password|secret|api[_-]?key|token' CHEMIN")`.
3. **Erreurs** : exception avalée, code retour ignoré, ressource non libérée, message d'erreur qui perd la cause.
4. **Performance** : requête dans une boucle (N+1), lecture complète d'un fichier qui pourrait être streamée, allocation dans une boucle chaude. Ne signale une perte de performance que si tu peux nommer l'ordre de grandeur.
5. **Tests** : le comportement ajouté est-il couvert ? Un test qui ne peut pas échouer ne prouve rien. Vérifie qu'il existe : `run_command("git diff --stat -- '*test*' '*spec*'")`.
6. **Lisibilité** : nommage, fonction trop longue, imbrication au delà de 3 niveaux, code mort, commentaire qui ment.

## 3. Classe par gravité ; jamais par ordre de lecture
- **Bloquant** : faille, corruption ou perte de données, erreur de logique, rupture d'interface publique sans version.
- **Important** : test manquant sur un chemin critique, N+1 avéré, duplication lourde, écart d'architecture assumé nulle part.
- **Suggestion** : nommage, simplification, documentation.

Format de chaque constat, sans exception :
```
[Bloquant] chemin/fichier.py:142 ; concaténation SQL depuis une entrée utilisateur
   Ligne : cur.execute("SELECT * FROM u WHERE id=" + uid)
   Pourquoi : injection SQL, uid vient de request.args
   Correction : cur.execute("SELECT * FROM u WHERE id=%s", (uid,))
```
Sans `chemin:ligne` et sans la ligne recopiée, le constat ne compte pas. Maximum 12 constats ; au delà, garde les plus graves et dis combien tu as écartés.

## 4. Vérifie avant de rendre
- Rouvre 2 constats au hasard avec `read_file(chemin, offset)` et confirme que la ligne citée est bien à ce numéro. Un numéro de ligne faux discrédite toute la revue.
- Le projet a un linter ? Lance-le et compare : ce qu'il trouve déjà n'a pas besoin d'être dans ta liste.
- Les tests passent-ils sur cette branche ? `run_command` avec la commande du projet, timeout 120 s. Suite trop longue : lance le sous-ensemble touché par le diff, et dis-le.

## 5. Restitution
Trois lignes de verdict (ce que fait le changement, ce qui bloque, ce qui manque), puis la liste des constats par gravité, puis « Points forts » en 2 puces max. Termine par ce que tu n'as PAS relu : fichiers sautés, tranches non lues, tests non lancés.

## Garde-fous
- Ne modifie aucun fichier. Une revue qui patche n'est plus une revue ; si l'utilisateur veut le correctif, bascule sur la skill `dev-senior`.
- Pas de constat sans preuve tirée d'un outil. « Ça pourrait poser problème » n'est pas un constat.
- Ne signale jamais deux fois le même motif : groupe-le (« même schéma aux lignes 42, 78, 91 »).
- Ne juge pas le style personnel de l'auteur quand le projet n'a pas de convention écrite.
- Plus de 3 fichiers volumineux à relire : `spawn_agent` un relecteur par fichier (2 à 6 max), brief autonome avec le chemin exact, les six passes et le format de constat ci-dessus, puis `ask_agent` ; fusionne et déduplique toi-même. Deux rapports contradictoires : signale-le, ne tranche pas en silence.
