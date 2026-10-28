# Spotify Web Player connector

## Назначение и статус

Chrome MV3 connector читает персональную библиотеку из уже открытого Spotify Web Player: Liked Songs и каталог пользовательских плейлистов с их треками. Подключение локальное; тот же page-session connector теперь поддерживает экспериментальный writer (см. [`SPOTIFY_TRANSFER.md`](SPOTIFY_TRANSFER.md)). У Spotify используется внутренний Pathfinder/GraphQL контракт Web Player, поэтому это исследовательский adapter без публичного API SLA; код не является проверенным production adapter. До live проверки на аккаунте не обещаем полноту или стабильность.

## Поток данных

1. Пользователь открывает Spotify Web Player и входит обычным способом. Можно одновременно открыть вкладки остальных поддерживаемых сервисов.
2. Нажимает кнопку **Music Importer** в панели Chrome. Приложение внутри расширения автоматически запускает общий скан всех открытых сервисов; отдельно выбирать Spotify для начала чтения не нужно.
3. Extension bridge просит уже открытую вкладку прочитать текущую библиотеку. Если вкладка не получила content script после установки/обновления расширения, service worker перезагрузит её один раз и повторит запуск.
4. Main-world observer получает только нужные request headers из fetch вызовов самой страницы Spotify. Заголовки остаются в closure страницы и не отправляются в Chrome storage, popup, app, журнал или локальный HTTP сервер.
5. Page connector постранично читает Liked Songs (`fetchLibraryTracks`), список playlists (`libraryV3`) и содержимое каждого playlist (`fetchPlaylistContents`). Изолированный bridge передаёт только нормализованный snapshot.
6. Service worker принимает сообщения только от extension content script с origin `https://open.spotify.com`, проверяет полноту каталога, избранного и каждого playlist, хранит последний snapshot локально и отдаёт его Music Importer app. Выберите Spotify как источник или цель после завершения общего сканирования.

## Полнота и сохранение данных

- Все страницы читаются до provider `totalCount`, без собственного лимита на размер библиотеки; запросы ограничены паузой, а HTTP 429 обрабатывается с `Retry-After` и backoff.
- При несовпадении totals, пустой ранней странице, повторном изменении totals или неполном playlist scan snapshot не подтверждается и импорт блокируется.
- Favorites проверяются на уникальность Spotify track URI. Playlist items сохраняются по порядку и с повторениями, пустые playlists сохраняются.
- PathFinder persisted-query hashes сначала обновляются по наблюдаемым запросам Player, затем сверяются с доступными Web Player bundle; если Spotify явно вернул `PersistedQueryNotFound`, выполняется одна попытка обновить hash.
- Перед каждым разделом и страницей показывается актуальный этап. Один сетевой запрос ограничен 45 секундами; загрузка Web Player bundle для поиска hash — 15 секундами. Во время `Retry-After` скан сообщает оставшееся ожидание, чтобы inactivity watchdog не принял активный backoff за зависание.
- В snapshot передаются Spotify URI, title, artists, album, ISRC если есть, duration и playlist positions. OAuth tokens, cookies, session headers и raw request bodies в app не попадают.

## Ограничения

- Это private Web Player API, который Spotify может менять в любой момент. HTTP 401/403, GraphQL errors и неизвестная схема завершают сбор явной ошибкой.
- Для первого запроса Web Player должен уже выполнить запрос Pathfinder в текущей вкладке. Если заголовки ещё не наблюдались, откройте Spotify раздел с вашей библиотекой и повторите.
- Комплект проверен только статически и mock/syntax проверками; пользовательский Spotify аккаунт и live endpoints в этой итерации не вызывались. В README и UI этот путь следует считать экспериментальным до live read-only sweep.
- Live smoke scan ранее дошёл до конца Liked Songs и завис до подтверждённого snapshot. Добавлены сообщения перед запросом каталога плейлистов и перед страницами плейлистов, а также ограничение времени ожидания одного запроса. Это изменение прошло fixture-тесты, но ещё требует повторного live scan после Reload расширения.
- Все Spotify API paths остаются экспериментальными. Статические fixtures не доказывают live чтение, поиск или запись в аккаунт. Автоматический matcher и пакетная orchestration существуют, но точность и скорость на тысячах треков ещё не измерены.

## Локальный запуск

Установите unpacked extension из `chrome-extension/` в Chrome Developer Mode. После изменения extension нажмите Reload на странице `chrome://extensions`, затем снова откройте Spotify Web Player и нажмите кнопку Music Importer в панели Chrome. Основной интерфейс открывается внутри расширения и не требует localhost-разрешения. Данные остаются локально; если пользовательский snapshot не подтверждён, его не передаём в matcher.
