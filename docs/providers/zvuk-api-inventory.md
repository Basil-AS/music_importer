# Звук: инвентарь API v1, Tiny API и пользовательского входа

Срез на 28.10.2026. Официальной публичной API-спецификации не найдено; это reverse-engineered интерфейсы веб-клиента и community-библиотек, не обещанный стабильный контракт. Здесь «API v1» — GraphQL `/api/v1/graphql`; Tiny REST встречается как `/api/tiny/...` и `/api/v2/tiny/...`. Не следует считать все Tiny-маршруты API v2.

## Вход и получение токена

1. Пользователь входит на `https://zvuk.com` обычным способом; пароль и OTP вводятся только на сайте Звука.
2. В активной сессии браузерные `GET /api/tiny/profile` и `GET /api/v2/tiny/profile` возвращают JSON профиля с session token. В Chrome 27.10.2026 `/api/tiny/profile` ответил `200` с `x-app-instance`/`x-device-id`; в terminal `GET /api/v2/tiny/profile` с cookie `auth` и browser-like headers ответил `200`, а `result.profile.is_anonymous` был `false`. В versionless пути token находится в `result.token`, в `/api/v2/` — в `result.profile.token`. Значения не выводились, не сохранялись и не коммитились.
3. Community-клиенты передают token в `X-Auth-Token`; веб-клиент использует same-origin cookie-сессию. Это bearer-секрет: хранить только локально в системном хранилище; не помещать в URL, логи, shell history или Git.
4. Анонимный token упоминается в README `zvuk-music` и `sberzvuk-api`, но его получение из чистого CLI здесь не подтвердилось: без cookies три проверки получили `418 text/html` от защиты. Не трактовать WAF `418` как отсутствие API.

### Перепроверка пользовательского `ZvukDownloader` (28.10.2026)

`Basil-AS/ZvukDownloader` по-прежнему на HEAD `922e2587f52a411a05695fd6454bb6dd40afba5a` (latest push 2026-02-13). В `zvuk_multibot.py` найдены `get_profile`, `get_tracks(ids)`, `get_releases(ids)`, `get_playlists(ids)`, `get_stream_url`, `get_lyrics` и `get_artist_releases`; generic `graphql_query()` фактически используется для каталожного `getArtistReleases` с `limit/offset`. Поиск методов, GraphQL documents и CLI команд не обнаружил чтение `userCollection`/`userTracks`, cursor collection, Favorite Songs, like/unlike или экспорта списка пользовательских лайков. `get_playlists(ids)` гидрирует заданные playlist ID, а не запрашивает коллекцию аккаунта.

Security cross-check source: `ZvukConfig.auth_token` попадает в `Cookie: auth=…`; CLI принимает `--token` либо читает plaintext `config.json`; `aiohttp.TCPConnector` задан с `ssl=False`; глобальный logger пишет и в `zvuk_multibot.log`, и в stdout, а общий request handler логирует полный текст каждого non-200 ответа. Публичный `API_DOCUMENTATION.md` содержит фиксированную token-shaped строку, объявленную обезличенным примером; значение не копировали и не проверяли. Поэтому этот проект не запускаем с реальной учетной сессией и не используем как source likes adapter; безопасная интеграция должна отдельно реализовать read-only collection operation, HTTPS verification, secret storage и redacted logs.

### Статический cross-check: `Aiving/sberzvuk-api`

MIT TypeScript-клиент проверен на HEAD `3c157f8114b236ccc2d15d1215d3b7e069e1e754`; GitHub metadata показывает последнее обновление 2024-01-15. В README заявлен `getAnonymousToken()` через `GET https://zvuk.com/api/tiny/profile`. В каталоге находятся семь GraphQL documents: `getSearch`, `getSearchAll`, `getTracks`, `getFullTrack`, `getReleases`, `getPlaylists`, `getStream`; однако executor регистрирует только шесть (`getSearchAll` в него не импортирован). Ни одна из доступных операций не запрашивает `userCollection`, `userTracks`, `paginatedCollection` или liked tracks; это каталоговый/stream client, не likes exporter.

Важное отличие от актуальных HTTPS-клиентов: GraphQL executor шлёт `X-Auth-Token` на `http://zvuk.com/api/v1/graphql` по незашифрованному HTTP. Такой путь нельзя использовать с пользовательским токеном до замены на HTTPS. В нашей свежей credential-free terminal проверке `/api/tiny/profile`, `/api/v2/tiny/profile` и safe GraphQL `__typename` каждый вернул `418 text/html`; это тот же WAF boundary, не отрицание схемы из исходника.

### Email/password login route из `nikolaykindness/zvukplugin` (static only)

В Lyrion-плагине [`nikolaykindness/zvukplugin`](https://github.com/nikolaykindness/zvukplugin/tree/2237230a4967d0b6bb66faf1882e3833da4a291c), HEAD `2237230a4967d0b6bb66faf1882e3833da4a291c` (v0.1.6, 08.07.2026), обнаружен third-party login flow:

| Метод и путь | Тело/ответ по исходнику | Следующий шаг |
|---|---|---|
| `POST https://zvuk.com/api/tiny/login/email` | `application/x-www-form-urlencoded`: `email`, `password`; токен ищется в `result.token`, `user.token`, `result.profile.token` или корневом `token` | Плагин сохраняет token и email в Lyrion preferences, затем проверяет профиль |
| `GET https://zvuk.com/api/tiny/profile` | Профиль; одновременно передаются `X-Auth-Token` и `Cookie: auth=<token>` | При token-поле вход считается успешным |
| `POST https://zvuk.com/api/v1/graphql` | JSON `{query, operationName, variables}` с `X-Auth-Token` и тем же `auth` cookie | Чтение favorites/catalog |

Это только контракт из исходников, не проверенный здесь live route. Исходник не показывает сохранение пароля в preferences, но password вводится в чужую LMS форму и передаётся route-у Звука; MFA/SSO/refresh поведение не установлено. Защищённость хранения token средствами Lyrion не проверялась. Для собственного продукта это UX/endpoint reference, а не основание собирать пароль у пользователя.

`getFavoriteTracks()` вызывает `userTracks(orderBy: dateAdded, orderDirection: desc)` с `collection.tracks { id }`, без cursor/limit, затем одним `getTracks(ids)` гидрирует карточки. В плагине нет page loop или reconciliation с `getCollectionIds`/count — полнота больших коллекций не доказана. `getPlaylistTracks()` задаёт `limit=100, offset=0` и тоже не обходит следующую страницу.

## Точки входа и REST

| Назначение | Метод и путь | Параметры | Авторизация / состояние |
|---|---|---|---|
| GraphQL API v1 | `POST https://zvuk.com/api/v1/graphql` | JSON `{query, operationName, variables}` | `zvuk-music` использует HTTPS + `X-Auth-Token`; браузерные запросы same-origin с cookie-сессией. Ранее authenticated collection reads дали `200` из Chrome и при ephemeral terminal replay. Без авторизации safe `query { __typename }` дал `418 text/html` в терминале. |
| Профиль/session token | `GET https://zvuk.com/api/tiny/profile` | Уже открытая browser session; web client в trace послал `x-app-instance` и `x-device-id` | В Chrome `200`; token в `result.token`. Для CLI no-cookie вызовы ранее отвечали `418 text/html`. |
| Профиль/session token, альтернативный путь | `GET https://zvuk.com/api/v2/tiny/profile` | Пользовательский cookie `auth` + `Accept`, `Origin`, `Referer`, Chrome `User-Agent`; follow HTTP 307 redirect | Live terminal `200 application/json`; `result.profile.is_anonymous=false`, token в `result.profile.token`. Важная ловушка: cookie `access_token` тоже дал `200`, но `is_anonymous=true` и пустые collection responses; он не удостоверяет пользовательскую библиотеку для этого пути. |
| Метаданные треков | `GET /api/tiny/tracks?ids=...&include=track` | ID и optional include | `ZvukDownloader`; не логировать реальные URL с IDs. |
| Метаданные релизов | `GET /api/tiny/releases?ids=...&include=track` | ID и optional include | `ZvukDownloader` / community Tiny client. |
| Метаданные плейлистов | `GET /api/tiny/playlists?ids=...` | ID; downloader умеет `include=track` | Community Tiny client. |
| Текст песни | `GET /api/tiny/lyrics?track_id=...` | track ID | Для лайк-миграции не нужен. |
| Stream metadata | `GET /api/tiny/track/stream?id=...&quality=...` | ID; `mid`/`high`/`flac` | Возвращает временную stream-ссылку; не нужно для переноса. Не запрашивать/не сохранять аудио. |
| Grid content | `GET /api/tiny/grid/content?name=...&ranker_enabled=...` | имя секции и флаг | Есть в текущем `zvuk-music`; не относится к экспорту лайков. |

Без cookies/token terminal probes к `/api/tiny/profile`, `/api/v2/tiny/profile` и `/api/v1/graphql` дали `418 text/html`. Это подтверждает антибот-барьер для чистого CLI, а не несуществование endpoint. Ранее authenticated GraphQL terminal replay с ephemeral session context возвращал `200`.

### Clean CLI sweep маршрутов `ZvukDownloader` (27.10.2026)

По pinned HEAD [`922e2587`](https://github.com/Basil-AS/ZvukDownloader/tree/922e2587f52a411a05695fd6454bb6dd40afba5a) из чистого Python `urllib` без cookie, bearer, Chrome headers и сохранения body выполнены безопасные запросы к profile v1/v2, metadata GET с синтетическим несуществующим ID `-987654321`, lyrics с тем же ID и GraphQL `query SafeProbe { __typename }`. Все семь ответов — `418 text/html`, одинаковый размер 4 338 байт. Ровный размер у всех разных маршрутов согласуется с общей WAF/anti-bot страницей, поэтому не интерпретировать эти статусы как endpoint-specific `401/403/404`. Запросов к stream/audio и GraphQL mutations не было.

| Method / path | Clean terminal | Примечание |
|---|---:|---|
| `GET /api/tiny/profile` | `418 text/html` | Versionless Tiny profile |
| `GET /api/v2/tiny/profile` | `418 text/html` | Versioned profile |
| `GET /api/tiny/tracks?ids=-987654321&include=track` | `418 text/html` | Synthetic ID; response body discarded |
| `GET /api/tiny/releases?ids=-987654321&include=track` | `418 text/html` | Synthetic ID; response body discarded |
| `GET /api/tiny/playlists?ids=-987654321` | `418 text/html` | Synthetic ID; response body discarded |
| `GET /api/tiny/lyrics?track_id=-987654321` | `418 text/html` | Synthetic ID; response body discarded |
| `POST /api/v1/graphql` (`SafeProbe`) | `418 text/html` | Safe read-only query |

## GraphQL операции из `trudenboy/zvuk-music`

Проверен snapshot `ed491f61bc7b18c9f327017a8a87d9fe183022a7` от 07.10.2026. Этот список покрывает checked-in GraphQL documents одной библиотеки, но не весь внутренний schema веб-клиента. Всё идёт через `/api/v1/graphql`.

### Чтение

| Область | Operations | Назначение |
|---|---|---|
| Поиск | `quickSearch(query, limit, searchSessionId)`, `search(query, limit, cursors, include flags)` | Автодополнение и полный каталоговый поиск; полный поиск имеет cursor-поля по типам результатов. |
| Каталог | `getTracks(ids)`, `getFullTrack(ids)`, `getArtists(ids, flags/offsets/limits)`, `getReleases(ids, relatedLimit)`, `getPlaylists(ids)`, `getShortPlaylist(ids)`, `getPlaylistTracks(id, limit, offset)`, `getStream(ids)` | Карточки и связи track/artist/release/playlist, а также stream metadata. |
| Профиль/коллекция | `userCollection`, `userTracks(orderBy, orderDirection)`, `userPlaylists`, `userPaginatedPodcasts(cursor, count)` | Лайки, плейлисты и пользовательские подкасты. В библиотечном `userTracks` нет limit/cursor: он возвращает IDs/`lastModified`, метаданные берутся отдельным `getTracks`. |
| Hidden | `getAllHiddenCollection`, `getHiddenTracks` | Скрытые записи. |
| Подкасты | `getPodcasts(ids)`, `getEpisodes(ids)`, `episodes(ids)` | Подкасты и эпизоды. |
| История/профиль | `listeningHistory(limit, offset)`, `listenedEpisodes`, `notificationsHasUnread`, `profileFollowersCount(ids)`, `followingCount(id)` | История, уведомления и профильные счётчики. |
| Подборки | `synthesisPlaylist(ids)`, `synthesisPlaylistBuild(firstAuthorId, secondAuthorId)` | Получение и построение синтезированной подборки. В checked-in каталоге mutations `synthesisPlaylistBuild` объявлен как `query`. |

В snapshot находятся 26 query operations и 10 mutation operations. Веб-приложение дополнительно использует `getPaginatedCollection(limit, after)` с `paginatedCollection.tracks.items/page.endCursor`; этой операции нет в Python `userTracks` document. Browser и ephemeral terminal ранее подтвердили initial/next cursor pages с `200`; в списке наблюдались повторные IDs и расхождение с collection count. Для полного экспорта нужна дедупликация и reconciliation страниц.

### Независимый актуальный Swift-клиент: `korenskoy/zvuk-swift`

Публичный GitHub README в Chrome подтверждает, что [`korenskoy/zvuk-swift`](https://github.com/korenskoy/zvuk-swift/tree/8245d4e39abe93739cc0c01249a6e8a460fe5cb3) на HEAD `8245d4e39abe93739cc0c01249a6e8a460fe5cb3` (2026-10-20) — неофициальная MIT-библиотека для Zvuk API; README заявляет требование аккаунта и оплаченной подписки. GitHub metadata и checked-in LICENSE показывают MIT. Утверждение о подписке — документация автора; доступность read-only лайков без подписки отдельно не проверялась.

- Реализация использует `POST https://zvuk.com/api/v1/graphql` с JSON GraphQL payload и `X-Auth-Token`; Tiny endpoints: `https://zvuk.com/api/tiny/*`. README просит взять поле `token` на `/api/tiny/profile`, отдельный OAuth/login UI отсутствует. В библиотеке есть anonymous profile-token helper.
- Отдельная операция `userTracks(orderBy, orderDirection)` выбирает `collection.tracks { id, collectionItemData { lastModified } }`, без `limit`/cursor; документация справедливо говорит затем гидрировать ID отдельным методом.
- Более новый web-app query `getPaginatedCollection(limit, after)` возвращает `paginatedCollection.tracks.items` с full track data и `page.endCursor`. Обёртка `getPaginatedCollectionTracks(limit:cursor:)` передаёт cursor. В GraphQL query запрашивается только `endCursor`, без `hasNextPage`; helper по умолчанию декодирует отсутствующий `hasNextPage` как `false`, поэтому приложение должно продолжать по ненулевому end cursor и само делать reconciliation. Доказательство source-level, не обещание стабильности API.
- `swift build` на checkout прошёл в среде Swift 6.4, с warning о недоступном системном framework search path; сборка пакета успешна. Тесты не запускались: интеграционные тесты читают живой аккаунт, а тест `addAndRemovePlaylistTracks` создаёт временный playlist и вызывает add/remove/delete. Не следует запускать suite на пользовательском аккаунте для этой задачи.

Это полезная независимая сверка текущего web cursor query и MIT-licensed модели данных, но не готовый connector для приложения: нет входа пользователя, нет независимого доказательства полного likes feed или subscription gate, а token передаётся вручную в процесс. Не заимствовать его код до проверки, нужен ли Swift/macOS connector в нашем продукте.

### Независимый legacy cross-check: `oklookat/gozvuk`

Статически просмотрен [MIT snapshot `fc4ed9399d70f599e0d85a133aa663d0a8cbe3fb`](https://github.com/oklookat/gozvuk/tree/fc4ed9399d70f599e0d85a133aa663d0a8cbe3fb), последний commit 2023-08-08. Go 1.20 client отправляет GraphQL JSON в `POST https://zvuk.com/api/v1/graphql` с `X-Auth-Token`; README указывает, что user token берётся из `/api/tiny/profile`. Source содержит `userCollection` (списки ID по категориям), `userTracks(orderBy, orderDirection)`, отдельный `getFullTrack(ids)` и обычный `getTracks(ids)`. `userTracks` выбирает только `id` и `collectionItemData.lastModified`, не содержит page size/cursor. `getFullTrack` запрашивает больше полей и возвращает их через GraphQL field `getTracks`. Отдельная особенность wrapper: outer request `variables` serializes как JSON string вместо JSON object; live compatibility не проверена.

README автора предупреждает, что отдельные сохранённые ID могут вернуть пустые track objects; в миграторе проверять присутствие непустого ID/title и учитывать неразрешённые записи отдельно, не считать размер массива гидратированных карточек числом исходных лайков. Repo также содержит `addItemToCollection`/`removeItemFromCollection` и другие мутации, но ни одна не нужна source-export этапу. Snapshot подтверждает существование старого non-paginated community path, не его работоспособность на текущем backend. В этой среде Go CLI/test suite не запускались; live auth повторно не выполнялся. Это независимая старая сверка к `trudenboy/zvuk-music`, а не замена актуальному `getPaginatedCollection` из веб-клиента.

### Независимый cursor-reference: `TypeHintsFun/sber-zvuk-downloader`

Проверен публичный snapshot [`43c0f8da5acab344f50da85128725f8a6a6d9c90`](https://github.com/TypeHintsFun/sber-zvuk-downloader/tree/43c0f8da5acab344f50da85128725f8a6a6d9c90), последний commit 09.02.2026; GitHub не показывает SPDX license и в репозитории нет файла `LICENSE`. Это небольшой downloader, но его favorites code — независимый reference к вебовской пагинации:

| Часть | Контракт, видимый в коде |
|---|---|
| GraphQL transport | `POST https://zvuk.com/api/v1/graphql`, JSON `{operationName, query, variables}`, заголовки `X-Auth-Token`, `x-app-name`, `Accept: application/graphql-response+json, application/json`; клиент также отправляет browser cookies и `Origin`/`Referer`/`User-Agent`. |
| Любимые треки | `getPaginatedCollection(limit, after)` → `paginatedCollection.tracks.items` с `id`, `title`, `artists.title`; следующая страница определяется по `page.endCursor`; в коде установлен размер страницы `100`. В query нет `hasNextPage` или `collectionCount`, а loop останавливается на пустых items либо отсутствующем cursor. Нет защиты от повторного cursor, сохранения checkpoint или сравнения полного набора с контрольным ответом. |
| Плейлисты | Сначала `collection.playlists { id, title }`, затем `playlistTracks(id, limit, offset)` по страницам по 100; проход завершается пустой или короткой страницей. Ошибки transport/JSON для GraphQL перехватываются и возвращают `{}`, поэтому caller может принять ошибку за конец списка. |
| Каталог и аудио | `mediaContents(ids, quality, encodeType)` для `stream`/`streamV3`; после получения ссылки скрипт скачивает аудио. Для миграции метаданных stream/download операция не нужна; извлечённая favorites карточка не запрашивает album, duration, ISRC или availability для качественного matching. |
| Авторизация и эксплуатация | README предлагает вручную копировать набор cookie из DevTools в `COOKIES_DICT`; `auth` затем используется и как cookie, и как `X-Auth-Token`. Также предлагается подставлять браузерный User-Agent и `wafv=human`, объясняя это прохождением anti-fraud/WAF, и добавлены случайные паузы для снижения риска IP block. Это credential-copy/WAF-evasion подход, не переносить в наш клиент; код не запускался и network probes с этими данными не выполнялись. |

Этот проект — дополнительное подтверждение shape cursor query, но не надёжный exporter: весь список накапливается в RAM, API errors маскируются под пустые ответы, нет проверки конца страниц и точной сверки, а README рекомендует ограничивать загрузки 200–300 треками за сеанс. Он также скачивает аудио и не содержит matcher/Apple writer. Для нашей задачи из него полезен только static query reference; безлицензионный код и ручной cookie/WAF путь не использовать как основу.

### Изменения данных — live mutations не выполнялись

| Mutation | Переменные | Эффект |
|---|---|---|
| `addItemToCollection(id, type)` / `removeItemFromCollection(id, type)` | item ID и `CollectionItemType` | Поставить/снять like с track/release/artist/playlist/podcast. |
| `addItemToHidden(id, type)` / `removeItemFromHidden(id, type)` | ID и type | Скрыть/вернуть item. |
| `createPlayList(items, name)` | имя и items | Создать плейлист. |
| `addTracksToPlaylist(id, items)` | playlist ID и items | Добавить треки. |
| `updataPlaylist(id, items, isPublic, name)` | ID/items/видимость/имя | Обновить плейлист; operation написан `updataPlaylist` в исходнике. |
| `renamePlaylist(id, name)` / `setPlaylistToPublic(id, isPublic)` | ID и свойства | Переименовать или изменить видимость. |
| `deletePlaylist(id)` | ID | Удалить плейлист — не вызывать в миграторе. |

Live проверки касались только чтения. Для нашей миграции нужны source reads; коллекцию Звука менять не надо.

## Наблюдения авторизованного web app

### Same-origin GraphQL и Tiny metadata recheck (27.10.2026)

На уже открытой авторизованной `/favorites` вкладке Chrome выполнен без UI navigation один read-only запрос `POST /api/v1/graphql` с `{ operationName: "SafeProbe", query: "query SafeProbe { __typename }" }` из контекста страницы и `credentials: same-origin`. Ответ: `200 application/json; charset=utf-8`, только ключ `data.__typename`, `errors` отсутствовал. Эквивалентный без-cookie terminal запрос в той же итерации получил `418 text/html`; значит страничный контекст может вызывать GraphQL без ручного копирования bearer/cookie в приложение. Это лишь проверка безопасного query, не повтор лайков и не подтверждение независимого CLI auth.

Дополнительно из того же контекста проверен описанный в `ZvukDownloader` `GET /api/tiny/tracks?ids=-987654321&include=track`: он вернул `404 text/html` (548 bytes) на синтетический несуществующий ID. Это не подтверждает доступность route и не доказывает его отсутствие: ответ не был JSON и ID заведомо некаталожный. Реальный user track ID не использовался. Страничный код не читал cookies/headers/storage; raw response bodies не сохранялись. Никаких mutations не было.

27.10.2026 переход на видимую страницу `/favorites` в Chrome вызвал GraphQL `getPersonalWave(waveSrc, first, waveType)` и `getSubscriptions(status)`, `GET /api/tiny/profile`, `/api/featured/info`, `/desktop-data/api/cookieAPI`, а также Next.js `/desktop-data/_next/data/{buildId}/{page}.json` для `index`, `search`, `popular`, `kids`, `collection`, `favorites`, `notifications`. Это traffic inventory выбранных страниц, не полный список backend. Ответы с данными библиотеки не сохранялись.

### Свежая сверка frontend bundle из браузера и чистого терминала

27.10.2026 открыта отдельная Chrome-вкладка `https://zvuk.com/favorites`. В ней UI отрисовал заголовок «Любимое», `0 треков` и cookie-consent banner; это анонимное состояние не доказывает, что пользовательская коллекция пуста. В CDP-событиях этой загрузки не было `POST /api/v1/graphql`, поэтому из неё не делается вывод об авторизованном API.

В повторной сессии 27.10.2026 прямой browser navigation `/api/v2/tiny/profile` вернул JSON с `result.profile.token`; значение не выводилось. На живой `/favorites` странице наблюдались GraphQL operations `getPaginatedCollection(limit, after)`, `getCollectionIds`, `getUnreadNotificationsCount` и `getCollectionCount`. Используя только browser request context и `limit=1`, clean terminal replay `getPaginatedCollection` вернул HTTP 200, без GraphQL errors, с одним item и следующим cursor. Terminal профильный GET при этом вернул 307, поэтому этот маршрут нельзя считать воспроизведённым простым копированием cookie jar; для GraphQL replay понадобились token и app/device headers. Значения headers/куки не попали в docs; temporary 0600 files удалены.

Для получения приложения выполнены чистые terminal GET без cookies: `https://zvuk.com/favorites` вернул `200 text/html`, но это challenge shell от Servicepipe — в body не было `__NEXT_DATA__`, Next asset URLs или API strings; не принимать один HTTP 200 за доступ к приложению. Публичные CDN ресурсы `https://cdn-new.zvuk.com/desktop-static/_next/static/v8.20.1/_buildManifest.js` и chunks для `/favorites` ответили `200 application/javascript`. Build manifest подтверждает route `/favorites` и build `v8.20.1`; `pages/favorites-676e0691ac8f1436.js` вызывает клиентский `collectionService.getProfileFavoritesInfo({limit: d.X1, after: ""})`, а список использует `collectionService.getPaginatedCollection` с cursor `endCursor`. `d.X1` соответствует наблюдавшемуся browser `limit=30`. Это static frontend contract, а не самостоятельный live GraphQL response.

Чистый frontend bundle fetch дал возможность изучить UI-route без auth-секретов, но не снял барьер для terminal API-запросов: `/api/v1/graphql` и профили по-прежнему проверять отдельно через активную пользовательскую сессию. Query/mutation payloads и любые account records из CDN bundle в документацию не копировались.

В трёх страницах/общих chunks обнаружены такие frontend service methods (это имена клиентского слоя; считать их точными backend GraphQL operation names нельзя):

| Экран | Метод клиента | Видимые аргументы/назначение |
|---|---|---|
| `/favorites` | `collectionService.getProfileFavoritesInfo` | Стартовая загрузка с `{limit: 30, after: ""}`; обновляет начало списка и сведения профиля/счётчика |
| `/favorites`, `/collection`, `/listening-history` | `collectionService.getPaginatedCollection` / `getPaginatedCollectionAll` | Cursor traversal с `limit: 30`, стартовым `after: ""` и следующим `after: endCursor`; collection page прокидывает ещё filter-поля |
| `/collection` | `collectionService.getPaginatedCollectionAllSections` | Первая порция `limit: 15`, `after: ""`, флаги `withPlaylists`, `withReleases`, `withArtists`, `withPodcasts`, `withBooks` |
| `/collection` | `collectionService.getCollectionCount` | Счётчик liked tracks; UI вызывает отдельно от cursor-страниц, поэтому live-аудит уже показал, что он не является надёжной контрольной суммой |
| `/collection` | `collectionService.getCollectionIds` | Используется при поиске, чтобы отделить уже добавленное в коллекцию от остального; live terminal cross-check уже сверил union cursor-ID с этим результатом |
| Разные страницы | `collectionService.getTracksShortInfo` | Гидрация/короткие карточки по IDs; не является методом получения полного списка лайков |

Полный статический обход 100 JS chunks build `v8.20.1` из terminal прошёл без cookies: все 100 ответили `200`, суммарно около 2.17 MB. Кроме известных collection methods в нём встречались другие `getTracks` wrappers, но extracted route chunks не содержали явных GraphQL `operationName`/HTTP API path strings. Поэтому это расширяет карту клиентского слоя, но не заменяет live capture authenticated GraphQL variables и серверных ответов.

### Повторная проверка текущей сборки и чистого CLI (27.10.2026)

После нового открытия `/favorites` в подключённом Chrome UI снова показал `0 треков` и cookie consent; это анонимная вкладка, пользовательский список не проверен. Страница загрузила build `v8.20.1`; в текущем документе присутствовали 60 JS script URLs. Отдельно по публичному `_buildManifest.js` из терминала скачаны все 100 перечисленных JS assets (HTTP 200). Имена client-side методов, найденные в bundle scan: `getProfileFavoritesInfo`, `getPaginatedCollection`, `getCollectionIds`, `getCollectionCount`. Поиск литералов `/api/v1`, `/api/v2`, `/api/tiny` и query/mutation operation names в 100 исходниках не нашёл точек GraphQL транспорта; вероятно, transport и документы собираются/обфусцируются в другом runtime слое, поэтому это нельзя считать полным endpoint inventory или доказательством отсутствия `/api/v2`.

Свежие credential-free terminal запросы к `GET /api/tiny/profile`, `GET /api/v2/tiny/profile` и безопасному `POST /api/v1/graphql` (`query { __typename }`) все вернули `418 text/html`. Ответы и пользовательские данные не сохранялись. Это подтверждает текущий CLI challenge на этих маршрутах, но не проверяет аутентифицированную работоспособность и не меняет вывод из прежнего авторизованного read-only cursor walk.

### Повторное сравнение текущей Chrome-сессии и чистого terminal GET (27.10.2026)

В новой вкладке существующего Chrome direct navigation на `/api/v2/tiny/profile` показал JSON с `result.profile` и полем `token`; отдельно вернули только список имён полей и булевый признак наличия token. Значение token и значения личных полей `email`/`phone` не выводились и не сохранялись. Browser wrapper в этом чтении не отдал HTTP status, поэтому свежая проверка подтверждает JSON response shape и доступ с текущей сессией, но не новый status code. Затем clean Python `urllib` GET на тот же URL без браузерной сессии вернул HTTP `418 text/html`; response body не сохранялся. Это подтверждает сессионное различие; для HTTP 200 авторизованного profile route остаются предыдущие практические записи выше.

### Повторная проверка авторизованной вкладки и чистого CLI (27.10.2026)

В подключённом Chrome пользовательская вкладка `https://zvuk.com/favorites` показала активный профиль и заполненный список «Любимое». Это подтверждает, что в этой вкладке есть авторизованная сессия; количество и содержимое списка не сохранялись. Прежние снимки страницы с `0 треков` относились к отдельной анонимной вкладке и не описывают эту сессию.

Пассивное наблюдение загрузки страницы в этой проверке показало CDN/Next.js assets, но не дало пригодной трассы GraphQL вызова: method, operation, status и response shape повторно не подтверждены. Поэтому эту вкладку можно считать доказательством доступной авторизованной UI-сессии, но не новой сетевой фиксацией API. В отдельном чистом Python `urllib` без cookies/token три read-only запроса — `GET /api/tiny/profile`, `GET /api/v2/tiny/profile` и `POST /api/v1/graphql` с `{ __typename }` — каждый получили `418 text/html`. Это подтверждает текущий no-session WAF/challenge; оно не опровергает ранее зафиксированный authenticated cursor replay. Ни cookies, ни token, ни пользовательские карточки/ID в файлы не записывались.

### Живая трасса `/collection` в активной Chrome-сессии (27.10.2026)

В подключённой вкладке Звука после перехода на видимую страницу `/collection` пассивно записаны два успешных чтения с `POST https://zvuk.com/api/v1/graphql`, оба HTTP `200`:

| Operation | Переменные запроса | Безопасно сохранённая форма ответа |
|---|---|---|
| `getCollectionCount` | GraphQL variables отсутствуют | `data.collectionCount.tracks: number` |
| `getPaginatedCollectionAll` | `after`, `limit`, `withArtists`, `withBooks`, `withPlaylists`, `withPodcasts`, `withReleases`; начальный запрос передал `limit=15`, курсор не передавался | `data.paginatedCollection` содержит `artists`, `books`, `playlists`, `podcasts`, `releases`; у секций форма `items[]` + `page.{endCursor,hasNextPage}` |

На первом ответе `getPaginatedCollectionAll` отдельная секция `tracks` в форме ответа не наблюдалась. Поэтому этот запрос подтверждает загрузку разделов коллекции и их cursor-пагинацию, но сам по себе не является экспортом понравившихся треков; для них остаются отдельные `getPaginatedCollection`/`getCollectionIds` пути из предыдущих capture. `getCollectionCount` возвращает поле числа треков, но фактическое значение не сохранялось и этот счётчик нельзя использовать как checksum полноты.

Из сетевой трассы оставлены только operation names, имена переменных, типы/имена полей и HTTP status. Значения cookies, токенов, идентификаторов, названий, количества записей и cursor не выводились и не сохранялись; запросы были read-only.

### Живая трасса `/favorites` и чистая terminal-проверка (27.10.2026)

В той же подключённой Chrome-сессии открыта видимая страница `/favorites`. Пассивная трасса подтвердила эти read-only операции `POST /api/v1/graphql` (все `200 application/graphql-response+json`):

| Operation | Переменные | Форма ответа |
|---|---|---|
| `getPaginatedCollection` | `after`, `limit`; начальный вызов: пустой cursor и `limit=30` | `data.paginatedCollection.tracks.{items,page.endCursor}`; `hasNextPage` в наблюдённой форме `page` отсутствовал |
| `getCollectionIds` | без variables | `data.collection.{artists,bookAuthors,books,chapters,episodes,playlists,podcasts,profiles,releases,tracks}`, категории представлены массивами `{id}` |
| `getCollectionCount` | без variables | `data.collectionCount.tracks: number` |

Схема короткой track-card в cursor-ответе включает ключи `id`, `title`, `artists`, `release`, `duration`, `availability`, `explicit`, `hasFlac`, `lyrics`, `mark`, `artistTemplate`, `childParam`, `zchan`, `__typename`; сохранены только имена полей и типы. `getCollectionIds` даёт ID-only набор категорий для reconciliation; конкретные ID не записывались. Поскольку observed `page` содержит `endCursor`, но не `hasNextPage`, экспортёр должен обнаруживать завершение аккуратно и сверять собранные уникальные IDs с `getCollectionIds`, не полагаясь на count.

Сразу после browser capture без cookies и любого auth header из terminal отправлен только публичный безопасный GraphQL probe `query SafeProbe { __typename }`; он вернул `418 text/html`. Response body не сохранялся. Это повторно подтверждает различие между browser session и чистым CLI/WAF, не доказывая отсутствие API и не оправдывая обход антибот-защиты. В трассе не читались заголовки авторизации/cookies и не сохранялись значения коллекции; никаких mutations не выполнялось.

### Свежая Chrome-трасса `/favorites` (27.10.2026)

Для отдельной проверки открыт новый Chrome tab на `/favorites`; исходную вкладку пользователя не перезагружали. После завершения загрузки/гидрации зафиксированы read-only GraphQL operations `getPaginatedCollection` (`after`, `limit`), `getCollectionIds` (без variables), `getCollectionCount` (без variables) и `getUnreadNotificationsCount` (`availableTypes`). Все четыре запроса к `POST /api/v1/graphql` получили `200 application/graphql-response+json`. Дополнительно `GET /api/tiny/profile` ответил `200 application/json`; тело и поля профиля не читались.

Эта трасса независимо подтверждает, что текущий web UI запускает cursor-запрос лайков и ID/count cross-check в открытой Chrome-сессии. В документацию перенесены только operation names, имена variable keys, route, status и MIME type; значения headers/variables, response bodies, трековые названия/ID и cursor не сохранялись. Эта итерация не выполняла terminal replay с browser credentials; свежий чистый unauthenticated terminal probe не запускался. Схема ответов и пагинационная логика остаются подтверждены предыдущими проверками выше.

### Проверка завершения cursor-выгрузки и terminal boundary (27.10.2026)

В отдельной Chrome-вкладке `/favorites` после включения сетевого наблюдения выполнено read-only прокручивание списка. Ответы GraphQL разбирались только внутри процесса: track IDs накапливались в set и сразу сравнивались с `collection.tracks` из `getCollectionIds`; названия, ID, cursor, число треков и тело ответа не записывались. Курсоры продвигались без повторов, GraphQL `errors` не было, body retrieval завершился без ошибок. Уникальный набор из cursor-страниц совпал с ID-only списком `getCollectionIds`; повторные карточки страниц были дедуплицированы. `getCollectionCount.tracks` не совпал с числом уникальных cursor IDs, поэтому count нельзя использовать как checksum. Ответ страницы не содержал `hasNextPage`; проверка завершила чтение по совпадению наборов, а не по серверному флагу конца.

Следом чистый terminal `curl` без cookies/token проверил `GET /api/tiny/profile`, `GET /api/v2/tiny/profile` и безопасный `POST /api/v1/graphql` с `query SafeProbe { __typename }`. Все вернули `418 text/html`; тела ответов не сохранялись. Это доказывает лишь, что прямой unauthenticated CLI path блокируется WAF. Авторизованный replay с browser credentials в той проверке не выполнялся; он проверен отдельно ниже.

### Авторизованный terminal replay с текущей пользовательской сессией (27.10.2026)

В этой итерации повторно проверена уже авторизованная вкладка `/favorites`; видимая страница показывала пользовательский список «Любимое». Через Chrome DevTools локально выбран только один cookie с домена Звука. Его значение не выводилось и временно записывалось в cookie jar с правами `0600`; полный cookie jar и профиль Chrome не копировались.

Сначала проверен cookie `access_token`: `/api/v2/tiny/profile` ответил `200`, но `result.profile.is_anonymous=true`; оба GraphQL списка лайков вернулись пустыми. Равенство двух пустых наборов ложно выглядело как успешная reconciliation. Этот результат отозван и не считается проверкой экспорта.

Проверенный пользовательский путь использует cookie `auth`. `curl` к `GET https://zvuk.com/api/v2/tiny/profile` с cookie `auth`, `Accept: application/json`, Chrome `User-Agent`, `Origin: https://zvuk.com` и `Referer: https://zvuk.com/favorites` завершил HTTP `307` redirect и получил `200 application/json`; `result.profile.is_anonymous=false`, token находится в `result.profile.token`. Значение token использовано только в памяти как `X-Auth-Token` для `POST https://zvuk.com/api/v1/graphql/`.

С этой подтверждённой учётной сессией terminal прошёл все страницы реального web-client operation `getPaginatedCollection(limit:30, after)`, выбирая только `{ id }` и продолжая по `page.endCursor`. Cursor завершился; выборка была непустой, а unique ID set совпал с отдельным минимальным `getCollectionIds { collection { tracks { id } } }`; каждый page/readback запрос ответил `200` без GraphQL errors. Дополнительная одна карточка вернула поля трека `id`, `title`, `duration`, `availability`, `explicit`, `artists[{id,title}]`, `release[{id,title}]`. Запрос поля `isrc` был отклонён schema validation (`Cannot query field "isrc" on type "Track"`), значит Zvuk GraphQL карточка не дала ISRC в этой проверке.

Так подтверждены локальный CLI login без developer Client ID/secret, полный read-only экспорт likes IDs и доступные поля для matching. Имена, реальные ID, размер библиотеки, cursor и token не выводились и не сохранялись; temporary cookie/header файлы удалены. Mutations не отправлялись. Веб API private и нестабильный; запросы без пользовательской сессии по-прежнему могут получать `418 text/html`.

### Повторная UI-triggered трасса из Chrome (28.10.2026)

В существующей Chrome-сессии без чтения cookies/storage открыты видимые разделы «Коллекция» и «Любимое». При навигации страница запросила `GET /desktop-data/_next/data/v8.20.1/collection.json` и `GET /desktop-data/_next/data/v8.20.1/favorites.json`; загрузка «Любимое» также вызвала `POST /api/v1/graphql` с operations `getPersonalWave` и `getPaginatedCollection`, а также `GET /desktop-data/api/cookieAPI`. Это наблюдение названий маршрутов/операций из DevTools request events; тела, заголовки и HTTP-статусы этих запросов не читались. Оно подтверждает, что маршрут likes collection активен в текущем UI, но не является новой проверкой полноты или статуса страницы.

Сразу после UI-проверки чистые no-cookie terminal запросы к `POST /api/v1/graphql` с `query ReadOnlyProbe { __typename }` и `GET /desktop-data/_next/data/v8.20.1/favorites.json` вернули `418 text/html`. Тела отброшены. Совпадение с уже описанной WAF boundary не опровергает доступность authenticated UI. URL значения, идентификаторы коллекции, cookies, tokens, response bodies и данные треков в записи не включались; мутаций не было.

## Device login и GraphQL из source `zvuk/kithara`

В GitHub-организации `Zvuk LLC` найден Rust workspace [`zvuk/kithara`](https://github.com/zvuk/kithara), HEAD `1e49fd342bcb614dba31db8c8a6d675b9dbeaf42` от 27.10.2026; GitHub metadata указывает Apache-2.0. Организация GitHub в настоящее время не отмечена как verified, поэтому это сильный source reference под именем компании, но не опубликованный/гарантированный API-контракт. Просмотрены `kithara-app-zvuk` auth/client source и tests; live QR-start проверен ниже, но пользовательская авторизация и вызовы с выданным access token не завершались. Все API запросы этого crate получают настроенный `User-Agent`; значения его client identity нужно считать частью сервиса-зависимого поведения и не подменять без проверки.

В отличие от web-session подхода, клиент реализует QR device sign-in, при котором пароль и MFA вводятся в открытой сервисной странице:

| Этап | Запрос и форма по source |
|---|---|
| Начать вход | `POST https://zvuk.com/api/tiny/login/qr/session`, `Content-Type: application/json`, JSON `{ "device_id": "<fresh UUID>" }`; ответ читается как `{ result: { device_code, expires_in, qr_authorization_url } }`. |
| Пользователь подтвердит вход | Клиент открывает `qr_authorization_url` системным браузером; пароль не передаётся приложению. |
| Poll результата | `GET https://zvuk.com/api/tiny/login/qr/token?device_code=<device_code>` без пользовательского auth token; опрашивается каждые 2 секунды до `expires_in`. Ответ — `result.status` `pending` либо `success`, при успехе `result.access_token`. |
| Проверить имя профиля | `GET https://zvuk.com/api/v2/tiny/profile` с `X-Auth-Token`; source читает `result.profile.name`. |
| Отключить/revoke | `POST https://zvuk.com/api/tiny/logout` с `X-Auth-Token`; source отзывает сессию и удаляет локальный секрет независимо от ответа сервиса. |

Token сохраняется через абстракцию `Secrets`; README Kithara описывает OS keystore, когда включена feature `keystore`, иначе конфигурационный secrets overlay. Встроенная сессионная авторизация подходит под «войти в аккаунт у сервиса», не требует нашего OAuth Client ID и предоставляет явный logout endpoint. Это пока только кодовая подсказка: QR endpoints, consent, expiry, revoke и платформенный secret store нужно проверить на отдельном аккаунте до выбора как production flow.

### Live QR-start probe из Chrome (28.10.2026)

Без чтения Chrome cookies/storage из уже открытой страницы `https://zvuk.com/` выполнен same-origin `POST /api/tiny/login/qr/session` с новым случайным `device_id`. Браузер получил `200 application/json`; у `result` были ключи `device_code`, `user_code`, `expires_in`, `qr_authorization_url`, `expires_in=300`. Значения кодов и URL не записывались и не включались в вывод. Чистый terminal Python `urllib` POST на тот же маршрут без browser context/cookies получил `418 text/html`; body отброшен. Это подтверждает только запуск QR-сессии из browser origin, не выпуск access token.

Открытие выданного URL привело на `https://id.zvuk.com/` с экраном входа по номеру телефона и SMS-коду. Видимая форма сообщает о принятии условий сервиса и обработке персональных данных при продолжении; рекламная подписка показана отдельным checkbox. Уже активная сессия `zvuk.com` не перевела этот экран автоматически в подтверждение устройства. Не вводились телефон/OTP, не принимались условия и не нажималась кнопка входа; poll не завершался, user access token не получен, account/library не менялись. Поэтому QR-start API живой из Chrome, а «один клик без дополнительного входа» не доказан; flow остаётся незавершённым до пользовательского входа/подтверждения в этой странице. Неодобренные device sessions истекают по указанному 300-секундному сроку.

| Задача | GraphQL operation из source |
|---|---|
| Поиск каталога | `POST https://zvuk.com/api/v1/graphql/`, `X-Auth-Token`; `search(query)` → `tracks(limit: 100) { items, page { total } }`. |
| Лайки | `KitharaLiked`: `collectionCount { tracks }` + `paginatedCollection { tracks(pagination: { first: 100 }) { items, page { hasNextPage } } }`. Ресурс поддерживает пагинацию, но текущая функция `liked_tracks()` запрашивает только первую страницу; использует `hasNextPage=false` только как fallback для вычисления `total`, не обходит следующие страницы. Экспорт полного списка из этой реализации не следует. |
| Плейлисты | `collection { playlists { id title } }`; для выбранного ID `playlists(ids: […]) { id trackCount tracks(limit: 100, offset: 0) { … } }`. Текущая функция читает только первую страницу. |
| Like/unlike | GraphQL mutation `collection.addItem(id: <id>, type: track)` или `collection.removeItem(...)`, `X-Auth-Token`. Source требует ожидаемое поле подтверждения; mutation transport настроен на один запрос без повторов. В нашем проекте writes не проверялись и не выполнялись. |

Endpoint в crate задан как `https://zvuk.com/api/v1/graphql/` (trailing slash); профиль остаётся отдельным `/api/v2/tiny/profile`, а QR/login/logout — versionless `/api/tiny/...`. Значит проверенная версия API — GraphQL v1 плюс несколько Tiny routes, среди которых есть v2 profile; общего `/api/v2/graphql` в source нет. GitHub code search по точной строке `/api/v2/graphql` также не дал результатов; это не доказывает отсутствия скрытого маршрута на сервере.

### Свежий независимый клиент: `korenskoy/yamp-zvuk-com-sharp`

Windows 11 плеер [yamp-zvuk-com-sharp](https://github.com/korenskoy/yamp-zvuk-com-sharp/tree/c0c986f89f70719d493607823dc81d0762583e5b), HEAD `c0c986f89f70719d493607823dc81d0762583e5b` (22.08.2026), проверен через GitHub code/repository API 27.10.2026. В репозитории есть MIT `LICENSE`; это клиент-плеер, не мигратор. Основная логика вызывает соседний проект `ZvukApiSharp`, который не входит в checkout, поэтому здесь подтверждён consumer-путь коллекции, но не весь transport implementation.

`ZvukService.InitializeAsync()` загружает уже переданный token, а при его отсутствии просит `ZvukClient.GetAnonymousTokenAsync()`; сервиса авторизации пользователя в этом классе нет. `AuthService` хранит пользовательский token через Windows `PasswordVault`; если vault недоступен в unpackaged режиме, секрет остаётся только в памяти. Клиент задаёт rate limit 5. Это локальный storage reference, но не готовая кнопка входа для нашего macOS/Chrome MVP.

`CacheService.GetLikedTracksAsync()` использует GraphQL client `GetPaginatedCollectionTracksAsync(limit=100, after=cursor)`, дедуплицирует по ID и продолжает по `page.endCursor`. Код задаёт `LikedTracksMaxPages=50`, то есть не более 5 000 записей, и прекращает цикл также при пустом cursor или странице меньше 100. Поле `hasNextPage` не выбирается. Если cursor остаётся после 50-й страницы, цикл всё равно возвращает и кеширует накопленное как обычный результат; явного статуса «экспорт неполный» или сравнения с общим числом тут нет. Это найденный пример скрытого клиентского потолка, а не ограничение Zvuk API. У нас следует делать обход до серверного конца и показывать ошибку/неполноту при внутреннем аварийном пределе.

Срез кода относится к последнему commit на `master`; repository metadata называет проект Windows 11 и последняя публикация была в августе 2026. Код не запускался на macOS, пользовательские аккаунты и API-вызовы этого приложения не проверялись. См. также [краткую оценку проекта](../PROJECTS.md#самые-полезные-кандидаты).

### Дополнительный UX/API reference: Crossfade

В кандидате [`RoninHikami/Crossfade`](https://github.com/RoninHikami/Crossfade/tree/342110df795dc65f45ef198964b9a90fb8d7e9db), ветка `claude/sweet-ride-lejbvy`, увиден компактный Chrome MV3-переносчик между Spotify, Яндексом, Звуком и YouTube Music. GitHub license metadata не задана, checked-out `LICENSE` отсутствует. Статический audit показал: Zvuk connector пытается получить профиль сначала через `/api/v2/tiny/profile`, затем `/api/tiny/profile`; GraphQL reads/writes идут только на `/api/v1/graphql`. Лайки он читает через `userTracks(orderBy: dateAdded, orderDirection: desc)` без cursor, затем гидрирует `getTracks(ids)` группами по 100; like mutation `collection.addItem` выполняется по одному треку. Это не полный экспорт-контроль: code не проверяет cursor/total и не сверяет гидратированные ID с likes list.

Crossfade демонстрирует желаемый user flow: кнопка подключения сначала использует вход на `zvuk.com` в браузере, при необходимости открывает сервисную вкладку и ждёт входа; полученный profile token сохраняется в `chrome.storage.local`. Есть явный ручной fallback ввода токена. Расширение включает `cookies` permission для YouTube auth; остальным сервисам запрашивает OAuth/session access, поддерживает pause/resume, fuzzy matching, run history и optional auto-sync, который автоматически добавляет лайки. Spotify всё равно требует пользовательский Client ID/app allowlist; исходники не объявляют лицензию, а ZV/Spotify/Yandex API остаются private/shared-client paths. Проверено статически; unit suite `node --test tests/*.test.js` прошёл: 38/38 на предоставленном Node runtime. Отдельных service tests для Yandex/Spotify в checkout нет; Chrome extension не устанавливался и аккаунты не подключались. Заимствовать можно UX-идеи после license clearance, не код.

### Независимая сверка импорта коллекции: `lubaskinc0de/beatstash`

На GitHub найден MIT-проект [Beatstash](https://github.com/lubaskinc0de/beatstash/tree/2ac4573273fd4b2037a04dcda9c216ea230f1d4d), HEAD `2ac4573` (последнее обновление 24.10.2026). Это self-hosted Telegram bot + Navidrome: в текущем README Zvuk импортируется в локальную аудиобиблиотеку вместе с лайками, сохранёнными альбомами и плейлистами; Spotify, Яндекс Музыка и YouTube Music отмечены как planned. Это не Apple Music importer и не перенос только метаданных.

Источник независимо подтверждает текущую форму Zvuk-запросов: `POST /api/v1/graphql` с JSON `{operationName, query, variables}` и `X-Auth-Token`; `userCollection { tracks { id } releases { id } playlists { id } artists { id } }`; `getTracks(ids)` — отдельная гидратация треков группами по 100. В `userCollection` нет cursor/limit, поэтому точная полнота больших likes-списков из этого проекта не доказана. Обычные playlists читаются отдельным запросом `getPlaylists(ids: [$id]) { trackCount tracks(limit: 100, offset: $offset) }` с проходом до `trackCount`; удалённые/недоступные элементы могут отсутствовать в странице.

Для проверки аккаунта Beatstash использует `GET /api/v2/tiny/profile`, затем проверяет `profile.is_registered`, subscription status, наличие `premium` в `services_available` и expiration. Это subscription gate самого Beatstash, который нужен его аудио-ingest потоку. Он не доказывает, что Zvuk блокирует сам read-only GraphQL collection без подписки. Документация просит пользователя вручную открыть `/api/tiny/profile`, скопировать token и отправить его Telegram bot; bot удаляет сообщение и хранит token, зашифрованный AES-256-GCM с `SECRET_KEY`. Такой flow отправляет credential за пределы устройства в Telegram/self-hosted сервер и не соответствует нашему предпочтительному локальному connector UX.

`Client` использует persistent cookie jar и фиксированный браузерный User-Agent; комментарий к коду говорит, что Tiny routes иначе получают anti-bot redirect/418. Это кодовый workaround автора, не подтверждённый нашей live-проверкой и не рекомендуемый шаблон для importer. В репозитории есть тестовый HTTP mock с проверками `/api/v2/tiny/profile`, `/api/v1/graphql` и subscription states; это mock coverage, не live service contract. Код не запускался и аудиопотоки не запрашивались.

## Продуктовый вывод

- User-only sign-in можно сделать как кнопку «Подключить Звук»: локально открыть сайт, пользователь входит только у провайдера, приложение получает минимальный session token из same-origin профиля или использует существующую browser session.
- Это не OAuth и community API не обещает refresh contract; при отзыве/истечении token потребуется повторно пройти вход. Не просить пароль/OTP и не отправлять token на сервер проекта.
- Чистый внешний CLI блокируется WAF. Не обходить bot detection и не добавлять stealth/anti-bot bypass. Приватные endpoints могут меняться и зависеть от подписки/региона.

## Источники

- [`trudenboy/zvuk-music` pinned source](https://github.com/trudenboy/zvuk-music/tree/ed491f61bc7b18c9f327017a8a87d9fe183022a7/zvuk_music).
- [`Basil-AS/ZvukDownloader` API notes](https://github.com/Basil-AS/ZvukDownloader/blob/922e2587f52a411a05695fd6454bb6dd40afba5a/API_DOCUMENTATION.md) и [implementation](https://github.com/Basil-AS/ZvukDownloader/blob/922e2587f52a411a05695fd6454bb6dd40afba5a/zvuk_multibot.py).
- [`oshokin/zvuk-grabber` login notes](https://github.com/oshokin/zvuk-grabber/blob/c9079597bc431109c0c9cd4596dd5bd48032e2fc/docs/usage.md): reviewed statically only; its stealth/anti-bot behavior is explicitly excluded from our workflow.
- [`Aiving/sberzvuk-api`](https://github.com/Aiving/sberzvuk-api), [`korenskoy/zvuk-swift`](https://github.com/korenskoy/zvuk-swift), [`oklookat/gozvuk`](https://github.com/oklookat/gozvuk).
