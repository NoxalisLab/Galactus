---
name: expressions-regulieres
description: "Écrire, lire ou corriger une expression régulière."
---

Une regex ne se relit pas, elle se teste. Règle absolue : **aucune regex livrée sans avoir été exécutée sur un jeu de cas qui doivent passer et un jeu de cas qui doivent échouer**.

## 0. Le dialecte change tout ; nomme-le d'abord
| Contexte | Dialecte | Pièges |
|---|---|---|
| `python3 -c` avec `re` | PCRE-like | `\d` inclut les chiffres unicode sauf `re.ASCII` |
| `grep` | BRE | `+`, `?`, `|`, `()` doivent être échappés |
| `grep -E`, `egrep` | ERE | pas de `\d`, utilise `[0-9]` ou `[[:digit:]]` |
| `grep -P` | PCRE | **absent du grep de macOS** ; ne l'utilise pas |
| `sed` sur macOS | BRE BSD | `-i` exige un suffixe : `sed -i ''` |
| JavaScript | ECMAScript | pas de lookbehind sur les vieux moteurs |
| `rg` | Rust regex | pas de lookaround du tout |

Sur ce Mac, `grep` et `sed` sont les versions BSD, pas GNU. `grep -P` échoue. Quand une regex devient non triviale, préfère `python3` : le dialecte est prévisible et testable.

## 1. Construis par étapes, pas d'un bloc
Écris la regex en morceaux et valide chacun sur un échantillon réel avant d'assembler.
```
run_command("head -5 FICHIER")
```
Regarde ce que tu vises AVANT d'écrire le motif. Une regex écrite sur un format imaginé ne matche rien.

## 2. Le banc d'essai ; toujours le même
Écris un fichier de test avec `write_file`, puis lance-le. Un heredoc de 40 lignes est illisible dans le fil et impossible à rejouer.
```python
# /tmp/regex_test.py
import re
MOTIF = r"^(\d{4})-(\d{2})-(\d{2})$"
DOIT_PASSER = ["2026-08-08", "1999-01-31"]
DOIT_ECHOUER = ["2026-8-8", "08-08-2026", "2026-08-08 ", "abcd-ef-gh"]
rx = re.compile(MOTIF)
for s in DOIT_PASSER:
    print("OK " if rx.match(s) else "RATE ", repr(s))
for s in DOIT_ECHOUER:
    print("RATE " if rx.match(s) else "OK   ", repr(s))
```
```
run_command("python3 /tmp/regex_test.py")
```
Un seul `RATE` et la regex n'est pas livrable. La liste `DOIT_ECHOUER` est la partie qui compte : c'est elle qui attrape les regex trop permissives, et c'est celle qu'on oublie.

## 3. Les erreurs qui coûtent, et leur signe
| Signe observé | Cause | Correction |
|---|---|---|
| Le match avale toute la ligne | quantificateur gourmand `.*` | version paresseuse `.*?`, ou classe négative `[^"]*` |
| Ça matche au milieu d'une chaîne invalide | pas d'ancrage | `^` et `$`, ou `re.fullmatch` |
| `$` accepte un retour à la ligne final | comportement de `$` en Python | `\Z` si tu veux la vraie fin |
| Rien ne matche alors que le motif semble bon | échappement mangé par le shell | guillemets simples autour du motif, et `r"…"` en Python |
| Ça marche en Python, pas en grep | `\d`, `\w`, `+` non supportés en BRE | `grep -E` et classes POSIX |
| La commande ne rend jamais la main | explosion combinatoire (`(a+)+b`) | supprime l'imbrication de quantificateurs |
| Ça matche 3 fois au lieu d'une | pas de frontière de mot | `\b` |
| Les accents ne passent pas | classe `[a-z]` sur du texte français | `[^\W\d_]` avec unicode, ou liste explicite |

## 4. Extraire depuis un fichier
- Compte AVANT de lire : `run_command("grep -cE 'MOTIF' FICHIER")`. Un compte à zéro ou à un million change entièrement la suite.
- Puis échantillonne : `run_command("grep -oE 'MOTIF' FICHIER | sort | uniq -c | sort -rn | head -20")`. Le comptage par valeur distincte révèle immédiatement les faux positifs.
- Groupes de capture, extraction structurée : `python3` en streaming, jamais tout le fichier en mémoire.
- Dans un espace de travail ouvert, `search_workspace` cherche une chaîne littérale sans passer par le shell : préfère-le quand tu n'as pas besoin de motif.

## 5. Remplacer en masse ; jamais en une passe
1. Montre ce qui va changer, en lecture seule :
```
run_command("grep -rnE 'MOTIF' CHEMIN | head -40; grep -rcE 'MOTIF' CHEMIN | grep -v ':0$'")
```
2. Fais valider la liste des fichiers et le nombre d'occurrences.
3. Sauvegarde : `run_command("cp -a CHEMIN CHEMIN.bak.$(date +%Y%m%d%H%M%S)")`, ou vérifie que l'arbre git est propre (`git status`) pour avoir un retour arrière.
4. Applique avec un script `python3` (plus lisible et plus portable que `sed -i ''` sur macOS), en affichant le nombre de substitutions par fichier.
5. Recompte : `grep -rcE 'MOTIF' CHEMIN` doit tomber à zéro, et `git diff --stat` doit montrer exactement les fichiers annoncés.

## Garde-fous
- Ne parse pas du HTML, du JSON, du CSV ni du XML à la regex. Utilise `json`, `csv`, `html.parser` de la stdlib. Une regex sur un format imbriqué finit toujours par se tromper sur un cas réel.
- Une regex de validation d'adresse e-mail « complète » est un piège : valide `.+@.+\..+` et laisse l'envoi confirmer le reste.
- Aucune regex ne part dans du code sans son banc d'essai. Livre le fichier de test à côté.
- Motif de plus de 80 caractères : découpe-le en plusieurs passes ou en `re.VERBOSE` commenté. Une regex illisible est une régression garantie.
- Restitution finale : le motif, le dialecte visé, la sortie brute du banc d'essai (cas positifs et négatifs), et les cas connus qu'il ne couvre pas.
