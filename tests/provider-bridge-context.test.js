const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const cases = [
  { file: 'apple-bridge.js', marker: 'music-importer-apple', source: 'music-importer-apple', progressSource: 'music-importer-apple' },
  { file: 'spotify-bridge.js', marker: 'music-importer-spotify', source: 'music-importer-spotify', progressSource: 'music-importer-spotify' },
  { file: 'yandex-bridge.js', marker: 'music-importer-yandex', source: 'music-importer-yandex', progressSource: 'music-importer-yandex' },
  { file: 'bridge.js', marker: 'music-importer-zvuk', source: 'music-importer-zvuk', progressSource: 'music-importer-zvuk-target' },
];

function createBridge({ file, origin, sendMessage }) {
  const listeners = new Map();
  const runtimeListeners = [];
  const posted = [];
  let reloads = 0;
  const window = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    postMessage(message) { posted.push(message); },
  };
  const chrome = {
    runtime: {
      id: 'fixture-extension-id',
      sendMessage,
      onMessage: { addListener(listener) { runtimeListeners.push(listener); } },
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve(`../chrome-extension/${file}`), 'utf8'), {
    window, location: { origin, reload() { reloads += 1; } }, chrome, setTimeout,
  }, { filename: file });
  return {
    posted,
    get reloads() { return reloads; },
    healthCheck() {
      const responses = [];
      for (const listener of runtimeListeners) listener({ type: 'music-importer:bridge-health-check' }, {}, (value) => responses.push(value));
      return responses;
    },
    dispatch(data) {
      listeners.get('message')?.({ source: window, origin, data });
    },
  };
}

for (const bridgeCase of cases) {
  test(`${bridgeCase.file} ignores a synchronously invalidated extension context`, async () => {
    const origin = 'https://provider.example';
    const bridge = createBridge({
      ...bridgeCase,
      origin,
      sendMessage() { throw new Error('Extension context invalidated'); },
    });
    assert.doesNotThrow(() => bridge.dispatch({ source: bridgeCase.source, type: 'scan-progress' }));
    if (bridgeCase.file === 'spotify-bridge.js') assert.doesNotThrow(() => bridge.dispatch({
      source: bridgeCase.source, type: 'scan-progress', progressAckId: 'scan-progress-fixture',
    }));
    assert.doesNotThrow(() => bridge.dispatch({
      source: bridgeCase.progressSource,
      type: 'transfer-progress',
      requestId: 'fixture-request',
      progress: { checkpointId: 'fixture-checkpoint' },
    }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(bridge.posted.some((message) => message.type === 'transfer-progress-ack' && message.ok === false));
    if (bridgeCase.file === 'spotify-bridge.js') assert.ok(bridge.posted.some((message) =>
      message.type === 'scan-progress-ack' && message.progressAckId === 'scan-progress-fixture' && message.ok === false));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(bridge.reloads, 1, 'an invalidated bridge reloads its provider tab once');
  });

  test(`${bridgeCase.file} consumes a rejected runtime message and rejects its checkpoint`, async () => {
    const origin = 'https://provider.example';
    const bridge = createBridge({
      ...bridgeCase,
      origin,
      sendMessage() { return Promise.reject(new Error('Extension context invalidated')); },
    });
    assert.doesNotThrow(() => bridge.dispatch({
      source: bridgeCase.progressSource,
      type: 'transfer-progress',
      requestId: 'fixture-request',
      progress: { checkpointId: 'fixture-checkpoint' },
    }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(bridge.posted.some((message) => message.type === 'transfer-progress-ack' && message.ok === false));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(bridge.reloads, 1, 'a rejected invalidated bridge reloads its provider tab once');
  });

  test(`${bridgeCase.file} answers extension bridge health checks`, () => {
    const bridge = createBridge({ ...bridgeCase, origin: 'https://provider.example', sendMessage() { return Promise.resolve(null); } });
    assert.ok(bridge.healthCheck().some((response) => response?.ok === true && response.bridgeProtocol === 4));
  });
}

test('yandex-bridge forwards the separately confirmed favorites snapshot to extension storage', () => {
  const sent = [];
  const bridge = createBridge({
    file: 'yandex-bridge.js',
    origin: 'https://music.yandex.ru',
    sendMessage(message) { sent.push(message); return Promise.resolve({ ok: true }); },
  });
  const payload = {
    service: 'yandex-music',
    partialScope: 'favorites',
    completeness: { confirmed: false, favoritesConfirmed: true, favoritesCount: 1 },
    tracks: [{ id: 'liked-1', position: 0 }],
    playlists: [],
  };
  bridge.dispatch({ source: 'music-importer-yandex', type: 'favorites-snapshot', payload });
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0])), { type: 'yandex:favorites-snapshot', source: 'music-importer-yandex', payload });
});

test('spotify bridge acknowledges scan progress only after the service worker accepts it', async () => {
  const sent = [];
  const bridge = createBridge({
    file: 'spotify-bridge.js',
    origin: 'https://open.spotify.com',
    sendMessage(message) { sent.push(message); return Promise.resolve({ ok: true }); },
  });
  bridge.dispatch({
    source: 'music-importer-spotify', type: 'scan-progress', phase: 'playlists',
    message: 'Reading playlist catalog.', progressAckId: 'scan-progress-fixture',
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(sent[0])), {
    type: 'spotify:scan-progress', source: 'music-importer-spotify', phase: 'playlists',
    message: 'Reading playlist catalog.', progressAckId: 'scan-progress-fixture',
  });
  assert.ok(bridge.posted.some((message) => message.type === 'scan-progress-ack'
    && message.progressAckId === 'scan-progress-fixture' && message.ok === true));
});

test('spotify bridge acknowledges a terminal scan result only after the service worker accepts it', async () => {
  const sent = [];
  const bridge = createBridge({
    file: 'spotify-bridge.js',
    origin: 'https://open.spotify.com',
    sendMessage(message) { sent.push(message); return Promise.resolve({ ok: true }); },
  });
  bridge.dispatch({ source: 'music-importer-spotify', type: 'library-snapshot', terminalAckId: 'scan-terminal-fixture', payload: { service: 'spotify' } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sent[0]?.type, 'spotify:library-snapshot');
  assert.ok(bridge.posted.some((message) => message.type === 'scan-terminal-ack'
    && message.terminalAckId === 'scan-terminal-fixture' && message.ok === true));

  const rejected = createBridge({
    file: 'spotify-bridge.js',
    origin: 'https://open.spotify.com',
    sendMessage() { return Promise.resolve({ ok: false }); },
  });
  rejected.dispatch({ source: 'music-importer-spotify', type: 'scan-error', terminalAckId: 'scan-error-fixture', error: 'fixture' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(rejected.posted.some((message) => message.type === 'scan-terminal-ack'
    && message.terminalAckId === 'scan-error-fixture' && message.ok === false));
});
