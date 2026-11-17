#!/usr/bin/env bash
# Pack the extension into dist/kiki-chrome-<version>.zip (only the files Chrome loads).
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p "require('./manifest.json').version")
mkdir -p dist
out="dist/kiki-chrome-${version}.zip"
rm -f "$out"
zip -qr "$out" manifest.json popup.html icons src LICENSE
echo "$out"
