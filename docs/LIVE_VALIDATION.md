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

## 2026-10-28 — scan after extension installation

- Reloading the local app connected it to the enabled unpacked extension and started reads from the open service tabs.
- Apple Music completed a snapshot containing playlists; the observed account currently returned no liked tracks. No write was attempted.
- The completed Apple Music snapshot could be selected as the source while other provider scans were still pending; the app displayed its playlist tracks for matching. This confirms that a pending reader does not prevent selecting an already completed provider snapshot.
- Yandex Music continued fetching likes page by page and then began playlist pagination. It was still progressing at the end of this observation, so no complete snapshot was available yet.
- Spotify remained at the same displayed Liked Songs boundary for several minutes and did not complete a snapshot during this observation. This reproduces the stuck scan in the live UI; the underlying request or response that stopped progress has not been identified.
- Zvuk did not yield a complete library snapshot. The app returned to “Войдите и откройте сервис в Chrome”; the reason is not established from the app UI.
- No target search, account write, or read-back was run. Counts, track names, IDs, cookies, and session headers are intentionally not recorded.

Fixture coverage remains separate from this live observation. None of the 12 source-to-target routes has yet completed a live write and read-back.

## 2026-10-28 — parallel scan state audit

- Code review found that simultaneous Spotify, Apple Music, and Yandex progress/snapshot messages each performed an independent read-modify-write of the same Chrome storage record. A later write could therefore erase another provider's just-written progress or completed snapshot.
- Provider-state mutations are now serialized, including scan start, stale-scan failure, scan errors, progress, and completed snapshots. A concurrent three-provider snapshot fixture confirms that all three results survive.
- This is a confirmed storage race in the implementation, but it is not yet proven to be the cause of the observed Spotify stall. The changed extension still needs a live reload and another read-only multi-service scan; no account writes were made.
