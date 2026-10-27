const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const origin = 'https://open.spotify.com';
const endpoint = 'https://api-partner.spotify.com/pathfinder/v2/query';

function makePage(respond) {
  const listeners = new Map();
  const messages = [];
  const requests = [];
  const location = { origin, href: `${origin}/collection/tracks` };
  const document = { querySelectorAll: () => [] };
  const window = {
    location,
    addEventListener(name, callback) { listeners.set(name, callback); },
    postMessage(message) { messages.push(message); },
    async fetch(url, init = {}) {
      const request = { url: String(url), init, payload: typeof init.body === 'string' ? JSON.parse(init.body) : null };
      requests.push(request);
      const result = await respond(request);
      return {
        ok: result.status === undefined || (result.status >= 200 && result.status < 300),
        status: result.status || 200,
        headers: { get: () => null },
        json: async () => result.payload ?? result,
        text: async () => result.text || '',
      };
    },
  };
  const context = {
    window, location, document, URL, URLSearchParams, Headers, Request, Promise, Map, Set,
    String, Number, Array, Object, Error, JSON, Date, RegExp, Math,
    setTimeout, clearTimeout, setImmediate,
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
