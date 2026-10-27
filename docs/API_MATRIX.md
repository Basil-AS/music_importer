# Каталог API-вызовов для миграции

Сводка маршрутов, которые нужны для чтения liked/saved tracks, поиска в каталоге и записи в Apple Music. Срез проверен 27.10.2026. Это не перечень всех методов Spotify, MusicKit, Яндекс Музыки или Звука. Для полного контекста, примеров ответов и исходников см. провайдерские заметки.

## Уровни подтверждения

- **Official** — опубликованный контракт провайдера.
- **Community** — маршрут и схема описаны сторонней библиотекой; провайдер не гарантирует совместимость.
- **Private web API** — внутренний web-player endpoint, наблюдён в браузере и воспроизведён чистым HTTP-клиентом; без стабильного публичного контракта.
- **Live read** означает, что выполнен только GET/read-only GraphQL; live write/mutation не выполнялся.

Ниже указываются только имена заголовков и шаблоны параметров. Access tokens, cookies, account IDs, реальные URI, cursors и записи пользовательской коллекции в этот файл не переносить.

## Spotify

| Назначение | Запрос | Авторизация и параметры | Подтверждение / ограничения |
|---|---|---|---|
| Начать официальный OAuth | `GET https://accounts.spotify.com/authorize` | Authorization Code + PKCE; `client_id`, точный registered `redirect_uri`, `scope=user-library-read`, `state`, `code_challenge_method=S256`, `code_challenge` | Official; параметры изучены, flow не запущен: Developer Terms не приняты, Premium с ошибкой оплаты не подтверждён |
| Обменять code / обновить токен | `POST https://accounts.spotify.com/api/token` | Form-urlencoded; authorization code включает `client_id`, `code`, `redirect_uri`, `code_verifier`; refresh включает `grant_type=refresh_token`, `refresh_token`, `client_id` | Official; обмен и refresh на пользовательском токене не выполнялись |
| Читать saved/Liked Songs | `GET https://api.spotify.com/v1/me/tracks?limit=50&offset=0` | `user-library-read`; `limit` максимум 50, `offset`, продолжать по `next` до `null`; ответ содержит `added_at`, track metadata/ISRC | Official; в текущей документации есть маршрут. Чистый запрос без токена дал `401`; authenticated OAuth flow не тестировали |
| Каталожный поиск | `GET https://api.spotify.com/v1/search` | OAuth; `type=track`, `q`; Development Mode `limit` максимум 10 | Official; без токена проверенный запрос дал `401` |
| Получить track metadata | `GET https://api.spotify.com/v1/tracks/{id}` | OAuth; одиночный ID в новых Development Mode условиях | Official; пакетный `/v1/tracks?ids=...` для новых Dev Mode приложений удалён |
| Добавить/убрать saved items | `PUT` / `DELETE https://api.spotify.com/v1/me/library?uris=<comma-separated-Spotify-URIs>` | `user-library-modify`; максимум 40 URI | Official; запись в аккаунт не выполнялась. Это Spotify library write, не Apple import |
| Прочитать playlist items | `GET https://api.spotify.com/v1/playlists/{id}/items` | OAuth; `playlist-read-private` для private playlists; страницы по `next` | Official; для нового Dev Mode вместо старого `/tracks` маршрута |
| Внутреннее чтение Liked Songs | `POST https://api-partner.spotify.com/pathfinder/v2/query` | Persisted GraphQL `fetchPlaylistContents`; browser bearer + `client-token`; request variables включают `uri`, `limit`, `offset` | Private web API; live terminal replay дал `200`, полный offset sweep сошёлся с server total. Использует авторизованную browser session, контракт/hashes могут измениться, не выбран как stable app auth |

Spotify archive — отдельный offline export path, не HTTP API: файл `YourLibrary.json` читается локально после пользовательской выгрузки. См. [заметку Spotify](providers/spotify.md).

## Apple Music

| Назначение | Запрос / действие | Авторизация и параметры | Подтверждение / ограничения |
|---|---|---|---|
| Бесплатный текстовый поиск кандидатов | `GET https://itunes.apple.com/search?term=...&media=music&entity=song&country=...&limit=...` | Без Apple Music developer/user token | Terminal read-only: `200`; проверенный JSON содержит `trackId`, title, artist, album, duration, но в sampled item не было ISRC. Старый `trackId` нельзя автоматически считать Music catalog ID |
| ISRC поиск в Apple Music catalog | `GET https://api.music.apple.com/v1/catalog/{storefront}/songs?filter[isrc]=...` | Developer Token; до 25 ISRC на запрос; один ISRC может дать несколько результатов | Official; текущая документация Apple, live REST с собственным developer token не запускался |
| Текстовый поиск Apple Music catalog | `GET https://api.music.apple.com/v1/catalog/{storefront}/search?term=...&types=songs` | Developer Token | Official; доступ к Apple Music REST требует членства Apple Developer Program для собственного developer token |
| Прочитать Library | `GET https://api.music.apple.com/v1/me/library/songs` | Developer Token + Music User Token; `limit`/`offset`, читать `next` | Official route; API без auth вернул `401`; browser bearer + user token ранее дал `200` на web-player чтение |
| Прочитать Favorite Songs для read-back | `GET /v1/me/library/playlists` → найти системный Favorite Songs → `GET /v1/me/library/playlists/{id}/tracks` | Official API требует оба токена; web-player в live probe использовал `Authorization` и `Media-User-Token` | Browser/terminal read-only дал `200` на список playlist и один Favorite Songs item; per-account playlist ID не сохранять |
| Поставить Favorite | `POST https://api.music.apple.com/v1/me/favorites?ids[songs]=<catalog-id>` | Developer Token + Music User Token | Official; Apple указывает `202 Accepted`; ни одной записи в этом проекте не отправляли |
| Library add или обычный playlist | `POST /v1/me/library?ids[songs]=...`; playlist: `POST /v1/me/library/playlists`, затем `POST /v1/me/library/playlists/{id}/tracks` | Developer Token + Music User Token | Official; это не эквивалент Favorite Songs |
| Проверить локальные Favorites | AppleScript `count of (every track whose favorited is true)` | macOS Music.app automation; HTTP auth не требуется | Clean terminal read-only query успешно выполнен; число и записи не сохранялись |
| Выставить Favorite локально | AppleScript `set favorited of <track from Music.app playlist> to true` | macOS Automation permission для управления Music.app; HTTP/developer token не нужны | Публичный MIT how-to содержит идемпотентный пример с проверкой уже избранных и `favorited=true`; live write в нашем аккаунте не выполнялся. Входной track должен уже присутствовать в Music.app, поэтому это только destination step, не API для поиска/импорта каталога |

## Яндекс Музыка

| Назначение | Запрос | Авторизация и параметры | Подтверждение / ограничения |
|---|---|---|---|
| Получить device code / начать вход | `POST https://oauth.yandex.ru/device/code`, затем `POST /token` | Form-urlencoded: `client_id`, `device_id`, `device_name`, далее `grant_type=device_code`, `code`, `client_id`, `client_secret` | Device-code request live `200`; browser consent Android client показал широкие scopes (профиль, платежи, Disk, Smart Home и изменение плейлистов). Согласие отменено до выдачи token; не использовать без минимально привилегированной авторизации |
| Poll токена | `POST https://oauth.yandex.ru/token` | Form-urlencoded: `grant_type=device_code`, `code`, `client_id`, `client_secret`; интервал/timeout брать из device-code response | Community; OAuth credentials встроены в библиотеку от стороннего публичного клиента, не являются credentials нашего приложения |
| Проверить аккаунт/получить UID | `GET https://api.music.yandex.net/account/status` | OAuth bearer для чистого HTTP клиента; в Chrome работает с браузерной cookie session | Community OpenAPI/client base — `.net`; authenticated terminal probe на `.ru` дал `200`; Chrome cookie session вернула JSON `result.account` (browser wrapper не показал HTTP status); UID не сохранять |
| Прочитать likes | `GET https://api.music.yandex.net/users/{user_id}/likes/tracks` | OAuth bearer для чистого HTTP клиента; в Chrome браузерная cookie session; библиотека передаёт `if-modified-since-revision=0` | Authenticated terminal probe ранее дал `200`; Chrome session вернула `result.library {uid, revision, playlistUuid, tracks[]}` одним массивом без page/cursor envelope; short ref содержит `id`, `albumId`, `timestamp`. Полноту надо сверять; cookie-only terminal replay пока не подтверждён |
| Загрузить карточки по ID | `POST https://api.music.yandex.net/tracks` | Form-urlencoded `track-ids=<comma-separated IDs>` (при необходимости `with-positions`) | Community OpenAPI — `.net`; предыдущий authenticated terminal probe на `.ru` дал `200`; JSON array вместо form data дал `400`; batch limits неизвестны |
| Публичный поиск каталога | `GET https://api.music.yandex.net/search?text=...&type=track&page=0` | Без OAuth в проверенном случае | Terminal no-auth probe 27.10.2026 дал `200 application/json` на `.net` и `.ru`; это не подтверждает host equivalence для private routes |
| Поставить/снять like | `POST /users/{user_id}/likes/tracks/add-multiple` или `/remove` | `Authorization: OAuth <token>`; Community OpenAPI указывает form-urlencoded `track-ids` | Статически подтверждено библиотекой/OpenAPI; live mutation не выполнялась, размер пачки неизвестен |
| Экспорт playlist metadata | `GET /users/{uid}/playlists/list`, затем `GET /users/{uid}/playlists/{kind}` | OAuth bearer; concrete community exporter uses API host | Статически просмотрено; полный список всех операций pinned spec см. [Yandex OpenAPI inventory](providers/yandex-openapi-inventory.md) |

## Звук / SberZvuk

| Назначение | Запрос | Авторизация и параметры | Подтверждение / ограничения |
|---|---|---|---|
| Получить ограниченный anonymous token | `GET https://zvuk.com/api/tiny/profile` (в другой библиотеке — `/api/v2/tiny/profile`) | Без сессии; TypeScript client читает `result.token` | Community clients расходятся в версии пути; автор сообщает ограничения anonymous token; terminal helper `/api/v2/tiny/profile` редиректил `307` |
| Каталог/поиск и media metadata | `POST https://zvuk.com/api/v1/graphql` | JSON GraphQL; `X-Auth-Token: <token>` в community clients | `quickSearch`, `getTrack`, `getAlbum`, `getPlaylist`, `getStreamURL`; это не все server operations. Не используйте legacy `Aiving/sberzvuk-api` HTTP GraphQL endpoint с auth token: checked source формирует `http://...` |
| Получить список liked IDs (community client) | GraphQL `userTracks` через HTTPS `/api/v1/graphql` | User token в `X-Auth-Token`; `zvuk-music.get_liked_tracks()` | Live read ранее дал `200`, но его query не объявляет `limit`/cursor; не считать полный export без сверки |
| Получить коллекцию cursor-страниц | GraphQL `getPaginatedCollection(limit, after)` через `POST https://zvuk.com/api/v1/graphql` | В браузерной сессии — Cookie; Swift client также использует `X-Auth-Token`; response `paginatedCollection.tracks.items`, `page.endCursor` | Chrome live + terminal replay подтвердили initial/next page `200`; observed `limit=30`. Были повторные IDs и несовпадение со счётчиком; дедупликация/reconciliation нужны |
| Прочитать счётчик | GraphQL `getCollectionCount` | Сессия/token как выше | Live read `200`; count не совпал с traversal, не считать checksum |
| Поставить/снять like (community client) | GraphQL mutations `collection.addItem(id,type)` / `collection.removeItem(id,type)` | Авторизованный token; source library кладёт его в `X-Auth-Token` | Статически подтверждено в `zvuk-music`; browser/terminal mutations не выполнялись |
| Старые REST-подобные catalog routes | `GET /tiny/tracks?ids=...`, `/tiny/releases?ids=...`, `/tiny/playlists?ids=...`, `/tiny/lyrics?track_id=...`, `/tiny/track/stream?id=...&quality=...` | В `ZvukDownloader` используется cookie `auth` | Статически просмотрено; download/stream не нужен для переноса библиотеки. `ZvukDownloader` отключает TLS verification, не использовать с живым auth cookie без исправления |

## Источники и следующие проверки

- Подробные provider notes: [Spotify](providers/spotify.md), [Apple Music](providers/apple-music.md), [Яндекс Музыка](providers/yandex-music.md), [Звук](providers/zvuk.md).
- Полные machine-readable route inventories: [Spotify official OpenAPI](providers/spotify-openapi-inventory.md), [Yandex community OpenAPI](providers/yandex-openapi-inventory.md).
- Official Spotify: [February 2026 migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide), [saved tracks](https://developer.spotify.com/documentation/web-api/reference/get-users-saved-tracks), [save to library](https://developer.spotify.com/documentation/web-api/reference/save-library-items).
- Official Apple: [Apple Music API](https://developer.apple.com/documentation/AppleMusicAPI), [ISRC lookup](https://developer.apple.com/documentation/applemusicapi/get-multiple-catalog-songs-by-isrc), [iTunes Search examples](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/SearchExamples.html).
- Community Yandex: [OpenAPI](https://ym.marshal.dev/api/), [Device Flow source](https://github.com/MarshalX/yandex-music-api/blob/9ca132e5c18a72aab779c1fc68c169380a9357d0/yandex_music/_client/device_auth.py).
- Community Zvuk: [`zvuk-music`](https://github.com/trudenboy/zvuk-music), [`zvuk-swift`](https://github.com/korenskoy/zvuk-swift), user's [`ZvukDownloader`](https://github.com/Basil-AS/ZvukDownloader).

Ключевые оставшиеся runtime checks: независимая сверка полного Yandex likes total/refs; повторная cursor reconciliation Звука и уточнение subscription gate; безопасный Apple Music.app favorite write/read-back на выбранной тестовой записи; Spotify official OAuth после подтверждения active Premium и принятия Developer Terms через рабочий dashboard. В проекте не выполнялись лайк/unlike и Apple write mutations.
