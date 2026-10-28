#!/usr/bin/env python3
"""Builds the other copies of the tracker from index.html, which stays the one source.

  docs/index.html   the installable app (GitHub Pages): APP_BUILD = true, a full HTML document
  <test-copy path>  the claude.ai test copy: TEST_COPY = true and its own title (optional argument)

Usage: python3 tools/build.py [path/for/test-copy.html]
"""
import pathlib, sys

root = pathlib.Path(__file__).resolve().parent.parent
src = (root / "index.html").read_text()

def swap(text, old, new):
    if text.count(old) != 1:
        sys.exit(f"build: expected exactly one {old!r} in index.html")
    return text.replace(old, new)

HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0E2130">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Residency">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" type="image/png" href="icon-192.png">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<style>:root{box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
"""

app = swap(src, "const APP_BUILD = false;", "const APP_BUILD = true;")
app = swap(app, '<div id="app"></div>', '</head>\n<body>\n<div id="app"></div>')
(root / "docs" / "index.html").write_text(HEAD + app.rstrip() + "\n</body>\n</html>\n")
print("built docs/index.html")

if len(sys.argv) > 1:
    test = swap(src, "<title>Neurosurgery Residency Tracker</title>", "<title>Residency Tracker Test Copy</title>")
    test = swap(test, "const TEST_COPY = false;", "const TEST_COPY = true;")
    pathlib.Path(sys.argv[1]).write_text(test)
    print("built", sys.argv[1])
