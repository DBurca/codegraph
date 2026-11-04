"""Turn a folder into a dependency graph: nodes (files), edges (imports), and layout metrics."""

from __future__ import annotations

import json
import os
import posixpath
import sys
import time
from collections import defaultdict, deque

from .parsers import parse_file
from .scanner import HEADER_EXTS, read_text, scan, signature

PY_STDLIB = set(getattr(sys, "stdlib_module_names", ())) | {"__future__"}
NODE_BUILTINS = {
    "fs", "path", "os", "http", "https", "url", "util", "events", "stream", "crypto", "child_process",
    "net", "zlib", "buffer", "assert", "readline", "worker_threads", "cluster", "dns", "tls", "process",
    "querystring", "timers", "module", "vm", "perf_hooks", "string_decoder", "v8", "tty", "dgram",
}
JS_EXTS = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts"]
ENTRY_STEMS = {"main", "app", "index", "server", "__main__", "cli", "run", "manage", "start"}

_parse_cache: dict[tuple, tuple[dict, str]] = {}


class Builder:
    def __init__(self, root: str, exclude: list[str] | None = None):
        self.root = os.path.abspath(root)
        self.exclude = exclude or []

    # ------------------------------------------------------------------ helpers
    def _exists(self, rel: str) -> bool:
        return rel in self.fileset

    def _norm(self, path: str) -> str | None:
        p = posixpath.normpath(path)
        if p.startswith("..") or p.startswith("/"):
            return None
        return "" if p == "." else p

    def _closest(self, src: str, cands: list[str]) -> str | None:
        if not cands:
            return None
        if len(cands) == 1:
            return cands[0]
        sdir = posixpath.dirname(src).split("/")

        def score(c):
            cd = posixpath.dirname(c).split("/")
            n = 0
            for a, b in zip(sdir, cd):
                if a != b:
                    break
                n += 1
            return (n, -abs(len(cd) - len(sdir)))

        cands = sorted(cands, key=score, reverse=True)
        return cands[0] if score(cands[0]) != score(cands[1]) else cands[0]

    def _suffix(self, src: str, spec: str, exts=None) -> str | None:
        s = spec.lstrip("/")
        if not s:
            return None
        options = [s] + [s + e for e in (exts or [])]
        cands = [f for f in self.files_sorted for o in options if f == o or f.endswith("/" + o)]
        return self._closest(src, list(dict.fromkeys(cands)))

    # ------------------------------------------------------------ edge building
    def add_edge(self, src, tgt, kind, uses=(), line=None):
        if not tgt or src == tgt:
            return
        e = self.edges[(src, tgt)]
        e["kinds"].add(kind)
        if line:
            e["lines"].add(line)
        for sym, ln in uses:
            e["symbols"][sym].add(ln)

    def add_external(self, src, name, lang):
        if not name:
            return
        self.externals[(name, lang)].add(src)
        self.node_ext[src].add(name)

    # ----------------------------------------------------------------- python
    def _py_resolve(self, src: str, module: str, level: int) -> str | None:
        parts = [p for p in module.split(".") if p] if module else []
        if level > 0:
            base = posixpath.dirname(src).split("/") if posixpath.dirname(src) else []
            up = level - 1
            if up > len(base):
                return None
            base = base[:len(base) - up] if up else base
            bases = ["/".join(base)]
        else:
            d = posixpath.dirname(src)
            bases = []
            while True:
                bases.append(d)
                if not d:
                    break
                d = posixpath.dirname(d)
            for extra in ("src", "lib"):
                if extra in self.dirset and extra not in bases:
                    bases.append(extra)
        for b in bases:
            path = "/".join([p for p in [b] + parts if p])
            if not path:
                continue
            if self._exists(path + ".py"):
                return path + ".py"
            if parts and self._exists(path + "/__init__.py"):
                return path + "/__init__.py"
            if not parts and self._exists(path + "/__init__.py"):
                return path + "/__init__.py"
        return None

    def _py_is_local_dir(self, src: str, top: str) -> bool:
        d = posixpath.dirname(src)
        while True:
            cand = f"{d}/{top}" if d else top
            if cand in self.dirset:
                return True
            if not d:
                return False
            d = posixpath.dirname(d)

    def link_python(self, src: str, info: dict):
        for imp in info.get("imports", []):
            mod, level = imp["module"], imp["level"]
            if imp["type"] == "from":
                name = imp["name"]
                sub = f"{mod}.{name}" if mod else name
                tgt = self._py_resolve(src, sub, level) if name != "*" else None
                if tgt:
                    uses = imp.get("attr_uses") or []
                    self.add_edge(src, tgt, "import", uses, imp["line"])
                    continue
                tgt = self._py_resolve(src, mod, level)
                if tgt:
                    uses = imp.get("uses") or []
                    if name == "*":
                        uses = [("*", imp["line"])]
                    elif not uses:
                        uses = [(name, imp["line"])]
                    self.add_edge(src, tgt, "import", uses, imp["line"])
                    continue
            else:
                tgt = self._py_resolve(src, mod, 0)
                if tgt:
                    self.add_edge(src, tgt, "import", imp.get("uses") or [], imp["line"])
                    continue
            if level > 0:
                continue
            top = mod.split(".")[0] if mod else ""
            if not top:
                continue
            if top in PY_STDLIB:
                self.node_std[src].add(top)
            elif not self._py_is_local_dir(src, top):
                self.add_external(src, top, "python")

    # -------------------------------------------------------------------- c++
    def link_cpp(self, src: str, info: dict):
        for inc in info.get("includes", []):
            spec = inc["spec"]
            tgt = None
            cand = self._norm(posixpath.join(posixpath.dirname(src), spec))
            if cand and self._exists(cand):
                tgt = cand
            elif self._exists(spec):
                tgt = spec
            else:
                tgt = self._suffix(src, spec)
            if tgt:
                tinfo = self.infos[tgt]
                uses = []
                idents = info.get("idents", {})
                for s in tinfo.get("symbols", []):
                    short = s["name"].split("::")[-1]
                    for ln in idents.get(short, [])[:20]:
                        uses.append((short, ln))
                self.add_edge(src, tgt, "include", uses, inc["line"])
            elif inc["system"]:
                lib = spec.split("/")[0].split(".")[0]
                if "/" in spec or spec.endswith((".h", ".hpp")) and lib not in ("stdio", "stdlib", "string", "math", "assert", "time", "ctype", "errno", "signal", "stdint", "stddef", "stdbool", "limits", "float", "unistd"):
                    self.add_external(src, lib, "cpp")
                else:
                    self.node_std[src].add(spec)
            else:
                self.add_external(src, spec, "cpp")

    # --------------------------------------------------------------------- js
    def _js_try(self, base: str) -> str | None:
        if base is None:
            return None
        if self._exists(base):
            return base
        for e in JS_EXTS:
            if self._exists(base + e):
                return base + e
        for e in JS_EXTS:
            if self._exists(f"{base}/index{e}"):
                return f"{base}/index{e}"
        root, ext = posixpath.splitext(base)
        if ext in (".js", ".jsx", ".mjs"):
            for e in (".ts", ".tsx", ".mts"):
                if self._exists(root + e):
                    return root + e
        return None

    def _resolve_web(self, src: str, spec: str, html_ctx: bool):
        """Return ('file', rel) | ('ext', name) | ('builtin', name) | (None, None)."""
        spec = spec.split("?")[0].split("#")[0].strip()
        if not spec or spec.startswith(("data:", "javascript:", "mailto:", "{{", "{%")):
            return None, None
        if spec.startswith(("http://", "https://", "//")):
            url = spec.split("//", 1)[1]
            if "/npm/" in url:
                name = url.split("/npm/", 1)[1].split("/")[0]
                if name.startswith("@"):
                    name = "/".join(url.split("/npm/", 1)[1].split("/")[:2])
                name = name.rsplit("@", 1)[0] if name.count("@") > (1 if name.startswith("@") else 0) else name
            else:
                name = posixpath.basename(url) or url.split("/")[0]
                for suffix in (".min.js", ".js", ".min.css", ".css"):
                    if name.endswith(suffix):
                        name = name[: -len(suffix)]
            return "ext", name + " (CDN)"
        sdir = posixpath.dirname(src)
        if spec.startswith("/"):
            t = self._js_try(self._norm(spec.lstrip("/"))) or self._suffix(src, spec, JS_EXTS)
            return ("file", t) if t else (None, None)
        if spec.startswith(".") or html_ctx:
            t = self._js_try(self._norm(posixpath.join(sdir, spec)))
            if not t and html_ctx:
                t = self._js_try(self._norm(spec)) or self._suffix(src, spec)
            return ("file", t) if t else (None, None)
        if spec.startswith(("@/", "~/")):
            rest = spec[2:]
            t = self._js_try(self._norm("src/" + rest)) or self._js_try(self._norm(rest))
            return ("file", t) if t else (None, None)
        if spec.startswith("node:") or spec.split("/")[0] in NODE_BUILTINS:
            return "builtin", spec.replace("node:", "").split("/")[0]
        parts = spec.split("/")
        name = "/".join(parts[:2]) if spec.startswith("@") else parts[0]
        return "ext", name

    def link_web(self, src: str, info: dict, lang: str):
        html = lang == "html"
        for imp in info.get("imports", []):
            kind, val = self._resolve_web(src, imp["spec"], False)
            if kind == "file":
                self.add_edge(src, val, "import", imp.get("uses") or [], imp["line"])
            elif kind == "ext":
                self.add_external(src, val, "js")
            elif kind == "builtin":
                self.node_std[src].add(val)
        if not html:
            return
        page_scripts = []
        for sc in info.get("scripts", []):
            kind, val = self._resolve_web(src, sc["spec"], True)
            if kind == "file":
                tinfo = self.infos.get(val, {})
                idents = info.get("idents", {})
                uses = []
                for s in tinfo.get("symbols", []):
                    if s.get("top") and s["kind"] in ("function", "class", "var", "global"):
                        for ln in idents.get(s["name"], [])[:10]:
                            uses.append((s["name"], ln))
                self.add_edge(src, val, "script", uses, sc["line"])
                if not sc["module"]:
                    page_scripts.append(val)
            elif kind == "ext":
                self.add_external(src, val, "js")
        for st in info.get("styles", []):
            kind, val = self._resolve_web(src, st["spec"], True)
            if kind == "file":
                self.add_edge(src, val, "style", [], st["line"])
            elif kind == "ext":
                self.add_external(src, val, "css")
        self.pages.append(page_scripts)

    def link_globals(self):
        """Classic <script> tags on one page share a global scope; link scripts that call each other."""
        for scripts in self.pages:
            for a in scripts:
                ainfo = self.infos.get(a, {})
                own = {s["name"] for s in ainfo.get("symbols", []) if s.get("top")}
                aid = ainfo.get("idents", {})
                for b in scripts:
                    if a == b or (a, b) in self.global_done:
                        continue
                    self.global_done.add((a, b))
                    uses = []
                    for s in self.infos.get(b, {}).get("symbols", []):
                        n = s["name"]
                        if s.get("top") and s["kind"] in ("function", "class", "var", "global") and n not in own and len(n) > 2:
                            for ln in aid.get(n, [])[:10]:
                                uses.append((n, ln))
                    if uses:
                        self.add_edge(a, b, "global", uses)

    def link_refs(self, src: str, info: dict):
        for spec, line in info.get("refs", []):
            if spec.startswith(("http", "//")):
                continue
            cand = self._norm(posixpath.join(posixpath.dirname(src), spec))
            tgt = cand if cand and self._exists(cand) else None
            if not tgt and self._exists(spec.lstrip("/")):
                tgt = spec.lstrip("/")
            if not tgt:
                tgt = self._suffix(src, spec)
            if tgt and tgt != src and (src, tgt) not in self.edges:
                self.ref_edges.append((src, tgt, line))

    # ------------------------------------------------------------------ build
    def build(self) -> dict:
        t0 = time.time()
        scan_stats: dict = {}
        files = scan(self.root, self.exclude, stats=scan_stats)
        self.truncated = scan_stats.get("truncated", False)
        self.sig = signature(files)
        self.files = {f.rel: f for f in files}
        self.fileset = set(self.files)
        self.files_sorted = sorted(self.fileset)
        self.dirset = set()
        for rel in self.fileset:
            d = posixpath.dirname(rel)
            while d:
                self.dirset.add(d)
                d = posixpath.dirname(d)
        self.infos: dict[str, dict] = {}
        self.texts: dict[str, str] = {}
        for f in files:
            key = (f.abs, f.mtime, f.size)
            if key in _parse_cache:
                info, text = _parse_cache[key]
            else:
                text = read_text(f.abs)
                try:
                    info = parse_file(f.lang, f.ext, text)
                except Exception as exc:  # never let one odd file break the graph
                    info = {"doc": None, "symbols": [], "imports": [], "entry": False,
                            "error": f"parser crashed: {exc}"}
                _parse_cache[key] = (info, text)
            self.infos[f.rel] = info
            self.texts[f.rel] = text

        self.edges = defaultdict(lambda: {"kinds": set(), "lines": set(), "symbols": defaultdict(set)})
        self.externals = defaultdict(set)
        self.node_ext = defaultdict(set)
        self.node_std = defaultdict(set)
        self.pages: list[list[str]] = []
        self.global_done: set = set()
        self.ref_edges = []

        for rel, f in self.files.items():
            info = self.infos[rel]
            if f.lang == "python":
                self.link_python(rel, info)
            elif f.lang in ("c", "cpp"):
                self.link_cpp(rel, info)
            else:
                self.link_web(rel, info, f.lang)
        self.link_globals()
        for rel in self.files:
            self.link_refs(rel, self.infos[rel])
        for src, tgt, line in self.ref_edges:
            if (src, tgt) not in self.edges:
                self.add_edge(src, tgt, "ref", [], line)

        entry_from_pkg = self._package_json_mains()
        return self._assemble(entry_from_pkg, time.time() - t0)

    def _package_json_mains(self) -> set[str]:
        mains = set()
        for rel in list(self.dirset) + [""]:
            pj = os.path.join(self.root, rel, "package.json")
            if os.path.exists(pj):
                try:
                    with open(pj, encoding="utf-8") as fh:
                        data = json.load(fh)
                    m = data.get("main")
                    if isinstance(m, str):
                        t = self._js_try(self._norm(posixpath.join(rel, m)))
                        if t:
                            mains.add(t)
                except Exception:
                    pass
        return mains

    # --------------------------------------------------------------- metrics
    def _assemble(self, pkg_mains: set[str], elapsed: float) -> dict:
        ids = self.files_sorted
        out_adj = defaultdict(set)
        in_adj = defaultdict(set)
        for (s, t) in self.edges:
            out_adj[s].add(t)
            in_adj[t].add(s)

        # strongly connected components → cycles (only real imports; shared-global scripts
        # referencing each other both ways is normal and not a "circular import")
        imp_adj = defaultdict(set)
        for (s, t), e in self.edges.items():
            if e["kinds"] & {"import", "include"}:
                imp_adj[s].add(t)
        cyc_comp = self._scc(ids, imp_adj)

        # entry points
        explicit = set()
        for rel in ids:
            info, f = self.infos[rel], self.files[rel]
            stem = posixpath.splitext(posixpath.basename(rel))[0].lower()
            if rel in pkg_mains or (f.lang != "html" and info.get("entry")) or posixpath.basename(rel) == "__main__.py":
                explicit.add(rel)
            elif f.lang == "html" and not in_adj[rel] and out_adj[rel]:
                explicit.add(rel)
            elif stem in ENTRY_STEMS and not in_adj[rel] and out_adj[rel]:
                explicit.add(rel)
        connected = {r for r in ids if out_adj[r] or in_adj[r]}

        # C/C++: foo.cpp implements foo.h — nothing #includes a .cpp, so place it beside its header
        impl_of: dict[str, str] = {}
        for rel in ids:
            f = self.files[rel]
            if f.lang in ("c", "cpp") and f.ext not in HEADER_EXTS and not in_adj[rel] and rel not in explicit:
                stem = posixpath.splitext(posixpath.basename(rel))[0]
                for t in out_adj[rel]:
                    if self.files[t].ext in HEADER_EXTS and posixpath.splitext(posixpath.basename(t))[0] == stem:
                        impl_of[rel] = t
                        break

        roots = [r for r in ids if r in explicit and r in connected]
        if not roots:
            roots = [r for r in ids if r in connected and not in_adj[r] and r not in impl_of]

        depth: dict[str, int] = {}

        def bfs(seeds: list[tuple[str, int]]):
            q = deque()
            for s, d0 in seeds:
                if s not in depth:
                    depth[s] = d0
                    q.append(s)
            while q:
                u = q.popleft()
                for v in sorted(out_adj[u]):
                    if v not in depth:
                        depth[v] = depth[u] + 1
                        q.append(v)

        bfs([(r, 0) for r in roots])
        while True:
            rest = [r for r in ids if r in connected and r not in depth]
            if not rest:
                break
            # implementation files whose header is placed go on the header's ring
            seeds = [(r, depth[impl_of[r]]) for r in rest if r in impl_of and impl_of[r] in depth]
            if seeds:
                bfs(seeds)
                continue
            cands = [r for r in rest if r not in impl_of] or rest
            best = max(cands, key=lambda r: (len(out_adj[r]) - len(in_adj[r]), len(out_adj[r])))
            bfs([(best, 0)])

        pr = self._pagerank(ids, out_adj)

        # folder groups: strip a shared top-level folder so colors stay meaningful
        dirs = [posixpath.dirname(r).split("/") if posixpath.dirname(r) else [] for r in ids]
        strip = 0
        while dirs and all(len(d) > strip for d in dirs) and len({d[strip] for d in dirs}) == 1:
            strip += 1

        nodes = []
        for rel, d in zip(ids, dirs):
            f, info = self.files[rel], self.infos[rel]
            text = self.texts[rel]
            lines = text.count("\n") + (0 if text.endswith("\n") or not text else 1)
            loc = sum(1 for l in text.splitlines() if l.strip())
            group = d[strip] if len(d) > strip else "(root)"
            nodes.append({
                "id": rel,
                "name": posixpath.basename(rel),
                "dir": posixpath.dirname(rel),
                "group": group,
                "lang": f.lang,
                "header": f.ext in HEADER_EXTS,
                "lines": lines,
                "loc": loc,
                "size": f.size,
                "mtime": f.mtime,
                "doc": info.get("doc"),
                "error": info.get("error"),
                "symbols": info.get("symbols", [])[:400],
                "entry": rel in roots,
                "orphan": rel not in connected,
                "depth": depth.get(rel),
                "pagerank": pr.get(rel, 0),
                "indeg": len(in_adj[rel]),
                "outdeg": len(out_adj[rel]),
                "externals": sorted(self.node_ext[rel]),
                "stdlib": sorted(self.node_std[rel]),
                "cycle": cyc_comp.get(rel) is not None,
            })

        edges = []
        for (s, t), e in sorted(self.edges.items()):
            sym_items = sorted(e["symbols"].items(), key=lambda kv: (-len(kv[1]), kv[0]))
            uses = []
            for name, lns in sym_items:
                for ln in sorted(lns)[:25]:
                    uses.append([ln, name])
            cyc = (cyc_comp.get(s) is not None and cyc_comp.get(s) == cyc_comp.get(t)
                   and bool(e["kinds"] & {"import", "include"}))
            edges.append({
                "id": f"{s}->{t}",
                "source": s,
                "target": t,
                "kinds": sorted(e["kinds"]),
                "symbols": [n for n, _ in sym_items][:80],
                "uses": uses[:400],
                "lines": sorted(e["lines"])[:20],
                "cycle": cyc,
            })

        externals = [{"name": n, "lang": lang, "users": sorted(u)} for (n, lang), u in sorted(self.externals.items())]
        return {
            "root": self.root,
            "name": os.path.basename(self.root.rstrip("/")) or self.root,
            "generated": time.time(),
            "buildMs": round(elapsed * 1000),
            "truncated": self.truncated,
            "nodes": nodes,
            "edges": edges,
            "externals": externals,
        }

    @staticmethod
    def _pagerank(ids, out_adj, d=0.85, iters=60):
        n = len(ids)
        if not n:
            return {}
        pr = {i: 1 / n for i in ids}
        for _ in range(iters):
            dangling = sum(pr[i] for i in ids if not out_adj[i])
            new = {i: (1 - d) / n + d * dangling / n for i in ids}
            for i in ids:
                outs = out_adj[i]
                if outs:
                    share = d * pr[i] / len(outs)
                    for t in outs:
                        new[t] += share
            pr = new
        m = max(pr.values()) or 1
        return {k: round(v / m, 4) for k, v in pr.items()}

    @staticmethod
    def _scc(ids, out_adj) -> dict[str, int]:
        """Tarjan's algorithm (iterative). Returns node → component id for components of size > 1."""
        index, low, on, stack, comp = {}, {}, set(), [], {}
        counter = [0]
        cid = 0
        for start in ids:
            if start in index:
                continue
            work = [(start, iter(sorted(out_adj[start])))]
            index[start] = low[start] = counter[0]
            counter[0] += 1
            stack.append(start)
            on.add(start)
            while work:
                v, it = work[-1]
                pushed = False
                for w in it:
                    if w not in index:
                        index[w] = low[w] = counter[0]
                        counter[0] += 1
                        stack.append(w)
                        on.add(w)
                        work.append((w, iter(sorted(out_adj[w]))))
                        pushed = True
                        break
                    elif w in on:
                        low[v] = min(low[v], index[w])
                if pushed:
                    continue
                work.pop()
                if work:
                    low[work[-1][0]] = min(low[work[-1][0]], low[v])
                if low[v] == index[v]:
                    members = []
                    while True:
                        w = stack.pop()
                        on.discard(w)
                        members.append(w)
                        if w == v:
                            break
                    if len(members) > 1:
                        for m in members:
                            comp[m] = cid
                        cid += 1
        return comp


def build_graph(root: str, exclude: list[str] | None = None) -> tuple[dict, dict[str, str], tuple]:
    """Returns (graph JSON, file texts by id, change-detection signature)."""
    b = Builder(root, exclude)
    g = b.build()
    return g, b.texts, b.sig
