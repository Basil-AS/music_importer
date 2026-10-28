# Apple Music source connector

The local Chrome extension reader handles liked songs and user playlists from the signed-in `music.apple.com` page. It uses the Apple Music Web player's own in-memory authenticated requests to the first-party `/v1/me/library` API. The observed authorization headers stay inside the page's private closure; the extension and local app receive normalized track records only. No browser storage, cookie jar, or token file is read or persisted. Fixtures cover pagination and completeness checks; a live read-only refresh has now returned a selectable snapshot. Target search, writes, and read-back remain unverified live.

## Read flow

1. Open Apple Music in Chrome and sign in normally. You can keep Spotify, Yandex Music, and Zvuk tabs open too.
2. Click the **Music Importer** extension button. Its extension-hosted app starts a scan of all supported music tabs; do not start a separate Apple-only scan.
3. The reader follows `next` pages for `/v1/me/library/songs`, `/v1/me/library/playlists`, and each playlist's `/tracks` relationship.
4. The `/v1/me/library/songs` response is the user's library catalog, not a likes-only endpoint. The reader classifies only rows whose `attributes.inFavorites` is `true` as liked songs, preserves playlist order and repeated items, and confirms each total before returning the snapshot. If Apple omits the membership attribute for any song, the reader rejects the scan instead of silently treating an unknown like as unliked. Apple's API documentation defines `inFavorites` as whether the catalog resource is in the person's favorites.
5. Wait for the Apple Music library status to report a complete snapshot, then choose Apple Music as the source and any of the other three services as the destination.

The scan is read-only. If Apple Music has not yet made an authenticated API request in the open page, the reader asks the user to open the library and retry. A missing `meta.total`, repeated page, invalid pagination URL, or malformed track stops the scan rather than claiming a complete snapshot.

## Limits

- The connector uses the logged-in web player's private runtime headers to call documented personal-library reads. It does not create a MusicKit developer token or store user credentials. Apple's public REST API normally requires a developer token; this browser-session route is specific to the first-party Apple Music web app and may change.
- Apple is both a source connector and an experimental target writer. The target writer's documented REST operations pass fixtures; live use through the first-party page session is still unverified. See [`APPLE_TRANSFER.md`](APPLE_TRANSFER.md).
- If the Apple library is not listed in the extension-hosted app, reload the unpacked extension in `chrome://extensions`, then reload the Apple Music tab and reopen Music Importer. The localhost page is only a fallback and cannot use the extension until its optional localhost permission is granted.

## Live verification

On 2026-10-28, a read-only refresh through the local app and unpacked extension returned a complete, selectable Apple Music library snapshot, including playlists. Account-specific counts and item names were omitted from the validation record. This establishes the source reader against the currently signed-in page session only; it does not validate any target catalog search or live write.

## References

- [Apple: Get All Library Songs](https://developer.apple.com/documentation/applemusicapi/get-all-library-songs)
- [Apple: Get All Library Playlists](https://developer.apple.com/documentation/applemusicapi/get-all-library-playlists)
- [Apple: LibrarySongs attributes](https://developer.apple.com/documentation/applemusicapi/librarysongs/attributes-data.dictionary)
- [Apple: Add resource to favorites](https://developer.apple.com/documentation/applemusicapi/add-resource-to-favorites)
- [Apple: User Authentication for MusicKit](https://developer.apple.com/documentation/applemusicapi/user-authentication-for-musickit)
- Full provider/API research is documented in `docs/providers/apple-music.md` in the research branch.
