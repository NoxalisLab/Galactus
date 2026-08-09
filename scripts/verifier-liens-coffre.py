#!/usr/bin/env python3
"""Verificateur de liens du coffre par defaut.

Reproduit exactement la resolution de `obsidian_graph` (app/src-tauri/src/lib.rs) :
  - une note est indexee par le nom de fichier sans extension, en minuscules ;
  - un lien [[a/b|alias#ancre]] est resolu sur le dernier segment de chemin,
    apres retrait de l'alias et de l'ancre ;
  - un lien vers une note inexistante ne produit aucune arete.

Rapporte : liens non resolus, notes orphelines (degre 0 dans le graphe non
oriente) et notes sans lien entrant. Sortie non nulle si un defaut est trouve.

Usage : python3 scripts/verifier-liens-coffre.py [chemin_du_coffre]
"""
from __future__ import annotations

import os
import re
import sys

LINK_RE = re.compile(r"\[\[([^\]\[]+)\]\]")


def collect(root: str) -> list[str]:
    out: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in filenames:
            if name.endswith(".md") and not name.startswith("."):
                out.append(os.path.join(dirpath, name))
    return sorted(out)


def main() -> int:
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(repo_root, "vault")
    files = collect(root)
    if not files:
        print(f"aucune note trouvee dans {root}")
        return 1

    index: dict[str, str] = {}
    duplicates: list[str] = []
    for path in files:
        stem = os.path.splitext(os.path.basename(path))[0]
        key = stem.lower()
        if key in index:
            duplicates.append(os.path.relpath(path, root))
            continue
        index[key] = os.path.relpath(path, root)

    unresolved: list[tuple[str, str]] = []
    edges: set[tuple[str, str]] = set()
    outgoing: dict[str, int] = {rel: 0 for rel in index.values()}
    incoming: dict[str, int] = {rel: 0 for rel in index.values()}
    total_links = 0

    for path in files:
        rel = os.path.relpath(path, root)
        src = index.get(os.path.splitext(os.path.basename(path))[0].lower())
        if src is None or src != rel:
            continue
        text = open(path, encoding="utf-8").read()
        for raw in LINK_RE.findall(text):
            target = re.split(r"[|#]", raw)[0].strip()
            if not target:
                continue
            total_links += 1
            leaf = target.rsplit("/", 1)[-1].lower()
            dst = index.get(leaf)
            if dst is None:
                unresolved.append((rel, target))
                continue
            if dst == src:
                continue
            outgoing[src] += 1
            incoming[dst] += 1
            edges.add((min(src, dst), max(src, dst)))

    orphans = [rel for rel in index.values() if outgoing[rel] == 0 and incoming[rel] == 0]
    no_inbound = [rel for rel in index.values() if incoming[rel] == 0]

    total_bytes = sum(os.path.getsize(p) for p in files)
    print(f"notes                : {len(index)}")
    print(f"octets               : {total_bytes} ({total_bytes / 1024:.1f} Kio)")
    print(f"tokens approx (/3.6) : {round(total_bytes / 3.6)}")
    print(f"wikilinks            : {total_links}")
    print(f"aretes uniques       : {len(edges)}")
    print(f"degre moyen          : {2 * len(edges) / len(index):.1f}")
    print(f"liens non resolus    : {len(unresolved)}")
    print(f"notes orphelines     : {len(orphans)}")
    print(f"notes sans entrant   : {len(no_inbound)}")
    print(f"noms dupliques       : {len(duplicates)}")

    failed = False
    for rel, target in unresolved:
        print(f"  NON RESOLU  {rel} -> [[{target}]]")
        failed = True
    for rel in orphans:
        print(f"  ORPHELINE   {rel}")
        failed = True
    for rel in no_inbound:
        print(f"  SANS ENTRANT {rel}")
        failed = True
    for rel in duplicates:
        print(f"  DUPLIQUE    {rel}")
        failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
