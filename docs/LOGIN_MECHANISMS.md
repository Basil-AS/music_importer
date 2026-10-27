# Пользовательский вход без авторских аккаунтов разработчика

Сверка на 27.10.2026. Цель: дать пользователю понятную кнопку «Подключить», не принимать у него пароль и не требовать от него OAuth app ID. Здесь различаются три вещи: вход человека на сайт провайдера, разрешение приложению читать данные и способ передать эти данные локальному импортёру.

## Вывод

Расширение для браузера может сделать для Звука тот же простой сценарий, который визуально предлагает токен-расширение Яндекс Музыки: пользователь уже вошёл у провайдера, нажимает «Подключить», видит свой список, а приложение получает библиотеку. Для Звука это не требует OAuth регистрации: сайт сам выдаёт веб-сессии профильный токен, а web API принимает cursor-запросы коллекции.

При этом не нужно копировать общий токен или cookie в поле приложения. Лучше, чтобы маленький source-specific connector выполнял запросы только на открытом домене провайдера и передавал локальному companion нормализованный список `{provider, id, title, artists, album, isrc?, likedAt?}`. Такой мост работает локально и не связывает учётную запись пользователя с сервером Basil-AS. Он всё ещё зависит от частного веб-контракта, если провайдер не публикует OAuth/API для этого сценария.

| Сервис | Официальный login без credentials разработчика | Уже существующая browser session | Практический вывод |
|---|---|---|---|
| Spotify | Нет для user-specific Web API: OAuth app/client ID нужен; PKCE убирает client secret из desktop/browser клиента, но не регистрацию приложения. | Web Player можно использовать как private connector: MIT helper получил user-bound bearer через `sp_dc` + актуальный TOTP. | Получение bearer без app credentials подтверждено. У нового bearer проверка `/v1/me/tracks?limit=1` ответила 429, поэтому Saved Tracks scope этим токеном ещё не доказан; не повторять без учёта `Retry-After`. Pathfinder Liked Songs чтение другим bearer подтверждалось отдельно. Private connector удобен для локального UX, но остаётся нестабильным; архив — ручной резервный путь. См. [подробности и безопасный probe](providers/spotify.md#повторное-получение-web-player-bearer-из-sp_dc). |
| Яндекс Музыка | Нет для OAuth: нужно зарегистрированное OAuth app и scopes. | Да: ранее выбранная Chrome cookie-session дала `200` на read-only account status и likes endpoints без OAuth app ID. В `yandex-music-downloader` extension hook перехватывает `Authorization` из запросов сайта. | Самый короткий no-app путь — connector в уже авторизованном контексте. Не копировать `yandex-music-token` redirect с общим app ID/широкими scopes или постоянное сохранение токена из downloader extension; лучше вернуть только нормализованные лайки. |
| Звук | Публичный OAuth/developer flow не обнаружен. | Да: web session, `/api/tiny/profile` или `/api/v2/tiny/profile`, затем `getPaginatedCollection(limit, after)`; browser и временный terminal replay уже вернули страницы `200`. V2 профиль содержит `result.profile.token`. | Хороший кандидат для первого настоящего connector: работать только на origin `zvuk.com` в активной сессии, читать cursor-страницы и передавать только коллекцию; не экспортировать cookies/session token. API private и может меняться. |
| Apple Music | MusicKit официальный, но MusicKit JS должен быть настроен developer token приложения; пользователь затем явно разрешает доступ и MusicKit автоматически добавляет Music User Token. | Веб-сайт использует собственную сессию, но копирование web-player credentials в импортёр — частный, неподдерживаемый путь. | Для API путь зависит от developer credentials. На этом Mac исследуется отдельный локальный путь через Music.app; запись в Favorite Songs и read-back ещё не проверены вживую. |

## Как должно выглядеть расширение

1. **Локальное приложение** запускается на устройстве; показывает список источников и принимает результат импорта.
2. **Пользователь открывает сайт сервиса и входит там.** Импортёр не получает пароль, OTP или recovery-код.
3. Пользователь нажимает кнопку расширения **«Прочитать мои лайки»** для текущего сайта. Разрешение ограничено активной вкладкой и выдано явно на это действие.
4. Адаптер выполняет только read-only запросы нужного API, обходит cursor-пагинацию, дедуплицирует по provider ID и отдаёт track metadata локальному приложению через Native Messaging. Значения auth заголовков/cookies не входят в message payload.
5. Companion нормализует и хранит экспорт локально, показывает count/reconciliation и предлагает ручную проверку совпадений до любых записей в Apple Music.

Для Chrome технически есть узкий permission pattern: `activeTab` + `scripting`, запуск content script по нажатию пользователя, затем message passing. Chrome разрешает inject-скрипт в текущую вкладку и получить результат без постоянного доступа ко всем сайтам; если расширение вместо этого просит `cookies` permission и широкие `host_permissions`, разрешения существенно сильнее. Уточнять механику нужно по актуальной документации Chrome и каждому сервису отдельно. См. [activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab), [Scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting) и [Chrome permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions).

Распространение — отдельный UX-барьер: публикация в Chrome Web Store требует аккаунт разработчика и разовую плату. Без неё проект можно бесплатно раздавать исходниками/архивом, но пользователь должен включить Developer mode в `chrome://extensions` и нажать **Load unpacked**. Это нормальный исследовательский/MVP путь, но не одношаговая установка для широкой аудитории. См. [регистрацию CWS](https://developer.chrome.com/docs/webstore/register/) и [официальную установку unpacked extension](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked).

### Почему не нужен «универсальный перехватчик токенов»

- Для чтения можно выполнить запрос в контексте сайта и вернуть только библиотеку. Отдельный перенос bearer token увеличивает последствия утечки и усложняет отзыв доступа.
- Cookie jar всей системы не нужен: он может включать входы в почту, платежи и другие сайты. Разрешение должно охватывать только конкретный музыкальный домен и одну операцию.
- У Яндекса есть три разных паттерна. `MarshalX/yandex-music-token` включает Device Code Flow в статическом web app, но использует общий OAuth app с широкими правами и открытым в публичном JS client secret; его password fallback отправляет введённые credentials напрямую Яндексу, а extension OAuth flow пересылает token Telegram-боту. `vladimir120307-droid/yandex-music-downloader` перехватывает Authorization из запросов уже открытой страницы и сохраняет его в extension storage. Для импортёра не нужны ни эти широкие scopes, ни token extraction/persistence: connector должен вернуть только список треков.
- Если запросы надо выполнять вне вкладки, переходить на более привилегированный background host access только после подтверждения, что same-origin content script этого не может. Секреты никогда не должны попадать в query string, telemetry, crash logs, history или репозиторий.

## Статус прототипируемости по провайдерам

| Connector | Read-only источник | Нужно доказать перед реализацией |
|---|---|---|
| Zvuk | `GET /api/tiny/profile` для профиля и `POST /api/v1/graphql` с `getPaginatedCollection(limit: 30, after: cursor)`; cursor loop уже прошёл из Chrome и терминала. См. [полный инвентарь](providers/zvuk-api-inventory.md). | Проверить отсутствие подписки; повторить reconciliation на новом проходе; связать локальное расширение с companion без передачи bearer. |
| Яндекс | `GET /account/status`, `GET /users/{uid}/likes/tracks`; уже подтверждён cookie-session read в терминале. См. [provider note](providers/yandex-music.md). | Выяснить стабильный способ получить минимальные auth context прямо из страницы и избежать чтения общего Chrome cookie database. Проверить revision sentinel и объём ответа. |
| Spotify | Web Player private API или DOM/session adapter; официальный fallback — OAuth PKCE и архив аккаунта. См. [provider note](providers/spotify.md). | Сверить действующую политику Web API и документацию web connector; проверить полную пагинацию и поведение session expiry. Не встраивать маскировку automation. |
| Apple | MusicKit user consent с developer token или локальный Music.app automation route. См. [provider note](providers/apple-music.md). | Определить, может ли Music.app добавить и выставить именно `favorited` у найденного каталожного трека; проверить обратное чтение после одной тестовой записи. |

## Проекты и UX-референсы

- [Spotify2Yt](https://github.com/OleksandrS23/Spotify2Yt): локальный persistent browser profile, login на Spotify web и экспорт liked tracks; только Spotify → YouTube Music. Source review уже находится в [PROJECTS.md](PROJECTS.md).
- [Songport](https://github.com/xlollx/Songport): local-first Android aggregator, содержит official OAuth и отдельные Web connector implementations; нет Яндекс Музыки/Звука и нужного Apple Favorite Songs target.
- [SongMirror](https://github.com/ahnafnafee/songmirror): self-hosted transfer UI и ручные web credentials в части connector’ов; Apple library access зависит от платного CloudLibrary. Статический review записан в [PROJECTS.md](PROJECTS.md).
- Transferify в Chrome Web Store описывает расширение, которое получает Apple Music session cookie и отправляет на backend; это обратный по безопасности образец требуемой архитектуры, потому что пользовательский auth secret уходит за пределы устройства. Источник — [описание расширения](https://chromewebstore.google.com/detail/transferify/olknikingikimniojflgomlmpokkdfnf); его исходники и backend не проверялись, поэтому его нельзя считать подтверждённым open-source решением.
- Harmony Sync listing обещает локальную передачу плейлистов между Spotify, Apple Music и другими сервисами ([Chrome Web Store](https://chromewebstore.google.com/detail/harmonysync/ademgclgpcjineomlelhiaicglbnabib)); открытый GitHub source и полная локальная обработка пока не подтверждены. Нельзя считать поддержкой лайков или Favorite Songs по одному описанию магазина.

## Нерешённые продуктовые ограничения

«Зашёл в учётку и всё работает» достижимо как единый интерфейс локальных provider adapters, но не как один универсальный auth protocol. Внутри останутся четыре разных схемы: официальный OAuth, private web session, Apple MusicKit и local Music.app. Без developer credentials создателя доступность достигается browser-session adapters для источников и, вероятно, локальной Apple automation для назначения; это требует отдельного технического аудита и остаётся менее стабильным, чем официальные APIs.

Пока не доказаны: бесплатное чтение Звука на любом тарифе, расширение Яндекса с действительно минимальными правами, надёжная private Spotify session интеграция, а также Apple Favorite Songs write/read-back без developer token. До этих проверок нельзя обещать «всё готово без ограничений».
