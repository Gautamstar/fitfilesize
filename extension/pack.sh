#!/bin/sh
# Builds the zip to upload to the Chrome Web Store and Edge Add-ons: only the
# files the extension runs, without tests or store material.
set -e
cd "$(dirname "$0")"
version=$(node -p "require('./manifest.json').version")
out="../dist/fitfilesize-extension-$version.zip"
mkdir -p ../dist
rm -f "$out"
zip -q -r "$out" manifest.json background.js content.js limits.js fit.html fit.js popup.html popup.js welcome.html welcome.js icons
echo "$out"
