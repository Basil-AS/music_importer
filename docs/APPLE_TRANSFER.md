# Apple Music target adapter

Status: experimental implementation; fixture-tested, not live-verified against an account.

## Intended flow

1. The user opens Apple Music in Chrome and the unpacked extension attaches to the tab.
2. Search runs against the selected Apple catalog storefront from the Apple page context. The UI retains Apple catalog song IDs; it does not use iTunes Store IDs for account writes.
3. The user reviews matches and confirms the transfer. A complete source snapshot is required before any account mutation.
4. Favorites are added in batches. Playlists are created as private, then ordered track batches are appended. The adapter reads favorites and playlist tracks back and reports success only after IDs, counts, and order match.

## API operations

- Catalog metadata search: `GET /v1/catalog/{storefront}/search?term=…&types=songs&limit=25`.
- Exact catalog lookup: `GET /v1/catalog/{storefront}/songs?filter[isrc]={isrc}` when the source track has a valid ISRC; if Apple returns no exact match, the adapter falls back to title/artist search. Apple documents this route in [Get Multiple Catalog Songs by ISRC](https://developer.apple.com/documentation/applemusicapi/get-multiple-catalog-songs-by-isrc); a single ISRC can still return multiple catalog songs.
- Favorites: `POST /v1/me/favorites?ids[songs]=…`.
- Create playlist: `POST /v1/me/library/playlists` with `attributes.name` and `attributes.isPublic=false`.
- Append playlist songs: `POST /v1/me/library/playlists/{id}/tracks` with `{ "data": [{ "id": "catalog-song-id", "type": "songs" }] }`.
- Read-back uses paginated `/v1/me/library/songs` (`attributes.inFavorites`) and `/v1/me/library/playlists/{id}/tracks`.

Apple documents these endpoints and requires a Music User Token for personal-library requests. Apple Music on the Web manages its own user token automatically. Research found that the first-party page may spell the header `Media-User-Token`, while Apple's public REST documentation spells it `Music-User-Token`; the adapter recognizes either spelling and sends it back under the same name used by the active page session. It temporarily keeps session headers in a private JavaScript closure. The local UI, extension storage, and local server never receive those headers. Using Apple Music's first-party page as the transport is still an implementation dependency: Apple can change the page's request setup or block cross-context calls, and this is not a standalone third-party OAuth flow.

Official references:

- [User Authentication for MusicKit](https://developer.apple.com/documentation/applemusicapi/user-authentication-for-musickit)
- [Add resource to favorites](https://developer.apple.com/documentation/applemusicapi/add-resource-to-favorites)
- [Create a New Library Playlist](https://developer.apple.com/documentation/applemusicapi/create-a-new-library-playlist)
- [Add Tracks to a Library Playlist](https://developer.apple.com/documentation/applemusicapi/add-tracks-to-a-library-playlist)

## Limits before calling it usable

- The current Chrome installation did not answer the local extension handshake. Reloading the unpacked extension, allowing it on the local app origin, and reloading Apple Music are required before a live check.
- Fixture tests cannot establish Apple account eligibility, actual favorite propagation delay, browser CORS behavior, or whether all catalog IDs resolve identically in the user's storefront.
- Apple returns `202 Accepted` for favorite writes. The adapter polls library read-back and fails closed if it cannot see every requested favorite.
- Playlist creation followed by a later failure can leave a partial playlist. A retry can create another playlist; persistent idempotency/recovery is not implemented yet.
- No real account write has been attempted by this project.
