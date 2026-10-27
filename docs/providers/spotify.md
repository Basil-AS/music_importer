# Spotify Web API

Статус: официальная документация и пользовательский Web Player проверены 27.10.2026. Учитывать миграцию API февраля 2026: часть старых `/me/tracks` операций заменяется универсальными `/me/library`.

Полный inventory официального OpenAPI (96 операций, 70 path templates) см. [spotify-openapi-inventory.md](spotify-openapi-inventory.md).

## OAuth

Для данных пользователя нужен OAuth. Для локального desktop/browser инструмента подходит Authorization Code with PKCE: приложение не хранит client secret. Официальный поток подробно описан [Spotify PKCE guide](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow).

### Запрос пользователя и обмен кода

1. Сгенерировать криптографически случайные `code_verifier` и `state`; вычислить `code_challenge = BASE64URL(SHA256(code_verifier))` без `=` padding.
2. Открыть браузер по адресу ниже. `redirect_uri` должен в точности совпасть с зарегистрированным; Spotify требует для loopback явный IP, например `127.0.0.1`, и запрещает `localhost`.

```text
GET https://accounts.spotify.com/authorize
  ?response_type=code
  &client_id=<CLIENT_ID>
  &redirect_uri=http%3A%2F%2F127.0.0.1%3A8888%2Fcallback
  &scope=user-library-read
  &state=<RANDOM_STATE>
  &code_challenge_method=S256
  &code_challenge=<BASE64URL_SHA256_VERIFIER>
```

3. На callback принять `code` только если возвращённый `state` совпадает с исходным, затем одноразово обменять code. PKCE-запрос — `application/x-www-form-urlencoded`, без `Authorization: Basic` и без client secret:

```text
POST https://accounts.spotify.com/api/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&client_id=<CLIENT_ID>&code=<CALLBACK_CODE>&redirect_uri=http%3A%2F%2F127.0.0.1%3A8888%2Fcallback&code_verifier=<ORIGINAL_VERIFIER>
```

Успешный ответ содержит `access_token`, `token_type`, разрешённые `scope`, `expires_in` и `refresh_token`. По текущей документации access token действует 1 час, а refresh token для Dashboard app — 6 месяцев; refresh не продлевает эти 6 месяцев. Новые ответы refresh могут не содержать новый refresh token: если его нет, продолжать хранить старый.

### Обновление access token

```text
POST https://accounts.spotify.com/api/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&refresh_token=<REFRESH_TOKEN>&client_id=<CLIENT_ID>
```

При `invalid_grant` токен отозван/истёк — удалить его локально и заново провести пользователя через authorization. Не писать access/refresh tokens в логи, Git, отчёт миграции или URL. `Client Credentials` предназначен для публичных данных и не даёт доступа к пользовательским лайкам.

Минимальные scopes для чтения лайкнутых песен: `user-library-read`; для записи в библиотеку Spotify — `user-library-modify`. `playlist-read-private`/`playlist-read-collaborative` нужны только при импорте приватных плейлистов.

### Текущие ограничения Developer Mode (сверено 27.10.2026)

Официальная [Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes) требует активную Spotify Premium подписку у владельца Development Mode app; каждое подключаемое лицо должно быть в allowlist, максимум — 5 пользователей на app. Spotify подняла лимит до **25 Client IDs на developer account** 23.07.2026, но запросная quota теперь общая для всех этих app IDs на одном аккаунте — создание дополнительных приложений не умножает бюджет. При исчерпании quota приходит `429` с JSON `error.reason = QUOTA_EXCEEDED`, отдельно от обычного rate-limit `429`.

Extended Quota Mode снимает allowlist cap и даёт больший rate limit, но с 15.05.2025 Spotify принимает новые заявки только от организаций; в опубликованных требованиях — зарегистрированная организация, уже запущенный сервис, минимум 250k MAU, ключевые рынки и коммерческая жизнеспособность. Поэтому official PKCE остаётся хорошим локальным входом для личного/малого теста, но общий Client ID автора не подходит для открытого сервиса без зависимости от автора и массового запуска. В феврале 2026 migration guide ещё показывает старый лимит «1 Client ID»; его следует читать вместе с более поздним июльским quota update.

## Лайки и запись библиотеки

- Читать: `GET https://api.spotify.com/v1/me/tracks?limit=50&offset=0`, scope `user-library-read`. Текущий reference указывает максимум 50, `offset`/`next`, `total`, `added_at` и track object. Следовать `next` до `null`, не полагаться только на счётчик.
- Для сопоставления Spotify track object по-прежнему может содержать `external_ids.isrc`: February 2026 changelog временно пометил `external_ids` как удалённое поле, но официальный [March 2026 changelog](https://developer.spotify.com/documentation/web-api/references/changes/march-2026) отменил это изменение и подтвердил, что поле остаётся. Проверять поле на каждой записи и иметь fallback для отсутствующего ISRC.
- Сохранять/удалять: `PUT`/`DELETE https://api.spotify.com/v1/me/library?uris=spotify:track:<id>,...`, scope `user-library-modify`, максимум 40 URI. В новых Development Mode приложениях заменяет type-specific write routes вроде `PUT /me/tracks`; старые маршруты ещё могут отображаться в reference для совместимости/Extended Quota Mode.
- Искать: `GET /v1/search` по track/title/artist; с февраля 2026 `limit` не больше 10 (по умолчанию 5). Пакетный `GET /v1/tracks?ids=...` в Development Mode удалён — читать metadata через `GET /v1/tracks/{id}` по одному ID.
- Плейлисты: новые маршруты используют `/v1/playlists/{id}/items` (старые `/tracks` заменены); полный список items доступен не для всех чужих плейлистов. Сохранять `added_at` и исходный порядок отдельно.
- Для Development Mode приложение требует Premium у владельца и allowlist максимум на 5 пользователей. Лимит Client IDs был поднят до 25 на developer account в июле 2026; quota при этом общая на аккаунт. Это ограничения режима приложения, а не лимит количества треков в аккаунте.
- API может вернуть 401/403/429; 429 требует учитывать `Retry-After`. Результат пакетной записи следует перепроверять.

### Cross-check свежего GitHub-клиента

[Ruhrkrieger/spotify-account-migrator](https://github.com/Ruhrkrieger/spotify-account-migrator/tree/c7a609eea235c5a1e1ed93a69592fa49ffbb7e1d), MIT, HEAD `c7a609eea235c5a1e1ed93a69592fa49ffbb7e1d` (2026-08-26), — независимый статический reference для февральского API-перехода. Его source по-прежнему читает лайки через `GET /me/tracks?limit=50` и следует `next`; playlist items читает через `/playlists/{id}/items` по 50 штук, проверяет количество против playlist total и записывает library additions через `PUT /me/library` группами до 40 URI. Это подтверждает сохранение read route `/me/tracks` при смене write/playlist endpoints; official reference независимо задаёт `limit` максимум 50 и `next` до `null`.

Этот инструмент не переносит в Apple: `PUT /me/library` назначает Spotify saved items; нет Apple catalog match или `/v1/me/favorites`. Для запуска он просит свой Spotify Client ID **и Client Secret**, использует Spotipy OAuth, требует Premium владельца Development Mode app и allowlist пользователей. `config.json`, token cache, полный экспорт и resume state остаются локально в plaintext; они игнорируются Git, но source не задаёт отдельные restrictive permissions. Offline тестовый suite — mock-only; локальный запуск на этом окружении не стартовал из-за отсутствующего `requests` (и возможно `spotipy`), поэтому ни live API, ни OAuth им не подтверждены.

## Практическая проверка

- В авторизованном Chrome Web Player список «Любимые треки» открылся через видимую страницу коллекции. После перезагрузки страницы в read-only сетевом журнале наблюдались:

  | Метод и маршрут | Наблюдаемая операция / форма | Статус |
  |---|---|---|
  | `POST https://api-partner.spotify.com/pathfinder/v2/query` | Persisted GraphQL `fetchPlaylistContents`; переменные включают `uri`, `limit`, `offset`, `includeEpisodeContentRatingsV2`. В ответе `data.playlistV2.content.items[]`, `pagingInfo {limit, offset}`, `totalCount`; у элементов есть `addedAt` и `itemV2.data` с полями трека. Значения URI, курсоров и содержимое не сохранялись. | 200 |
  | `POST https://api-partner.spotify.com/pathfinder/v2/query` | `libraryV3`; переменные включают `limit`, `offset`, `folderUri`, `order`, `textFilter`; ответ содержит `data.me.libraryV3.items`, `pagingInfo`, `totalCount`. | 200 |
  | `POST https://api-partner.spotify.com/pathfinder/v2/query` | `fetchPlaylist`, `fetchPlaylistMetadata`, `playlistPermissions`, `areEntitiesInLibrary`, `isCurated` и вспомогательные операции оформления страницы. | 200 |
  | `POST https://spclient.wg.spotify.com/collection/v2/contains` | Проверка принадлежности записей коллекции; тело имеет поля `items`, `set`, `username`. Значения не сохранялись. | 200 |
  | `POST https://spclient.wg.spotify.com/extended-metadata/v0/extended-metadata` | Дополнительные метаданные каталожных объектов. | 200 |
  | `GET https://spclient.wg.spotify.com/library-import/v1/eligible` | Проверка доступности функции импорта библиотеки. | 200 |

  На этих маршрутах нет публичного или стабильного контракта; GraphQL использует `extensions` для persisted query. Наблюдение подтверждает работу текущего web player, а не возможность без изменений воспроизводить запросы в стороннем клиенте. Ответы обрабатывались в памяти; не сохранялись URI, `username`, заголовки авторизации, содержимое списка, счётчики и ID. Перезагрузка страницы не меняла библиотеку.
- Терминальный запрос без OAuth к `GET https://api.spotify.com/v1/me/tracks?limit=1` вернул `401 application/json`; аналогичный запрос каталожного поиска `/v1/search` без токена также вернул 401. Это подтверждает необходимость официального OAuth для Web API, а не доступ к данным без авторизации.
- Чистый terminal-вызов внутреннего `GET https://open.spotify.com/get_access_token?reason=transport&productType=web_player` с Chrome-сессионными cookies и `app-platform: WebPlayer` вернул `403 text/html`. Отдельно тот же read-only `POST /pathfinder/v2/query` с operation `fetchPlaylistContents`, текущим browser `Authorization` + `client-token` и минимально нужными web-player headers успешно повторён из обычного Python HTTP-клиента: `200 application/json`, ключ `data`, без GraphQL errors. В самом captured request cookie-заголовка не было. Ответ содержал список items и `pagingInfo` с `limit`/`offset` плюс `totalCount`; персональные значения не выводились и не сохранялись. Сессионные заголовки и исходный запрос находились в одноразовом файле `0600`, удалённом сразу после проверки. Это подтверждает чистый terminal replay именно текущего private Web Player API, не официального Web API и не стабильный способ получать/обновлять токен.
- Дополнительная проверка полноты: из терминала `fetchPlaylistContents` прошёл всю текущую коллекцию постранично от `offset=0` с `limit=50` до API-значения `totalCount`. Все страницы дали HTTP 200; возвращённые сервером `offset`/`limit` совпали с запрошенными, число обработанных элементов сошлось с `totalCount`. Скрипт держал записи в памяти и вывел только признаки успешной пагинации; названия, ID, URI и фактический размер коллекции не выводил и не сохранял. Первичный replay с урезанным набором заголовков получил 403; повтор с набором заголовков браузерного запроса прошёл. Временный файл с сессионными заголовками был с правами `0600` и удалён после проверки.
- Никакие лайки не менялись. Поля пользовательских записей и приватные идентификаторы не сохранялись.

**Повторная проверка 27.10.2026:** существующая Chrome-сессия Spotify была авторизована; при открытии `/collection/tracks` passive CDP capture увидел `GET /collection/tracks` → `200 text/html`, но не Pathfinder operation. При reload страницы и повторном клике по уже открытой коллекции снова наблюдались два внутренних `DELETE` на device/connect-state и track-playback device paths, оба `204`. Их точный эффект на Spotify Connect/playback отдельно не установлен; прямых playback-команд и запросов изменения library в этой проверке не отправляли. Это значит, что само открытие Web Player не является гарантированно read-only. Не продолжать навигацию/перезагрузку Spotify для сетевого аудита без отдельного решения о влиянии этих DELETE. Отсутствие Pathfinder в этом capture — ограничение текущего CDP target, не доказательство отсутствия API. Из чистого terminal без Authorization повторён официальный `GET https://api.spotify.com/v1/me/tracks?limit=1`: `401 application/json`, `WWW-Authenticate` присутствует; body отброшен. Ранее документированный authenticated terminal `fetchPlaylistContents` replay относится к отдельному private Web Player API и остаётся подтверждённым чтением; свежий bearer в этой пробе не извлекался.

**Дополнительная browser-проверка 27.10.2026:** навигация в Chrome на видимый маршрут Liked Songs `/collection/tracks` загрузила пустую оболочку (`body` пустой) и не показала коллекцию. Инициализация Web Player отправила два внутренних `DELETE` на `gew1-spclient.spotify.com` device/session paths; оба получили `204`. Это не были запросы изменения музыкальной библиотеки и мы не запускали playback, но их точное влияние на зарегистрированное устройство отдельно не подтверждено. Поэтому открытие Spotify Web Player нельзя считать гарантированно read-only browser probe; повторно этот путь не использовать для сетевого аудита. Треки, account values и device IDs не записывались.

**Предыдущая повторная проверка user browser session, 27.10.2026:** Chrome-сессия открывала `/collection/tracks`. Ранее захваченный TOTP URL был одноразовым/истёкшим (два replay вернули 400), а исходные page request status не сохранились. Этот исторический replay был разрешён отдельной проверкой: helper с актуальной TOTP cipher dictionary и пользовательской сессией получил bearer из `sp_dc` (см. следующий раздел). В той более ранней capture дополнительных DELETE не наблюдалось; при более позднем повторе ниже два DELETE появились снова. Временные данные удалены.

### Chrome route-key recheck (28.10.2026)

На уже открытой странице «Любимые треки» выполнена обычная перезагрузка с read-only CDP capture. В видимом потоке браузер отправил `GET https://open.spotify.com/api/token` с query-key names `productType`, `reason`, `totp`, `totpServer`, `totpVer`, затем `POST https://clienttoken.spotify.com/v1/clienttoken` и preflight `OPTIONS` на тот же путь. Значения query, заголовки и тела не читались и не сохранялись. Буфер событий переполнился (`truncated=true`) до того, как удалось зафиксировать все запросы; Pathfinder operation и status этого token request поэтому не подтверждены этой итерацией. Не выводить из неё ни успех обновления bearer, ни доступность Saved Tracks.

Сразу после браузерной проверки чистый запрос без Authorization к официальному `GET https://api.spotify.com/v1/me/tracks?limit=1` вернул `401 application/json`, что повторно подтверждает auth boundary официального endpoint. Свежая проверка не трогала лайки и не сохраняла список пользователя.

### Повторное получение Web Player bearer из `sp_dc` (27.10.2026)

Найден MIT-кандидат [mirrorfm/spotify-webplayer-token](https://github.com/mirrorfm/spotify-webplayer-token), checked HEAD `7f0ac21eb95c0c592394fdb2529d9f6671b8aef4` (2026-03-22). Его `GetAccessToken()` берёт только `sp_dc`, получает TOTP cipher dictionary, выбирает последнюю версию и делает `GET https://open.spotify.com/api/token` с `totp`, `totpServer`, `totpVer` и Web Player headers; `sp_key`, Spotify OAuth Client ID и password не нужны. В исходном CLI `main.go` печатает первые 30 символов access token, а библиотечная `app.go` подгружает JSON cipher data с неприкреплённой к commit `raw.githubusercontent.com/.../main/...` ссылки — этот CLI нельзя запускать без исправлений, а зависимость надо pin-ить и аудировать.

Для проверки протокол независимо воспроизведён в коротком stdlib-only Python terminal probe после просмотра исходника. Он использовал `sp_dc` текущей авторизованной Chrome-сессии и публичную cipher dictionary из pinned `xyloflake/spot-secrets-go` HEAD `4cd9440671af3a419bad112164a193ea1374e0e1`; секрет cookie лежал в одноразовом файле mode `0600`, был удалён после вызова и ни разу не печатался. Ответ Spotify: `GET /api/token` — HTTP `200 application/json`, access token present, `isAnonymous=false`, expiration примерно через 41 минуту; token не показывался и не сохранялся. В этой проверке `sp_key` не передавался.

Немедленный read-only `GET https://api.spotify.com/v1/me/tracks?limit=1` с полученным bearer ответил HTTP `429`; поэтому доступ именно нового токена к Saved Tracks Web API этой пробой не доказан, и повторный запрос без ожидания `Retry-After` не делался. Предыдущий полный `fetchPlaylistContents` Pathfinder read с уже выданным browser bearer остаётся подтверждённым отдельно. Текущий вывод: получение user-bound Web Player bearer без app credentials создателя подтверждено; автоматическое полное чтение Liked Songs с самостоятельно обновлённым токеном требует ещё одного ограниченного read-only Pathfinder replay. TOTP key-dictionary upstream имеет GPL-3.0, helper сам MIT; ничего из репозитория в проект не копировалось.

## Неофициальный Web Player API (по открытому исходному коду)

В `ahnafnafee/songmirror` (MIT, HEAD `76d3d27`) статически просмотрен адаптер `songmirror/engine/spotify_cookie.py`. Он повторяет first-party Web Player протокол: использует `sp_dc` как пароль-подобный cookie для получения bearer через `spotify_scraper`, затем отправляет POST на `https://api-partner.spotify.com/pathfinder/v2/query`. Persisted-query body содержит `operationName`, `variables` и `extensions.persistedQuery` с версией и SHA-256 hash; актуальные hashes проект считывает из web-player bundle и обновляет при ротации.

Операции, присутствующие в проверенном коде:

- Likes/library: `fetchLibraryTracks` (offset/limit), `addToLibrary`, `removeFromLibrary`.
- Library directory/profile: `libraryV3`, `profileAttributes`.
- Плейлисты: `fetchPlaylist`, `fetchPlaylistContents`, `addToPlaylist`, `removeFromPlaylist`.

Это не официальный Web API и не гарантированная интеграция. В известных open-source реализациях `sp_dc` применяется для получения bearer; в нашей live-проверке текущий browser bearer/client-token уже работал при direct terminal replay, но отдельный web token endpoint вернул `403`. Private endpoints/hashes могут измениться, а Spotify может отозвать сессию. По исходному коду pathfinder используется для чтения и записи Liked Songs без Developer Mode app; это reference для анализа, не выбранный стабильный способ авторизации своего приложения.

Отдельный проект [Brimx/Melomaniac](https://github.com/Brimx/Melomaniac), HEAD `a6f81cb` от 26.10.2026, независимо показывает directory-запрос `POST https://api-partner.spotify.com/pathfinder/v1/query`, operation `libraryV3`, с `features: ["LIKED_SONGS", ...]`, `limit` и `offset`. Он отображает `LibraryPseudoPlaylistResponseWrapper` как synthetic ID `collection:tracks`, то есть подтверждает способ обнаружить Liked Songs в списке библиотеки. В том же source общий loader передаёт ID в `PublicPlaylist(...).get_playlist_info(...)` и отдельной ветки для `collection:tracks` не видно. Дополнительно upstream `spotapi` `PublicPlaylist` строит `fetchPlaylist` URI по шаблону `spotify:playlist:{playlist_id}` и оставляет `collection:tracks` в идентификаторе, то есть получится `spotify:playlist:collection:tracks`, а не отдельный liked-songs operation. Это указывает на вероятный source-loader bug, но точное соответствие PyPI `spotapi==1.2.8` и HTTP-ответ не проверены; transfer нельзя считать рабочим по одному факту, что список показывает этот источник. Melomaniac directory listing останавливается на offset 600 — это предел реализации, не API Spotify. Проект вручную принимает `sp_dc` и `sp_key`, а Apple принимает web `Authorization` + `media-user-token`; он пишет destination playlist в Apple Library, не Favorite Songs. Код не обнаруживает вызова `/v1/me/favorites`; лицензия и test suite в репозитории не объявлены.

## Важные текущие ограничения

В официальном migration guide для Development Mode указаны Premium у владельца приложения и до пяти пользователей на приложение для новых/не-grandfathered apps. Это означает, что персональный перенос потенциально реалистичен при соблюдении требований, но публичный бесплатный сервис на одном dev client ID — не рабочее предположение. Прежде чем строить продуктовую авторизацию, проверить условия Spotify для конкретного типа приложения/аккаунта.

Дополнительный legal/runtime gate: при переходе в авторизованном Chrome на Developer Dashboard отобразились Spotify Developer Terms v10 (effective 15 May 2025) и обязательный checkbox. Пользователь разрешил принять условия и создать минимальное приложение при наличии Premium. В Account Overview показан Premium Family, но одновременно Spotify предупреждает о сбое оплаты и скорой потере доступа; active Premium у владельца app поэтому не подтверждён. Стандартный клик по checkbox через управление страницей не изменил его состояние, кнопка осталась выключенной. Условия не приняты, приложение и OAuth client не созданы. Официальный текст — [developer.spotify.com/terms](https://developer.spotify.com/terms); §I.3 говорит, что использование **или доступ** к Spotify Platform означает принятие Developer Agreement как юридически обязывающего договора. OAuth не запускали.

В той же редакции официальный [Spotify Developer Policy](https://developer.spotify.com/policy), §I.9, прямо разрешает SDA передавать данные в другой сервис, если цель — дать пользователю перенести **свои персональные данные** или метаданные его плейлистов. Это поддерживает проектный сценарий пользовательского экспорта как предусмотренное исключение, но само по себе не подтверждает соответствие конкретной реализации условиям Spotify. Сохраняются и другие требования Terms: запрашивать только нужные данные, получить явное согласие на иное использование персональных данных, не передавать Spotify Content третьим лицам за пределами предусмотренных исключений, обеспечить отключение интеграции и удаление данных, иметь privacy policy и обязательные пользовательские условия (§III.5, V.3–V.11). Практический дизайн должен держать перенос локально и передавать в Apple только выбранные пользователем записи; точный охват исключения для конкретного приложения требует чтения полных условий. Этот пункт относится к официальной Spotify Platform, не легализует private Web Player API или обход Developer Mode.

## Бесплатный архив аккаунта как запасной источник

Spotify позволяет запросить машиночитаемую копию личных данных из Account Privacy. В официальном описании `Your Library` включает сохранённые songs, episodes, shows, artists и albums; там же указано наличие имён сущностей, исполнителей/альбомов и Spotify URI. Это полезный offline backup и fallback, если Web API Development Mode не подходит, без регистрации Web API app и её Premium-ограничения. Архив не пишет ничего в Apple Music, может содержать другие чувствительные данные аккаунта и требует времени на подготовку; будущий parser должен локально читать только нужный JSON, не сохранять исходный ZIP в проекте и удалять его по завершении.

### Выгрузка и типичная схема

1. Пользователь сам запрашивает `Download your data` в Spotify Account Privacy и выбирает пакет `Account data`, где находится список сохранённой библиотеки; `Extended streaming history` для лайков не нужен. Проверенный UI показывает срок подготовки Account data до 5 дней и требует подтвердить запрос ссылкой из письма; extended history и technical logs предлагаются отдельно со сроком до 30 дней. Пакет Account data включает также несвязанные с переносом сведения (например, платежи, поиски, геолокацию и сообщения), поэтому после загрузки обрабатывать только `YourLibrary.json`, а остальные файлы не открывать.
2. В открытых парсерах Spotify `YourLibrary.json` содержит верхнеуровневый объект `tracks`, где запись обычно имеет поля `artist`, `album`, `track`, `uri`. Типичный пример, собранный из фикстур публичных репозиториев (не пользовательский экспорт):

```json
{
  "tracks": [
    {
      "artist": "Artist Name",
      "album": "Album Name",
      "track": "Track Name",
      "uri": "spotify:track:<id>"
    }
  ],
  "albums": [],
  "artists": [],
  "shows": [],
  "episodes": []
}
```

3. Независимые парсеры `liMusic` и `Namida` читают `tracks[]` из `YourLibrary.json`; `MelodyBridge` также документирует его как источник Spotify liked songs. Это подтверждает практическую применимость файла как экспорта сохранённых треков, но официальная схема и обещание сохранить порядок/дату добавления в справке Spotify не опубликованы. Для переносимого источника опираться на `uri` (когда это `spotify:track:`), а имя/артиста/альбом использовать как fallback; `spotify:local:` не содержит каталожного track ID.
4. `Playlist*.json` — отдельный формат пользовательских плейлистов (`playlists[] → items[] → track/episode/localTrack`). Не смешивать их с `YourLibrary.json`: для задачи переноса лайков основной источник — `tracks[]` библиотеки.

Практическое состояние: схема и смысл сопоставлены по официальной справке Spotify и коду/докам публичных импортёров; в Spotify UI проверены выбор Account data, состав пакета, срок и подтверждение email. Запрос архива находится в ожидании email-подтверждения, поэтому пользовательский ZIP не загружен и не проверен. Перед production parser нужна отдельная синтетическая fixture и проверка `YourLibrary.json` из пользовательского экспорта после подтверждения. Импорт должен работать локально: выбирать из ZIP только `YourLibrary.json` и явно разрешённые `Playlist*.json`, не извлекать весь аккаунтный архив в рабочий каталог и не загружать его на сервер.

### Проекты, проверенные на чтение архива

- [`SimoHypers/liMusic`](https://github.com/SimoHypers/limusic/tree/d82372cdd3016e3c5e28ea8022596b7fefdf681a/src-tauri/src/spotify.rs) (GPL-3.0) находит `YourLibrary.json` и `Playlist*.json` внутри ZIP независимо от имени верхней папки, читает saved tracks и сохраняет Liked Songs как отдельный source list. Код имеет типы для `artist`/`album`/`track`/`uri` и ZIP fixture. Это полезный Rust parser reference; target проекта — YouTube Music, не Apple Music.
- [`namidaco/namida`](https://github.com/namidaco/namida/blob/dc2c96c598d1e9cd6616cf228c17011e23555d9a/lib/controller/json_to_history_parser.dart) (лицензия GitHub не классифицирована; checked-in licence проверить отдельно) умеет читать Spotify Account Data для импорта истории прослушиваний и использует `YourLibrary.json` как коллекцию треков. Это подтверждение формата на независимой реализации, а не межсервисный Apple importer.
- [`warreth/melodybridge`](https://github.com/warreth/melodybridge/blob/7595b7a81dcc154c4432755933a67a41051699df/docs/accounts.md) (AGPL-3.0) описывает ручной Spotify archive import как источник liked songs и плейлистов. У него также есть неофициальный `sp_dc` режим; README проекта предупреждает, что cookie хранится в базе открытым текстом. Для нашего подхода пригоден только file-import сценарий после проверки кода, не способ авторизации.

Архивный parser устраняет Spotify Web API quota/app/Premium-зависимость чтения списка, но не решает поиск совпадений и запись в Apple Favorite Songs. Для этого всё ещё нужен отдельный matcher и локальный Apple Music путь или API.

## Источники

- [Authorization](https://developer.spotify.com/documentation/web-api/concepts/authorization)
- [PKCE flow](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow)
- [Refreshing tokens](https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens)
- [Redirect URI requirements](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri)
- [Scopes](https://developer.spotify.com/documentation/web-api/concepts/scopes)
- [Get a User's Saved Tracks](https://developer.spotify.com/documentation/web-api/reference/get-users-saved-tracks)
- [Save Items to Library](https://developer.spotify.com/documentation/web-api/reference/save-library-items)
- [February 2026 migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)
- [February 2026 Web API changelog](https://developer.spotify.com/documentation/web-api/references/changes/february-2026)
- [Developer Terms v10](https://developer.spotify.com/terms)
- [Developer Policy, effective 15 May 2025](https://developer.spotify.com/policy)
- [Spotify data rights and export](https://support.spotify.com/us/article/data-rights-and-privacy-settings/)
- [Understanding your Spotify data](https://support.spotify.com/mt/article/understanding-your-data/)
- [Spotify Development Mode quota rules](https://developer.spotify.com/documentation/web-api/concepts/quota-modes), [July 2026 account quota update](https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates)
- [SongMirror Web Player adapter](https://github.com/ahnafnafee/songmirror/tree/main/songmirror/engine)
- [SongMirror first-party request reference](https://github.com/ahnafnafee/songmirror/blob/main/docs/spotify-web-postman.md)
- [Melomaniac Spotify libraryV3 and loader](https://github.com/Brimx/Melomaniac/blob/a6f81cbb675315a93f93bcf74d14667692ecb09a/services/api_service.py)
- [SpotAPI `PublicPlaylist` request construction](https://github.com/Aran404/SpotAPI/blob/cb862571574e1ddbf5f8975f58a4f61a0e3d2050/spotapi/playlist.py)
- [mirrorfm/spotify-webplayer-token at `7f0ac21`](https://github.com/mirrorfm/spotify-webplayer-token/tree/7f0ac21eb95c0c592394fdb2529d9f6671b8aef4) and pinned [TOTP secret dictionary source at `4cd9440`](https://github.com/xyloflake/spot-secrets-go/tree/4cd9440671af3a419bad112164a193ea1374e0e1)

Официальные endpoints сверены с документацией; полный inventory получен из официальной OpenAPI спецификации. Практический браузерный read-only просмотр, terminal no-auth контроль и полная пагинация приватной Web Player коллекции выполнены. OAuth flow официального Web API и запись в собственном аккаунте ещё не запускали.
