const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function makePage(path = '/favorites', respond = null) {
  const listeners = new Map();
  const messages = [];
  const requests = [];
  let scrollCallback = null;
  let now = Date.now();
  class TestDate extends Date { static now() { return now; } }
  const location = { origin: 'https://zvuk.com', pathname: path, href: `https://zvuk.com${path}?music_importer_capture=1` };
  const history = { state: {}, replaceState(_state, _title, url) { location.href = String(url); } };
  class XMLHttpRequest {
    open() {}
    send() {}
    addEventListener() {}
  }
  const window = {
    location,
    addEventListener(name, callback) { listeners.set(name, callback); },
    postMessage(message) {
      messages.push(message);
      if (message.captureAckId) queueMicrotask(() => listeners.get('message')?.({
        source: window, origin: location.origin,
        data: { source: 'music-importer-zvuk', type: 'capture-ack', captureAckId: message.captureAckId, ok: true },
      }));
    },
    scrollTo() {},
    fetch: async (url, init = {}) => {
      const request = { url: String(url), init, payload: JSON.parse(init.body || '{}') };
      requests.push(request);
      const operation = request.payload.operationName;
      const defaultPayload = operation === 'getPaginatedCollection'
        ? { data: { paginatedCollection: { tracks: {
          items: [{ id: 'favorite-1', title: 'Favorite', artists: [{ id: 'artist-1', title: 'Artist' }], release: { id: 'release-1', title: 'Album' }, isrc: 'USABC1234567', duration: 180000, privateField: 'must-not-leak' }],
          page: { endCursor: null },
        } } } }
        : operation === 'getPaginatedCollectionAll'
          ? { data: { paginatedCollectionAll: { playlists: { items: [
            { id: 'playlist-road', title: 'Road', trackCount: 2 },
            { id: 'playlist-empty', title: 'Empty', trackCount: 0 },
          ], page: { endCursor: null } } } } }
          : operation === 'getPlaylistTracks'
            ? { data: { playlistTracks: { items: [
              { id: 'repeat-track', title: 'Repeated', artists: [{ title: 'Artist' }] },
              { id: 'repeat-track', title: 'Repeated', artists: [{ title: 'Artist' }] },
            ] } } }
            : { errors: [{ message: 'Unexpected fixture operation' }] };
      const result = respond ? respond(request) : defaultPayload;
      const payload = result?.payload || result;
      const status = Number(result?.statusCode || 200);
      return { ok: status >= 200 && status < 300, status, json: async () => payload, clone: () => ({ json: async () => payload }) };
    },
  };
  const context = {
    window, location, history, document: { documentElement: { scrollHeight: 100, clientHeight: 100, scrollTop: 0 }, querySelectorAll: () => [] }, XMLHttpRequest, URL, Request: class Request {}, Promise,
    Map, Set, String, Number, Array, Object, Error, JSON, Date: TestDate, RegExp, Math, AbortController,
    setTimeout, clearTimeout, setInterval: (callback) => { scrollCallback = callback; return 1; }, clearInterval() {},
    getComputedStyle: () => ({ overflowY: 'visible' }),
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../chrome-extension/main-world.js'), 'utf8'), context);
  return {
    messages,
    requests,
    async request(operationName, variables = {}) {
      const response = await window.fetch('https://zvuk.com/api/v1/graphql', {
        method: 'POST', body: JSON.stringify({ operationName, variables }),
      });
      await response.clone().json();
      await new Promise((resolve) => setImmediate(resolve));
    },
    setPath(pathname) { location.pathname = pathname; },
    async tickScrollAfter(ms) { now += ms; scrollCallback?.(); await new Promise((resolve) => setImmediate(resolve)); },
  };
}

test('Zvuk page connector captures only normalized favorites and playlist catalog data', async () => {
  const page = makePage('/favorites');
  await page.request('getPaginatedCollection', { first: 100, after: null });
  const favoritePage = page.messages.find((message) => message.type === 'favorite-page');
  assert.deepEqual(Array.from(favoritePage.tracks, (track) => [track.id, track.title, track.isrc]), [
    ['favorite-1', 'Favorite', 'USABC1234567'],
  ]);
  assert.equal(favoritePage.hasMore, false);
  assert.ok(!JSON.stringify(page.messages).includes('must-not-leak'));

  page.setPath('/collection');
  await page.request('getPaginatedCollectionAll', { first: 100, after: null });
  const catalog = page.messages.find((message) => message.type === 'playlist-list-page');
  assert.deepEqual(Array.from(catalog.playlists, (playlist) => [playlist.id, playlist.title, playlist.trackCount]), [
    ['playlist-road', 'Road', 2], ['playlist-empty', 'Empty', 0],
  ]);
  assert.equal(catalog.hasMore, false);
});

test('Zvuk page connector preserves repeated playlist tracks and their requested offset', async () => {
  const page = makePage('/playlist/playlist-road');
  await page.request('getPlaylistTracks', { id: 'playlist-road', offset: 20, limit: 2 });
  const playlistPage = page.messages.find((message) => message.type === 'playlist-track-page');
  assert.equal(playlistPage.playlistId, 'playlist-road');
  assert.equal(playlistPage.offset, 20);
  assert.equal(playlistPage.limit, 2);
  assert.deepEqual(Array.from(playlistPage.tracks, (track) => track.id), ['repeat-track', 'repeat-track']);
});

test('Zvuk source reader follows observed favorite cursors without relying on scroll events', async () => {
  const page = makePage('/favorites', ({ payload }) => {
    const cursor = payload.variables?.after || null;
    const pages = {
      null: { items: [{ id: 'favorite-a', title: 'A', artists: [{ title: 'Artist' }] }], page: { endCursor: 'cursor-b' } },
      'cursor-b': { items: [{ id: 'favorite-b', title: 'B', artists: [{ title: 'Artist' }] }], page: { endCursor: 'cursor-c' } },
      'cursor-c': { items: [{ id: 'favorite-c', title: 'C', artists: [{ title: 'Artist' }] }], page: { endCursor: null } },
    };
    return { data: { paginatedCollection: { tracks: pages[String(cursor)] } } };
  });

  await page.request('getPaginatedCollection', { first: 100, after: null });
  for (let attempt = 0; attempt < 20 && !page.messages.some((message) => message.type === 'favorites-scroll-end'); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const favoritePages = page.messages.filter((message) => message.type === 'favorite-page');
  assert.deepEqual(favoritePages.flatMap((message) => message.tracks.map((track) => track.id)), [
    'favorite-a', 'favorite-b', 'favorite-c',
  ]);
  assert.deepEqual(page.messages.filter((message) => message.type === 'favorites-scroll-end').length, 1);
  assert.deepEqual(page.requests.filter((request) => request.payload.operationName === 'getPaginatedCollection')
    .map((request) => request.payload.variables.after), [null, 'cursor-b', 'cursor-c']);
});

test('Zvuk source reader exposes a failed cursor request when scroll fallback stalls', async () => {
  const page = makePage('/favorites', ({ payload }) => {
    const cursor = payload.variables?.after || null;
    if (cursor) return { statusCode: 503, payload: { errors: [{ message: 'temporarily unavailable' }] } };
    return { data: { paginatedCollection: { tracks: {
      items: [{ id: 'favorite-a', title: 'A', artists: [{ title: 'Artist' }] }],
      page: { endCursor: 'cursor-b' },
    } } } };
  });

  await page.request('getPaginatedCollection', { first: 100, after: null });
  await page.tickScrollAfter(21000);
  const stalled = page.messages.find((message) => message.type === 'favorites-scroll-stall');
  assert.match(stalled.reason, /GraphQL ответил HTTP 503/);
});
