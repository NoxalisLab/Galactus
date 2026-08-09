---
name: ui-ux
description: "Concevoir ou critiquer une interface : audit UX ou maquette HTML/CSS."
---

## 0. Cadre (obligatoire, avant tout)
Établis en 3 lignes : utilisateur cible + tâche clé, plateforme (web desktop/mobile, app macOS…), livrable (critique = étape 2A OU maquette = étape 2B). Si flou : pose UNE question max ; sans réponse claire, choisis un défaut raisonnable et annonce-le.

## 1. Analyse l'existant
- Code HTML/CSS/composants : `read_file` (gros fichiers : par sections via offset).
- Capture d'écran, PDF, export design : `read_document`. Une image ne rend que le texte (OCR) : ne juge jamais couleurs, contraste ou espacements sans le code source.
- Projet entier : `list_directory`, puis lis uniquement les fichiers UI pertinents.
- 2 écrans ou plus : `spawn_agent` un coéquipier par écran (2 à 6 max), chaque brief donne les chemins exacts des fichiers car un coéquipier part de zéro, puis `ask_agent` et fusionne les rapports.
Relève : hiérarchie visuelle, espacements, couleurs/contraste, états manquants, parcours clavier.

## 2A. Critique structurée
Classe chaque constat par sévérité :
- **Bloquant** ; empêche la tâche clé : contraste illisible, action principale introuvable, focus clavier absent.
- **Majeur** ; gêne réelle : hiérarchie plate, états vide/erreur/chargement absents, cibles < 44 px.
- **Mineur** ; finitions : espacements irréguliers, incohérences typographiques.
Pour CHAQUE constat : où (fichier:ligne ou zone d'écran) → pourquoi c'est un problème → correction concrète. Max 10 constats, les plus graves d'abord.

## 2B. Maquette HTML/CSS
Écris UN fichier autonome via `write_file` (ex. `maquette-ui.html`) : CSS dans `<style>`, zéro dépendance externe (ni CDN, ni framework, ni npm ; le fichier doit s'ouvrir hors ligne). Propose ensuite `run_command` avec `open maquette-ui.html` pour l'afficher sur ton Mac.
Règles non négociables :
- Échelle d'espacement fixe : 4/8/12/16/24/32/48 px ; aucune valeur hors échelle.
- UNE action primaire par écran ; max 4 tailles de texte (ex. 13/15/18/24).
- États visibles dans la maquette : `:hover`, `:focus-visible` (anneau net), vide, erreur, chargement.
- Accessibilité : contraste texte ≥ 4.5:1, cibles ≥ 44 px, vrais `<button>`/`<a>`/`<label>` navigables au clavier.
- Contenu réaliste, jamais de lorem ipsum.

## 3. Itère
Après retour utilisateur : réécris le MÊME fichier via `write_file` (si tu n'as plus son contenu en contexte, relis-le d'abord avec `read_file`) ; n'en crée jamais un nouveau. Résume les changements en 3 puces max, puis redemande un retour.

## Garde-fous
- Ne modifie JAMAIS les fichiers du projet sans accord explicite : la maquette vit dans son propre fichier.
- OCR illisible ou ambigu ? Dis-le et demande le code source ; n'invente rien.
- Aucun avis esthétique gratuit : chaque remarque se rattache à la tâche clé ou à une règle ci-dessus.
- Pour appliquer la critique au code du projet : corrections fichier par fichier, une à la fois, chacune avec son aperçu diff.
