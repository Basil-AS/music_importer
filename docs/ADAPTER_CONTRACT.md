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

Перед write adapter читает уже существующую целевую коллекцию, поддерживает безопасное продолжение после checkpoint и принимает bounded batches по собственным ограничениям сервиса. `readBack()` возвращает фактически сохранённые provider IDs и playlist positions, чтобы итоговый отчёт различал запрошенные, записанные и подтверждённые позиции. Writes запускаются только после явного пользовательского подтверждения сводки и target account.

## Текущий статус реализации

`demo/transfer-engine.js` реализует общий bounded search и paged source reader. Apple catalog adapter подключён к поиску. Ни один account adapter полного цикла (connect → discover → page read → target write → read-back) пока не подключён; формируемый UI план остаётся `preview-only`. Звук Chrome connector — экспериментальный источник JSON и пока не реализует этот adapter contract.
