---
name: notes-de-reunion
description: "Transcription ou notes vers un compte rendu : décisions, actions, points ouverts."
---

Le livrable n'est pas un résumé, c'est une **liste de décisions et d'actions**. Ce qui n'est ni une décision, ni une action, ni un point ouvert n'a presque jamais sa place dans un compte rendu.

## 0. Métadonnées d'abord ; trois questions maximum
Établis avant de lire : titre et date de la réunion, participants, et le destinataire du compte rendu (les participants seuls, ou une direction qui n'était pas là ?). Le destinataire change tout le reste.
Manquant : pose au plus trois questions, puis avance en marquant `TBD` ce qui reste inconnu. Ne bloque pas sur des métadonnées.
La date du jour, si elle sert : `run_command("date '+%Y-%m-%d'")`.

## 1. Ouvre la source avec le bon outil
- Transcription ou notes en texte : `read_file`.
- PDF, Word, image d'un tableau blanc : `read_document`.
- Chemin incertain : `list_directory`. Ne devine jamais un chemin.
- **L'application ne transcrit pas un fichier audio.** Un `.m4a` ou un `.mp3` ne peut pas être lu ici : demande la transcription à l'utilisateur, ne prétends pas l'avoir écoutée.

## 2. Source longue ; la lecture par tranches
Une transcription d'une heure fait entre 8 000 et 12 000 mots et ne tient pas dans ta fenêtre de 8192 tokens.
1. Sortie > 20 000 caractères : elle part dans un fichier scratch, le chemin apparaît dans le fil.
2. Relis-le par tranches : `read_file(chemin_scratch, offset)`.
3. **Après CHAQUE tranche, écris 4 à 6 lignes de notes** : sujets abordés, décisions entendues, actions entendues, citations candidates avec leur position. Ces notes survivent au résumé automatique du fil, pas le texte brut.
4. Les notes de tranche s'accumulent dans un fichier (`write_file` vers `/tmp/notes-tranches.md`), pas dans le fil. Tu rédigeras à partir de ce fichier.
5. Ne conclus qu'après la dernière tranche. À défaut, liste explicitement les parties non lues.
Transcription très longue, ou plusieurs réunions à comparer : `spawn_agent` un coéquipier par bloc ou par réunion (2 à 6 max), chaque brief donnant le chemin exact, la plage à couvrir et exactement la même grille (décision, action, responsable, échéance, citation, position) ; puis `ask_agent` et assemble toi-même.

## 3. Trier ; les quatre catégories, et rien d'autre
| Catégorie | Test de reconnaissance | Ce qu'il faut capturer |
|---|---|---|
| **Décision** | quelque chose est désormais tranché | ce qui est décidé, par qui, la raison en une phrase |
| **Action** | quelqu'un doit faire quelque chose | quoi, QUI, pour QUAND |
| **Point ouvert** | posé, non tranché | la question, ce qui bloque, qui doit trancher |
| **Information** | contexte utile aux absents | une ligne, pas plus |
Le reste (digressions, redites, échanges de politesse, débats sans issue) ne va pas dans le compte rendu.

**Une action sans responsable nommé n'est pas une action.** Si la transcription ne dit pas qui, écris `responsable : à confirmer` et remonte-le en fin de document. Ne l'attribue jamais à quelqu'un par déduction. Même règle pour l'échéance : `échéance : non fixée`, jamais une date inventée.

## 4. Le format de sortie
```markdown
# Comité produit ; 2026-08-08

Participants : A. Martin, B. Diop, C. Rossi. Absents : D. Leroy.
Rédigé par : Galactus, depuis la transcription /chemin/transcription.txt

## Décisions
1. Le lancement est reporté au 15 septembre. Motif : le module de facturation n'est pas testé. (A. Martin)

## Actions
| # | Action | Responsable | Échéance |
|---|---|---|---|
| 1 | Chiffrer le reste à faire sur la facturation | B. Diop | 2026-08-12 |
| 2 | Prévenir les trois clients pilotes | C. Rossi | à confirmer |

## Points ouverts
- Faut-il une version intermédiaire sans facturation ? Décideur : A. Martin.

## À confirmer
- Action 2 : échéance non fixée pendant la réunion.
```
Compte rendu destiné à des absents : ajoute en tête trois lignes de contexte. Destiné aux participants : n'en mets pas, ils y étaient.

## 5. Contrôle avant de livrer ; quatre passes
1. **Chaque décision et chaque action est-elle rattachée à un passage réel de la source ?** Rouvre deux entrées au hasard avec `read_file(chemin, offset)` et vérifie. Une action inventée détruit la confiance dans tout le document.
2. Un nom propre, un chiffre, une date, un montant : recopiés caractère par caractère depuis la source, jamais reconstruits.
3. Aucun jugement de ta part sur les personnes ou la qualité des arguments. Tu consignes, tu n'arbitres pas.
4. Les contradictions entendues pendant la réunion se signalent (« deux positions exprimées, non tranchées »), elles ne se résolvent pas.

## Livraison
- Affiche le compte rendu dans ta réponse, prêt à copier.
- Fichier demandé : `write_file` avec un nom daté, par exemple `2026-08-08-cr-comite-produit.md`, puis confirme le chemin. `write_file` est une proposition que l'utilisateur accepte.
- Coffre Obsidian configuré : `obsidian_append` pour ajouter à une note existante (plus sûr), `obsidian_update` seulement après avoir lu la note entière, car il la remplace intégralement.
- Galactus n'envoie rien : ne promets jamais la diffusion du compte rendu, l'utilisateur le copie lui-même.

## Garde-fous
- N'ajoute jamais une décision, une action, un chiffre ou une échéance qui n'a pas été dit. Le manque se marque `à confirmer`, il ne se comble pas.
- Ne reformule pas une décision au point d'en changer la portée. En cas de doute, cite la phrase exacte entre guillemets.
- Réunion sensible (RH, litige, restructuration) : rédige, mais recommande explicitement une relecture humaine avant diffusion, et ne recopie aucune donnée personnelle superflue. Données personnelles au coeur du sujet : bascule sur la skill `donnees-sensibles`.
- Restitution finale : le nombre de décisions et d'actions, les points marqués `à confirmer`, le chemin du fichier écrit, et les parties de la source que tu n'as pas lues.
