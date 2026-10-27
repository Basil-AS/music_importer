# Перенос музыки

Локальный прототип переноса. Цель — лайки и плейлисты в любом направлении между Spotify, Apple Music, Яндекс Музыкой и Звуком. Экспериментальные локальные readers есть для всех четырёх сервисов. Apple Music, Яндекс Музыка и Звук получили fixture-tested target writers; Spotify writer ещё не подключён. Live-перенос через установленное расширение пока не подтверждён.

## Быстрый старт

```bash
python3 -m http.server 8000 --bind 127.0.0.1 --directory demo
```

Откройте <http://127.0.0.1:8000>. Сервер нужен для поиска Apple и связи с расширением; при открытии HTML напрямую браузер может заблокировать сетевые запросы.

Для чтения библиотек и записи через аккаунтную сессию загрузите `chrome-extension/` через `chrome://extensions` → **Режим разработчика** → **Загрузить распакованное расширение**. После обновления кода нажмите **Обновить** у расширения и перезагрузите вкладки сервиса и локального приложения. Локальная страница показывает, подключилось ли расширение, и отключает чтение вне Chrome. Поддерживаются адреса `127.0.0.1`/`localhost` на портах 8000 и 8001.

Запускайте сервер из checkout ветки `feature/interactive-importer-mvp`. Если параллельно переключаете основную папку проекта на ветку исследования, держите MVP в отдельном Git worktree: при переключении ветки каталог `demo/` исчезает из checkout, и оставшийся сервер начинает отвечать `404`.

Можно загрузить CSV/JSON или читать библиотеку из открытой сессии любого из четырёх сервисов. Перед чтением откройте соответствующий сервис в Chrome и выберите его как источник. Цель выбирается отдельно: Apple Music, Яндекс Музыка и Звук имеют экспериментальные write paths после отдельного подтверждения; записи сверяются обратным чтением. Для поиска и записи нужен установленный extension и открытая авторизованная вкладка выбранного сервиса. Неоднозначные совпадения остаются в review. См. [Apple source connector](docs/APPLE_CONNECTOR.md), [Apple target writer](docs/APPLE_TRANSFER.md) и [Zvuk target writer](docs/ZVUK_TRANSFER.md).

Поддерживаемый CSV: обязательные `title,artist`, дополнительные `album,isrc,duration_ms,id` (также понимаются `Track Name,Artist Name(s)` и русские `название,исполнитель`; разделители запятая, точка с запятой или табуляция). JSON — массив объектов с `title`/`artist` либо `tracks`, `items` или `data` с таким массивом. Для объектов с вложенным `track` поля также распознаются. Общая provider-neutral модель snapshot/plan находится в [`demo/transfer-core.js`](demo/transfer-core.js), общий контракт поиска и постраничного чтения — в [`demo/transfer-engine.js`](demo/transfer-engine.js), контракт account adapters — в [`docs/ADAPTER_CONTRACT.md`](docs/ADAPTER_CONTRACT.md). Yandex writer использует вкладку с активной сессией, не читает и не сохраняет токены, требует подтверждённый полный snapshot и явное согласие перед записью.

Это ещё не готовый универсальный перенос. Yandex и Zvuk используют частные API; их mutations и read-back проверены на fixtures, но не на живом аккаунте. Apple source/target code fixture-tested, но live account scan/write пока не проверены. Spotify writer отсутствует. Полный any-to-any scope и статус 12 направлений ведутся в [матрице возможностей](https://github.com/Basil-AS/music_importer/blob/feature/music-service-api-research/docs/TRANSFER_CAPABILITY_MATRIX.md).

Подробности сценария и границ прототипа: [`docs/MVP.md`](docs/MVP.md). Правила сопоставления и ограничения confidence: [`docs/MATCHING.md`](docs/MATCHING.md).

Локальное расширение находится в [`chrome-extension/`](chrome-extension/). Коннекторы и ограничения: [Zvuk source](docs/ZVUK_CONNECTOR.md), [Zvuk target](docs/ZVUK_TRANSFER.md), [Spotify](docs/SPOTIFY_CONNECTOR.md), [Apple Music source](docs/APPLE_CONNECTOR.md), [Apple Music target](docs/APPLE_TRANSFER.md), [Яндекс source](docs/YANDEX_CONNECTOR.md), [Яндекс target](docs/YANDEX_TRANSFER.md). Ни один из 12 маршрутов ещё не прошёл end-to-end live transfer.
