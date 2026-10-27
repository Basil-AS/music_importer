# Звук: инвентарь API v1, Tiny API и пользовательского входа

Срез на 27.10.2026. Официальной публичной API-спецификации не найдено; это reverse-engineered интерфейсы веб-клиента и community-библиотек, не обещанный стабильный контракт. Здесь «API v1» — GraphQL `/api/v1/graphql`; Tiny REST встречается как `/api/tiny/...` и `/api/v2/tiny/...`. Не следует считать все Tiny-маршруты API v2.

## Вход и получение токена

1. Пользователь входит на `https://zvuk.com` обычным способом; пароль и OTP вводятся только на сайте Звука.
2. В активной сессии браузерные `GET /api/tiny/profile` и `GET /api/v2/tiny/profile` возвращают JSON профиля с session token. В Chrome 27.10.2026 оба маршрута ответили `200 application/json`; в versionless пути token находится в `result.token`, в `/api/v2/` — в `result.profile.token`. Значения не выводились, не сохранялись и не коммитились.
3. Community-клиенты передают token в `X-Auth-Token`; веб-клиент использует same-origin cookie-сессию. Это bearer-секрет: хранить только локально в системном хранилище; не помещать в URL, логи, shell history или Git.
4. Анонимный token упоминается в README `zvuk-music` и `sberzvuk-api`, но его получение из чистого CLI здесь не подтвердилось: без cookies три проверки получили `418 text/html` от защиты. Не трактовать WAF `418` как отсутствие API.

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

### Независимый legacy cross-check: `oklookat/gozvuk`

Статически просмотрен [MIT snapshot `fc4ed9399d70f599e0d85a133aa663d0a8cbe3fb`](https://github.com/oklookat/gozvuk/tree/fc4ed9399d70f599e0d85a133aa663d0a8cbe3fb), последний commit 2023-08-08. Go 1.20 client отправляет GraphQL JSON в `POST https://zvuk.com/api/v1/graphql` с `X-Auth-Token`; README указывает, что user token берётся из `/api/tiny/profile`. Source содержит `userCollection` (списки ID по категориям), `userTracks(orderBy, orderDirection)`, отдельный `getFullTrack(ids)` и обычный `getTracks(ids)`. `userTracks` выбирает только `id` и `collectionItemData.lastModified`, не содержит page size/cursor. `getFullTrack` запрашивает больше полей и возвращает их через GraphQL field `getTracks`. Отдельная особенность wrapper: outer request `variables` serializes как JSON string вместо JSON object; live compatibility не проверена.

README автора предупреждает, что отдельные сохранённые ID могут вернуть пустые track objects; в миграторе проверять присутствие непустого ID/title и учитывать неразрешённые записи отдельно, не считать размер массива гидратированных карточек числом исходных лайков. Repo также содержит `addItemToCollection`/`removeItemFromCollection` и другие мутации, но ни одна не нужна source-export этапу. Snapshot подтверждает существование старого non-paginated community path, не его работоспособность на текущем backend. В этой среде Go CLI/test suite не запускались; live auth повторно не выполнялся. Это независимая старая сверка к `trudenboy/zvuk-music`, а не замена актуальному `getPaginatedCollection` из веб-клиента.

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

Следом чистый terminal `curl` без cookies/token проверил `GET /api/tiny/profile`, `GET /api/v2/tiny/profile` и безопасный `POST /api/v1/graphql` с `query SafeProbe { __typename }`. Все вернули `418 text/html`; тела ответов не сохранялись. Это повторно доказывает лишь, что прямой unauthenticated CLI path блокируется WAF. Авторизованный terminal replay в этой итерации не выполнялся.

## Продуктовый вывод

- User-only sign-in можно сделать как кнопку «Подключить Звук»: локально открыть сайт, пользователь входит только у провайдера, приложение получает минимальный session token из same-origin профиля или использует существующую browser session.
- Это не OAuth и community API не обещает refresh contract; при отзыве/истечении token потребуется повторно пройти вход. Не просить пароль/OTP и не отправлять token на сервер проекта.
- Чистый внешний CLI блокируется WAF. Не обходить bot detection и не добавлять stealth/anti-bot bypass. Приватные endpoints могут меняться и зависеть от подписки/региона.

## Источники

- [`trudenboy/zvuk-music` pinned source](https://github.com/trudenboy/zvuk-music/tree/ed491f61bc7b18c9f327017a8a87d9fe183022a7/zvuk_music).
- [`Basil-AS/ZvukDownloader` API notes](https://github.com/Basil-AS/ZvukDownloader/blob/922e2587f52a411a05695fd6454bb6dd40afba5a/API_DOCUMENTATION.md) и [implementation](https://github.com/Basil-AS/ZvukDownloader/blob/922e2587f52a411a05695fd6454bb6dd40afba5a/zvuk_multibot.py).
- [`oshokin/zvuk-grabber` login notes](https://github.com/oshokin/zvuk-grabber/blob/c9079597bc431109c0c9cd4596dd5bd48032e2fc/docs/usage.md): reviewed statically only; its stealth/anti-bot behavior is explicitly excluded from our workflow.
- [`Aiving/sberzvuk-api`](https://github.com/Aiving/sberzvuk-api), [`korenskoy/zvuk-swift`](https://github.com/korenskoy/zvuk-swift), [`oklookat/gozvuk`](https://github.com/oklookat/gozvuk).
