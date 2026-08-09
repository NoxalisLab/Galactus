---
name: analyse-de-logs
description: "Fichier de logs : compter et grouper les erreurs, situer un pic, extraire une trace."
---

Un log fait des centaines de mégaoctets ; ta fenêtre fait 8192 tokens. **On ne lit jamais un log, on l'agrège.** Toute conclusion s'appuie sur un compte, pas sur un échantillon.

## 0. Dimensionne avant d'ouvrir
```
run_command("ls -lh FICHIER; wc -l FICHIER; head -3 FICHIER; tail -3 FICHIER")
```
Cette commande donne quatre choses en un appel : la taille, le nombre de lignes, le format d'une ligne, et la fenêtre temporelle couverte. Sans elle, tu travailles à l'aveugle.
- Jamais de `cat` sur un log. Jamais de `read_file` sur un fichier de plus de quelques mégaoctets sans `offset`.
- Jamais de `tail -f` ni de `journalctl -f` : ils ne rendent pas la main et seront coupés à 120 s.
- Log distant : filtre **côté serveur**, toujours. Rapatrier 400 Mo pour en lire 20 lignes fait déborder ta fenêtre et prend une minute.
```
ssh -o BatchMode=yes -o ConnectTimeout=8 ALIAS 'journalctl -u SERVICE --since "2 hours ago" --no-pager | grep -c -i error'
```
- Log compressé : `zgrep` et `zcat | head`, ne le décompresse pas sur disque.

## 1. Compte, groupe, hiérarchise
Trois commandes, dans cet ordre, avant toute lecture de ligne.
```
run_command("grep -c -iE 'error|fatal|exception|panic' FICHIER; grep -c -i 'warn' FICHIER; wc -l < FICHIER")
```
```
run_command("grep -iE 'error|exception' FICHIER | sed -E 's/[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9:.,]+//; s/[0-9a-f]{8,}/ID/g; s/[0-9]+/N/g' | sort | uniq -c | sort -rn | head -20")
```
Cette normalisation (on efface l'horodatage, les identifiants et les nombres) transforme dix mille lignes uniques en une dizaine de motifs distincts. **C'est le geste central de la skill** : sans lui, tout log paraît chaotique.
Restitue un tableau : motif d'erreur, nombre d'occurrences, part du total. Les trois premiers motifs représentent presque toujours plus de 80 % du volume.

## 2. Situe dans le temps
Un compte total ne dit pas si le problème est permanent ou s'il a commencé à 14h32.
```
run_command("grep -iE 'error' FICHIER | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}' | uniq -c | tail -60")
```
Le résultat est un histogramme par minute. Cherche : le premier instant non nul (début), la pente (progressive ou brutale), et un motif périodique (une tâche planifiée). Un démarrage brutal désigne un déploiement ou un changement de configuration ; une montée progressive désigne une fuite ou une saturation.
Adapte l'expression d'extraction au format réel observé à l'étape 0. Ne suppose jamais le format de l'horodatage.

## 3. Extraire une trace complète
Une exception s'étale sur 30 lignes ; `grep` seul n'en rend qu'une.
```
run_command("grep -n -m3 -A 30 'MOTIF_EXCEPTION' FICHIER")
```
Pour suivre une requête de bout en bout, prends l'identifiant de corrélation et remonte tout ce qui le porte :
```
run_command("grep -F 'req_id=01J8ABC' FICHIER | head -60")
```
Aucun identifiant de corrélation dans les logs : c'est un constat à remonter à l'utilisateur, c'est ce qui rend le diagnostic coûteux.

## 4. Corréler plusieurs sources
- Aligne d'abord les fuseaux horaires. Un log en UTC et un log en heure locale décalés de deux heures produisent une fausse causalité. Vérifie sur une ligne de chaque et annonce le décalage.
- Ne travaille que sur la fenêtre de l'incident, jamais sur les fichiers entiers :
```
run_command("awk '$0>=\"2026-08-08T14:30\" && $0<=\"2026-08-08T15:00\"' FICHIER > /tmp/fenetre-app.log; wc -l /tmp/fenetre-app.log")
```
- Puis compare les histogrammes par minute des deux sources. Le service qui casse en premier est presque toujours la cause, pas la victime.
- Deux fichiers volumineux ou plus, indépendants : `spawn_agent` un coéquipier par fichier, chaque brief donnant le chemin exact, la fenêtre temporelle, la normalisation à appliquer et le format du tableau attendu ; puis `ask_agent` et corrèle les tableaux toi-même.

## 5. Extraction structurée
Log au format JSON par ligne : n'écris pas de regex, utilise `python3` en streaming (la stdlib suffit, ne charge jamais le fichier en mémoire).
```python
# /tmp/logstat.py
import json, sys, collections
c = collections.Counter()
for line in open(sys.argv[1], errors="replace"):
    try:
        d = json.loads(line)
    except ValueError:
        c["_non_json"] += 1
        continue
    if d.get("level") in ("error", "fatal"):
        c[d.get("msg", "?")[:80]] += 1
for msg, n in c.most_common(20):
    print(n, msg)
```
Le compteur `_non_json` n'est pas décoratif : des lignes non parsées silencieusement faussent tous les totaux.

## Garde-fous
- N'affirme jamais une cause à partir d'un échantillon de lignes. Un motif se démontre par un compte et une fenêtre temporelle.
- Ne conclus pas depuis les seules erreurs : vérifie aussi le volume total. Cent erreurs sur un million de requêtes et cent sur mille ne sont pas le même incident.
- Corrélation n'est pas causalité : deux pics simultanés se signalent comme simultanés, pas comme liés.
- Les logs contiennent souvent des adresses IP, des e-mails, des jetons et des identifiants clients. Ne les recopie pas dans ta réponse ; masque-les, cite par position. Extraction destinée à être conservée : bascule sur la skill `donnees-sensibles`.
- Ne modifie ni ne tronque jamais un fichier de log source ; écris tes extraits ailleurs.
- Restitution finale : la fenêtre couverte, le volume total, le tableau des motifs avec leur nombre, le premier instant d'apparition, la corrélation avec un changement s'il y en a un, et ce que les logs ne permettent PAS de savoir.
