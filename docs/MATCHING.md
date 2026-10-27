# Сопоставление треков между сервисами

Срез источников: 27.10.2026. Цель — выбрать запись Apple Music того же трека, а не просто первое совпадение по названию. Источник предоставляет metadata и service-specific IDs, а не переносимый аудиофайл.

## Доступные данные по лайкам

| Источник / путь | Что содержит ссылка на лайк | Где получить metadata | ISRC по проверенному контракту | Уровень доказательности |
|---|---|---|---|---|
| Spotify Official Web API: `GET /v1/me/tracks` | `added_at` + Spotify Track object; сохранять порядок/время и URI отдельно | Track object в ответе | `external_ids.isrc` документирован; поле удаления из февральского изменения было отменено в марте 2026 | Official docs; этот authenticated OAuth flow в проекте пока не запускался |
| Spotify Web Player private GraphQL: `fetchPlaylistContents` | `addedAt` + item/track object; страницы `limit`/`offset` | Встроенный объект трека | Стабильного публичного обещания нет; проверять конкретный selection/ответ. Не требовать от приватного пути поля ISRC | Live read + clean terminal replay и полный offset sweep ранее дали 200; private route может поменяться |
| Яндекс Музыка: `GET /users/{uid}/likes/tracks` | `TrackShort {id, album_id, timestamp}`; составной `track_id` клиента — `id:album_id`, если album ID задан | `POST /tracks` с form-urlencoded `track-ids` | Полная модель `Track` community-клиента имеет optional `isrc`, но 5/5 свежих публичных `POST /tracks` карточек пришли без этого поля | Likes endpoint ранее проверен с пользовательской сессией; schema статическая, текущий no-auth catalog sample — clean terminal `200`, пять результатов |
| Звук: cursor GraphQL `getPaginatedCollection` | Track object, `page.endCursor`; короткий community `userTracks` отдаёт `id` + `lastModified` | `getTracks(ids)` / `getFullTrack` GraphQL | В просмотренных `getPaginatedCollection`/`getTracks` query documents ISRC не запрашивается. Это не доказывает, что поле отсутствует в схеме сервера | Chrome + terminal read-only routes проверены; поля сверены со сторонними GraphQL documents |
| Apple Music Catalog | Catalog song ID, `name`, `artistName`, `albumName`, `durationInMillis`, `releaseDate`, `inFavorites` (когда доступно) | `GET /v1/catalog/{storefront}/songs?filter[isrc]=...` либо текстовый `/search` | Catalog Songs attributes документируют `isrc`; endpoint принимает до 25 ISRC за запрос, один ISRC может вернуть несколько песен | Official docs; live REST с нашим developer token не запускался |
| iTunes Search API (no-auth fallback) | `trackId`, название/артист/альбом/длительность в проверенном ответе | `GET https://itunes.apple.com/search?term=...&media=music&entity=song` | ISRC отсутствовал в исследованном sample; `trackId` нельзя без проверки считать Apple Music Catalog ID | Clean terminal read-only `200`; отдельный образец не является гарантией всех результатов |

## Практический алгоритм

1. **Сохранить исходную запись без потерь.** Для каждого liked item хранить локально source ID/URI, source timestamp или позицию, исходное название, исполнителей, альбом, длительность, storefront/market и исходный payload только на устройстве. Эти поля нужны для восстановления порядка и объяснения матча; не выводить их в логи по умолчанию.
2. **Сначала искать Apple Catalog по ISRC.** Если источник действительно предоставил ISRC, вызывать `filter[isrc]`, группируя не более 25 кодов. ISRC подтверждает запись, но не гарантирует единственный catalog result или правильный доступный storefront.
3. **Проверять кандидата по нескольким признакам.** Сравнить исполнителя (включая featured artists), название, длительность, альбом, год/дату и version markers: live, remix, remaster, acoustic, clean/explicit, sped-up/slowed. Различия издания и названия могут быть законными; сомнительный результат должен идти на ручной review.
4. **Если ISRC нет — использовать текстовый поиск как генератор кандидатов.** Нормализовать регистр, Unicode/диакритику, пунктуацию и безопасные feat-префиксы, но отдельно сохранять оригинал. Ранжировать по artist/title, затем длительности и альбому; одно совпадение по title или популярность/первый результат не считать достаточными для автоматической записи.
5. **Разделять состояния.** В отчёте держать `exact_isrc`, `strong_text`, `ambiguous`, `not_found`, `already_favorite`. Показывать источник, Apple-кандидата и причины уверенности; пользователь подтверждает ambiguous и слабые совпадения.
6. **Записывать и проверять целевой список отдельно.** Дедуплицировать по Apple catalog ID, применять Favorite write только после подтверждения, затем читать Favorite Songs обратно и сверять source → accepted candidate → actual favorite. Повторный запуск должен пропускать уже избранное и возобновляться без потери позиции.

## Что пока не доказано

- ISRC присутствует не у каждого source track и может отсутствовать в Spotify Web Player/Звук private response.
- У Звука в просмотренных GraphQL operations поле ISRC не запрашивается; возможность добавить его в query и наличие в GraphQL schema не проверены.
- Yandex full `Track` model содержит ISRC, но для каждого трека live completeness не подсчитывали.
- Apple text-search sample не содержал ISRC, а `trackId` из iTunes Search ещё не использовался для Favorite write.
- Сопоставление на реальной представительной выборке не выполнялось; пользовательские track names/IDs и статистика коллекций в Git не сохранялись.
- Разрешение на запись в Favorite Songs требуется проверять отдельно от read-only API-исследования.

## Источники

- Spotify [Get User's Saved Tracks](https://developer.spotify.com/documentation/web-api/reference/get-users-saved-tracks), [Get Track](https://developer.spotify.com/documentation/web-api/reference/get-track), [February 2026 changelog](https://developer.spotify.com/documentation/web-api/references/changes/february-2026), [March 2026 correction](https://developer.spotify.com/documentation/web-api/references/changes/march-2026).
- Yandex pinned [`TrackShort`](https://github.com/MarshalX/yandex-music-api/blob/9ca132e5c18a72aab779c1fc68c169380a9357d0/yandex_music/track_short.py), [`Track`](https://github.com/MarshalX/yandex-music-api/blob/9ca132e5c18a72aab779c1fc68c169380a9357d0/yandex_music/track/track.py), [`TracksList`](https://github.com/MarshalX/yandex-music-api/blob/9ca132e5c18a72aab779c1fc68c169380a9357d0/yandex_music/tracks_list.py).
- Zvuk pinned [`getPaginatedCollection`](https://github.com/korenskoy/zvuk-swift/blob/8245d4e39abe93739cc0c01249a6e8a460fe5cb3/Sources/ZvukMusic/Resources/Queries/getPaginatedCollection.graphql), [`getTracks`](https://github.com/korenskoy/zvuk-swift/blob/8245d4e39abe93739cc0c01249a6e8a460fe5cb3/Sources/ZvukMusic/Resources/Queries/getTracks.graphql), [`Track` model](https://github.com/korenskoy/zvuk-swift/blob/8245d4e39abe93739cc0c01249a6e8a460fe5cb3/Sources/ZvukMusic/Models/Track.swift).
- Apple [`Songs.Attributes`](https://developer.apple.com/documentation/applemusicapi/songs/attributes-data.dictionary), [`Get Multiple Catalog Songs by ISRC`](https://developer.apple.com/documentation/applemusicapi/get-multiple-catalog-songs-by-isrc), [iTunes Search examples](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/SearchExamples.html).
- Project live/static evidence: [API matrix](API_MATRIX.md), [Spotify](providers/spotify.md), [Yandex Music](providers/yandex-music.md), [Zvuk](providers/zvuk.md), [Apple Music](providers/apple-music.md).
