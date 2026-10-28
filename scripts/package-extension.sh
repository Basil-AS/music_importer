#!/usr/bin/env bash
# Builds the Chrome Web Store / Edge Add-ons upload archive (manifest.json at the zip root).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node "$repo_root/scripts/build-extension-app.mjs" --check

version="$(node -e "console.log(JSON.parse(require('node:fs').readFileSync('$repo_root/chrome-extension/manifest.json','utf8')).version)")"
out_dir="$repo_root/distribution"
archive="$out_dir/music-importer-$version.zip"

mkdir -p "$out_dir"
rm -f "$archive"
(cd "$repo_root/chrome-extension" && zip -qr "$archive" . -x '*.DS_Store' 'INSTALL.txt')
printf 'Built %s\n' "$archive"
