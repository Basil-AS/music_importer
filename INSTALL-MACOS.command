#!/bin/zsh
set -eu

ROOT_DIR="${0:A:h}"
EXTENSION_DIR="$ROOT_DIR/chrome-extension"

if [[ ! -f "$EXTENSION_DIR/manifest.json" ]]; then
  print -u2 "Не найдена папка chrome-extension рядом с этим файлом. Сначала распакуйте архив полностью."
  exit 1
fi

if ! open -Ra "Google Chrome"; then
  print -u2 "Google Chrome не найден. Установите Chrome и повторите запуск."
  exit 1
fi

open -a "Google Chrome" "chrome://extensions"
open "$EXTENSION_DIR"

cat <<'EOF'

Установка Music Importer:
1. В Chrome включите «Режим разработчика».
2. Нажмите «Загрузить распакованное».
3. Выберите открытую в Finder папку chrome-extension.
4. Нажмите значок Music Importer — приложение проверит открытые вкладки Spotify, Apple Music, Яндекс Музыки и Звука.

Chrome просит это подтверждение для любого локально установленного расширения.
Пароли, cookie и токены не вводите в окно Music Importer.
EOF

read -k 1 "?Нажмите любую клавишу, чтобы закрыть это окно…"
print
