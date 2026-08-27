---
name: documents-depuis-tableau
description: "Modifier des documents Word ou PDF à partir d'un tableau : remplacer des phrases, insérer du texte, ajouter une page, en série et sans jamais écraser l'original."
---

Tu appliques à un ou plusieurs documents ce qu'un tableau dicte : une phrase à remplacer, une mention à ajouter, une annexe à joindre.

**La première question est le format, et elle décide de tout le reste.**

Un `.docx` se modifie proprement : c'est un zip de XML, le texte est du texte, et un remplacement conserve exactement la mise en page, les styles, les images, les en-têtes et les tableaux. Rien n'est aplati, rien ne rétrécit. Une phrase coupée en plusieurs morceaux par du gras est retrouvée quand même, parce que l'outil raisonne sur le texte complet du paragraphe et pas sur les fragments.

Un `.pdf` ne peut pas offrir ça : il n'a pas de paragraphes, seulement des glyphes à des coordonnées. Remplacer y signifie recouvrir puis redessiner, la page modifiée est transformée en image pour que les anciens mots disparaissent réellement, et une phrase plus longue que celle qu'elle remplace rétrécit pour tenir.

Donc : **si le document Word d'origine existe, travaille dessus**, même si l'utilisateur t'a d'abord montré le PDF. Demande-le. C'est la différence entre un document intact et un document abîmé.

## 0. Lis le tableau, et rends-le à l'utilisateur avant d'agir

```
read_document(chemin/du/classeur.xlsx)
```
Un `.xlsx` te revient comme un vrai tableau : une ligne d'en-tête nommant les colonnes par leur lettre Excel (`A`, `B`, `C`), puis une ligne par ligne du classeur, **précédée de son numéro de ligne Excel**. Les feuilles sont séparées et nommées comme leurs onglets, les cellules vides gardent leur place, les dates sortent en `2025-01-01` et non en nombre de jours, et le résultat d'une formule est sa valeur affichée. Un `.csv` se lit tout aussi bien.

Sers-toi de ces numéros de ligne : ils sont ceux que l'utilisateur voit dans Excel, donc « ligne 12 ignorée » est une phrase qu'il peut vérifier en trois secondes.

**Avant d'écrire quoi que ce soit, reformule ce que tu as compris** : combien de lignes de consignes, quelle colonne désigne le document, laquelle contient le texte à chercher, laquelle le texte de remplacement. Fais valider. Une colonne mal interprétée, ce sont deux cents documents faux.

Méfie-toi de deux choses qu'un tableau réel contient toujours : des lignes vides ou incomplètes (une consigne sans texte de remplacement n'est pas une consigne, signale-la et passe), et des espaces en trop en début ou fin de cellule, qui font échouer une recherche exacte. Nettoie-les avant de chercher.

## 1. Regarde le document avant de le modifier

```
read_document(path)
```
Sur un PDF, si le texte revient vide ou en désordre, c'est un scan : la couche texte n'existe pas et `edit_document` ne trouvera rien, parce qu'il cherche dans cette couche. Dis-le et arrête-toi là plutôt que de produire un fichier inchangé que l'utilisateur croira modifié. Sur un `.docx`, ce cas n'existe pas.

## 2. Localise avant de remplacer

```
edit_document(operation: "find", path, find: "un fragment court")
```
Cette opération n'écrit rien. Elle rend la page et le rectangle de chaque occurrence, et surtout elle te dit **si la recherche aboutit**. Zéro correspondance sur une phrase que tu vois pourtant dans le texte : elle est presque toujours coupée par un retour à la ligne. Réessaie sur un fragment plus court, tenant sur une seule ligne, et unique dans le document.

Vérifie aussi le nombre : trois occurrences pour une phrase que tu croyais unique, c'est trois remplacements. Si ce n'est pas voulu, restreins le fragment.

## 1 bis. Une colonne « page » ne peut pas fonctionner sur un Word

Si le tableau désigne les portions à modifier par un numéro de page, **dis-le tout de suite** : un `.docx` ne contient pas de pages. Word les calcule au moment de la mise en page, à partir du format de papier, des polices, des images et jusqu'au pilote d'imprimante, si bien que le même fichier ne se pagine pas pareil sur deux machines. Rien dans le fichier ne dit « page 3 ». L'outil refuse d'ailleurs `page` sur un Word, avec cette explication, plutôt que de faire semblant.

Ce qu'un document contient vraiment, et qui désigne une portion sans ambiguïté :

- **un intervalle entre deux titres** : `between_start: "Article 4"`, `between_end: "Article 5"`. C'est la forme à privilégier, et celle qui correspond à l'intention quand quelqu'un écrit « page 4 » : il pense à une section, pas à une feuille de papier.
- **un numéro de paragraphe**, tel que `find` le renvoie. Utile quand la passe à blanc a déjà identifié l'endroit exact.
- **un numéro d'occurrence** : `occurrence: 2` pour ne changer que la deuxième apparition d'une phrase qui revient.

Propose donc à l'utilisateur de remplacer sa colonne « page » par une colonne « section » ou « article », qui porte le titre exact tel qu'il figure dans le document. C'est plus court à remplir, et surtout ça reste juste quand la mise en page bouge.

Sur un PDF, en revanche, les pages existent et `page` fonctionne : c'est une vraie différence entre les deux formats, pas une inconstance de l'outil.

`find` te renvoie aussi `explicit_page_breaks`, le nombre de sauts de page posés à la main dans le document. Zéro signifie que la pagination est entièrement calculée par Word : c'est l'argument à donner à l'utilisateur qui insiste avec ses numéros de page.

## 2 bis. Une passe à blanc sur TOUT le lot, avant la première écriture

C'est l'étape qui distingue un travail sérieux d'un massacre en série. Avant d'écrire le moindre fichier, parcours **toutes** les lignes du tableau avec `find` seul, qui n'écrit rien, et rends un état :

| Ligne | Document | Trouvé | Remarque |
|---|---|---|---|
| 2 | contrat-dupont.docx | 1 fois | |
| 3 | contrat-martin.docx | **0 fois** | phrase introuvable, probablement coupée |
| 4 | contrat-durand.docx | 3 fois | 3 remplacements, est-ce voulu ? |
| 5 | contrat-petit.docx | fichier absent | |

Puis **arrête-toi et fais valider ce tableau**. Sur des documents que tu ne peux pas montrer à leur auteur autrement, c'est sa seule occasion de voir ce qui va se passer avant que ça se passe. Une ligne à zéro correspondance ou à trois correspondances est une question, pas un détail : pose-la.

Cette passe ne coûte rien : `find` ne modifie aucun fichier et ne crée rien.

## 3. Remplace, et lis ce que l'outil répond

```
edit_document(operation: "replace", path, out, find, replace)
```
`out` est **obligatoirement un autre fichier**. L'outil refuse d'écrire sur l'original, et c'est une protection, pas une contrainte à contourner : garde toujours la source intacte pour pouvoir recommencer.

Deux champs de la réponse méritent d'être lus, et rapportés à l'utilisateur :

- `replaced` : combien d'occurrences ont été traitées. **Zéro signifie qu'aucun fichier n'a été écrit** ; ne dis jamais que c'est fait.
- `smallest_scale` : de combien la nouvelle phrase a dû rétrécir pour tenir dans la place de l'ancienne. En dessous d'environ 0,7 le résultat se voit à l'œil. Préviens, et propose l'alternative : une phrase plus courte, ou un ajout ailleurs sur la page plutôt qu'un remplacement.

Sache aussi ce que tu échanges : **une page modifiée est redessinée en image**, pour que les anciens mots disparaissent réellement du fichier au lieu d'être seulement masqués. Cette page perd donc son texte sélectionnable. Les autres pages n'y touchent pas. Si l'utilisateur tient à garder le texte sélectionnable, il faut savoir que l'ancienne phrase reste alors récupérable par un copier-coller : dans un document destiné à un tiers, c'est une fuite, dis-le clairement.

## 4. Ajouter plutôt que remplacer, quand c'est possible

Ajouter est toujours plus sûr : rien n'est masqué, aucune page n'est aplatie, rien ne rétrécit.

```
edit_document(operation: "insert", path, out, page, x, y, size, text)
edit_document(operation: "append", path, out, size, text)
```
Pour `insert`, `x` et `y` sont en points depuis le coin **bas gauche**, et une page A4 fait 595 par 842. Prends les coordonnées d'une occurrence rendue par `find` plutôt que de les deviner : placer une mention juste sous un paragraphe existant demande le `y` de ce paragraphe moins la hauteur d'une ligne.

`append` ajoute une page en fin de document et conserve la taille de la dernière page. C'est la bonne réponse quand le tableau apporte plus de texte qu'une phrase.

## 5. Tout le lot en un seul appel : `apply`

Sur un Word, n'enchaîne pas quatre cents `replace`. Chacun coûte un aller-retour au modèle, soit une nuit de travail pour un tableau ordinaire. Écris le lot dans un fichier JSON et donne-le à `apply`, qui le passe en une fois :

```
edit_document(operation: "apply", path, out, plan: "/chemin/plan.json")
```

```json
{"edits": [
  {"id": "ligne 2 ES", "op": "replace", "find": "…", "replace": "…"},
  {"id": "ligne 3 ES", "op": "insert",  "find": "…", "text": "…"}
]}
```

L'`id` est à toi : mets-y la coordonnée de la ligne dans le tableau, c'est ce qui rendra le rapport lisible pour l'utilisateur.

### Lire la réponse

Elle est volontairement courte : des compteurs pour ce qui a marché, le détail **seulement** pour ce qui n'a pas marché.

| Champ | Ce qu'il dit |
|---|---|
| `applied` / `total` | combien de lignes sur combien |
| `exact` | appliquées au caractère près |
| `near_match` | appliquées sur une **quasi-correspondance** |
| `failed` | non appliquées, inchangées dans la sortie |
| `written` | `false` signifie **qu'aucun fichier n'existe** |
| `out` | le chemin du fichier produit |
| `near_matches`, `failures` | le détail, ligne par ligne, plafonné |

Une **quasi-correspondance** est une ligne dont le document dit presque la phrase du tableau : une virgule en plus, un mot d'écart. C'est le cas normal, pas l'exception : une table de traduction ne cite jamais son document au caractère près. L'outil remplace alors le paragraphe entier et te donne son score et l'écart exact. **Annonce leur nombre à l'utilisateur** : ce sont les lignes qu'il voudra peut-être revoir.

Un statut `ambiguous` veut dire que plusieurs paragraphes sont aussi proches les uns que les autres, donc qu'aucun n'est clairement celui visé. Rien n'est écrit pour cette ligne, et c'est délibéré : resserre-la avec `between_start`, `paragraph` ou `occurrence`, ou pose la question.

Si le rapport te paraît tronqué, il ne l'est pas : `failures_omitted` et `near_matches_omitted` disent combien de lignes ne sont pas nommées. N'essaie pas de récupérer la liste complète, elle n'existe pas ; les compteurs sont la réponse.

## 6. En série

Une ligne du tableau, un fichier de sortie. Nomme les sorties de façon prévisible (`facture-042-modifiee.pdf`) et tiens un compte : traités, ignorés, et pour quelle raison. À la fin, donne ce décompte plutôt qu'un « c'est fait ».

Après chaque écriture, **relis le résultat** avec `read_document` sur le fichier produit. Sur une page remplacée, la couche texte est vide (la page est devenue une image) : c'est le signe que le remplacement a bien effacé l'ancien texte. Utilise alors `read_document(path, mode: "ocr")` pour vérifier ce qui est réellement visible.

## 7. Vérifie le fichier produit, toujours

Un document peut être écrit sans erreur et rester illisible pour Word. C'est déjà arrivé sur cette chaîne : les préfixes de namespace du fichier avaient été renommés à la réécriture, si bien que Word ouvrait le document, annonçait « contenu illisible » et proposait de le réparer. Rien ne l'avait signalé côté outil, puisque le XML restait valide.

Donc, après chaque écriture, relis le résultat avec `read_document`. Si le texte revient normalement, le fichier s'ouvre. Si la lecture échoue ou revient vide alors que le rapport annonce des opérations appliquées, **ne dis pas que c'est fait** : signale que le fichier produit est suspect et arrête-toi là.

Sur un lot, cette relecture se fait une fois, à la fin, sur le document produit. Elle coûte un appel et elle est la seule preuve que le travail est utilisable.

## Garde-fous

- Jamais d'écriture sur le PDF d'origine, jamais de suppression de la source.
- Zéro correspondance n'est pas une réussite : aucun fichier n'est écrit, dis-le.
- Un rétrécissement sous 0,7 se signale ; ne laisse pas l'utilisateur le découvrir à l'impression.
- Un PDF scanné ne peut pas être modifié par recherche de texte : constate-le et propose l'ajout d'une page ou d'une mention à une position donnée.
- Sur un lot, arrête-toi à la première anomalie inattendue et rends compte, plutôt que de produire deux cents fichiers douteux.
- Un fichier écrit n'est pas un fichier valide : relis-le avant de conclure.
