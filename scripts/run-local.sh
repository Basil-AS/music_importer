#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
server_port="${MUSIC_IMPORTER_PORT:-8001}"

printf 'Music Importer: http://127.0.0.1:%s/\n' "$server_port"
printf 'Chrome extension folder: %s/chrome-extension\n' "$repo_root"
printf 'Stop the server with Ctrl-C.\n'
exec python3 -m http.server "$server_port" --bind 127.0.0.1 --directory "$repo_root/demo"
