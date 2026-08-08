---
title: Infrastructure as code
tags: [métier, iac, terraform]
description: Écrire et relire du Terraform ou de l'Ansible, avec le plan comme unique source de vérité.
---

# Infrastructure as code

> [!warning] La règle unique
> Le `plan` fait foi, jamais le modèle. Aucune conclusion sur ce qui va changer
> tant que la sortie de `terraform plan` ou de `ansible --check` n'est pas dans
> le fil. Et jamais d'`apply` déclenché par l'assistant.

## Workflow : relire un plan

Le plan est long : passe-le par un fichier.

```
J'ai écrit le plan dans /tmp/plan.txt. Ne le lis pas en entier.
run_command("grep -E '^  # |will be (created|destroyed|updated|replaced)' /tmp/plan.txt | head -60")
Rends un tableau : ressource, action, risque. Mets en tête tout ce qui est
détruit ou remplacé, avec ce que cela coupe.
```

**Vérification** : le nombre de lignes du tableau doit correspondre au résumé
`Plan: X to add, Y to change, Z to destroy`. Fais-le comparer explicitement.

## Workflow : écrire un module

```
Lis modules/network/ pour les conventions du dépôt (nommage, variables, tags),
puis écris modules/cache/ : une instance Redis, variables pour la taille et la
rétention, sorties pour l'endpoint et le port, tags identiques aux autres
modules. Puis lance terraform fmt et terraform validate, montre les sorties.
```

`fmt` et `validate` sont gratuits et attrapent la moitié des erreurs.

## Workflow : rôle Ansible

```
Écris un rôle qui installe et configure nginx : idempotent, handlers pour le
reload, template avec variables, aucune commande shell sauf si aucun module ne
convient. Puis donne la commande de test en --check --diff sur l'inventaire de
staging uniquement.
```

Le test d'idempotence est simple et décisif : deux exécutions consécutives, la
seconde doit annoncer zéro changement. Fais-le montrer.

## Pièges de ce métier

- **État distant** : le modèle ne le voit pas. Il raisonne sur le code, pas sur
  la réalité de l'infrastructure. Un plan est le seul pont entre les deux.
- **Ressource inventée** : un argument de provider qui n'existe pas dans ta
  version. `validate` le dit, pas le modèle.
- **Secret dans le code** : relire chaque diff, voir [[Sécurité applicative]].
- **Destruction masquée** : un changement d'attribut immuable provoque un
  `replace`. C'est le mot à chercher dans le plan.

## Faiblesse honnête

Pas d'accès à ton état distant, à ton fournisseur cloud, à ton coût réel. Sur
la partie « est-ce que ça correspond à ce qui tourne », l'application ne peut
rien affirmer, et une note qui prétendrait le contraire te ferait détruire une
base de données.

## Voir aussi

[[Conteneurs et orchestration]] · [[Systèmes et DevOps]] ·
[[CI-CD et livraison]] · [[Réseau et infrastructure]] ·
[[Sécurité applicative]] · [[Vérifier avant de croire]]
