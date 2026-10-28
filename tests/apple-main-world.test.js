const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function makePage(fixtures, userTokenHeader = 'music-user-token', checkpointAck = true, timerScale = 1) {
  const listeners = new Map();
  const messages = [];
  const requests = [];
  const token = 'fixture-only-credential';
  const location = { origin: 'https://music.apple.com', href: 'https://music.apple.com/library/songs' };
  async function dispatch(event) {
    return Promise.all((listeners.get('message') || []).map((listener) => listener(event)));
  }
  const window = {
    location,
    addEventListener(name, callback) { listeners.set(name, [...(listeners.get(name) || []), callback]); },
    postMessage(data) {
      messages.push(data);
      if (data.type === 'transfer-progress' && data.progress?.checkpointId) queueMicrotask(() => {
        void dispatch({ source: window, origin: location.origin, data: {
          source: 'music-importer-apple', type: 'transfer-progress-ack', checkpointId: data.progress.checkpointId,
          ok: typeof checkpointAck === 'function' ? checkpointAck(data.progress) : checkpointAck,
        } });
      });
    },
    fetch: async (url, init = {}) => {
      requests.push({ url: String(url), method: init.method || 'GET', body: init.body || null, headers: new Headers(init.headers || {}) });
      const key = new URL(String(url)).pathname + new URL(String(url)).search;
      const fixture = fixtures[`${init.method || 'GET'} ${key}`]
        ?? fixtures[key]
        ?? Object.entries(fixtures).find(([route]) => route.endsWith('*') && key.startsWith(route.slice(0, -1)))?.[1];
      if (!fixture) return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) };
      const response = typeof fixture === 'function' ? fixture({ url: String(url), init, requests }) : fixture;
      const status = response?.status || 200;
      return {
        ok: status >= 200 && status < 300, status, headers: new Headers(response?.headers || {}),
        clone: () => ({ arrayBuffer: async () => {
          if (!response?.pendingBody) return new ArrayBuffer(0);
          await new Promise((resolve, reject) => {
            if (init.signal.aborted) reject(new Error('aborted'));
            else init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
          return new ArrayBuffer(0);
        } }),
        json: async () => response?.payload ?? response,
      };
    },
  };
  const context = {
    window, location, URL, URLSearchParams, Headers, Request, Promise, Map, Set, String, Number, Array, Object, Error, JSON, Date,
    setTimeout: (callback, delay, ...args) => setTimeout(callback, delay * timerScale, ...args),
    clearTimeout, console, AbortController,
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../chrome-extension/apple-main-world.js'), 'utf8'), context);
  return {
    messages,
    requests,
    async scan() {
      await window.fetch('https://amp-api.music.apple.com/v1/me/storefront', {
        headers: { authorization: `Bearer ${token}`, [userTokenHeader]: token },
      });
      await dispatch({
        source: window,
        origin: location.origin,
        data: { source: 'music-importer-apple', type: 'start-library-scan' },
      });
      return messages.find((message) => message.type === 'library-snapshot')?.payload;
    },
    async command(action, details = {}) {
      await window.fetch('https://amp-api.music.apple.com/v1/me/storefront', {
        headers: { authorization: `Bearer ${token}`, [userTokenHeader]: token },
      });
      await dispatch({
        source: window, origin: location.origin,
        data: { source: 'music-importer-apple', type: 'command', requestId: 'fixture-command-0001', action, ...details },
      });
      return messages.filter((message) => message.type === 'command-result').at(-1);
    },
    token,
  };
}

test('Apple source reader classifies favorites and preserves playlist duplicates and order', async () => {
  const fixtures = {
    '/v1/me/library/songs?limit=100': {
      meta: { total: 2 }, next: '/v1/me/library/songs?limit=100&offset=1',
      data: [{ id: 'library-song-1', attributes: { name: 'Liked track', artistName: 'Artist', albumName: 'Album', inFavorites: true, playParams: { id: 'catalog-track-1' }, isrc: 'USABC1234567' } }],
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
  assert.equal(payload.tracks[0].catalogId, 'catalog-track-1');
  assert.equal(payload.playlists.length, 2);
  assert.equal(payload.playlists[0].tracks.length, 2);
  assert.deepEqual(Array.from(payload.playlists[0].tracks, (track) => track.position), [0, 1]);
  assert.equal(payload.playlists[1].complete, true);
  assert.ok(page.requests.every((request) => request.headers.get('authorization') === `Bearer ${page.token}`));
  assert.ok(!JSON.stringify(page.messages).includes(page.token));
});

test('Apple Music reader times out a response body that stalls after headers', async () => {
  const page = makePage({
    '/v1/me/library/songs?limit=100': { pendingBody: true },
    '/v1/me/library/playlists?limit=100': { pendingBody: true },
  }, 'music-user-token', true, 0.001);
  await page.scan();
  assert.match(page.messages.find((message) => message.type === 'scan-error')?.error || '', /не загрузил ответ за 45 с/);
  assert.ok(!page.messages.some((message) => message.type === 'library-snapshot'));
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

test('Apple source reader follows more than 10,000 pages without an artificial item cap', async () => {
  const total = 10001;
  const page = makePage({
    '/v1/me/library/songs?limit=100*': ({ url }) => {
      const offset = Number(new URL(url).searchParams.get('offset') || 0);
      return {
        meta: { total },
        next: offset + 1 < total ? `/v1/me/library/songs?limit=100&offset=${offset + 1}` : null,
        data: [{ id: `song-${offset}`, attributes: { name: `Song ${offset}`, artistName: 'Artist', inFavorites: true } }],
      };
    },
    '/v1/me/library/playlists?limit=100': { meta: { total: 0 }, next: null, data: [] },
  });

  const payload = await page.scan();

  assert.equal(payload.completeness.librarySongsCount, total);
  assert.equal(payload.tracks.length, total);
  assert.equal(page.requests.filter((request) => request.url.includes('/v1/me/library/songs')).length, total);
});

test('Apple page session preserves the observed Media-User-Token header spelling', async () => {
  const page = makePage({
    '/v1/me/library/songs?limit=100': { meta: { total: 0 }, next: null, data: [] },
    '/v1/me/library/playlists?limit=100': { meta: { total: 0 }, next: null, data: [] },
  }, 'media-user-token');
  await page.scan();

  const libraryRequest = page.requests.find((request) => request.url.includes('/v1/me/library/songs'));
  assert.equal(libraryRequest.headers.get('media-user-token'), page.token);
  assert.equal(libraryRequest.headers.get('music-user-token'), null);
  assert.ok(!JSON.stringify(page.messages).includes(page.token));
});

test('Apple catalog search returns catalog song IDs without exposing session headers', async () => {
  const page = makePage({
    'GET /v1/catalog/ae/search?term=One+More+Time+Daft+Punk&types=songs&limit=25': {
      results: { songs: { data: [{
        id: 'catalog-song-1',
        attributes: { name: 'One More Time', artistName: 'Daft Punk', albumName: 'Discovery', url: 'https://music.apple.com/ae/song/one-more-time/1' },
      }] } },
    },
  });
  const result = await page.command('search-tracks', { query: 'One More Time Daft Punk', storefront: 'AE' });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.result[0].trackId, 'catalog-song-1');
  assert.equal(result.result[0].trackName, 'One More Time');
  assert.ok(page.requests[1].url.startsWith('https://amp-api.music.apple.com/v1/catalog/ae/search?'));
  assert.ok(!JSON.stringify(page.messages).includes(page.token));
});

test('Apple catalog search forwards HTTP 429 and Retry-After to the shared search engine', async () => {
  const page = makePage({
    'GET /v1/catalog/ae/search?term=Limited+Song&types=songs&limit=25': {
      status: 429,
      headers: { 'retry-after': '6' },
      payload: {},
    },
  });
  const result = await page.command('search-tracks', { query: 'Limited Song', storefront: 'AE' });

  assert.equal(result.ok, false);
  assert.equal(result.status, 429);
  assert.equal(result.retryAfter, '6');
  assert.equal(page.requests.filter((request) => request.url.includes('/v1/catalog/ae/search?')).length, 1);
});

test('Apple catalog search accepts a batch of ISRCs and keeps each result ISRC', async () => {
  const page = makePage({
    'GET /v1/catalog/ae/songs?filter%5Bisrc%5D=USABC1234567%2CGBDEF1234567&limit=25': {
      data: [
        { id: 'catalog-song-a', attributes: { name: 'Song A', artistName: 'Artist A', isrc: 'USABC1234567' } },
        { id: 'catalog-song-b', attributes: { name: 'Song B', artistName: 'Artist B', isrc: 'GBDEF1234567' } },
      ],
    },
  });
  const result = await page.command('search-tracks', {
    query: 'isrc:USABC1234567,GBDEF1234567', storefront: 'AE',
  });

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(Array.from(result.result, (song) => [song.trackId, song.isrc]), [
    ['catalog-song-a', 'USABC1234567'],
    ['catalog-song-b', 'GBDEF1234567'],
  ]);
  assert.equal(page.requests[1].url, 'https://amp-api.music.apple.com/v1/catalog/ae/songs?filter%5Bisrc%5D=USABC1234567%2CGBDEF1234567&limit=25');
});

test('Apple album batch search returns tracks from matching catalog album pages', async () => {
  const page = makePage({
    '/v1/catalog/ae/search?term=Discovery+Daft+Punk&types=albums&limit=5': {
      results: { albums: { data: [{ id: 'album-1', attributes: { name: 'Discovery' } }] } },
    },
    '/v1/catalog/ae/albums/album-1/tracks?limit=100': {
      data: [
        { id: 'song-1', attributes: { name: 'One More Time', artistName: 'Daft Punk', durationInMillis: 320357 } },
        { id: 'song-2', attributes: { name: 'Aerodynamic', artistName: 'Daft Punk', durationInMillis: 212546 } },
      ],
      next: null,
    },
  });
  const result = await page.command('search-album-tracks', { album: 'Discovery', artist: 'Daft Punk', storefront: 'AE' });

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(Array.from(result.result, (track) => [track.trackId, track.collectionName]), [
    ['song-1', 'Discovery'], ['song-2', 'Discovery'],
  ]);
  assert.equal(page.requests.filter((request) => request.url.includes('/v1/catalog/ae/')).length, 2);
});

test('Apple target writer adds favorites and ordered playlist items, then verifies both', async () => {
  let favoriteReads = 0;
  const fixtures = {
    'GET /v1/me/library/songs?limit=100': () => {
      favoriteReads += 1;
      return favoriteReads === 1
        ? { meta: { total: 0 }, next: null, data: [] }
        : { meta: { total: 1 }, next: null, data: [{ id: 'library-song-a', attributes: { inFavorites: true, playParams: { id: 'catalog-song-a' } } }] };
    },
    'POST /v1/me/favorites?ids%5Bsongs%5D=catalog-song-a': { status: 202, payload: {} },
    'POST /v1/me/library/playlists': {
      status: 201,
      payload: { data: [{ id: 'playlist-created', type: 'library-playlists', attributes: { name: 'Road' } }] },
    },
    'POST /v1/me/library/playlists/playlist-created/tracks': { status: 204, payload: {} },
    'GET /v1/me/library/playlists/playlist-created/tracks?limit=100': {
      meta: { total: 1 }, next: null,
      data: [{ id: 'library-song-b', attributes: { playParams: { id: 'catalog-song-b' } } }],
    },
  };
  const page = makePage(fixtures);
  const result = await page.command('execute-transfer', {
    plan: {
      type: 'music-transfer-plan',
      target: { provider: 'apple-music', collectionType: 'library' },
      completeness: { source: [{ confirmed: true }] },
      collectionMappings: [{ sourceId: 'source-playlist', sourceName: 'Road', targetName: 'Road' }],
      operations: [
        { operation: 'add_to_favorites', target: { providerId: 'catalog-song-a' } },
        { operation: 'add_to_playlist', source: { collectionId: 'source-playlist', position: 0 }, target: { providerId: 'catalog-song-b' } },
      ],
    },
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.result.status, 'complete');
  assert.equal(result.result.favorites.verified, 1);
  assert.equal(result.result.playlists[0].verified, 1);
  assert.deepEqual(JSON.parse(page.requests.find((request) => request.method === 'POST' && request.url.includes('/tracks')).body), {
    data: [{ id: 'catalog-song-b', type: 'songs' }],
  });
  assert.deepEqual(JSON.parse(page.requests.find((request) => request.method === 'POST' && request.url.endsWith('/library/playlists')).body), {
    attributes: { name: 'Road', description: '', isPublic: false },
  });
  assert.ok(!JSON.stringify(page.messages).includes(page.token));
});

test('Apple resume validates the existing playlist prefix and writes only the missing suffix', async () => {
  let playlistIds = ['catalog-song-a'];
  const page = makePage({
    'POST /v1/me/library/playlists/playlist-resume/tracks': ({ init }) => {
      playlistIds.push(...JSON.parse(init.body).data.map((item) => item.id));
      return { status: 204, payload: {} };
    },
    'GET /v1/me/library/playlists/playlist-resume/tracks?limit=100': () => ({
      meta: { total: playlistIds.length }, next: null,
      data: playlistIds.map((id, index) => ({ id: `library-${index}`, attributes: { playParams: { id } } })),
    }),
  });
  const result = await page.command('execute-transfer', {
    plan: {
      type: 'music-transfer-plan',
      target: { provider: 'apple-music', collectionType: 'playlists' },
      completeness: { source: [{ confirmed: true }] },
      collectionMappings: [{ sourceId: 'source-playlist', sourceName: 'Road', targetName: 'Road' }],
      operations: ['catalog-song-a', 'catalog-song-b'].map((providerId, position) => ({
        operation: 'add_to_playlist', source: { collectionId: 'source-playlist', position }, target: { providerId },
      })),
      recovery: {
        playlistTargets: { 'source-playlist': 'playlist-resume' },
        progress: { phase: 'playlist-items', sourceKey: 'source-playlist', targetPlaylistId: 'playlist-resume', playlistIndex: 0 },
      },
    },
  });

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(playlistIds, ['catalog-song-a', 'catalog-song-b']);
  assert.equal(page.requests.filter((request) => request.method === 'POST' && request.url.endsWith('/library/playlists')).length, 0);
  const append = page.requests.find((request) => request.method === 'POST' && request.url.endsWith('/tracks'));
  assert.deepEqual(JSON.parse(append.body).data.map((item) => item.id), ['catalog-song-b']);
});

test('Apple resume stops without writing when the saved playlist does not match the plan prefix', async () => {
  const page = makePage({
    'GET /v1/me/library/playlists/playlist-resume/tracks?limit=100': {
      meta: { total: 1 }, next: null,
      data: [{ id: 'library-existing', attributes: { playParams: { id: 'different-track' } } }],
    },
  });
  const result = await page.command('execute-transfer', {
    plan: {
      type: 'music-transfer-plan',
      target: { provider: 'apple-music', collectionType: 'playlists' },
      completeness: { source: [{ confirmed: true }] },
      collectionMappings: [{ sourceId: 'source-playlist', sourceName: 'Road', targetName: 'Road' }],
      operations: [{ operation: 'add_to_playlist', source: { collectionId: 'source-playlist', position: 0 }, target: { providerId: 'expected-track' } }],
      recovery: {
        playlistTargets: { 'source-playlist': 'playlist-resume' },
        progress: { phase: 'playlist-items', sourceKey: 'source-playlist', targetPlaylistId: 'playlist-resume', playlistIndex: 0 },
      },
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /не является префиксом плана/i);
  assert.equal(page.requests.filter((request) => request.method === 'POST').length, 0);
});

test('Apple creates no playlist when the pre-create checkpoint is not durable', async () => {
  const page = makePage({
    'POST /v1/me/library/playlists': { status: 201, payload: { data: [{ id: 'should-not-exist', type: 'library-playlists', attributes: { name: 'Road' } }] } },
  }, 'music-user-token', false);
  const result = await page.command('execute-transfer', { plan: {
    type: 'music-transfer-plan',
    target: { provider: 'apple-music', collectionType: 'playlists' },
    completeness: { source: [{ confirmed: true }] },
    collectionMappings: [{ sourceId: 'source-playlist', sourceName: 'Road', targetName: 'Road' }],
    operations: [{ operation: 'add_to_playlist', source: { collectionId: 'source-playlist', position: 0 }, target: { providerId: 'expected-track' } }],
  } });

  assert.equal(result.ok, false);
  assert.match(result.error, /контрольную точку перед созданием/i);
  assert.equal(page.requests.filter((request) => request.method === 'POST').length, 0);
});

test('Apple target writer refuses an incomplete source before mutating the account', async () => {
  const page = makePage({});
  const result = await page.command('execute-transfer', {
    plan: {
      type: 'music-transfer-plan',
      target: { provider: 'apple-music', collectionType: 'favorites' },
      completeness: { source: [{ confirmed: false }] },
      operations: [{ operation: 'add_to_favorites', target: { providerId: 'catalog-song-a' } }],
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /полнота исходной библиотеки не подтверждена/i);
  assert.equal(page.requests.filter((request) => request.method === 'POST').length, 0);
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
      getManifest: () => ({ version: '0.10.0' }),
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
    source: 'music-importer-local-app', type: 'extension-ready', requestId: 'fixture-request-0001', version: '0.10.0',
  }]);
});

test('local app bridge forwards only the selected providers for onboarding', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const posted = [];
  const sent = [];
  let listener;
  const location = { origin: 'http://127.0.0.1:8001', pathname: '/' };
  const window = {
    addEventListener(name, callback) { if (name === 'message') listener = callback; },
    postMessage(data) { posted.push(data); },
  };
  const context = {
    window, location, URL, Set, String, chrome: { runtime: {
      sendMessage: async (message) => { sent.push(message); return { ok: true, opened: ['spotify'], alreadyOpen: ['apple-music'] }; },
      getManifest: () => ({ version: '0.13.19' }),
      onMessage: { addListener() {} },
    } },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../chrome-extension/local-app-bridge.js'), 'utf8'), context);
  listener({
    source: window,
    origin: location.origin,
    data: {
      source: 'music-importer-local-app', type: 'open-provider-tabs', requestId: 'fixture-request-0002',
      providerIds: ['apple-music', 'spotify'],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{
    type: 'music-importer:open-provider-tabs', providerIds: ['apple-music', 'spotify'],
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{
    source: 'music-importer-local-app', type: 'provider-tabs-response', requestId: 'fixture-request-0002',
    ok: true, opened: ['spotify'], alreadyOpen: ['apple-music'], error: null,
  }]);
});
