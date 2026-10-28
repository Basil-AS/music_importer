# Spotify as a transfer destination

## Status

The experimental writer uses the signed-in Spotify Web Player session in the open Chrome tab. It does not ask for a developer Client ID, create an OAuth app, or copy session headers out of the page. Header values remain in the page closure. The current implementation is based on the Web Player bundle inspected on 2026-10-28; Spotify can change these private operations without notice. Fixture tests cover request construction and read-back, but no live account write has been run.

## Observed operations

- Track search uses `GET https://api.spotify.com/v1/search` with the user's active Web Player authorization and `market=from_token`. When an unedited source record has a valid ISRC, it first queries `q=isrc:{code}` and falls back to title/artist if the response has no candidate returning that exact ISRC. Spotify documents `isrc` as a Search field filter in its [Search reference](https://developer.spotify.com/documentation/web-api/reference/search).
- Catalog search and album-track pages share a serialized request-start limiter with Pathfinder calls. Catalog `429` responses forward `Retry-After` to the shared bulk-search backoff; live rate limits still require measurement on the current account.
- Liked Songs are read with the existing `fetchLibraryTracks` Pathfinder query and added with `addToLibrary`, in batches of 40.
- Playlists are created with `POST https://spclient.wg.spotify.com/playlist/v2/playlist`, then inserted into the user's root list through `/playlist/v2/user/{username}/rootlist/changes`.
- Playlist items are appended through the Web Player `addToPlaylist` Pathfinder mutation, in batches of 100. The source order and repeated tracks are kept.
- The writer reads favorites and every created playlist back. It reports completion only when IDs and playlist order match the plan. A repeated run skips already-liked tracks; playlists are created anew, so retrying a partial playlist transfer can create another playlist.

## Safety and limitations

Before the write, the app requires a complete source snapshot and explicit confirmation showing the selected destination. Spotify session headers stay in the page world and are not serialized into plans, extension storage, or logs. The writer does not delete or reorder existing playlists. A failed request can leave a partially created playlist; the report marks this as a partial failure when read-back is available.

The Web Player endpoints are private and can break. HTTP errors, changed query hashes, missing user identity, unknown playlist URI shapes, or read-back mismatches fail visibly. Do not treat the current fixture coverage as proof of a live Spotify transfer. The official Spotify Web API remains the documented option for production clients, but it requires a registered app and has current Development Mode limits; this experimental connector instead follows the user's existing Web Player session.
