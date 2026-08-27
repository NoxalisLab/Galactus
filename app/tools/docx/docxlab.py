"""Fabrique de .docx minimalistes pour les tests de `apply`."""
import json, pathlib, subprocess, sys, tempfile, zipfile

HELPER = str(pathlib.Path(__file__).resolve().parents[2] / "src-tauri" / "helpers" / "galactus-docx.py")
TMP = pathlib.Path(tempfile.mkdtemp(prefix="galactus-docx-test-"))
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

DOC = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="{w}"><w:body>{paras}</w:body></w:document>"""
PARA = '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">{t}</w:t></w:r></w:p>'
RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""
CT = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""


def build(path, lines):
    body = "".join(PARA.format(t=t) for t in lines)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CT)
        z.writestr("_rels/.rels", RELS)
        z.writestr("word/document.xml", DOC.format(w=W, paras=body))


def read_paras(path):
    import xml.etree.ElementTree as ET
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("word/document.xml"))
    out = []
    for p in root.iter(f"{{{W}}}p"):
        out.append("".join(t.text or "" for t in p.iter(f"{{{W}}}t")))
    return out


def run(src, out, plan):
    plan_path = TMP / "plan.json"
    plan_path.write_text(json.dumps(plan, ensure_ascii=False))
    r = subprocess.run([sys.executable, HELPER, "apply", str(src), str(out), str(plan_path)],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


