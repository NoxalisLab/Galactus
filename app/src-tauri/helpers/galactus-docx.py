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
import difflib
import json
import pathlib
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

# How close a paragraph must be to a sentence the document does not contain
# verbatim before `apply` will let it stand in. Below this, the row is reported
# as not found and nothing is written.
FUZZY_MIN = 0.92

# How much better than its runner-up a near match must be before it counts as
# "the one meant". Inside this margin the row is reported as ambiguous and
# nothing is written.
AMBIGUOUS_BY = 0.02

# How many failing rows, and how many near matches, a batch report names one by
# one. Past this the report gives the count instead: the point of the answer is
# to fit in the caller's window, and a list that does not fit is a list nobody
# reads.
REPORT_CAP = 60


# Every xmlns declaration of a part, so the prefixes can be put back exactly.
NS_DECL = re.compile(rb'xmlns:([A-Za-z0-9_.\-]+)="([^"]+)"')


def register_prefixes(data: bytes) -> dict[str, str]:
    """Teach ElementTree the prefixes this part already uses.

    WHY THIS IS NOT COSMETIC. ElementTree does not keep the prefixes it read:
    it invents ns0, ns1, ns2 for every namespace it did not know. A Word
    document declares a dozen of them (wpc, cx, mc, aink, wps, w14...) and
    refers to those names elsewhere, notably in mc:Ignorable and in the
    AlternateContent blocks around every drawing. Rewriting them all breaks
    those references, and Word answers by declaring the file damaged and
    offering to repair it: "contenu illisible". Measured on a real notice, and
    the reason this function exists at all.
    """
    found: dict[str, str] = {}
    # The WHOLE part, not just its head: Word declares some namespaces deeper
    # in the tree (asvg, on a drawing), and ElementTree hoists those to the
    # root under an invented name unless it has been told the real one.
    for prefix, uri in NS_DECL.findall(data):
        prefix_s, uri_s = prefix.decode(), uri.decode()
        found[prefix_s] = uri_s
        ET.register_namespace(prefix_s, uri_s)
    return found


def parse_part(data: bytes) -> ET.Element:
    if SUSPECT.search(data[:8192]):
        fail("this document declares XML entities, which Word does not do: refusing to expand them")
    register_prefixes(data)
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

    def allowed_indices(self, paras: list, texts: list) -> list:
        """The same choice as `allowed`, on a cached text list."""
        first, last = 0, len(paras)
        if self.start:
            begin = next((i for i, t in enumerate(texts) if self.start in t), None)
            if begin is None:
                return []
            first = begin
            if self.end:
                last = next((i for i in range(begin + 1, len(texts)) if self.end in texts[i]), len(paras))
        if self.paragraph:
            i = self.paragraph - 1
            return [i] if first <= i < last else []
        return list(range(first, last))

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


def replace_whole_paragraph(para: ET.Element, replacement: str) -> int:
    """Put `replacement` in place of EVERYTHING this paragraph says.

    The near-match path needs this and nothing else does. When the table's
    sentence and the document's sentence differ by a comma, there is no
    substring to swap: the only honest operation is "this paragraph now reads
    that". The whole replacement lands in the first run, which is the rule
    replace_in_paragraph already follows, so the paragraph keeps its font, its
    size and its weight; the later runs are emptied rather than removed, so the
    paragraph keeps its shape for Word.
    """
    nodes = text_nodes(para)
    if not nodes:
        return 0
    nodes[0].text = replacement
    preserve_space(nodes[0])
    for node in nodes[1:]:
        node.text = ""
        preserve_space(node)
    return 1


def first_run_props(para: ET.Element) -> ET.Element | None:
    """The run formatting of a paragraph: its font, its size, its colour.

    LOOKED FOR RECURSIVELY, and that is the whole point. A direct-child search
    finds nothing in a document with tracked changes, because Word wraps every
    inserted run in <w:ins>, and it finds nothing inside a hyperlink either. A
    new paragraph then carries no run properties at all and Word draws it in
    the document default: measured on a real notice, Arial everywhere and the
    inserted lines in the theme font, which is exactly the kind of difference
    a reader notices immediately and a test never does.

    Nested paragraphs are skipped for the same reason `text_nodes` skips them:
    a text box has its own formatting and it is not this paragraph's.

    The paragraph mark's own properties are the fallback. Word keeps the
    formatting of an empty paragraph there, so on a paragraph whose runs carry
    nothing it is the only place the font is written down.
    """
    def walk(node: ET.Element):
        for child in node:
            if child.tag == f"{{{W}}}p":
                continue
            if child.tag == f"{{{W}}}r":
                found = child.find(f"{{{W}}}rPr")
                if found is not None:
                    return found
            hit = walk(child)
            if hit is not None:
                return hit
        return None

    found = walk(para)
    if found is None:
        props = para.find(f"{{{W}}}pPr")
        if props is not None:
            found = props.find(f"{{{W}}}rPr")
    return copy.deepcopy(found) if found is not None else None


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
        run_props = first_run_props(template)
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


def root_tag_of(data: bytes) -> bytes:
    """The opening tag of the root ELEMENT, skipping the XML declaration.

    Written out because the obvious one-liner is wrong in a way that hides
    itself: the first '>' in the file closes `<?xml ... ?>`, so a search for it
    returns a declaration that carries no namespace at all, and the restoration
    below silently has nothing to restore.
    """
    i = 0
    while 0 <= i < len(data):
        i = data.find(b"<", i)
        if i < 0:
            return b""
        if data[i + 1 : i + 2] not in (b"?", b"!"):
            end = data.find(b">", i)
            return data[i : end + 1] if end > 0 else b""
        i = data.find(b">", i) + 1
    return b""


def serialise(root: ET.Element, original: bytes = b"") -> bytes:
    """The part, with every namespace declaration the original carried.

    Registering the prefixes is not enough on its own: ElementTree only writes
    a declaration for a namespace it actually used, and a Word document names
    prefixes in places ElementTree cannot see them, above all the mc:Ignorable
    attribute whose VALUE is a list of prefix names. Dropping those turns a
    valid file into one Word offers to repair, so the declarations that went
    missing are put back on the root tag.
    """
    body = ET.tostring(root, encoding="utf-8", xml_declaration=False)
    if original:
        want = NS_DECL.findall(root_tag_of(original))
        end = body.find(b">")
        if end > 0:
            head = body[:end]
            missing = b"".join(
                b' xmlns:%s="%s"' % (p, u) for p, u in want if b"xmlns:%s=" % p not in head
            )
            if missing:
                body = head + missing + body[end:]
    return b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + body


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
            data = z.read(name)
            root = parse_part(data)
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
                edited[name] = serialise(root, data)
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
            data = z.read(name)
            root = parse_part(data)
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
                edited[name] = serialise(root, data)
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
        data = z.read(name)
        root = parse_part(data)
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
        edited = {name: serialise(root, data)}
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


def command_apply(src: str, out: str, plan_path: str) -> None:
    """Apply a whole batch of edits in ONE pass, and report on every row.

    WHY THIS EXISTS, and it is the difference between a usable tool and a
    demonstration. Driving edits one call per row through a model costs a
    prompt round trip each time: on a real job, 93 rows across 15 languages is
    around 1400 operations, which at thirty to sixty seconds a turn is a night
    of work with nothing to show halfway through. The model belongs at the
    start, to read the table and decide WHAT to do; the doing is mechanical and
    belongs here. The same batch runs in under a second.

    The plan is JSON: {"edits": [{"id": ..., "op": "replace"|"insert",
    "find": ..., "replace": ..., "text": ..., "between_start": ...,
    "between_end": ..., "occurrence": N}], "fuzzy": 0.92}. A row that cannot be
    applied stops nothing: it is reported and the rest proceeds, which is what
    makes the answer a worklist rather than a failure.

    The answer names the rows that FAILED and the rows that matched only
    approximately, and counts the rest. Returning all of them was how a
    successful batch of 414 became an unreadable 37 KB; see the comment on the
    payload at the end of this function.

    NOTHING IS WRITTEN IF NOTHING APPLIED, for the same reason a single replace
    writes nothing when it matches nothing: a copy that changed in no way must
    not be mistaken for a finished job.
    """
    try:
        plan = json.loads(pathlib.Path(plan_path).read_text())
    except Exception as exc:  # noqa: BLE001
        fail(f"cannot read the plan: {exc}")
    edits = plan.get("edits") if isinstance(plan, dict) else plan
    if not isinstance(edits, list) or not edits:
        fail("the plan carries no edits")
    # How close a paragraph must be to stand in for a sentence that was not
    # found exactly. `"fuzzy": false` turns the repair off, a number moves the
    # bar; the default is high enough that only a punctuation or a wording
    # detail gets through, and low enough to catch what a translation table
    # actually looks like.
    fuzzy = FUZZY_MIN
    if isinstance(plan, dict) and "fuzzy" in plan:
        raw_fuzzy = plan.get("fuzzy")
        if raw_fuzzy is False:
            fuzzy = 0.0
        elif isinstance(raw_fuzzy, (int, float)) and not isinstance(raw_fuzzy, bool):
            fuzzy = min(1.0, max(0.6, float(raw_fuzzy)))

    z, _ = read_parts(src)
    with z:
        raw = {name: z.read(name) for name in each_text_part(z)}
        parts = {name: parse_part(data) for name, data in raw.items()}

    # The paragraphs and their text, read ONCE.
    #
    # WHY THIS IS NOT A DETAIL. Walking the tree and joining the runs costs the
    # same whether it happens once or four hundred times, and a real batch is
    # four hundred edits over fifteen thousand paragraphs: measured at 115
    # seconds recomputing per edit, against a couple of seconds when the text
    # is read once and refreshed only where something changed. The cache is
    # invalidated per paragraph, not globally, so an edit still sees what the
    # edits before it did.
    index = {name: list(paragraphs(root)) for name, root in parts.items()}
    cache = {name: [joined(text_nodes(p)) for p in paras] for name, paras in index.items()}

    report = []
    touched: set[str] = set()
    for i, e in enumerate(edits):
        if not isinstance(e, dict):
            report.append({"id": i, "status": "refused", "why": "not an object"})
            continue
        ident = e.get("id", i)
        op = str(e.get("op") or "replace")
        needle = str(e.get("find") or "")
        scope = Scope(
            between=(str(e.get("between_start") or ""), str(e.get("between_end") or ""))
            if e.get("between_start")
            else None,
            paragraph=int(e.get("paragraph") or 0),
            occurrence=int(e.get("occurrence") or 0),
        )
        if not needle:
            report.append({"id": ident, "status": "refused", "why": "no text to look for"})
            continue
        done = 0
        where = []
        for name, root in parts.items():
            paras = index[name]
            texts = cache[name]
            allowed = scope.allowed_indices(paras, texts)
            if op == "replace":
                replacement = str(e.get("replace") or "")
                if not replacement:
                    break
                for k in allowed:
                    if needle not in texts[k]:
                        continue
                    n = replace_in_paragraph(paras[k], needle, replacement)
                    if n:
                        done += n
                        where.append(name)
                        texts[k] = joined(text_nodes(paras[k]))
            elif op == "insert":
                text = str(e.get("text") or "")
                if not text:
                    break
                targets = [k for k in allowed if needle in texts[k]]
                if targets:
                    parents = parent_map(root)
                for k in targets:
                    para = paras[k]
                    parent = parents.get(para)
                    if parent is None:
                        continue
                    kids = list(parent)
                    fresh = new_paragraph(para, text)
                    parent.insert(kids.index(para) + 1, fresh)
                    # The new paragraph joins the index right after its
                    # neighbour, so a later edit can find it too.
                    paras.insert(k + 1, fresh)
                    texts.insert(k + 1, text)
                    done += 1
                    where.append(name)
            else:
                report.append({"id": ident, "status": "refused", "why": f"unknown op {op}"})
                break
        else:
            if done:
                touched.update(where)
                report.append({"id": ident, "status": "applied", "count": done,
                               "parts": sorted(set(where))})
                continue
            # NOT FOUND EXACTLY. Before giving up, look at what the document
            # actually says, because the answer is usually one comma away.
            #
            # WHY THIS MATTERS MORE THAN IT SOUNDS. On the run that prompted
            # this, 91 of 414 rows came back "not found" and EVERY ONE of them
            # carried "closest match 95%" with the exact difference spelled
            # out: the tool knew where the sentence was, knew what separated
            # the two, and wrote nothing. A table of translations never quotes
            # its source document to the character; refusing anything short of
            # a byte-perfect match is refusing the normal case.
            #
            # The repair is deliberately narrow. Only `replace`, only above
            # FUZZY_MIN, never when the row asked for a numbered occurrence
            # (whole-paragraph substitution cannot honour "the second match"),
            # and every one of them is named in the report with its score and
            # its difference, so a near match is something the user reviews
            # rather than something that happened to them.
            replacement = str(e.get("replace") or "")
            close: list[tuple[float, str, int, str]] = []
            ambiguous = 0
            if fuzzy and op == "replace" and replacement and not scope.occurrence:
                close = [m for m in near(cache, needle) if m[0] >= fuzzy]
                if close and (scope.start or scope.paragraph):
                    allow = {
                        name: set(scope.allowed_indices(index[name], cache[name]))
                        for name in parts
                    }
                    close = [m for m in close if m[2] in allow.get(m[1], ())]
                # ONE NEAR MATCH, OR NONE. An exact replace may fire everywhere
                # because every hit is the same string; a near match may not,
                # because every candidate is by definition a DIFFERENT sentence.
                # A notice whose boilerplate repeats with a changing reference
                # number produces forty paragraphs above the bar, and applying
                # to all of them would overwrite thirty-nine sentences the row
                # never meant — measured at exactly forty on the fixture that
                # caught this. So when the runner-up is as close as the winner,
                # nothing is written and the row says so: the caller narrows it
                # with between_start, paragraph or occurrence, which is what
                # those arguments are for.
                if len(close) > 1 and close[1][0] >= close[0][0] - AMBIGUOUS_BY:
                    ambiguous = sum(1 for m in close if m[0] >= close[0][0] - AMBIGUOUS_BY)
                    close = []
                else:
                    close = close[:1]
            for _, name, k, _text in close:
                paras, texts = index[name], cache[name]
                if k >= len(paras):
                    continue
                if replace_whole_paragraph(paras[k], replacement):
                    done += 1
                    where.append(name)
                    texts[k] = joined(text_nodes(paras[k]))
            if done:
                touched.update(where)
                report.append({"id": ident, "status": "near match", "count": done,
                               "ratio": round(close[0][0], 3),
                               "why": gap(needle, close[0][3]),
                               "parts": sorted(set(where))})
            elif ambiguous:
                report.append({"id": ident, "status": "ambiguous", "candidates": ambiguous,
                               "why": f"{ambiguous} paragraphs are equally close to this sentence and "
                                      "none is clearly the one meant; narrow the row with "
                                      "between_start, paragraph or occurrence"})
            else:
                # The single most useful thing to say about a row that failed:
                # WHY it failed, in the document's own words. difflib is in the
                # standard library and turns "not found" into "the document
                # says the same sentence with something extra".
                report.append({"id": ident, "status": "not found",
                               "why": nearest_hint(cache, needle)})
            continue
        if not report or report[-1].get("id") != ident:
            report.append({"id": ident, "status": "refused", "why": "missing replacement text"})

    exact = [r for r in report if r["status"] == "applied"]
    fuzzed = [r for r in report if r["status"] == "near match"]
    failed = [r for r in report if r["status"] not in ("applied", "near match")]
    written = bool(exact or fuzzed)
    if written:
        edited = {name: serialise(root, raw[name]) for name, root in parts.items() if name in touched}
        write_docx(src, out, edited)

    # WHAT A BATCH REPORT IS FOR, and the previous answer got it backwards.
    #
    # It used to return a verdict for all 414 rows, successes included: 37 KB
    # of JSON, of which 323 entries said "applied" and nothing else. That
    # overflowed the caller's window, which spilled it to a scratch file,
    # which the model then tried to read back, which overflowed again. The job
    # had SUCCEEDED — 323 rows written to disk — and the user was told nothing
    # at all, because the good news was too long to deliver.
    #
    # So: counts for what worked, detail only for what did not, and for the
    # near matches, which are the rows a human may want to overrule. Both
    # lists are capped, and when a cap bites it says so with the number it
    # dropped, because a silently shortened list reads as a complete one.
    body: dict = {
        "applied": len(exact) + len(fuzzed),
        "exact": len(exact),
        "near_match": len(fuzzed),
        "failed": len(failed),
        "total": len(edits),
        "written": written,
        "out": out if written else "",
    }
    if fuzzed:
        body["near_matches"] = fuzzed[:REPORT_CAP]
        if len(fuzzed) > REPORT_CAP:
            body["near_matches_omitted"] = len(fuzzed) - REPORT_CAP
    if failed:
        body["failures"] = failed[:REPORT_CAP]
        if len(failed) > REPORT_CAP:
            body["failures_omitted"] = len(failed) - REPORT_CAP
    say(body)


def flatten(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def scan_near(cache: dict, needle: str) -> list[tuple[float, str, int, str]]:
    """Every paragraph close to `needle`, best first, WITH WHERE IT IS.

    ONE CHEAP FILTER MAKES THIS AFFORDABLE, and without it a batch spends more
    time on its failures than on its work. Measured on a real notice of fifteen
    thousand paragraphs with four hundred edits: 87 seconds, nearly all of it
    here. The full comparison runs only on the handful of paragraphs that
    survive `quick_ratio`, which bounds the real ratio from above and costs a
    fraction of it.

    The position travels with the ratio because the caller does two different
    things with the answer: explain a failure, or repair it in place.
    """
    flat = flatten(needle)
    shortlist: list[tuple[float, str, int, str]] = []
    for name, texts in cache.items():
        for k, raw in enumerate(texts):
            text = flatten(raw)
            if not text or abs(len(text) - len(flat)) > max(80, len(flat)):
                continue
            m = difflib.SequenceMatcher(None, flat, text)
            if m.quick_ratio() < 0.6:
                continue
            shortlist.append((m.quick_ratio(), name, k, text))
    shortlist.sort(key=lambda row: -row[0])
    scored = [
        (difflib.SequenceMatcher(None, flat, text).ratio(), name, k, text)
        for _, name, k, text in shortlist[:40]
    ]
    scored.sort(key=lambda row: -row[0])
    return scored


_NEAR: dict[str, list[tuple[float, str, int, str]]] = {}


def near(cache: dict, needle: str) -> list[tuple[float, str, int, str]]:
    """`scan_near`, memoised on the sentence and revalidated against the cache.

    A translation matrix asks for the same source sentence once per language:
    fourteen identical scans where one is needed. But the answer carries
    positions, and an earlier edit may have changed the very paragraph it points
    at, so the memo is trusted only while the text it remembered is still there.
    Anything else, and it is computed again rather than applied to a paragraph
    that has moved on.
    """
    remembered = _NEAR.get(needle)
    if remembered is not None:
        for _, name, k, text in remembered:
            texts = cache.get(name)
            if texts is None or k >= len(texts) or flatten(texts[k]) != text:
                remembered = None
                break
    if remembered is None:
        remembered = scan_near(cache, needle)
        _NEAR[needle] = remembered
    return remembered


def nearest_hint(cache: dict, needle: str) -> str:
    """The closest paragraph to a sentence that was not found, and the gap."""
    matches = near(cache, needle)
    if not matches or matches[0][0] < 0.6:
        return "nothing close to it in this document"
    best_ratio, _, _, best = matches[0]
    return f"closest match {best_ratio:.0%}: " + gap(needle, best)


def gap(needle: str, other: str) -> str:
    """What separates two sentences, in words rather than in opcodes."""
    flat = flatten(needle)
    diff = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, flat, other).get_opcodes():
        if tag == "delete":
            diff.append(f"the document lacks {flat[i1:i2][:40]!r}")
        elif tag == "insert":
            diff.append(f"the document adds {other[j1:j2][:40]!r}")
        elif tag == "replace":
            diff.append(f"{flat[i1:i2][:30]!r} is {other[j1:j2][:30]!r} in the document")
    return "; ".join(diff[:3]) or "no visible difference"


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
    elif op == "apply":
        if len(argv) < 5:
            fail("usage: apply <in.docx> <out.docx> <plan.json>")
        command_apply(path, argv[3], argv[4])
    else:
        fail(f"unknown operation: {op}")


if __name__ == "__main__":
    main(sys.argv)
