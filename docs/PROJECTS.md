# Готовые проекты и библиотеки

Срез GitHub и документации от 27.10.2026. Список — кандидаты для разбора, а не гарантия, что последний релиз у каждого работает или что заявленные возможности покрывают перенос лайков в Apple Music. Перед использованием проверить текущие коммиты, лицензии, открытые issues, способ авторизации и что делает код с токенами.

## Самые полезные кандидаты

| Проект | Что умеет / польза для нас | Ограничения по текущим данным |
|---|---|---|
| [Apple Music: Transfer Music from Other Services](https://support.apple.com/en-us/118249) | Встроенный официальный перенос из доступных источников; Apple подтверждает, что лайки/избранное source становятся элементами Favorite Songs. Доступен на iOS/iPadOS, Android и web | Нужна подписка Apple Music и Sync Library; поддерживаемые источники/объекты зависят от провайдера и региона. Поставляет third party; не доступен в материковом Китае, Мьянме и России. Сначала проверить список источников в аккаунте |
| [ZvukDownloader](https://github.com/Basil-AS/ZvukDownloader) | Данный пользователем код; разбирает API Звука, профиль, релизы, треки, плейлисты, stream, тексты | Скрипт для скачивания локального аудио. Cookie `auth` извлекается вручную; в просмотренном коде нет методов импорта/экспорта лайков. Отличная база для каталожного адаптера, но не готовый переносчик |
| [Официальная миграция Звука](https://help.zvuk.com/article/42207) | Импортирует в Звук из Apple Music, Яндекс Музыки, VK, Spotify, Deezer, YouTube Music; на сайте принимает также список треков | Не экспортирует из Звука; результат создаётся отдельным плейлистом, не «Любимым»; переносит лишь каталоговые совпадения Звука. Не решает целевое направление Звук → Apple |
| [sberzvuk-api](https://github.com/Aiving/sberzvuk-api) | TypeScript клиент: анонимный токен, поиск, track/album/playlist и stream через GraphQL | Не нашёл likes/favorites; анонимный токен урезан. Полезен для каталоговых запросов и понимания GraphQL |
| [zvuk-music](https://github.com/trudenboy/zvuk-music) | Python, MIT, опубликован на PyPI (`0.6.3` на 07.10.2026); `get_liked_tracks`, `like_track`, `unlike_track`; sync/async клиенты и CLI | Неофициально исследованный API. Нужен токен авторизованного аккаунта. README противоречиво говорит про платную подписку в целом и отдельно про премиальные аудиокачества. Проверить чтение лайков без подписки; для миграции не нужны stream/download методы |
| [yandex-music-api](https://github.com/MarshalX/yandex-music-api) | Наиболее полная библиотека Яндекс Музыки; Device Flow, чтение/запись лайков, OpenAPI | Неофициальная, reverse-engineered; внешние OAuth client credentials; LGPL-3.0. Возможны изменения сервиса |
| [YandexMusic_to_AppleMusic](https://github.com/ComputerPers/YandexMusic_to_AppleMusic) | Небольшой macOS/Python pipeline: экспорт Яндекс лайков, поиск Apple каталога, добавление через Music.app/AppleScript или API; полезные примеры экспорта и отчёта несовпадений | Добавляет в Apple Library/playlist, а не в `Favorite Songs`. В API режиме использует Developer + Media User Token; `extract_tokens.py` извлекает токен из Chrome/Safari cookies — не перенимать этот подход. Небольшой проект, лицензия не указана |
| [Myp3a/mixxer](https://github.com/Myp3a/mixxer) | MIT Python-проект: Spotify, Yandex, Apple, VK; настраиваемый matcher/threshold, отдельный плейлист или library; Yandex adapter использует `users_likes_tracks()` | Последний коммит 2024-08-05. Apple adapter пишет в Library/playlist, не Favorite Songs; использует Apple user token. Устаревшие зависимости/методы и ручная конфигурация; референс матчинг-пайплайна, не готовый мигратор |
| [Spotify data export](https://support.spotify.com/us/article/data-rights-and-privacy-settings/) | Бесплатный официальный архив личных данных; Spotify указывает, что раздел `Your Library` содержит сохранённые песни и их URIs. Хороший backup/fallback без Web API quota | Архив нужно запросить и дождаться; это исходные метаданные, а не автоматическая запись в Apple. Для приложения нужен parser скачанного пользователем ZIP/JSON |
| [SongMirror](https://github.com/ahnafnafee/songmirror) | Самостоятельно размещаемый проект для многих сервисов, включая Spotify и Apple; заявляет transfer/ISRC matching и поддержку built-in favorites. Ценно как архитектурный ориентир | README говорит, что Apple Music destination и часть library browsing требуют платного CloudLibrary privilege. Spotify default использует `sp_dc` cookie и внутренний web API. Не путь для повторения в нашем приложении |
| [Songport](https://github.com/xlollx/Songport) | Android, локальная обработка, Spotify и Apple Music в списке коннекторов | Текущая матрица перечисляет Liked Songs source/target для Spotify, Deezer и локальных источников, но Apple favorites target не заявлен. Spotify Web route неофициальный, может нарушать условия Spotify и сломаться |
| [jMusic](https://github.com/JotaMelo/jMusic) | Узкий Spotify → Apple Music, открытый код и потенциально самый простой референс для одного направления | Не общий мультисервисный движок; Apple auth/ограничения и актуальную работоспособность нужно проверить на исходниках/устройстве |
| [yandex-music-api OpenAPI](https://ym.marshal.dev/api/) | Машиночитаемая документация на более чем сотню методов, подходящая для изучения и прототипирования | Это community spec, генерируемая из неофициальной реализации |

## Что важно проверить в готовом коде

1. Вход через OAuth/системный браузер или запрос пароля/cookie/session token. Предпочтителен OAuth с явным consent; если надо использовать cookie, понимать риск и не отправлять его стороннему серверу.
2. Наличие `liked songs` в обоих направлениях и точный семантический смысл назначения: Apple Favorite Songs или отдельный playlist.
3. Пагинация и отсутствие внутреннего ограничения в 100/500/1000 элементов; обработка 429 и возобновление после обрыва.
4. ISRC, качество сопоставления, работа с explicit/live/remaster/compilation, ручной разбор неизвестных песен.
5. Проверка дубликатов и фактической записи на стороне Apple, а не только успешный HTTP статус.
6. Лицензия каждой библиотеки и совместимость с моделью локального приложения.

## Что можно взять в наш проект

- Переиспользовать типы и запросы в `ZvukDownloader`/`sberzvuk-api` как исследовательскую базу, но отделить чтение каталога от скачивания аудио.
- Для Звука начать с read-only `trudenboy/zvuk-music`: это первый найденный актуальный коннектор с методами лайков и MIT лицензией.
- Использовать `yandex-music-api` как эталон списка методов/моделей, начиная с read-only выгрузки лайков.
- Для Spotify сначала проверить Apple built-in transfer и при необходимости официальный Spotify data export; Web API оставить вариантом при выполнении условий Spotify.
- Собственная запись в Apple Favorites через REST MusicKit не выглядит бесплатным путём: выпуск developer token документирован для участника Apple Developer Program ($99/год в текущем прайсе). Проверять штатный Apple transfer или другие официально разрешённые варианты до проектирования записи в API.
- `YandexMusic_to_AppleMusic` и `mixxer` могут ускорить экспорт и catalogue matching, но их операции Apple Library не равны записи в Favorite Songs.
- Изучить SongMirror для нормализации данных и сопоставления, но не строить на нём ожидание, что путь Apple Music останется полностью бесплатным.
- Сначала реализовать небольшую собственную локальную миграцию с форматом промежуточного экспорта и ручным подтверждением несовпадений. Приватные API оставить изолированными адаптерами, чтобы замена одного провайдера не меняла ядро.

## Ссылки

- [ZvukDownloader](https://github.com/Basil-AS/ZvukDownloader)
- [sberzvuk-api](https://github.com/Aiving/sberzvuk-api)
- [zvuk-music](https://github.com/trudenboy/zvuk-music)
- [yandex-music-api](https://github.com/MarshalX/yandex-music-api)
- [YandexMusic_to_AppleMusic](https://github.com/ComputerPers/YandexMusic_to_AppleMusic)
- [Myp3a/mixxer](https://github.com/Myp3a/mixxer)
- [SongMirror](https://github.com/ahnafnafee/songmirror)
- [Songport](https://github.com/xlollx/Songport)
- [jMusic](https://github.com/JotaMelo/jMusic)
- [Spotify Web API examples](https://github.com/spotify/web-api-examples)
- [Spotify data export](https://support.spotify.com/us/article/data-rights-and-privacy-settings/)
- [Apple Music transfer support article](https://support.apple.com/en-us/118249)
