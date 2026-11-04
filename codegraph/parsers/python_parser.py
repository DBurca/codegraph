"""Python parsing via the standard-library ``ast`` module (exact, no regex guessing)."""

from __future__ import annotations

import ast
import re

FILE_REF_RE = re.compile(r"^[\w./\\-]+\.(?:html?|m?js|css|py|cpp|cc|h|hpp|ts|tsx)$", re.I)
MAX_USES = 300


def _sym(node, kind, parent=None):
    d = {
        "name": node.name,
        "kind": kind,
        "line": getattr(node, "lineno", 1),
        "end": getattr(node, "end_lineno", getattr(node, "lineno", 1)),
    }
    if parent:
        d["parent"] = parent
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        args = [a.arg for a in node.args.args]
        if args and args[0] in ("self", "cls"):
            args = args[1:]
        d["sig"] = "(" + ", ".join(args) + ")"
    doc = ast.get_docstring(node) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) else None
    if doc:
        d["doc"] = doc.strip().splitlines()[0][:140]
    return d


def _is_main_guard(node) -> bool:
    if not isinstance(node, ast.If):
        return False
    t = node.test
    if isinstance(t, ast.Compare) and len(t.comparators) == 1:
        names = [t.left, t.comparators[0]]
        has_name = any(isinstance(n, ast.Name) and n.id == "__name__" for n in names)
        has_main = any(isinstance(n, ast.Constant) and n.value == "__main__" for n in names)
        return has_name and has_main
    return False


def _chain(node):
    """Return dotted name parts for Name/Attribute chains like a.b.c, else None."""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return parts[::-1]
    return None


def parse(text: str) -> dict:
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError) as e:
        return {"error": f"Could not parse: {e.__class__.__name__} (line {getattr(e, 'lineno', '?')})",
                "symbols": [], "imports": [], "entry": False, "doc": None, "refs": []}

    doc = ast.get_docstring(tree)
    symbols = []
    entry = False
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            symbols.append(_sym(node, "function"))
        elif isinstance(node, ast.ClassDef):
            symbols.append(_sym(node, "class"))
            for child in node.body:
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    symbols.append(_sym(child, "method", parent=node.name))
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for t in targets:
                if isinstance(t, ast.Name) and not t.id.startswith("__"):
                    symbols.append({"name": t.id, "kind": "var", "line": node.lineno,
                                    "end": getattr(node, "end_lineno", node.lineno)})
        elif _is_main_guard(node):
            entry = True

    # Every Name / dotted chain used in the file, with line numbers.
    chains: list[tuple[list[str], int]] = []
    refs: list[tuple[str, int]] = []
    imports_raw = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                imports_raw.append({"type": "import", "module": a.name, "level": 0, "line": node.lineno,
                                    "bind": a.asname or a.name.split(".")[0], "aliased": bool(a.asname)})
        elif isinstance(node, ast.ImportFrom):
            for a in node.names:
                imports_raw.append({"type": "from", "module": node.module or "", "level": node.level or 0,
                                    "name": a.name, "line": node.lineno, "bind": a.asname or a.name})
        elif isinstance(node, (ast.Attribute, ast.Name)):
            if isinstance(node, ast.Name) and not isinstance(node.ctx, ast.Load):
                continue
            c = _chain(node)
            if c:
                chains.append((c, node.lineno))
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            v = node.value.strip()
            if len(v) < 200 and FILE_REF_RE.match(v):
                refs.append((v, node.lineno))

    by_head: dict[str, list[tuple[list[str], int]]] = {}
    for c, line in chains:
        by_head.setdefault(c[0], []).append((c, line))

    imports = []
    for imp in imports_raw:
        cands = by_head.get(imp["bind"], [])
        if imp["type"] == "import":
            prefix = [imp["bind"]] if imp["aliased"] else imp["module"].split(".")
            uses = set()
            for c, line in cands:
                if len(c) > len(prefix) and c[:len(prefix)] == prefix:
                    uses.add((c[len(prefix)], line))
            imp["uses"] = sorted(uses, key=lambda u: u[1])[:MAX_USES]
        else:
            direct, attrs = set(), set()
            for c, line in cands:
                direct.add((imp["name"], line))
                if len(c) > 1:
                    attrs.add((c[1], line))
            imp["uses"] = sorted(direct, key=lambda u: u[1])[:MAX_USES]
            imp["attr_uses"] = sorted(attrs, key=lambda u: u[1])[:MAX_USES]
        imports.append(imp)

    return {
        "doc": doc.strip().splitlines()[0][:200] if doc else None,
        "symbols": symbols,
        "imports": imports,
        "entry": entry,
        "refs": refs,
        "error": None,
    }
