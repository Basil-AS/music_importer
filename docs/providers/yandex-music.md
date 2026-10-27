# Яндекс Музыка API

Статус: исходники актуальной community-библиотеки и её документация просмотрены 27.10.2026. API неофициальный и обратным проектированием восстановлен сообществом; официального открытого Web API для этой интеграции не найдено.

## Библиотека и авторизация

Основной кандидат — [MarshalX/yandex-music-api](https://github.com/MarshalX/yandex-music-api), LGPL-3.0. В проверенном срезе GitHub: последний опубликованный релиз `v3.2.2`, исходный commit `9ca132e` (2026-10-11), репозиторий обновлялся 2026-10-26. Поддерживает sync/async клиент; OpenAPI справочник, генерируемый из реализации библиотеки, описывает около 150 операций и 220 схем. Сверяйте детали с конкретной версией перед реализацией.

В библиотеке есть OAuth Device Flow: клиент запрашивает device code у `https://oauth.yandex.ru/device/code`, показывает `verification_url` и `user_code`, периодически опрашивает `https://oauth.yandex.ru/token` и получает access token (и, в ответе библиотеки, поля refresh token/expires). Пользователь сам подтверждает вход на домене Яндекса. В коде этой версии используются OAuth client credentials публичного Android-клиента; это не равно официально выданным credentials нашему приложению. Некоторые аккаунты/регионы/режимы могут не пройти flow. Библиотека предупреждает, что хранение токена остаётся вызывающему приложению; lifecycle обновления следует явно реализовать и проверить.

Вход через логин/пароль не нужен для рекомендуемого прототипа. Токен — секрет; не коммитить и не печатать в лог.

## Операции с лайками

В этой версии библиотека реализует следующие HTTP-шаблоны (это reverse-engineered контракт библиотеки, не официальная спецификация Яндекса):

- `GET /users/{user_id}/likes/tracks` — список лайкнутых треков (`users_likes_tracks()`); если `user_id` не передан, библиотека использует UID текущего аккаунта. Поддерживается параметр `if-modified-since-revision`; полный набор данных и поведение при отсутствии изменений нужно проверять на используемой версии.
- `POST /users/{user_id}/likes/tracks/add-multiple`, JSON-поле `track-ids` — добавить лайк одному или нескольким трекам (`users_likes_tracks_add`).
- `POST /users/{user_id}/likes/tracks/remove`, JSON-поле `track-ids` — снять лайк (`users_likes_tracks_remove`).
- `POST /tracks` — получить карточки по набору ID; библиотека передаёт `with-positions`.

Реализация `_like_action` считает операцию успешной по наличию `revision` в ответе для треков. В изученном исходнике не обнаружено зафиксированного стабильного максимального размера пачки: его нельзя предполагать, нужно выяснять тестом и учитывать ответы сервиса.

### Другой рабочий клиент: `yandex-music-transfer`

В репозитории [yarikmsu/yandex-music-transfer](https://github.com/yarikmsu/yandex-music-transfer), HEAD `eb88366` (2026-10-20, MIT), exporter использует тот же список лайков, но отдельный legacy flow: пользователь получает access token по URL с `response_type=token` и client ID официального Android-приложения. README уточняет, что этот client ID не опубликован Яндексом для сторонних интеграций. Это не Device Flow из MarshalX-библиотеки и не официально зарегистрированное приложение нашего проекта.

По исходнику `exporter/fetch_tracks.py` exporter вызывает `GET /account/status`, `GET /users/{uid}/likes/tracks`, `POST /tracks` с `application/x-www-form-urlencoded` и `track-ids=<comma-separated IDs>`, а для плейлистов — `GET /users/{uid}/playlists/list` и `GET /users/{uid}/playlists/{kind}`. Карточки лайков батчатся по 100; экспортируются CSV с ID и метаданными. Эти routes совпадают с нашими read-only terminal probes, но это только статическая сверка кода: данный exporter не запускали.

Из этого проекта стоит взять формат полного offline экспорта/ручной сверки. Не перенимать implicit-token URL и постоянное хранение access token в `.env` как основную auth-архитектуру; предпочтительнее Device Flow с локальным защищённым token store и ясным revoke path.

### Дополнительный CSV exporter: `nevdev-ml/yandex-music-exporter`

В репозитории [nevdev-ml/yandex-music-exporter](https://github.com/nevdev-ml/yandex-music-exporter), MIT, просмотренный HEAD `78a081a` (последнее обновление GitHub — 13.03.2026), найдены экспорт лайкнутых/дизлайкнутых треков, альбомов и артистов. Треки читаются через `users_likes_tracks().fetch_tracks()` из `yandex-music`; CSV содержит название, артиста, альбом и ID, сохраняется UTF-8 BOM. Выходные файлы автоматически разбиваются на части до 500 строк — это ограничение формата файла, а не заявленный лимит выгрузки. Код сортирует записи по артисту, поэтому исходный порядок лайков теряется; ISRC не экспортируется.

Авторизация открывает отдельный Selenium Chrome по implicit URL (`response_type=token`) с client ID публичного Android-приложения, извлекает access token из callback URL и записывает его в `.env` через `python-dotenv`. Источник прямо заявляет, что client ID не является credential нашего приложения; режим прав файла не задаётся, а токен в URL/файле нужно считать секретом. Код просмотрен статически, не запускался. Полезен как CSV-exporter/reference на методы библиотеки, но не как готовый Apple importer или образец безопасной авторизации.

Дополнительная реализация в [oklookat/synchro](https://github.com/oklookat/synchro), HEAD `ac441f4` от 2024-07-07 (GPL-3.0), использует Go-клиент `goym`: OAuth Device Flow с credentials публичного Android-клиента, чтение `LikedTracks`, загрузку metadata пачками по 30 и методы `LikeTracks`/`UnlikeTracks`. В просмотренной версии `LikedTracks` отбрасывает UGC записи; это означает, что такой экспорт не гарантированно сохраняет весь список лайков. Код старый и хранит auth в SQLite без шифрования, поэтому годится только как reference операций, не как готовое приложение.

## Практическая проверка

- В авторизованной вкладке Chrome видимый раздел коллекции «Мне нравится» открылся. Наблюдались `GET https://api.music.yandex.ru/playlist/lk.:liked-id` и `POST https://api.music.yandex.ru/tracks`, оба `200`. ID приватного плейлиста заменён шаблоном; параметры и тела с содержимым пользовательской коллекции не сохранялись.
- Повторная read-only проверка из терминала с временной Chrome-сессией: `GET https://api.music.yandex.ru/account/status` вернул `200`; полученный в памяти UID использован только для `GET /users/{uid}/likes/tracks` (`200`). Список содержал записи `id`/track refs; приватный UID, названия и сами ID не печатались и не сохранялись.
- По первой записи списка проверен `POST https://api.music.yandex.ru/tracks` с form body `track-ids=<id>` (формат из `_client/_batch.py`), ответ `200`, одна карточка. Вызов сначала был сформирован неверно как JSON-массив и вернул `400`; после сверки с реализацией исправлен на form-encoded `track-ids`. Тела ответов не сохранялись.
- Из терминала публичный no-auth запрос `GET https://api.music.yandex.net/search?text=...&type=track&page=0` вернул `200 application/json`. Вывод ответа не раскрывался. Это подтверждает доступность поискового каталога без аккаунта в проверенном случае, но ничего не говорит о доступе к лайкам.
- Device Flow описан проектом: `POST https://oauth.yandex.ru/device/code`, затем polling `POST https://oauth.yandex.ru/token`; фактический вход и получение токена в терминале не запускались. Запись/снятие лайков не вызывались.

## Оценка

Подходит как источник лайков для локального прототипа и для дальнейшей поддержки. Риски: нестабильный контракт, зависимость от OAuth credentials стороннего клиента, разная доступность по аккаунтам, и лицензия LGPL-3.0 при возможном включении библиотеки в проект. Для MVP лучше начать read-only экспорт, сохранить полный каталог, затем отдельно проверить изменение лайка на собственном аккаунте.

## Источники

- [GitHub repository](https://github.com/MarshalX/yandex-music-api)
- [nevdev-ml/yandex-music-exporter](https://github.com/nevdev-ml/yandex-music-exporter)
- [Project docs](https://ym.marshal.dev/)
- [Client method reference](https://ym.marshal.dev/client/)
- [OpenAPI reference](https://ym.marshal.dev/api/)
- [Device auth docs](https://ym.marshal.dev/token)
- [oklookat/synchro Yandex adapter at `ac441f4`](https://github.com/oklookat/synchro/blob/ac441f45f1cd6a143b361a10a48611f33e96f426/remote/yandexmusic/accountActions.go)
- [oklookat/synchro Yandex auth at `ac441f4`](https://github.com/oklookat/synchro/blob/ac441f45f1cd6a143b361a10a48611f33e96f426/remote/yandexmusic/main.go)

Изучено по исходникам community-библиотеки, её OpenAPI, браузерному UI и terminal HTTP-пробам с пользовательской сессией. Это не контракт Яндекса; OAuth Device Flow и мутации на аккаунте не запускались.
