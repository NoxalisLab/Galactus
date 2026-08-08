#!/usr/bin/env python3
"""Exact Python analysis for the Galactus Code view, for zero added bytes.

The app already bundles a private CPython 3.12 (Resources/python/bin/python3).
That interpreter knows Python's grammar exactly, because it IS Python: asking
it to parse the editor buffer beats any scanner, any regex and any third party
grammar we could ship. This script is the whole of that idea.

It reads the EDITOR BUFFER on stdin (never the file on disk, which may be
older than what the user is looking at) and prints one JSON object on stdout:

  * `error`   the exact SyntaxError, with lineno, offset, end position, the
              offending source line and CPython's own message. `compile(...,
              ast.PyCF_ONLY_AST)` is used, so nothing is executed: the source
              is parsed, never imported, never run.
  * `symbols` an exact outline from the `ast` module: imports, classes,
              functions, methods, module-level bindings, with real nesting.
  * `scopes`  what `symtable` knows: the scope tree, parameters, globals,
              nested-ness. This is the part a text scanner cannot fake.

WHAT THIS CANNOT GIVE, and the UI must say so: no type inference. No hover
types, no member completion, no go-to-definition across files. Python's types
are not in the syntax, and running the user's imports to find out is exactly
what an offline, permission-gated app must never do.

Usage:
    galactus_pylang.py --path <display/path.py>   < buffer.py
    galactus_pylang.py --selftest
    galactus_pylang.py --version

Exit status is 0 whenever the analysis ran, even when the source does not
parse: a SyntaxError is the answer, not a failure. 2 means bad usage.
"""

from __future__ import annotations

import ast
import json
import sys
import symtable

SCHEMA = 1

# Mirrors MAX_FILE_BYTES in src-tauri/src/code.rs: the workspace refuses to
# read a file bigger than this, so a buffer bigger than this cannot have come
# from the editor. Second line of defence, the Rust side caps too.
MAX_SOURCE_BYTES = 4 * 1024 * 1024

# An outline is a thing a human reads. A generated file with 100 000 module
# level bindings would otherwise ship 100 000 rows to the UI, which is not an
# outline, it is a second copy of the file. Past this the list is cut and the
# payload says so, rather than pretending it is complete.
MAX_SYMBOLS = 5000


# ---------------------------------------------------------------- outline


def _fmt_annotation(node) -> str:
    try:
        return ast.unparse(node)
    except Exception:
        return "?"


def _signature(fn) -> str:
    """A readable parameter list. Names and markers only, no defaults: this is
    an outline row, not a documentation generator."""
    a = fn.args
    parts: list[str] = []
    for arg in getattr(a, "posonlyargs", []):
        parts.append(arg.arg)
    if getattr(a, "posonlyargs", []):
        parts.append("/")
    for arg in a.args:
        parts.append(arg.arg)
    if a.vararg is not None:
        parts.append("*" + a.vararg.arg)
    elif a.kwonlyargs:
        parts.append("*")
    for arg in a.kwonlyargs:
        parts.append(arg.arg)
    if a.kwarg is not None:
        parts.append("**" + a.kwarg.arg)
    sig = "(" + ", ".join(parts) + ")"
    if fn.returns is not None:
        sig += " -> " + _fmt_annotation(fn.returns)
    return sig


def _char_col(line_text: str, byte_col: int) -> int:
    """`ast` reports col_offset as a UTF-8 BYTE offset, while an editor counts
    characters. On a line holding an accent the two differ, and a symbol would
    land one column too far right. Converted here, once, exactly."""
    if byte_col <= 0:
        return 0
    raw = line_text.encode("utf-8")
    if byte_col >= len(raw):
        return len(line_text)
    return len(raw[:byte_col].decode("utf-8", errors="ignore"))


def _symbol(name: str, kind: str, node, depth: int, detail: str = "", lines=()) -> dict:
    line = getattr(node, "lineno", 1)
    byte_col = getattr(node, "col_offset", 0)
    text = lines[line - 1] if 0 < line <= len(lines) else ""
    return {
        "name": name,
        "kind": kind,
        "line": line,
        "col": _char_col(text, byte_col),
        "end_line": getattr(node, "end_lineno", None) or line,
        "depth": depth,
        "detail": detail,
    }


# Statements that hold a body but do not introduce a scope. A def inside
# `if TYPE_CHECKING:` is still a module-level def, and the outline must read
# that way.
_TRANSPARENT = (ast.If, ast.Try, ast.With, ast.AsyncWith, ast.For, ast.AsyncFor, ast.While)


def _collect(body, depth: int, in_class: bool, out: list, lines) -> None:
    for node in body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            kind = "method" if in_class else "function"
            if isinstance(node, ast.AsyncFunctionDef):
                kind = "async " + kind
            out.append(_symbol(node.name, kind, node, depth, _signature(node), lines))
            _collect(node.body, depth + 1, False, out, lines)
        elif isinstance(node, ast.ClassDef):
            bases = ", ".join(_fmt_annotation(b) for b in node.bases)
            out.append(_symbol(node.name, "class", node, depth, bases, lines))
            _collect(node.body, depth + 1, True, out, lines)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                shown = alias.asname or alias.name
                out.append(_symbol(shown, "import", node, depth, alias.name, lines))
        elif isinstance(node, ast.ImportFrom):
            module = "." * (node.level or 0) + (node.module or "")
            for alias in node.names:
                shown = alias.asname or alias.name
                out.append(
                    _symbol(
                        shown,
                        "import",
                        node,
                        depth,
                        f"{module}.{alias.name}".lstrip("."),
                        lines,
                    )
                )
        elif isinstance(node, ast.Assign) and depth == 0 and not in_class:
            for target in node.targets:
                if isinstance(target, ast.Name):
                    out.append(_symbol(target.id, "variable", node, depth, "", lines))
        elif isinstance(node, ast.AnnAssign) and depth == 0 and not in_class:
            if isinstance(node.target, ast.Name):
                out.append(
                    _symbol(
                        node.target.id,
                        "variable",
                        node,
                        depth,
                        _fmt_annotation(node.annotation),
                        lines,
                    )
                )
        elif isinstance(node, _TRANSPARENT):
            _collect(node.body, depth, in_class, out, lines)
            _collect(getattr(node, "orelse", []) or [], depth, in_class, out, lines)
            _collect(getattr(node, "finalbody", []) or [], depth, in_class, out, lines)
            for handler in getattr(node, "handlers", []) or []:
                _collect(handler.body, depth, in_class, out, lines)


# ---------------------------------------------------------------- scopes


def _collect_scopes(table, depth: int, out: list) -> None:
    entry = {
        "name": table.get_name(),
        "type": table.get_type(),
        "line": table.get_lineno(),
        "depth": depth,
        "nested": bool(table.is_nested()),
        "params": [],
        "globals": sorted(s.get_name() for s in table.get_symbols() if s.is_global()),
    }
    if isinstance(table, symtable.Function):
        entry["params"] = list(table.get_parameters())
    out.append(entry)
    for child in table.get_children():
        _collect_scopes(child, depth + 1, out)


# ---------------------------------------------------------------- errors


def _syntax_error(exc: SyntaxError) -> dict:
    # offset is 1-based and may be None; col is the 0-based column the editor
    # wants. end_offset exists since 3.10 and is what makes a precise squiggle
    # possible instead of a whole-line highlight.
    offset = exc.offset if isinstance(exc.offset, int) else None
    end_offset = getattr(exc, "end_offset", None)
    if not isinstance(end_offset, int):
        end_offset = None
    return {
        "kind": "syntax",
        "message": exc.msg or str(exc),
        "line": exc.lineno if isinstance(exc.lineno, int) else 1,
        "offset": offset,
        "col": max(0, offset - 1) if offset else 0,
        "end_line": getattr(exc, "end_lineno", None) or (exc.lineno or 1),
        "end_col": max(0, end_offset - 1) if end_offset else None,
        "text": (exc.text or "").rstrip("\n"),
    }


def _refused(path: str, error: dict) -> dict:
    """A payload for input we would not even hand to the parser. Same shape as
    a real analysis, so the Rust side has exactly one schema to read."""
    return {
        "schema": SCHEMA,
        "ok": False,
        "path": path,
        "python": "%d.%d.%d" % sys.version_info[:3],
        "error": error,
        "symbols": [],
        "scopes": [],
        "truncated": False,
        "limits": {"types": False, "hover_types": False, "member_completion": False},
    }


def _plain_error(kind: str, message: str) -> dict:
    return {
        "kind": kind,
        "message": message,
        "line": 1,
        "offset": None,
        "col": 0,
        "end_line": 1,
        "end_col": None,
        "text": "",
    }


# ---------------------------------------------------------------- analysis


def analyze(source: str, path: str) -> dict:
    """Parse `source` and describe it. Never executes anything."""
    result = {
        "schema": SCHEMA,
        "ok": False,
        "path": path,
        "python": "%d.%d.%d" % sys.version_info[:3],
        "error": None,
        "symbols": [],
        "scopes": [],
        "truncated": False,
        # Stated in the payload itself so the UI cannot promise more than the
        # analysis can deliver.
        "limits": {"types": False, "hover_types": False, "member_completion": False},
    }

    if len(source.encode("utf-8", errors="ignore")) > MAX_SOURCE_BYTES:
        result["error"] = _plain_error(
            "limit",
            "source is larger than %d bytes, not analysed" % MAX_SOURCE_BYTES,
        )
        return result

    try:
        tree = ast.parse(source, filename=path or "<buffer>", mode="exec")
    except SyntaxError as exc:
        result["error"] = _syntax_error(exc)
        return result
    except ValueError as exc:
        # Null bytes and a few other malformed inputs land here, not on
        # SyntaxError. Reported as data, so the UI shows a message instead of
        # an empty panel.
        result["error"] = _plain_error("value", str(exc))
        return result
    except RecursionError:
        result["error"] = _plain_error("internal", "expression nested too deeply to parse")
        return result

    symbols: list = []
    _collect(tree.body, 0, False, symbols, source.splitlines())
    if len(symbols) > MAX_SYMBOLS:
        result["truncated"] = True
        symbols = symbols[:MAX_SYMBOLS]
    result["symbols"] = symbols

    try:
        table = symtable.symtable(source, path or "<buffer>", "exec")
        scopes: list = []
        _collect_scopes(table, 0, scopes)
        result["scopes"] = scopes
    except (SyntaxError, ValueError, RecursionError):
        # The AST parsed but symtable refused: keep the outline, drop the
        # scopes rather than losing the whole analysis.
        result["scopes"] = []

    result["ok"] = True
    return result


# ---------------------------------------------------------------- selftest


SELFTEST_CLEAN = '''"""Doc."""
import os
from typing import List

VERSION = "1"


class Widget:
    def __init__(self, name):
        self.name = name

    async def render(self, *, upper: bool = False) -> str:
        return self.name


def main(argv: List[str]) -> int:
    def inner():
        return os.sep

    return len(inner()) + len(argv)
'''

SELFTEST_BROKEN = "def ok():\n    return 1\n\n\ndef broken(:\n    return 2\n"


def selftest() -> int:
    checks = 0

    def check(cond, label):
        nonlocal checks
        if not cond:
            raise AssertionError("selftest failed: " + label)
        checks += 1

    r = analyze(SELFTEST_CLEAN, "clean.py")
    check(r["ok"] is True, "clean parses")
    check(r["error"] is None, "clean has no error")
    names = [(s["name"], s["kind"], s["line"], s["depth"]) for s in r["symbols"]]
    check(("os", "import", 2, 0) in names, "import os")
    check(("List", "import", 3, 0) in names, "from typing import List")
    check(("VERSION", "variable", 5, 0) in names, "module variable")
    check(("Widget", "class", 8, 0) in names, "class Widget")
    check(("__init__", "method", 9, 1) in names, "method __init__")
    check(("render", "async method", 12, 1) in names, "async method render")
    check(("main", "function", 16, 0) in names, "function main")
    check(("inner", "function", 17, 1) in names, "nested function inner")
    render = [s for s in r["symbols"] if s["name"] == "render"][0]
    check(render["detail"] == "(self, *, upper) -> str", "signature: " + render["detail"])
    scope_names = [(s["name"], s["type"]) for s in r["scopes"]]
    check(("Widget", "class") in scope_names, "symtable sees the class scope")
    check(("inner", "function") in scope_names, "symtable sees the nested scope")
    main_scope = [s for s in r["scopes"] if s["name"] == "main"][0]
    check(main_scope["params"] == ["argv"], "symtable parameters")
    inner_scope = [s for s in r["scopes"] if s["name"] == "inner"][0]
    check(inner_scope["nested"] is True, "symtable nesting")

    r = analyze(SELFTEST_BROKEN, "broken.py")
    check(r["ok"] is False, "broken does not parse")
    check(r["error"]["kind"] == "syntax", "broken yields a SyntaxError")
    check(r["error"]["line"] == 5, "broken error on line 5, got %r" % r["error"]["line"])
    check(isinstance(r["error"]["offset"], int), "broken error carries an offset")
    check(len(r["error"]["message"]) > 0, "broken error carries a message")
    check(r["symbols"] == [], "no outline when the source does not parse")

    r = analyze("x = 1\x00\n", "nul.py")
    check(r["ok"] is False, "NUL byte refused")
    check(r["error"]["kind"] in ("value", "syntax"), "NUL byte reported as data")

    r = analyze("def café(thé):\n    return thé\n", "accents.py")
    check(r["ok"] is True, "accented identifiers parse")
    check(r["symbols"][0]["name"] == "café", "accented identifier preserved")
    check(r["scopes"][1]["params"] == ["thé"], "accented parameter preserved")

    r = analyze("if True:\n    import json\n", "transparent.py")
    check(r["symbols"][0]["name"] == "json", "import inside if is module level")
    check(r["symbols"][0]["depth"] == 0, "transparent statement keeps depth 0")

    r = analyze("x" * (MAX_SOURCE_BYTES + 1), "huge.py")
    check(r["ok"] is False, "oversized source refused")
    check(r["error"]["kind"] == "limit", "oversized source reported as a limit")

    r = analyze("x = 1\n" * (MAX_SYMBOLS + 10), "many.py")
    check(r["ok"] is True, "a file with many bindings still parses")
    check(len(r["symbols"]) == MAX_SYMBOLS, "outline capped at MAX_SYMBOLS")
    check(r["truncated"] is True, "truncation is declared, not hidden")

    r = analyze("x = 1\n", "small.py")
    check(r["truncated"] is False, "a small file is not marked truncated")

    # The payload must survive a JSON round trip: it is what the Rust side
    # parses, and an unserialisable field would only show up in production.
    round_trip = json.loads(json.dumps(analyze(SELFTEST_CLEAN, "clean.py")))
    check(round_trip["ok"] is True, "payload survives JSON")

    print("selftest: %d checks passed on CPython %s" % (checks, ".".join(map(str, sys.version_info[:3]))))
    return 0


# ---------------------------------------------------------------- entry point


def main(argv: list[str]) -> int:
    path = "<buffer>"
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--selftest":
            return selftest()
        if arg == "--version":
            print(json.dumps({"schema": SCHEMA, "python": sys.version.split()[0]}))
            return 0
        if arg == "--path":
            i += 1
            if i >= len(argv):
                sys.stderr.write("--path needs a value\n")
                return 2
            path = argv[i]
        else:
            sys.stderr.write("unknown argument: %s\n" % arg)
            return 2
        i += 1

    raw = sys.stdin.buffer.read()
    if len(raw) > MAX_SOURCE_BYTES:
        print(json.dumps(
            _refused(
                path,
                _plain_error(
                    "limit", "source is larger than %d bytes, not analysed" % MAX_SOURCE_BYTES
                ),
            ),
            ensure_ascii=True,
        ))
        return 0
    try:
        source = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        print(json.dumps(
            _refused(path, _plain_error("encoding", "buffer is not valid UTF-8: %s" % exc)),
            ensure_ascii=True,
        ))
        return 0

    # ensure_ascii keeps the pipe to Rust free of any encoding question:
    # accented identifiers travel as \uXXXX escapes and come back exact.
    print(json.dumps(analyze(source, path), ensure_ascii=True))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
