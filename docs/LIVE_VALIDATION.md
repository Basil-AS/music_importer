# Live validation log

This log records connector behavior observed with an unpacked extension and the user's already signed-in Chrome tabs. It intentionally omits account-specific collection sizes, track names, IDs, session data, and request credentials.

## 2026-10-28 — first Chrome scan

- The localhost app and installed extension exchanged messages in regular Chrome; the extension started a scan across the open provider tabs.
- Apple Music returned a complete library snapshot with playlists. The displayed account-specific counts are omitted.
- Spotify reported progress through its liked-song collection but did not produce a complete snapshot during this observation. The UI remained in `scanning`; the exact point of delay is not established from the visible status.
- Yandex Music failed closed with `Карточки лайков Яндекс Музыки неполны.` The reader did not mark the partial collection complete.
- Zvuk failed closed with `Загрузка избранного остановилась до последней страницы.` The reader did not mark the partial collection complete.
- No target catalog search or account write was run in this smoke test.
- The scan exposed a product issue: provider reads without new progress could keep the whole UI in a pending state for up to 45 minutes. Commit `2fc6d4a` reduces the inactivity threshold to two minutes, preserves the last complete snapshot, and lets other provider results finish. The installed unpacked extension must be reloaded to use that change.
- Follow-up fixture-driven change: Spotify now reports the transition from Liked Songs to playlist catalog and each playlist page; Web Player bundle fetches time out after 15 seconds, API requests after 45 seconds, and `Retry-After` waits continue to report progress. Fixture coverage confirms a stalled playlist-catalog request becomes an explicit scan error. This has not yet been repeated against the live account.
- Follow-up fixture-driven change: Zvuk favorites now continue from the observed GraphQL `endCursor` without depending on virtualized scrolling; each page is acknowledged after local persistence, the scan waits for the independent ID count, and a two-minute no-progress watchdog releases the UI. Scroll remains a fallback if query replay fails. This has not yet been repeated against the live account.

Fixture coverage remains separate from this live observation. None of the 12 source-to-target routes has yet completed a live write and read-back.
