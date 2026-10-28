# Яндекс Музыка: local-session reader

## Назначение и статус

Добавлен экспериментальный read-only connector для уже открытой авторизованной вкладки `music.yandex.ru`. Он читает понравившиеся треки и пользовательские плейлисты для передачи в общий importer. Используются private/community API маршруты из исследования; это не официальный third-party API и не стабильная production интеграция. Browser main-world direct fetch response shapes подтверждены для read routes, а полная работа самого extension bridge всё ещё требует live-проверки.

## Запросы

Из main-world контекста вкладки выполняются запросы с обычными browser credentials:

1. `GET https://api.music.yandex.ru/account/status` — получить UID текущего аккаунта в памяти страницы.
2. `GET /users/{uid}/likes/tracks?if-modified-since-revision=0` — прочитать полный массив short track refs и revision.
3. `POST /tracks` — гидрировать карточки ID form-urlencoded полем `track-ids`, партиями по 25, без лимита на весь список. Batch size 25 выбран по ранее подтверждённым terminal responses; больший размер не используем.
4. `GET /users/{uid}/playlists/list` — получить каталог пользовательских плейлистов.
5. `GET /users/{uid}/playlists/list/kinds` — независимо прочитать kinds и сверить их полный набор с playlist catalog response.
6. `GET /users/{ownerUid}/playlists/{kind}` — читать треки каждого плейлиста; для short refs повторно вызывается `/tracks`.

Cookie значения и access tokens не читаются JavaScript-кодом, не складываются в extension storage и не отправляются в приложение. Браузер сам прикладывает cookie к запросу домена Яндекса. Локальное приложение получает только метаданные после завершения скана.

## Полнота и обработка ошибок

- Likes принимаются только если ответ содержит revision и все short refs имеют уникальные IDs. `/tracks` запрашивается партиями по 25; если ответ не содержит одну из карточек, известный ID сохраняется в правильной позиции как запись с пустыми метаданными, а snapshot отмечает `metadataComplete: false` и увеличивает `metadataIncompleteCount`. Это сохраняет точный состав избранного, не выдавая отсутствие карточки за найденные название и исполнителя.
- Для каждого playlist `tracks.length` сравнивается с provider `trackCount`; позиции назначаются по исходному порядку API, повторы сохраняются, пустые playlist остаются в snapshot.
- Гидратация идёт партиями по 25 с короткой паузой. Временные сетевые ошибки и HTTP 408, 429, 5xx повторяются максимум три раза; при 429 учитывается `Retry-After`, а длинное ожидание сообщает прогресс. Повреждённый JSON, постоянные API errors, отсутствие аккаунта, unknown shape, отсутствие revision/ID или mismatch каталога останавливают скан и не передают неподтверждённый состав в matcher.
- Каталог пользовательских плейлистов приходит одним массивом без cursor-пагинации; полный набор сверяется со вторым endpoint `list/kinds`. Несовпадение kinds или их дубликаты останавливают скан.

## Ограничения и дальнейшая проверка

- Из открытой авторизованной вкладки напрямую проверены HTTP 200 и response shapes для `/account/status`, liked tracks, playlist list, playlist kinds, playlist detail, catalog search и `POST /tracks` hydration. Это подтверждает CORS для этих запросов, но не весь extension bridge, массовую гидратацию пользовательского каталога или все edge cases.
- Likes endpoint не описывает pagination. Пока source service возвращает весь список одним response, код сверяет все уникальные refs и сохраняет revision; отсутствующие карточки представлены только известным ID с явным incomplete-metadata флагом. Этот контракт остаётся private.
- Этот документ описывает только reader: он выполняет GET и metadata POST. Yandex target writer реализован отдельно; см. [`YANDEX_TRANSFER.md`](YANDEX_TRANSFER.md). Live mutation всё ещё не проверялась.
- Для общего сценария откройте Яндекс Музыку и нужные остальные сервисы в Chrome, войдите обычным способом и нажмите кнопку Music Importer в панели Chrome. Extension-hosted app запускает чтение всех открытых библиотек; Яндекс выбирается уже после сканирования как источник или цель. Если аккаунт не появился, перезагрузите unpacked extension и вкладку Яндекс Музыки. Live full-library scan и transfer пока требуют проверки.

Исследовательские детали и ранее подтверждённые request shapes: [`providers/yandex-music.md` в API research](https://github.com/Basil-AS/music_importer/blob/feature/music-service-api-research/docs/providers/yandex-music.md).

## Browser and terminal read-only shape check (2026-10-28)

Из уже авторизованной страницы Chrome выполнены browser-credentialed fetches через `window.fetch`: `/account/status`, likes, playlist list, `list/kinds` и один playlist detail вернули HTTP 200. Likes ответ имеет `result.library.{uid,revision,playlistUuid,tracks}`, playlist catalog и independent kinds оба возвращают массивы, detail содержит `trackCount` и `tracks[]`. Отдельно публичный catalog search (`type=track`) вернул HTTP 200, а `POST /tracks` с form-urlencoded `track-ids` успешно гидрировал один публичный search result (HTTP 200). В terminal без credentials те же public search + one-track hydration вернули HTTP 200; ответы совпали по форме. Скрипты возвращали только статусы, типы и имена полей: UID, playlist kinds, названия, user track IDs и account collection sizes не сохранялись и не включались в PR. Это проверяет CORS/route shapes для чтения и metadata hydration, но не весь extension→app bridge и не hydration всей пользовательской библиотеки.
