# Перенос музыки

Локальный прототип переноса. Цель — лайки и плейлисты в любом направлении между Spotify, Apple Music, Яндекс Музыкой и Звуком. Сейчас есть локальное read-only чтение Звука, экспериментальные readers Spotify/Яндекс из браузерных сессий и поиск в каталоге Apple; записи в аккаунты назначения пока нет.

## Быстрый старт

```bash
python3 -m http.server 8000 --bind 127.0.0.1 --directory demo
```

Откройте <http://127.0.0.1:8000>. Сервер нужен для поиска в каталоге Apple; при открытии HTML напрямую браузер может заблокировать сетевой запрос.

Запускайте сервер из checkout ветки `feature/interactive-importer-mvp`. Если параллельно переключаете основную папку проекта на ветку исследования, держите MVP в отдельном Git worktree: при переключении ветки каталог `demo/` исчезает из checkout, и оставшийся сервер начинает отвечать `404`.

Можно загрузить демо-данные, CSV/JSON или читать библиотеку из уже открытой сессии Звука/Spotify через локальное Chrome-расширение. Затем искать версии в каталоге Apple и автоматически принимать только очевидные совпадения. Поиск передаёт Apple названия и исполнителей.

Поддерживаемый CSV: обязательные `title,artist`, дополнительные `album,isrc,duration_ms,id` (также понимаются `Track Name,Artist Name(s)` и русские `название,исполнитель`; разделители запятая, точка с запятой или табуляция). JSON — массив объектов с `title`/`artist` либо `tracks`, `items` или `data` с таким массивом. Для объектов с вложенным `track` поля также распознаются. Общая provider-neutral модель snapshot/plan находится в [`demo/transfer-core.js`](demo/transfer-core.js), общий контракт поиска и постраничного чтения — в [`demo/transfer-engine.js`](demo/transfer-engine.js), контракт account adapters — в [`docs/ADAPTER_CONTRACT.md`](docs/ADAPTER_CONTRACT.md). Они принимают ID четырёх сервисов, сохраняют playlist order и различают целевые действия likes/playlists. Apple catalog search подключён; source read-only connectors есть для Звука и экспериментально для Spotify. Yandex/Apple account adapters и любые target writes пока не подключены.

Это не готовый универсальный перенос. Spotify и Яндекс readers используют private web API и экспериментальны; live account scan для них ещё не подтверждён. Apple account adapter, все destination adapters и записи в пользовательские библиотеки отсутствуют. JSON пока является планом, не выполненным переносом. Подробный статус направлений — в [матрице возможностей](https://github.com/Basil-AS/music_importer/blob/feature/music-service-api-research/docs/TRANSFER_CAPABILITY_MATRIX.md).

Подробности сценария и границ прототипа: [`docs/MVP.md`](docs/MVP.md). Правила сопоставления и ограничения confidence: [`docs/MATCHING.md`](docs/MATCHING.md).

Локальное расширение находится в [`chrome-extension/`](chrome-extension/). Коннекторы Звука, экспериментальный Spotify flow и экспериментальный Яндекс reader описаны в [`docs/`](docs/): [Zvuk](docs/ZVUK_CONNECTOR.md), [Spotify](docs/SPOTIFY_CONNECTOR.md), [Яндекс](docs/YANDEX_CONNECTOR.md). Spotify/Yandex live account scan не проверялся через установленное расширение; Apple Music как аккаунтный источник/назначение и все target writes остаются впереди.
