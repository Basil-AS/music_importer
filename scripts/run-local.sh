#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
server_port="${MUSIC_IMPORTER_PORT:-8001}"

if [[ "$server_port" != "8000" && "$server_port" != "8001" ]]; then
  printf 'Unsupported port %s. The Chrome extension supports only 8000 and 8001.\n' "$server_port" >&2
  printf 'Try MUSIC_IMPORTER_PORT=8000 ./scripts/run-local.sh\n' >&2
  exit 2
fi

printf 'Music Importer: http://127.0.0.1:%s/\n' "$server_port"
printf 'Chrome extension folder: %s/chrome-extension\n' "$repo_root"
printf 'Stop the server with Ctrl-C.\n'
exec python3 -m http.server "$server_port" --bind 127.0.0.1 --directory "$repo_root/demo"
