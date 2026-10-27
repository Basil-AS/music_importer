# Apple Music source connector

The experimental local Chrome extension reader is implemented for liked songs and user playlists from the signed-in `music.apple.com` page. It uses the Apple Music Web player's own in-memory authenticated requests to the first-party `/v1/me/library` API. The observed authorization headers stay inside the page's private closure; the extension and local app receive normalized track records only. No browser storage, cookie jar, or token file is read or persisted. The reader has fixture coverage; a live account scan still needs verification after reloading the unpacked extension.

## Read flow

1. Open the Apple Music library in Chrome and choose Apple Music as the source in the local app.
2. Click **Подтянуть из расширения**. The extension asks the Apple Music page to scan the account.
3. The reader follows `next` pages for `/v1/me/library/songs`, `/v1/me/library/playlists`, and each playlist's `/tracks` relationship.
4. It classifies songs with the documented `inFavorites` library attribute into favorites, preserves playlist order and repeated items, and confirms each total before returning the snapshot.

The scan is read-only. If Apple Music has not yet made an authenticated API request in the open page, the reader asks the user to open the library and retry. A missing `meta.total`, repeated page, invalid pagination URL, or malformed track stops the scan rather than claiming a complete snapshot.

## Limits

- The connector uses the logged-in web player's private runtime headers to call documented personal-library reads. It does not create a MusicKit developer token or store user credentials. Apple's public REST API normally requires a developer token; this browser-session route is specific to the first-party Apple Music web app and may change.
- Apple is now a source connector as well as the existing catalog matcher. Apple destination writes are not enabled in the MVP. The target writer is still experimental for Yandex Music only.
- Before using the updated unpacked extension, reload it in `chrome://extensions` and refresh both Apple Music and the local app tabs.

## References

- [Apple: Get All Library Songs](https://developer.apple.com/documentation/applemusicapi/get-all-library-songs)
- [Apple: Get All Library Playlists](https://developer.apple.com/documentation/applemusicapi/get-all-library-playlists)
- [Apple: LibrarySongs attributes](https://developer.apple.com/documentation/applemusicapi/librarysongs/attributes-data.dictionary)
- [Apple: User Authentication for MusicKit](https://developer.apple.com/documentation/applemusicapi/user-authentication-for-musickit)
- Full provider/API research is documented in `docs/providers/apple-music.md` in the research branch.
