---
name: debogage-methodique
description: "Un test échoue, ça plante, comportement inattendu : trouver la cause racine."
---

Règle unique : **aucune correction avant d'avoir identifié la cause racine**. Corriger un symptôme, c'est déplacer le bug.

## Phase 1 ; reproduire, avant tout le reste
- Lis le message d'erreur EN ENTIER, pas la première ligne. La trace contient le fichier, la ligne et souvent la réponse.
- Trouve la commande qui déclenche l'échec de façon fiable, et note-la. Sans reproduction, tu devines.
```
run_command("COMMANDE_DE_TEST 2>&1 | tail -40")
```
- Sortie > 20 000 caractères : elle part dans un fichier scratch. Relis-la avec `read_file(chemin, offset)`, en commençant par la FIN, où sont les erreurs.
- Intermittent ? Boucle bornée pour mesurer le taux, jamais une boucle infinie (120 s de plafond) :
```
run_command("for i in $(seq 1 20); do COMMANDE >/dev/null 2>&1 || echo KO; done | wc -l")
```
- Non reproductible après cette mesure : dis-le et collecte plus de données. N'invente pas de correctif.

## Phase 2 ; qu'est-ce qui a changé
- `run_command("git log --oneline -15")` et `run_command("git diff HEAD~1 --stat")`.
- Le bug est récent et le dépôt est propre ? `git bisect` est le moyen le plus court :
```
run_command("git bisect start && git bisect bad && git bisect good SHA_CONNU_BON")
```
puis, à chaque étape, lance le test et `git bisect good` ou `git bisect bad`. Termine TOUJOURS par `git bisect reset`.
- Rien n'a changé dans le code : regarde les dépendances, la configuration, les données d'entrée, l'horloge, l'environnement.

## Phase 3 ; instrumenter les frontières
Quand le système a plusieurs couches (appelant, service, base, réseau), ne devine pas laquelle casse : mesure. Ajoute une trace à chaque frontière, lance UNE fois, lis, puis retire les traces.
```
run_command("python3 - <<'EOF'
import sys
print('entree:', repr(sys.argv), file=sys.stderr)
EOF")
```
Objectif de cette phase : nommer la couche qui reçoit une valeur correcte et en émet une fausse. Tant que tu ne peux pas la nommer, tu n'es pas en phase 4.

## Phase 4 ; une hypothèse, un test
1. Écris l'hypothèse en une phrase : « la cause est X, parce que Y ». Vague = inutilisable.
2. Fais le plus petit changement qui la teste. Une variable à la fois.
3. Relance la commande de reproduction. Confirmée : passe en phase 5. Infirmée : reviens à la phase 1 avec l'information nouvelle, ne superpose pas un second correctif.
4. Compte tes tentatives. **Trois hypothèses infirmées = le problème est architectural** : arrête, expose ce que tu as éliminé, et demande à l'utilisateur de trancher. N'en tente pas une quatrième.

## Phase 5 ; corriger et prouver
- Écris d'abord un test qui échoue pour la bonne raison, puis corrige, puis relance : rouge, puis vert.
- Preuve du rouge : lance le test AVANT le correctif et montre l'échec. Un test écrit après le correctif ne prouve rien.
- Corrige à la source, pas au point d'observation. Une valeur fausse se corrige là où elle naît.
- Un seul changement. Pas de refactor opportuniste dans le même patch.
- Relance la suite (ou le sous-ensemble touché, si elle dépasse 120 s) et montre la sortie brute.

## Signaux d'alarme ; si tu te surprends à les penser, reviens en phase 1
- « Je vais juste essayer de changer ça pour voir. »
- « C'est probablement X. »
- « Je corrige d'abord, j'enquêterai après. »
- « Je ne comprends pas tout, mais ça devrait marcher. »
- Tu proposes une correction et tu n'as encore lancé aucune commande.

## Garde-fous
- N'affaiblis jamais un test pour faire disparaître un échec. Un test qui gêne est un test qui a raison, jusqu'à preuve du contraire.
- Ne modifie jamais plus d'un fichier tant que la cause n'est pas nommée.
- Trois pistes de diagnostic indépendantes : `spawn_agent` un coéquipier par piste, chaque brief donnant la commande de reproduction exacte et le périmètre à ne pas dépasser, puis `ask_agent`. Un coéquipier ne voit pas ton fil.
- Restitution finale : le symptôme, la cause racine avec `chemin:ligne`, la preuve (sortie de commande avant et après), le correctif, et ce que tu n'as pas pu écarter.
