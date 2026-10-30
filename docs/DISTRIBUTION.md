# Distribution and first-run setup

## Product constraint

The importer reads and writes music libraries through the user's authenticated service tabs. A normal GitHub Pages page cannot inject code into Spotify, Apple Music, Yandex Music, or Zvuk pages because of browser origin isolation. Keep the transfer core in a local Chrome extension; do not ask users to create provider OAuth apps or give the project their passwords/tokens.

## Available paths

| Path | User effort | Cost/constraint | Status |
| --- | --- | --- | --- |
| GitHub Pages only | Open a link | Cannot read other services' tabs or sessions on its own | Useful for documentation/landing page, not the account connector |
| Unpacked Chrome extension from CI artifact | Download/extract, enable Developer Mode, choose the extension folder once | No store registration fee; user must load an unpacked extension and updates are manual | Current no-cost path; CI packages the extension and macOS helper |
| Microsoft Edge Add-ons | One-click install inside Edge | Microsoft documents no registration fee; requires a Microsoft account, developer enrollment, listing details, and store review. The user installs/runs Edge instead of Chrome. | Free-store candidate; CI now also packages a ZIP with `manifest.json` at the archive root. Edge compatibility, store submission, and live account routes are not yet verified |
| Chrome Web Store | Install from a listing | Chrome requires developer account registration with a one-time fee; publication needs a ZIP with root `manifest.json`, listing assets, accurate privacy policy and prior user-data disclosures, plus review | Not submitted; requires the user's explicit choice to pay/register and publish |

Chrome's official [developer registration guide](https://developer.chrome.com/docs/webstore/register/) says a one-time registration fee is required before publishing. Its [preparation guide](https://developer.chrome.com/docs/webstore/prepare) requires a ZIP with the manifest at its root, icons, a description of up to 132 characters, and listing assets. The [program policies](https://developer.chrome.com/docs/webstore/program-policies/policies) require an accurate privacy policy for products handling user data and clear, prior disclosure of collection/use/sharing, including data processed locally. A current implementation-based disclosure is in [`demo/privacy.html`](../demo/privacy.html); the Pages workflow copies `demo/` as the static site root. Store review is also required before a release becomes available.

## Current no-cost onboarding

The CI workflow uploads `music-importer-chrome-extension` for 30 days. The archive contains `chrome-extension/` and `INSTALL-MACOS.command`; the helper opens Chrome's extension manager and the extracted folder but leaves the Developer Mode and “Load unpacked” actions to the user. After the first load, the extension opens its own full UI and scans open provider tabs. It does not require a localhost permission for the main flow. See [README quick start](../README.md) and [MVP checks](MVP.md).

This is the best current path that preserves the zero-cost constraint and avoids a developer-owned OAuth application. It is still a manual first install, so it does not yet meet the ideal “open a link and everything is ready” onboarding. For broad public use with a one-click install, either the user accepts the Web Store registration/publishing path or the product must target another distribution model/browser; a static website alone cannot replace the extension's cross-origin access.

## No-fee one-click candidate: Microsoft Edge

Microsoft's [Edge developer account guide](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/create-dev-account) states there is no registration fee for submitting extensions. Edge is Chromium-based and Microsoft's [migration guidance](https://learn.microsoft.com/en-us/microsoft-edge/extensions/) says existing Chrome extensions can be submitted, subject to API compatibility. The CI artifact now contains `music-importer-edge-addons.zip` with `manifest.json` at its root, alongside the unpacked Chrome package. This is only a packaging step: we still need to load and exercise the extension in Edge, complete a live read-only scan, prepare store listing assets/privacy details, and obtain explicit authorization before submitting a public listing. A store listing identifies its publisher account; this changes extension distribution, not the provider sign-in model or account ownership.
