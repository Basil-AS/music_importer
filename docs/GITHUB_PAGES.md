# GitHub Pages hosting

The app is static and has no project backend, so GitHub Pages can serve the UI without owning Spotify, Apple Music, Yandex Music, or Zvuk OAuth credentials. User libraries and account requests stay in the browser extension and the signed-in provider tabs. The public site contains only the app files.

## Deployment

The repository currently has no Pages site configured. The workflow in `.github/workflows/deploy-pages.yml` uploads the `demo/` directory and deploys only after a push to GitFlow release branch `master`. After this PR is merged through `develop` and a release is merged to `master`, enable **Settings → Pages → Build and deployment → Source: GitHub Actions**. The expected project URL is `https://basil-as.github.io/music_importer/`.

No public deployment has been triggered from this feature branch. GitHub Pages makes the app files public; it does not publish user libraries. Every user still needs to install the local extension and grant its host access to `basil-as.github.io` as well as the four provider sites. Chrome may show a new permission warning after extension update `0.10.0` because the extension can now inject its local-app bridge on the project Pages path. Its match pattern is limited to `/music_importer/*`.

## Local alternative

The app can still run locally with `python3 -m http.server 8001 --bind 127.0.0.1 --directory demo`. The same extension supports this local origin. The local path avoids relying on Pages availability but requires Python and a running server.

## Limits

GitHub Pages removes the Python server step. It does not remove extension installation, provider sign-in, or live connector verification. All 12 directed transfers remain experimental until each route has been tested with real account snapshots and a small write/read-back.
