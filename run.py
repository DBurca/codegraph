#!/usr/bin/env python3
"""Run CodeGraph from anywhere:  python3 /path/to/CodeGraph/run.py <folder>"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from codegraph.__main__ import main  # noqa: E402

if __name__ == "__main__":
    main()
