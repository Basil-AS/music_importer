# Experimental target writer for Zvuk

The local Chrome extension can search the signed-in Zvuk catalog and write matched favorites and playlists into the current account. The app asks for confirmation before dispatching a complete transfer plan. It keeps the user's session in the open Zvuk page; it does not read or save cookies, tokens, passwords, or authorization headers.

## Routes and reconciliation

- Catalog search uses `POST /api/v1/graphql`, operation `search`, and returns Zvuk track IDs for the matcher.
- Existing favorites are read with the first-party cursor query `getPaginatedCollection(limit, after)`. Missing likes are submitted in batches through `collection.addItems(items: [{ id, type: "track" }])`.
- New playlists use `playlist.createV1(items, name)`; additional groups of 100 tracks use `playlist.addItemsV1(id, items)`.
- The writer reads favorites through the cursor until every requested like is found or `endCursor` is empty. It keeps only the requested IDs found while scanning, not a materialized copy of the full favorites list; when every requested ID is present, it stops early. For playlists it pages `playlistTracks(id, limit, offset)` until the service returns a short page, comparing each returned batch to the expected plan prefix and then verifying exact order, including repeats. There is no project-level one-million-item cutoff; offset reads fail closed only if the JavaScript safe-integer range is exceeded. Requests and the local recovery plan remain subject to service availability and browser storage limits.
- It refuses incomplete source snapshots before sending a write. Any error after the first mutation is reported as a partial failure, since the private API offers no transaction across likes and multiple playlists.

These are private, reverse-engineered GraphQL routes, not a supported public API. Names and shapes were cross-checked against [`korenskoy/zvuk-swift`](https://github.com/korenskoy/zvuk-swift) (MIT, HEAD `8245d4e`, 2026-10-20; operation documents note Zvuk Web v8.6.2) and [`trudenboy/zvuk-music`](https://github.com/trudenboy/zvuk-music) (MIT, HEAD `ed491f6`). Those project snapshots do not guarantee that the currently deployed Web API still accepts the same mutation names. No live write has been performed; fixtures cover search, idempotent favorites, batching, playlist order/repeats, and fail-closed behavior only.

## Official import fallback

Zvuk's [official migration guide](https://help.zvuk.com/article/42207) currently supports importing selected playlists from Apple Music, Spotify, Yandex Music, VK, Deezer, and YouTube Music, using provider login or a playlist link depending on source. It creates a separate playlist and imports only tracks present in Zvuk's catalog; it does not add them to favorites. The same guide says exporting a Zvuk library is not supported. This is a useful supported fallback for playlist→Zvuk when a user accepts the service's UI, but it does not replace the writer's favorites path or any Zvuk source connector.

For a first live validation, use a disposable, complete source snapshot and a small transfer after inspecting the exact confirmation summary. Confirm the resulting likes and playlist in Zvuk before using the connector for a large library.
