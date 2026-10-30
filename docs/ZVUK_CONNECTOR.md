# Локальный коннектор Звука: чтение и экспериментальная запись

Расширение читает метаданные из ответов GraphQL, которые сама страница Звука получает в активной пользовательской сессии. Поддерживаются «Любимое», каталог плейлистов и их треки. Сырые ответы, пароли, cookies, токены, GraphQL-заголовки и cursor не сохраняются; запросы к серверу проекта отсутствуют.

## Встроенный импорт Звука — отдельный fallback

На открытой авторизованной странице `zvuk.com/favorites` 2026-10-28 была видна штатная кнопка «Перенести» с пунктами Яндекс, VK, KION, Spotify, Apple Music, YouTube Music и «Перенести вручную» (пункты проверены по видимому UI; это не описание API). Официальная [справка Звука](https://help.zvuk.com/article/42207) описывает автоматический импорт из Apple Music, Яндекс Музыки, VK, Spotify, Deezer и YouTube Music; ограничения собраны в [отдельной статье поддержки](https://help.zvuk.com/article/70615).

Повторная read-only проверка 2026-10-28 во внешнем Chrome: вкладка Звука с `/migrations` показывала пользовательский аватар и штатные варианты импорта. После открытия `/favorites` страница отрисовала содержимое «Любимого» и карточки треков, что подтверждает доступность списка через обычную пользовательскую сессию и правильный URL для коннектора. Счётчики и содержимое библиотеки в документацию не копировались. Bridge MVP на localhost не ответил, поэтому расширение не передавало снимок приложениям; GraphQL request/response и заголовки не инспектировались, пагинация, полнота снимка и перенос не проверялись.

Этот механизм не удовлетворяет основному сценарию importer-а: он работает только в направлении **в Звук**, требует ссылку/доступ к исходному сервису, создаёт отдельный плейлист и добавляет только записи из каталога Звука. Официальная справка указывает, что перенести tracks непосредственно в «Любимое» таким способом нельзя, а экспорт из Звука пока не поддерживается. Для Apple требуется активная подписка; для части источников плейлист должен быть публичным. Поэтому встроенную миграцию можно рекомендовать как отдельный ручной fallback для playlist → Zvuk, но нельзя считать её коннектором Звука или использовать в автоматическом all-directions flow.

## Общий запуск переноса

1. Установите unpacked extension один раз через `chrome://extensions` → Developer mode → **Load unpacked**, выбрав каталог `chrome-extension/`.
2. Войдите в Звук обычным способом. При необходимости откройте и авторизуйте вкладки Spotify, Яндекс Музыки и Apple Music.
3. Нажмите кнопку **Music Importer** в панели Chrome. Приложение внутри расширения автоматически запустит сбор всех доступных библиотек.
4. Если во вкладках не открыта страница коллекции, расширение использует последнюю открытую вкладку `zvuk.com`, в том числе `/migrations`, и само перейдёт на `/favorites`. Затем последовательно загрузит `/favorites`, `/collection` и страницы найденных плейлистов. Оставьте вкладку открытой до завершения.
5. Когда снимки библиотек подтверждены, выберите Звук источником или целью. Для диагностики отдельно можно открыть popup расширения и скачать `zvuk-library.json`, `zvuk-favorites.json` или `zvuk-playlists.json`.

## Что подтверждается

- Избранное дедуплицируется по Zvuk track ID. Сбор помечается подтверждённым только при завершённой cursor-пагинации и совпадении количества с независимым `getCollectionIds`.
- После первой страницы connector пробует продолжить избранное тем же GraphQL-запросом с наблюдаемым `endCursor`, подтверждая сохранение каждой страницы через extension bridge. Заголовки исходного `fetch(Request)` или XHR сохраняются только в памяти page-script closure и используются только для cursor replay; в extension bridge они не попадают. Запрос ограничен 45 секундами до полного чтения JSON тела ответа. Если replay запроса не сработал, остаётся fallback на прокрутку интерфейса; при остановке карточка сервиса показывает сохранённую безопасную причину (например, HTTP status или таймаут). Отдельная сверка ждёт независимый `getCollectionIds`, даже если cursor закончился раньше.
- Каталог плейлистов подтверждается при совпадении числа уникальных элементов с независимым счётчиком и отсутствии следующей страницы.
- Плейлист подтверждается, если получено известное число элементов и позиции непрерывны от нуля. Неполные списки остаются явно помеченными и не считаются готовыми.
- В playlist JSON сохраняются исходные ID, порядок и повторяющиеся элементы. Для полного source snapshot приложение может искать треки в каталоге Звука, добавлять favorites и создавать плейлисты; запись требует отдельного подтверждения. Схема writer и его ограничения описаны в [ZVUK_TRANSFER.md](ZVUK_TRANSFER.md).
- Один запуск объединяет сбор избранного и playlist catalog. Перед переходом к следующему шагу проверяются независимые totals; при остановке, ошибке или расхождении scan получает статус `needs_review` и не объявляется полным.
- Fallback выбора `zvuk.com` вкладки и переход с `/migrations` на `/favorites` проверен worker fixture; живое автоматическое переключение пока не подтверждено с установленным расширением.

## Дополнительный REST API inventory из ZvukDownloader

Upstream [`API_DOCUMENTATION.md`](https://github.com/Basil-AS/ZvukDownloader/blob/master/API_DOCUMENTATION.md) описывает ещё несколько маршрутов под `https://zvuk.com/api`:

| Метод и путь | Назначение по upstream заметкам | Значение для importer-а |
|---|---|---|
| `GET /v2/tiny/profile` | профиль, подписка, регион и account feature flags | profile/status check; не возвращает библиотеку |
| `GET /tiny/tracks?ids=…&include=track` | метаданные треков по известным ID | дополнить metadata после того, как collection scan нашёл ID |
| `GET /tiny/releases?ids=…&include=track` | релизы и связанные `track_ids` | batch enrichment, не поиск пользовательских likes |
| `GET /tiny/playlists?ids=…` | базовые данные плейлистов по известным ID | enrichment известных playlist ID; не даёт каталог коллекции пользователя |
| `POST /v1/graphql` | в CLI примерах — artist/release lookup с `limit`/`offset` | ещё один пример GraphQL v1; формы favorites/playlist membership нужно брать из page connector и сверять отдельно |

Это статическая документация стороннего downloader-проекта, не официальный API contract и не live-проверка актуального сервера. Она не показывает, как получить полный список пользовательских likes и playlists через REST v2, и не описывает перенос между сервисами. Методы `/tiny/track/stream` и `/tiny/lyrics` относятся к загрузке/аудио и в importer не нужны. В документации downloader-а указан cookie-based `auth` token; наш connector его не извлекает и не сохраняет. У репозитория не обнаружен опубликованный LICENSE, поэтому код оттуда не копируем.

## Ограничения и безопасность

- Сбор основан на частных и изменяемых GraphQL-операциях Звука: `getPaginatedCollection`, `getPaginatedCollectionAll` / `getPaginatedCollectionAllSections`, `getPlaylistTracks`, `getPlaylists`, `getCollectionIds`. Формы ответов могут измениться. Фоновая обработка браузера, новая версия API или медленная загрузка могут оставить отдельный плейлист неполным; JSON обязан сохранить это состояние.
- Расширение использует host permissions для сервисных вкладок и запрашивает отдельно optional host permission к `127.0.0.1` либо `localhost` из popup при подключении локального приложения. Локальный bridge ограничен корневой страницей и портами 8000/8001. Расширение не запрашивает `cookies` или `webRequest`, не читает учётные данные и не внедряет новые запросы в аккаунт.
- Нормализованные музыкальные метаданные хранятся в `chrome.storage.local` до ручной очистки или удаления расширения. Chrome не шифрует это хранилище. Extension-hosted Music Importer читает снимок через service worker; отдельный HTTP server и синхронизация не используются. У запасной страницы на localhost есть отдельное optional permission.
- Demo/CSV preview использует публичный iTunes Search API для поиска Apple. Если целью выбран Звук, поиск и запись идут из открытой страницы Звука.
- Zvuk target writer добавлен в extension версии `0.5.0`. Его private mutations fixture-tested, но live mutation и целевой read-back ещё не проверены; текущие операции могут поменяться вместе с web-клиентом.
- Автоматизация использует только активную вкладку и её текущую пользовательскую сессию: сначала повторяет наблюдаемый GraphQL cursor-запрос, затем при необходимости fallback-ит на прокрутку страницы. Каждый продолженный запрос ограничен 45 секундами, а скан без прогресса завершается через две минуты. Это частный и изменяемый API; секреты сессии не читаются и не сохраняются.
- Cursor reader и ожидание независимого счётчика проверены fixture-тестами. В последнем live read-only refresh extension→app handoff работал, но reader завершился без полного snapshot из-за ошибки каталога плейлистов.
- Catalog reader prefers `hasNextPage` when present and falls back to `endCursor`; successful responses are no longer retained as an error diagnostic. A stalled next-page request is reported separately from malformed data. Fixtures cover cursor/boolean disagreement and the pagination-stall status; the live response shape still needs revalidation.
- Перед массовым использованием нужны повторный live sweep и независимая сверка чисел/статусов на аккаунте.

## Последняя live-проверка

2026-10-28: текущий extension refresh отправил Звук в crawl избранного и плейлистов, но итоговый статус сообщил, что каталог плейлистов не загрузился. В видимой странице присутствовали разделы избранного и плейлистов, однако этого недостаточно, чтобы подтвердить API-сессию или полный каталог. Частичный progress не сохранён как полный snapshot. GraphQL bodies, заголовки и session values не читались; причина отказа неизвестна. Текущая реализация остаётся не подтверждённой live как reader.

## Saved albums (releases), fixture-only

Status: implemented against fixtures in `tests/zvuk-albums.test.js`; not live-verified.

- Reader: `main-world.js` forwards the `releases` section of `getPaginatedCollectionAll` / `getPaginatedCollectionAllSections` as `release-list-page` (`releases[{id,title,artists[{id,title}],trackCount,releaseDate,artworkUrl}]`, `hasMore`), `getReleases` hydration as `release-metadata`, and the independent ID count from `getCollectionIds` as `uniqueReleaseCount` inside `collection-count`. A page with `hasMore` but no cursor is dropped and reported as `read-error`. The consumer must treat the album list as complete only when the unique hydrated release IDs equal `uniqueReleaseCount`; a mismatch fails closed, like tracks and playlists.
- Search: `search-albums` command runs `search { releases(limit) { items { id title date artists tracks } } }`. Candidates carry `providerId`, `title`, `artists[]`, `trackCount` (from `tracks.length`), `releaseDate`; Zvuk exposes no UPC (`upc` is empty).
- Unverified: the `releases` search field names (`date`, `tracks`) and the `getReleases` response key are inferred from community clients and the observed `getCollectionIds` shape.

## Album write

Albums are written with `execute-transfer` (see `ZVUK_TRANSFER.md`). The item type sent is the single constant `RELEASE_ITEM_TYPE = 'release'` in `zvuk-target-main-world.js`, chosen by analogy with the observed lowercase `'track'`; the enum value is not confirmed live. If the first live write is rejected, change only that constant (community clients use an upper-case `CollectionItemType`).

## CSP warning from Zvuk analytics

A user report from `https://zvuk.com/collection` showed the page blocking `https://cnt.rambler.ru/cnt/v2/` under its own `connect-src` policy. The policy text shown in the report contains the source `cnt.rambler.ru/cnt/v2` without a trailing slash, while the blocked request path ends in `/`; this is consistent with a page-side CSP path mismatch.

The earlier stack pointed to `chrome-extension/main-world.js`'s `patchedSend` because the connector used to wrap every page XHR while inspecting Zvuk GraphQL responses. The observer now attaches only to `/api/v1/graphql`; all other XHRs use the original `send` and `setRequestHeader` methods directly. The Rambler request is therefore a Zvuk analytics request, not an importer API call. Adding a Rambler host permission to the extension would not override the page's CSP and is not an appropriate fix.

This warning can still appear because the site's own CSP blocks its analytics request; changing the extension cannot repair the site's policy. After updating the extension and reloading the Zvuk tab, the analytics XHR should no longer pass through the importer's observer or show `patchedSend` in its call stack. The warning alone does not indicate that library scanning failed. Diagnose a scan failure from the importer status or a separate `read-error` for a Zvuk GraphQL operation. Assessment is based on the pasted browser report, a regression fixture, and static source inspection; no live retry was performed.
