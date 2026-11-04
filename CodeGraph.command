#!/bin/bash
# Double-click in Finder to start CodeGraph, then pick a project folder in the browser.
cd "$(dirname "$0")" && exec python3 run.py "$@"
