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
  assert.deepEqual(JSON.parse(JSON.stringify(sourceAction({ extensionAvailable: true, snapshot: {}, selected: true }))), {
    action: 'select',
    disabled: false,
    label: '✓ Источник',
    title: '',
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

test('account cards call the selected-provider opener and focus refresh includes its pending queue', () => {
  const app = fs.readFileSync(require.resolve('../demo/app.js'), 'utf8');
  assert.match(app, /requestOpenProviderTabs\(\[provider\]\)/);
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

test('account-first copy names likes and playlists and presents CSV/JSON as an alternative', () => {
  const html = fs.readFileSync(require.resolve('../demo/index.html'), 'utf8');
  assert.match(html, /Перенос лайков и плейлистов/);
  assert.match(html, /Лайки и плейлисты из аккаунта/);
  assert.match(html, /CSV\/JSON можно загрузить как альтернативный источник/);
  assert.match(html, /src="provider-connection-flow\.js"/);
});
