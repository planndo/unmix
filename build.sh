#!/bin/sh
# Generates studio.html (a full HTML document for static hosting) from page.html.
# page.html is the source of truth; it is also what gets published as the Claude artifact,
# whose host adds the document skeleton itself. index.html is the separate marketing page.
set -e
cd "$(dirname "$0")"
{
  printf '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
  printf '<link rel="icon" href="favicon.svg" type="image/svg+xml">\n<link rel="manifest" href="manifest.webmanifest">\n'
  printf '<!-- Enables cross-origin isolation on static hosts (GitHub Pages) so the CPU engine can use multiple threads -->\n<script src="coi-serviceworker.min.js"></script>\n'
  printf '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%%}[hidden]{display:none!important}</style>\n</head>\n<body>\n'
  cat page.html
  printf '\n</body>\n</html>\n'
} > studio.html
echo "studio.html built"
