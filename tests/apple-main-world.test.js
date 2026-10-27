const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function makePage(fixtures) {
  const listeners = new Map();
  const messages = [];
  const requests = [];
  const token = 'fixture-only-credential';
  const location = { origin: 'https://music.apple.com', href: 'https://music.apple.com/library/songs' };
  const window = {
    location,
    addEventListener(name, callback) { listeners.set(name, callback); },
    postMessage(data) { messages.push(data); },
    fetch: async (url, init = {}) => {
      requests.push({ url: String(url), headers: new Headers(init.headers || {}) });
      const key = new URL(String(url)).pathname + new URL(String(url)).search;
      const payload = fixtures[key];
      if (!payload) return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) };
      return { ok: true, status: 200, headers: new Headers(), json: async () => payload };
    },
  };
  const context = {
    window, location, URL, Headers, Request, Promise, Map, Set, String, Number, Array, Object, Error, JSON, Date,
    setTimeout, clearTimeout, console,
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../chrome-extension/apple-main-world.js'), 'utf8'), context);
  return {
    messages,
    requests,
    async scan() {
      await window.fetch('https://amp-api.music.apple.com/v1/me/storefront', {
        headers: { authorization: `Bearer ${token}`, 'music-user-token': token },
      });
      await listeners.get('message')({
        source: window,
        origin: location.origin,
        data: { source: 'music-importer-apple', type: 'start-library-scan' },
      });
      return messages.find((message) => message.type === 'library-snapshot')?.payload;
    },
    token,
  };
}

test('Apple source reader classifies favorites and preserves playlist duplicates and order', async () => {
  const fixtures = {
    '/v1/me/library/songs?limit=100': {
      meta: { total: 2 }, next: '/v1/me/library/songs?limit=100&offset=1',
      data: [{ id: 'library-song-1', attributes: { name: 'Liked track', artistName: 'Artist', albumName: 'Album', inFavorites: true } }],
    },
    '/v1/me/library/songs?limit=100&offset=1': {
      meta: { total: 2 }, next: null,
      data: [{ id: 'library-song-2', attributes: { name: 'Unliked track', artistName: 'Artist', inFavorites: false } }],
    },
    '/v1/me/library/playlists?limit=100': {
      meta: { total: 2 }, next: null, data: [
        { id: 'playlist-1', attributes: { name: 'Repeated track' } },
        { id: 'playlist-2', attributes: { name: 'Empty playlist' } },
      ],
    },
    '/v1/me/library/playlists/playlist-1/tracks?limit=100': {
      meta: { total: 2 }, next: '/v1/me/library/playlists/playlist-1/tracks?limit=100&offset=1',
      data: [{ id: 'song-x', attributes: { name: 'Same song', artistName: 'Artist' } }],
    },
    '/v1/me/library/playlists/playlist-1/tracks?limit=100&offset=1': {
      meta: { total: 2 }, next: null,
      data: [{ id: 'song-x', attributes: { name: 'Same song', artistName: 'Artist' } }],
    },
    '/v1/me/library/playlists/playlist-2/tracks?limit=100': { meta: { total: 0 }, next: null, data: [] },
  };
  const page = makePage(fixtures);
  const payload = await page.scan();

  assert.equal(payload.service, 'apple-music');
  assert.equal(payload.completeness.confirmed, true);
  assert.equal(payload.completeness.librarySongsCount, 2);
  assert.deepEqual(Array.from(payload.tracks, (track) => track.id), ['library-song-1']);
  assert.equal(payload.playlists.length, 2);
  assert.equal(payload.playlists[0].tracks.length, 2);
  assert.deepEqual(Array.from(payload.playlists[0].tracks, (track) => track.position), [0, 1]);
  assert.equal(payload.playlists[1].complete, true);
  assert.ok(page.requests.every((request) => request.headers.get('authorization') === `Bearer ${page.token}`));
  assert.ok(!JSON.stringify(page.messages).includes(page.token));
});

test('Apple source reader refuses an incomplete library page', async () => {
  const page = makePage({
    '/v1/me/library/songs?limit=100': { meta: { total: 1 }, next: null, data: [] },
    '/v1/me/library/playlists?limit=100': { meta: { total: 0 }, next: null, data: [] },
  });
  await page.scan();
  assert.ok(page.messages.some((message) => message.type === 'scan-error'));
  assert.ok(!page.messages.some((message) => message.type === 'library-snapshot'));
});

test('local app bridge identifies the installed extension without requesting account data', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const messages = [];
  let listener;
  const location = { origin: 'http://127.0.0.1:8001', pathname: '/' };
  const window = {
    addEventListener(name, callback) { if (name === 'message') listener = callback; },
    postMessage(data) { messages.push(data); },
  };
  const context = {
    window, location, URL, Set, String, chrome: { runtime: {
      getManifest: () => ({ version: '0.3.0' }),
      onMessage: { addListener() {} },
    } },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../chrome-extension/local-app-bridge.js'), 'utf8'), context);
  listener({
    source: window,
    origin: location.origin,
    data: { source: 'music-importer-local-app', type: 'extension-ping', requestId: 'fixture-request-0001' },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{
    source: 'music-importer-local-app', type: 'extension-ready', requestId: 'fixture-request-0001', version: '0.3.0',
  }]);
});
