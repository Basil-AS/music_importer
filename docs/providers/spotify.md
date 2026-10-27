# Spotify Web API

Статус: официальная документация просмотрена 27.10.2026. Учитывать миграцию API февраля 2026: часть старых `/me/tracks` операций заменяется универсальными `/me/library`.

## OAuth

Для данных пользователя нужен OAuth. Для локального desktop/browser инструмента подходит Authorization Code with PKCE, поскольку секрет приложения нельзя надёжно хранить в клиенте. Поток: создать verifier/challenge S256 и state; открыть `https://accounts.spotify.com/authorize`; проверить state в callback; обменять code через `https://accounts.spotify.com/api/token`; хранить access/refresh token только локально и защищённо. В dev mode Redirect URI должен соответствовать текущим требованиям Spotify (для локальной разработки — loopback IP `127.0.0.1`, не `localhost`). Client Credentials работает только для публичных данных, не для пользовательских лайков.

Минимальные scopes для чтения лайкнутых песен: `user-library-read`; для записи в библиотеку Spotify — `user-library-modify`. `playlist-read-private`/`playlist-read-collaborative` нужны только при импорте приватных плейлистов.

## Лайки и запись библиотеки

- Читать: `GET https://api.spotify.com/v1/me/tracks`, scope `user-library-read`, пагинация через `limit` и `offset`/`next`. Формат элементов содержит `added_at` и объект track. Время добавления полезно сохранить.
- Сохранять: актуальная универсальная запись — `PUT https://api.spotify.com/v1/me/library?uris=spotify:track:<id>,...`, scope `user-library-modify`, максимум 40 URI в запросе. Старый `PUT /me/tracks` помечен deprecated в актуальной документации.
- Metadata search: Web API search/catalog routes; при совпадении ISRC можно искать точнее, если он есть в исходных данных.
- API может вернуть 401/403/429; 429 требует учитывать `Retry-After`. Результат пакетной записи следует перепроверять.

## Важные текущие ограничения

В официальном migration guide для Development Mode указаны Premium у владельца приложения и до пяти пользователей на приложение для новых/не-grandfathered apps. Это означает, что персональный перенос потенциально реалистичен при соблюдении требований, но публичный бесплатный сервис на одном dev client ID — не рабочее предположение. Прежде чем строить продуктовую авторизацию, проверить условия Spotify для конкретного типа приложения/аккаунта.

## Источники

- [Authorization](https://developer.spotify.com/documentation/web-api/concepts/authorization)
- [PKCE flow](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow)
- [Scopes](https://developer.spotify.com/documentation/web-api/concepts/scopes)
- [Get a User's Saved Tracks](https://developer.spotify.com/documentation/web-api/reference/get-users-saved-tracks)
- [Save Items to Library](https://developer.spotify.com/documentation/web-api/reference/save-library-items)
- [February 2026 migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)

Проверено по документации; живой OAuth/пагинацию в собственном аккаунте ещё не запускали.
