# Live validation log

## 2026-10-31 — concise app copy

- Removed the generic connector/test disclaimer, repeated onboarding paragraph, long connection setup text, and sidebar privacy paragraph from the main app. Kept the live provider errors/progress, transfer recovery actions, cache controls, and a short extension-recovery hint. Legacy stored watchdog text is normalized when displayed.
- Reduced default empty/loading copy and cache notices to concise labels. The detailed privacy document remains available separately from the app's “Приватность” link.
- Reloaded the existing local app tab through Chrome DevTools MCP. No legacy copy remained on screen; the saved Spotify watchdog appeared as “Spotify: нет прогресса 2 минуты. Снимок не сохранён.” Yandex and Apple showed their own independent counters. The local page console had no warnings/errors. This refresh only read libraries; it made no account changes.
- Focused app/worker/UI tests pass **80/80**, the full suite passes **378/378**, the extension bundle matches `demo/`, and `git diff --check` passes.

## 2026-10-31 — detailed progress in nested phases

- After PR #29 merged, reloaded the existing local app tab through Chrome DevTools MCP. Its per-provider progress bars updated independently with Yandex at 275/4,979 and Apple reading a playlist with 400/1,320 tracks. For Apple's message “playlist 1 of 12: 400 of 1,320”, the UI initially chose the first pair and displayed 1/12.
- Updated the progress parser to use the last reported count pair, so nested phases display the detailed track count. A regression fixture covers Spotify, Yandex, and Apple's nested playlist count. The full suite passes **377/377**, and the bundle check passes. The local Chrome page was not reloaded again after this small code change; verification is from the fixture and bundle build. No account writes were made.

## 2026-10-31 — provider-specific scan status UX

- Used only the user's existing Chrome through `chrome-devtools`: `list_pages` first, then inspected the existing local app tab (`http://127.0.0.1:8001/`). No new browser/profile was started. The page displayed a distinct status and progress indicator per provider, plus provider-specific retry/update buttons. The console had no warnings or errors.
- The live read-only refresh confirmed **4,979 Yandex likes**, but the library was not complete: a playlist page came back empty before the service's reported end, so the app retained likes as a partial source and offered “Повторить чтение”. Zvuk failed on a GraphQL error while reading its playlist catalog. Apple displayed its previous cached snapshot, not a fresh scan. No account was written.
- Clicked the Spotify card's “Проверить Spotify” action. Its own status advanced through **1,000/1,430** and **1,430/1,430** liked tracks, then stopped progressing before a complete library snapshot was confirmed; the worker later marked it stale at the two-minute watchdog. The Spotify page console also had socket/network errors, but the exact operation that stalled is not proven. This confirms the reader can paginate its liked tracks, not that full Spotify library collection succeeds.
- The local page showed independent live progress for Spotify and Yandex at the same time. The updated app now makes count-based progress bars determinate and keeps them indeterminate for phases without a count. The old watchdog text remained on the already-saved Spotify error; the updated instruction has not yet been verified in the installed extension. No cookies, tokens, headers, or raw API responses were inspected.
- Code review found a mismatch between the watchdog instruction and the actual Spotify card action, hidden retry controls for saved snapshots, a shared progress message, and provider-scoped refresh polling that waited on unrelated scans. The UI now keeps “Обновить библиотеки” in a stable location, gives each service an independent progress/status view and visible retry/update action for failed or stale snapshots, and polls only the providers being refreshed. If a retry is requested during another scan, it is queued.
- The extension app bundle was rebuilt from `demo/` and passes `node scripts/build-extension-app.mjs --check`; `git diff --check`, manifest JSON parsing, and JS syntax checks pass. The full test suite passes **377/377**. The live Chrome refresh did **not** prove a successful Spotify scan or complete libraries from the other providers. Chrome DevTools MCP refused navigation to the existing `chrome://extensions` tab with `Error: Navigating to chrome: URLs is not allowed.`, so I could not reload the unpacked extension there; the updated watchdog text still needs verification after a manual extension reload.

## 2026-10-31 — deterministic retry fixture and installer wording

- A `develop` CI run exposed a timing race in the Zvuk retry fixture: it polled with `setImmediate` and could finish before the retry timer fired. The fixture helper now yields through a 1 ms timer while waiting for asynchronous messages.
- The full suite using the same default concurrency as CI passes **373/373** locally. The preceding develop run passed **372/373**; its only failure was the retry fixture timing out before `read-error` was posted.
- README now describes the CI download as a free unpacked installation, clarifies that only the artifact expires after 30 days, and updates the manifest version to **0.15.2**.

## 2026-10-31 — safe catalog page diagnostics

- Zvuk catalog failures now include the collection section, page ordinal, and cursor-present/repeated flags. Cursor contents, request headers, response bodies, and account-specific IDs remain outside the diagnostic.
- The app surfaces section and page ordinal alongside HTTP/API errors so repeated reader failures can be narrowed down from the visible UI.
- Focused service-worker and Zvuk source suite passes **77/77**. This is fixture evidence; no authenticated page was read during this change.

## 2026-10-31 — reader pagination recovery fixtures

- Zvuk now falls back to a valid root collection cursor when the nested playlist/release `page` object is empty. Cursor reads retry bounded network, 408/429, and 5xx failures; `Retry-After` is capped at 60 seconds and emits progress while waiting. Diagnostics continue to omit response bodies. Regression fixtures walk both pages and cover a 429 retry.
- Yandex now uses a valid pager total when a virtual playlist's list/detail `trackCount` is stale; revision, page sequence, pager consistency, and final hydrated track count still have to agree. A regression fixture models stale counts while verifying all rows.
- Focused Yandex and Zvuk source suites pass **42/42**. This is fixture evidence only. Live scan status is unchanged until the rebuilt extension is used for a read-only rescan in the existing Chrome profile.

## 2026-10-31 — target writers stop after favorite read-back failures

- Added mixed-plan fixtures for Apple Music, Яндекс.Музыка, and Сбер.Звук where the favorite write request is accepted but its read-back omits the requested track. Each test asserts the command returns `partial_failure` and sends no playlist write.
- Spotify already has the same mixed-plan regression fixture, and its saved-album writer already has a failed-read-back fixture. These tests exercise safe stopping in mocks only; no account was written.
- Focused provider writer suite: **60/60 passed**. The full suite passes **369/369**; `git diff --check` passes. This remains fixture evidence only.

## 2026-10-31 — read-only refresh after UI polish

- Reused the user's existing Chrome profile and the open `http://127.0.0.1:8001/` tab. Triggered **Обновить открытые аккаунты**; no destination was selected, no catalog search was run, and no account was written.
- The UI again reported that Zvuk stopped before confirming its next page. Spotify showed the existing no-progress timeout; this refresh did not produce a new complete Spotify snapshot. Yandex finished reading its liked tracks but rejected the full library because a playlist's catalog count did not match its detail evidence. Apple continued to show a previously saved snapshot; this pass did not confirm a new Apple snapshot.
- No cookies, tokens, authorization headers, raw service responses, or account-specific library contents were collected. This is a live UI observation only; the installed extension version was not independently verified, so it cannot confirm the latest connector recovery changes.

## 2026-10-31 — reloaded the unpacked extension in the existing Chrome profile

- Confirmed the installed unpacked extension points to this repository's `chrome-extension/` directory. Reloaded it there and used its extension-hosted app; no new Chrome profile was created.
- Apple Music has a complete locally stored library snapshot after the current extension reload. The earlier live `inFavorites` omission was not reproduced in this read; the app continues to fail closed if Apple omits that attribute.
- Yandex returned a complete independently counted liked-track list, then its playlist completeness check rejected a virtual collection because the independent catalog count did not match. The extension-hosted app exposes the confirmed likes as a partial source and does not offer unconfirmed playlists.
- Zvuk delivered its liked-track pages, but the collection reader still stops before confirming the next playlist-catalog page. The exact cursor/page diagnostics remain a follow-up; response bodies and credentials were not collected.
- Spotify stayed on the explicit-refresh path and was not freshly read in this pass. No account write or transfer read-back was run. The previously saved one-track Apple → Yandex transfer remains pending and was not resumed.
- The localhost bridge was found to omit `partialLibraries` from its response even though the service worker returned it. A regression test and forwarder fix are in `feature/forward-partial-library-through-local-bridge`; the extension-hosted app path already displayed the partial source.

## 2026-10-30 — read-only scan in the user's existing Chrome profile

- Used the user's ordinary Chrome profile only; no separate profile was created. The Music Importer extension UI and signed-in provider tabs were already present. No cookies, access tokens, authorization headers, track names, or playlist names were read or copied.
- With the user's approval, triggered the app's **Обновить открытые аккаунты** action. This was a read-only refresh; no catalog search or account write was run.
- Yandex Music paginated Liked Songs, then rejected the full snapshot when a virtual playlist failed completeness checks. Exact counts and playlist names are omitted.
- Zvuk returned a sanitized unsupported-response error for `getPaginatedCollectionAll`. Spotify stalled while checking for a refreshed page session and timed out without saving a partial snapshot. Apple Music reported that it could not confirm favorite status for 341 songs and rejected the incomplete snapshot.
- Result: the current installed build does **not** successfully load complete libraries from any of the four accounts in this live check. Fixture success must not be represented as live service success. No route was written or read back.
- The user approved temporarily enabling Chrome's **View → Developer → Allow JavaScript from Apple Events** for this read-only check. macOS denied UI automation of System Events (`-1743`), so the user switched the menu setting off manually after the scan. The Chrome preference was rechecked as `browser.allow_javascript_apple_events: false`; the existing Chrome session was left open.

## 2026-10-30 — Spotify bridge refresh requires a user action

- The Spotify page has previously sent two first-party `DELETE` requests during Web Player navigation; their effect on device/playback state is not established. Automatic bridge repair on extension install/update, browser startup, and the app's initial scan now skips Spotify. The other three providers continue through automatic recovery.
- The Spotify card starts a read only after the user clicks it; its action text says that an outdated bridge may reload the Spotify tab. Opening Spotify for login also queues a scan after the user returns to the importer.
- Worker fixtures cover install/update, browser startup, and app repair with a stale Spotify bridge, plus the explicit all-provider repair path. This change does not verify Spotify library reading or transfer; no new Chrome profile or account operation was used for these fixtures.

## 2026-10-30 — Zvuk collection response shape regression

- Comparing the live error with `docs/providers/zvuk-api-inventory.md` revealed that the observed `getPaginatedCollectionAll` payload uses `data.paginatedCollection`, while the reader accepted only `paginatedCollectionAll` and `paginatedCollectionAllSections`. This matches the live unsupported-response error and the gap in prior fixtures.
- Added the observed response-root alias with the existing playlist-section and cursor validation unchanged, plus a regression fixture based on the documented shape. The fixture suite passes; this is not yet live confirmation. A fresh read requires reloading the unpacked extension and the signed-in Zvuk tab, then retrying the scan.

## 2026-10-30 — Apple favorite attribute request

- The live Apple scan found 341 library-song rows without an `inFavorites` boolean and correctly refused to guess their favorite state. Apple documents `inFavorites` on library-song attributes and supports `extend` on the library-songs endpoint; the reader now explicitly requests `extend=inFavorites` on every page, including favorite verification reads.
- Apple reader fixtures pass with that request parameter. This is a reasoned fix candidate, not live confirmation; retry after the updated extension is loaded. The reader still rejects a response if the service omits favorite state.

## 2026-10-30 — Yandex playlist evidence and Spotify auth timeout

- Yandex's playlist completeness failure now reports only which required evidence is absent (`tracks`, `track-count`, `revision`, or catalog count mismatch); it never includes response bodies, account IDs, or credentials. A fixture reproduces a virtual playlist with no revision.
- Spotify progress now retains a validated scan phase. If the page reports an auth refresh after HTTP 401 but the bridge never delivers a terminal result, the worker ends that scan after 20 seconds with a session-specific instruction instead of waiting for the generic two-minute watchdog. A worker fixture covers this lost-terminal-event path.
- These code and fixture changes still need live confirmation after the unpacked extension is reloaded. The Yandex reader remains fail-closed until it has enough evidence to prove playlist completeness.

## 2026-10-30 — preserve verified Yandex likes on playlist failure

- After Yandex confirms the full liked-track list and its revision, the page now sends a separately validated favorites snapshot before reading playlists. The worker stores this under a partial snapshot slot; it never promotes it to a complete library. Duplicate/missing IDs, bad positions, or a count mismatch reject the partial payload.
- If playlist discovery or any playlist read fails and there is no earlier complete snapshot, the app exposes the partial source with a warning and restricts the collection selector to the single option «Только подтверждённые лайки». The selected transfer plan contains a confirmed favorites collection and no playlist mappings. An earlier complete snapshot remains preferred if one exists. A later complete scan replaces and removes the partial copy.
- Reader, bridge, worker validation/storage, app selection, transfer-plan fixtures, and UI scope tests pass. This is fixture evidence only; the live Yandex error has not yet been retested in the user's existing Chrome profile.

## 2026-10-30 — responsive, contrast, and stage accessibility pass

- A temporary Chrome profile rendered the local UI with six demo tracks. At CSS viewport widths 320, 375, 390, 820, 821, 900, 960, and 1280 px, document/body widths matched the viewport and no track row exceeded its card. The sidebar stacks before the track grid becomes cramped.
- Dark and light mobile views at 390 × 844 were visually inspected. At 320 px, all five workflow labels fit and remain visible; the active step is exposed with `aria-current="step"`. The app updates that attribute as the workflow advances, covered by `tests/ui-accessibility.test.js`.
- Light-theme search text measured 6.52:1 against white; the disabled light-theme primary action measured 6.83:1. The dark-theme disabled action now has its own muted color pair instead of fading text and background together.
- Full fixture suite: **328/328 passed**. JavaScript syntax, manifest JSON, generated extension bundle parity, and `git diff --check` passed.
- These are local UI and simulated connector checks. The temporary profile had no provider sessions; no account data or credentials were read and no account was written. Live service scans and route read-back remain outstanding.
- Read-only inspection of the native Chrome front window found only `about:blank`. A harmless `1+1` AppleScript probe was rejected because Chrome's **View → Developer → Allow JavaScript from Apple Events** setting is disabled. I left the setting unchanged; no live provider page or session was inspected.

## 2026-10-30 — final resilience and responsive smoke checks

- The hero artwork now sits below the copy on narrow screens while the text fills the available width. Disabled provider buttons and inactive steps use muted colors instead of success green.
- In an isolated temporary Chrome profile, the UI was measured at 320 px and 390 px CSS viewport widths. At both widths, document and body scroll widths matched the viewport and no element extended past the right edge. A dark-theme 390 × 844 screenshot was visually inspected.
- The full fixture suite passed **327/327**. JavaScript syntax checks, manifest JSON validation, generated extension app bundle parity, and `git diff --check` passed.
- The fixtures cover provider pagination and completeness, timeout/rate-limit/error recovery, checkpoint recovery, and synthetic favorite/playlist transfer across all 12 provider directions. They do not prove behavior against today's authenticated service sessions.
- No account session, cookie, token, or library data was accessed in these checks, and no account was written. Live library reads and source-to-target read-back remain unverified in this pass.

## 2026-10-30 — visual layout check

- The demo UI was rendered in a temporary headless Chrome profile in light and dark desktop modes, then measured at actual 320 px and 390 px CSS viewports through the Chrome DevTools Protocol.
- At both narrow widths, `documentElement.scrollWidth` and `body.scrollWidth` matched the viewport and no element extended outside it. A 390 × 844 screenshot was visually inspected; source cards stack, the notice wraps, and the theme control stays visible.
- This verifies layout only. It did not load an extension context or read provider accounts.


## 2026-10-30 — provider error isolation regression check

- A failed Chrome tab query for one provider now yields that provider's own `failed` status while the response still contains statuses for the other three. A fault-injection fixture verifies the failure is isolated and does not reject the aggregate scan response.
- Full fixture suite: **327/327 passed** on Node.js 24.22.1. JavaScript syntax, manifest JSON, extension bundle parity, and `git diff --check` passed.
- No provider session was read and no account was written in this check. Live account verification still requires the permitted read-only Chrome DOM access and separate route-specific write/read-back evidence.

## 2026-10-30 — recovery and playlist consistency regression checks

- Transfer-job progress and finish now update the record in one IndexedDB read/write transaction. A deliberately delayed old-style progress write fixture verifies that a terminal `complete` status and its plan cleanup cannot be overwritten by late progress.
- Zvuk playlist capture now compares IDs at overlapping positions. Conflicting page snapshots keep the collection in `needs_review`; matching overlaps and intentional repeated tracks at different positions remain valid.
- Full fixture suite: **326/326 passed** on Node.js 24.22.1. Extension app bundle check passed.
- Chrome had the Music Importer extension page and all four provider page origins open. A read-only status refresh was not run: this Chrome profile has JavaScript-from-Apple-Events disabled, and I left that security setting unchanged. Tabs alone do not prove an active login or a successful library scan.
- No provider account data was read or written in this pass. The prior live read evidence below remains the 2026-10-28 observation; no source→target route has live write/read-back evidence.

## 2026-10-28 — stale Apple bridge recovery

- Version `0.13.43` upgrades all provider bridge health replies to protocol 3. Tabs still running a protocol 2 content script now fail the health check and are reloaded automatically on extension install/update or before the next read/write command.
- Version `0.13.44` also checks and repairs provider bridge health every time the extension-hosted app opens, before scanning accounts. This covers stale bridge tabs even when the install/update event did not repair them. Old `Extension context invalidated` entries already recorded in Chrome's error log remain historical; active errors from a stale page are cleared when the extension reloads that provider tab.
- Version `0.13.45` waits for a provider tab's initial navigation to complete before checking its bridge, preventing a new background tab from being mistaken for an invalidated extension context. The matcher also keeps an exact-ISRC candidate in manual review when title/artist strongly conflict or duration differs by over 20 seconds. Fixture coverage added; live catalog accuracy remains unmeasured.
- Version `0.13.46` also rejects Apple library snapshots whose paginated song or playlist catalog repeats an ID, even when the response row count still equals `meta.total`. Repeated IDs inside playlist contents remain valid and preserve order. Synthetic overlap fixtures added; this has not been measured against live Apple pagination.
- Version `0.13.47` makes each provider bridge schedule one page reload when it detects an invalidated extension context, and absorbs that runtime messaging error. This prevents a stale bridge from continuing to emit the uncaught exception after its first failed message. Fixture tests cover synchronous exceptions and rejected runtime messages; Chrome must load this version before the behavior can be observed live.
- Version `0.13.48` requires a stable Yandex playlist `revision` across paginated reads and keeps unexplained extra artist credits in matcher review, including when the ISRC matches exactly. Legitimate featured credits declared in the title or artist field still qualify for automatic matching. Regression fixtures cover both cases; no new live account read or transfer was performed.
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

## 2026-10-28 — Apple bridge report and local server check

- `127.0.0.1:8001` is served by Python `http.server` PID 20084 from `/Users/basil/Code/music_importer-mvp/demo`; it serves the static UI and is not a backend.
- The current Apple Music tab's captured console snapshot contained no active errors. The user's pasted `apple-bridge.js` still shows a direct `chrome.runtime.sendMessage(...).then(...)`, which differs from the guarded bridge in manifest `0.13.48`. This points to an older injected content script, an older unpacked extension copy, or a historical Chrome error entry.
- Current source handles synchronous and rejected runtime-message failures and schedules one provider-tab reload. The extension also checks bridge health on app launch and before commands; when its new code is installed, stale provider tabs are repaired automatically. Chrome must load the new unpacked extension files once for this recovery code to become active.
- The extension can open missing service pages in the background. The pages still need to be open during account reads because content scripts run in each signed-in provider page's context. Apple reads paginated library songs and playlist tracks, using `inFavorites` to select likes. Zvuk observes its signed-in page's GraphQL responses and pagination/scroll events for favorites and playlists. Only normalized music metadata is sent to extension storage; session headers remain within Apple page memory.
- Focused bridge and reader-recovery fixtures pass 59/59; extension app bundle synchronization and `git diff --check` pass. No live library refresh or account write was run during this check.

## 2026-10-31 — read-only refresh in the user's existing Chrome

- Used the already-open Chrome profile and the `http://127.0.0.1:8001/` app. The refresh read provider libraries only; it did not select a destination, search the catalog, or write to an account. No separate Chrome profile was created.
- Port 8001 was Python's static `http.server`, serving `/Users/basil/Code/music_importer/demo` (PID 6432 during this check); no application backend was running.
- Apple Music completed and the app displayed a newly refreshed full snapshot. Spotify reached its reported Liked Songs page count but then timed out after two minutes without progress; its incomplete snapshot was discarded. Yandex finished reading likes but the full library was rejected because a playlist's catalog count did not match the playlist evidence. These are UI observations only; the exact account metadata and counts are intentionally omitted.
- Zvuk again ended with the sanitized message that loading stopped before the next page. The newly implemented collection cursor replay has fixture coverage but is not yet confirmed against the authenticated live page. The account/API cause is unknown.
- The full local test suite passed **352/352**. No live search, transfer, or read-back was run, so successful source-to-target operation remains unverified. No cookies, tokens, authorization headers, or raw service responses were read or recorded.

## 2026-10-31 — provider scan recovery fixes

- Yandex now treats the count from `/playlists/list` as advisory when playlist detail supplies its own count. Detail revision, pager totals, page sequence, and final hydrated track count still have to agree. A multi-page virtual-playlist fixture covers the stale list count; this fix has not yet been loaded into Chrome for live retest.
- Spotify scan-stage progress and final snapshot/error delivery now wait for a service-worker acknowledgment. Shared reader helpers route status to transfer checkpoints during target read-back, avoiding scan/transfer phase confusion. A lost final snapshot acknowledgment does not trigger a second `scan-error`, because the worker may already have committed the snapshot. Bridge, reader, and transfer fixtures cover accepted, rejected, late, and invalidated-context paths; no new live Spotify scan has been run.
- Zvuk now walks playlist and saved-release cursors independently, replaying each with only its corresponding `withPlaylists` or `withReleases` flag. A release-only response uses the root cursor for releases and cannot accidentally claim playlist pagination. Fixtures cover distinct cursors and release-only root pagination; live API behavior remains unconfirmed.
- Final local verification: `node --test --test-concurrency=1 --test-reporter=spec tests/*.test.js` passed **361/361**. Bundle parity, JavaScript syntax, manifest JSON, and `git diff --check` also passed. These are local fixtures/unit checks; they do not establish live service scanning or transfers.
- No account writes or reads were run after these code changes. The existing Chrome extension still needs a manual reload before any live retest.

## 2026-10-31 — Spotify transfer fails fast after an unverified like

- Spotify now stops before creating or appending any playlist when a requested favorite is missing from the immediate read-back. The partial report preserves favorite counts and leaves `playlists` empty so the user can retry safely without extra writes.
- A mixed-plan fixture makes the favorite write appear successful while the subsequent library read omits it, then asserts no playlist creation, append, or read request occurs.
- Focused Spotify target tests pass **10/10**; the full suite passes **365/365**. `git diff --check` passes. This is fixture verification only; no live Spotify account write was performed.
