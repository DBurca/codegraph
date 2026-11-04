"""C / C++ parsing: #include directives plus a heuristic symbol scan (classes, functions)."""

from __future__ import annotations

import re

from . import clike

INCLUDE_RE = re.compile(r'^[ \t]*#[ \t]*include[ \t]*([<"])([^>"\n]+)[>"]', re.M)
MAIN_RE = re.compile(r"\b(?:int|void)\s+main\s*\(")
ARDUINO_RE = re.compile(r"\bvoid\s+setup\s*\(\s*\)")

KEYWORDS = {
    "if", "for", "while", "switch", "catch", "return", "sizeof", "else", "do", "case",
    "new", "delete", "throw", "decltype", "alignof", "static_assert", "defined", "typeid",
    "using", "operator",
}

FUNC_RE = re.compile(
    r"(?P<name>~?[A-Za-z_]\w*(?:\s*::\s*~?[A-Za-z_]\w*)*)\s*"
    r"\((?P<args>[^;{}()]*(?:\([^;{}()]*\)[^;{}()]*)*)\)\s*"
    r"(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:final\s*)?"
    r"(?:->\s*[\w:<>\s\*&,]+?\s*)?(?::[^;{]*)?\{"
)

PROTO_RE = re.compile(
    r"^[ \t]*(?:(?:static|inline|extern|virtual|explicit|constexpr|friend)\s+)*"
    r"[A-Za-z_][\w:<>,\*&\s]*?[\s\*&]+(?P<name>[A-Za-z_]\w*)\s*\([^;{}()]*\)\s*(?:const\s*)?(?:override\s*)?(?:=\s*0\s*)?;",
    re.M,
)

CLASS_RE = re.compile(r"\b(class|struct|union|enum(?:\s+class)?)\s+(?:alignas\([^)]*\)\s*)?([A-Za-z_]\w*)\s*(?:final\s*)?(?::[^;{]*)?\{")
DEFINE_RE = re.compile(r"^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)", re.M)


def parse(text: str, is_header: bool) -> dict:
    stripped = clike.strip(text)
    li = clike.LineIndex(text)
    braces = clike.brace_map(stripped)

    includes = []
    for m in INCLUDE_RE.finditer(text):
        includes.append({"spec": m.group(2).strip(), "system": m.group(1) == "<", "line": li.line(m.start())})

    symbols = []
    seen = set()

    for m in CLASS_RE.finditer(stripped):
        bpos = m.end() - 1
        info = braces.get(bpos)
        if not info or info["depth"] > 0:
            continue
        kind = "class" if m.group(1) in ("class", "struct", "union") else "enum"
        key = (m.group(2), li.line(m.start()))
        if key in seen:
            continue
        seen.add(key)
        symbols.append({"name": m.group(2), "kind": kind, "line": key[1], "end": li.line(info["close"])})

    for m in FUNC_RE.finditer(stripped):
        name = re.sub(r"\s+", "", m.group("name"))
        short = name.split("::")[-1].lstrip("~")
        if short in KEYWORDS or name.split("::")[0] in KEYWORDS:
            continue
        bpos = m.end() - 1
        info = braces.get(bpos)
        if not info or info["depth"] > 0:
            continue
        # Must look like a definition: preceded by a type / qualifier, a newline, or be a Class::method.
        before = stripped[max(0, m.start() - 80):m.start()]
        prev = before.rstrip()
        if "::" not in name and prev and prev[-1] in "=(,!&|+-*/<>?:" and not prev.endswith(("*", "&", ">", "::")):
            continue
        line = li.line(m.start("name"))
        key = (name, line)
        if key in seen:
            continue
        seen.add(key)
        sym = {"name": name, "kind": "method" if ("::" in name or info.get("parent")) else "function",
               "line": line, "end": li.line(info["close"]),
               "sig": "(" + re.sub(r"\s+", " ", m.group("args").strip()) + ")"}
        if info.get("parent"):
            sym["parent"] = info["parent"]
        elif "::" in name:
            sym["parent"] = name.rsplit("::", 1)[0]
        symbols.append(sym)

    if is_header:
        for m in PROTO_RE.finditer(stripped):
            name = m.group("name")
            if name in KEYWORDS:
                continue
            # skip prototypes inside function bodies
            depth = 0
            pos = m.start("name")
            for bpos, info in braces.items():
                if bpos < pos < info["close"] and info["kind"] == "block":
                    depth += 1
                    break
            if depth:
                continue
            line = li.line(pos)
            if (name, line) in seen:
                continue
            seen.add((name, line))
            symbols.append({"name": name, "kind": "decl", "line": line, "end": line})
        for m in DEFINE_RE.finditer(text):
            name = m.group(1)
            if name.endswith("_H") or name.endswith("_H_") or name.endswith("_HPP"):
                continue
            symbols.append({"name": name, "kind": "macro", "line": li.line(m.start()), "end": li.line(m.start())})

    symbols.sort(key=lambda s: s["line"])
    entry = bool(MAIN_RE.search(stripped) or ARDUINO_RE.search(stripped))

    doc = None
    lead = re.match(r"\s*(?://\s*(.+)|/\*+\s*\**\s*(.+))", text)
    if lead:
        doc = (lead.group(1) or lead.group(2) or "").strip().rstrip("*/").strip()[:200] or None

    return {
        "doc": doc,
        "symbols": symbols,
        "includes": includes,
        "entry": entry,
        "idents": clike.identifiers(stripped, li),
        "error": None,
    }
