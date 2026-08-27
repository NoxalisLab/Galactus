"""Ce que `apply` doit faire: appliquer l'exact, reparer la quasi-correspondance,
refuser le reste, et tenir dans une fenetre de contexte."""
import json, sys
from docxlab import build, read_paras, run, TMP

fails = []


def check(label, cond, detail=""):
    print(("  ok   " if cond else "  FAIL ") + label + ("" if cond else f"  -> {detail}"))
    if not cond:
        fails.append(label)


# --- 1. exact, quasi-correspondance, et introuvable dans le meme lot ---------
src, out = TMP / "src.docx", TMP / "out.docx"
# La phrase "near" reproduit le cas reel: une notice ou le document ajoute
# ", au pliage," a une phrase que la table de traduction cite sans elle. Sur
# une phrase de longueur d'IFU, cet ecart vaut environ 95%, exactement le
# "closest match 95%" des 91 lignes refusees sur le lot du 27 aout.
DOC_NEAR = ("Ne pas reutiliser le dispositif, au pliage, apres ouverture de "
            "l'emballage sterile, sous peine de contamination du patient.")
TABLE_NEAR = ("Ne pas reutiliser le dispositif apres ouverture de "
              "l'emballage sterile, sous peine de contamination du patient.")
build(src, [
    "Le dispositif est sterile.",
    DOC_NEAR,
    "Conserver a l'abri de la lumiere.",
])
res = run(src, out, {"edits": [
    {"id": "exact",   "op": "replace", "find": "Le dispositif est sterile.", "replace": "The device is sterile."},
    {"id": "near",    "op": "replace", "find": TABLE_NEAR, "replace": "Do not reuse after opening."},
    {"id": "absent",  "op": "replace", "find": "Phrase qui n'existe nulle part ici.", "replace": "X"},
]})
print(json.dumps(res, ensure_ascii=False, indent=2)[:900])
paras = read_paras(out)
check("exact applique", res["exact"] == 1, res)
check("quasi-correspondance appliquee", res["near_match"] == 1, res)
check("introuvable signale", res["failed"] == 1, res)
check("texte exact ecrit", paras[0] == "The device is sterile.", paras)
check("texte quasi ecrit", paras[1] == "Do not reuse after opening.", paras)
check("paragraphe intact", paras[2] == "Conserver a l'abri de la lumiere.", paras)
check("out annonce", res["out"] == str(out), res)
check("la near match est detaillee", "near_matches" in res and res["near_matches"][0]["ratio"] >= 0.92, res)
check("l'echec est detaille", "failures" in res and res["failures"][0]["id"] == "absent", res)
check("les succes ne sont PAS detailles", "report" not in res, list(res))

# --- 2. le rapport reste petit sur un gros lot ------------------------------
big_src, big_out = TMP / "big.docx", TMP / "big_out.docx"
build(big_src, [f"Phrase numero {i} du document." for i in range(400)])
res2 = run(big_src, big_out, {"edits": [
    {"id": f"L{i}", "op": "replace", "find": f"Phrase numero {i} du document.", "replace": f"Sentence {i}."}
    for i in range(400)
]})
size = len(json.dumps(res2, ensure_ascii=False))
check("400 lignes appliquees", res2["applied"] == 400, res2)
check(f"rapport compact ({size} caracteres, avant: 37532)", size < 2000, size)

# --- 3. fuzzy desactivable --------------------------------------------------
res3 = run(src, TMP / "out3.docx", {"fuzzy": False, "edits": [
    {"id": "near", "op": "replace", "find": TABLE_NEAR, "replace": "Do not reuse after opening."},
]})
check("fuzzy:false refuse la quasi-correspondance", res3["applied"] == 0 and res3["written"] is False, res3)

# --- 4. un ecart trop grand n'est jamais applique ---------------------------
res4 = run(src, TMP / "out4.docx", {"edits": [
    {"id": "loin", "op": "replace", "find": "Le dispositif est sterile mais il faut le jeter tout de suite.", "replace": "NON"},
]})
check("ecart > 8% refuse", res4["applied"] == 0, res4)

# --- 5. une quasi-correspondance ambigue n'ecrit RIEN -----------------------
# Le vrai danger du rapprochement flou: une notice dont le passe-partout se
# repete avec une reference qui change. Chaque candidat est une phrase
# DIFFERENTE, donc appliquer partout ecraserait tout sauf une.
amb_src = TMP / "amb.docx"
build(amb_src, [
    "Verifier la reference 1 du dispositif avant toute utilisation en salle.",
    "Verifier la reference 2 du dispositif avant toute utilisation en salle.",
    "Verifier la reference 3 du dispositif avant toute utilisation en salle.",
])
res5 = run(amb_src, TMP / "amb_out.docx", {"edits": [
    {"id": "amb", "op": "replace",
     "find": "Verifier la reference 9 du dispositif avant toute utilisation en salle.",
     "replace": "ECRASE"},
]})
check("l'ambiguite n'ecrit rien", res5["applied"] == 0 and res5["written"] is False, res5)
check("l'ambiguite est nommee", res5["failures"][0]["status"] == "ambiguous", res5["failures"])
check("elle compte ses candidats", res5["failures"][0]["candidates"] == 3, res5["failures"])
check("le document est intact", read_paras(amb_src)[0].startswith("Verifier la reference 1"),
      read_paras(amb_src)[0])

# --- 6. levee de l'ambiguite par paragraph ----------------------------------
res6 = run(amb_src, TMP / "amb_out6.docx", {"edits": [
    {"id": "amb", "op": "replace", "paragraph": 2,
     "find": "Verifier la reference 9 du dispositif avant toute utilisation en salle.",
     "replace": "Check reference 2 before use."},
]})
check("paragraph leve l'ambiguite", res6["near_match"] == 1, res6)
check("seul le paragraphe vise change",
      read_paras(TMP / "amb_out6.docx") == [
          "Verifier la reference 1 du dispositif avant toute utilisation en salle.",
          "Check reference 2 before use.",
          "Verifier la reference 3 du dispositif avant toute utilisation en salle."],
      read_paras(TMP / "amb_out6.docx"))

print()
print("ECHECS:", fails if fails else "aucun")
sys.exit(1 if fails else 0)
