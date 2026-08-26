#!/usr/bin/env python3
"""galactus-sheet - reading a spreadsheet as an actual table.

WHY THIS REPLACED WHAT WAS HERE. An .xlsx is a zip of XML, and the previous
reader stripped the tags and printed what was left. For a Word document that
is nearly enough; for a spreadsheet it is useless, and measurably so: the
values live in word/sharedStrings.xml while the sheet holds only INDEXES into
that list, so the model received a list of words followed by a grid of
numbers, and had to do the join itself. On a table of two hundred rows driving
two hundred edits, one wrong join is one wrong contract.

This resolves what a spreadsheet actually contains: shared strings, inline
strings, cached formula results, booleans, and dates, which are stored as a
number and are only dates because of a format written somewhere else entirely.
Empty cells keep their column, because a table read with the columns shifted
is worse than no table at all.

NO THIRD PARTY CODE. zipfile and ElementTree, from the standard library.
openpyxl would be a dependency, a NOTICE entry and a licence review for
something that is two hundred lines here.

  galactus-sheet <file.xlsx> [max_rows]

Output is CSV, one block per sheet, with the Excel row number as the first
column so a caller can say "row 12" and mean what the user sees in Excel.
"""
from __future__ import annotations

import csv
import datetime as dt
import io
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
DOC_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

# See galactus-docx.py: Word and Excel never write a DOCTYPE, and expanding
# entities is how a small file becomes a memory bomb.
SUSPECT = re.compile(rb"<!DOCTYPE|<!ENTITY", re.I)

DEFAULT_MAX_ROWS = 5000


def fail(message: str) -> None:
    sys.stderr.write("galactus-sheet: " + message + "\n")
    raise SystemExit(2)


def parse(data: bytes) -> ET.Element:
    if SUSPECT.search(data[:8192]):
        fail("this workbook declares XML entities, which Excel does not do: refusing to expand them")
    return ET.fromstring(data)


def column_of(ref: str) -> str:
    """"BC12" -> "BC". The column is what keeps an empty cell in its place."""
    letters = []
    for ch in ref:
        if ch.isalpha():
            letters.append(ch.upper())
        else:
            break
    return "".join(letters)


def column_index(letters: str) -> int:
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n


def index_to_column(n: int) -> str:
    out = ""
    while n > 0:
        n, rest = divmod(n - 1, 26)
        out = chr(65 + rest) + out
    return out


# Excel's built-in number formats that mean a date or a time. A cell holding
# 45000 is a number until one of these says otherwise, and printing 45000 where
# the user sees 2023-03-15 is exactly the kind of silent wrongness this file
# exists to remove.
BUILTIN_DATE_FORMATS = set(range(14, 23)) | set(range(45, 48))
DATE_HINT = re.compile(r"(?<!\\)[ymdhs]", re.I)


def date_format_ids(z: zipfile.ZipFile) -> set[int]:
    """The style indexes whose format is a date or a time."""
    if "xl/styles.xml" not in z.namelist():
        return set()
    root = parse(z.read("xl/styles.xml"))
    custom_dates = set()
    for fmt in root.iter(f"{{{MAIN}}}numFmt"):
        code = fmt.get("formatCode") or ""
        fid = fmt.get("numFmtId")
        # A custom format is a date when it mentions a date field outside of
        # any literal text. The escape check keeps "\\d" (a literal d) out.
        if fid and DATE_HINT.search(re.sub(r'"[^"]*"', "", code)):
            custom_dates.add(int(fid))
    styles = set()
    xfs = root.find(f"{{{MAIN}}}cellXfs")
    if xfs is None:
        return styles
    for i, xf in enumerate(xfs.findall(f"{{{MAIN}}}xf")):
        fid = int(xf.get("numFmtId") or 0)
        if fid in BUILTIN_DATE_FORMATS or fid in custom_dates:
            styles.add(i)
    return styles


def serial_to_text(value: float) -> str:
    """Excel's day count to something a human and a model both read.

    Excel's epoch is 1899-12-30 rather than 12-31 because it keeps a leap day
    that never existed, for compatibility with a spreadsheet from 1983.
    """
    try:
        base = dt.datetime(1899, 12, 30)
        moment = base + dt.timedelta(days=float(value))
    except (OverflowError, ValueError):
        return str(value)
    if abs(float(value) - int(float(value))) < 1e-9:
        return moment.strftime("%Y-%m-%d")
    return moment.strftime("%Y-%m-%d %H:%M")


def shared_strings(z: zipfile.ZipFile) -> list[str]:
    name = "xl/sharedStrings.xml"
    if name not in z.namelist():
        return []
    root = parse(z.read(name))
    out = []
    for si in root.findall(f"{{{MAIN}}}si"):
        # A single string can be split into several <t> by formatting, exactly
        # as a Word run is: joined, or half the cell goes missing.
        out.append("".join(t.text or "" for t in si.iter(f"{{{MAIN}}}t")))
    return out


def sheet_parts(z: zipfile.ZipFile) -> list[tuple[str, str]]:
    """(sheet name, part path), in the order the tabs appear."""
    names = z.namelist()
    if "xl/workbook.xml" not in names:
        fail("this file has no xl/workbook.xml: it is not a .xlsx")
    book = parse(z.read("xl/workbook.xml"))
    rels: dict[str, str] = {}
    rel_part = "xl/_rels/workbook.xml.rels"
    if rel_part in names:
        for rel in parse(z.read(rel_part)).findall(f"{{{PKG_REL}}}Relationship"):
            rid, target = rel.get("Id"), rel.get("Target") or ""
            if rid:
                rels[rid] = target if target.startswith("xl/") else "xl/" + target.lstrip("/")
    out = []
    for sheet in book.iter(f"{{{MAIN}}}sheet"):
        title = sheet.get("name") or "sheet"
        rid = sheet.get(f"{{{DOC_REL}}}id")
        part = rels.get(rid or "", "")
        if part and part in names:
            out.append((title, part))
    if not out:
        # A workbook whose relationships are unusual: fall back to whatever
        # worksheets are on disk rather than reporting an empty file.
        for name in names:
            if name.startswith("xl/worksheets/sheet") and name.endswith(".xml"):
                out.append((name.rsplit("/", 1)[-1][:-4], name))
    return out


def cell_text(cell: ET.Element, strings: list[str], date_styles: set[int]) -> str:
    kind = cell.get("t") or "n"
    if kind == "inlineStr":
        return "".join(t.text or "" for t in cell.iter(f"{{{MAIN}}}t"))
    value = cell.find(f"{{{MAIN}}}v")
    raw = value.text if value is not None else None
    if raw is None:
        return ""
    if kind == "s":
        try:
            return strings[int(raw)]
        except (ValueError, IndexError):
            return ""
    if kind == "b":
        return "TRUE" if raw not in ("0", "", None) else "FALSE"
    if kind in ("str", "e"):
        # A formula's cached result, or an error like #DIV/0!. Both are what
        # the user sees in the cell, which is what a caller has to act on.
        return raw
    style = cell.get("s")
    if style is not None and style.isdigit() and int(style) in date_styles:
        return serial_to_text(raw)
    return raw


def read_sheet(z: zipfile.ZipFile, part: str, strings: list[str], date_styles: set[int], max_rows: int):
    root = parse(z.read(part))
    rows: list[tuple[int, dict[str, str]]] = []
    widest = 0
    truncated = False
    for row in root.iter(f"{{{MAIN}}}row"):
        if len(rows) >= max_rows:
            truncated = True
            break
        number = int(row.get("r") or len(rows) + 1)
        cells: dict[str, str] = {}
        for cell in row.findall(f"{{{MAIN}}}c"):
            ref = cell.get("r") or ""
            col = column_of(ref)
            if not col:
                continue
            text = cell_text(cell, strings, date_styles)
            if text != "":
                cells[col] = text
                widest = max(widest, column_index(col))
        if cells:
            rows.append((number, cells))
    return rows, widest, truncated


def main(argv: list[str]) -> None:
    if len(argv) < 2:
        fail("usage: galactus-sheet <file.xlsx> [max_rows]")
    path = argv[1]
    max_rows = int(argv[2]) if len(argv) > 2 and argv[2].isdigit() else DEFAULT_MAX_ROWS
    try:
        z = zipfile.ZipFile(path)
    except Exception as exc:  # noqa: BLE001
        fail(f"not a readable workbook: {exc}")
    with z:
        strings = shared_strings(z)
        date_styles = date_format_ids(z)
        blocks = []
        for title, part in sheet_parts(z):
            rows, widest, truncated = read_sheet(z, part, strings, date_styles, max_rows)
            if not rows:
                blocks.append(f"--- sheet: {title} (empty) ---")
                continue
            columns = [index_to_column(i) for i in range(1, widest + 1)]
            buffer = io.StringIO()
            writer = csv.writer(buffer, lineterminator="\n")
            writer.writerow(["row"] + columns)
            for number, cells in rows:
                writer.writerow([number] + [cells.get(c, "") for c in columns])
            head = f"--- sheet: {title} ({len(rows)} rows, columns {columns[0]}-{columns[-1]}) ---"
            if truncated:
                head += f"\n--- WARNING: stopped at {max_rows} rows, this sheet has more ---"
            blocks.append(head + "\n" + buffer.getvalue().rstrip("\n"))
    print("\n\n".join(blocks))


if __name__ == "__main__":
    main(sys.argv)
