"""CLI:  python3 -m codegraph <folder> [--port N] [--exclude GLOB ...] [--json out.json]"""

import argparse
import json
import os
import sys

from .graph import build_graph
from .server import serve


def main(argv=None):
    ap = argparse.ArgumentParser(prog="codegraph", description="Interactive dependency graph for a code folder.")
    ap.add_argument("folder", nargs="?", default=None,
                    help="project folder or repo to graph (omit it to pick one in the browser)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--exclude", "-x", action="append", default=[], metavar="GLOB",
                    help="skip files/folders matching this glob (repeatable), e.g. -x 'tests/*' -x assets")
    ap.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    ap.add_argument("--no-watch", action="store_true", help="don't live-reload when files change")
    ap.add_argument("--json", metavar="FILE", help="write the graph JSON to FILE and exit")
    args = ap.parse_args(argv)

    if args.folder is not None and not os.path.isdir(args.folder):
        sys.exit(f"Not a folder: {args.folder}")
    if args.json:
        if args.folder is None:
            sys.exit("--json needs a folder")
        graph = build_graph(args.folder, args.exclude)[0]
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(graph, fh, indent=1)
        print(f"wrote {args.json}: {len(graph['nodes'])} nodes, {len(graph['edges'])} edges")
        return
    serve(args.folder, args.port, args.exclude, not args.no_browser, not args.no_watch)


if __name__ == "__main__":
    main()
