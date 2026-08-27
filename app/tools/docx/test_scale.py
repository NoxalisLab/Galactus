"""A l'echelle du lot reel: 15 000 paragraphes, 414 lignes, 91 quasi-correspondances.

Ce que ce test pese: le cout du chemin quasi-correspondance (le scan difflib
etait mesure a 87 s sur ce volume) et la taille du rapport, qui est ce qui avait
fait exploser la fenetre de contexte le 27 aout.

Les phrases sont VRAIMENT distinctes les unes des autres, comme dans une notice
reelle. Une fixture ou toutes les phrases se ressemblent mesure l'ambiguite, pas
l'echelle: c'est ce que fait test_apply.
"""
import hashlib, json, subprocess, sys, time
from docxlab import build, read_paras, HELPER, TMP

PARAS = 15000
ROWS = 414
NEAR = 91


def token(r: int, n: int = 24) -> str:
    """Un bloc propre a la ligne r, assez long et assez disperse pour qu'aucune
    ligne ne ressemble a une autre au sens de difflib.

    Un generateur arithmetique modulo 26 semblait faire l'affaire et ne la
    faisait pas: il boucle toutes les 26 lignes, si bien que 414 phrases n'en
    valaient que 16 distinctes et que la mesure portait sur des doublons.
    """
    return hashlib.sha256(str(r).encode()).hexdigest()[:n]


lines = [f"Paragraphe {i} de la notice, texte de remplissage sans interet." for i in range(PARAS)]
sources = []
for r in range(ROWS):
    k = r * 30 + 7
    phrase = (f"Avant toute utilisation du dispositif, verifier {token(r)} "
              f"et {token(r + 1000)}, sous peine de contamination du patient.")
    # Les 91 premieres: le document ajoute ", au pliage," a la phrase que la
    # table cite sans elle. C'est le "closest match 95%" du lot du 27 aout.
    lines[k] = phrase.replace("du dispositif", "du dispositif, au pliage,") if r < NEAR else phrase
    sources.append(phrase)

src, out = TMP / "scale.docx", TMP / "scale_out.docx"
build(src, lines)
plan = {"edits": [
    {"id": f"L{r}", "op": "replace", "find": sources[r], "replace": f"Before use, check reference {r}."}
    for r in range(ROWS)
]}
(TMP / "scale_plan.json").write_text(json.dumps(plan, ensure_ascii=False))

t0 = time.time()
p = subprocess.run([sys.executable, HELPER, "apply", str(src), str(out), str(TMP / "scale_plan.json")],
                   capture_output=True, text=True)
elapsed = time.time() - t0
assert p.returncode == 0, p.stderr
res = json.loads(p.stdout)
size = len(p.stdout)

print(json.dumps({k: v for k, v in res.items() if not isinstance(v, list)}, indent=2))
print(f"\ndocument : {PARAS} paragraphes | lignes : {ROWS}")
print(f"duree    : {elapsed:.1f} s")
print(f"rapport  : {size} caracteres   (le lot du 27 aout: 37532)\n")

paras = read_paras(out)
fails = []


def check(label, cond, detail=""):
    print(("  ok   " if cond else "  FAIL ") + label + ("" if cond else f"  -> {detail}"))
    if not cond:
        fails.append(label)


counts = {k: res[k] for k in ("applied", "exact", "near_match", "failed")}
check("les 414 lignes sont passees", res["applied"] == ROWS, counts)
check(f"{ROWS - NEAR} exactes", res["exact"] == ROWS - NEAR, counts)
check(f"{NEAR} en quasi-correspondance", res["near_match"] == NEAR, counts)
check("aucun echec", res["failed"] == 0, counts)
check("une quasi-correspondance ne touche qu'un paragraphe",
      all(m["count"] == 1 for m in res.get("near_matches", [])),
      [m["count"] for m in res.get("near_matches", [])])
check("quasi-correspondance ecrite", paras[7] == "Before use, check reference 0.", paras[7])
check("exacte ecrite", paras[(NEAR + 5) * 30 + 7] == f"Before use, check reference {NEAR + 5}.",
      paras[(NEAR + 5) * 30 + 7])
check("paragraphe voisin intact", paras[8].startswith("Paragraphe 8 "), paras[8])
check(f"rapport sous 20 KB ({size})", size < 20000, size)
check(f"le plafond de 60 est annonce ({res.get('near_matches_omitted')})",
      res.get("near_matches_omitted") == NEAR - 60, res.get("near_matches_omitted"))

print()
print("ECHECS:", fails if fails else "aucun")
sys.exit(1 if fails else 0)
