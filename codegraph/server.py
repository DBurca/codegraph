"""Tiny local web server: serves the viewer, the graph JSON, file contents, folder picking, and watch mode."""

from __future__ import annotations

import json
import mimetypes
import os
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from .graph import build_graph
from .scanner import LANG_BY_EXT, scan, signature

WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
RECENT_FILE = os.environ.get("CODEGRAPH_RECENT_FILE") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".recent-projects.json")
PROJECT_MARKERS = {".git", "pyproject.toml", "setup.py", "requirements.txt", "package.json", "CMakeLists.txt",
                   "Makefile", "Cargo.toml", "go.mod", "tsconfig.json", "Pipfile", "environment.yml"}


# ------------------------------------------------------------------- recents
def load_recent() -> list[str]:
    try:
        with open(RECENT_FILE, encoding="utf-8") as fh:
            items = json.load(fh)
        return [p for p in items if isinstance(p, str) and os.path.isdir(p)][:12]
    except (OSError, ValueError):
        return []


def remember_recent(path: str):
    items = [p for p in load_recent() if p != path]
    items.insert(0, path)
    try:
        with open(RECENT_FILE, "w", encoding="utf-8") as fh:
            json.dump(items[:12], fh, indent=1)
    except OSError:
        pass


# --------------------------------------------------------------- folder tools
def looks_like_project(path: str) -> bool:
    try:
        with os.scandir(path) as it:
            for i, e in enumerate(it):
                if i > 300:
                    break
                if e.name in PROJECT_MARKERS:
                    return True
                if e.is_file() and os.path.splitext(e.name)[1].lower() in LANG_BY_EXT:
                    return True
    except OSError:
        pass
    return False


def browse(path: str | None) -> dict:
    home = os.path.expanduser("~")
    path = os.path.abspath(os.path.expanduser(path or home))
    while not os.path.isdir(path):
        parent = os.path.dirname(path)
        if parent == path:
            path = home
            break
        path = parent
    dirs, code_here, error = [], 0, None
    try:
        with os.scandir(path) as it:
            for e in it:
                if e.name.startswith("."):
                    continue
                try:
                    if e.is_dir():
                        dirs.append({"name": e.name, "path": e.path})
                    elif os.path.splitext(e.name)[1].lower() in LANG_BY_EXT:
                        code_here += 1
                except OSError:
                    continue
    except PermissionError:
        error = "macOS didn't allow reading this folder. Grant your terminal access in System Settings → Privacy & Security → Files and Folders."
    except OSError as exc:
        error = str(exc)
    dirs.sort(key=lambda d: d["name"].lower())
    dirs = dirs[:600]
    if len(dirs) <= 150:  # cheap enough to flag which subfolders look like code projects
        for d in dirs:
            d["project"] = looks_like_project(d["path"])
    parent = os.path.dirname(path)
    return {"path": path, "parent": parent if parent != path else None, "home": home, "sep": os.sep,
            "dirs": dirs, "codeHere": code_here, "isProject": looks_like_project(path), "error": error}


def native_picker_available() -> bool:
    if sys.platform == "darwin":
        return bool(shutil.which("osascript"))
    if sys.platform.startswith("win"):
        return bool(shutil.which("powershell"))
    return bool(shutil.which("zenity") or shutil.which("kdialog"))


def native_pick(start: str | None) -> str | None:
    """Show the OS folder dialog (on this machine — the server is always local). None = cancelled."""
    prompt = "Choose a project folder for CodeGraph"
    if sys.platform == "darwin":
        script = f'POSIX path of (choose folder with prompt "{prompt}"'
        if start and os.path.isdir(start):
            safe = start.replace("\\", "\\\\").replace('"', '\\"')
            script += f' default location (POSIX file "{safe}")'
        script += ")"
        # bare `activate` brings osascript's dialog to the front without needing Automation permission
        cmd = ["osascript", "-e", "activate", "-e", script]
    elif sys.platform.startswith("win"):
        ps = ("Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; "
              f"$d.Description = '{prompt}'; $d.ShowNewFolderButton = $false; "
              "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }")
        cmd = ["powershell", "-NoProfile", "-STA", "-Command", ps]
    elif shutil.which("zenity"):
        cmd = ["zenity", "--file-selection", "--directory", f"--title={prompt}"]
    elif shutil.which("kdialog"):
        cmd = ["kdialog", "--getexistingdirectory", start or os.path.expanduser("~"), "--title", prompt]
    else:
        raise RuntimeError("No native folder dialog on this system")
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    out = r.stdout.strip()
    if r.returncode != 0 or not out:
        return None
    return out.rstrip("/\\") or out


# --------------------------------------------------------------------- state
class State:
    def __init__(self, root: str | None, exclude: list[str]):
        self.root: str | None = None
        self.exclude = exclude
        self.lock = threading.Lock()        # guards the published graph
        self.build_lock = threading.Lock()  # one build at a time (watcher vs. project switch)
        self.version = 0
        self.graph: dict = {}
        self.texts: dict[str, str] = {}
        self.sig = None
        if root:
            self.open(root)

    def open(self, root: str) -> dict:
        root = os.path.abspath(os.path.expanduser(root))
        if not os.path.isdir(root):
            raise ValueError(f"Not a folder: {root}")
        with self.build_lock:
            graph, texts, sig = build_graph(root, self.exclude)
            with self.lock:
                self.root, self.graph, self.texts, self.sig = root, graph, texts, sig
                self.version += 1
                graph["version"] = self.version
                graph["changed"] = []
        remember_recent(root)
        print(f"  ▸ {root}: {len(graph['nodes'])} files · {len(graph['edges'])} links · {graph['buildMs']} ms")
        return graph

    def rebuild(self):
        with self.build_lock:
            root = self.root
            if not root or not os.path.isdir(root):
                return
            if signature(scan(root, self.exclude)) == self.sig:
                return
            old = {n["id"]: n["mtime"] for n in self.graph.get("nodes", [])}
            graph, texts, sig = build_graph(root, self.exclude)
            with self.lock:
                self.graph, self.texts, self.sig = graph, texts, sig
                self.version += 1
                graph["version"] = self.version
                new = {n["id"]: n["mtime"] for n in graph["nodes"]}
                graph["changed"] = sorted([k for k in new if old.get(k) != new[k]] + [k for k in old if k not in new])
        print(f"  ↻ graph updated ({len(graph['changed'])} file(s) changed)")

    def watch(self, interval=1.5):
        while True:
            time.sleep(interval)
            try:
                self.rebuild()
            except Exception as exc:  # keep watching even if a rebuild fails mid-save
                print(f"  ! rebuild failed: {exc}", file=sys.stderr)


# ------------------------------------------------------------------- handler
def make_handler(state: State, port_ref: list[int]):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # quiet
            pass

        def _send(self, code, body: bytes, ctype="application/json"):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, obj, code=200):
            self._send(code, json.dumps(obj).encode("utf-8"))

        def _trusted(self) -> bool:
            """Only answer pages served from this server (blocks DNS-rebinding / cross-site requests)."""
            host = (self.headers.get("Host") or "").lower()
            ok_hosts = {f"127.0.0.1:{port_ref[0]}", f"localhost:{port_ref[0]}", f"[::1]:{port_ref[0]}"}
            if host not in ok_hosts:
                self._send(403, b"forbidden host", "text/plain")
                return False
            return True

        def _body(self) -> dict | None:
            if "application/json" not in (self.headers.get("Content-Type") or ""):
                self._json({"error": "expected JSON"}, 415)
                return None
            length = int(self.headers.get("Content-Length") or 0)
            try:
                return json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                self._json({"error": "bad json"}, 400)
                return None

        def do_GET(self):
            if not self._trusted():
                return
            url = urlparse(self.path)
            q = parse_qs(url.query)
            if url.path == "/api/graph":
                with state.lock:
                    if not state.root:
                        return self._json({"root": None, "version": state.version})
                    return self._json(state.graph)
            if url.path == "/api/version":
                return self._json({"version": state.version})
            if url.path == "/api/status":
                return self._json({"root": state.root, "version": state.version, "recent": load_recent(),
                                   "nativePicker": native_picker_available(), "home": os.path.expanduser("~")})
            if url.path == "/api/browse":
                return self._json(browse((q.get("path") or [None])[0]))
            if url.path == "/api/file":
                fid = (q.get("id") or [""])[0]
                with state.lock:
                    text = state.texts.get(fid)
                if text is None:
                    return self._json({"error": "unknown file"}, 404)
                return self._json({"id": fid, "text": text})
            # static viewer files
            rel = url.path.lstrip("/") or "index.html"
            path = os.path.normpath(os.path.join(WEB_DIR, rel))
            if not path.startswith(WEB_DIR) or not os.path.isfile(path):
                return self._send(404, b"not found", "text/plain")
            ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
            with open(path, "rb") as fh:
                self._send(200, fh.read(), ctype + ("; charset=utf-8" if ctype.startswith(("text/", "application/javascript")) else ""))

        def do_POST(self):
            if not self._trusted():
                return
            url = urlparse(self.path)
            body = self._body()
            if body is None:
                return
            if url.path == "/api/project":
                try:
                    g = state.open(str(body.get("path") or ""))
                except ValueError as exc:
                    return self._json({"ok": False, "error": str(exc)}, 400)
                except Exception as exc:
                    return self._json({"ok": False, "error": f"Could not read that folder: {exc}"}, 500)
                return self._json({"ok": True, "root": g["root"], "files": len(g["nodes"]), "truncated": g["truncated"]})
            if url.path == "/api/pick":
                try:
                    picked = native_pick(body.get("start") or state.root)
                except Exception as exc:
                    return self._json({"ok": False, "error": str(exc)})
                return self._json({"ok": True, "path": picked})
            if url.path == "/api/open":
                fid, line = body.get("id", ""), int(body.get("line") or 1)
                with state.lock:
                    known = fid in state.texts
                    root = state.root
                if not known or not root:
                    return self._json({"error": "unknown file"}, 404)
                return self._json(open_in_editor(os.path.join(root, fid), line))
            return self._json({"error": "not found"}, 404)

    return Handler


def open_in_editor(path: str, line: int) -> dict:
    for cli in ("code", "cursor"):
        exe = shutil.which(cli)
        if exe:
            subprocess.Popen([exe, "-g", f"{path}:{line}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return {"ok": True, "editor": cli}
    if sys.platform == "darwin":
        subprocess.Popen(["open", path])
        return {"ok": True, "editor": "default app"}
    if sys.platform.startswith("win"):
        os.startfile(path)  # type: ignore[attr-defined]
        return {"ok": True, "editor": "default app"}
    subprocess.Popen(["xdg-open", path])
    return {"ok": True, "editor": "default app"}


def serve(root: str | None, port: int, exclude: list[str], open_browser: bool, watch: bool):
    print("CodeGraph")
    state = State(root, exclude)
    if not root:
        print("  no folder given: pick one in the browser")

    port_ref = [port]
    server = None
    for p in range(port, port + 20):
        try:
            port_ref[0] = p
            server = ThreadingHTTPServer(("127.0.0.1", p), make_handler(state, port_ref))
            break
        except OSError:
            continue
    if server is None:
        sys.exit(f"No free port in {port}-{port + 19}")

    if watch:
        threading.Thread(target=state.watch, daemon=True).start()
    url = f"http://127.0.0.1:{port_ref[0]}/"
    print(f"  open {url}   (Ctrl+C to stop)")
    if open_browser:
        import webbrowser
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
