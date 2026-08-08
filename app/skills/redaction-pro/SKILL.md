---
name: redaction-pro
description: "À utiliser pour rédiger ou retravailler un texte professionnel en français : email, note interne, compte rendu, proposition commerciale ou documentation."
---

## 1. Cadre avant d'écrire
Identifie : **destinataire** (qui, quel lien, connaît-il le dossier ?), **objectif** (informer, convaincre, obtenir une décision), **ton** (formel, cordial, direct), **format** et longueur attendus. S'il manque un élément clé, pose 1 à 3 questions courtes AVANT de rédiger.
Matière source ? Lis-la d'abord : `read_file` pour le texte brut, `read_document` pour PDF/Word/images. Source longue : lis par sections (`read_file` avec `offset`), ne charge que l'utile. Plusieurs documents longs à synthétiser (ex. compte rendu à partir de 3 PDF) : délègue : `spawn_agent` un lecteur par document (brief autonome : chemin exact, faits à extraire, citations exigées), puis `ask_agent` ; rédige à partir des rapports.
N'invente JAMAIS un fait, chiffre, nom ou date : demande, ou insère `[À COMPLÉTER : …]` et signale-le à la fin.

## 2. Structure selon le format
- **Email** : objet explicite (< 60 caractères), 1 idée par paragraphe, appel à l'action clair, formule de politesse adaptée.
- **Note interne** : titre, contexte en 2-3 lignes, points clés en liste, décision attendue / prochaines étapes.
- **Compte rendu** : en-tête (date, participants, objet), décisions prises, actions (qui / quoi / pour quand), points ouverts.
- **Proposition commerciale** : contexte client, besoin reformulé, solution, périmètre et livrables, conditions, prochaines étapes.
- **Documentation** : objectif, prérequis, étapes numérotées, exemples concrets.

## 3. Rédige
- Typographie française : espace insécable avant : ; ? !, guillemets « », nombres avec espace (10 000), M. / Mme.
- Pas d'anglicisme inutile : deadline → échéance, feedback → retour, meeting → réunion. Garde les termes techniques établis du milieu.
- Phrases courtes, voix active, un message par paragraphe. Vouvoiement par défaut en contexte pro, sauf demande contraire.
- Ton constant ; pas de superlatifs creux ni de jargon décoratif.

## 4. Relecture systématique (obligatoire)
Vérifie point par point :
1. Orthographe, grammaire, accords.
2. Concision : coupe 10 à 20 % (adverbes, redondances, périphrases).
3. Cohérence : dates, noms, montants conformes aux sources lues.
4. L'objectif apparaît dès le premier paragraphe ; l'action attendue est explicite.
5. Aucun `[À COMPLÉTER]` non signalé.

## 5. Livraison
- Texte > ~15 lignes ou enjeu fort (annonce, proposition, réclamation) : livre **deux versions** relues ; essentielle (≤ 5 lignes) et développée. L'utilisateur choisit.
- Affiche le texte dans ta réponse, prêt à copier.
- Fichier demandé : `write_file` avec un nom clair (ex. `2026-08-06-cr-comite.md`), puis confirme le chemin.
- Galactus n'envoie rien : ne promets jamais l'envoi d'un email, l'utilisateur copie-colle lui-même.
- En retouche, modifie uniquement ce qui est demandé, sans réécrire le reste.

## Garde-fous
- Jamais d'engagement inventé (prix, délai, promesse contractuelle) : uniquement ce que l'utilisateur a validé.
- Tout reste sur le Mac : n'envoie jamais le texte ni les sources vers le web (pas de `curl` vers un correcteur, traducteur ou autre service en ligne).
- Contenu sensible (RH, juridique, litige) : rédige, mais recommande explicitement une relecture humaine avant envoi.
