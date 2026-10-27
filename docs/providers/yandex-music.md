# Яндекс Музыка API

Статус: исходники актуальной community-библиотеки и её документация просмотрены 27.10.2026. API неофициальный и обратным проектированием восстановлен сообществом; официального открытого Web API для этой интеграции не найдено.

## Библиотека и авторизация

Основной кандидат — [MarshalX/yandex-music-api](https://github.com/MarshalX/yandex-music-api), LGPL-3.0. В проверенном срезе GitHub: последний опубликованный релиз `v3.2.2`, исходный commit `9ca132e` (2026-10-11), репозиторий обновлялся 2026-10-26. Поддерживает sync/async клиент; OpenAPI справочник, генерируемый из реализации библиотеки, описывает около 150 операций и 220 схем. Сверяйте детали с конкретной версией перед реализацией.

В библиотеке есть OAuth Device Flow. `POST https://oauth.yandex.ru/device/code` передаёт form-urlencoded `client_id`, `device_id` и `device_name`; по умолчанию библиотека генерирует `device_id` из 10 символов, а имя задаёт `YandexMusicAPI`. Ответная модель описана полями `device_code`, `user_code`, `verification_url`, `expires_in` и `interval`. Пользователь открывает verification URL и подтверждает код на домене Яндекса.

Затем библиотека делает `POST https://oauth.yandex.ru/token` с form-urlencoded полями `grant_type=device_code`, `code`, `client_id` и `client_secret`. В проверенном commit вшиты credentials публичного Android-клиента Яндекс Музыки; это не credentials, выданные нашему приложению, и встроенный `client_secret` нельзя считать секретом проекта. Значения самих credentials в документацию не копируем. Polling следует выполнять с интервалом `interval` и до срока `expires_in` из device-code ответа: `authorization_pending` возвращается как `None`, а `expired_token`, `access_denied`, `invalid_client` и другие OAuth ошибки приводят к `DeviceAuthError`. Блокирующий helper также поддерживает timeout и отмену. При успехе он записывает access token в клиент и добавляет `Authorization: OAuth <token>`.

Ответ token-модели содержит `access_token`, `refresh_token`, `expires_in` и `token_type`, но эта библиотека не сохраняет токены и не обновляет access token автоматически. Хранение и срок жизни — ответственность приложения; поведение refresh token этим клиентом не реализовано. Device Flow в пользовательском аккаунте не запускали. Некоторые аккаунты/регионы/режимы могут не пройти этот неофициальный flow.

Вход через логин/пароль не нужен для рекомендуемого прототипа. Токен — секрет; не коммитить и не печатать в лог.

## Операции с лайками

В этой версии библиотека реализует следующие HTTP-шаблоны (это reverse-engineered контракт библиотеки, не официальная спецификация Яндекса):

- `GET /users/{user_id}/likes/tracks` — список лайкнутых треков (`users_likes_tracks()`); если `user_id` не передан, библиотека использует UID текущего аккаунта. Метод по умолчанию отправляет `if-modified-since-revision=0`. Код и community OpenAPI не описывают `offset`, `limit` или cursor для этой операции.
- Ответ описан как `TracksList { uid, revision, tracks[] }`, где элементы — `TrackShort`; у модели нет page/cursor полей. `revision` описан авторами как актуальность списка, но его семантика в коде помечена TODO. Следовательно, выгрузку нельзя считать полной только по наличию ответа: отдельно сверять browser-side count, число коротких refs и последующие metadata responses.
- `POST /users/{user_id}/likes/tracks/add-multiple` и `/remove` — изменить лайк (`users_likes_tracks_add`/`_remove`). Community OpenAPI указывает `application/x-www-form-urlencoded` и поле `track-ids` (описанное как string), не JSON. Библиотека принимает ID как list/string/int и передаёт словарь через `requests` `data=`; точный wire format списка и то, какие варианты принимает сервер, требуют отдельной контролируемой проверки. Максимальный размер пачки также не зафиксирован.
- `POST /tracks` — получить карточки по набору ID; community OpenAPI также помечает тело как `application/x-www-form-urlencoded`, поля `track-ids` и `with-positions`. В ранее проверенном единичном terminal-запросе form body `track-ids=<id>` вернул карточку; JSON-array формат дал `400`.

Реализация `_like_action` считает операцию успешной по наличию `revision` в ответе для треков. В изученном исходнике не обнаружено зафиксированного стабильного максимального размера пачки: его нельзя предполагать, нужно выяснять тестом и учитывать ответы сервиса.

### Другой рабочий клиент: `yandex-music-transfer`

В репозитории [yarikmsu/yandex-music-transfer](https://github.com/yarikmsu/yandex-music-transfer), HEAD `eb88366` (2026-10-20, MIT), exporter использует тот же список лайков, но отдельный legacy flow: пользователь получает access token по URL с `response_type=token` и client ID официального Android-приложения. README уточняет, что этот client ID не опубликован Яндексом для сторонних интеграций. Это не Device Flow из MarshalX-библиотеки и не официально зарегистрированное приложение нашего проекта.

По исходнику `exporter/fetch_tracks.py` exporter вызывает `GET /account/status`, `GET /users/{uid}/likes/tracks`, `POST /tracks` с `application/x-www-form-urlencoded` и `track-ids=<comma-separated IDs>`, а для плейлистов — `GET /users/{uid}/playlists/list` и `GET /users/{uid}/playlists/{kind}`. Карточки лайков батчатся по 100; экспортируются CSV с ID и метаданными. Эти routes совпадают с нашими read-only terminal probes, но это только статическая сверка кода: данный exporter не запускали.

Из этого проекта стоит взять формат полного offline экспорта/ручной сверки. Не перенимать implicit-token URL и постоянное хранение access token в `.env` как основную auth-архитектуру; предпочтительнее Device Flow с локальным защищённым token store и ясным revoke path.

### Дополнительный CSV exporter: `nevdev-ml/yandex-music-exporter`

В репозитории [nevdev-ml/yandex-music-exporter](https://github.com/nevdev-ml/yandex-music-exporter), MIT, просмотренный HEAD `78a081a` (последнее обновление GitHub — 13.03.2026), найдены экспорт лайкнутых/дизлайкнутых треков, альбомов и артистов. Треки читаются через `users_likes_tracks().fetch_tracks()` из `yandex-music`; CSV содержит название, артиста, альбом и ID, сохраняется UTF-8 BOM. Выходные файлы автоматически разбиваются на части до 500 строк — это ограничение формата файла, а не заявленный лимит выгрузки. Код сортирует записи по артисту, поэтому исходный порядок лайков теряется; ISRC не экспортируется.

Авторизация открывает отдельный Selenium Chrome по implicit URL (`response_type=token`) с client ID публичного Android-приложения, извлекает access token из callback URL и записывает его в `.env` через `python-dotenv`. Источник прямо заявляет, что client ID не является credential нашего приложения; режим прав файла не задаётся, а токен в URL/файле нужно считать секретом. Код просмотрен статически, не запускался. Полезен как CSV-exporter/reference на методы библиотеки, но не как готовый Apple importer или образец безопасной авторизации.

### Прямой pipeline: `ComputerPers/YandexMusic_to_AppleMusic`

В [ComputerPers/YandexMusic_to_AppleMusic](https://github.com/ComputerPers/YandexMusic_to_AppleMusic), проверенный HEAD `41fdd0e` от 07.04.2026 (GitHub не показывает объявленную лицензию), экспорт вызывает `users_likes_tracks()`, затем запрашивает подробности через `POST /tracks` батчами по 100. JSON сохраняет Yandex ID, title, artists, album, duration; CSV опускает внутренний список артистов. ISRC и исходный порядок/позиции лайков не сохраняются. Сам лимит списка лайков не проверен; в используемой библиотеке нет явной cursor-пагинации.

Сопоставление идёт через публичный `GET https://itunes.apple.com/search` (`term`, `media=music`, `entity=song`, `limit`, `country`), ищет в `ru` и `us`, запрашивает до 25 результатов и использует нормализацию плюс substring-проверку title/artist. ISRC-first стратегии нет. Результаты можно проверить по JSON/отчёту несовпадений и продолжить после прерывания; matcher делает несколько поисков на трек с задержкой 3,5 секунды.

Apple API-вариант проверяет `GET /v1/me/library/songs?limit=1`, добавляет catalog song IDs через `POST /v1/me/library?ids[songs]=...` порциями по 25 и может создать playlist через `POST /v1/me/library/playlists`, затем дополнять `POST /v1/me/library/playlists/{id}/tracks`. Принятие в библиотеку считается успешным при HTTP 202. Ни этот writer, ни AppleScript-вариант не вызывают Favorite Songs route `/v1/me/favorites`: они добавляют в Library и отдельный playlist, поэтому сохранённые исходные лайки не становятся Apple Favorites.

Локальный writer открывает `music://` track URL, запускает воспроизведение и дублирует current track в Library и playlist. Поиск для playlist сначала использует название+артиста, затем fallback только по названию; это может выбрать неверную одноимённую запись. Режима установить `track.favorited` в просмотренном коде нет.

Токенный helper не является надёжным Chrome extractor на macOS: он копирует целиком SQLite Cookies database во временный файл, ищет `media-user-token`, а для encrypted value с префиксом `v10` сразу останавливается с инструкцией скопировать cookie вручную; temporary copy удаляется в `finally`. В коде нет вызова Keychain/decryption. Для иных префиксов он пробует UTF-8 decode, что не доказывает успешную расшифровку. Developer token скрейпится из JavaScript bundle `beta.music.apple.com` и частично печатается; при `--save` оба токена записываются открытым текстом без задания ограниченного file mode (файлы лишь перечислены в `.gitignore`). `--dry-run` в API-варианте всё ещё загружает токены и выполняет auth-check до выхода. Это полезный reference на общий экспорт→match→review pipeline, но не готовый import в Favorite Songs и не образец session/token handling.

Дополнительная реализация в [oklookat/synchro](https://github.com/oklookat/synchro), HEAD `ac441f4` от 2024-07-07 (GPL-3.0), использует Go-клиент `goym`: OAuth Device Flow с credentials публичного Android-клиента, чтение `LikedTracks`, загрузку metadata пачками по 30 и методы `LikeTracks`/`UnlikeTracks`. В просмотренной версии `LikedTracks` отбрасывает UGC записи; это означает, что такой экспорт не гарантированно сохраняет весь список лайков. Код старый и хранит auth в SQLite без шифрования, поэтому годится только как reference операций, не как готовое приложение.

## Практическая проверка

- В авторизованной вкладке Chrome видимый раздел коллекции «Мне нравится» открылся. Наблюдались `GET https://api.music.yandex.ru/playlist/lk.:liked-id` и `POST https://api.music.yandex.ru/tracks`, оба `200`. ID приватного плейлиста заменён шаблоном; параметры и тела с содержимым пользовательской коллекции не сохранялись.
- Повторная read-only проверка из терминала с временной Chrome-сессией: `GET https://api.music.yandex.ru/account/status` вернул `200`; полученный в памяти UID использован только для `GET /users/{uid}/likes/tracks` (`200`). Список содержал записи `id`/track refs; приватный UID, названия и сами ID не печатались и не сохранялись.
- По первой записи списка проверен `POST https://api.music.yandex.ru/tracks` с form body `track-ids=<id>` (формат из `_client/_batch.py`), ответ `200`, одна карточка. Вызов сначала был сформирован неверно как JSON-массив и вернул `400`; после сверки с реализацией исправлен на form-encoded `track-ids`. Тела ответов не сохранялись.
- Из терминала публичный no-auth запрос `GET https://api.music.yandex.net/search?text=...&type=track&page=0` вернул `200 application/json`. Вывод ответа не раскрывался. Это подтверждает доступность поискового каталога без аккаунта в проверенном случае, но ничего не говорит о доступе к лайкам.
- Новая попытка проверить тот же browser playlist route напрямую из терминала с выбранными cookies `Session_id`, `sessionid2`, `yandex_login` и `yandexuid` завершилась `ConnectionResetError` до получения HTTP-статуса. Cookies были в одноразовом файле `0600`, удалённом в `finally`; не трактовать это как отказ авторизации. Ранее подтверждённый `200` для account status и likes использовал community OAuth bearer token, не этот cookie-only путь.
- Device Flow описан проектом: `POST https://oauth.yandex.ru/device/code`, затем polling `POST https://oauth.yandex.ru/token`; фактический вход и получение токена в терминале не запускались. Запись/снятие лайков не вызывались.

## Оценка

Подходит как источник лайков для локального прототипа и для дальнейшей поддержки. Риски: нестабильный контракт, зависимость от OAuth credentials стороннего клиента, разная доступность по аккаунтам, и лицензия LGPL-3.0 при возможном включении библиотеки в проект. Для MVP лучше начать read-only экспорт, сохранить полный каталог, затем отдельно проверить изменение лайка на собственном аккаунте.

## Источники

- [GitHub repository](https://github.com/MarshalX/yandex-music-api)
- [nevdev-ml/yandex-music-exporter](https://github.com/nevdev-ml/yandex-music-exporter)
- [Project docs](https://ym.marshal.dev/)
- [Client method reference](https://ym.marshal.dev/client/)
- [OpenAPI reference](https://ym.marshal.dev/api/)
- [Device auth docs](https://ym.marshal.dev/token)
- [Device auth implementation at `9ca132e`](https://github.com/MarshalX/yandex-music-api/blob/9ca132e5c18a72aab779c1fc68c169380a9357d0/yandex_music/_client/device_auth.py)
- [OAuth device-code and token models at `9ca132e`](https://github.com/MarshalX/yandex-music-api/tree/9ca132e5c18a72aab779c1fc68c169380a9357d0/yandex_music/device_auth)
- [Request authorization and form-post implementation at `9ca132e`](https://github.com/MarshalX/yandex-music-api/blob/9ca132e5c18a72aab779c1fc68c169380a9357d0/yandex_music/utils/request_base.py)
- [oklookat/synchro Yandex adapter at `ac441f4`](https://github.com/oklookat/synchro/blob/ac441f45f1cd6a143b361a10a48611f33e96f426/remote/yandexmusic/accountActions.go)
- [oklookat/synchro Yandex auth at `ac441f4`](https://github.com/oklookat/synchro/blob/ac441f45f1cd6a143b361a10a48611f33e96f426/remote/yandexmusic/main.go)
- [`ComputerPers/YandexMusic_to_AppleMusic` exporter at `41fdd0e`](https://github.com/ComputerPers/YandexMusic_to_AppleMusic/blob/41fdd0ed6e53dcc9a7056c5ad4fbc15f5c6b344f/export_yandex_favorites.py)
- [`ComputerPers/YandexMusic_to_AppleMusic` Apple API writer at `41fdd0e`](https://github.com/ComputerPers/YandexMusic_to_AppleMusic/blob/41fdd0ed6e53dcc9a7056c5ad4fbc15f5c6b344f/add_to_apple_music_api.py)
- [`ComputerPers/YandexMusic_to_AppleMusic` Chrome token helper at `41fdd0e`](https://github.com/ComputerPers/YandexMusic_to_AppleMusic/blob/41fdd0ed6e53dcc9a7056c5ad4fbc15f5c6b344f/extract_tokens.py)
- [`ComputerPers/YandexMusic_to_AppleMusic` matcher at `41fdd0e`](https://github.com/ComputerPers/YandexMusic_to_AppleMusic/blob/41fdd0ed6e53dcc9a7056c5ad4fbc15f5c6b344f/match_apple_music.py)

Изучено по исходникам community-библиотеки, её OpenAPI, браузерному UI и terminal HTTP-пробам с пользовательской сессией. Это не контракт Яндекса; OAuth Device Flow и мутации на аккаунте не запускались.
