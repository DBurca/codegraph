"""JavaScript / TypeScript / HTML / CSS parsing (regex + brace matching; good enough for real projects)."""

from __future__ import annotations

import re

from . import clike

# --- JS / TS -----------------------------------------------------------------

IMPORT_FROM = re.compile(r"\bimport\s+(?:type\s+)?([\w$*{}\s,]+?)\s+from\s*(['\"])([^'\"\n]+)\2")
IMPORT_BARE = re.compile(r"\bimport\s*(['\"])([^'\"\n]+)\1")
EXPORT_FROM = re.compile(r"\bexport\s+(?:type\s+)?(\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s*(['\"])([^'\"\n]+)\2")
REQUIRE = re.compile(r"(?:(?:const|let|var)\s+([\w$]+|\{[^}]*\})\s*=\s*)?\brequire\s*\(\s*(['\"])([^'\"\n]+)\2\s*\)")
DYNAMIC = re.compile(r"\bimport\s*\(\s*(['\"])([^'\"\n]+)\1\s*\)")
FILE_REF = re.compile(r"(['\"`])([\w./-]+\.(?:html?|m?js|css|py|ts|tsx|jsx))\1")

FUNC_DECL = re.compile(r"\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(")
CLASS_DECL = re.compile(r"\bclass\s+([A-Za-z_$][\w$]*)")
ARROW = re.compile(
    r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:async\s+)?"
    r"(?:function\b|\([^()]*\)\s*(?::\s*[^=;{]+)?=>|[A-Za-z_$][\w$]*\s*=>)"
)
METHOD = re.compile(
    r"^[ \t]*(?:(?:static|async|get|set|public|private|protected|readonly|override)\s+)*\*?"
    r"([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*(?::\s*[^{;]+)?\{",
    re.M,
)
TOPVAR = re.compile(r"^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)", re.M)
WINDOW_ASSIGN = re.compile(r"\bwindow\.([A-Za-z_$][\w$]*)\s*=[^=]")
TS_TYPE = re.compile(r"^(?:export\s+)?(?:declare\s+)?(interface|type|enum)\s+([A-Za-z_$][\w$]*)", re.M)

JS_KEYWORDS = {"if", "for", "while", "switch", "catch", "return", "function", "constructor_", "with", "else", "do"}


def _bindings(clause: str) -> tuple[list[dict], list[str]]:
    """Parse an import clause → (named bindings, namespace locals)."""
    named, ns = [], []
    clause = clause.strip()
    m = re.search(r"\*\s+as\s+([\w$]+)", clause)
    if m:
        ns.append(m.group(1))
        clause = clause[:m.start()] + clause[m.end():]
    brace = re.search(r"\{([^}]*)\}", clause)
    if brace:
        for part in brace.group(1).split(","):
            part = part.strip()
            if not part:
                continue
            part = re.sub(r"^type\s+", "", part)
            if " as " in part:
                imported, local = [p.strip() for p in part.split(" as ", 1)]
            else:
                imported = local = part
            named.append({"imported": imported, "local": local})
        clause = clause[:brace.start()] + clause[brace.end():]
    default = clause.strip().strip(",").strip()
    if default and re.fullmatch(r"[\w$]+", default):
        named.append({"imported": "default", "local": default})
        ns.append(default)  # default exports are often objects/classes accessed via dots
    return named, ns


def parse_js(text: str, is_ts: bool = False) -> dict:
    no_comments = clike.strip(text, keep_strings=True)
    stripped = clike.strip(text)
    li = clike.LineIndex(text)
    braces = clike.brace_map(stripped)
    depth = clike.DepthIndex(braces)
    idents = clike.identifiers(stripped, li)

    imports = []

    def add(spec, line, kind, named=None, ns=None):
        imports.append({"spec": spec, "line": line, "kind": kind, "named": named or [], "ns": ns or []})

    for m in IMPORT_FROM.finditer(no_comments):
        named, ns = _bindings(m.group(1))
        add(m.group(3), li.line(m.start()), "import", named, ns)
    for m in IMPORT_BARE.finditer(no_comments):
        add(m.group(2), li.line(m.start()), "side-effect")
    for m in EXPORT_FROM.finditer(no_comments):
        named, ns = _bindings(m.group(1)) if "{" in m.group(1) else ([], [])
        add(m.group(3), li.line(m.start()), "re-export", named, ns)
    for m in REQUIRE.finditer(no_comments):
        target = m.group(1)
        named, ns = [], []
        if target and target.startswith("{"):
            named, _ = _bindings(target.replace(":", " as "))
        elif target:
            ns = [target]
        add(m.group(3), li.line(m.start()), "require", named, ns)
    for m in DYNAMIC.finditer(no_comments):
        add(m.group(2), li.line(m.start()), "dynamic")

    # usage: named bindings → their identifier lines; namespaces → ns.attr lines
    for imp in imports:
        uses = []
        for b in imp["named"]:
            for ln in idents.get(b["local"], []):
                if ln != imp["line"]:
                    uses.append((b["imported"] if b["imported"] != "default" else b["local"], ln))
        for ns in imp["ns"]:
            for m in re.finditer(r"(?<![\w$.])" + re.escape(ns) + r"\s*\.\s*([A-Za-z_$][\w$]*)", stripped):
                uses.append((m.group(1), li.line(m.start())))
        imp["uses"] = sorted(set(uses), key=lambda u: u[1])[:300]

    symbols, seen = [], set()

    def add_sym(name, kind, start, brace_pos=None, end_line=None, parent=None, sig=None):
        line = li.line(start)
        if (name, line) in seen:
            return
        seen.add((name, line))
        if brace_pos is not None and brace_pos in braces:
            end_line = li.line(braces[brace_pos]["close"])
        s = {"name": name, "kind": kind, "line": line, "end": end_line or line, "top": depth.at(start) == 0}
        if parent:
            s["parent"] = parent
        if sig:
            s["sig"] = sig
        symbols.append(s)

    for m in FUNC_DECL.finditer(stripped):
        paren = m.end() - 1
        after = clike.match_paren(stripped, paren)
        sig = re.sub(r"\s+", " ", text[paren:after])[:80]
        bpos = clike.next_brace(stripped, after, 200)
        add_sym(m.group(1), "function", m.start(1), bpos if bpos >= 0 else None, sig=sig)
    for m in CLASS_DECL.finditer(stripped):
        bpos = clike.next_brace(stripped, m.end(), 300)
        add_sym(m.group(1), "class", m.start(1), bpos if bpos >= 0 else None)
    for m in ARROW.finditer(stripped):
        arrow = stripped.find("=>", m.start(), m.end() + 2)
        bpos = -1
        if arrow >= 0:
            rest = stripped[arrow + 2:arrow + 40].lstrip()
            if rest.startswith("{"):
                bpos = stripped.find("{", arrow)
        else:
            bpos = clike.next_brace(stripped, m.end(), 300)
        add_sym(m.group(1), "function", m.start(1), bpos if bpos >= 0 else None)
    class_scopes = [(o, i["close"], i.get("name")) for o, i in braces.items()
                    if i["kind"] == "scope" and i.get("scope_kw") == "class"]
    for m in (METHOD.finditer(stripped) if class_scopes else ()):
        name = m.group(1)
        if name in JS_KEYWORDS:
            continue
        bpos = m.end() - 1
        info = braces.get(bpos)
        # a method's body brace sits directly inside a class body
        parent = None
        for opos, close, cname in class_scopes:
            if opos < bpos < close and (parent is None or opos > parent[0]):
                parent = (opos, cname)
        if not info or parent is None:
            continue
        if depth.at(m.start()) != depth.at(parent[0]):
            continue
        add_sym(name, "method", m.start(1), bpos, parent=parent[1])
    for m in TOPVAR.finditer(stripped):
        if depth.at(m.start()) == 0:
            add_sym(m.group(1), "var", m.start(1))
    for m in WINDOW_ASSIGN.finditer(stripped):
        add_sym(m.group(1), "global", m.start(1))
    if is_ts:
        for m in TS_TYPE.finditer(stripped):
            add_sym(m.group(2), "type", m.start(2), clike.next_brace(stripped, m.end(), 200) if m.group(1) != "type" else None)

    # de-dup vars that are really arrow functions already recorded
    fnames = {(s["name"], s["line"]) for s in symbols if s["kind"] != "var"}
    symbols = [s for s in symbols if not (s["kind"] == "var" and (s["name"], s["line"]) in fnames)]
    symbols.sort(key=lambda s: s["line"])

    refs = [(m.group(2), li.line(m.start())) for m in FILE_REF.finditer(no_comments)]

    doc = None
    lead = re.match(r"\s*(?://\s*(.+)|/\*+\s*\**\s*(.+))", text)
    if lead:
        doc = (lead.group(1) or lead.group(2) or "").strip().rstrip("*/").strip()[:200] or None

    return {"doc": doc, "symbols": symbols, "imports": imports, "idents": idents, "refs": refs,
            "entry": False, "error": None}


# --- HTML --------------------------------------------------------------------

SCRIPT_BLOCK = re.compile(r"<script\b([^>]*)>([\s\S]*?)</script\s*>", re.I)
# attribute values may contain the other quote kind, e.g. src="{{ url_for('static', filename='app.js') }}"
SRC_ATTR = re.compile(r"""\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')""", re.I)
TYPE_ATTR = re.compile(r"""\btype\s*=\s*(["'])([^"']+)\1""", re.I)
LINK_TAG = re.compile(r"""<link\b(?:[^>"']|"[^"]*"|'[^']*')*>""", re.I)
HREF_ATTR = re.compile(r"""\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')""", re.I)


def _attr(m) -> str:
    return m.group(1) or m.group(2)
EVENT_ATTR = re.compile(r"""\son\w+\s*=\s*(["'])([\s\S]*?)\1""", re.I)
TITLE = re.compile(r"<title[^>]*>([\s\S]*?)</title>", re.I)
URL_FOR = re.compile(r"""url_for\(\s*['"]static['"]\s*,\s*filename\s*=\s*['"]([^'"]+)['"]""")


def _blank(s: str) -> str:
    return re.sub(r"[^\n]", " ", s)


def parse_html(text: str) -> dict:
    li = clike.LineIndex(text)
    scripts, styles = [], []
    # Build a JS-only view of the document with identical offsets.
    view = list(_blank(text))

    for m in SCRIPT_BLOCK.finditer(text):
        attrs, body = m.group(1), m.group(2)
        t = TYPE_ATTR.search(attrs)
        stype = (t.group(2).lower() if t else "")
        src = SRC_ATTR.search(attrs)
        if src:
            spec = _attr(src)
            uf = URL_FOR.search(spec)
            if uf:
                spec = "static/" + uf.group(1)
            scripts.append({"spec": spec, "module": stype == "module", "line": li.line(m.start())})
        elif stype in ("", "module", "text/javascript", "application/javascript", "text/babel"):
            s = m.start(2)
            view[s:s + len(body)] = list(body)

    for m in EVENT_ATTR.finditer(text):
        s = m.start(2)
        view[s:s + len(m.group(2))] = list(m.group(2))

    for m in LINK_TAG.finditer(text):
        tag = m.group(0)
        if re.search(r"""rel\s*=\s*["']?(?:stylesheet|modulepreload)""", tag, re.I):
            h = HREF_ATTR.search(tag)
            if h:
                spec = _attr(h)
                uf = URL_FOR.search(spec)
                if uf:
                    spec = "static/" + uf.group(1)
                styles.append({"spec": spec, "line": li.line(m.start())})

    js = parse_js("".join(view))
    title = TITLE.search(text)
    doc = re.sub(r"\s+", " ", title.group(1)).strip()[:200] if title else None
    return {
        "doc": doc,
        "symbols": js["symbols"],
        "imports": js["imports"],          # inline <script type=module> imports
        "scripts": scripts,
        "styles": styles,
        "idents": js["idents"],
        "refs": js["refs"],
        "entry": True,
        "error": None,
    }


# --- CSS ---------------------------------------------------------------------

CSS_IMPORT = re.compile(r"""@import\s+(?:url\(\s*)?["']?([^"')\s;]+)""", re.I)


def parse_css(text: str) -> dict:
    li = clike.LineIndex(text)
    imports = [{"spec": m.group(1), "line": li.line(m.start()), "kind": "import", "named": [], "ns": [], "uses": []}
               for m in CSS_IMPORT.finditer(text)]
    return {"doc": None, "symbols": [], "imports": imports, "idents": {}, "refs": [], "entry": False, "error": None}
