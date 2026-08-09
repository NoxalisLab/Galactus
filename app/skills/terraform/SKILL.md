---
name: terraform
description: "Terraform ou OpenTofu : lire un plan, module, apply, import, destruction non voulue."
---

Le plan est la seule vérité. **On ne fait jamais `apply` sans avoir lu le plan ligne à ligne**, et l'utilisateur décide de chaque destruction.

## 0. Terrain et état, avant tout
```
run_command("terraform version 2>&1 | head -2 || tofu version 2>&1 | head -2")
run_command("cd /chemin && terraform workspace show 2>&1; terraform providers 2>&1 | head -20")
```
- Binaire absent : dis-le et arrête-toi.
- **Nomme le workspace et le backend à l'utilisateur, et fais-les confirmer.** Un plan juste appliqué au mauvais environnement est l'incident classique.
- `terraform init` et `plan` sortent sur le réseau et dépassent souvent 120 s : lance-les en fond avec un log (§2).
- Le fichier d'état contient des secrets en clair. Ne le lis jamais entièrement dans le fil, ne le recopie jamais, ne le commite jamais.

## 1. Lis le code avant de proposer
- `find_files` pour `*.tf`, `*.tfvars`, `backend.tf`, puis `read_file`. Commence par les `variable` et `output` : ils décrivent le contrat du module mieux que les ressources.
- Repère : le backend (local ou distant, verrouillé ou non), les versions épinglées des providers, les modules distants et leur source.
- Provider non épinglé (`version = "~> 5.0"` absent) : c'est ton premier constat. Un `init` demain ne produira pas le même plan qu'aujourd'hui.

## 2. Produire le plan sans se faire couper
```
run_command("cd /chemin && nohup sh -c 'terraform init -input=false && terraform plan -input=false -lock-timeout=60s -out=/tmp/tf.plan' > /tmp/tfplan-$(date +%s).log 2>&1 & echo LOG=/tmp/tfplan-...log")
```
Puis, dans un appel SÉPARÉ :
```
run_command("tail -n 60 /tmp/tfplan-….log; pgrep -f 'terraform plan' >/dev/null || echo TERMINE")
```
`-input=false` est indispensable : sans lui, une variable manquante fait attendre une saisie qui n'arrivera jamais, et la commande meurt à 120 s sans message utile.
Sortie > 20 000 caractères : elle part dans un fichier scratch ; relis-la par tranches avec `read_file(chemin, offset)`, en commençant par la fin (le récapitulatif y est).

## 3. Lire le plan ; ce qu'il faut extraire
Le récapitulatif seul ne suffit pas. Décompose :
```
run_command("cd /chemin && terraform show -json /tmp/tf.plan | python3 -c \"
import sys,json
d=json.load(sys.stdin)
for r in d.get('resource_changes',[]):
    a=r['change']['actions']
    if a!=['no-op']:
        print('/'.join(a), r['address'])
\" | sort | uniq -c | sort -rn")
```
Rends un tableau : action, adresse de la ressource, et pour chaque destruction la raison visible dans le plan.
Les quatre signaux à remonter en priorité :
- **`destroy` ou `replace` (`-/+`)** sur une base de données, un volume, un bucket, un enregistrement DNS. Chacun se justifie ou s'annule ; jamais de destruction acceptée en lot.
- **Remplacement forcé** : le plan indique quel attribut le force. Un changement de nom ou de zone recrée souvent la ressource entière.
- **Ressources créées hors du périmètre annoncé** : signe d'un module ou d'une source de données qui capte plus large que prévu.
- **`(known after apply)` sur une valeur critique** : tu ne sauras qu'après. Dis-le, ne le masque pas.

## 4. Qualité du code ; ce qui se vérifie mécaniquement
```
run_command("cd /chemin && terraform fmt -check -recursive; terraform validate")
```
Puis relis à la main :
1. Aucun secret en dur dans un `.tf` ni un `.tfvars` commité. Contrôle : `run_command("grep -rniE 'password|secret|access_key|private_key' --include='*.tf' --include='*.tfvars' /chemin | head -20")`. Toute occurrence est bloquante.
2. `sensitive = true` sur chaque variable et sortie qui porte un secret, sinon la valeur apparaît dans le plan et dans les logs de CI.
3. Backend distant avec verrouillage. Un état local sur un projet à plusieurs personnes garantit une corruption.
4. Versions épinglées : Terraform lui-même ET chaque provider.
5. `count`/`for_each` : `for_each` sur une map, pas `count` sur une liste. Retirer un élément au milieu d'une liste avec `count` décale et recrée tout ce qui suit.
6. `prevent_destroy = true` dans un bloc `lifecycle` sur les ressources porteuses de données.

## 5. Apply, import, retour arrière
- **Apply** : uniquement sur le fichier de plan déjà relu (`terraform apply /tmp/tf.plan`), jamais un `apply` qui recalcule son propre plan, et jamais `-auto-approve`. Montre le récapitulatif, obtiens l'accord, exécute en fond avec un log, puis prouve le résultat.
- **Ressource existante à reprendre** : `terraform import ADRESSE ID`, puis `terraform plan` qui doit ressortir vide. Un plan non vide après import signifie que ton code ne décrit pas la ressource réelle : corrige le code, jamais la ressource.
- **Retour arrière** : Terraform n'en a pas. Le seul retour est un nouveau plan qui remet l'état précédent, ou une restauration de sauvegarde de l'état. Dis-le avant, pas après.
- **État corrompu ou dérivé** : `terraform state list` et `terraform state show ADRESSE` en lecture. `state rm` et `state mv` sont des actions destructrices : sauvegarde de l'état d'abord, accord explicite ensuite.

## Garde-fous
- Ne lance JAMAIS `terraform destroy`, ni `apply -auto-approve`, ni une commande `state rm` de ta propre initiative.
- Ne commite jamais `terraform.tfstate`, `*.tfstate.backup`, `.terraform/` ni un `.tfvars` contenant des valeurs réelles.
- Ne recopie jamais une valeur sortie de `terraform output` marquée sensible.
- Un plan qui détruit une ressource que l'utilisateur n'a pas mentionnée : arrête-toi, expose-la, ne cherche pas à l'expliquer par toi-même.
- Deux environnements ou plus à comparer : `spawn_agent` un coéquipier par environnement, brief autonome (chemin, workspace, commandes exactes, format du tableau d'actions), puis `ask_agent`.
- Restitution finale : workspace et backend utilisés, le tableau des actions du plan, la liste explicite des destructions et remplacements, ce qui a été appliqué ou non, et la stratégie de retour arrière.
