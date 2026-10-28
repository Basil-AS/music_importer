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
  const posted = [];
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
      onMessage: { addListener() {} },
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve(`../chrome-extension/${file}`), 'utf8'), {
    window, location: { origin }, chrome,
  }, { filename: file });
  return {
    posted,
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
    assert.doesNotThrow(() => bridge.dispatch({
      source: bridgeCase.progressSource,
      type: 'transfer-progress',
      requestId: 'fixture-request',
      progress: { checkpointId: 'fixture-checkpoint' },
    }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(bridge.posted.some((message) => message.type === 'transfer-progress-ack' && message.ok === false));
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
  });
}
