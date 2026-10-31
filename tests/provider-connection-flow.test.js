const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function loadFlow() {
  const context = { globalThis: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../demo/provider-connection-flow.js'), 'utf8'), context);
  return context.globalThis.MusicProviderConnectionFlow;
}

test('unavailable account cards offer a login action only after the extension connects', () => {
  const { sourceAction } = loadFlow();
  assert.deepEqual(JSON.parse(JSON.stringify(sourceAction({ extensionAvailable: false }))), {
    action: 'none',
    disabled: true,
    label: 'Нет соединения',
    title: 'Сначала запустите Music Importer в Chrome.',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(sourceAction({ extensionAvailable: true }))), {
    action: 'login',
    disabled: false,
    label: 'Войти / открыть',
    title: 'Откроется страница входа в музыкальный сервис.',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(sourceAction({ extensionAvailable: true, opening: true }))), {
    action: 'opening',
    disabled: true,
    label: 'Открываем…',
    title: '',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(sourceAction({ extensionAvailable: true, status: { status: 'scanning' } }))), {
    action: 'none',
    disabled: true,
    label: 'Сканируем…',
    title: '',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(sourceAction({ extensionAvailable: true, status: { status: 'failed', message: 'Ошибка чтения' } }))), {
    action: 'retry',
    disabled: false,
    label: 'Повторить сбор',
    title: 'Ошибка чтения',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(sourceAction({ extensionAvailable: true, status: { status: 'failed', message: 'Apple Music не передал сессию API.' } }))), {
    action: 'login',
    disabled: false,
    label: 'Войти / открыть',
    title: 'Apple Music не передал сессию API.',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(sourceAction({ extensionAvailable: true, snapshot: {}, selected: true }))), {
    action: 'select',
    disabled: false,
    label: '✓ Источник',
    title: '',
  });
});

test('Spotify retry explains that an explicit read may refresh its tab', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(loadFlow().sourceAction({
    extensionAvailable: true,
    providerName: 'Spotify',
    status: { status: 'failed', message: 'Сбор Spotify не запускался.' },
  }))), {
    action: 'retry',
    disabled: false,
    label: 'Проверить Spotify',
    title: 'Запущу чтение Spotify по нажатию. Если мост расширения устарел, вкладка Spotify перезагрузится.',
  });
});

test('failed and stale cached provider cards always expose a separate provider retry action', () => {
  const { refreshAction } = loadFlow();
  assert.deepEqual(JSON.parse(JSON.stringify(refreshAction({
    extensionAvailable: true,
    status: { status: 'failed', message: 'Spotify не сообщил о прогрессе.' },
  }))), {
    visible: true, disabled: false, label: 'Повторить чтение', title: 'Spotify не сообщил о прогрессе.',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(refreshAction({
    extensionAvailable: true,
    status: { status: 'stale', message: 'Снимок устарел.' },
  }))), {
    visible: true, disabled: false, label: 'Обновить сейчас', title: 'Снимок устарел.',
  });
  assert.equal(refreshAction({ extensionAvailable: true, status: { status: 'scanning' } }).visible, false);
  assert.equal(refreshAction({ extensionAvailable: false, status: { status: 'failed' } }).visible, false);
  assert.equal(refreshAction({
    extensionAvailable: true, status: { status: 'failed' }, queued: true,
  }).disabled, true);
  assert.deepEqual(JSON.parse(JSON.stringify(loadFlow().sourceAction({
    extensionAvailable: true,
    status: { status: 'failed', message: 'Повтор Spotify поставлен в очередь.' },
    providerName: 'Spotify',
    queued: true,
  }))), {
    action: 'queued', disabled: true, label: 'Повтор в очереди', title: 'Повтор Spotify поставлен в очередь.',
  });
});

test('a provider opened for login stays queued for refresh when the app regains focus', () => {
  const { providersForFocusRefresh } = loadFlow();
  const providers = ['zvuk', 'spotify', 'yandex-music', 'apple-music'];
  const snapshots = { spotify: { completeness: { confirmed: true } } };
  const statuses = { spotify: { status: 'ready' }, 'yandex-music': { status: 'unavailable' } };
  const selected = providersForFocusRefresh(providers, snapshots, statuses, new Set(['spotify']));
  assert.deepEqual(JSON.parse(JSON.stringify(selected)), ['zvuk', 'spotify', 'yandex-music', 'apple-music']);
  assert.deepEqual(JSON.parse(JSON.stringify(providersForFocusRefresh(providers, snapshots, { spotify: { status: 'ready' } }))), ['zvuk', 'yandex-music', 'apple-music']);
});

test('automatic refresh skips Spotify unless the user opened it for a login or explicitly queued it', () => {
  const { providersForAutomaticRefresh } = loadFlow();
  const providers = ['zvuk', 'spotify', 'yandex-music', 'apple-music'];
  assert.deepEqual(JSON.parse(JSON.stringify(providersForAutomaticRefresh(providers))), ['zvuk', 'yandex-music', 'apple-music']);
  assert.deepEqual(JSON.parse(JSON.stringify(providersForAutomaticRefresh(providers, new Set(['spotify'])))), providers);
});

test('account cards call the selected-provider opener and focus refresh includes its pending queue', () => {
  const app = fs.readFileSync(require.resolve('../demo/app.js'), 'utf8');
  assert.match(app, /repair-provider-bridges', skipProviders: \['spotify'\]/);
  assert.match(app, /providersForAutomaticRefresh\(providersToRefresh, state\.pendingLoginProviders\)/);
  assert.match(app, /providersForAutomaticRefresh\(window\.MusicProviderConnectionFlow\.providersForFocusRefresh/);
  assert.match(app, /requestOpenProviderTabs\(\[provider\], provider\)/);
  assert.match(app, /state\.pendingLoginProviders\.add\(provider\)/);
  assert.match(app, /providersForFocusRefresh\([\s\S]*state\.pendingLoginProviders/);
  assert.match(app, /document\.addEventListener\('visibilitychange'/);
  assert.doesNotMatch(app, /if \(!extensionApp \|\| !state\.extensionAvailable \|\| document\.visibilityState/);
});

test('failed provider cards retry only that provider instead of reopening its login page', () => {
  const app = fs.readFileSync(require.resolve('../demo/app.js'), 'utf8');
  assert.match(app, /const status = state\.libraryStatuses\[provider\]/);
  assert.match(app, /action\.action === 'retry'[\s\S]*?scanOpenAccounts\(false, \[provider\]\)/);
});

test('each provider card has its own progress indicator and visible retry control', () => {
  const html = fs.readFileSync(require.resolve('../demo/index.html'), 'utf8');
  const app = fs.readFileSync(require.resolve('../demo/app.js'), 'utf8');
  const cards = [...html.matchAll(/<article class="source"[^>]*data-provider="([^"]+)"[\s\S]*?<\/article>/g)];
  assert.deepEqual(cards.map(([, provider]) => provider), ['zvuk', 'spotify', 'yandex-music', 'apple-music']);
  for (const [card] of cards) {
    assert.match(card, /class="source-status" role="status" aria-live="polite"/);
    assert.match(card, /<progress class="source-progress"[^>]*hidden><\/progress>/);
    assert.match(card, /class="source-retry"[^>]*hidden>/);
  }
  assert.match(html, /class="library-scan-toolbar"[\s\S]*?id="extensionImportBtn"/);
  assert.match(app, /status\.message \|\| `Обновляем \$\{sourceLabels\[provider\]\}/);
  assert.match(app, /`Сбор: \$\{running\.length\}/);
  assert.doesNotMatch(app, /running\[0\]|running\.join\(' · '\)/);
  assert.match(app, /requestAllLibraries\(false, providersBeingRefreshed\)/);
  assert.match(app, /pendingProviderRetries\.add\(provider\)/);
});

test('account-first copy keeps only concise actions and statuses', () => {
  const html = fs.readFileSync(require.resolve('../demo/index.html'), 'utf8');
  assert.match(html, /Перенос лайков и плейлистов/);
  assert.match(html, /Лайки и плейлисты из аккаунта/);
  assert.match(html, /Импорт CSV\/JSON/);
  assert.match(html, /<summary>Не подключается\?<\/summary>/);
  assert.doesNotMatch(html, /Подготовлены коннекторы четырёх сервисов|Доступность зависит от входа|onboarding-note|Вы управляете переносом|Сессионные API-заголовки/);
  assert.doesNotMatch(html, /checkout проекта|localhost-страница|CSV\/JSON можно загрузить как альтернативный источник/);
  assert.doesNotMatch(html, /доступны как источники и цели/);
  assert.match(html, /src="provider-connection-flow\.js"/);
});
