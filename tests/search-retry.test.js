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

function loadMatcher() {
  const context = { window: {}, String, Set, Map, Array, Number, Math };
  vm.runInNewContext(fs.readFileSync(require.resolve('../demo/matcher.js'), 'utf8'), context);
  return context.window.MusicMatcher;
}

test('bulk catalog engine issues one request for repeated source recording occurrences', async () => {
  const { engine } = loadEngine();
  const matcher = loadMatcher();
  const first = { sourceId: 'same-zvuk-track', title: 'Song', artist: 'Artist', sourceCollectionId: 'favorites', sourcePosition: 3 };
  const repeated = { sourceId: 'same-zvuk-track', title: 'Song (Remastered)', artist: 'Artist', sourceCollectionId: 'playlist-7', sourcePosition: 12 };
  let requests = 0;
  let progressGroup;
  const results = await engine.searchMany({
    id: 'spotify',
    async searchTracks() { requests += 1; return [{ trackId: 'spotify:target-track' }]; },
  }, [first, repeated], {
    keyFor: (track) => matcher.catalogSearchGroupKey(track, 'zvuk', 'spotify', '', `${track.title} ${track.artist}`),
    onProgress: (group) => { progressGroup = group; },
  });

  assert.equal(requests, 1);
  assert.equal(results.length, 1);
  assert.equal(progressGroup.tracks.length, 2);
  assert.equal(JSON.stringify(progressGroup.tracks.map((track) => [track.sourceCollectionId, track.sourcePosition])), JSON.stringify([['favorites', 3], ['playlist-7', 12]]));
  assert.equal(progressGroup.candidates[0].trackId, 'spotify:target-track');
});

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

test('catalog search honors Retry-After seconds and HTTP-date values on 429', async () => {
  const seconds = loadEngine();
  let secondsAttempts = 0;
  await seconds.engine.searchMany({
    id: 'spotify',
    async searchTracks() {
      secondsAttempts += 1;
      if (secondsAttempts === 1) throw Object.assign(new Error('Spotify: HTTP 429.'), { status: 429, retryAfter: '7' });
      return [];
    },
  }, [{ title: 'Song', artist: 'Artist' }], { maxRetries: 1 });
  assert.deepEqual(seconds.delays, [7000]);

  const date = loadEngine();
  let dateAttempts = 0;
  const retryAt = Date.now() + 6000;
  await date.engine.searchMany({
    id: 'yandex-music',
    async searchTracks() {
      dateAttempts += 1;
      if (dateAttempts === 1) throw Object.assign(new Error('Яндекс Музыка: HTTP 429.'), {
        status: 429,
        retryAfter: new Date(retryAt).toUTCString(),
      });
      return [];
    },
  }, [{ title: 'Song', artist: 'Artist' }], { maxRetries: 1 });
  assert.equal(date.delays[0] >= 2500, true);
  assert.equal(date.delays[0] <= 6000, true);
});

test('batch catalog search preserves order and individually retries missing ISRC results', async () => {
  const { engine } = loadEngine();
  let batchCalls = 0;
  const individualQueries = [];
  const tracks = [
    { title: 'Song A', artist: 'Artist A', isrc: 'USABC1234567' },
    { title: 'Song B', artist: 'Artist B', isrc: 'GBDEF1234567' },
  ];
  const progress = [];
  const results = await engine.searchMany({
    id: 'apple-music',
    canBatchSearch() { return true; },
    async searchTracksBatch(batchTracks) {
      batchCalls += 1;
      assert.deepEqual(Array.from(batchTracks, (track) => track.title), ['Song A', 'Song B']);
      return [[{ trackId: 'apple:a', isrc: 'USABC1234567' }], []];
    },
    async searchTracks(track) {
      individualQueries.push(track.title);
      return [{ trackId: 'apple:b', isrc: track.isrc }];
    },
  }, tracks, {
    context: { accountWrite: true },
    onProgress: (_group, completed) => progress.push(completed),
  });

  assert.equal(batchCalls, 1);
  assert.deepEqual(individualQueries, ['Song B']);
  assert.deepEqual(Array.from(results, (result) => result.candidates[0].trackId), ['apple:a', 'apple:b']);
  assert.deepEqual(progress, [1, 2]);
});

test('batch catalog search uses bounded parallelism for large ISRC queues', async () => {
  const { engine } = loadEngine();
  const tracks = Array.from({ length: 9 }, (_, index) => ({
    title: `Song ${index}`,
    artist: 'Artist',
    isrc: `USABC${String(index).padStart(7, '0')}`,
  }));
  let active = 0;
  let peakActive = 0;
  const results = await engine.searchMany({
    id: 'apple-music',
    maxConcurrentSearches: 2,
    batchSearchSize: 1,
    canBatchSearch() { return true; },
    async searchTracksBatch(batchTracks) {
      active += 1;
      peakActive = Math.max(peakActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return [[{ trackId: `apple:${batchTracks[0].title}`, isrc: batchTracks[0].isrc }]];
    },
    async searchTracks() {
      throw new Error('successful batches should not fall back to per-track search');
    },
  }, tracks);

  assert.equal(peakActive, 2);
  assert.deepEqual(results.map((result) => result.candidates[0].trackId), tracks.map((track) => `apple:${track.title}`));
});

test('bulk catalog search aborts queued requests without reporting cancelled tracks as complete', async () => {
  const { engine } = loadEngine();
  const controller = new AbortController();
  let calls = 0;
  const progress = [];
  await assert.rejects(engine.searchMany({
    id: 'spotify',
    async searchTracks() {
      calls += 1;
      controller.abort();
      return [{ trackId: 'spotify:track:cancelled' }];
    },
  }, [
    { title: 'Song A', artist: 'Artist' },
    { title: 'Song B', artist: 'Artist' },
    { title: 'Song C', artist: 'Artist' },
  ], {
    concurrency: 1,
    signal: controller.signal,
    onProgress: (_group, completed) => progress.push(completed),
  }), (error) => error.name === 'AbortError');

  assert.equal(calls, 1);
  assert.deepEqual(progress, []);
});
