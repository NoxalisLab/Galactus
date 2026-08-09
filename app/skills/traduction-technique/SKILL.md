---
name: traduction-technique
description: "Traduire doc, interface ou messages d'erreur : glossaire, balisage préservé."
---

Une traduction technique se juge sur deux choses : **la terminologie est constante** d'un bout à l'autre, et **rien de non traduisible n'a été traduit**. Le style vient après.

## 0. Cadre en quatre lignes ; avant d'ouvrir le fichier
Établis, et fais valider si un élément manque : langue source et langue cible (avec la variante, `fr-FR` et `fr-CA` ne se traitent pas pareil), nature du texte (documentation, interface, message d'erreur, contrat, article), registre (tutoiement ou vouvoiement, formel ou direct), et ce qui doit rester en anglais.
Par défaut en français technique : les identifiants de code, les noms de produits, les noms de fonctions et les termes établis du métier restent en anglais. On ne traduit pas `commit`, `pull request`, `endpoint` ou `buffer` par principe ; on les traduit quand le lectorat visé l'attend, et alors on le décide une fois pour toutes dans le glossaire.

## 1. Le glossaire, avant la première phrase
C'est la pièce qui rend la traduction cohérente et rejouable.
1. Extrais les termes récurrents de la source :
```
run_command("tr -c '[:alnum:]_' '\\n' < SOURCE.md | tr '[:upper:]' '[:lower:]' | sort | uniq -c | sort -rn | head -60")
```
2. Construis un fichier `glossaire.csv` avec `write_file` : `terme_source;traduction;ne_pas_traduire;note`.
3. **Fais valider le glossaire par l'utilisateur AVANT de traduire.** Corriger 200 occurrences après coup coûte dix fois plus cher que trancher 15 termes avant.
4. Une traduction existante est fournie ? Extrais-en le glossaire réel plutôt que d'en inventer un : la cohérence avec l'existant prime sur ta préférence.

## 2. Ce qui ne se traduit jamais
- Le code, dans un bloc ou en ligne, y compris les commentaires si l'utilisateur ne l'a pas demandé.
- Les identifiants : noms de variables, de fonctions, de classes, de fichiers, de tables, de clés JSON ou YAML.
- Les URLs, les chemins, les commandes shell, les noms de paquets.
- Les balises, les attributs HTML et Markdown, les ancres de liens, les clés de localisation.
- Les marqueurs d'interpolation : `{count}`, `%s`, `{{name}}`, `$1`. **Les préserver à l'identique, dans le même nombre.** Un marqueur perdu ou renommé fait planter l'application à l'exécution, pas à la relecture.
- Les messages destinés aux logs quand la convention du projet les garde en anglais : vérifie avant de trancher.

## 3. Traduire par blocs
- Segmente en unités qui gardent leur contexte : une section, une entrée de fichier de localisation, un paragraphe. Ne traduis jamais une phrase isolée d'un tableau sans avoir lu la colonne.
- Source longue : lis par tranches (`read_file` avec `offset`), traduis la tranche, écris le résultat, puis passe à la suivante. Après chaque tranche, note en 3 lignes : plage couverte, nouveaux termes rencontrés, choix faits. Ces notes survivent au résumé du fil, pas le texte.
- Plusieurs fichiers indépendants : `spawn_agent` un coéquipier par fichier (2 à 6 max). Le brief doit contenir **le glossaire en entier**, pas une référence à lui : un coéquipier part d'un contexte vierge. Puis `ask_agent`.
- Conserve la structure exacte : même nombre de lignes dans un fichier de localisation, mêmes niveaux de titres, mêmes listes, même ordre.

## 4. Contrôles mécaniques ; obligatoires avant de livrer
Ces quatre contrôles attrapent la quasi-totalité des défauts d'une traduction technique.
```
run_command("grep -coE '\\{[a-zA-Z_]+\\}|%[sd]|\\{\\{[^}]+\\}\\}' SOURCE.md CIBLE.md")
```
Nombre de marqueurs d'interpolation identique des deux côtés. Différence = régression, corrige avant tout le reste.
```
run_command("grep -c '^#' SOURCE.md; grep -c '^#' CIBLE.md; grep -c '^```' SOURCE.md; grep -c '^```' CIBLE.md")
```
Même nombre de titres et de délimiteurs de blocs de code. Un bloc de code non fermé casse le rendu.
```
run_command("grep -oE 'https?://[^ )\"]+' SOURCE.md | sort > /tmp/u1; grep -oE 'https?://[^ )\"]+' CIBLE.md | sort > /tmp/u2; diff /tmp/u1 /tmp/u2 | head -20")
```
URLs identiques. Une URL « traduite » est une URL morte.
Cohérence du glossaire, terme par terme :
```
run_command("grep -ionE 'TERME_SOURCE' SOURCE.md | wc -l; grep -ionE 'TRADUCTION_RETENUE' CIBLE.md | wc -l")
```
Les deux comptes doivent correspondre, aux occurrences non traduisibles près. Un écart signale une traduction incohérente ou un oubli.
Complétude : `run_command("wc -l -w SOURCE.md CIBLE.md")`. Un écart de plus de 25 % sur le nombre de mots mérite une explication ; du français traduit de l'anglais s'allonge typiquement de 10 à 20 %.

## 5. Relecture de fond
1. Typographie française : espace insécable avant `: ; ? !`, guillemets `« »`, espace fine dans les nombres (`10 000`), `M.` et `Mme`.
2. Faux amis techniques du couple anglais-français : `eventually` (finalement, pas éventuellement), `actually` (en réalité), `library` (bibliothèque, pas librairie), `to support` (prendre en charge), `deprecated` (obsolète), `to assert` (vérifier, dans un test).
3. Voix active et phrases courtes. Un manuel anglais en voix passive traduit littéralement devient illisible en français.
4. Interface : compte les caractères. Une chaîne française dépasse souvent son anglais de 20 % et coupe un bouton. Propose une variante courte quand la place est contrainte.
5. Un passage ambigu dans la source ne se devine pas : traduis au plus près, marque `[ambigu : …]`, et signale-le en fin de réponse.

## Garde-fous
- N'invente jamais un terme technique. Introuvable dans le glossaire et pas d'équivalent établi : garde l'anglais et signale-le.
- Ne corrige jamais une erreur de la source en silence : traduis fidèlement, et signale l'erreur à part.
- **Tout reste sur ce Mac** : n'envoie jamais le texte vers un service de traduction en ligne, pas de `curl` ni de `fetch_url` vers un traducteur. C'est la raison d'être de ce travail en local.
- Document juridique, médical ou contractuel : traduis, mais recommande explicitement une relecture par un traducteur assermenté ou un spécialiste avant tout usage engageant.
- Restitution finale : le glossaire utilisé, les résultats bruts des quatre contrôles mécaniques, les passages marqués ambigus, les termes laissés en anglais, et le chemin du fichier produit.
