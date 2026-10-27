# Перенос музыки

Локальный прототип переноса. Цель — лайки и плейлисты в любом направлении между Spotify, Apple Music, Яндекс Музыкой и Звуком. Сейчас локально читаются библиотеки Звука, Spotify и Яндекс Музыки; экспериментальный Yandex search/write/read-back путь добавлен и проверен fixture-тестами, но не live-аккаунтом. Apple Music пока доступен как каталог для preview-плана; target adapters Spotify и Звука ещё не подключены.

## Быстрый старт

```bash
python3 -m http.server 8000 --bind 127.0.0.1 --directory demo
```

Откройте <http://127.0.0.1:8000>. Сервер нужен для поиска Apple и связи с расширением; при открытии HTML напрямую браузер может заблокировать сетевые запросы.

Для чтения библиотек и записи через аккаунтную сессию загрузите `chrome-extension/` через `chrome://extensions` → **Режим разработчика** → **Загрузить распакованное расширение**. После обновления кода нажмите **Обновить** у расширения и перезагрузите вкладки сервиса и локального приложения. Поддерживаются адреса `127.0.0.1`/`localhost` на портах 8000 и 8001.

Запускайте сервер из checkout ветки `feature/interactive-importer-mvp`. Если параллельно переключаете основную папку проекта на ветку исследования, держите MVP в отдельном Git worktree: при переключении ветки каталог `demo/` исчезает из checkout, и оставшийся сервер начинает отвечать `404`.

Можно загрузить CSV/JSON или читать библиотеку из открытой сессии Звука, Spotify или Яндекс Музыки. Цель выбирается отдельно: Apple Music создаёт только preview-план; Яндекс Музыка выполняет экспериментальный импорт лайков и playlist tracks после отдельного подтверждения, создаёт приватные плейлисты и сверяет запись. Неоднозначные совпадения остаются в review.

Поддерживаемый CSV: обязательные `title,artist`, дополнительные `album,isrc,duration_ms,id` (также понимаются `Track Name,Artist Name(s)` и русские `название,исполнитель`; разделители запятая, точка с запятой или табуляция). JSON — массив объектов с `title`/`artist` либо `tracks`, `items` или `data` с таким массивом. Для объектов с вложенным `track` поля также распознаются. Общая provider-neutral модель snapshot/plan находится в [`demo/transfer-core.js`](demo/transfer-core.js), общий контракт поиска и постраничного чтения — в [`demo/transfer-engine.js`](demo/transfer-engine.js), контракт account adapters — в [`docs/ADAPTER_CONTRACT.md`](docs/ADAPTER_CONTRACT.md). Yandex writer использует вкладку с активной сессией, не читает и не сохраняет токены, требует подтверждённый полный snapshot и явное согласие перед записью.

Это ещё не готовый универсальный перенос. Yandex routes — неофициальный private API; writer собран по community clients и fixture-tested, но live mutation, page-context CORS, реальные playlist revision conflicts и read-back ещё не проверялись. Apple остаётся preview-only; Spotify/Zvuk writers и Apple account adapter отсутствуют. Полный any-to-any scope и статус 12 направлений ведутся в [матрице возможностей](https://github.com/Basil-AS/music_importer/blob/feature/music-service-api-research/docs/TRANSFER_CAPABILITY_MATRIX.md).

Подробности сценария и границ прототипа: [`docs/MVP.md`](docs/MVP.md). Правила сопоставления и ограничения confidence: [`docs/MATCHING.md`](docs/MATCHING.md).

Локальное расширение находится в [`chrome-extension/`](chrome-extension/). Коннекторы и ограничения: [Zvuk](docs/ZVUK_CONNECTOR.md), [Spotify](docs/SPOTIFY_CONNECTOR.md), [Яндекс](docs/YANDEX_CONNECTOR.md), [Яндекс target writer](docs/YANDEX_TRANSFER.md). Ни один из 12 маршрутов ещё не прошёл проверенный end-to-end live transfer; Yandex write flow пока проверен только изолированными fixtures.
