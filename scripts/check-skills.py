#!/usr/bin/env python3
"""Validate every app/skills/**/SKILL.md against the Galactus runtime.

Three checks:
  1. tools   -- every tool-shaped identifier used as a tool exists in TOOLS
  2. dashes  -- no em dash / en dash anywhere
  3. front   -- frontmatter has exactly the fields `name` and `description`,
                and `name` matches the parent directory

Usage: python3 scripts/check-skills.py [SKILLS_DIR]
Exit code 0 when everything passes, 1 otherwise.
"""

import pathlib
import re
import sys

# The complete tool surface of the Galactus agent. Nothing else may be named.
#
# It is READ from app/src/agent.ts, which is where the surface is actually
# declared, and not transcribed here. A hand kept copy drifts silently and had
# already drifted: `generate_image` and `retrieve` shipped in agent.ts while
# this list still denied they existed, so every skill that named them was
# reported as naming an unknown tool.
AGENT_TS = pathlib.Path(__file__).resolve().parent.parent / "app/src/agent.ts"
TOOL_DECL = re.compile(r'^\s*name:\s*"([a-z][a-z0-9_]*)"', re.M)


def load_tools(source=AGENT_TS):
    """Return the tool names declared in agent.ts.

    Raises rather than returns an empty set: a check whose reference list is
    empty accepts every name it is shown, which is the failure mode this
    function exists to prevent.
    """
    try:
        text = source.read_text(encoding="utf-8")
    except OSError as exc:
        raise SystemExit(f"cannot read the tool surface from {source}: {exc}")
    names = set(TOOL_DECL.findall(text))
    if not names:
        raise SystemExit(
            f"no tool declaration matched in {source}.\n"
            "The `name: \"...\"` shape this check relies on has changed. Fix the\n"
            "pattern in scripts/check-skills.py; do not let it pass empty."
        )
    return names


TOOLS = load_tools()

# Underscore-bearing identifiers that sit in a tool-shaped position but are NOT
# agent tools: JSON keys, HCL meta-arguments, example test names, column names.
# Kept explicit and short so a genuinely unknown tool cannot hide in here.
NON_TOOLS = {
    "request_id", "next_cursor", "order_id",           # API field names
    "allocation_cible",                                  # portfolio JSON key
    "for_each", "prevent_destroy",                       # Terraform meta-args
    "node_modules",                                      # directory name
    "lignes_gauche", "lignes_droite",                    # reconciliation counts
    "orphelines_gauche", "orphelines_droite",
    "test_retourne_zero_quand_la_liste_est_vide",        # example test name
    "test_calcul",                                       # counter-example
}

# Tool names from OTHER agent runtimes. Any occurrence anywhere in a SKILL.md
# is an error, even in prose or a code block: these do not exist in Galactus.
# `run_workflow` is here because it was shipped by mistake and must not return.
FOREIGN = {
    "run_workflow", "web_search", "web_fetch", "str_replace_editor",
    "browser_action", "multi_edit", "todo_write", "bash_tool",
    "WebSearch", "WebFetch", "MultiEdit", "TodoWrite", "NotebookEdit",
    "Glob", "Grep", "Task", "Bash",
}

DASHES = {"—": "em dash", "–": "en dash"}

FENCE = re.compile(r"^\s*```")

# A tool mention is an underscore-bearing (or mcp__) identifier used the way a
# tool is used: either called, `name(...)`, or named alone in an inline-code
# span, `name`. An identifier buried inside a shell command, a URL, a SQL
# snippet or a format string is not a tool mention.
IDENT = r"(?:mcp__[A-Za-z0-9_]+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)"
CALLED = re.compile(r"\b(" + IDENT + r")\s*\(")
SPAN = re.compile(r"`([^`\n]+)`")
BARE = re.compile(r"^" + IDENT + r"$")
WORD = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]*\b")


def tool_mentions(line):
    """Yield identifiers used in a tool-shaped position on this line."""
    for name in CALLED.findall(line):
        yield name
    for span in SPAN.findall(line):
        span = span.strip()
        if BARE.match(span):
            yield span


def strip_fenced(text):
    """Return the file with fenced code blocks blanked out, line count kept."""
    out, inside = [], False
    for line in text.splitlines():
        if FENCE.match(line):
            inside = not inside
            out.append("")
            continue
        out.append("" if inside else line)
    return out


def frontmatter(text):
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---\n", 4)
    if end == -1:
        return None
    fields = []
    for line in text[4:end].splitlines():
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):", line)
        if m:
            fields.append(m.group(1))
    return fields


def main():
    root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "app/skills")
    # rglob, not glob: the docstring promises **/SKILL.md, and `*/SKILL.md`
    # walks exactly one level. A skill filed in a subdirectory was not checked
    # at all, and its absence from the report read as a pass.
    files = sorted(root.rglob("SKILL.md"))
    if not files:
        print(f"no SKILL.md found under {root}")
        return 1

    unknown, dash_hits, front_hits, foreign_hits = [], [], [], []

    for path in files:
        text = path.read_text(encoding="utf-8")

        fields = frontmatter(text)
        if fields != ["name", "description"]:
            front_hits.append((path, f"fields={fields}"))
        else:
            m = re.search(r"^name:\s*(\S+)", text, re.M)
            if not m or m.group(1) != path.parent.name:
                front_hits.append((path, "name does not match directory"))

        for lineno, line in enumerate(text.splitlines(), 1):
            for ch, label in DASHES.items():
                if ch in line:
                    dash_hits.append((path, lineno, label))
            # foreign tool names are banned everywhere, code blocks included
            for word in WORD.findall(line):
                if word in FOREIGN:
                    foreign_hits.append((path, lineno, word))

        for lineno, line in enumerate(strip_fenced(text), 1):
            for token in tool_mentions(line):
                if token in TOOLS or token in NON_TOOLS:
                    continue
                if token.startswith("mcp__"):
                    continue  # connector-provided, allowed by contract
                unknown.append((path, lineno, token))

    print(f"scanned {len(files)} SKILL.md files under {root}\n")

    print(f"[tools]  unknown tool mentions: {len(unknown)}")
    for path, lineno, token in unknown:
        print(f"  {path}:{lineno}  {token}")

    print(f"[foreign] tool names from other runtimes: {len(foreign_hits)}")
    for path, lineno, word in foreign_hits:
        print(f"  {path}:{lineno}  {word}")

    print(f"[dashes] em/en dash occurrences: {len(dash_hits)}")
    for path, lineno, label in dash_hits:
        print(f"  {path}:{lineno}  {label}")

    print(f"[front]  frontmatter problems: {len(front_hits)}")
    for path, why in front_hits:
        print(f"  {path}  {why}")

    used = sorted({t for p in files
                   for line in strip_fenced(p.read_text(encoding='utf-8'))
                   for t in tool_mentions(line) if t in TOOLS})
    print(f"\n[info]   tools actually referenced ({len(used)}/{len(TOOLS)}):")
    print("         " + ", ".join(used))
    never = sorted(TOOLS - set(used))
    if never:
        print(f"[info]   never referenced: {', '.join(never)}")

    return 1 if (unknown or dash_hits or front_hits or foreign_hits) else 0


if __name__ == "__main__":
    sys.exit(main())
