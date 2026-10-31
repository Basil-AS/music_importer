const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function runBridge(origin, pathname) {
  let listener;
  const messages = [];
  const window = {
    addEventListener(name, callback) { if (name === 'message') listener = callback; },
    postMessage(message) { messages.push(message); },
  };
  const location = { origin, pathname };
  const context = {
    window,
    location,
    Set,
    Map,
    String,
    chrome: {
      runtime: {
        getManifest: () => ({ version: '0.12.0' }),
        onMessage: { addListener() {} },
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../chrome-extension/local-app-bridge.js'), 'utf8'), context);
  listener?.({
    source: window,
    origin,
    data: { source: 'music-importer-local-app', type: 'extension-ping', requestId: 'fixture-request-0001' },
  });
  return messages;
}

test('local app extension bridge answers on GitHub Pages project path', () => {
  const messages = runBridge('https://basil-as.github.io', '/music_importer/');
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{
    source: 'music-importer-local-app',
    type: 'extension-ready',
    requestId: 'fixture-request-0001',
    version: '0.12.0',
  }]);
});

test('local app extension bridge refuses unrelated GitHub Pages paths', () => {
  assert.deepEqual(runBridge('https://basil-as.github.io', '/other-project/'), []);
});

test('extension and deployment are scoped to the project Pages URL', () => {
  const manifest = JSON.parse(fs.readFileSync(require.resolve('../chrome-extension/manifest.json'), 'utf8'));
  const appBridge = manifest.content_scripts.find((script) => script.js.includes('local-app-bridge.js'));
  assert.ok(appBridge.matches.includes('https://basil-as.github.io/music_importer/*'));
  assert.ok(manifest.host_permissions.includes('https://basil-as.github.io/*'));
  assert.deepEqual(manifest.icons, { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' });
  assert.deepEqual(manifest.action.default_icon, manifest.icons);
  for (const iconPath of Object.values(manifest.icons)) {
    assert.ok(fs.existsSync(require.resolve(`../chrome-extension/${iconPath}`)), `missing extension icon ${iconPath}`);
  }
  assert.equal(manifest.version, '0.15.5');

  const appHtml = fs.readFileSync(require.resolve('../demo/index.html'), 'utf8');
  assert.match(appHtml, /<h1>Перенос музыки<\/h1>/);
  assert.match(appHtml, /<link rel="icon" href="assets\/favicon\.svg" type="image\/svg\+xml">/);
  assert.ok(fs.existsSync(require.resolve('../demo/assets/favicon.svg')));
  assert.doesNotMatch(appHtml, /Соберите свою библиотеку|class="hero"|library без границ/i);
  for (const provider of ['zvuk', 'spotify', 'yandex-music', 'apple-music']) {
    const card = appHtml.match(new RegExp(`<article class="source"[^>]*data-provider="${provider}"[\\s\\S]*?<\\/article>`))?.[0];
    assert.ok(card, `missing ${provider} library card`);
    assert.match(card, /class="source-status"[^>]*role="status"/);
    assert.match(card, /class="source-progress"/);
  }
  assert.match(appHtml, /<meta name="description" content="[^"]+">/);
  const popupHtml = fs.readFileSync(require.resolve('../chrome-extension/popup.html'), 'utf8');
  for (const copy of [
    'Вы управляете переносом',
    'Библиотеки остаются в вашем профиле Chrome',
    'Сессионные API-заголовки Apple Music/Spotify используются только в памяти',
    'Подготовлены коннекторы четырёх сервисов',
    'После подключения приложения авторизованные страницы будут просканированы автоматически',
  ]) {
    assert.doesNotMatch(appHtml, new RegExp(copy));
    assert.doesNotMatch(popupHtml, new RegExp(copy));
  }
  assert.doesNotMatch(appHtml, /Если его нет, загрузите папку `chrome-extension`/);
  assert.doesNotMatch(popupHtml, /Расширение пройдёт избранное, каталог плейлистов/);

  const workflow = fs.readFileSync(require.resolve('../.github/workflows/deploy-pages.yml'), 'utf8');
  assert.match(workflow, /branches:\s*\[master\]/);
  assert.match(workflow, /path:\s*demo/);
  const privacyPage = fs.readFileSync(require.resolve('../demo/privacy.html'));
  assert.deepEqual(privacyPage, fs.readFileSync(require.resolve('../chrome-extension/app/privacy.html')));
  assert.match(privacyPage.toString(), /локально в `chrome\.storage\.local`/);
});
