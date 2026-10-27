# Apple Music API / MusicKit

Статус: официальная документация и авторизованный Apple Music Web проверены 27.10.2026. В качестве назначения важно переносить понравившиеся композиции именно в Apple Favorite Songs, если пользователь под «лайками» имеет это в виду; не просто складывать их в отдельный плейлист.

## Авторизация

Apple API различает developer token, подписанный разработчиком JWT, и Music User Token, который разрешает пользовательские операции. Запросы каталога используют developer token; запросы к `/v1/me/...` требуют также Music User Token. MusicKit предназначен для получения пользовательского разрешения в поддерживаемой платформе. Запрос доступа должен быть явным и объяснять назначение.

Для выпуска developer token Apple документирует Media Services private key и прямо говорит, что для запросов Apple Music API разработчик должен быть участником Apple Developer Program. Текущая официальная цена членства — $99 в год (региональные цены могут отличаться). Поэтому собственный REST-клиент записи в Favorites нельзя считать бесплатным до практической проверки альтернативного штатного flow. Бесплатная регистрация Apple Developer не равна членству в программе и не даёт подтверждённого здесь права создать ключ MusicKit.

### Локальный Music.app без MusicKit REST API

Для macOS есть отдельный путь без MusicKit developer token: локальное приложение Music управляется AppleScript. В открытом проекте `ComputerPers/YandexMusic_to_AppleMusic` вариант `add_to_apple_music.py` добавляет предварительно найденные записи через Music.app/AppleScript; README указывает подписку Apple Music и авторизацию в приложении, но не developer key для этого варианта.

Для собственно Favorites опубликован [MIT AppleScript](https://gist.github.com/obitech/5e18ec3c8c24f89c96f0cf396cb33e48): он проходит по трекам уже созданного в Music.app плейлиста и выставляет `favorited` в true, пропуская уже избранные. Скрипт ждёт 1 секунду между треками; автор пишет, что ему нужен macOS и Apple Music subscription. Это готовый минимальный прототип назначения лайков, но не полный переносчик и не проверка надёжности на больших/смешанных коллекциях.

Ещё один актуальный референс — [epheterson/applemusic-mcp](https://github.com/epheterson/applemusic-mcp), MIT. В его README локальный уровень `music` ограничивает доступ только приложением Music.app и заявляет Favorites, добавление записей в Library, управление плейлистами и рейтингами. Для этой задачи интересен именно локальный AppleScript-уровень; у проекта есть также web/API режимы с иной моделью авторизации, которые не входят в выбранный бесплатный flow.

Рабочая гипотеза для бесплатного локального мигратора: выгрузить лайки провайдера → сопоставить с каталогом Apple → добавить найденные записи в Library/временный плейлист через штатное Music.app управление → локальным AppleScript выставить Favorites → сверить результат и отчёт пропусков. Ограничение Apple Developer Program относится к REST API и не автоматически к AppleScript. Сценарий всё равно требует Apple Music subscription и локального Mac; массовую запись, облачную синхронизацию и поведение на уже добавленных/недоступных треках нужно проверить на тестовой небольшой выборке.

### Встроенный перенос в Apple Music

Apple поддерживает отдельный официальный пользовательский transfer flow в приложении и на `music.apple.com`. Apple пишет, что source liked/loved songs попадают в Favorite Songs; пользователю нужно подписаться на Apple Music, включить Sync Library и авторизоваться в source service. Совместимые источники и переносимые типы данных выбираются провайдером и могут различаться. Для вариантов, требующих проверки, Apple даёт 30 дней на разбор; сам перенос выполняется сторонним провайдером. Это первый кандидат для пробного Spotify → Apple переноса, если Spotify есть в списке источников для конкретного аккаунта и региона. Официальная поддержка Apple указывает, что transfer недоступен в материковом Китае, Мьянме и России; в других регионах доступность может отличаться.

## Каталог, библиотека, избранное

- Поиск: Apple Music API Catalog search по storefront, искать песню/артиста/альбом; затем подтвердить совпадение ISRC/метаданными.
- Чтение библиотеки: `GET https://api.music.apple.com/v1/me/library/songs`; требует Music User Token, поддерживает пагинацию. Для catalog ID в library response может присутствовать `playParams.catalogId`.
- Добавление в Favorite Songs: `POST https://api.music.apple.com/v1/me/favorites?ids=<catalog-id>` с developer + music user authorization. Документация указывает `202 Accepted`; если пользователь favorites song, она добавляется в `favorite songs` playlist. Для недоступных ID запрос может быть принят, но такие элементы игнорируются — поэтому успех HTTP сам по себе не равен успешному импорту.
- Создание обычного плейлиста: `POST /v1/me/library/playlists`, добавление элементов в playlist поддерживается отдельно. Это не эквивалент добавлению в favorites.
- Добавление ресурса в библиотеку `POST /v1/me/library` — отдельная операция от `/me/favorites`; нужно не смешивать понятия «в библиотеке» и «избранное».

## Практическая проверка

- В авторизованной вкладке Music Web для storefront `tr` при открытии видимого раздела избранного браузер получил `200` от `GET https://amp-api.music.apple.com/v1/me/library` и `GET /v1/me/library/playlists/{id}`; запрос каталога `GET /v1/catalog/tr` также вернул `200`. Это подтверждает работу сессии веб-приложения в браузере, но не выдаёт поддерживаемый публичный способ получать его credentials.
- Из терминала без пользовательской авторизации `GET https://api.music.apple.com/v1/me/library/songs?limit=1` и поиск `GET /v1/catalog/us/search?...` вернули `401`. Официальный REST-доступ требует developer token, а пользовательские `/me` операции — ещё и Music User Token.
- Словарь установленного локального Music.app (`com.apple.Music.sdef`) объявляет свойство `favorited` как read/write для треков; persistent ID доступен только для чтения. Это локальное AppleScript-поверхностное API, отдельное от MusicKit REST. Оно делает локальный сценарий правдоподобным, но полноценную запись избранного ещё надо безопасно проверить на тестовом наборе.
- Запись через браузерные или REST endpoints не выполнялась; ID пользователя и содержимое библиотеки в документацию не переносились.

## Ограничения для миграции

Нужен storefront пользователя: каталожные ID региональны, некоторые записи отсутствуют или доступны только в другом storefront. Favorite request может игнорировать неразрешимые ID без подробного результата по каждому элементу, поэтому после пачек требуется повторно перечитать Favorite Songs/библиотеку и сравнить фактический набор. API не переносит исходный аудиофайл и не гарантирует точное соответствие версии/ремастера.

## Источники

- [Apple Music API overview](https://developer.apple.com/documentation/AppleMusicAPI)
- [MusicKit](https://developer.apple.com/musickit/)
- [User authentication / Music User Token](https://developer.apple.com/documentation/applemusicapi/user-authentication-for-musickit)
- [Generating developer tokens](https://developer.apple.com/documentation/AppleMusicAPI/generating-developer-tokens)
- [Create a media identifier and private key](https://developer.apple.com/help/account/capabilities/create-a-media-identifier-and-private-key)
- [Add resource to favorites](https://developer.apple.com/documentation/applemusicapi/add-resource-to-favorites)
- [Get all library songs](https://developer.apple.com/documentation/applemusicapi/get-all-library-songs)
- [Create a library playlist](https://developer.apple.com/documentation/applemusicapi/create-a-new-library-playlist)
- [Apple Developer Program fee](https://developer.apple.com/help/account/membership/program-enrollment)
- [Apple Music transfer from other services](https://support.apple.com/en-us/118249)
- [Transfer in the Music app](https://support.apple.com/en-ca/guide/iphone/iph103c19002/ios)
- [MIT script: Spotify Liked Songs to Apple Music Favorite Songs](https://gist.github.com/obitech/5e18ec3c8c24f89c96f0cf396cb33e48)
- [Apple Music MCP (MIT; local Music.app mode)](https://github.com/epheterson/applemusic-mcp)

**Уточнение к найденным сторонним скриптам:** `ComputerPers/YandexMusic_to_AppleMusic` показывает два способа добавления: AppleScript добавляет песню в библиотеку/свой плейлист, API-вариант вызывает `POST /v1/me/library` (добавить в библиотеку). Просмотренный код не вызывает `/v1/me/favorites`, поэтому его успешная работа не означает, что лайки перенесены в Favorite Songs. Его `extract_tokens.py` автоматически читает Chrome/Safari cookie-хранилище и сохраняет приватный Music User Token; это не официальный MusicKit authorization flow. Не использовать извлечение cookie как архитектурный образец.

Проверено по официальной документации, исходникам и read-only наблюдениям браузера/терминала. Пользовательские операции записи не запускались.
