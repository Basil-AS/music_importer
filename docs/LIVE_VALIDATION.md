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
- The same read-modify-write race existed in Zvuk's favorites and playlist crawler state. Collection messages, library refresh/state reads, and snapshot clearing are now serialized separately from catalog commands and transfer progress, so a concurrent favorite page and independent total cannot erase one another.
- This is a confirmed storage race in the implementation, but it is not yet proven to be the cause of the observed Spotify stall. The changed extension still needs a live reload and another read-only multi-service scan; no account writes were made.

## 2026-10-28 — scan after unpacked extension installation

- Reloading the localhost MVP reconnected the unpacked extension and started another read-only scan across the open service tabs. Apple Music returned a complete selectable snapshot with playlists; account-specific counts and track metadata are omitted.
- Yandex Music advanced through nearly the entire likes collection, then produced no complete snapshot. The UI showed the incomplete-like-cards error. The exact response batch was not captured, so whether the remaining IDs were omitted by `/tracks` or another shape issue caused the failure is not established.
- Spotify did not return a new complete snapshot during this run; its visible card reported that the previous scan stopped without a response. Zvuk also did not return a complete snapshot, despite its page visibly showing the signed-in favorites library. No API credentials or cookie values were inspected.
- Fixture-driven follow-up now preserves authoritative Yandex collection IDs when hydration omits metadata rows and marks those rows incomplete. Temporary network errors, HTTP 408, 429 and 5xx also receive bounded retries; `Retry-After` is honored and visible progress continues during waits. This change is not yet verified against the live scan.
- Follow-up fixture change (2026-10-28): when a successful 25-ID Yandex `/tracks` hydration omits a card, retry that ID alone before accepting an explicitly metadata-incomplete entry. The regression fixture confirms the skipped card is recovered without refetching already hydrated tracks. Live scan result is still unknown.
- Selecting Spotify as the destination automatically started a bulk search for the Apple Music snapshot. No result completed before the progress remained at zero for about a minute, so the queue was stopped. A later single-track Spotify catalog query returned HTTP 429 after its retry window. The request was not repeated; no account write occurred.
- No destination write or read-back was run. All twelve live transfer directions remain unverified.
- Fixture-driven follow-up: bulk search now shows its active request and 429 cooldown. After retries are exhausted on 429, network failure, 408, 5xx, 401 or 403, the search queue stops instead of falling back from a failed album batch into individual requests. Fixtures cover rate-limit UI callbacks, preserving earlier results, and no fallback fan-out. This guard is not yet live-verified against Spotify.

## 2026-10-28 — scan with the unpacked extension installed

- Repeated the scan from the live localhost app after the extension was installed. Apple Music remained selectable; Spotify still displayed its final Liked Songs progress without a complete snapshot. Zvuk and Yandex failed closed, so no partial library was offered for transfer.
- The user-visible error details were available as button tooltips: Zvuk stopped before the final favorites page; Yandex rejected an incomplete likes-card result. The exact live responses were not captured, and those causes remain unverified.
- Code inspection found a concrete timeout gap shared by readers: Spotify, Apple Music, and Yandex bounded fetch-to-headers, while JSON/body reads could remain pending after headers arrived. Zvuk's cursor reader also stopped its 45-second timer before reading JSON. Version `0.13.5` keeps the deadline active through body consumption and displays provider errors directly in their source cards. These changes are fixture-verified but have not yet been live-tested.
- Further inspection found Spotify launched its likes and playlist-catalog requests concurrently, while the 300 ms delay was calculated outside a shared queue; concurrent calls could therefore start together. Version `0.13.6` reserves request starts through a small serialized scheduler while keeping the existing spacing and `Retry-After` behavior. A fixture verifies that simultaneous likes/catalog reads do not burst; the effect on the live scan is not yet known.
- The Spotify live status did not reveal the current phase. No target search, write, or read-back was performed. All twelve live transfer directions remain unverified.

### Spotify catalog limiter follow-up — 2026-10-28

Code review of the live `HTTP 429` observed in the importer showed that the `0.13.6` request-start scheduler covered Pathfinder operations but not the Spotify catalog `GET /v1/search` or album-track reads. Version `0.13.8` applies the same serialized request-start interval to these catalog calls; their `Retry-After` values already flow into the shared bulk-search backoff. The change is covered by a fixture that checks start spacing between album search and track-list requests. It is not yet live-verified because the user's Chrome still has the previous importer page open and the unpacked extension has not been reloaded.

### Spotify reader preflight/hash follow-up — 2026-10-28

Static review found that source scanning fetched and buffered a Spotify CDN bundle even when all required persisted-query hashes were already available in the reader. It also found that a `PersistedQueryNotFound` response could rediscover the cached old hash instead of refreshing it. Version `0.13.20` skips the unnecessary preflight fetch and removes the stale hash before discovery. Fixtures prove the no-download path and successful retry with a refreshed query hash. The prior live Liked Songs stall remains unexplained and this fix has not been retested in the user's account.
