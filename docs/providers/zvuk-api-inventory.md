# Звук: инвентарь API v1, Tiny API и пользовательского входа

Срез на 27.10.2026. Официальной публичной API-спецификации не найдено; это reverse-engineered интерфейсы веб-клиента и community-библиотек, не обещанный стабильный контракт. Здесь «API v1» — GraphQL `/api/v1/graphql`; Tiny REST встречается как `/api/tiny/...` и `/api/v2/tiny/...`. Не следует считать все Tiny-маршруты API v2.

## Вход и получение токена

1. Пользователь входит на `https://zvuk.com` обычным способом; пароль и OTP вводятся только на сайте Звука.
2. В активной сессии браузерные `GET /api/tiny/profile` и `GET /api/v2/tiny/profile` возвращают JSON профиля с session token. В Chrome 27.10.2026 оба маршрута ответили `200 application/json`; в versionless пути token находится в `result.token`, в `/api/v2/` — в `result.profile.token`. Значения не выводились, не сохранялись и не коммитились.
3. Community-клиенты передают token в `X-Auth-Token`; веб-клиент использует same-origin cookie-сессию. Это bearer-секрет: хранить только локально в системном хранилище; не помещать в URL, логи, shell history или Git.
4. Анонимный token упоминается в README `zvuk-music` и `sberzvuk-api`, но его получение из чистого CLI здесь не подтвердилось: без cookies три проверки получили `418 text/html` от защиты. Не трактовать WAF `418` как отсутствие API.

## Точки входа и REST

| Назначение | Метод и путь | Параметры | Авторизация / состояние |
|---|---|---|---|
| GraphQL API v1 | `POST https://zvuk.com/api/v1/graphql` | JSON `{query, operationName, variables}` | `zvuk-music` использует HTTPS + `X-Auth-Token`; браузерные запросы same-origin с cookie-сессией. Ранее authenticated collection reads дали `200` из Chrome и при ephemeral terminal replay. Без авторизации safe `query { __typename }` дал `418 text/html` в терминале. |
| Профиль/session token | `GET https://zvuk.com/api/tiny/profile` | нет | В текущей Chrome-сессии `200`; token в `result.token`. Anonymous режим заявлен community client, но без авторизации в чистом CLI сейчас не подтверждён. |
| Профиль/session token, альтернативный путь | `GET https://zvuk.com/api/v2/tiny/profile` | нет | Chrome `200`; token в `result.profile.token`. Clean no-cookie terminal `418 text/html`; ранее другой CLI видел `307`, ответ зависит от контекста/защиты. |
| Метаданные треков | `GET /api/tiny/tracks?ids=...&include=track` | ID и optional include | `ZvukDownloader`; не логировать реальные URL с IDs. |
| Метаданные релизов | `GET /api/tiny/releases?ids=...&include=track` | ID и optional include | `ZvukDownloader` / community Tiny client. |
| Метаданные плейлистов | `GET /api/tiny/playlists?ids=...` | ID; downloader умеет `include=track` | Community Tiny client. |
| Текст песни | `GET /api/tiny/lyrics?track_id=...` | track ID | Для лайк-миграции не нужен. |
| Stream metadata | `GET /api/tiny/track/stream?id=...&quality=...` | ID; `mid`/`high`/`flac` | Возвращает временную stream-ссылку; не нужно для переноса. Не запрашивать/не сохранять аудио. |
| Grid content | `GET /api/tiny/grid/content?name=...&ranker_enabled=...` | имя секции и флаг | Есть в текущем `zvuk-music`; не относится к экспорту лайков. |

Без cookies/token terminal probes к `/api/tiny/profile`, `/api/v2/tiny/profile` и `/api/v1/graphql` дали `418 text/html`. Это подтверждает антибот-барьер для чистого CLI, а не несуществование endpoint. Ранее authenticated GraphQL terminal replay с ephemeral session context возвращал `200`.

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

## Продуктовый вывод

- User-only sign-in можно сделать как кнопку «Подключить Звук»: локально открыть сайт, пользователь входит только у провайдера, приложение получает минимальный session token из same-origin профиля или использует существующую browser session.
- Это не OAuth и community API не обещает refresh contract; при отзыве/истечении token потребуется повторно пройти вход. Не просить пароль/OTP и не отправлять token на сервер проекта.
- Чистый внешний CLI блокируется WAF. Не обходить bot detection и не добавлять stealth/anti-bot bypass. Приватные endpoints могут меняться и зависеть от подписки/региона.

## Источники

- [`trudenboy/zvuk-music` pinned source](https://github.com/trudenboy/zvuk-music/tree/ed491f61bc7b18c9f327017a8a87d9fe183022a7/zvuk_music).
- [`Basil-AS/ZvukDownloader` API notes](https://github.com/Basil-AS/ZvukDownloader/blob/922e2587f52a411a05695fd6454bb6dd40afba5a/API_DOCUMENTATION.md) и [implementation](https://github.com/Basil-AS/ZvukDownloader/blob/922e2587f52a411a05695fd6454bb6dd40afba5a/zvuk_multibot.py).
- [`oshokin/zvuk-grabber` login notes](https://github.com/oshokin/zvuk-grabber/blob/c9079597bc431109c0c9cd4596dd5bd48032e2fc/docs/usage.md): reviewed statically only; its stealth/anti-bot behavior is explicitly excluded from our workflow.
- [`Aiving/sberzvuk-api`](https://github.com/Aiving/sberzvuk-api), [`korenskoy/zvuk-swift`](https://github.com/korenskoy/zvuk-swift), [`oklookat/gozvuk`](https://github.com/oklookat/gozvuk).
