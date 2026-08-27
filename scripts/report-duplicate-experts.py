#!/usr/bin/env python3
"""Combien de place un modele MoE installe occupe deux fois, et pourquoi.

CE QUE CE SCRIPT MESURE. Un modele MoE installe pour Galactus stocke ses experts
DEUX FOIS : une fois dans le `.gguf`, une fois dans le `.pack` que la couche h4
sert reellement. Au demarrage, llama.cpp lit les premiers, constate que le
graphe ne les demande pas, et les jette :

    W model has unused tensor blk.0.ffn_gate_exps.weight (size = 564019200 bytes) -- ignoring

Mesure : 3,90 Go sur les 4,21 Go du GGUF d'olmoe-1b-7b (92 %), et de l'ordre de
61 Go sur les 65 Go de celui de gpt-oss-120b. C'est du disque, et c'est aussi du
temps de demarrage a froid, puisque `--no-mmap` lit tout.

POURQUOI CE N'EST QU'UN RAPPORT. La premiere version de ce fichier RETIRAIT ces
tenseurs et reecrivait un GGUF sans eux. Le fichier produit etait valide et
llama.cpp l'a refuse :

    E llama_model_load: error loading model: missing tensor 'blk.0.ffn_gate_exps.weight'

Le chargeur exige la liste de tenseurs de l'architecture AVANT que la couche h4
ne substitue les siens ; « unused ... ignoring » decrit ce qui se passe apres un
chargement reussi, pas une permission de les omettre. Recuperer cette place
demande donc une modification du moteur (enregistrer les substituts h4 avant la
validation, ou rendre ces tenseurs optionnels pour cette architecture), pas un
outil de fichier. Le chemin d'ecriture a ete retire plutot que livre : un script
qui produit des modeles incapables de demarrer est un piege.

Il decide par preuve : il lit le journal d'un vrai demarrage et ne compte QUE
les tenseurs que le moteur y a nommes inutilises.

Usage:
  python3 scripts/report-duplicate-experts.py --gguf M.gguf --log llama-server.log
"""
from __future__ import annotations

import argparse
import pathlib
import re
import struct
import sys

MAGIC = b"GGUF"
# Types de valeur GGUF, pour parcourir les métadonnées sans les interpréter.
_FIXED = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}
_STRING, _ARRAY = 8, 9


class Reader:
    def __init__(self, data: bytes):
        self.d = data
        self.i = 0

    def take(self, n: int) -> bytes:
        if self.i + n > len(self.d):
            raise ValueError("fichier tronqué")
        out = self.d[self.i : self.i + n]
        self.i += n
        return out

    def u32(self) -> int:
        return struct.unpack("<I", self.take(4))[0]

    def u64(self) -> int:
        return struct.unpack("<Q", self.take(8))[0]

    def string(self) -> str:
        return self.take(self.u64()).decode("utf-8", "replace")

    def skip_value(self, vtype: int) -> None:
        if vtype in _FIXED:
            self.take(_FIXED[vtype])
        elif vtype == _STRING:
            self.take(self.u64())
        elif vtype == _ARRAY:
            inner = self.u32()
            count = self.u64()
            for _ in range(count):
                self.skip_value(inner)
        else:
            raise ValueError(f"type de métadonnée inconnu: {vtype}")


def unused_from_log(path: pathlib.Path) -> set[str]:
    """Les tenseurs que le moteur a lui-même déclarés inutilisés."""
    pat = re.compile(r"model has unused tensor (\S+)")
    names = set()
    for line in path.read_text(errors="ignore").splitlines():
        m = pat.search(line)
        if m:
            names.add(m.group(1))
    return names


def parse(data: bytes):
    """(alignment, fin de la section métadonnées, [(nom, dims, type, offset)])."""
    r = Reader(data)
    if r.take(4) != MAGIC:
        raise ValueError("ce n'est pas un GGUF")
    version = r.u32()
    if version != 3:
        raise ValueError(f"version GGUF {version} non gérée par cet outil (attendu 3)")
    n_tensors = r.u64()
    n_kv = r.u64()

    alignment = 32
    for _ in range(n_kv):
        key = r.string()
        vtype = r.u32()
        if key == "general.alignment" and vtype in (4, 5, 10, 11):
            raw = r.d[r.i : r.i + _FIXED[vtype]]
            alignment = int.from_bytes(raw, "little")
            r.take(_FIXED[vtype])
        else:
            r.skip_value(vtype)
    kv_end = r.i

    tensors = []
    for _ in range(n_tensors):
        name = r.string()
        dims = [r.u64() for _ in range(r.u32())]
        ttype = r.u32()
        offset = r.u64()
        tensors.append((name, dims, ttype, offset))
    return alignment, kv_end, r.i, tensors


def tensor_info_bytes(name: str, dims: list[int], ttype: int, offset: int) -> bytes:
    raw = name.encode("utf-8")
    out = struct.pack("<Q", len(raw)) + raw + struct.pack("<I", len(dims))
    for d in dims:
        out += struct.pack("<Q", d)
    return out + struct.pack("<I", ttype) + struct.pack("<Q", offset)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gguf", required=True)
    ap.add_argument("--log", required=True, help="journal d'un démarrage réel de ce modèle")
    a = ap.parse_args()

    src = pathlib.Path(a.gguf)
    data = src.read_bytes()
    alignment, _kv_end, infos_end, tensors = parse(data)

    # Début des données: fin des descripteurs, aligné.
    data_start = (infos_end + alignment - 1) // alignment * alignment

    # Taille d'un bloc = distance jusqu'au suivant, dans l'ordre du fichier.
    ordered = sorted(range(len(tensors)), key=lambda k: tensors[k][3])
    sizes = {}
    for pos, k in enumerate(ordered):
        start = tensors[k][3]
        end = tensors[ordered[pos + 1]][3] if pos + 1 < len(ordered) else len(data) - data_start
        sizes[k] = end - start

    drop = unused_from_log(pathlib.Path(a.log))
    if not drop:
        print("le journal ne nomme aucun tenseur inutilisé; rien à faire", file=sys.stderr)
        return 1
    known = {t[0] for t in tensors}
    missing = drop - known
    if missing:
        print(
            f"ce journal parle d'un autre modèle: {len(missing)} tenseur(s) absent(s) "
            f"de ce GGUF, par exemple {sorted(missing)[0]}",
            file=sys.stderr,
        )
        return 1

    freed = sum(sizes[k] for k in range(len(tensors)) if tensors[k][0] in drop)
    print(f"{len(tensors)} tenseurs, dont {len(drop)} charges puis ignores")
    print(f"{len(data) / 1e9:.2f} Go au total, dont {freed / 1e9:.2f} Go en double "
          f"({freed * 100 // len(data)} %); le pack sert les memes experts")
    print()
    print("Cette place n'est PAS recuperable par un outil de fichier: le chargeur de")
    print("llama.cpp exige ces tenseurs avant que la couche h4 ne substitue les siens.")
    print("Voir l'en-tete de ce script pour l'erreur exacte et ce qu'il faudrait changer.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
