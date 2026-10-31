# Звук (бывший СберЗвук): API и авторизация

Статус: исходники нескольких сторонних клиентов просмотрены 27.10.2026. Официальная публичная документация API не найдена. Все перечисленные HTTP/GraphQL интерфейсы следует считать частными и меняющимися. Сводный маршрутный и operation inventory см. в [zvuk-api-inventory.md](zvuk-api-inventory.md).

## Что просмотрено

- [Basil-AS/ZvukDownloader](https://github.com/Basil-AS/ZvukDownloader), файлы `zvuk_multibot.py`, `API_DOCUMENTATION.md`, README.
- [oklookat/synchro](https://github.com/oklookat/synchro) и его Go-зависимость [oklookat/gozvuk](https://github.com/oklookat/gozvuk), snapshot исходников 2024/2023 годов.
- [Aiving/sberzvuk-api](https://github.com/Aiving/sberzvuk-api), исходники TypeScript и docs.
- [Lincoln-Continental/SberZvuk_API](https://github.com/Lincoln-Continental/SberZvuk_API), checkout `e1f7819` от 10.01.2026; Python wrapper, README, setup metadata, `client.py` и полный `queries.py`.
- [trudenboy/zvuk-music](https://github.com/trudenboy/zvuk-music), исходники, GraphQL operation-файлы, README, MIT license; на дату проверки PyPI показывал версию `0.6.3` (7 октября 2026).
- [korenskoy/zvuk-swift](https://github.com/korenskoy/zvuk-swift), Swift Package, README, GraphQL документы, transport/auth implementation, MIT; проверенный HEAD `8245d4e` от 20.10.2026.
- [trudenboy/ma-provider-zvuk-music](https://github.com/trudenboy/ma-provider-zvuk-music), Music Assistant provider; HEAD `8a9058928e7d80822717337d364e6c8abefc4b78` от 27.10.2026; provider source, setup flow, tests and Russian docs checked statically.
- Контрольные checkout исходников на 27.10.2026: `Basil-AS/ZvukDownloader` `922e258` (GitHub metadata не обнаружила license; README заявляет MIT, но в checkout нет `LICENSE`), `Aiving/sberzvuk-api` `3c157f8`, `trudenboy/zvuk-music` `ed491f6`.
- Дополнительная проверка `trudenboy/zvuk-music`: HEAD `ed491f61bc7b18c9f327017a8a87d9fe183022a7` от 07.10.2026; просмотрены HTTP transport, Tiny routes и все checked-in GraphQL operation documents.
- Найден и проверен source [`zvuk/kithara`](https://github.com/zvuk/kithara/tree/1e49fd342bcb614dba31db8c8a6d675b9dbeaf42), HEAD `1e49fd3` от 27.10.2026; просмотрены QR auth, GraphQL client, token storage and tests. Это Rust source в GitHub organization `Zvuk LLC` (GitHub не отмечает её verified); live QR-start теперь проверен, но пользовательский вход/poll/access token не завершены.
- Проверен новый browser extension reference [`RoninHikami/Crossfade`](https://github.com/RoninHikami/Crossfade/tree/342110df795dc65f45ef198964b9a90fb8d7e9db), branch `claude/sweet-ride-lejbvy`, HEAD `342110d` от 26.10.2026; source, manifest, auth/services and mocks reviewed; license metadata/`LICENSE` отсутствуют.
- Официальная справка Звука о переносе [«Как перенести музыку в Звук?»](https://help.zvuk.com/article/42207), проверена 27.10.2026.

## Авторизация в найденных клиентах

`ZvukDownloader` просит пользователя взять cookie с именем `auth` из браузера после входа на `zvuk.com`, либо получить токен из `/api/v2/tiny/profile`; затем отправляет cookie `auth=<значение>`. Это bearer-секрет активной сессии. В README/API notes есть команда передать его через CLI или хранить в `config.json`. Для нашего приложения нельзя выводить это значение в консоль/логи или коммитить конфиг. Не просить пароль пользователя и не пытаться извлекать cookie автоматически без отдельного безопасного потока.

**Chrome live-check 27.10.2026:** авторизованная страница вызвала `GET /api/tiny/profile` с `x-app-instance` и `x-device-id`, без `Cookie` header; ответ `200 application/json` содержал `result.token`. Эти app/device headers видны в браузерном запросе, их значения не сохранялись. Терминальный профильный запрос без соответствующих browser headers ответил `307`; не следует считать это отказом авторизованной сессии. Ранее no-cookie GraphQL запросы без профиля/сессионного контекста получали `418 text/html`.

**Авторизованный terminal replay, 27.10.2026:** правильная account-bound сессия приходит из cookie `auth`: `/api/v2/tiny/profile` вернул `200` с `is_anonymous=false`, затем GraphQL `getPaginatedCollection(limit:30, after)` прошёл все непустые cursor-страницы и совпал по unique IDs с `getCollectionIds`, все запросы `200`. Cookie `access_token` тоже дал профильный `200`, но `is_anonymous=true` и пустые lists; этот false positive исключён из подтверждений. One-card read подтвердил поля `id`, `title`, `duration`, `availability`, `explicit`, `artists[{id,title}]`, `release[{id,title}]`; `isrc` отклонён GraphQL validation. Только ID/имена полей и статусы записаны; реальные cookie/token/трековые данные не сохранялись, временные файлы удалены. Лайк-mutации не выполнялись. Детали: [API inventory](zvuk-api-inventory.md#авторизованный-terminal-replay-с-текущей-пользовательской-сессией-27102026).

В source `zvuk/kithara` дополнительно найден QR/device login без ввода пароля в приложение: `POST /api/tiny/login/qr/session` → системный браузер открывает `qr_authorization_url` → `GET /api/tiny/login/qr/token?device_code=…` с polling interval 2 секунды до `expires_in` → `access_token`. Далее Kithara вызывает `/api/v2/tiny/profile` с `X-Auth-Token`; Disconnect отправляет `POST /api/tiny/logout`. Token уходит в абстракцию `Secrets`/OS keystore, когда feature включена. См. точные поля и caveats в [Zvuk API inventory](zvuk-api-inventory.md). Это не публично задокументированный third-party OAuth, и его runtime contract/consent/revoke ещё требуется проверить.

**Live QR-start, 28.10.2026:** same-origin `POST /api/tiny/login/qr/session` из открытого Chrome получил `200`, response shape содержал device/user codes, authorization URL и срок 300 секунд. Чистый terminal без browser context получил `418`. Authorization URL открыл отдельный `id.zvuk.com` login, который просит номер телефона и SMS; существующая web-сессия не подтвердила устройство автоматически. Вход/OTP/условия не отправлялись и access token не выдавался. Значит endpoint работает в browser context, но простой QR login пока требует дополнительного пользовательского шага; полный flow и token polling не завершены. [Детали](zvuk-api-inventory.md#live-qr-start-probe-из-chrome-28102026).

Crossfade подтверждает альтернативный browser-session UX: сначала пробует `/api/v2/tiny/profile`, затем `/api/tiny/profile`, получает token из текущей вкладки и сохраняет его в `chrome.storage.local`; GraphQL работает только на `/api/v1/graphql`. Его `userTracks` list не имеет cursor, поэтому это быстрый prototype, но не полный exporter. Репозиторий без лицензии; код не переиспользовать до license clearance.

В просмотренном `ZvukDownloader` есть дополнительный риск: `aiohttp.TCPConnector(..., ssl=False)` отключает TLS-проверку сертификата для HTTP-сессии, через которую передаётся cookie `auth`. Его общий обработчик ошибок также логирует текст HTTP-ответа. Поэтому даже для локального чтения профиля не следует использовать этот клиент с реальным токеном без исправления TLS и очистки логов. Репозиторий не содержит файла `LICENSE`, несмотря на формулировку «MIT» в README.

**Повторный scope/security audit `Basil-AS/ZvukDownloader`, 28.10.2026:** GitHub metadata и `git ls-remote` подтвердили, что HEAD `922e2587f52a411a05695fd6454bb6dd40afba5a` не изменился; репозиторий последний раз был pushed 13.02.2026. В текущем checkout публичные методы — profile, lookup треков/релизов/плейлистов по переданным ID, artist releases, lyrics, stream и download; единственный вызываемый GraphQL query — offset-paged `getArtistReleases` (`limit` до 50 на страницу). `userCollection`, `userTracks`, paginated collection, favorites или like/unlike methods отсутствуют. `get_playlists(ids=...)` — lookup известных ID, а не чтение пользовательской библиотеки.

Повторно подтверждены риски хранения/обработки секрета: токен можно передать через CLI `--token` или plaintext `config.json`, затем он прикладывается как cookie `auth`; TLS verification выключена через `ssl=False`; non-200 response body попадает в logger, настроенный одновременно на файл `zvuk_multibot.log` и stdout. `API_DOCUMENTATION.md` также содержит похожую на токен фиксированную строку под подписью обезличенного примера; мы не копировали и не проверяли её, не следует считать её рабочей. Source checkout статически прочитан, приложение с токеном не запускалось. Для задачи это справочник отдельных Tiny/catalog routes, но не likes exporter и небезопасная основа для auth connector.

`sberzvuk-api` принимает токен конструктором и посылает его в заголовке `X-Auth-Token`. У библиотеки есть `getAnonymousToken()`, который вызывает `GET https://zvuk.com/api/tiny/profile` без входа и возвращает `result.token`; автор README сообщает об ограничениях анонимного токена, например отсутствии доступа к high bitrate.

Ещё один GitHub-кандидат, [Lincoln-Continental/SberZvuk_API](https://github.com/Lincoln-Continental/SberZvuk_API), проверен по checkout `e1f7819` от 10.01.2026. Это Python/aiohttp обёртка к `POST https://zvuk.com/api/v1/graphql`: принимает `X-Auth-Token`, умеет получить anonymous token через `/api/tiny/profile`, `search`, `search_all`, `get_track`, `get_full_track`, `get_playlist`, `get_album`, stream URL и download. Все семь query documents из `ALL_QUERIES` относятся к поиску и каталогу (`GetSearch`, `GetSearchAll`, `GetTracks`, `GetFullTrack`, `GetReleases`, `GetPlaylists`, `GetStream`); collection/likes query и like/unlike mutations в клиенте отсутствуют. README благодарит `Aiving/sberzvuk-api` за GraphQL schema; поэтому это альтернативная/производная каталожная реализация, а не новый likes API. В `setup.py` заявлена MIT, но в checkout нет `LICENSE`; код статически просмотрен и не запускался.

В checked-out TypeScript `src/graphql/execute.ts` запрос на GraphQL собран как `POST http://zvuk.com/api/v1/graphql` — схема `http`, не `https` — и вызывается с axios instance, где выставлен `X-Auth-Token`. GitHub показывает MIT, но этот код не следует запускать с авторизованным токеном до исправления endpoint на HTTPS и проверки redirect-поведения. Ни в его операциях `getSearch`, `getTracks`, `getFullTrack`, `getReleases`, `getPlaylists`, `getStream` не найдено чтения/изменения пользовательских лайков.

`zvuk-music` также принимает токен пользователя (в `X-Auth-Token`), имеет ограниченный anonymous access, sync/async Python-клиенты и MIT license. В `client.py` подтверждены `get_liked_tracks(order_by, direction)`, `like_track(id)`, `unlike_track(id)`, `get_collection()`, а в GraphQL operation-файлах — `userTracks` (возвращает track IDs и дату последнего изменения), `collection.addItem(id,type)` и `collection.removeItem(id,type)`. Важная деталь: конкретный `userTracks` document и `get_liked_tracks()` не передают cursor/page-size, а затем клиент отдельно вызывает `get_tracks(ids)` для метаданных. В отличие от этого API библиотеки, веб-клиент использует `getPaginatedCollection(limit, after)`; его cursor-путь проверен отдельно в живой сессии и чистом терминальном запросе. До сравнения total/уникальных ID у `userTracks` и `getPaginatedCollection` нельзя считать выгрузку через готовую `get_liked_tracks()` полной на больших коллекциях. По README полноценные лайки/плейлисты требуют авторизованный токен. При этом англоязычный README сверху говорит «нужна платная подписка», а ниже описывает отдельно лишь подписочные качества FLAC/320 kbps; исходники не доказывают, что чтение лайков само требует платного плана. Это противоречие нужно проверить read-only на аккаунте без подписки, если такой аккаунт доступен.

**Свежая сверка исходника 27.10.2026:** повторный shallow clone `trudenboy/zvuk-music` совпал с HEAD `ed491f61bc7b18c9f327017a8a87d9fe183022a7`. В [`userTracks.graphql`](https://github.com/trudenboy/zvuk-music/blob/ed491f61bc7b18c9f327017a8a87d9fe183022a7/zvuk_music/graphql/queries/userTracks.graphql) реально объявлены только переменные сортировки `$orderBy` и `$orderDirection`; [`client.py:get_liked_tracks()`](https://github.com/trudenboy/zvuk-music/blob/ed491f61bc7b18c9f327017a8a87d9fe183022a7/zvuk_music/client.py#L921) возвращает `collection.tracks` целиком и не реализует цикл страниц. В том же checkout автор библиотеки сделал cursor-пагинатор [`userPaginatedPodcasts($cursor, $count)`](https://github.com/trudenboy/zvuk-music/blob/ed491f61bc7b18c9f327017a8a87d9fe183022a7/zvuk_music/graphql/queries/userPaginatedPodcasts.graphql) с `endCursor` и `hasNextPage`, но не аналогичный query для liked tracks. Это усиливает вывод о пробеле именно в готовом адаптере; не доказывает, что серверная схема не умеет пагинировать `collection.tracks`. Исходник просмотрен, upstream tests и авторизованные методы не запускались.

**Повторная проверка публичного README и чистого CLI (27.10.2026):** в отдельной видимой Chrome-вкладке GitHub README на текущем HEAD явно говорит, что для использования нужен аккаунт Звука и платная подписка; раздел Anonymous Access одновременно называет анонимный токен ограниченным, а раздел Audio Quality отдельно помечает подписку для 320 kbps и FLAC. Раздел Authorized Access предлагает вручную войти в сайт, открыть `/api/tiny/profile` и скопировать `token`; это не готовый OAuth/device-login flow для приложения. Граница подписки для read-only лайков осталась неясной: статичный README не устанавливает, требуется ли платный тариф именно для collection. В терминале Python-запросы без cookies и токенов к `GET /api/tiny/profile` и `POST /api/v1/graphql` с безопасным `query SafeProbe { __typename }` ответили `418 text/html`; тела ответов не читались. Это повторяет наблюдение WAF для чистого CLI и не отвечает на вопрос о доступе лайков без подписки. Токены, куки и пользовательские данные этой проверкой не использовались.

Текущий Music Assistant provider `trudenboy/ma-provider-zvuk-music` на HEAD `8a90589` даёт независимую проверку использования библиотеки, но не добавляет нового механизма входа или пагинации. Его setup flow просит пользователя вручную получить значение из `https://zvuk.com/api/tiny/profile` и вставить его как `X-Auth-Token` в secure-string поле; провайдер создаёт `ClientAsync(token=...).init()` и проверяет `is_authorized()`. В исходниках подтверждены `get_collection()`, `get_liked_tracks()`, `like_track()` и `unlike_track()`. Вызовы ограничены пятью запросами в секунду; 429 преобразуется в 60-секундный backoff. Для синхронизации metadata-получатель разбивает уже имеющиеся ID на batches по 50: это размер batch для чтения карточек, не лимит и не доказательство полноты initial likes query. Проект — синхронизируемый media provider с активными write methods, не безопасный read-only importer; не подключать его для переноса без отключения исходящих изменений.

Новый альтернативный клиент [korenskoy/zvuk-swift](https://github.com/korenskoy/zvuk-swift) подтверждает ровно тот же browser cursor-путь на уровне реализации: `getPaginatedCollectionTracks(limit:cursor:)` вызывает GraphQL `getPaginatedCollection` с `limit` и `after`, читает `paginatedCollection.tracks.items` и `page.endCursor`, причём возвращает полные track objects. Его transport отправляет JSON `POST https://zvuk.com/api/v1/graphql`, а пользовательский токен кладёт в `X-Auth-Token`; анонимный токен получается через `/api/tiny/profile`. README требует аккаунт с платной подпиской для полного доступа — это пока только заявление автора, без независимой проверки тарифа. Код не запускали. При включённом network logger callback клиент передаёт в лог сырые request/response body; токен находится в header, но response body может содержать личные карточки коллекции, поэтому нельзя сохранять такие логи целиком.

## Подтверждённые в стороннем коде запросы

База API: `https://zvuk.com/api`.

| Запрос / операция | Что видно в просмотренном коде |
|---|---|
| `GET /v2/tiny/profile` или `/tiny/profile` | Профиль/проверка токена; пути слегка различаются в двух клиентах |
| `GET /tiny/tracks?ids=...&include=track` | Метаданные треков в downloader |
| `GET /tiny/releases?ids=...&include=track` | Релиз/альбом, включая track IDs |
| `GET /tiny/playlists?ids=...` | Плейлист и список треков |
| `GET /tiny/track/stream?id=...&quality=...` | Временная ссылка на поток; доступность качества зависит от токена/подписки |
| `GET /tiny/lyrics?track_id=...` | Текст/таймкодированный текст в downloader |
| `POST /v1/graphql` | GraphQL-каталог, поиск, треки, релизы, плейлисты и mediaContents/stream |
| GraphQL `userTracks` | Список ID лайкнутых треков и время изменения элемента в `zvuk-music` |
| GraphQL `getPaginatedCollection` (`limit`, `after`) | Cursor-страницы `paginatedCollection.tracks.items` и `page.endCursor`; подтверждено web-клиентом, live replay и отдельным Swift-клиентом |
| GraphQL `collection.addItem` / `collection.removeItem` | Поставить/снять лайк; тип коллекции передаётся отдельным параметром |

В TypeScript клиенте GraphQL operations включают `quickSearch`, `getTrack`, `getAlbum`, `getPlaylist`, `getStreamURL`. В переданном `ZvukDownloader` и в `Aiving/sberzvuk-api` не найдено чтения liked tracks или мутации like/unlike. Это пробел именно этих клиентов, а не самого API: в более новой `trudenboy/zvuk-music` найдены методы чтения и изменения коллекции. У `ZvukDownloader` дополнительно проверены `get_profile`, `get_tracks`, `get_releases`, `get_playlists`, `get_stream_url`, `get_lyrics` и GraphQL `get_artist_releases`; у них нет пользовательского collection API.

`ZvukDownloader` в первую очередь предназначен для получения медиапотока и локальных FLAC/MP3 файлов. Для переноса библиотеки нам интересны каталог и лайки, а не скачивание аудио. Не использовать downloader как импортёр без отдельной проверки лицензионных условий и модели доступа.

## Живой браузер и терминальная проверка

### Наблюдение в Chrome, 27.10.2026

В авторизованной вкладке открыт маршрут `/favorites`. Для схемы запросов прочитаны только метод, path, status, имя GraphQL operation и имена variable keys. По явному разрешению пользователя cookie-значения кратковременно читались в памяти Chrome-инспектора; они не печатались и не коммитились. Для терминальных read-only replay временные файлы с браузерной cookie-сессией создавались с mode `0600` и удалялись после запросов. Значения треков, ID, cursor и cookies не сохранялись.

| Метод/маршрут | Наблюдение |
|---|---|
| `GET /desktop-data/_next/data/v8.20.1/favorites.json` | JSON-данные страницы «Любимое», статус 200 |
| `POST /api/v1/graphql`, `getPaginatedCollection` | Выборка `data.paginatedCollection.tracks.items` и `tracks.page.endCursor`; в Chrome видны variable keys `limit` и `after`; проверенный `limit` — 30 |
| `POST /api/v1/graphql`, `getCollectionCount` | Счётчик `collectionCount.tracks` |
| `POST /api/v1/graphql`, `getCollectionIds` | Операция без variables, статус 200; `collection.tracks[].id` даёт ID библиотеки для cross-check |
| `POST /api/v1/graphql`, `getPersonalWave` | Данные персональной волны/плеера, включая фрагмент `PlayerTrackData`; это соседний запрос страницы, не источник списка лайков |
| `GET /desktop-data/api/cookieAPI` | Внутренний маршрут сайта, статус 200; назначение и контракт не выяснялись, чтобы не читать/сохранять auth-данные |
| `GET /desktop-data/_next/data/v8.20.1/{track,artist,release}/…json` | Догрузка данных карточек. Числовые идентификаторы аккаунта и каталога в документ не переносились |

В свежем capture после reload и прокрутки страницы пойманы два вызова `getPaginatedCollection`: начальная порция и запрос с непустым `after`; оба ответили `200`. У ответа cursor-запроса форма `data.paginatedCollection.tracks.{items,page.endCursor}`. Событийная очередь CDP была ограничена/усечена, поэтому это проверка цепочки чтения, а не исчерпывающий список всех обращений сайта. В наблюдавшемся GraphQL request был `Cookie` header и не было `Authorization` или `X-Auth-Token` header; не переносить значения cookie в документацию.

Лайк/unlike в браузере не нажимался: проверялись только чтение и сетевые маршруты. Поэтому имена реальных browser-side мутаций и их переменные пока подтверждены только исходниками стороннего клиента, а не live-трафиком.

### Read-only проверка из терминала, 27.10.2026

Без cookies и токенов выполнены два запроса без авторизации: `GET /api/v2/tiny/profile`, `GET /api/tiny/profile`, а также безопасный GraphQL `POST /api/v1/graphql` с `query { __typename }`. Все три получили HTTP `418 text/html` от антибот-защиты; тело ответа не сохранялось. Это показывает, что внешний CLI без сессии не проходит защиту. В браузере тот же GraphQL endpoint отвечал `200` в уже открытой сессии.

Дополнительная проверка 27.10.2026: открытая в Chrome страница `/collection` показала раздел коллекции с избранным без экрана входа, значит браузерная сессия была авторизована. Контроллер Chrome дал evaluate-контекст с `document` и `window`, но без `fetch` и `performance`; безопасный same-origin GraphQL вызов остановился с клиентским `TypeError` до отправки HTTP-запроса. Это ограничение контроллера, а не ответ Звука. Затем тот же безопасный `__typename` POST отправили из чистого терминала без cookies/токенов и получили `418 text/html`. Секреты и данные коллекции не извлекались и не сохранялись; никакие изменения не выполнялись.

**Полная browser pagination и terminal replay, 27.10.2026:** авторизованная страница `/favorites` последовательно запрашивала `getPaginatedCollection(limit=30, after=...)` при прокрутке. Все полученные страницы вернули `200`, последний ответ не содержал следующего cursor; по пути встречались повторные track IDs. Read-only обход тем же GraphQL запросом из терминала также дошёл до страницы без cursor, все page requests вернули `200`, а ошибки GraphQL отсутствовали. Терминальная сессия использовала только cookie `auth`, token из browser response `/api/tiny/profile` и виденные в browser request headers `x-app-instance`/`x-device-id`; token/header значения передавались через временный файл mode `0600`, удалённый сразу после probe. Прямой terminal profile GET без совпадающих browser headers дал `307`, а auth cookie без token/app headers ранее давала `418`.

**Повторная точечная проверка, 27.10.2026:** пользователь подтвердил активный вход; отдельная Chrome-навигация на `/api/v2/tiny/profile` вернула JSON `result.profile` с token-полем (значение не отображалось). Из текущей авторизованной `/favorites` вкладки сняты только безопасные метаданные GraphQL-запросов: `getPaginatedCollection(limit, after)` и `getCollectionIds`; рядом при загрузке видны `getUnreadNotificationsCount` и `getCollectionCount`. Для clean terminal replay временно использовались cookies, session token и заголовки `x-device-id`, `x-app-instance`, `x-app-name` из browser context. Profile GET из terminal всё равно ответил `307`, но GraphQL `getPaginatedCollection` с `limit=1, after=null` вернул `200`, ноль GraphQL errors, один item и следующий cursor. Все временные credential/query файлы mode `0600` удалены; ни track names, ни IDs, ни cursor не сохранялись, только одна запись была прочитана; мутаций не было.

**Сверка профилей v1/v2 в Chrome и чистого CLI, 27.10.2026:** в авторизованном Chrome открыты оба GET `https://zvuk.com/api/tiny/profile` и `/api/v2/tiny/profile`. Оба показали JSON; в первой форме токен лежит в `result.token`, во второй — в `result.profile.token`. В браузерном выводе сохранялись только имена полей и признак наличия token; его значение и личные поля профиля не отображались и не сохранялись. Независимые terminal-запросы без cookies/token к обоим profile routes и безопасному GraphQL `__typename` снова вернули `418 text/html`. Это подтверждает различие между авторизованным browser context и чистым CLI/WAF, а не отсутствие API; авторизованный replay в этой точечной проверке не выполнялся.

Для reconciliation terminal запрос `getCollectionIds` вернул тот же набор ID, что и union cursor-страниц; `getCollectionCount.tracks` не совпал с количеством уникальных cursor IDs. Точные объёмы и сами ID не сохранялись. Практический вывод: дедуплицировать export по track ID, сравнивать с `getCollectionIds`, а `getCollectionCount` не использовать как checksum. Это подтверждает читаемость всей коллекции в проверенной сессии, но не гарантирует одинаковую полноту на иных аккаунтах/регионах или при изменении частного API.

Ранее отдельные terminal probes также подтвердили `userTracks` и `getTracks(ids: [...])` с `200`. Отличие от полной cursor-проверки выше — в этой перепроверке GraphQL page walk сработал с `auth` cookie и browser profile token/app headers без полного cookie jar. Все credential values удалены после запросов и не сохранялись.

### Следующая безопасная проверка

1. Проверить доступность чтения лайков без платного тарифа на аккаунте, где такой план не активен; текущая сессия не доказывает subscription gate.
2. Мутации `collection.addItem` / `collection.removeItem` пока не вызывать. Для их live-проверки понадобится отдельное решение на тестовом лайке, потому что это изменяет медиатеку.
3. В приложении оформлять получение профиля/токена как локальную работу browser extension или явный user session bridge с минимальными cookies/headers; секреты держать в памяти или системном keychain, не логировать и не сохранять в репозитории.

Не сохранять HAR, заголовки авторизации, cookies, значения token, GraphQL variables с пользовательскими данными и сырые ответы личной коллекции в репозиторий.

Независимый source cross-check: MIT [`lubaskinc0de/beatstash`](https://github.com/lubaskinc0de/beatstash/tree/2ac4573273fd4b2037a04dcda9c216ea230f1d4d) читает `userCollection` через GraphQL v1 и отдельно гидрирует `getTracks(ids)` пачками по 100; его likes query также не содержит cursor/limit. Приложение проверяет подписку через v2 profile перед своим audio import, но этот прикладной gate сам по себе не доказывает ограничение чтения likes API. Полный разбор auth, лицензии и отличия от мигратора добавлен в [инвентарь API](zvuk-api-inventory.md#независимая-сверка-импорта-коллекции-lubaskinc0debeatstash).

### Инвентарь GraphQL операций `trudenboy/zvuk-music`

По checkout `ed491f6` библиотека хранит отдельные GraphQL документы. Запросы: `episodes`, `followingCount`, `getAllHiddenCollection`, `getArtists`, `getEpisodes`, `getFullTrack`, `getHiddenTracks`, `getPlaylistTracks`, `getPlaylists`, `getPodcasts`, `getReleases`, `getShortPlaylist`, `getStream`, `getTracks`, `listenedEpisodes`, `listeningHistory`, `notificationsHasUnread`, `profileFollowersCount`, `quickSearch`, `search`, `synthesisPlaylist`, `userCollection`, `userPaginatedPodcasts`, `userPlaylists`, `userTracks`. Мутации: `addItemToCollection`, `addItemToHidden`, `addTracksToPlaylist`, `createPlaylist`, `deletePlaylist`, `removeItemFromCollection`, `removeItemFromHidden`, `renamePlaylist`, `setPlaylistToPublic`, `synthesisPlaylistBuild`, `updataPlaylist` (имя operation в библиотеке с этой орфографией).

Для главного сценария `userTracks` выбирает `collection.tracks` с `id` и `collectionItemData.lastModified`; query не объявляет аргументы пагинации, клиент передаёт только сортировку `orderBy`/`orderDirection`, затем вызывает `get_tracks` для метаданных. Соседний `userCollection` перечисляет типы коллекций: artists, episodes, podcasts, playlists, synthesisPlaylists, profiles, releases и tracks. Эти документы описывают API-контракт сторонней реализации, а не гарантированный официальный контракт Звука.

### Перекрёстная сверка в `oklookat/synchro`

В Go-проекте [oklookat/synchro](https://github.com/oklookat/synchro), HEAD `ac441f4` (2024-07-07, GPL-3.0), есть независимый Zvuk-адаптер через библиотеку [oklookat/gozvuk](https://github.com/oklookat/gozvuk), последний просмотренный commit `fc4ed93` (2023-08-08). Он подтверждает private GraphQL-путь: `POST https://zvuk.com/api/v1/graphql`, `userTracks` для списка ID/дат лайков и `getFullTrack` для метаданных; данные для карточек в адаптере разбиваются на пачки по 10. В отличие от нового cursor `getPaginatedCollection`, `gozvuk.UserTracks` не принимает cursor/page size и выгружает набор одним GraphQL запросом, поэтому его нельзя считать проверкой полной пагинации больших аккаунтов.

Запись/снятие лайка в этой реализации — GraphQL `addItemToCollection`/`removeItemFromCollection` по одному ID с типом `TRACK`. Авторизация: токен из `https://zvuk.com/api/tiny/profile`, затем `X-Auth-Token`; refresh token библиотека не хранит. Клиент проверяет его через `Profile()` и ограничивает запросы до 10 в секунду. Это подтверждает имена операций из другого клиента, но старый код и его хранение секретов в открытом SQLite использовать как готовую интеграцию нельзя.

## Наш локальный source connector

В feature-ветке MVP реализован read-only Chrome-коннектор для активной вкладки пользователя. Кнопка одного запуска автоматически открывает `/favorites`, затем `/collection`, затем страницы всех найденных плейлистов; обычная страница Звука сама выполняет свои GraphQL-запросы, а расширение наблюдает только их нормализованные музыкальные ответы. Для likes, каталога и каждого плейлиста сверяются независимые totals/позиции; при таймауте или несовпадении статус остаётся `needs_review`. Экспорт JSON сохраняет отдельные коллекции, пустые плейлисты, повторяющиеся элементы и порядок; importer превращает их в per-collection snapshot.

Пароли, cookies, tokens и auth headers не читаются. Запросы выполняются только страницей самого Звука, записи в аккаунт не вызываются. Архитектурный/mock сценарий автоматики прошёл, но это не live validation: расширение ещё не установлено и не проверено на пользовательской сессии; экспорт пока вручную переносится файлом в MVP. Исходный API остаётся частным и изменяемым. См. [ZVUK_CONNECTOR.md](../../docs/ZVUK_CONNECTOR.md) и [PR #2](https://github.com/Basil-AS/music_importer/pull/2).

## Риски и вывод

- Неформальный cookie-flow может сломаться, отозваться или раскрыть аккаунт при утечке.
- Публичный контракт/гарантии стабильности не обнаружены.
- Официальная функция миграции работает **в сторону Звука**, а не экспортирует коллекцию из него. Справка перечисляет Apple Music, Яндекс Музыку, ВКонтакте, Spotify, Deezer и YouTube Music как поддерживаемые источники автоматического переноса в Звук. Для прочих источников сайт принимает список треков.
- По официальной справке импорт создаёт отдельный плейлист; в «Любимое» треки не попадают. Добавляются только записи, которые есть в каталоге Звука. Справка отдельно говорит, что экспорт коллекции из Звука пока недоступен.
- В Chrome открыт список «Любимое»; подтверждён живой GraphQL read-path и связанные запросы данных страницы. Затем по прямому разрешению пользователя авторизационные cookies временно использованы для clean terminal read-only запросов; значение секрета и записи коллекции не выводились, временный файл удалён, ничего личного в репозиторий не перенесено.
- Лайк-коннектор для Звука найден в исходниках, live-запрос списка и read-only CLI чтение подтверждены. Пагинация работает, но счётчик и элементы расходятся, встречаются повторные ID; доступность чтения лайков без платного тарифа ещё не проверена.
- Следующий безопасный шаг — экспорт списка лайков без скачивания аудио, сохранив ID/даты и обезличенный отчёт. Токен должен задаваться локально секретным способом и не попадать в git/логи.

## Рекомендуемый кандидат

Из найденных библиотек `trudenboy/zvuk-music` лучше всего подходит как исходный адаптер: он явно покрывает чтение и запись лайков, имеет тесты и упакован в PyPI. Не запускать массовые изменения коллекции и не использовать функции скачивания для задачи миграции. Сначала исследовать `get_liked_tracks()` на чтение, затем отдельно получить метаданные песен по ID.

Для полноты крупной коллекции отдельно стоит сравнить Python `userTracks` с cursor implementation `korenskoy/zvuk-swift`/web `getPaginatedCollection`; Swift-клиент пока только статически просмотрен, его наличие не заменяет уже проведённую live read-only проверку.

## Изоляция курсоров разделов коллекции (31.10.2026)

Ответ `getPaginatedCollectionAll` может включать и плейлисты, и сохранённые релизы; у секций есть собственные `page.endCursor`. Reader теперь продолжает их отдельными запросами, задавая `withPlaylists`/`withReleases` так, чтобы следующая страница одной секции не могла заменить курсор другой. Если в release-only ответе нет отдельного `releases.page`, корневой `page` относится к релизам; он не считается курсором плейлистов. Проверено fixtures для расходящихся курсоров и release-only пагинации. В открытом Chrome новый код ещё не проверялся; текущий видимый сбой Звука остаётся без установленной live-причины.

В Chrome DevTools MCP в read-only GraphQL ответе `getPaginatedCollectionAll` с HTTP 200 был найден только безопасный код `DOWNSTREAM_SERVICE_ERROR`. Временный allowlist таких downstream/server кодов теперь повторяет страницу ограниченное число раз с backoff и показывает код без сырого `message`, курсора, переменных и заголовков. Фикстуры проверяют повтор временного кода и fail-closed для неизвестного/permanent кода. После обновления расширения live-повтор не проводился.

Официальный импорт Звука может быть полезен для обратного сценария или как reference UX, но не решает Звук → Apple Music: у него нет экспорта, а импортированный плейлист не равен «Любимому».

## Источники

- [Справка Звука: перенос музыки в Звук](https://help.zvuk.com/article/42207)
- [Справка Звука: коллекция и лайкнутые треки](https://help.zvuk.com/article/48259)
- [Справка Звука: плейлисты и «Любимое»](https://help.zvuk.com/article/48272)
- [Synchro Zvuk adapter at `ac441f4`](https://github.com/oklookat/synchro/blob/ac441f45f1cd6a143b361a10a48611f33e96f426/remote/zvuk/accountActions.go)
- [gozvuk GraphQL client at `fc4ed93`](https://github.com/oklookat/gozvuk/tree/fc4ed9399d70f599e0d85a133aa663d0a8cbe3fb)
- [Zvuk Swift library README at `8245d4e`](https://github.com/korenskoy/zvuk-swift/blob/8245d4e39abe93739cc0c01249a6e8a460fe5cb3/README.md)
- [Zvuk Swift cursor collection implementation at `8245d4e`](https://github.com/korenskoy/zvuk-swift/blob/8245d4e39abe93739cc0c01249a6e8a460fe5cb3/Sources/ZvukMusic/API/Client%2BCollection.swift)
- [Zvuk Swift GraphQL transport and optional body logger at `8245d4e`](https://github.com/korenskoy/zvuk-swift/blob/8245d4e39abe93739cc0c01249a6e8a460fe5cb3/Sources/ZvukMusic/Networking/Request.swift)
