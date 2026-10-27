# Apple Music API / MusicKit

Статус: официальная документация просмотрена 27.10.2026. В качестве назначения важно переносить понравившиеся композиции именно в Apple Favorite Songs, если пользователь под «лайками» имеет это в виду; не просто складывать их в отдельный плейлист.

## Авторизация

Apple API различает developer token, подписанный разработчиком JWT, и Music User Token, который разрешает пользовательские операции. Запросы каталога используют developer token; запросы к `/v1/me/...` требуют также Music User Token. MusicKit предназначен для получения пользовательского разрешения в поддерживаемой платформе. Запрос доступа должен быть явным и объяснять назначение.

Создание ключа и developer token нужно проверить для локального личного сценария отдельно. Apple Developer Program сейчас указан как $99 за год; бесплатная регистрация разработчика существует, но наличие бесплатной учётной записи само по себе не доказывает, что можно выпустить нужный MusicKit private key. Не считать бесплатность подтверждённой до практической проверки конкретного token flow.

## Каталог, библиотека, избранное

- Поиск: Apple Music API Catalog search по storefront, искать песню/артиста/альбом; затем подтвердить совпадение ISRC/метаданными.
- Чтение библиотеки: `GET https://api.music.apple.com/v1/me/library/songs`; требует Music User Token, поддерживает пагинацию. Для catalog ID в library response может присутствовать `playParams.catalogId`.
- Добавление в Favorite Songs: `POST https://api.music.apple.com/v1/me/favorites?ids=<catalog-id>` с developer + music user authorization. Документация указывает `202 Accepted`; если пользователь favorites song, она добавляется в `favorite songs` playlist. Для недоступных ID запрос может быть принят, но такие элементы игнорируются — поэтому успех HTTP сам по себе не равен успешному импорту.
- Создание обычного плейлиста: `POST /v1/me/library/playlists`, добавление элементов в playlist поддерживается отдельно. Это не эквивалент добавлению в favorites.
- Добавление ресурса в библиотеку `POST /v1/me/library` — отдельная операция от `/me/favorites`; нужно не смешивать понятия «в библиотеке» и «избранное».

## Ограничения для миграции

Нужен storefront пользователя: каталожные ID региональны, некоторые записи отсутствуют или доступны только в другом storefront. Favorite request может игнорировать неразрешимые ID без подробного результата по каждому элементу, поэтому после пачек требуется повторно перечитать Favorite Songs/библиотеку и сравнить фактический набор. API не переносит исходный аудиофайл и не гарантирует точное соответствие версии/ремастера.

## Источники

- [Apple Music API overview](https://developer.apple.com/documentation/AppleMusicAPI)
- [MusicKit](https://developer.apple.com/musickit/)
- [User authentication / Music User Token](https://developer.apple.com/documentation/applemusicapi/user-authentication-for-musickit)
- [Add resource to favorites](https://developer.apple.com/documentation/applemusicapi/add-resource-to-favorites)
- [Get all library songs](https://developer.apple.com/documentation/applemusicapi/get-all-library-songs)
- [Create a library playlist](https://developer.apple.com/documentation/applemusicapi/create-a-new-library-playlist)
- [Apple Developer Program fee](https://developer.apple.com/help/account/membership/program-enrollment)

Проверено по официальной документации; токен/живые пользовательские операции и стоимость credentials для локального прототипа ещё не проверялись.
