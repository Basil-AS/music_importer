# Яндекс Музыка: local-session reader

## Назначение и статус

Добавлен экспериментальный read-only connector для уже открытой авторизованной вкладки `music.yandex.ru`. Он читает понравившиеся треки и пользовательские плейлисты для передачи в общий importer. Используются private/community API маршруты из исследования; это не официальный third-party API и не стабильная production интеграция. В этой итерации вызовы проверены только на mock responses, не на пользовательской сессии.

## Запросы

Из main-world контекста вкладки выполняются запросы с обычными browser credentials:

1. `GET https://api.music.yandex.ru/account/status` — получить UID текущего аккаунта в памяти страницы.
2. `GET /users/{uid}/likes/tracks?if-modified-since-revision=0` — прочитать полный массив short track refs и revision.
3. `POST /tracks` — гидрировать карточки ID form-urlencoded полем `track-ids`, партиями по 100, без лимита на весь список.
4. `GET /users/{uid}/playlists/list` — получить каталог пользовательских плейлистов.
5. `GET /users/{ownerUid}/playlists/{kind}` — читать треки каждого плейлиста; для short refs повторно вызывается `/tracks`.

Cookie значения и access tokens не читаются JavaScript-кодом, не складываются в extension storage и не отправляются в приложение. Браузер сам прикладывает cookie к запросу домена Яндекса. Локальное приложение получает только метаданные после завершения скана.

## Полнота и обработка ошибок

- Likes принимаются только если ответ содержит revision, все short refs имеют уникальные IDs, и `/tracks` вернул каждую карточку.
- Для каждого playlist `tracks.length` сравнивается с provider `trackCount`; позиции назначаются по исходному порядку API, повторы сохраняются, пустые playlist остаются в snapshot.
- Гидратация идёт партиями по 100 с короткой паузой. Повреждённый JSON, неполные batches, API errors, отсутствие аккаунта, unknown shape или mismatch останавливают скан и не передают неполный snapshot в matcher.
- Каталог пользовательских плейлистов приходит одним ответом endpoint без известной cursor-пагинации. Независимый total каталога в исследованном контракте не описан; это ограничение надо проверить на аккаунте до заявления полной синхронизации.

## Ограничения и дальнейшая проверка

- CORS и поведение запросов из `music.yandex.ru` в `api.music.yandex.ru` ещё не подтверждены на runtime; API может потребовать заголовки, которые устанавливает сам web player.
- Likes endpoint не описывает pagination. Пока source service возвращает весь список одним response, код сверяет все уникальные refs с гидратированными карточками и сохраняет revision; этот контракт остаётся private.
- Этот документ описывает только reader: он выполняет GET и metadata POST. Yandex target writer реализован отдельно; см. [`YANDEX_TRANSFER.md`](YANDEX_TRANSFER.md). Live mutation всё ещё не проверялась.
- Для проверки откройте Яндекс Музыку в Chrome, выберите её как источник и нажмите «Подтянуть из расширения». Если API не допускает page-context fetch, ошибка будет показана, а snapshot не будет считаться полным.

Исследовательские детали и ранее подтверждённые request shapes: [`providers/yandex-music.md` в API research](https://github.com/Basil-AS/music_importer/blob/feature/music-service-api-research/docs/providers/yandex-music.md).

## Browser read-only shape check (2026-10-28)

В отдельной вкладке Chrome без изменения исходной страницы проверена существующая авторизованная cookie-сессия: `/account/status` вернул JSON с `result.account`, likes route — `result.library.{uid,revision,playlistUuid,tracks}`, а `/users/{uid}/playlists/list` — массив playlist objects с `uid`, `kind`, `title`, `trackCount`. Запрос карточки одного playlist вернул `trackCount` и `tracks[]` элементов с вложенным `track` и `originalIndex`. Коллекции не экспортировались и не сохранялись; UID, playlist kinds, названия, track IDs и размеры библиотек не включались в рабочий каталог или PR. Это подтверждает live GET response shapes, но не cross-origin fetch/CORS и не POST hydration из main-world connector.
