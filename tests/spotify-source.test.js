const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const origin = 'https://open.spotify.com';
const endpoint = 'https://api-partner.spotify.com/pathfinder/v2/query';

function makePage(respond, timerScale = 1, scriptUrls = []) {
  const listeners = new Map();
  const messages = [];
  const requests = [];
  const location = { origin, href: `${origin}/collection/tracks` };
  const document = { querySelectorAll: () => scriptUrls.map((src) => ({ src })) };
  const window = {
    location,
    addEventListener(name, callback) { listeners.set(name, callback); },
    postMessage(message) { messages.push(message); },
    async fetch(url, init = {}) {
      const request = { url: String(url), init, payload: typeof init.body === 'string' ? JSON.parse(init.body) : null, startedAt: Date.now() };
      requests.push(request);
      const result = await respond(request);
      return {
        ok: result.status === undefined || (result.status >= 200 && result.status < 300),
        status: result.status || 200,
        headers: { get: () => null },
        clone: () => ({ arrayBuffer: async () => {
          if (!result.pendingBody) return new ArrayBuffer(0);
          await new Promise((resolve, reject) => {
            if (request.init.signal.aborted) reject(new Error('aborted'));
            else request.init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
          return new ArrayBuffer(0);
        } }),
        json: async () => result.payload ?? result,
        text: async () => result.text || '',
      };
    },
  };
  const context = {
    window, location, document, URL, URLSearchParams, Headers, Request, Promise, Map, Set,
    String, Number, Array, Object, Error, JSON, Date, RegExp, Math,
    setTimeout: (callback, delay, ...args) => setTimeout(callback, delay * timerScale, ...args), clearTimeout, setImmediate,
    AbortController,
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../chrome-extension/spotify-main-world.js'), 'utf8'), context);
  return {
    messages,
    requests,
    async startScan() {
      await window.fetch(endpoint, {
        method: 'POST',
        headers: { authorization: 'Bearer fixture-secret', 'client-token': 'fixture-client-secret' },
        body: JSON.stringify({ operationName: 'initialPageRequest', extensions: { persistedQuery: { sha256Hash: 'a'.repeat(64) } } }),
      });
      await listeners.get('message')({
        source: window, origin,
        data: { source: 'music-importer-spotify', type: 'start-library-scan' },
      });
    },
  };
}

function trackData(uri, name) {
  return { uri, name, artists: [{ name: 'Artist' }], album: { name: 'Album' }, externalIds: { isrc: 'USABC1234567' }, duration: { totalMilliseconds: 180000 } };
}

test('Spotify source reader imports liked tracks and every playlist with item order and empty lists', async () => {
  const page = makePage(({ payload }) => {
    const { operationName } = payload || {};
    if (operationName === 'initialPageRequest') return { payload: { data: {} } };
    if (operationName === 'fetchLibraryTracks') return { payload: { data: { me: { library: { tracks: {
      totalCount: 1,
      items: [{ track: { _uri: 'spotify:track:like1', data: trackData('spotify:track:like1', 'Liked') } }],
    } } } } } };
    if (operationName === 'libraryV3') return { payload: { data: { me: { libraryV3: {
      totalCount: 2,
      items: [
        { item: { _uri: 'spotify:playlist:road', data: { name: 'Road', totalLength: 2 } } },
        { item: { _uri: 'spotify:playlist:empty', data: { name: 'Empty', totalLength: 0 } } },
      ],
    } } } } };
    if (operationName === 'fetchPlaylistContents') {
      const playlist = payload.variables.uri;
      const rows = playlist.endsWith(':road')
        ? ['spotify:track:one', 'spotify:track:two'].map((uri, index) => ({ itemV2: { data: trackData(uri, `Track ${index + 1}`) } }))
        : [];
      return { payload: { data: { playlistV2: { content: { items: rows, totalCount: rows.length, pagingInfo: { offset: 0 } } } } } };
    }
    throw new Error(`Unexpected Spotify operation: ${operationName}`);
  });

  await page.startScan();
  const snapshot = page.messages.find((message) => message.type === 'library-snapshot')?.payload;
  assert.ok(snapshot, JSON.stringify(page.messages));
  assert.equal(snapshot.service, 'spotify');
  assert.equal(snapshot.completeness.confirmed, true);
  assert.deepEqual(Array.from(snapshot.tracks, (track) => [track.id, track.collectionType]), [['spotify:track:like1', 'favorites']]);
  assert.deepEqual(Array.from(snapshot.playlists, (playlist) => playlist.title), ['Road', 'Empty']);
  assert.deepEqual(Array.from(snapshot.playlists[0].tracks, (track) => [track.id, track.position]), [
    ['spotify:track:one', 0], ['spotify:track:two', 1],
  ]);
  assert.equal(snapshot.playlists[1].complete, true);
  const emitted = JSON.stringify(page.messages);
  assert.ok(!emitted.includes('fixture-secret'));
  assert.ok(!emitted.includes('fixture-client-secret'));
  assert.ok(page.requests.filter((request) => request.url === endpoint).every((request) => request.init.headers.authorization === 'Bearer fixture-secret'));
});

test('Spotify source reader skips downloading the web-player bundle when seeded query hashes are available', async () => {
  const page = makePage(({ payload }) => {
    if (payload?.operationName === 'initialPageRequest') return { payload: { data: {} } };
    if (payload?.operationName === 'fetchLibraryTracks') return { payload: { data: { me: { library: { tracks: { totalCount: 0, items: [] } } } } } };
    if (payload?.operationName === 'libraryV3') return { payload: { data: { me: { libraryV3: { totalCount: 0, items: [] } } } } };
    throw new Error(`Unexpected Spotify operation: ${payload?.operationName}`);
  }, 1, ['https://open.spotifycdn.com/cdn/build/web-player.fixture.js']);

  await page.startScan();

  assert.equal(page.requests.some((request) => request.url.includes('spotifycdn.com')), false);
  assert.ok(page.messages.some((message) => message.type === 'library-snapshot'));
});

test('Spotify source reader refreshes a persisted query hash after PersistedQueryNotFound', async () => {
  const refreshedHash = 'f'.repeat(64);
  let favoritesRequests = 0;
  const page = makePage(({ url, payload }) => {
    if (url.includes('spotifycdn.com')) return { text: ` fetchLibraryTracks ${refreshedHash}`, payload: {} };
    if (payload?.operationName === 'initialPageRequest') return { payload: { data: {} } };
    if (payload?.operationName === 'fetchLibraryTracks' && favoritesRequests++ === 0) {
      return { payload: { errors: [{ message: 'PersistedQueryNotFound' }] } };
    }
    if (payload?.operationName === 'fetchLibraryTracks') return { payload: { data: { me: { library: { tracks: { totalCount: 0, items: [] } } } } } };
    if (payload?.operationName === 'libraryV3') return { payload: { data: { me: { libraryV3: { totalCount: 0, items: [] } } } } };
    throw new Error(`Unexpected Spotify operation: ${payload?.operationName}`);
  }, 0.01, ['https://open.spotifycdn.com/cdn/build/web-player.fixture.js']);

  await page.startScan();

  const favoriteRequests = page.requests.filter((request) => request.payload?.operationName === 'fetchLibraryTracks');
  assert.equal(favoriteRequests.length, 2);
  assert.equal(favoriteRequests[1].payload.extensions.persistedQuery.sha256Hash, refreshedHash);
  assert.ok(page.messages.some((message) => message.type === 'library-snapshot'));
});

test('Spotify source reader times out when an HTTP response body stalls after headers', async () => {
  const page = makePage(({ payload }) => {
    if (payload.operationName === 'initialPageRequest') return { payload: { data: {} } };
    return { pendingBody: true };
  }, 0.001);
  await page.startScan();
  assert.match(page.messages.find((message) => message.type === 'scan-error')?.error || '', /Spotify не ответил за 45 с/);
});

test('Spotify source reader spaces concurrent likes and playlist requests instead of bursting', async () => {
  const page = makePage(({ payload }) => {
    if (payload.operationName === 'initialPageRequest') return { payload: { data: {} } };
    if (payload.operationName === 'fetchLibraryTracks') return { payload: { data: { me: { library: { tracks: { totalCount: 0, items: [] } } } } } };
    if (payload.operationName === 'libraryV3') return { payload: { data: { me: { libraryV3: { totalCount: 0, items: [] } } } } };
    throw new Error(`Unexpected Spotify operation: ${payload.operationName}`);
  });

  await page.startScan();
  const starts = page.requests.filter((request) => request.url === endpoint && request.payload?.operationName !== 'initialPageRequest')
    .map((request) => request.startedAt);
  assert.equal(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 250, `Spotify requests started ${starts[1] - starts[0]} ms apart`);
});

test('Spotify source reader refuses a truncated liked-track page', async () => {
  const page = makePage(({ payload }) => {
    const operation = payload?.operationName;
    if (operation === 'initialPageRequest') return { payload: { data: {} } };
    if (operation === 'fetchLibraryTracks') return { payload: { data: { me: { library: { tracks: { totalCount: 2, items: [] } } } } } };
    throw new Error(`Incomplete favorites should stop before ${operation}`);
  });

  await page.startScan();
  assert.ok(page.messages.some((message) => message.type === 'scan-error' && /пустую страницу/i.test(message.error)));
  assert.ok(!page.messages.some((message) => message.type === 'library-snapshot'));
});

test('Spotify source reader reports the playlist phase and fails a stalled API request', async () => {
  const page = makePage(({ payload, init }) => {
    const operation = payload?.operationName;
    if (operation === 'initialPageRequest') return { payload: { data: {} } };
    if (operation === 'fetchLibraryTracks') return { payload: { data: { me: { library: { tracks: { totalCount: 0, items: [] } } } } } };
    if (operation === 'libraryV3') return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    throw new Error(`Unexpected Spotify operation: ${operation}`);
  }, 0.001);

  await page.startScan();
  assert.ok(page.messages.some((message) => message.type === 'scan-progress' && /каталог плейлистов/i.test(message.message)));
  assert.ok(page.messages.some((message) => message.type === 'scan-error' && /не ответил за 45 с/i.test(message.error)));
  assert.ok(!page.messages.some((message) => message.type === 'library-snapshot'));
});
