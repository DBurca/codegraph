"""Walk a project folder and collect the source files CodeGraph understands."""

from __future__ import annotations

import fnmatch
import os
from dataclasses import dataclass

LANG_BY_EXT = {
    ".py": "python", ".pyw": "python",
    ".c": "c", ".h": "cpp", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp",
    ".hpp": "cpp", ".hh": "cpp", ".hxx": "cpp", ".ino": "cpp",
    ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "js",
    ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts",
    ".html": "html", ".htm": "html",
    ".css": "css",
}

HEADER_EXTS = {".h", ".hpp", ".hh", ".hxx"}

# Directory names that are never project source.
SKIP_DIRS = {
    "node_modules", "__pycache__", "site-packages", "dist", "build", "out",
    "venv", "env", "bower_components", "vendor", "third_party", "target",
    "coverage", "htmlcov", "egg-info",
}

SKIP_FILE_GLOBS = ["*.min.js", "*.min.css", "*.bundle.js", "*.chunk.js", "*-min.*.js", "*.d.ts"]

MAX_FILE_BYTES = 1_500_000


@dataclass
class SourceFile:
    rel: str          # posix-style path relative to the project root
    abs: str
    lang: str
    ext: str
    size: int
    mtime: float


def _looks_minified(path: str) -> bool:
    try:
        with open(path, "rb") as fh:
            head = fh.read(8192)
    except OSError:
        return True
    if not head:
        return False
    lines = head.split(b"\n")
    longest = max(len(l) for l in lines)
    return longest > 2000 or (len(head) > 4000 and len(lines) < 4)


def _is_venv(dirpath: str) -> bool:
    return os.path.exists(os.path.join(dirpath, "pyvenv.cfg"))


MAX_FILES = 3000      # stop collecting after this many source files…
MAX_DIRS = 15000      # …or after walking this many folders (someone picked their home folder)


def scan(root: str, exclude: list[str] | None = None, include_hidden: bool = False,
         stats: dict | None = None) -> list[SourceFile]:
    root = os.path.abspath(root)
    exclude = exclude or []
    out: list[SourceFile] = []
    dirs_seen = 0
    if stats is not None:
        stats["truncated"] = False
    for dirpath, dirnames, filenames in os.walk(root):
        dirs_seen += 1
        if len(out) >= MAX_FILES or dirs_seen > MAX_DIRS:
            if stats is not None:
                stats["truncated"] = True
            break
        rel_dir = os.path.relpath(dirpath, root)
        rel_dir = "" if rel_dir == "." else rel_dir.replace(os.sep, "/")
        keep = []
        for d in sorted(dirnames):
            rel_d = f"{rel_dir}/{d}" if rel_dir else d
            if not include_hidden and d.startswith("."):
                continue
            # "*_files" = assets folder from a browser "Save page as…" (vendor JS, not your code)
            if d in SKIP_DIRS or d.endswith(".egg-info") or d.endswith("_files"):
                continue
            if any(fnmatch.fnmatch(rel_d, pat) or fnmatch.fnmatch(d, pat) for pat in exclude):
                continue
            if _is_venv(os.path.join(dirpath, d)):
                continue
            keep.append(d)
        dirnames[:] = keep

        for f in sorted(filenames):
            ext = os.path.splitext(f)[1].lower()
            lang = LANG_BY_EXT.get(ext)
            if not lang:
                continue
            if any(fnmatch.fnmatch(f, pat) for pat in SKIP_FILE_GLOBS):
                continue
            rel = f"{rel_dir}/{f}" if rel_dir else f
            if any(fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(f, pat) for pat in exclude):
                continue
            abs_path = os.path.join(dirpath, f)
            try:
                st = os.stat(abs_path)
            except OSError:
                continue
            if st.st_size > MAX_FILE_BYTES:
                continue
            if f == "__init__.py" and st.st_size < 3:  # empty package markers just add clutter
                continue
            if lang in ("js", "css", "ts") and _looks_minified(abs_path):
                continue
            out.append(SourceFile(rel, abs_path, lang, ext, st.st_size, st.st_mtime))
    return out


def signature(files: list[SourceFile]) -> tuple:
    """Cheap fingerprint used by watch mode to detect changes."""
    return tuple((f.rel, f.mtime, f.size) for f in files)


def read_text(path: str) -> str:
    with open(path, "rb") as fh:
        data = fh.read()
    for enc in ("utf-8", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", "replace")
