---
name: incident-production
description: "Incident de production : réduire l'impact, chronologie, post-mortem sans blâme."
---

Deux temps, à ne jamais mélanger. **Pendant** : rétablir le service et consigner les faits. **Après** : comprendre. Chercher la cause profonde pendant que le service est à terre coûte des minutes d'indisponibilité.

## Phase A ; les cinq premières minutes
1. **Horodate.** `run_command("date -u '+%Y-%m-%dT%H:%M:%SZ'")`. Chaque fait que tu écriras portera une heure UTC. Sans horodatage, la chronologie sera fausse dès demain.
2. **Ouvre un fichier de main courante** avec `write_file`, par exemple `~/Documents/Galactus/incident-AAAAMMJJ-HHMM.md`, et écris-y chaque constat au fil de l'eau. Ton contexte fait 8192 tokens et sera résumé ; ce fichier, non.
3. **Établis l'impact en trois lignes, avec des faits** : quel service, quelle proportion des requêtes, depuis quand. Une hypothèse n'est pas un impact.
4. **Qu'est-ce qui a changé** dans les deux dernières heures : déploiement, migration, changement de configuration, rotation de secret, pic de trafic, expiration de certificat. C'est la réponse dans la grande majorité des cas.

## Phase B ; constater, sans deviner
Un seul aller-retour par machine, filtre côté serveur, toujours.
```
ssh -o BatchMode=yes -o ConnectTimeout=8 ALIAS 'echo "== load"; uptime; echo "== disk"; df -h /; echo "== failed"; systemctl --failed --no-pager; echo "== erreurs 15min"; journalctl -u SERVICE --since "15 min ago" --no-pager | grep -c -i error'
```
```
run_command("curl -sS -m 10 -o /dev/null -w 'code=%{http_code} total=%{time_total}s\\n' https://SERVICE/health")
```
- Jamais de `tail -f` ni de `journalctl -f` : ils ne rendent pas la main et seront coupés à 120 s.
- Compte avant de lire. `grep -c ERROR`, puis `grep ERROR | tail -30`. Rapporte les motifs groupés avec leur nombre, pas 200 lignes brutes.
- Vérifie les quatre saturations classiques dans cet ordre : disque plein, mémoire, descripteurs de fichiers, connexions à la base.
- Sortie > 20 000 caractères : fichier scratch, relu par tranches avec `read_file(chemin, offset)`.

## Phase C ; réduire l'impact
- **Le retour arrière passe avant la compréhension.** Un déploiement récent est suspect : proposer le retour arrière est la bonne action même sans avoir compris.
- Montre la commande exacte, dis ce qu'elle change, attends l'accord. Une action = un appel. Jamais deux redémarrages chaînés.
- Après CHAQUE action : une preuve. `systemctl status`, un code HTTP, un compte d'erreurs sur les 5 dernières minutes. Sans preuve, l'action n'est pas terminée.
- Écris dans la main courante : heure, action, qui a validé, effet observé.
- Une action qui n'améliore rien s'annule avant d'en tenter une autre. Trois actions superposées rendent l'incident inanalysable.

## Phase D ; le post-mortem, sans blâme
Le principe tient en une phrase : **ce sont les systèmes qui échouent, pas les personnes**. Écris « l'alerte ne s'est pas déclenchée », jamais « X a oublié de ». Un post-mortem qui nomme un coupable ne produit aucune amélioration, il produit du silence au prochain incident.

Structure du document, écrit avec `write_file` :
1. **Titre, gravité, dates de détection et de résolution, durée d'impact.**
2. **Impact chiffré** : services touchés, proportion d'utilisateurs, requêtes en échec, perte de données oui ou non, engagement de service dépassé ou non. Un chiffre sans source est à remplacer par « non mesuré ».
3. **Chronologie** en UTC, une ligne par événement : heure, ce qui s'est passé, qui l'a observé, la trace (log, alerte, message). Marque explicitement les trous : « entre 14:32 et 14:47, aucune trace ».
4. **Cause racine par les cinq pourquoi.** Enchaîne jusqu'à sortir de la technique et atteindre le processus. Arrêter au premier « pourquoi » donne « le pod a manqué de mémoire » ; continuer donne « nos tests de charge ne couvrent pas les comptes à forte cardinalité ».
5. **Facteurs aggravants** : ce qui a rendu l'incident plus long que nécessaire. Alerte muette ou trop tardive, procédure absente ou périmée, absence de bascule, contexte perdu à la relève.
6. **Ce qui a bien marché.** Deux lignes. C'est ce qu'il faut protéger.
7. **Actions**, chacune avec un responsable nommé et une échéance. Une action sans responsable n'est pas une action, c'est un voeu. Trois à cinq maximum : dix actions signifient zéro action.

## Vérification avant de diffuser
- Chaque heure de la chronologie est-elle rattachée à une trace que tu as réellement vue ? Sinon, marque-la « reconstitué ».
- Le document contient-il un nom de personne associé à une erreur ? Réécris.
- Contient-il un secret, une adresse IP interne, un identifiant client, une trace d'exécution ? Retire.
- Chaque chiffre a-t-il sa source ? Un chiffre sans source devient une légende.

## Garde-fous
- N'exécute aucune action correctrice sur un système de production sans accord explicite, même en mode autonome. Reste en assisté.
- Un serveur qui ne répond pas n'est pas un serveur à redémarrer : rapporte, propose, laisse décider.
- N'écris jamais une cause racine que tu n'as pas prouvée. « Cause probable, non confirmée » est une conclusion acceptable ; une certitude inventée ne l'est pas.
- Ne colle jamais un secret dans une commande ni dans le document.
- Trois machines ou plus à inspecter avec le même diagnostic : `spawn_agent` un coéquipier par machine, brief autonome (alias, commandes exactes, format du tableau), puis `ask_agent` ; fusionne toi-même. Deux rapports contradictoires : signale-le dans la chronologie, ne tranche pas.
- Restitution finale : impact, chronologie, cause racine ou son absence explicite, actions avec responsables, chemin du document écrit, et ce qui reste non expliqué.
