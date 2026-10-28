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
        getManifest: () => ({ version: '0.11.0' }),
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
    version: '0.11.0',
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
  assert.equal(manifest.version, '0.11.0');

  const workflow = fs.readFileSync(require.resolve('../.github/workflows/deploy-pages.yml'), 'utf8');
  assert.match(workflow, /branches:\s*\[master\]/);
  assert.match(workflow, /path:\s*demo/);
});
