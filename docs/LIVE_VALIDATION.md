# Live validation log

## 2026-10-28 — stale Apple bridge recovery

- Version `0.13.43` upgrades all provider bridge health replies to protocol 3. Tabs still running a protocol 2 content script now fail the health check and are reloaded automatically on extension install/update or before the next read/write command.
- Version `0.13.44` also checks and repairs provider bridge health every time the extension-hosted app opens, before scanning accounts. This covers stale bridge tabs even when the install/update event did not repair them. Old `Extension context invalidated` entries already recorded in Chrome's error log remain historical; active errors from a stale page are cleared when the extension reloads that provider tab.
- The supplied Apple stack contains a direct `chrome.runtime.sendMessage(...).then(...)` call, while the current bridge wraps runtime access in `try/catch` and absorbs invalid-context rejections. That stack therefore belongs to a stale injected script or an older retained Chrome error entry; an already-injected invalid script cannot repair itself because its extension runtime is gone.
- `http://127.0.0.1:8001/` is a Python static server serving `music_importer-mvp/demo/`, not the extension app or a backend. The in-app browser does not share the separately installed Chrome extension. Open the extension UI from Chrome's Music Importer button for a connected session.
- Each provider needs a page tab for its existing signed-in session while reading/searching/writing; the extension opens missing tabs in the background. Zvuk reads favorites, then playlist catalog and each playlist's paginated tracks, preserving order and verifying counts. No cookies or tokens are exported to the app.

## 2026-10-28 — mobile layout verification

- Version `0.13.42` changes the service-card grid to two columns on mobile and stacks the hero artwork below copy at widths up to 360 px. Long source-card status labels no longer widen the grid.
- The ordinary local page was visually checked at 320 px and 390 px. DOM measurements reported document widths of exactly 320 px and 390 px respectively, with no element extending beyond the viewport. The temporary viewport override was reset after the check.
- This is a visual/layout check only. The in-app browser does not host the user's Chrome extension, so account connection remained unavailable there; no provider library was read or written in this check.

## 2026-10-28 — batch catalog cache writes

- Version `0.13.40` batches completed catalog-search results into local cache writes of up to 100 tracks, reducing serialized IndexedDB transaction count for large libraries. Any partial batch is flushed after normal completion, cancellation, or search failure; a cache-write error does not interrupt catalog matching.
- A 10,025-track fixture verifies 100 full batches plus a 25-track tail. A second fixture verifies later batches still flush after one rejected cache write. The extension app bundle was regenerated and matches `demo/` sources.
- Full suite: **233/233 tests**. This is fixture evidence; no live 10k-track account search, Chrome IndexedDB timing, catalog mutation, or source-to-target read-back has been run in this validation.

## 2026-10-28 — repair existing service tabs on install

- Version `0.13.39` runs the bridge health check on both first install and update. It reloads only already-open supported provider tabs that do not answer with the current bridge protocol. This covers tabs opened before the extension was installed; previously that repair ran only on update or browser startup.
- The reported Apple stack trace calls `chrome.runtime.sendMessage(...).then(...)` directly, which is absent from current bridge source. That injected script cannot recover after its extension context is invalidated; the tab must navigate to receive the current script. The extension now performs that navigation automatically during install/update and before commands.
- Covered by service-worker fixture tests. This does not establish a live Chrome retest; load extension `0.13.39` to verify that the historical error stops recurring.
- Verification: the full suite passes **231/231 tests**, the extension app bundle check passes, and `git diff --check` passes. Still fixture-verified only; no live account scan or transfer was run.

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

## 2026-10-28 — local app read-only scan and bridge error follow-up

- Confirmed `127.0.0.1:8001` is Python's static `http.server` serving the `demo/` directory; the running process is PID 20084. It has no project backend. The localhost page successfully connected to the installed extension.
- A read-only scan returned selectable snapshots from Apple Music and Yandex Music. Provider names and the ready/selected states are recorded; account-specific library sizes, track/playlist titles, IDs, and session data are omitted.
- Spotify and Zvuk did not have a newly loaded library snapshot at the end of this check. No target search, write, or read-back was run.
- The repeated `Extension context invalidated` report came from an old injected Apple bridge calling `chrome.runtime.sendMessage(...).then(...)` directly. Current Apple, Spotify, Yandex, and Zvuk bridges guard synchronous runtime invalidation and rejected message promises. Reloading the extension does not replace scripts already injected into open service pages; reload Music Importer in `chrome://extensions`, then refresh each service tab.
- Added provider-specific login/open actions to the local app and safe Spotify scan diagnostics that include only operation, page offset/limit, elapsed time, and a sanitized HTTP/error code. The diagnostic intentionally excludes request headers, tokens, collection IDs, titles, and raw provider error text. These changes are fixture-tested; Spotify's new diagnostic has not yet been exercised in the user's page session.
- Snapshot reading uses a content script injected into each provider page. The extension asks an already-open service tab to start a scan, then the provider's page code fetches the signed-in user's likes and playlist pages and sends normalized metadata to the extension for local storage. Spotify, Apple Music, and Yandex need an open signed-in tab during the read. Zvuk also currently needs its service page open for collection capture. This is metadata collection, not audio downloading.
- Fixture coverage remains separate from this live observation. No source-to-target route has completed a live target write and read-back.

## 2026-10-28 — automatic recovery from an old Apple bridge

- Confirmed the local fallback at `http://127.0.0.1:8001/` is the static demo page; it is not a project backend. The Chrome extension service worker performs account reads and stores normalized snapshots locally.
- Pressed **Обновить открытые аккаунты** in the app. The current service worker retried providers through their open pages; Apple Music returned to an available library state without manual navigation to the service tab. This verifies recovery in the app, not removal of an earlier console entry from Chrome's error history.
- The Apple error report contains a direct `chrome.runtime.sendMessage(...).then(...)` call, while the current Apple bridge wraps runtime messaging in synchronous and promise-rejection guards. The report therefore matches an old content script still injected into the page. On a later read, the service worker detects a missing bridge, reloads that provider page, and retries the scan.
- The same run did not complete new snapshots from Spotify, Yandex Music, or Zvuk. No target search, account write, or read-back was run.
- Provider tabs are required because readers run in the corresponding signed-in site page and use that page's authenticated requests. They can remain in the background; users should leave the Zvuk tab open until its multi-page collection scan finishes. Likes and playlist metadata are read into local extension storage; audio is not downloaded.

## 2026-10-28 — automatic recovery after browser startup

- The Apple stack trace still shown by Chrome is from a bridge that called `chrome.runtime.sendMessage(...).then(...)` directly. The current bridge source catches both synchronous “Extension context invalidated” exceptions and rejected message promises. A historical error entry in `chrome://extensions` can remain visible after recovery; its presence alone does not prove that the current bridge is still failing.
- The extension now checks open Spotify, Apple Music, Yandex Music, and Zvuk tabs at browser startup. It reloads only tabs whose health check is missing or reports an old bridge protocol. Existing update-time recovery remains in place. A fixture verifies that a stale Apple tab reloads while a healthy Spotify tab is left alone.
- This startup repair is implemented and fixture-checked, but Chrome must load manifest version `0.13.35` for it to take effect. If the old error is still actively emitted after that version is loaded and the Apple tab has been reloaded by the extension, collect the new error's timestamp and exact script line without sharing any session credentials.
- `http://127.0.0.1:8001/` is Python's static server for `demo/`, not an application backend. The normal extension-hosted UI has no project server.
- Fresh reads currently require open signed-in provider tabs. The extension sends a scan command to each tab; provider page code issues that site's authenticated library/API requests and sends normalized likes, playlists, and track metadata through a content-script bridge. The extension service worker saves complete snapshots locally. Provider tabs may remain in the background, but the Zvuk reader also scrolls/navigates its service page while collecting favorites and playlist pages. Transfer search and writes likewise need an open target-service tab. No audio is downloaded.

## 2026-10-28 — background provider-tab onboarding

- Based on the tabless-auth audit, the current connectors cannot move their authenticated reads/search/writes to the service worker without a separate per-service authentication prototype: Spotify and Apple need page-derived API headers, and Zvuk uses page-context requests plus collection navigation/scrolling. The extension therefore keeps page-context auth, but now opens any missing service page in a background tab during an all-service refresh. It does not steal focus from the importer.
- If a user needs to sign in, the provider card's login action focuses the already-open background tab rather than opening a duplicate. Returning to the importer triggers the existing pending-login refresh flow. A retry scoped to one provider opens only that provider page.
- Fixtures cover automatic background provisioning, focusing an existing service tab, rejecting a focus target outside the requested provider set, and existing provider scans. This improves setup flow but does not prove live auth or complete scans; the currently installed extension must load `0.13.36` before this behavior is available. No account write was performed.

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

## 2026-10-28 — cross-route regression and matching cache

- Version `0.13.34` adds confirmed page-by-page reads for long Yandex playlists. The reader requests 100 tracks per page, validates `pager.total/page/per_page` against the catalog count, and refuses incomplete or inconsistent responses. A two-page fixture verifies order; a truncated response without pager data must fail the whole snapshot. The endpoint contract is inferred from reverse-engineered community clients and remains unverified against the live account.
- Search-cache entries now rank candidates before the 12-item storage limit and keep an explicitly selected candidate. The cache format was bumped so older truncated entries are ignored. This avoids silently replacing a good match after a reload; unit fixtures cover both the best-ranked and a manually chosen candidate beyond the old limit.
- A full local run passed **215/215 tests**. The twelve route scenarios exercise each provider reader/writer and read-back against simulated service APIs; a separate Apple Music → Spotify test also checks an exact fake-account read-back. These are fixtures and do not establish live endpoint compatibility or a live account transfer.
- Two issues surfaced during the first full run and were fixed before the passing run: the bridge recovery fixture did not distinguish an old bridge protocol from a healthy one, and the Yandex route fixture did not model paginated playlist reads or direct writes to the newly created target playlist. The integration harness now verifies protocol-version recovery and all twelve mixed like/playlist paths.
- The extension app bundle check passed and both GitHub Actions checks for PR #2 passed. No target account was modified in this validation. The current Chrome installation still needs the updated unpacked extension reloaded before its live session can validate version `0.13.34`; no live route has yet completed a destination write plus read-back.

## 2026-10-28 — Spotify short-page pagination correction

- Code review confirmed a likely failure mode in the Spotify source reader: it requested 1,000 Liked Songs / playlist rows, then advanced offsets by the requested page size even when the response contained fewer rows. A capped response could skip rows and prevent a complete snapshot.
- Version `0.13.27` now requests 50 rows, validates returned page offsets when present, and advances by the actual number of returned rows for Liked Songs, playlist catalog, and playlist contents. A synthetic provider fixture caps pages at two rows and confirms offsets `0, 2, 4` plus complete IDs and playlist ordering.
- Full fixture suite passes 204/204; extension app bundle check and JavaScript syntax check pass. This is fixture evidence only: no fresh Spotify session scan was possible in this turn, so the live stall cause and fix remain unconfirmed. No account writes were run.

## 2026-10-28 — Zvuk cursor replay headers

- Code review found that cursor pagination could lose the page's original request headers when the site uses `fetch(Request)` or XHR instead of `fetch(url, init)`. This could make the first favorites page visible while the replayed next page is rejected.
- Version `0.13.29` copies request headers only inside the page-script closure for same-origin GraphQL cursor replay. Fetch Request method/credentials and XHR method/custom headers are preserved. Header values are not posted to the extension, stored, or included in diagnostics.
- Fixture tests exercise both Request and XHR replay with a required synthetic header, verify the next favorite page completes, and assert the header never appears in bridge messages. This is not live evidence; the Zvuk session still needs a read-only retest after extension reload.

## 2026-10-28 — Spotify HTTP 401 with an authenticated page

- The local importer showed `fetchLibraryTracks: HTTP 401` while the visible Spotify tab still rendered the signed-in Liked Songs page. The precise server-side rejection reason is not available from the sanitized response; no request or cookie values were inspected.
- Reader code sent the captured bearer/client headers but omitted Fetch's `credentials` option for `api-partner.spotify.com`. Version `0.13.30` now uses `credentials: include` for Pathfinder calls so the browser may attach Spotify's own session cookies, without reading or storing cookie values. The privacy disclosure now describes this behavior.
- Version `0.13.31` adds a bridge-health handshake on extension updates. Open provider tabs are reloaded only when the old content script no longer answers; healthy tabs are left alone. A scan still retries after a missing content script.
- A fixture asserts credentialed requests. This is a hypothesis-driven fix, not live proof; it must be checked after Reload of the unpacked extension. No target search, account write, or read-back was run.

## 2026-10-28 — Apple bridge error recheck

- The user-reported stack still displayed a direct `chrome.runtime.sendMessage(...).then(...)` call, which does not match the guarded bridge source in extension version `0.13.36`. This indicates a stale injected bridge or a historical Chrome extension error entry; the current source handles both synchronous invalidation and rejected messaging.
- Reloaded the open Apple Music page to replace its injected content scripts. The page's current console error list was empty after reload. The visible Apple Music page now requires sign-in, so no library scan was started; no account data or credentials were inspected.
- A stale-context error cannot be forwarded to the extension after Chrome has invalidated the content-script context. Recovery therefore belongs to the service worker: it checks the bridge health and reloads stale provider tabs, while the bridge safely ignores delivery failures. Historical errors may remain listed by Chrome after recovery.
- Current source behavior: a fresh library read uses an open signed-in provider tab. The page-context reader fetches that service's likes and playlist metadata; the extension stores normalized snapshots locally. These tabs may remain in the background. A genuinely tabless auth path is not implemented.

## 2026-10-28 — live read-only refresh from the local app

- Confirmed the page at `http://127.0.0.1:8001/` is the static demo frontend. Its local-app bridge connected to the unpacked extension; the extension opened/used provider tabs in the background and started a read-only refresh. No backend server or account write was involved.
- The refresh returned complete, selectable library snapshots from Apple Music and Yandex Music. Snapshot and track metadata remain in local Chrome extension storage; this note omits account-specific counts and track/playlist names.
- Spotify failed during its live source read with sanitized `fetchLibraryTracks: HTTP 401`, although the provider page title indicated the Liked Songs view. The authentication/API rejection remains unresolved; no headers, tokens, or cookies were inspected.
- Zvuk advanced through favorites and playlist collection, but the final provider status reported that the playlist catalog did not load. Partial crawl progress was not treated as a complete snapshot. The account/session or API cause is not established.
- The local UI showed two of four libraries available. No target was selected, no catalog search was run, and no likes or playlists were written. Therefore this proves two live source reads only; all twelve live source-to-target write/read-back routes remain unverified.

## 2026-10-28 — stale bridge recovery and Zvuk catalog diagnostics

- Confirmed `http://127.0.0.1:8001/` is Python's static `http.server` (PID 20084) serving `demo/`; it is not an application backend. The extension service worker reads provider pages and stores normalized snapshots in Chrome local extension storage. The extension-hosted app is the normal UI and does not need a project server.
- The reported Apple stack trace matches an older bridge source that called `chrome.runtime.sendMessage` directly. Current bridges catch invalidated contexts, and service commands now verify the content-script bridge protocol before scanning, searching, or writing. If the bridge is missing/outdated, the extension reloads that service tab and retries. Fixture-verified; Chrome must load extension `0.13.37` before live confirmation.
- Zvuk catalog errors now expose only an allowlisted GraphQL operation, numeric HTTP status, and boolean GraphQL/JSON error flags. The UI can distinguish HTTP rejection, unsupported response shape, and a slow/no-response timeout. The first catalog timeout now allows a minute for page hydration; the previous deadline started at document injection. No response body, variables, headers, IDs, titles, cookies, or tokens are retained.
- Fixtures cover slow catalog hydration, safe HTTP/GraphQL diagnostics, and stale-bridge repair. At that revision the full suite passed (223 tests); extension app bundle synchronization and `git diff --check` passed.
- This is code/fixture evidence only. No fresh live snapshot, catalog search, account write, or read-back was run. Provider tabs are required during authenticated reads/searches/writes, but may stay in the background. The Zvuk collector navigates/scrolls its service tab while collecting favorites, playlist catalog, and playlist tracks.

## 2026-10-28 — Spotify 401 recovery and Zvuk pagination diagnosis

- Spotify's private Web Player reader now waits up to eight seconds for a newer page-issued session request after one HTTP 401, then retries once only with that newer in-memory session snapshot. If the page does not refresh its session, it preserves the sanitized 401 and does not blindly replay the request. Fixtures verify both paths and ensure header values never enter messages. Stale session capture remains a hypothesis for the previous live 401, not a confirmed cause.
- Zvuk now uses explicit `hasNextPage` when present and falls back to `endCursor` only when absent. A successful HTTP 200 response is no longer remembered as the latest read error, so a stalled next page is not mislabeled as an API/shape failure. Missing catalog shape or inconsistent pagination is reported separately.
- The expanded full suite passes **228/228 tests** and the extension app bundle check passes. Fixture-verified only; no new live account scan or write was run. Chrome must load extension version `0.13.38` before a read-only retest can verify either change.
