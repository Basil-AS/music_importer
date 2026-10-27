# Яндекс Музыка: поиск и запись в аккаунт

## Статус

Добавлен первый target adapter для проекта: ищет tracks в каталоге Яндекса из активной вкладки и умеет переносить лайки и playlist items в аккаунт пользователя. Прямые обращения используют browser session на `api.music.yandex.ru`; значения cookie, `Authorization` и другие секреты не извлекаются из страницы и не сохраняются.

Реальная мутация аккаунта **не запускалась**. Код прошёл только изолированный fixture flow: поиск, чтение существующих лайков, добавление лайка, создание приватного playlist, positional insert и обратная проверка ID/порядка. До первой live-проверки остаются неизвестными CORS в актуальной вкладке, mutation batch limits, текущая форма всех ответов и поведение revision conflict.

## Запросы, используемые writer

| Действие | Запрос | Формат/проверки |
|---|---|---|
| Каталог | `GET /search?text=…&page=0&type=track` | Возвращает до 20 кандидатов с track ID, album ID и метаданными. |
| Текущие likes | `GET /users/{uid}/likes/tracks?if-modified-since-revision=0` | Перед записью существующие IDs читаются, чтобы пропустить уже сохранённые лайки. |
| Добавить likes | `POST /users/{uid}/likes/tracks/add-multiple` | `application/x-www-form-urlencoded`, поле `track-ids`; отправка партиями по 25 — консервативная настройка, её предел не подтверждён live. После записи коллекция перечитывается и все запрошенные IDs проверяются. |
| Создать playlist | `POST /users/{uid}/playlists/create` | Form fields `title`, `visibility=private`; далее из ответа требуется playlist `kind`. |
| Добавить playlist items | `POST /users/{uid}/playlists/{kind}/change-relative` | Form fields `revision` и `diff={op:"insert",at,tracks:[{id,albumId}]}`. Перед batch читается свежая revision и текущий trackCount. После вставки перечитываются IDs и порядок. |

Route families и формы сверены со статическим source audit community clients: [sonrac/yandex-music-api](https://github.com/sonrac/yandex-music-api/blob/master/src/Yandex.php), [MarshalX/yandex-music-api docs](https://github.com/MarshalX/yandex-music-api) и современным [okhsunrog/yamu](https://github.com/okhsunrog/yamu). Это не официальный SLA Яндекса.

## Защита от неверного переноса

- Writer принимает только `music-transfer-plan` с целью `yandex-music` и только полный подтверждённый source snapshot.
- UI требует отдельное явное подтверждение перед изменением аккаунта.
- Favorites добавляются без снятия текущих лайков; существующие IDs не дублируются.
- Новые плейлисты создаются приватными, включая пустые коллекции. Для каждого batch проверяется текущая playlist revision; конфликт приводит к остановке.
- В конце читаются назад favorites и созданные playlists; любой count, ID или порядок mismatch не объявляется успехом.
- Ошибка после части записи возвращает `partial_failure`. Запись не откатывается автоматически. Повторный запуск после частичного сбоя может создать playlist-дубликат; сначала проверьте аккаунт.

## Ограничения

Пока нет live browser verification для поисковых ответов, CORS, likes mutations, playlist creation, revision conflict и read-back. API route shapes из community-кода не означают, что их текущие серверные semantics подтверждены. Перед полноценным релизом нужна отдельная однотрековая live-проверка с пользователем, который просмотрит match и подтвердит операцию; после этого — испытание маленького playlist и контроль read-back. Сейчас не следует считать ни одно направление выполненным end-to-end.
