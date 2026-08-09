---
name: accessibilite
description: "Accessibilité web : audit WCAG, navigation clavier, lecteur d'écran, contrastes."
---

Un constat d'accessibilité se rattache toujours à un critère WCAG numéroté. Sans numéro de critère, ce n'est pas un audit, c'est un avis.

## 0. Ce que tu peux et ne peux pas vérifier ici
- **Vérifiable** : le code source (HTML, JSX, template, CSS), les contrastes calculés depuis les valeurs de couleur, la structure des titres, les attributs ARIA, les libellés de formulaire, l'ordre du DOM.
- **Non vérifiable** : le rendu réel, le focus visible à l'écran, le comportement d'un lecteur d'écran, le contraste sur une image de fond. L'application n'a pas de navigateur piloté.
- Une capture lue avec `read_document` ne rend que le texte par OCR. **Ne juge jamais une couleur, un contraste ou un espacement depuis une image.** Demande le code source.

## 1. Rassemble le code
- `find_files` pour les gabarits et composants (`*.html`, `*.jsx`, `*.tsx`, `*.vue`, `*.svelte`), puis `read_file` par sections.
- Dans un espace de travail ouvert, `search_workspace` est préférable à `grep` : pas de shell, confiné au dossier.
- Plus de deux écrans à auditer : `spawn_agent` un coéquipier par écran (2 à 6 max), chaque brief donnant les chemins exacts, la grille des sept passes ci-dessous et le format de constat ; puis `ask_agent` et fusionne.

## 2. Les sept passes ; chacune avec sa commande
**1. Images et médias (WCAG 1.1.1)**
```
run_command("grep -rnoE '<img[^>]*>' CHEMIN | grep -v 'alt=' | head -30")
```
Toute image sans `alt` est bloquante. Une image décorative prend `alt=""` explicite, pas l'absence d'attribut. Un `alt` qui répète le nom du fichier ne vaut rien.

**2. Formulaires (WCAG 1.3.1, 3.3.2)**
```
run_command("grep -rncE '<input|<select|<textarea' CHEMIN; grep -rnc '<label' CHEMIN")
```
Chaque champ a un `<label for>` associé, ou un `aria-label`, ou un `aria-labelledby`. Un `placeholder` n'est PAS un libellé : il disparaît à la saisie. Chaque message d'erreur est relié au champ par `aria-describedby` et annoncé par une zone `role="alert"`.

**3. Structure et titres (WCAG 1.3.1, 2.4.6)**
```
run_command("grep -rnoE '<h[1-6]' CHEMIN | head -40")
```
Un seul `<h1>` par page, aucun niveau sauté, l'ordre reflète la hiérarchie réelle et non la taille voulue. Des points de repère présents : `<main>`, `<nav>`, `<header>`, `<footer>`.

**4. Clavier (WCAG 2.1.1, 2.1.2, 2.4.7)**
```
run_command("grep -rnE 'onClick|@click' CHEMIN | grep -E '<div|<span' | head -20")
run_command("grep -rnE 'tabindex=\"[1-9]|outline: *none|outline: *0' CHEMIN | head -20")
```
Un `<div onClick>` est inatteignable au clavier : c'est bloquant. Utilise un vrai `<button>`. `tabindex` positif casse l'ordre de tabulation. `outline: none` sans remplacement supprime l'indicateur de focus, c'est bloquant. Toute fenêtre modale piège le focus et le rend à l'élément d'origine à la fermeture.

**5. Contrastes (WCAG 1.4.3, 1.4.11)**
Calcule, ne juge pas à l'oeil. Seuils : 4,5:1 pour le texte courant, 3:1 pour le texte large (18 pt, ou 14 pt gras) et pour les bordures de composants. Écris ce script avec `write_file`, puis lance-le sur toutes les paires du projet.
```python
# /tmp/contraste.py
def lum(h):
    c = [int(h.lstrip("#")[i:i+2], 16)/255 for i in (0, 2, 4)]
    c = [x/12.92 if x <= 0.03928 else ((x+0.055)/1.055)**2.4 for x in c]
    return 0.2126*c[0] + 0.7152*c[1] + 0.0722*c[2]
for fg, bg in [("#767676", "#ffffff"), ("#0066cc", "#ffffff")]:
    a, b = sorted((lum(fg), lum(bg)), reverse=True)
    print(fg, bg, round((a+0.05)/(b+0.05), 2))
```

**6. ARIA (WCAG 4.1.2)**
La première règle d'ARIA est de ne pas s'en servir : un élément natif fait toujours mieux. Cherche les usages fautifs :
```
run_command("grep -rnE 'role=\"button\"|aria-hidden=\"true\"|role=\"presentation\"' CHEMIN | head -20")
```
`aria-hidden="true"` sur un élément focalisable le rend invisible au lecteur d'écran tout en restant atteignable au clavier : bloquant. Un `role` qui contredit l'élément natif est pire que pas de `role`.

**7. Cibles, mouvement, langue (WCAG 2.5.8, 2.3.1, 3.1.1)**
Cibles interactives d'au moins 24x24 px CSS, 44 px sur mobile. `<html lang="fr">` présent et correct. Aucun clignotement de plus de 3 fois par seconde. Toute animation respecte `prefers-reduced-motion`.

## 3. Classe et localise
- **Bloquant** : l'utilisateur ne peut pas accomplir la tâche. Image informative sans `alt`, champ sans libellé, action inatteignable au clavier, focus invisible, piège au clavier, contraste sous 3:1.
- **Important** : barrière réelle. Titres désordonnés, erreur non annoncée, `aria-hidden` mal placé, contraste entre 3:1 et 4,5:1 sur du texte courant.
- **Suggestion** : cible un peu petite, libellé perfectible, point de repère manquant.

Format de chaque constat :
```
[Bloquant] WCAG 2.1.1 ; src/components/Menu.tsx:58
   Ligne : <div className="item" onClick={open}>Ouvrir</div>
   Effet : inatteignable au clavier et non annonce comme bouton
   Correction : <button type="button" className="item" onClick={open}>Ouvrir</button>
```
Sans `chemin:ligne`, sans la ligne recopiée et sans le numéro de critère, le constat ne compte pas. Maximum 12 constats, les plus graves d'abord, en disant combien tu as écartés.

## 4. Corriger
- Une correction à la fois, chacune avec son aperçu de diff. `write_file` est une proposition que l'utilisateur accepte : ne réécris jamais un fichier que tu n'as pas lu entièrement dans cette session.
- Après chaque correction, recompte le motif correspondant : le compte doit avoir baissé exactement du nombre attendu.
- Ne remplace jamais un composant natif par une reconstruction ARIA pour « faire propre ». Le sens inverse est le bon.

## Garde-fous
- N'affirme jamais qu'un contraste est conforme sans donner le rapport calculé et les deux couleurs.
- Ne conclus jamais à la conformité d'une page : une partie des critères ne se vérifie qu'à l'usage. Tu rends un audit du code, pas un certificat.
- Ne supprime jamais un attribut d'accessibilité existant que tu ne comprends pas.
- Une maquette produite avec la skill `ui-ux` repasse ces sept passes avant d'être livrée.
- Restitution finale : fichiers audités, constats par sévérité avec leur critère, corrections appliquées avec la preuve du recomptage, et la liste explicite de ce qui exige un test humain avec lecteur d'écran.
