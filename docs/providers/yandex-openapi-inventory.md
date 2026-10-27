# Yandex Music community OpenAPI: полный список операций

Снимок `MarshalX/yandex-music-api` commit [`9ca132e`](https://github.com/MarshalX/yandex-music-api/tree/9ca132e5c18a72aab779c1fc68c169380a9357d0), версия спецификации OpenAPI `3.1.0`, версия библиотеки `3.2.2.` Сгенерировано из [`docs/source/_extra/api/openapi.json`](https://github.com/MarshalX/yandex-music-api/blob/9ca132e5c18a72aab779c1fc68c169380a9357d0/docs/source/_extra/api/openapi.json).

В этом срезе **144 path templates и 150 HTTP operations**, сгруппированных по 22 тегам. Это community reverse-engineered contract, не документация Яндекса; схемы могут устареть и не гарантируют, что каждый путь доступен каждому аккаунту/региону.

Базовый сервер спецификации: `https://api.music.yandex.net`. Глобальная схема auth задаёт заголовок `Authorization: OAuth <token>`; только `POST /device/code` и `POST /token` помечены без этой схемы. Device Flow описан отдельно в [провайдерской заметке](yandex-music.md).

Значения параметров, тела, query/header encoding, response schemas и error models остаются в исходной JSON OpenAPI. Этот индекс перечисляет операции и смысл из `summary`, но не является пошаговой инструкцией для всех мутаций. HTTP `POST` не обязательно означает запись: например, `/tracks` используется для получения карточек.

## Операции по группам

### OAuth Device Flow (2)

| HTTP | Path | operationId | Описание из спецификации |
|---|---|---|---|
| `POST` | `/device/code` | `request_device_code` | Запрос кода устройства для OAuth Device Flow. |
| `POST` | `/token` | `poll_device_token` | Однократный опрос статуса подтверждения кода устройства. |

### Авторы контента (2)

| HTTP | Path | operationId | Описание из спецификации |
|---|---|---|---|
| `GET` | `/clips/{clip_id}/credits` | `clips_credits` | Получение информации об участниках создания клипа. |
| `GET` | `/tracks/{track_id}/credits` | `tracks_credits` | Получение информации об участниках создания трека. |

### Аккаунт (8)

| HTTP | Path | operationId | Описание из спецификации |
|---|---|---|---|
| `POST` | `/account/consume-promo-code` | `consume_promo_code` | Активация промо-кода. |
| `GET` | `/account/experiments` | `account_experiments` | Получение значений экспериментальных функций аккаунта. |
| `GET` | `/account/experiments/details` | `account_experiments_details` | Получение детальной информации об экспериментальных функциях аккаунта. |
| `GET` | `/account/settings` | `account_settings` | Получение настроек текущего пользователя. |
| `POST` | `/account/settings` | `account_settings_set` | Изменение настроек текущего пользователя. |
| `GET` | `/account/status` | `account_status` | Получение статуса аккаунта. Нет обязательных параметров. |
| `GET` | `/permission-alerts` | `permission_alerts` | Получение оповещений. Нет обязательных параметров. |
| `GET` | `/settings` | `settings` | Получение предложений по покупке. Нет обязательных параметров. |

### Альбомы (4)

| HTTP | Path | operationId | Описание из спецификации |
|---|---|---|---|
| `POST` | `/albums` | `albums` | Получение альбома/альбомов. |
| `GET` | `/albums/{album_id}/similar-entities` | `albums_similar_entities` | Получение похожих сущностей для альбома. |
| `GET` | `/albums/{album_id}/trailer` | `albums_trailer` | Получение трейлера альбома. |
| `GET` | `/albums/{album_id}/with-tracks` | `albums_with_tracks` | Получение альбома по его уникальному идентификатору вместе с треками. |

### Артисты (16)

| HTTP | Path | operationId | Описание из спецификации |
|---|---|---|---|
| `POST` | `/artists` | `artists` | Получение исполнителя/исполнителей. |
| `GET` | `/artists/{artist_id}/about-artist` | `artists_about` | Получение информации «Об артисте». |
| `GET` | `/artists/{artist_id}/also-albums` | `artists_also_albums` | Получение сборников и альбомов, в которых участвовал артист. |
| `GET` | `/artists/{artist_id}/artist-links` | `artists_links` | Получение ссылок на страницы артиста. |
| `GET` | `/artists/{artist_id}/blocks/artist-clips` | `artists_clips` | Получение клипов артиста. |
| `GET` | `/artists/{artist_id}/blocks/artist-donation` | `artists_donation` | Получение информации о донатах артиста. |
| `GET` | `/artists/{artist_id}/brief-info` | `artists_brief_info` | Получение информации об артисте. |
| `GET` | `/artists/{artist_id}/direct-albums` | `artists_direct_albums` | Получение альбомов артиста. |
| `GET` | `/artists/{artist_id}/discography-albums` | `artists_discography_albums` | Получение дискографии артиста. |
| `GET` | `/artists/{artist_id}/info` | `artists_info` | Получение подробной информации об артисте. |
| `GET` | `/artists/{artist_id}/safe-direct-albums` | `artists_safe_direct_albums` | Получение безопасных альбомов артиста. |
| `GET` | `/artists/{artist_id}/similar` | `artists_similar` | Получение похожих артистов. |
| `GET` | `/artists/{artist_id}/skeletons/web-artist-default` | `artists_skeleton` | Получение скелетона страницы артиста. |
| `GET` | `/artists/{artist_id}/track-ids` | `artists_track_ids` | Получение идентификаторов треков артиста. |
| `GET` | `/artists/{artist_id}/tracks` | `artists_tracks` | Получение треков артиста. |
| `GET` | `/artists/{artist_id}/trailer` | `artists_trailer` | Получение трейлера артиста. |

### Видеоклипы (2)

| HTTP | Path | operationId | Описание из спецификации |
|---|---|---|---|
| `GET` | `/clips` | `clips` | Получение клипов по идентификаторам. |
| `GET` | `/clips/will/like` | `clips_will_like` | Получение подборки рекомендуемых клипов. |

### Волна (3)

| HTTP | Path | operationId | Описание из спецификации |
|---|---|---|---|
| `GET` | `/rotor/wave/last` | `rotor_wave_last` | Получение последней запущенной волны пользователя. |
| `POST` | `/rotor/wave/last/reset` | `rotor_wave_last_reset` | Сброс последней запущенной волны пользователя на «Мою волну». |
| `GET` | `/rotor/wave/settings` | `rotor_wave_settings` | Получение настроек волны: контекстов (занятий) и доступных значений настроек. |

### Дисклеймеры (4)

| HTTP | Path | operationId | Описание из спецификации |
|---|---|---|---|
| `GET` | `/albums/{album_id}/disclaimer` | `albums_disclaimer` | Получение дисклеймера альбома. |
| `GET` | `/artists/{artist_id}/disclaimer` | `artists_disclaimer` | Получение дисклеймера артиста. |
| `GET` | `/clips/{clip_id}/disclaimer` | `clips_disclaimer` | Получение дисклеймера клипа. |
| `GET` | `/tracks/{track_id}/disclaimer` | `tracks_disclaimer` | Получение дисклеймера трека. |

### Закреплённые (9)

| HTTP | Path | operationId | Описание из спецификации |
|---|---|---|---|
| `PUT` | `/pin/album` | `pin_album` | Закрепление альбома. |
| `DELETE` | `/pin/album` | `unpin_album` | Открепление альбома. |
| `PUT` | `/pin/artist` | `pin_artist` | Закрепление артиста. |
| `DELETE` | `/pin/artist` | `unpin_artist` | Открепление артиста. |
| `PUT` | `/pin/playlist` | `pin_playlist` | Закрепление плейлиста. |
| `DELETE` | `/pin/playlist` | `unpin_playlist` | Открепление плейлиста. |
| `PUT` | `/pin/wave` | `pin_wave` | Закрепление волны. |
| `DELETE` | `/pin/wave` | `unpin_wave` | Открепление волны. |
| `GET` | `/pins` | `pins` | Получение списка закреплённых элементов. |

### История прослушивания (2)

| HTTP | Path | operationId | Описание из спецификации |
|---|---|---|---|
| `GET` | `/music-history` | `music_history` | Получение истории прослушивания. |
| `POST` | `/music-history/items` | `music_history_items` | Получение элементов истории прослушивания по списку идентификаторов. |

### Концерты (6)

| HTTP | Path | operationId | Описание из спецификации |
|---|---|---|---|
| `GET` | `/artists/{artist_id}/concerts` | `artists_concerts` | Получение концертов артиста. |
| `GET` | `/concerts/feed` | `concerts_feed` | Получение ленты концертов. |
| `GET` | `/concerts/locations` | `concerts_locations` | Получение списка местоположений для фильтрации концертов. |
| `GET` | `/concerts/tab-config` | `concerts_tab_config` | Получение конфигурации вкладок концертов. |
| `GET` | `/concerts/{concert_id}/info` | `concert_info` | Получение информации о концерте. |
| `GET` | `/concerts/{concert_id}/skeletons/concert_page` | `concert_skeleton` | Получение скелетона страницы концерта. |

### Лайки и дизлайки (21)

| HTTP | Path | operationId | Описание из спецификации |
|---|---|---|---|
| `GET` | `/users/{user_id}/dislikes/artists` | `users_dislikes_artists` | Получение исполнителей с отметкой "Не рекомендовать". |
| `POST` | `/users/{user_id}/dislikes/artists/add-multiple` | `users_dislikes_artists_add` | Поставить отметку "Не рекомендовать" исполнителю. |
| `POST` | `/users/{user_id}/dislikes/artists/remove` | `users_dislikes_artists_remove` | Снять отметку "Не рекомендовать" у исполнителя. |
| `GET` | `/users/{user_id}/dislikes/tracks` | `users_dislikes_tracks` | Получение треков с отметкой "Не рекомендовать". |
| `POST` | `/users/{user_id}/dislikes/tracks/add-multiple` | `users_dislikes_tracks_add` | Поставить отметку "Не рекомендовать" треку/трекам. |
| `POST` | `/users/{user_id}/dislikes/tracks/remove` | `users_dislikes_tracks_remove` | Снять отметку "Не рекомендовать" у трека/треков. |
| `GET` | `/users/{user_id}/likes/albums` | `users_likes_albums` | Получение альбомов с отметкой "Мне нравится". |
| `POST` | `/users/{user_id}/likes/albums/add-multiple` | `users_likes_albums_add` | Поставить отметку "Мне нравится" альбому/альбомам. |
| `POST` | `/users/{user_id}/likes/albums/remove` | `users_likes_albums_remove` | Снять отметку "Мне нравится" у альбома/альбомов. |
| `GET` | `/users/{user_id}/likes/artists` | `users_likes_artists` | Получение артистов с отметкой "Мне нравится". |
| `POST` | `/users/{user_id}/likes/artists/add-multiple` | `users_likes_artists_add` | Поставить отметку "Мне нравится" исполнителю/исполнителям. |
| `POST` | `/users/{user_id}/likes/artists/remove` | `users_likes_artists_remove` | Снять отметку "Мне нравится" у исполнителя/исполнителей. |
| `GET` | `/users/{user_id}/likes/clips` | `users_likes_clips` | Получение клипов с отметкой "Мне нравится". |
| `POST` | `/users/{user_id}/likes/clips/add` | `users_likes_clips_add` | Поставить отметку "Мне нравится" клипу. |
| `POST` | `/users/{user_id}/likes/clips/{clip_id}/remove` | `users_likes_clips_remove` | Снять отметку "Мне нравится" у клипа. |
| `GET` | `/users/{user_id}/likes/playlists` | `users_likes_playlists` | Получение плейлистов с отметкой "Мне нравится". |
| `POST` | `/users/{user_id}/likes/playlists/add-multiple` | `users_likes_playlists_add` | Поставить отметку "Мне нравится" плейлисту/плейлистам. |
| `POST` | `/users/{user_id}/likes/playlists/remove` | `users_likes_playlists_remove` | Снять отметку "Мне нравится" у плейлиста/плейлистов. |
| `GET` | `/users/{user_id}/likes/tracks` | `users_likes_tracks` | Получение треков с отметкой "Мне нравится". |
| `POST` | `/users/{user_id}/likes/tracks/add-multiple` | `users_likes_tracks_add` | Поставить отметку "Мне нравится" треку/трекам. |
| `POST` | `/users/{user_id}/likes/tracks/remove` | `users_likes_tracks_remove` | Снять отметку "Мне нравится" у трека/треков. |

### Лейблы (3)

| HTTP | Path | operationId | Описание из спецификации |
|---|---|---|---|
| `GET` | `/labels/{label_id}` | `label` | Получение информации о лейбле. |
| `GET` | `/labels/{label_id}/albums` | `label_albums` | Получение альбомов лейбла. |
| `GET` | `/labels/{label_id}/artists` | `label_artists` | Получение артистов лейбла. |

### Лендинг и фид (9)

| HTTP | Path | operationId | Описание из спецификации |
|---|---|---|---|
| `GET` | `/feed` | `feed` | Получение потока информации (фида) подобранного под пользователя. Содержит умные плейлисты. |
| `GET` | `/feed/wizard/is-passed` | `feed_wizard_is_passed` | Получение информации о прохождении визарда. |
| `GET` | `/genres` | `genres` | Получение жанров музыки. |
| `GET` | `/landing3` | `landing` | Получение лендинг-страницы содержащий блоки с новыми релизами, чартами, плейлистами с новинками и т.д. |
| `GET` | `/landing3/chart` | `chart` | Получение чарта. |
| `GET` | `/landing3/new-playlists` | `new_playlists` | Получение полного списка всех новых плейлистов. |
| `GET` | `/landing3/new-releases` | `new_releases` | Получение полного списка всех новых релизов (альбомов). |
| `GET` | `/landing3/podcasts` | `podcasts` | Получение подкастов с лендинга. |
| `GET` | `/tags/{tag_id}/playlist-ids` | `tags` | Получение тега (подборки). |

### Метатеги (5)

| HTTP | Path | operationId | Описание из спецификации |
|---|---|---|---|
| `GET` | `/landing3/metatags` | `metatags` | Получение дерева метатегов. |
| `GET` | `/metatags/{metatag_id}` | `metatag` | Получение информации о метатеге. |
| `GET` | `/metatags/{metatag_id}/albums` | `metatag_albums` | Получение альбомов метатега. |
| `GET` | `/metatags/{metatag_id}/artists` | `metatag_artists` | Получение артистов метатега. |
| `GET` | `/metatags/{metatag_id}/playlists` | `metatag_playlists` | Получение плейлистов метатега. |

### Очередь (4)

| HTTP | Path | operationId | Описание из спецификации |
|---|---|---|---|
| `POST` | `/queues` | `queue_create` | Создание новой очереди треков. |
| `GET` | `/queues` | `queues_list` | Получение всех очередей треков с разных устройств для синхронизации между ними. |
| `GET` | `/queues/{queue_id}` | `queue` | Получение информации об очереди треков и самих треков в ней. |
| `POST` | `/queues/{queue_id}/update-position` | `queue_update_position` | Установка текущего индекса проигрываемого трека в очереди треков. |

### Плейлисты (18)

| HTTP | Path | operationId | Описание из спецификации |
|---|---|---|---|
| `GET` | `/playlist/{playlist_uuid}` | `playlist` | Получение плейлиста по его UUID. |
| `GET` | `/playlist/{playlist_uuid}/similar-entities` | `playlist_similar_entities` | Получение похожих сущностей для плейлиста. |
| `GET` | `/playlists` | `playlists` | Получение списка плейлистов по идентификаторам. |
| `POST` | `/playlists/collective/join` | `playlists_collective_join` | Присоединение к плейлисту как соавтор. |
| `POST` | `/playlists/list` | `playlists_list` | Получение плейлиста/плейлистов. |
| `GET` | `/playlists/personal/{playlist_id}` | `playlists_personal` | Получение персонального плейлиста. |
| `POST` | `/users/{user_id}/playlists` | `users_playlists` | Получение плейлиста или списка плейлистов по уникальным идентификаторам. |
| `POST` | `/users/{user_id}/playlists/create` | `users_playlists_create` | Создание плейлиста. |
| `GET` | `/users/{user_id}/playlists/list` | `users_playlists_list` | Получение списка плейлистов пользователя. |
| `GET` | `/users/{user_id}/playlists/list/kinds` | `users_playlists_kinds` | Получение списка идентификаторов (kind) плейлистов пользователя. |
| `POST` | `/users/{user_id}/playlists/{kind}/change` | `users_playlists_change` | Изменение плейлиста. |
| `POST` | `/users/{user_id}/playlists/{kind}/delete` | `users_playlists_delete` | Удаление плейлиста. |
| `POST` | `/users/{user_id}/playlists/{kind}/description` | `users_playlists_description` | Изменение описания плейлиста. |
| `POST` | `/users/{user_id}/playlists/{kind}/name` | `users_playlists_name` | Изменение названия плейлиста. |
| `GET` | `/users/{user_id}/playlists/{kind}/recommendations` | `users_playlists_recommendations` | Получение рекомендаций для плейлиста. |
| `GET` | `/users/{user_id}/playlists/{kind}/trailer` | `users_playlists_trailer` | Получение трейлера плейлиста. |
| `POST` | `/users/{user_id}/playlists/{kind}/visibility` | `users_playlists_visibility` | Изменение видимости плейлиста. |
| `GET` | `/users/{user_id}/settings` | `users_settings` | Получение настроек пользователя. |

### Поиск (2)

| HTTP | Path | operationId | Описание из спецификации |
|---|---|---|---|
| `GET` | `/search` | `search` | Осуществление поиска по запросу и типу, получение результатов. |
| `GET` | `/search/suggest` | `search_suggest` | Получение подсказок по введенной части поискового запроса. |

### Предсохранения (3)

| HTTP | Path | operationId | Описание из спецификации |
|---|---|---|---|
| `GET` | `/users/{user_id}/presaves` | `users_presaves` | Получение списка предсохранённых альбомов. |
| `POST` | `/users/{user_id}/presaves/add` | `users_presaves_add` | Предсохранение альбома. |
| `POST` | `/users/{user_id}/presaves/remove` | `users_presaves_remove` | Удаление предсохранения альбома. |

### Радио (8)

| HTTP | Path | operationId | Описание из спецификации |
|---|---|---|---|
| `GET` | `/rotor/account/status` | `rotor_account_status` | Получение статуса пользователя с дополнительными полями. |
| `POST` | `/rotor/station/{station}/feedback` | `rotor_station_feedback` | Отправка обратной связи на действия при прослушивании радио. |
| `GET` | `/rotor/station/{station}/info` | `rotor_station_info` | Получение информации о станции и пользовательских настроек на неё. |
| `POST` | `/rotor/station/{station}/settings3` | `rotor_station_settings2` | Изменение настроек определённой станции. |
| `GET` | `/rotor/station/{station}/stream` | `rotor_station_stream` | Получение информации о генеративной станции и её потока. |
| `GET` | `/rotor/station/{station}/tracks` | `rotor_station_tracks` | Получение цепочки треков определённой станции. |
| `GET` | `/rotor/stations/dashboard` | `rotor_stations_dashboard` | Получение рекомендованных станций текущего пользователя. |
| `GET` | `/rotor/stations/list` | `rotor_stations_list` | Получение всех радиостанций с настройками пользователя. |

### Сессии радио (9)

| HTTP | Path | operationId | Описание из спецификации |
|---|---|---|---|
| `POST` | `/rotor/combined/session/landing` | `rotor_combined_session_landing` | Получение витрины комбинированной сессии радио (например, «Время клипов»). |
| `POST` | `/rotor/combined/session/new` | `rotor_combined_session_new` | Создание комбинированной сессии радио (треки и клипы). |
| `POST` | `/rotor/combined/session/{session_id}/next` | `rotor_combined_session_next` | Получение следующих элементов комбинированной сессии радио. |
| `POST` | `/rotor/session/new` | `rotor_session_new` | Создание новой сессии радио. |
| `POST` | `/rotor/session/{radio_session_id}/clone` | `rotor_session_clone` | Создание новой сессии радио на основе существующей (с теми же сидами). |
| `POST` | `/rotor/session/{radio_session_id}/feedback` | `rotor_session_feedback` | Отправка обратной связи сессии радио. |
| `POST` | `/rotor/session/{radio_session_id}/feedbacks` | `rotor_session_feedbacks` | Отправка нескольких событий обратной связи сессии радио одним запросом. |
| `POST` | `/rotor/session/{radio_session_id}/tracks` | `rotor_session_tracks` | Получение следующей партии треков сессии радио. |
| `POST` | `/rotor/sessions/feedbacks` | `rotor_sessions_feedbacks` | Отправка обратной связи сразу по нескольким сессиям радио. |

### Треки (10)

| HTTP | Path | operationId | Описание из спецификации |
|---|---|---|---|
| `GET` | `/after-track` | `after_track` | Получение рекламы или шота от Алисы после трека. |
| `GET` | `/get-file-info` | `tracks_file_info` | Получение информации о файле трека, в том числе в lossless качестве. |
| `POST` | `/play-audio` | `play_audio` | Метод для отправки текущего состояния прослушиваемого трека. |
| `POST` | `/tracks` | `tracks` | Получение трека/треков. |
| `GET` | `/tracks/{track_id}/download-info` | `tracks_download_info` | Получение информации о доступных вариантах загрузки трека. |
| `GET` | `/tracks/{track_id}/full-info` | `tracks_full_info` | Получение полной информации о треке. |
| `GET` | `/tracks/{track_id}/lyrics` | `tracks_lyrics` | Получение текста трека. |
| `GET` | `/tracks/{track_id}/similar` | `tracks_similar` | Получение похожих треков. |
| `GET` | `/tracks/{track_id}/supplement` | `track_supplement` | Получение дополнительной информации о треке. |
| `GET` | `/tracks/{track_id}/trailer` | `tracks_trailer` | Получение трейлера трека. |

## Практические оговорки

- В этой таблице перечислены все операции именно этого pinned OpenAPI snapshot; это не полный инвентарь всех private/mobile/web запросов самого приложения Яндекс Музыки.
- Library reads/writes и OAuth ручки в этой спецификации изучены статически. Live проверки проекта покрывают только `account/status`, likes read, `POST /tracks` для metadata и no-auth `/search`; пользовательские лайки/плейлисты не изменялись.
- В snapshot server — `https://api.music.yandex.net`; ранее наблюдённые user-library браузерные и terminal routes шли на `https://api.music.yandex.ru`. В read-only no-auth проверке 27.10.2026 `/search` вернул `200 application/json` на обоих hostnames. Это не доказывает взаимозаменяемость всех endpoint/региональных hostnames.
- Перед реализацией снова сравнивать путь, auth, content type, параметры и схемы с pinned spec и исходниками конкретной версии. Не пробовать mutating operations без заранее выбранного тестового объекта и write-authorization.
