#!/usr/bin/env python3
"""Spelling and register checks over the French strings of i18n.ts.

WHY THIS EXISTS. A pass that "fixed the missing accents" did it with substring
replacement, so the rule ferme -> fermé also rewrote fermer as fermér, three
times, and shipped. An infinitive of the first group never takes an accent, and
that is a rule a script can hold better than a person editing twenty strings in
one sitting.

It also watches the two things that drift on their own: the tu/vous register,
where fifteen strings had slid to vous while twenty-four still said tu, and the
gender of the borrowed nouns run and skill, which changed between neighbouring
lines.

Not a grammar checker. Every rule here corresponds to a mistake that actually
reached the product.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
I18N = ROOT / "app/src/i18n.ts"

# No French word ends in -ér. A participle ends in -é and an infinitive in -er,
# so the two together can only be a botched accent: fermer became fermér three
# times. Stated as the rule rather than as a list, because the next casualty
# will be a verb nobody thought to enumerate.
BAD_INFINITIVES = re.compile(r"\b\w+ér\b", re.I)

# Words whose accent was dropped, each seen in a shipped string.
MISSING_ACCENTS = {
    "authentifie": "authentifié",
    "copiee": "copiée",
    "installee": "installée",
    "generee": "générée",
    "telechargement": "téléchargement",
    "redemarrage": "redémarrage",
    "desactive": "désactivé",
    "planifiees": "planifiées",
    "surveillee": "surveillée",
    "derniere": "dernière",
}

# The product addresses one person it knows, on their own machine, so it says
# tu. Every string agreed on that except fifteen, which had drifted to vous and
# read like a bank. This catches the drift back.
VOUVOIEMENT = re.compile(r"\b(?:votre|vos)\b|\bvous\b")

# The borrowed nouns, which the product treats as masculine.
WRONG_GENDER = re.compile(r"\b(?:une|cette|la)\s+(?:run|skill)\b|\brun\s+autonome\b.{0,40}\belle\b")


def french_strings(text: str):
    for match in re.finditer(r'"([\w.]+)":\s*\{[^}]*?fr:\s*"((?:[^"\\]|\\.)*)"', text, re.S):
        yield match.group(1), match.group(2), text[: match.start()].count("\n") + 1


def main() -> int:
    text = I18N.read_text()
    problems = []
    for key, value, line in french_strings(text):
        if BAD_INFINITIVES.search(value):
            problems.append((line, key, "no French word ends in -ér", value))
        for wrong, right in MISSING_ACCENTS.items():
            if re.search(rf"\b{wrong}\b", value):
                problems.append((line, key, f"{wrong} should be {right}", value))
        if VOUVOIEMENT.search(value):
            problems.append((line, key, "vous; this product says tu", value))
        if WRONG_GENDER.search(value):
            problems.append((line, key, "run and skill are masculine here", value))

    if not problems:
        count = sum(1 for _ in french_strings(text))
        print(f"{count} French strings, nothing to report")
        return 0
    for line, key, why, value in problems:
        print(f"FAIL i18n.ts:{line} [{key}] {why}", file=sys.stderr)
        print(f"     {value[:110]}", file=sys.stderr)
    print(f"{len(problems)} problem(s)", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
