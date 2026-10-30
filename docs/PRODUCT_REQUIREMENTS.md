# Product requirements: cross-service music importer

This document records the product scope requested by Basil. It is the acceptance
criteria for MVP work; an Apple Music-only importer or a fixture-only route matrix
does not satisfy the product goal.

## User outcome

The user opens the importer, signs in to their own music accounts through the
services' ordinary login pages, and can move their library between the supported
services without creating developer apps or accounts owned by the importer
author. The user must not have to provide a password to the importer.

## Supported services and direction

The initial services are Apple Music, Spotify, Yandex Music, and Zvuk. The
product must support every source-to-target pair between different services:

| Source | Apple Music | Spotify | Yandex Music | Zvuk |
| --- | --- | --- | --- | --- |
| Apple Music | — | required | required | required |
| Spotify | required | — | required | required |
| Yandex Music | required | required | — | required |
| Zvuk | required | required | required | — |

That is 12 directed routes. A route counts as supported only after it can read
the source account, build a transfer plan, write the destination account, and
verify the result by reading it back. Unit fixtures alone do not count as a
working route.

## Collections and library discovery

- Read liked/favorite tracks and user playlists from every connected account.
- Discover all available libraries automatically after the user connects or
  opens an account; do not require a manual export for the normal path.
- Preserve playlist membership, order, repeated entries, and empty playlists
  where the destination service supports them.
- Keep likes separate from playlist entries so both can be transferred in one
  mixed-library operation.
- Show collection completeness and report unavailable or partial collections
  instead of silently treating them as complete.

## Matching and scale

- Automatically match high-confidence tracks using identifiers such as ISRC,
  version-aware title/artist metadata, album, and duration.
- Reuse one match for duplicate source tracks while preserving every playlist
  occurrence and order.
- Leave ambiguous and missing matches in an exception queue; do not require the
  user to review thousands of ordinary, confidently matched tracks one by one.
- Expose bulk progress, rate-limit pauses, cancellation, resumable checkpoints,
  and a final report for large libraries.
- Measure false-match rate and provider request limits on representative,
  consented account data before lowering automatic-match thresholds.

## Sign-in, privacy, and delivery

- Prefer normal sign-in in the user's browser and reuse only the active service
  session needed for that user's requested read/write operation.
- Never ask the user to paste passwords, cookies, or bearer tokens into the app;
  never send their library or session credentials to an importer backend.
- Explain any required browser extension clearly. A static GitHub Pages app by
  itself cannot read another site's account session; use a local browser
  connector when the service offers no suitable user-facing API.
- Do not require an OAuth developer app owned by the importer author when a
  user-session integration can deliver the same user-controlled workflow.
- Require an explicit final confirmation before writing to a destination
  account and verify writes through destination read-back.

## Evidence gates

Track each service adapter and each directed route independently. Record the
authentication surface, read endpoints, pagination/completeness signal, catalog
search behavior, write operations, rate limits, and read-back evidence. Keep
fixtures, observed browser behavior, public API guarantees, and live account
results clearly distinguished.

Current status is in [`TRANSFER_CAPABILITY_MATRIX.md`](TRANSFER_CAPABILITY_MATRIX.md):
all four services have experimental adapters in the code, but none of the 12
routes is yet verified end to end against live accounts. Therefore the current
implementation is a prototype, not a completed cross-service importer.
