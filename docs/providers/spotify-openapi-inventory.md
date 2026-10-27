# Spotify Web API: официальный OpenAPI inventory

Снимок построен 27.10.2026 из официальной машинно-читаемой спецификации Spotify. Это статический каталог контракта; он не доказывает фактическую доступность маршрута для каждого режима приложения.

- Источник: [Spotify OpenAPI YAML](https://developer.spotify.com/reference/web-api/open-api-schema.yaml), [гайд Spotify по OpenAPI](https://developer.spotify.com/documentation/web-api/tutorials/building-with-ai).
- OpenAPI: `3.0.3`; server: `https://api.spotify.com/v1`.
- SHA-256 исходного YAML: `2d888d731358ae8a97126ffd4117d257305943f06721734abe9af24962bf38c3`.
- 70 path templates, 96 operations, 48 operations marked deprecated.
- Группы: `Albums` 8; `Artists` 5; `Audiobooks` 7; `Categories` 2; `Chapters` 2; `Episodes` 6; `Genres` 1; `Library` 3; `Markets` 1; `Player` 15; `Playlists` 18; `Search` 1; `Shows` 7; `Tracks` 10; `Users` 10.

## Авторизация и лайки

- Схема описывает OAuth 2.0 Authorization Code (`https://accounts.spotify.com/authorize`, `https://accounts.spotify.com/api/token`). Для локального приложения без секрета использовать документированный Authorization Code with PKCE; scope `user-library-read` нужен для чтения saved tracks.
- `GET /me/tracks` остаётся документированным чтением сохранённых треков, с `limit`/`offset` и `next`; текущий Development Mode миграционный гид указывает новые ограничения и изменения записи. Новые универсальные операции: `PUT/DELETE /me/library?uris=...` и `GET /me/library/contains`; запись ограничена 40 URI на запрос.
- `GET /search` требует OAuth в схеме (scope list пустой), limit максимум 10, default 5; в Development Mode пакетный `GET /tracks?ids=...` удалён. Сверять маршруты и поля с [гайдом миграции февраля 2026](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide), который является источником текущих ограничений.
- Поле `deprecated` отражает OpenAPI-флаг. Оно не является датой удаления и не означает, что операция работает в новом Development Mode; часть старых операций оставлена для совместимости/Extended Quota Mode.

## Все операции

| Метод | Путь | Операция | OAuth scopes | OpenAPI |
|---|---|---|---|---|
| `GET` | `/albums` | Get Several Albums (`get-multiple-albums`) | OAuth; scope list пустой | deprecated |
| `GET` | `/albums/{id}` | Get Album (`get-an-album`) | OAuth; scope list пустой | current |
| `GET` | `/albums/{id}/tracks` | Get Album Tracks (`get-an-albums-tracks`) | OAuth; scope list пустой | current |
| `GET` | `/browse/new-releases` | Get New Releases (`get-new-releases`) | OAuth; scope list пустой | deprecated |
| `DELETE` | `/me/albums` | Remove Users' Saved Albums (`remove-albums-user`) | `user-library-modify` | deprecated |
| `GET` | `/me/albums` | Get User's Saved Albums (`get-users-saved-albums`) | `user-library-read` | current |
| `PUT` | `/me/albums` | Save Albums for Current User (`save-albums-user`) | `user-library-modify` | deprecated |
| `GET` | `/me/albums/contains` | Check User's Saved Albums (`check-users-saved-albums`) | `user-library-read` | deprecated |
| `GET` | `/artists` | Get Several Artists (`get-multiple-artists`) | OAuth; scope list пустой | deprecated |
| `GET` | `/artists/{id}` | Get Artist (`get-an-artist`) | OAuth; scope list пустой | current |
| `GET` | `/artists/{id}/albums` | Get Artist's Albums (`get-an-artists-albums`) | OAuth; scope list пустой | current |
| `GET` | `/artists/{id}/related-artists` | Get Artist's Related Artists (`get-an-artists-related-artists`) | OAuth; scope list пустой | deprecated |
| `GET` | `/artists/{id}/top-tracks` | Get Artist's Top Tracks (`get-an-artists-top-tracks`) | OAuth; scope list пустой | deprecated |
| `GET` | `/audiobooks` | Get Several Audiobooks (`get-multiple-audiobooks`) | OAuth; scope list пустой | deprecated |
| `GET` | `/audiobooks/{id}` | Get an Audiobook (`get-an-audiobook`) | OAuth; scope list пустой | current |
| `GET` | `/audiobooks/{id}/chapters` | Get Audiobook Chapters (`get-audiobook-chapters`) | OAuth; scope list пустой | current |
| `DELETE` | `/me/audiobooks` | Remove User's Saved Audiobooks (`remove-audiobooks-user`) | `user-library-modify` | deprecated |
| `GET` | `/me/audiobooks` | Get User's Saved Audiobooks (`get-users-saved-audiobooks`) | `user-library-read` | current |
| `PUT` | `/me/audiobooks` | Save Audiobooks for Current User (`save-audiobooks-user`) | `user-library-modify` | deprecated |
| `GET` | `/me/audiobooks/contains` | Check User's Saved Audiobooks (`check-users-saved-audiobooks`) | `user-library-read` | deprecated |
| `GET` | `/browse/categories` | Get Several Browse Categories (`get-categories`) | OAuth; scope list пустой | deprecated |
| `GET` | `/browse/categories/{category_id}` | Get Single Browse Category (`get-a-category`) | OAuth; scope list пустой | deprecated |
| `GET` | `/chapters` | Get Several Chapters (`get-several-chapters`) | OAuth; scope list пустой | deprecated |
| `GET` | `/chapters/{id}` | Get a Chapter (`get-a-chapter`) | OAuth; scope list пустой | current |
| `GET` | `/episodes` | Get Several Episodes (`get-multiple-episodes`) | `user-read-playback-position` | deprecated |
| `GET` | `/episodes/{id}` | Get Episode (`get-an-episode`) | `user-read-playback-position` | current |
| `DELETE` | `/me/episodes` | Remove User's Saved Episodes (`remove-episodes-user`) | `user-library-modify` | deprecated |
| `GET` | `/me/episodes` | Get User's Saved Episodes (`get-users-saved-episodes`) | `user-library-read`, `user-read-playback-position` | current |
| `PUT` | `/me/episodes` | Save Episodes for Current User (`save-episodes-user`) | `user-library-modify` | deprecated |
| `GET` | `/me/episodes/contains` | Check User's Saved Episodes (`check-users-saved-episodes`) | `user-library-read` | deprecated |
| `GET` | `/recommendations/available-genre-seeds` | Get Available Genre Seeds (`get-recommendation-genres`) | OAuth; scope list пустой | deprecated |
| `DELETE` | `/me/library` | Remove Items from Library (`remove-library-items`) | `user-library-modify`, `user-follow-modify`, `playlist-modify-public` | current |
| `PUT` | `/me/library` | Save Items to Library (`save-library-items`) | `user-library-modify`, `user-follow-modify`, `playlist-modify-public` | current |
| `GET` | `/me/library/contains` | Check User's Saved Items (`check-library-contains`) | `user-library-read`, `user-follow-read`, `playlist-read-private` | current |
| `GET` | `/markets` | Get Available Markets (`get-available-markets`) | OAuth; scope list пустой | deprecated |
| `GET` | `/me/player` | Get Playback State (`get-information-about-the-users-current-playback`) | `user-read-playback-state` | current |
| `PUT` | `/me/player` | Transfer Playback (`transfer-a-users-playback`) | `user-modify-playback-state` | current |
| `GET` | `/me/player/currently-playing` | Get Currently Playing Track (`get-the-users-currently-playing-track`) | `user-read-currently-playing` | current |
| `GET` | `/me/player/devices` | Get Available Devices (`get-a-users-available-devices`) | `user-read-playback-state` | current |
| `POST` | `/me/player/next` | Skip To Next (`skip-users-playback-to-next-track`) | `user-modify-playback-state` | current |
| `PUT` | `/me/player/pause` | Pause Playback (`pause-a-users-playback`) | `user-modify-playback-state` | current |
| `PUT` | `/me/player/play` | Start/Resume Playback (`start-a-users-playback`) | `user-modify-playback-state` | current |
| `POST` | `/me/player/previous` | Skip To Previous (`skip-users-playback-to-previous-track`) | `user-modify-playback-state` | current |
| `GET` | `/me/player/queue` | Get the User's Queue (`get-queue`) | `user-read-currently-playing`, `user-read-playback-state` | current |
| `POST` | `/me/player/queue` | Add Item to Playback Queue (`add-to-queue`) | `user-modify-playback-state` | current |
| `GET` | `/me/player/recently-played` | Get Recently Played Tracks (`get-recently-played`) | `user-read-recently-played` | current |
| `PUT` | `/me/player/repeat` | Set Repeat Mode (`set-repeat-mode-on-users-playback`) | `user-modify-playback-state` | current |
| `PUT` | `/me/player/seek` | Seek To Position (`seek-to-position-in-currently-playing-track`) | `user-modify-playback-state` | current |
| `PUT` | `/me/player/shuffle` | Toggle Playback Shuffle (`toggle-shuffle-for-users-playback`) | `user-modify-playback-state` | current |
| `PUT` | `/me/player/volume` | Set Playback Volume (`set-volume-for-users-playback`) | `user-modify-playback-state` | current |
| `GET` | `/browse/categories/{category_id}/playlists` | Get Category's Playlists (`get-a-categories-playlists`) | OAuth; scope list пустой | deprecated |
| `GET` | `/browse/featured-playlists` | Get Featured Playlists (`get-featured-playlists`) | OAuth; scope list пустой | deprecated |
| `GET` | `/me/playlists` | Get Current User's Playlists (`get-a-list-of-current-users-playlists`) | `playlist-read-private` | current |
| `POST` | `/me/playlists` | Create Playlist (`create-playlist`) | `playlist-modify-public`, `playlist-modify-private` | current |
| `GET` | `/playlists/{playlist_id}` | Get Playlist (`get-playlist`) | OAuth; scope list пустой | current |
| `PUT` | `/playlists/{playlist_id}` | Change Playlist Details (`change-playlist-details`) | `playlist-modify-public`, `playlist-modify-private` | current |
| `GET` | `/playlists/{playlist_id}/images` | Get Playlist Cover Image (`get-playlist-cover`) | OAuth; scope list пустой | current |
| `PUT` | `/playlists/{playlist_id}/images` | Add Custom Playlist Cover Image (`upload-custom-playlist-cover`) | `ugc-image-upload`, `playlist-modify-public`, `playlist-modify-private` | current |
| `DELETE` | `/playlists/{playlist_id}/items` | Remove Playlist Items (`remove-items-playlist`) | `playlist-modify-public`, `playlist-modify-private` | current |
| `GET` | `/playlists/{playlist_id}/items` | Get Playlist Items (`get-playlists-items`) | `playlist-read-private` | current |
| `POST` | `/playlists/{playlist_id}/items` | Add Items to Playlist (`add-items-to-playlist`) | `playlist-modify-public`, `playlist-modify-private` | current |
| `PUT` | `/playlists/{playlist_id}/items` | Update Playlist Items (`reorder-or-replace-playlists-items`) | `playlist-modify-public`, `playlist-modify-private` | current |
| `DELETE` | `/playlists/{playlist_id}/tracks` | Remove Playlist Items [DEPRECATED] (`remove-tracks-playlist`) | `playlist-modify-public`, `playlist-modify-private` | deprecated |
| `GET` | `/playlists/{playlist_id}/tracks` | Get Playlist Items [DEPRECATED] (`get-playlists-tracks`) | `playlist-read-private` | deprecated |
| `POST` | `/playlists/{playlist_id}/tracks` | Add Items to Playlist [DEPRECATED] (`add-tracks-to-playlist`) | `playlist-modify-public`, `playlist-modify-private` | deprecated |
| `PUT` | `/playlists/{playlist_id}/tracks` | Update Playlist Items [DEPRECATED] (`reorder-or-replace-playlists-tracks`) | `playlist-modify-public`, `playlist-modify-private` | deprecated |
| `GET` | `/users/{user_id}/playlists` | Get User's Playlists (`get-list-users-playlists`) | `playlist-read-private`, `playlist-read-collaborative` | deprecated |
| `POST` | `/users/{user_id}/playlists` | Create Playlist for user (`create-playlist-for-user`) | `playlist-modify-public`, `playlist-modify-private` | deprecated |
| `GET` | `/search` | Search for Item (`search`) | OAuth; scope list пустой | current |
| `DELETE` | `/me/shows` | Remove User's Saved Shows (`remove-shows-user`) | `user-library-modify` | deprecated |
| `GET` | `/me/shows` | Get User's Saved Shows (`get-users-saved-shows`) | `user-library-read` | current |
| `PUT` | `/me/shows` | Save Shows for Current User (`save-shows-user`) | `user-library-modify` | deprecated |
| `GET` | `/me/shows/contains` | Check User's Saved Shows (`check-users-saved-shows`) | `user-library-read` | deprecated |
| `GET` | `/shows` | Get Several Shows (`get-multiple-shows`) | OAuth; scope list пустой | deprecated |
| `GET` | `/shows/{id}` | Get Show (`get-a-show`) | `user-read-playback-position` | current |
| `GET` | `/shows/{id}/episodes` | Get Show Episodes (`get-a-shows-episodes`) | `user-read-playback-position` | current |
| `GET` | `/audio-analysis/{id}` | Get Track's Audio Analysis (`get-audio-analysis`) | OAuth; scope list пустой | deprecated |
| `GET` | `/audio-features` | Get Several Tracks' Audio Features (`get-several-audio-features`) | OAuth; scope list пустой | deprecated |
| `GET` | `/audio-features/{id}` | Get Track's Audio Features (`get-audio-features`) | OAuth; scope list пустой | deprecated |
| `DELETE` | `/me/tracks` | Remove User's Saved Tracks (`remove-tracks-user`) | `user-library-modify` | deprecated |
| `GET` | `/me/tracks` | Get User's Saved Tracks (`get-users-saved-tracks`) | `user-library-read` | current |
| `PUT` | `/me/tracks` | Save Tracks for Current User (`save-tracks-user`) | `user-library-modify` | deprecated |
| `GET` | `/me/tracks/contains` | Check User's Saved Tracks (`check-users-saved-tracks`) | `user-library-read` | deprecated |
| `GET` | `/recommendations` | Get Recommendations (`get-recommendations`) | OAuth; scope list пустой | deprecated |
| `GET` | `/tracks` | Get Several Tracks (`get-several-tracks`) | OAuth; scope list пустой | deprecated |
| `GET` | `/tracks/{id}` | Get Track (`get-track`) | OAuth; scope list пустой | current |
| `GET` | `/me` | Get Current User's Profile (`get-current-users-profile`) | `user-read-private`, `user-read-email` | current |
| `DELETE` | `/me/following` | Unfollow Artists or Users (`unfollow-artists-users`) | `user-follow-modify` | deprecated |
| `GET` | `/me/following` | Get Followed Artists (`get-followed`) | `user-follow-read` | current |
| `PUT` | `/me/following` | Follow Artists or Users (`follow-artists-users`) | `user-follow-modify` | deprecated |
| `GET` | `/me/following/contains` | Check If User Follows Artists or Users (`check-current-user-follows`) | `user-follow-read` | deprecated |
| `GET` | `/me/top/{type}` | Get User's Top Items (`get-users-top-artists-and-tracks`) | `user-top-read` | current |
| `DELETE` | `/playlists/{playlist_id}/followers` | Unfollow Playlist (`unfollow-playlist`) | `playlist-modify-public`, `playlist-modify-private` | deprecated |
| `PUT` | `/playlists/{playlist_id}/followers` | Follow Playlist (`follow-playlist`) | `playlist-modify-public`, `playlist-modify-private` | deprecated |
| `GET` | `/playlists/{playlist_id}/followers/contains` | Check if Current User Follows Playlist (`check-if-user-follows-playlist`) | OAuth; scope list пустой | deprecated |
| `GET` | `/users/{user_id}` | Get User's Profile (`get-users-profile`) | OAuth; scope list пустой | deprecated |

## Ограничения практической проверки

- В авторизованном Chrome Account Overview показывает план Premium Family, но также сообщение `Payment failed` и предупреждение о скорой потере доступа. Это не доказывает, что подписка удовлетворяет требованию активного Premium у владельца приложения.
- Spotify Developer Dashboard показал Developer Terms v10 (15.05.2025) и обязательный флажок принятия. Пользователь дал разрешение принять условия и создать минимальное приложение при Premium; стандартное взаимодействие с флажком не изменило его состояние и кнопка осталась выключена. Условия не приняты, приложение и OAuth client не созданы.
- Согласно официальному [Development Mode migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide), владелец Development Mode app должен иметь active Premium; также действует предел один Client ID на разработчика и пять пользователей приложения. С учётом ошибки оплаты условие Premium пока нельзя считать подтверждённым.
- Токены, cookies, идентификаторы аккаунта, track IDs и содержимое коллекции в этот inventory не включались. Официальный OAuth runtime test не выполнялся.

## Ссылки

- [Spotify Web API reference](https://developer.spotify.com/documentation/web-api/reference)
- [OAuth authorization](https://developer.spotify.com/documentation/web-api/concepts/authorization)
- [PKCE](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow)
- [Scopes](https://developer.spotify.com/documentation/web-api/concepts/scopes)
- [February 2026 migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)
