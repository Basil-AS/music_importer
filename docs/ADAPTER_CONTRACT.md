# Контракт музыкального адаптера

Каждый сервис реализует один adapter с локальным пользовательским входом, обнаружением всех коллекций, чтением страниц, поиском каталога назначения, записями likes/playlists и обратной сверкой. Общий transfer engine работает только с нормализованными объектами; пароли, cookies и bearer-токены остаются внутри provider adapter и не попадают в план или логи.

## Интерфейс

```js
{
  id: 'spotify' | 'apple-music' | 'yandex-music' | 'zvuk',
  connect(),
  disconnect(),
  discoverCollectionPage({ cursor, limit, signal }),
  readCollectionPage({ collection, cursor, limit, signal }),
  searchTracks(track, context),
  readDestination(collection),
  writeFavorites(items, options),
  createPlaylist(metadata, options),
  writePlaylistItems(playlistId, items, options),
  readBack(operation, options),
}
```

Capabilities могут отличаться по направлению и типу коллекции; adapter должен сообщать доступные операции и точную причину отсутствующей capability до запуска переноса. Вход открывает официальный сайт/экран авторизации провайдера. Универсальный код не принимает пароль или 2FA и не читает Chrome cookie database, storage или секретные заголовки.

## Модель коллекций и страниц

`discoverCollectionPage()` возвращает страницу всего доступного пользовательского списка, а не глобального музыкального каталога:

```js
{ collections: [{ id, type: 'favorites' | 'playlists', name, itemCount, writable }], nextCursor, hasMore, totalCount }
```

Engine `readLibrary()` последовательно проходит все страницы обнаружения, затем полностью читает каждую найденную коллекцию и собирает единый snapshot. Таким образом аккаунт может содержать и отдельный Favorites, и любое число playlists. Полнота каждого уровня (список коллекций и items внутри коллекции) сверяется независимо.

`readCollectionPage()` возвращает:

```js
{ items: TrackRef[], nextCursor: string | null, hasMore?: boolean, totalCount?: number, offset?: number }
```

`TrackRef` содержит `providerId`, `title`, `artists`, `album`, `isrc`, `durationMs` и optional provider metadata. Playlist items дополнительно содержат стабильный `position`; одинаковый `providerId` на разных позициях сохраняется. Favorites дедуплицируются по provider ID. Adapter переводит offset/URL/cursor конкретного API в opaque cursor для engine и не скрывает ошибку API как пустой последней страницы.

Engine проходит все страницы без собственного лимита, защищается от зацикленного cursor и вызывает checkpoint callback после каждой страницы. Snapshot помечается полным только при исчерпанной пагинации, согласованном независимом total и непрерывном playlist order. Отсутствующий или противоречивый total остаётся незакрытой полнотой.

## Поиск, запись и сверка

`searchTracks()` принимает один нормализованный source track и возвращает каталожные кандидаты с provider ID, ISRC если доступен, версиями, credits, длительностью, альбомом и storefront/region. Engine группирует одинаковые запросы, ограничивает параллельность настройкой adapter и применяет общий matcher; неоднозначный результат идёт в review queue.

Перед write adapter читает уже существующую целевую коллекцию и принимает bounded batches по собственным ограничениям сервиса. Для избранного повторный запуск обычно пропускает уже сохранённые provider IDs. `readBack()` возвращает фактически сохранённые provider IDs и playlist positions, чтобы итоговый отчёт различал запрошенные, записанные и подтверждённые позиции. Writes запускаются только после явного пользовательского подтверждения сводки и target account. **Безопасный resume playlist-записи после закрытия страницы пока не реализован:** provider writers могут создать новый плейлист при повторном запуске, а локальный job ledger не хранит исходный plan и соответствие source playlist → target playlist ID. Idempotency key передаётся generic engine, но текущие page-session writers не доказывают серверную идемпотентность и не используют его как гарантированный resume key.

Общий `executeTransferPlan(adapter, plan, { confirmed: true, onCheckpoint })` задаёт контракт последовательной записи для цели `favorites`, `playlists` или `library`. В режиме `library` один план содержит и `add_to_favorites`, и `add_to_playlist`; перед каждым типом записи отдельно подтверждается полнота соответствующей целевой коллекции. Перед любым изменением он требует подтверждённый snapshot источника и явное подтверждение запуска. Для избранного уже существующие provider IDs пропускаются. Для плейлистов сохраняются отдельные source mappings, пустые коллекции и исходные позиции; generic engine передаёт idempotency keys создания плейлиста и batch. После записи engine вызывает `readBack()` и возвращает `complete` только при полном read-back, подтверждении каждой запланированной позиции и наличии каждого целевого плейлиста. При ошибке сетевого шага исключение несёт `transferReport` с phase, количеством записей и статусом `failed`/`partial_failure`. **Этот generic engine пока используется для fixtures, а не как гарантированный recovery layer для четырёх реальных page-session writers.** Продуктовый UI сохраняет только краткий журнал прогресса; после сбоя он блокирует новый write до ручной сверки целевого аккаунта.

## Текущий статус реализации

`demo/transfer-engine.js` реализует общий bounded search, paged source reader и provider-neutral исполнитель плана с проверками полноты, дедупликацией избранного, batching, checkpoints и read-back. UI поддерживает experimental Apple, Yandex, Zvuk и Spotify search/write flows из активных вкладок; target mutations имеют fixture coverage, но live-проверки ещё нет. Все четыре сервиса дают source snapshots (часть read connectors остаётся experimental). Ни один из 12 directed transfer paths не прошёл live end-to-end проверку.

Локальное приложение и расширение обмениваются snapshots и явными provider commands через content scripts на `127.0.0.1`/`localhost` (порт 8000 или 8001, корневой URL) или проектном GitHub Pages origin (`basil-as.github.io/music_importer/`). Для Звука relay передаёт только подтверждённые snapshots; target commands выполняются в открытой вкладке страницы. Spotify и Apple page scripts временно наблюдают сессионные API-заголовки из запросов самого Web Player и держат их только в памяти этой вкладки для вызова API; заголовки не сериализуются в расширение, приложение или storage. Yandex и Zvuk используют browser-managed session credentials и не читают значения cookie/token. Ни один connector не читает Chrome cookie database или пароли. Перед любой записью UI требует подтверждение и полный source snapshot.
