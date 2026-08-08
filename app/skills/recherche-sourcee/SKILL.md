---
name: recherche-sourcee
description: "À utiliser quand l'utilisateur demande une recherche d'information fiable : faits vérifiés, sources croisées, synthèse avec URLs datées."
---

Recherche 100% via `run_command` + `curl` (pas de navigateur). Règle d'or : aucun fait sans URL précise et sans date.

## 1. Cadre la question
- Reformule la demande en une question précise : sujet, période, zone, niveau de détail attendu.
- Récupère la date du jour (`run_command("date")`) pour dater les résultats et repérer le périmé.
- Question ambiguë ? Pose UNE clarification avant de chercher.

## 2. Décompose et délègue
- Sujet large ou multi-sources : découpe en 2 à 6 sous-questions indépendantes, puis `spawn_agent` un coéquipier par sous-question et interroge-les avec `ask_agent`.
- Chaque brief doit répéter les consignes ; les coéquipiers partent d'un contexte vierge : « Web uniquement via run_command/curl. Chaque fait avec URL précise + date de publication. Minimum 2 sources indépendantes par affirmation importante. Liste ce que tu n'as pas trouvé. »
- Question simple à source unique (un chiffre officiel, une doc) : cherche directement, sans workflow.

## 3. Récupère léger
- Pas d'URL connue ? Point d'entrée : `curl -sL -m 20 -A "Mozilla/5.0" "https://lite.duckduckgo.com/lite/?q=REQUETE"`, puis ouvre les URLs prometteuses.
- Préfère les endpoints JSON aux pages HTML lourdes : Wikipedia REST (`https://fr.wikipedia.org/api/rest_v1/page/summary/Titre`), API GitHub, APIs officielles.
- Toujours `-m 20 -A "Mozilla/5.0"` ; limite le volume : `| head -c 20000`, `grep`, `jq`. Sortie > 200 Ko : elle part en fichier scratch (chemin donné), relis-la par sections avec `read_file(chemin, offset)`.
- 403 ou timeout : tente une source alternative ; après 2 échecs sur le même fait, note la limite et passe.

## 4. Croise et qualifie
- Toute affirmation importante : minimum 2 sources INDÉPENDANTES (deux articles reprenant le même communiqué = une seule source).
- Étiquette chaque élément : [FAIT] vérifié multi-sources, [ESTIMATION] projection/extrapolation, [OPINION] avis/analyse.
- Date chaque info avec la date de publication de la source, pas la date de consultation. Signale les infos anciennes si le sujet évolue vite.
- Recoupe aussi les rapports de sous-agents entre eux ; toute contradiction (entre rapports ou entre sources) : signale-la explicitement, ne tranche jamais en silence.

## 5. Synthétise
- Structure : réponse directe en tête → détails par sous-question → section « Limites » (non vérifié, non trouvé).
- Termine par une liste « Sources » numérotée : URL complète + date + ce qu'elle appuie. Chaque fait de la synthèse renvoie à un numéro [n].

## Garde-fous
- N'invente JAMAIS une URL, un chiffre ou une citation. Fait introuvable = écris « non trouvé », pas une approximation.
- Ta connaissance interne sert à formuler les requêtes, jamais de source : tout ce qui figure dans la synthèse vient des pages réellement récupérées.
- Tes interprétations personnelles vont en [OPINION], clairement attribuées à toi.
