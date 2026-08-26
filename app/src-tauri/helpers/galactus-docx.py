#!/usr/bin/env python3
"""galactus-docx - editing Word documents without a single dependency.

WHY THIS EXISTS NEXT TO galactus-doc.swift. A PDF has no paragraphs, only
glyphs at coordinates, so editing one means covering what was there and
drawing over it, and the page that changed has to be flattened for the old
words to really be gone. A .docx has none of those problems: it is a zip of
XML, the text is text, and a replacement keeps the style, the page layout,
the images, the headers and the tables exactly as they were. When the source
document exists, this is always the better road.

NO THIRD PARTY CODE. zipfile and ElementTree are in the standard library and
handle everything here: deflate, the OPC container, namespaces. python-docx
would add a dependency, a NOTICE entry and a licence review to do the same
thing less transparently.

THE ONE HARD PART: RUNS. Word splits a sentence across as many <w:t> elements
as it has formatting changes, spellcheck marks or edit history, so the
sentence you can see is very often not a single string in the file. Every
operation here therefore works on the JOINED text of a paragraph and maps the
offsets back onto the runs it came from. A tool that searched run by run
would silently fail on any sentence that happens to be bold in the middle,
which is most of the interesting ones.

  galactus-docx find <file.docx> <needle> [scope]
  galactus-docx replace <in.docx> <out.docx> <needle> <replacement> [scope]
  galactus-docx insert <in.docx> <out.docx> <after-needle> <text>
  galactus-docx append <in.docx> <out.docx> <text>

where [scope] narrows what is looked at, and is any of:

  --between START END   only the paragraphs from the one holding START to the
                        one holding END, which is how a section of a contract
                        is addressed ("Article 4" to "Article 5"). END may be
                        empty, meaning "to the end".
  --paragraph N         only paragraph N, numbered as `find` numbers them.
  --occurrence N        only the Nth match, counted in reading order.

THERE IS NO PAGE OPTION, and there cannot be one. A .docx does not contain
pages: Word computes them when it lays the document out, from the page size,
the fonts, the images and even the printer driver, so the same file paginates
differently on two machines. Nothing in the XML says "page 3". What a document
does contain is headings, sections, paragraphs and explicit page breaks, and
`find` reports how many of those breaks exist so a caller can tell whether the
author paginated by hand at all.

Answers are one line of JSON on stdout, errors one line on stderr with exit 2.
"""
from __future__ import annotations

import copy
import json
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
XML_NS = "http://www.w3.org/XML/1998/namespace"
ET.register_namespace("w", W)


# Word never writes a DOCTYPE into an OOXML part, so one appearing here is
# either a broken file or a deliberate XML bomb: ElementTree expands internal
# entities, and a few kilobytes of nested definitions become gigabytes in this
# process. Refused before parsing rather than mitigated afterwards, which also
# keeps the standard library as the only dependency.
SUSPECT = re.compile(rb"<!DOCTYPE|<!ENTITY", re.I)


def parse_part(data: bytes) -> ET.Element:
    if SUSPECT.search(data[:8192]):
        fail("this document declares XML entities, which Word does not do: refusing to expand them")
    return ET.fromstring(data)


def fail(message: str) -> None:
    sys.stderr.write("galactus-docx: " + message + "\n")
    raise SystemExit(2)


def say(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False))


# The parts that can hold visible text. Headers and footers matter: a footer
# carrying a date or a client name is exactly the kind of thing a table drives,
# and a tool that only looked at word/document.xml would report zero matches
# for a sentence the user can see on every page.
TEXT_PARTS = re.compile(
    r"^word/(document\d*\.xml|header\d*\.xml|footer\d*\.xml|footnotes\.xml|endnotes\.xml)$"
)


def paragraphs(root: ET.Element) -> list[ET.Element]:
    return root.iter(f"{{{W}}}p")  # type: ignore[return-value]


def text_nodes(para: ET.Element) -> list[ET.Element]:
    """Every <w:t> this paragraph OWNS, in reading order.

    Deleted text (<w:delText>, tracked changes) is deliberately NOT included:
    it is not on the page, and replacing inside it would resurrect it.

    NESTED PARAGRAPHS ARE NOT OURS, and that exception is load bearing. A text
    box lives inside a run of an outer paragraph, so a plain recursive walk
    reads the box's text twice: once as the box's own paragraph and once as
    part of the paragraph wrapping it. Measured on a document holding a body
    line, a table cell and a text box: `find` reported seven occurrences where
    `replace` changed six, which on a dry run is the difference between "three
    occurrences, is that what you want" and the truth. Worse, joining the two
    would let a match span the boundary between a sentence and a caption that
    merely sit next to each other in the file.
    """
    out: list[ET.Element] = []

    def walk(node: ET.Element) -> None:
        for child in node:
            if child.tag == f"{{{W}}}p":
                continue  # a nested paragraph is visited on its own turn
            if child.tag == f"{{{W}}}t":
                out.append(child)
            else:
                walk(child)

    walk(para)
    return out


def joined(nodes: list[ET.Element]) -> str:
    return "".join(n.text or "" for n in nodes)


def preserve_space(node: ET.Element) -> None:
    # Without this, Word trims leading and trailing spaces of a run, and a
    # replacement that starts or ends with one silently loses it.
    node.set(f"{{{XML_NS}}}space", "preserve")


class Scope:
    """Which paragraphs an operation is allowed to touch.

    Empty means the whole document, which is the default and what a caller
    gets by asking for nothing. Everything else exists because a table driving
    edits needs to say WHERE, and the only honest coordinates in a Word file
    are its own: a heading, a paragraph number, or the rank of a match.
    """

    def __init__(self, between=None, paragraph=0, occurrence=0):
        self.start, self.end = between if between else (None, None)
        self.paragraph = paragraph
        self.occurrence = occurrence

    def allowed(self, paras: list[ET.Element]) -> list[ET.Element]:
        chosen = paras
        if self.start:
            begin = None
            for i, para in enumerate(paras):
                if self.start in joined(text_nodes(para)):
                    begin = i
                    break
            if begin is None:
                return []
            stop = len(paras)
            if self.end:
                for i in range(begin + 1, len(paras)):
                    if self.end in joined(text_nodes(paras[i])):
                        stop = i
                        break
            chosen = paras[begin:stop]
        if self.paragraph:
            # Numbered as `find` numbers them, so a dry run and the edit that
            # follows it speak about the same paragraph.
            index = self.paragraph - 1
            chosen = [paras[index]] if 0 <= index < len(paras) and paras[index] in chosen else []
        return chosen


def count_page_breaks(root: ET.Element) -> int:
    """Explicit page breaks, the only pagination a .docx really carries."""
    return sum(
        1
        for br in root.iter(f"{{{W}}}br")
        if (br.get(f"{{{W}}}type") or "") == "page"
    )


def replace_in_paragraph(para: ET.Element, needle: str, replacement: str) -> int:
    """Replace every occurrence inside one paragraph. Returns how many."""
    nodes = text_nodes(para)
    if not nodes:
        return 0
    whole = joined(nodes)
    if needle not in whole:
        return 0

    # Offsets of each node in the joined string, so a match can be mapped back
    # onto the runs it spans.
    spans = []
    at = 0
    for n in nodes:
        length = len(n.text or "")
        spans.append((at, at + length, n))
        at += length

    count = 0
    # Right to left: an edit shifts every offset after it, and going backwards
    # means the offsets still to be used are the ones not yet touched.
    for match in reversed(list(re.finditer(re.escape(needle), whole))):
        start, end = match.span()
        count += 1
        first = True
        for begin, stop, node in spans:
            if stop <= start or begin >= end:
                continue  # this run is entirely outside the match
            text = node.text or ""
            head = text[: max(0, start - begin)]
            tail = text[max(0, end - begin):] if end - begin < len(text) else ""
            if first:
                # The whole replacement lands in the first run the match
                # touches, so it inherits that run's formatting: the bold of a
                # bold sentence, the size of a heading.
                node.text = head + replacement + tail
                preserve_space(node)
                first = False
            else:
                node.text = head + tail
                preserve_space(node)
    return count


def replace_nth_in_paragraph(para: ET.Element, needle: str, replacement: str, nth: int) -> int:
    """Replace only the `nth` occurrence (1 based) inside this paragraph."""
    nodes = text_nodes(para)
    whole = joined(nodes)
    hits = list(re.finditer(re.escape(needle), whole))
    if nth < 1 or nth > len(hits):
        return 0
    start, end = hits[nth - 1].span()
    spans = []
    at = 0
    for n in nodes:
        length = len(n.text or "")
        spans.append((at, at + length, n))
        at += length
    first = True
    for begin, stop, node in spans:
        if stop <= start or begin >= end:
            continue
        text = node.text or ""
        head = text[: max(0, start - begin)]
        tail = text[max(0, end - begin):] if end - begin < len(text) else ""
        node.text = head + (replacement if first else "") + tail
        preserve_space(node)
        first = False
    return 1


def new_paragraph(template: ET.Element | None, text: str) -> ET.Element:
    """A paragraph carrying `text`, styled like `template` when there is one.

    Copying the neighbour's paragraph properties rather than writing a bare
    <w:p> is what keeps an inserted sentence looking like the ones around it
    instead of reverting to the document's default style.
    """
    para = ET.Element(f"{{{W}}}p")
    run_props = None
    if template is not None:
        props = template.find(f"{{{W}}}pPr")
        if props is not None:
            para.append(copy.deepcopy(props))
        run = template.find(f"{{{W}}}r")
        if run is not None:
            found = run.find(f"{{{W}}}rPr")
            if found is not None:
                run_props = copy.deepcopy(found)
    run = ET.SubElement(para, f"{{{W}}}r")
    if run_props is not None:
        run.append(run_props)
    node = ET.SubElement(run, f"{{{W}}}t")
    node.text = text
    preserve_space(node)
    return para


def parent_map(root: ET.Element) -> dict[ET.Element, ET.Element]:
    return {child: parent for parent in root.iter() for child in parent}


def read_parts(path: str) -> tuple[zipfile.ZipFile, list[zipfile.ZipInfo]]:
    try:
        z = zipfile.ZipFile(path)
    except Exception as exc:  # noqa: BLE001 - the message is the point
        fail(f"not a readable .docx: {exc}")
    return z, z.infolist()


def write_docx(src: str, out: str, edited: dict[str, bytes]) -> None:
    """Copy the container, swapping in the parts that changed.

    Every other entry is copied byte for byte, in its original order, with its
    original compression and timestamp: images, styles, numbering and fonts
    come out of this identical to how they went in.
    """
    z, items = read_parts(src)
    with z, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dst:
        for item in items:
            data = edited.get(item.filename)
            if data is None:
                data = z.read(item.filename)
            info = zipfile.ZipInfo(item.filename, date_time=item.date_time)
            info.compress_type = item.compress_type
            info.external_attr = item.external_attr
            dst.writestr(info, data)


def serialise(root: ET.Element) -> bytes:
    return b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + ET.tostring(
        root, encoding="utf-8", xml_declaration=False
    )


def each_text_part(z: zipfile.ZipFile):
    for name in z.namelist():
        if TEXT_PARTS.match(name):
            yield name


def command_find(path: str, needle: str, scope: Scope) -> None:
    if not needle:
        fail("find needs the text to look for")
    z, _ = read_parts(path)
    matches = []
    breaks = 0
    with z:
        for name in each_text_part(z):
            root = parse_part(z.read(name))
            if name == "word/document.xml":
                breaks = count_page_breaks(root)
            paras = list(paragraphs(root))
            allowed = scope.allowed(paras)
            for index, para in enumerate(paras):
                if para not in allowed:
                    continue
                whole = joined(text_nodes(para))
                if needle in whole:
                    matches.append(
                        {
                            "part": name,
                            "paragraph": index + 1,
                            "count": whole.count(needle),
                            "context": whole[:300],
                        }
                    )
    total = sum(m["count"] for m in matches)
    # The page break count is reported on every search, not because it is
    # asked for, but because a caller trying to address "page 3" needs to be
    # told, once, that the document has no pages to address.
    say({"matches": matches, "total": total, "explicit_page_breaks": breaks})


def command_replace(src: str, out: str, needle: str, replacement: str, scope: Scope) -> None:
    if not needle:
        fail("replace needs the sentence to look for")
    z, _ = read_parts(src)
    edited: dict[str, bytes] = {}
    total = 0
    seen = 0  # matches walked past, for --occurrence
    with z:
        for name in each_text_part(z):
            root = parse_part(z.read(name))
            allowed = scope.allowed(list(paragraphs(root)))
            count = 0
            for para in allowed:
                if scope.occurrence:
                    # One match, chosen by its rank in reading order. Counted
                    # BEFORE editing, so the rank a dry run showed is the rank
                    # this acts on.
                    here = joined(text_nodes(para)).count(needle)
                    if here == 0:
                        continue
                    if seen + here < scope.occurrence:
                        seen += here
                        continue
                    nth_in_para = scope.occurrence - seen
                    count += replace_nth_in_paragraph(para, needle, replacement, nth_in_para)
                    seen += here
                    if count:
                        break
                else:
                    count += replace_in_paragraph(para, needle, replacement)
            if count:
                edited[name] = serialise(root)
                total += count
            if scope.occurrence and total:
                break
    if total == 0:
        # No file is written: an untouched copy would be indistinguishable from
        # a successful edit, and that is exactly how a caller reports "done"
        # for a document nobody changed.
        say({"replaced": 0, "parts": []})
        return
    write_docx(src, out, edited)
    say({"replaced": total, "parts": sorted(edited)})


def command_insert(src: str, out: str, after: str, text: str) -> None:
    if not after:
        fail("insert needs the sentence to insert after")
    if not text:
        fail("insert needs the text to add")
    z, _ = read_parts(src)
    edited: dict[str, bytes] = {}
    added = 0
    with z:
        for name in each_text_part(z):
            root = parse_part(z.read(name))
            parents = parent_map(root)
            targets = [p for p in paragraphs(root) if after in joined(text_nodes(p))]
            for para in targets:
                parent = parents.get(para)
                if parent is None:
                    continue
                kids = list(parent)
                parent.insert(kids.index(para) + 1, new_paragraph(para, text))
                added += 1
            if targets:
                edited[name] = serialise(root)
    if added == 0:
        say({"inserted": 0, "parts": []})
        return
    write_docx(src, out, edited)
    say({"inserted": added, "parts": sorted(edited)})


def command_append(src: str, out: str, text: str) -> None:
    if not text:
        fail("append needs the text to add")
    z, _ = read_parts(src)
    name = "word/document.xml"
    with z:
        if name not in z.namelist():
            fail("this .docx has no word/document.xml")
        root = parse_part(z.read(name))
        body = root.find(f"{{{W}}}body")
        if body is None:
            fail("this .docx has no body")
        existing = list(body.iter(f"{{{W}}}p"))
        template = existing[-1] if existing else None
        # sectPr, when present, is the last child of the body and describes the
        # page setup: a paragraph appended after it lands outside the section
        # and Word repairs the file on open. Inserted before it instead.
        section = body.find(f"{{{W}}}sectPr")
        paragraph = new_paragraph(template, text)
        if section is not None:
            body.insert(list(body).index(section), paragraph)
        else:
            body.append(paragraph)
        edited = {name: serialise(root)}
    write_docx(src, out, edited)
    say({"appended": 1})


def take_scope(argv: list[str]) -> tuple[list[str], Scope]:
    """Pull the scope flags out of the argument list, leaving the rest."""
    rest: list[str] = []
    between = None
    paragraph = 0
    occurrence = 0
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--between":
            if i + 2 >= len(argv):
                fail("--between takes a start and an end (the end may be empty)")
            between = (argv[i + 1], argv[i + 2])
            i += 3
            continue
        if arg == "--paragraph":
            if i + 1 >= len(argv) or not argv[i + 1].isdigit():
                fail("--paragraph takes a number")
            paragraph = int(argv[i + 1])
            i += 2
            continue
        if arg == "--occurrence":
            if i + 1 >= len(argv) or not argv[i + 1].isdigit():
                fail("--occurrence takes a number")
            occurrence = int(argv[i + 1])
            i += 2
            continue
        if arg == "--page" or arg.startswith("--page="):
            fail(
                "a .docx has no pages to address: Word computes them when it lays the "
                "document out. Use --between with two headings, --paragraph, or --occurrence"
            )
        rest.append(arg)
        i += 1
    return rest, Scope(between, paragraph, occurrence)


def main(raw: list[str]) -> None:
    argv, scope = take_scope(raw)
    if len(argv) < 3:
        fail("usage: galactus-docx <find|replace|insert|append> <file.docx> ...")
    op, path = argv[1], argv[2]
    if op == "find":
        if len(argv) < 4:
            fail("usage: find <file.docx> <needle>")
        command_find(path, argv[3], scope)
    elif op == "replace":
        if len(argv) < 6:
            fail("usage: replace <in.docx> <out.docx> <needle> <replacement>")
        command_replace(path, argv[3], argv[4], argv[5], scope)
    elif op == "insert":
        if len(argv) < 6:
            fail("usage: insert <in.docx> <out.docx> <after-needle> <text>")
        command_insert(path, argv[3], argv[4], argv[5])
    elif op == "append":
        if len(argv) < 5:
            fail("usage: append <in.docx> <out.docx> <text>")
        command_append(path, argv[3], argv[4])
    else:
        fail(f"unknown operation: {op}")


if __name__ == "__main__":
    main(sys.argv)
