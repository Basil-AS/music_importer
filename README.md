# Music Importer

Проект для переноса музыкальной библиотеки между стриминговыми сервисами. Первая цель — сохранить лайки и плейлисты при переносе в Apple Music; в перспективе — добавить другие источники и направления. Импортируются записи библиотеки и метаданные, не аудиофайлы.

## Исследование

- [Сводная таблица API-маршрутов, авторизации и проверок](docs/API_MATRIX.md)
- [Обзор API, авторизации и ограничений сервисов](docs/RESEARCH.md)
- [Целевой опыт и архитектурные ограничения продукта](docs/PRODUCT_DIRECTION.md)
- [Способы входа через пользовательские аккаунты и локальное расширение](docs/LOGIN_MECHANISMS.md)
- [Сравнение auth flow и локального хранения токенов](docs/AUTHENTICATION.md)
- [Сопоставление треков, ISRC и ручная проверка кандидатов](docs/MATCHING.md)
- [API-заметки: SberZvuk / Звук](docs/providers/zvuk.md)
- [API-заметки: Spotify](docs/providers/spotify.md)
- [Полный индекс 96 официальных Spotify OpenAPI операций](docs/providers/spotify-openapi-inventory.md)
- [API-заметки: Apple Music](docs/providers/apple-music.md)
- [API-заметки: Яндекс Музыка](docs/providers/yandex-music.md)
- [Полный индекс 150 community OpenAPI операций Яндекс Музыки](docs/providers/yandex-openapi-inventory.md)
- [Готовые проекты и библиотеки](docs/PROJECTS.md)
- [GitFlow и правила коммитов](docs/WORKFLOW.md)

Исследование ведётся по официальной документации, когда она есть, и сверяется с открытым исходным кодом для неофициальных API. В каждой заметке отмечено, что проверено в источнике, а что ещё предстоит проверить на живом аккаунте.
