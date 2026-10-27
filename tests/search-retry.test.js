const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function loadEngine() {
  const delays = [];
  const timers = new Set();
  let timerId = 0;
  const context = {
    window: {}, URL, URLSearchParams, Map, Set, Promise, Number, String, Array, Object, Error, JSON, Date, Math,
    DOMException,
    setTimeout(callback, delay) {
      delays.push(delay);
      const id = ++timerId;
      const handle = setImmediate(() => {
        timers.delete(handle);
        callback();
      });
      timers.add(handle);
      return { id, handle };
    },
    clearTimeout(timer) {
      if (timer?.handle) {
        clearImmediate(timer.handle);
        timers.delete(timer.handle);
      }
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../demo/transfer-engine.js'), 'utf8'), context);
  return { engine: context.window.MusicTransferEngine, delays };
}

test('catalog search retries transient 5xx responses with exponential backoff', async () => {
  const { engine, delays } = loadEngine();
  let attempts = 0;
  let progressCalls = 0;
  const [result] = await engine.searchMany({
    id: 'spotify',
    async searchTracks() {
      attempts += 1;
      if (attempts < 3) throw new Error('Spotify: HTTP 503.');
      return [{ trackId: 'spotify:track:ok' }];
    },
  }, [{ title: 'Song', artist: 'Artist' }], {
    maxRetries: 2,
    onProgress: () => { progressCalls += 1; },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [500, 1000]);
  assert.equal(progressCalls, 1);
  assert.equal(result.error, null);
  assert.equal(result.candidates[0].trackId, 'spotify:track:ok');
});

test('catalog search waits longer after rate limiting and does not retry permanent errors', async () => {
  const rateLimited = loadEngine();
  let attempts = 0;
  await rateLimited.engine.searchMany({
    id: 'apple-music',
    async searchTracks() {
      attempts += 1;
      if (attempts === 1) throw new Error('Каталог Apple ответил 429');
      return [];
    },
  }, [{ title: 'Song', artist: 'Artist' }], { maxRetries: 1 });
  assert.equal(attempts, 2);
  assert.deepEqual(rateLimited.delays, [2500]);

  const permanent = loadEngine();
  let permanentAttempts = 0;
  const [result] = await permanent.engine.searchMany({
    id: 'yandex-music',
    async searchTracks() {
      permanentAttempts += 1;
      throw new Error('Яндекс Музыка: HTTP 401');
    },
  }, [{ title: 'Song', artist: 'Artist' }]);
  assert.equal(permanentAttempts, 1);
  assert.deepEqual(permanent.delays, []);
  assert.match(result.error.message, /401/);
});
