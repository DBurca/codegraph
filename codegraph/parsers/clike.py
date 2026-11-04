"""Shared helpers for brace-based languages (C, C++, JS, TS)."""

from __future__ import annotations

import bisect
import re

_TOKEN_RE = re.compile(
    r"//[^\n]*"
    r"|/\*[\s\S]*?\*/"
    r'|"(?:\\.|[^"\\\n])*"'
    r"|'(?:\\.|[^'\\\n])*'"
    r"|`(?:\\.|[^`\\])*`"
)

IDENT_RE = re.compile(r"[A-Za-z_$][\w$]*")


def strip(text: str, keep_strings: bool = False) -> str:
    """Blank out comments (and optionally string contents) while preserving offsets and newlines."""

    def repl(m):
        s = m.group(0)
        if s.startswith("//") or s.startswith("/*"):
            return re.sub(r"[^\n]", " ", s)
        if keep_strings:
            return s
        if s[0] == "`" and "${" in s:
            return _blank_template(s)
        return s[0] + re.sub(r"[^\n]", " ", s[1:-1]) + s[-1]

    return _TOKEN_RE.sub(repl, text)


def _blank_template(s: str) -> str:
    """Blank a JS template literal's text but keep its ${ ... } expressions (they contain real calls)."""
    out, i, depth = [], 0, 0
    while i < len(s):
        c = s[i]
        if depth == 0:
            if s.startswith("${", i):
                out.append("  ")
                depth, i = 1, i + 2
                continue
            out.append(c if c in "`\n" else " ")
        else:
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    out.append(" ")
                    i += 1
                    continue
            out.append(c if c not in "'\"`" else " ")
        i += 1
    return "".join(out)


class LineIndex:
    def __init__(self, text: str):
        self.nl = [m.start() for m in re.finditer("\n", text)]

    def line(self, pos: int) -> int:
        return bisect.bisect_left(self.nl, pos) + 1


_SCOPE_KW = re.compile(r"\b(class|struct|union|namespace|interface|enum)\b(?:\s+([A-Za-z_$][\w$:]*))?")


def brace_map(stripped: str) -> dict[int, dict]:
    """Map each '{' offset to its matching '}', its kind, and its nesting.

    kind is 'scope' for class/struct/namespace bodies, 'block' otherwise.
    depth counts enclosing 'block' braces (function bodies, control flow, objects).
    """
    result: dict[int, dict] = {}
    stack: list[int] = []
    for m in re.finditer(r"[{}]", stripped):
        pos = m.start()
        if stripped[pos] == "{":
            start = max(stripped.rfind(";", 0, pos), stripped.rfind("{", 0, pos), stripped.rfind("}", 0, pos))
            seg = stripped[start + 1:pos]
            km = _SCOPE_KW.search(seg)
            kind = "scope" if km and "(" not in seg[km.start():] and "=" not in seg[:km.start()] else "block"
            # extern "C" { ... } — the "C" has already been blanked to " " by strip()
            if re.search(r'\bextern\s*"[^"\n]*"\s*$', seg):
                kind = "scope"
            depth = sum(1 for p in stack if result[p]["kind"] == "block")
            parent_class = None
            if stack and result[stack[-1]]["kind"] == "scope":
                parent_class = result[stack[-1]].get("name")
            result[pos] = {"close": len(stripped) - 1, "kind": kind, "depth": depth,
                           "name": km.group(2) if (km and kind == "scope") else None,
                           "scope_kw": km.group(1) if (km and kind == "scope") else None,
                           "parent": parent_class}
            stack.append(pos)
        else:
            if stack:
                result[stack.pop()]["close"] = pos
    return result


def identifiers(stripped: str, li: LineIndex, cap: int = 60) -> dict[str, list[int]]:
    out: dict[str, list[int]] = {}
    nl, j, n_nl = li.nl, 0, len(li.nl)
    for m in IDENT_RE.finditer(stripped):
        pos = m.start()
        while j < n_nl and nl[j] < pos:  # matches arrive in order, so walk the newline list once
            j += 1
        lst = out.get(m.group(0))
        if lst is None:
            out[m.group(0)] = [j + 1]
        elif len(lst) < cap and lst[-1] != j + 1:
            lst.append(j + 1)
    return out


class DepthIndex:
    """Answers 'how many block braces enclose this offset?' in O(log n)."""

    def __init__(self, braces: dict[int, dict]):
        events = []
        for pos, info in braces.items():
            if info["kind"] == "block":
                events.append((pos, 1))
                events.append((info["close"], -1))
        events.sort()
        self.pos = [e[0] for e in events]
        self.prefix = []
        d = 0
        for _, delta in events:
            d += delta
            self.prefix.append(d)

    def at(self, p: int) -> int:
        i = bisect.bisect_left(self.pos, p) - 1
        return self.prefix[i] if i >= 0 else 0


def match_paren(stripped: str, open_pos: int) -> int:
    """Given the offset of '(', return the offset just past its matching ')'."""
    depth = 0
    for i in range(open_pos, min(len(stripped), open_pos + 5000)):
        c = stripped[i]
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return i + 1
    return open_pos + 1


def next_brace(stripped: str, pos: int, limit: int = 400) -> int:
    """Find the first '{' at or after pos before hitting ';' (within limit chars)."""
    end = min(len(stripped), pos + limit)
    for i in range(pos, end):
        c = stripped[i]
        if c == "{":
            return i
        if c == ";":
            return -1
    return -1
