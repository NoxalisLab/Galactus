---
name: prompts-locaux
description: "Écrire ou réparer un prompt destiné à un modèle local à petite fenêtre."
---

Le contexte cible n'est pas celui d'un modèle en ligne. **8192 tokens par conversation**, partagés entre le prompt système, les schémas d'outils, la conversation et les sorties d'outils. Au delà de 75 % de remplissage, les anciens tours sont résumés et perdent leur texture. Un prompt écrit pour une fenêtre de 200 000 tokens ne se traduit pas, il se réécrit.

## 0. Le budget, en chiffres
- Une skill de 3 Ko coûte environ 800 tokens. Deux skills chargées, et il ne reste presque plus rien pour le travail.
- Une sortie d'outil de plus de 20 000 caractères part dans un fichier scratch ; seuls les 8 000 premiers restent dans l'historique, avec le chemin.
- Au delà de 1000 tokens, un prompt système dérive sur un modèle local : le début est appliqué, la fin oubliée.
- Chaque connecteur MCP actif ajoute ses schémas d'outils à chaque tour. Trois connecteurs « au cas où » réduisent la place utile.
**Règle de dimensionnement : la consigne tient en moins de 60 lignes, ou elle sera partiellement ignorée.**

## 1. Les quatre éléments d'une consigne qui marche
1. **Le point de départ exact** : un chemin absolu, un identifiant, un nom de fichier. Jamais « le fichier de config ».
2. **Le format de sortie, nommé** : un tableau markdown avec ces colonnes, un CSV à ce chemin, trois puces, un diff. Un format vague donne une réponse vague.
3. **La borne** : combien de fichiers, jusqu'où aller, combien de constats au maximum.
4. **La vérification** : la commande ou la relecture qui prouve que c'est juste.
Un prompt qui contient les quatre réussit ; il en manque un, et l'échec est prévisible.

## 2. Réparer un prompt existant ; par symptôme
| Symptôme observé | Cause | Correction du prompt |
|---|---|---|
| Réponse générique, aucune donnée du projet | aucun chemin ni fichier cité | donne le chemin absolu et impose une lecture avant de répondre |
| Il décrit au lieu de faire | verbe vague, ou mode manuel | verbes d'action, « fais-le », et nomme l'outil |
| Il invente une API ou un chemin | aucune source imposée | « ouvre le fichier qui définit ceci, recopie la signature ; introuvable, écris non vérifié » |
| Il fait la moitié du travail | deux tâches dans un message | une tâche par message |
| Il repart de zéro à mi-parcours | la fenêtre a été résumée | redonne le chemin et l'objectif, ou coupe en deux conversations |
| Il ignore la fin de la consigne | consigne trop longue | coupe à 60 lignes, mets l'essentiel en tête |
| Il « corrige » quand tu avais tort | complaisance | pose la question neutre : « vérifie si X est vrai et montre la preuve » |
| Il affirme avoir agi sans carte d'outil | hallucination d'action | exige une preuve : `run_command("git diff --stat")` |

## 3. Ce qui s'écrit différemment pour un modèle local
- **Impératif, présent, une action par ligne.** Les phrases conditionnelles imbriquées se perdent.
- **L'interdiction avant l'autorisation.** « Ne modifie aucun fichier » en tête pèse plus lourd qu'en fin de consigne.
- **Nommer l'outil exact** : `read_document` et non « lis le PDF », `search_workspace` et non « cherche ».
- **Pas d'exemples longs, pas de personnage.** Un exemple de 30 lignes coûte plus qu'il ne rapporte, et « tu es un ingénieur de 20 ans d'expérience » ne change rien au résultat. La procédure, oui.
- **Pas de chaîne de raisonnement demandée** sur un modèle déjà lent : à 5 tokens par seconde, 800 tokens de réflexion coûtent près de trois minutes.
- **Les tableaux battent les paragraphes** pour les règles conditionnelles : le modèle y retrouve sa ligne.

## 4. Adapter un prompt venu d'ailleurs
Quand tu reprends un prompt écrit pour un assistant en ligne, applique cette passe dans l'ordre :
1. **Supprime les outils qui n'existent pas ici.** Les seuls disponibles sont : `ask_agent`, `fetch_url`, `find_files`, `list_agents`, `list_directory`, `obsidian_append`, `obsidian_read`, `obsidian_search`, `obsidian_update`, `read_conversation`, `read_document`, `read_file`, `remember`, `run_command`, `search_conversations`, `search_knowledge`, `search_workspace`, `spawn_agent`, `update_plan`, `use_skill`, `write_file`, plus les outils `mcp__*` d'un connecteur actif. Tout autre nom d'outil doit disparaître.
2. **Supprime les hypothèses de contexte long** : « lis tout le dépôt », « garde tout en tête ». Remplace par une lecture bornée et des notes intermédiaires.
3. **Ajoute les contraintes réelles** : 120 s par commande, aucune interactivité, stdlib Python seulement, écriture de fichier soumise à acceptation.
4. **Coupe de moitié.** Un prompt frontier fait trois pages ; garde la séquence, les commandes et les garde-fous, jette les justifications et les exemples.
5. **Vérifie qu'il reste une étape de vérification.** Les prompts venus d'ailleurs l'omettent presque toujours.

## 5. Tester un prompt ; sinon tu ne sais rien
1. Écris **trois cas** avant de tester : un cas nominal, un cas limite, et un cas où la bonne réponse est « je ne peux pas ».
2. Fais tourner le prompt sur les trois, dans des conversations séparées : la même conversation contamine le second essai.
3. Le troisième cas est le plus important. Un prompt qui invente une réponse plutôt que d'admettre son ignorance est à rejeter, quelle que soit sa performance sur les deux autres.
4. Comparer deux formulations : même cas, même modèle, conversations séparées. Un prompt plus court est aussi un prompt plus rapide.
5. Brief de coéquipier : il doit être **autonome**. Un coéquipier ne voit pas ton fil ; chemins absolus, format de réponse et critères de qualité sont répétés en entier.

## Garde-fous
- Ne nomme jamais un outil qui n'existe pas dans la liste ci-dessus. Un outil inventé fait échouer le tour entier.
- Ne promets jamais dans un prompt une capacité absente : pas d'envoi d'e-mail, pas de navigateur piloté, pas d'accès au calendrier sans connecteur MCP.
- N'écris pas de prompt qui demande au modèle de calculer de tête : impose `python3` via `run_command` et la sortie brute.
- Un gabarit destiné à être réutilisé s'écrit dans un fichier (`write_file`) et se teste avant d'être annoncé comme prêt.
- Restitution finale : le prompt réécrit, sa taille approximative en tokens, ce que tu as retiré et pourquoi, les trois cas de test avec ce qui a été observé, et les limites connues.
