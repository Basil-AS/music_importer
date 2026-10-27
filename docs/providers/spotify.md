# Spotify Web API

Статус: официальная документация и пользовательский Web Player проверены 27.10.2026. Учитывать миграцию API февраля 2026: часть старых `/me/tracks` операций заменяется универсальными `/me/library`.

## OAuth

Для данных пользователя нужен OAuth. Для локального desktop/browser инструмента подходит Authorization Code with PKCE, поскольку секрет приложения нельзя надёжно хранить в клиенте. Поток: создать verifier/challenge S256 и state; открыть `https://accounts.spotify.com/authorize`; проверить state в callback; обменять code через `https://accounts.spotify.com/api/token`; хранить access/refresh token только локально и защищённо. В dev mode Redirect URI должен соответствовать текущим требованиям Spotify (для локальной разработки — loopback IP `127.0.0.1`, не `localhost`). Client Credentials работает только для публичных данных, не для пользовательских лайков.

Минимальные scopes для чтения лайкнутых песен: `user-library-read`; для записи в библиотеку Spotify — `user-library-modify`. `playlist-read-private`/`playlist-read-collaborative` нужны только при импорте приватных плейлистов.

## Лайки и запись библиотеки

- Читать: `GET https://api.spotify.com/v1/me/tracks?limit=50&offset=0`, scope `user-library-read`. Текущий reference указывает максимум 50, `offset`/`next`, `total`, `added_at` и track object. Следовать `next` до `null`, не полагаться только на счётчик.
- Сохранять/удалять: `PUT`/`DELETE https://api.spotify.com/v1/me/library?uris=spotify:track:<id>,...`, scope `user-library-modify`, максимум 40 URI. В новых Development Mode приложениях заменяет type-specific write routes вроде `PUT /me/tracks`; старые маршруты ещё могут отображаться в reference для совместимости/Extended Quota Mode.
- Искать: `GET /v1/search` по track/title/artist; с февраля 2026 `limit` не больше 10 (по умолчанию 5). Пакетный `GET /v1/tracks?ids=...` в Development Mode удалён — читать metadata через `GET /v1/tracks/{id}` по одному ID.
- Плейлисты: новые маршруты используют `/v1/playlists/{id}/items` (старые `/tracks` заменены); полный список items доступен не для всех чужих плейлистов. Сохранять `added_at` и исходный порядок отдельно.
- Для новых Development Mode приложений миграция также указывает Premium у владельца, один Client ID на разработчика и максимум 5 пользователей. Это ограничения режима приложения, а не лимит количества треков в аккаунте.
- API может вернуть 401/403/429; 429 требует учитывать `Retry-After`. Результат пакетной записи следует перепроверять.

## Практическая проверка

- В авторизованном Chrome Web Player список «Любимые треки» открылся через видимую страницу коллекции. При обновлении страницы браузер отправил `POST https://api-partner.spotify.com/pathfinder/v2/query`; среди имён GraphQL-операций наблюдались `fetchPlaylist` и `playlistPermissions`. Это внутренний контракт веб-клиента, не документированный Web API. Не закладывать его в переносчик: формат и доступ могут измениться без предупреждения.
- Терминальный запрос без OAuth к `GET https://api.spotify.com/v1/me/tracks?limit=1` вернул `401 application/json`; аналогичный запрос каталожного поиска `/v1/search` без токена также вернул 401. Это подтверждает необходимость официального OAuth для Web API, а не доступ к данным без авторизации.
- Чистый terminal-вызов внутреннего `GET https://open.spotify.com/get_access_token?reason=transport&productType=web_player` с Chrome-сессионными cookies и `app-platform: WebPlayer` вернул `403 text/html`; официальный `GET /v1/me/tracks` с токеном поэтому в этой проверке не выполнен. Browser-only `pathfinder` остаётся наблюдаемым, но не подтверждён как переносимый terminal API. Следующий валидный путь для Web API — отдельный OAuth Authorization Code with PKCE через зарегистрированное приложение, а не попытка обхода WAF.
- Никакие лайки не менялись. Поля пользовательских записей и приватные идентификаторы не сохранялись.

## Неофициальный Web Player API (по открытому исходному коду)

В `ahnafnafee/songmirror` (MIT, HEAD `76d3d27`) статически просмотрен адаптер `songmirror/engine/spotify_cookie.py`. Он повторяет first-party Web Player протокол: использует `sp_dc` как пароль-подобный cookie для получения bearer через `spotify_scraper`, затем отправляет POST на `https://api-partner.spotify.com/pathfinder/v2/query`. Persisted-query body содержит `operationName`, `variables` и `extensions.persistedQuery` с версией и SHA-256 hash; актуальные hashes проект считывает из web-player bundle и обновляет при ротации.

Операции, присутствующие в проверенном коде:

- Likes/library: `fetchLibraryTracks` (offset/limit), `addToLibrary`, `removeFromLibrary`.
- Library directory/profile: `libraryV3`, `profileAttributes`.
- Плейлисты: `fetchPlaylist`, `fetchPlaylistContents`, `addToPlaylist`, `removeFromPlaylist`.

Это не официальный Web API и не гарантированная интеграция. `sp_dc` даёт доступ к пользовательской сессии, private endpoints/hashes могут измениться, а Spotify может отозвать сессию. По исходному коду pathfinder используется для чтения и записи Liked Songs без Developer Mode app; наш terminal-вызов web token endpoint с текущим Chrome-сеансом ответил `403`, поэтому этот путь остаётся только reference и в своё приложение пока не переносится.

## Важные текущие ограничения

В официальном migration guide для Development Mode указаны Premium у владельца приложения и до пяти пользователей на приложение для новых/не-grandfathered apps. Это означает, что персональный перенос потенциально реалистичен при соблюдении требований, но публичный бесплатный сервис на одном dev client ID — не рабочее предположение. Прежде чем строить продуктовую авторизацию, проверить условия Spotify для конкретного типа приложения/аккаунта.

## Бесплатный архив аккаунта как запасной источник

Spotify позволяет запросить машиночитаемую копию личных данных из Account Privacy. В описании архива `Your Library` включает сохранённые треки, эпизоды, шоу, артистов и альбомы, в том числе URIs; это полезный офлайн backup и fallback, если Web API dev mode не подходит. Архив не пишет ничего в Apple Music и требует времени на подготовку; для нашего инструмента нужен локальный parser фактически выданного Spotify ZIP/JSON и корректное сопоставление записей.

## Источники

- [Authorization](https://developer.spotify.com/documentation/web-api/concepts/authorization)
- [PKCE flow](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow)
- [Scopes](https://developer.spotify.com/documentation/web-api/concepts/scopes)
- [Get a User's Saved Tracks](https://developer.spotify.com/documentation/web-api/reference/get-users-saved-tracks)
- [Save Items to Library](https://developer.spotify.com/documentation/web-api/reference/save-library-items)
- [February 2026 migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)
- [February 2026 Web API changelog](https://developer.spotify.com/documentation/web-api/references/changes/february-2026)
- [Spotify data rights and export](https://support.spotify.com/us/article/data-rights-and-privacy-settings/)
- [Understanding your Spotify data](https://support.spotify.com/mt/article/understanding-your-data/)
- [SongMirror Web Player adapter](https://github.com/ahnafnafee/songmirror/tree/main/songmirror/engine)
- [SongMirror first-party request reference](https://github.com/ahnafnafee/songmirror/blob/main/docs/spotify-web-postman.md)

Официальные endpoints сверены с документацией; практический браузерный read-only просмотр и терминальный no-auth контроль выполнены. OAuth flow, пагинацию и запись в собственном аккаунте ещё не запускали.
