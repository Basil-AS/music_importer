const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function makePage(path = '/favorites') {
  const listeners = new Map();
  const messages = [];
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
    postMessage(message) { messages.push(message); },
    scrollTo() {},
    fetch: async (url, init = {}) => {
      const operation = JSON.parse(init.body || '{}').operationName;
      const payload = operation === 'getPaginatedCollection'
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
      return { clone: () => ({ json: async () => payload }) };
    },
  };
  const context = {
    window, location, history, document: {}, XMLHttpRequest, URL, Request: class Request {}, Promise,
    Map, Set, String, Number, Array, Object, Error, JSON, Date, RegExp, Math,
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    getComputedStyle: () => ({ overflowY: 'visible' }),
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../chrome-extension/main-world.js'), 'utf8'), context);
  return {
    messages,
    async request(operationName, variables = {}) {
      const response = await window.fetch('https://zvuk.com/api/v1/graphql', {
        method: 'POST', body: JSON.stringify({ operationName, variables }),
      });
      await response.clone().json();
      await new Promise((resolve) => setImmediate(resolve));
    },
    setPath(pathname) { location.pathname = pathname; },
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
