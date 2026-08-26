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
#
# Case-insensitive, because the two survivors of the previous pass were "Vous"
# and "Votre Mac", capitalised at the head of a sentence, and this pattern had
# no re.I. The label on every message the user sends read "Vous" for a year.
VOUVOIEMENT = re.compile(r"\b(?:votre|vos)\b|\bvous\b", re.I)

# The register did not drift on the pronoun, it drifted on the verb. Almost
# nothing said "vous"; twenty-five strings said "Redémarrez le modèle" and
# "Quittez une application", and they were the failure messages, so the app
# tutoyait while it worked and vouvoyait the moment it broke. A second-person
# plural imperative is vouvoiement whether or not the pronoun is written.
#
# The floor of three characters before -ez already excludes chez, nez, rez and
# fez. What it does not exclude is a genuine word of five letters or more that
# happens to end that way, so those are named here one by one, as they turn up.
# A false positive stops the build on a correct string, which is worse than the
# rule not existing; nothing goes in this set on suspicion.
IMPERATIVE_EZ = re.compile(r"\b\w{3,}ez\b", re.I)
NOT_SECOND_PERSON = {
    "assez",  # adverb
}
# Nouns that carry a conjugated form inside a hyphenated compound. "aidez" on
# its own is an imperative; in aidez-mémoire it is part of a noun. Removed from
# the string before the imperative rule reads it.
COMPOUND_NOUNS = re.compile(r"\baidez-mémoire\b", re.I)

# The borrowed nouns, which the product treats as masculine.
WRONG_GENDER = re.compile(r"\b(?:une|cette|la)\s+(?:run|skill)\b|\brun\s+autonome\b.{0,40}\belle\b")


def french_strings(text: str):
    for match in re.finditer(r'"([\w.]+)":\s*\{[^}]*?fr:\s*"((?:[^"\\]|\\.)*)"', text, re.S):
        yield match.group(1), match.group(2), text[: match.start()].count("\n") + 1


def second_person_plural(value: str):
    """The -ez verbs in one string, minus the words that only look like verbs."""
    readable = COMPOUND_NOUNS.sub(" ", value)
    seen = {m.group(0).lower() for m in IMPERATIVE_EZ.finditer(readable)}
    return sorted(seen - NOT_SECOND_PERSON)


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
        for verb in second_person_plural(value):
            problems.append((line, key, f"{verb} is vouvoiement; this product says tu", value))
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
