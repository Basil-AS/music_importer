const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const origin = 'https://music.yandex.ru';

function makePage(fetchHandler) {
  const listeners = new Map();
  const messages = [];
  const requests = [];
  const location = { origin, href: `${origin}/home` };
  async function dispatch(event) {
    return Promise.all((listeners.get('message') || []).map((listener) => listener(event)));
  }
  const window = {
    location,
    addEventListener(name, callback) { listeners.set(name, [...(listeners.get(name) || []), callback]); },
    postMessage(message) {
      messages.push(message);
      if (message.type === 'transfer-progress' && message.progress?.checkpointId) queueMicrotask(() => {
        void dispatch({ source: window, origin, data: {
          source: 'music-importer-yandex', type: 'transfer-progress-ack', checkpointId: message.progress.checkpointId, ok: true,
        } });
      });
    },
    async fetch(url, init = {}) {
      const request = { url: String(url), init };
      requests.push(request);
      const response = await fetchHandler(request);
      return {
        ok: response.status === undefined || (response.status >= 200 && response.status < 300),
        status: response.status || 200,
        headers: { get: (name) => response.headers?.[String(name).toLowerCase()] || null },
        json: async () => response.payload ?? response,
      };
    },
  };
  const context = {
    window, location, URL, URLSearchParams, Promise, Map, Set, String, Number, Array, Object, Error, JSON, Date,
    setTimeout, clearTimeout, console,
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../chrome-extension/yandex-main-world.js'), 'utf8'), context);
  return {
    messages,
    requests,
    async dispatch(type, detail = {}) {
      await dispatch({
        source: window, origin,
        data: { source: 'music-importer-yandex', type, requestId: 'fixture-request-0001', ...detail },
      });
    },
  };
}

const song = (id, title) => ({
  id, title, artists: [{ id: `artist-${id}`, name: 'Artist' }],
  albums: [{ id: `album-${id}`, title: 'Album' }], durationMs: 180000, isrc: 'USABC1234567',
});

test('Yandex source reader confirms favorites, every playlist, order, and empty playlists', async () => {
  const page = makePage(async ({ url, init }) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/account/status') return { result: { account: { uid: 42 } } };
    if (parsed.pathname === '/users/42/likes/tracks') {
      return { result: { library: { revision: 7, tracks: [{ id: 'liked-1' }] } } };
    }
    if (parsed.pathname === '/tracks' && init.method === 'POST') return { result: [song('liked-1', 'Favorite')] };
    if (parsed.pathname === '/users/42/playlists/list') {
      return { result: { playlists: [
        { uid: 42, kind: 10, title: 'Road', trackCount: 2 },
        { uid: 42, kind: 20, title: 'Empty', trackCount: 0 },
      ] } };
    }
    if (parsed.pathname === '/users/42/playlists/list/kinds') return { result: [10, 20] };
    if (parsed.pathname === '/users/42/playlists/10') {
      return { result: { playlist: { title: 'Road', revision: 3, trackCount: 2, tracks: [
        { id: 'road-1', track: song('road-1', 'First') },
        { id: 'road-2', track: song('road-2', 'Second') },
      ] } } };
    }
    if (parsed.pathname === '/users/42/playlists/20') {
      return { result: { playlist: { title: 'Empty', revision: 1, trackCount: 0, tracks: [] } } };
    }
    throw new Error(`Unexpected Yandex request: ${init.method || 'GET'} ${parsed.pathname}`);
  });

  await page.dispatch('start-library-scan');
  const snapshot = page.messages.find((message) => message.type === 'library-snapshot')?.payload;
  assert.ok(snapshot, JSON.stringify(page.messages));
  assert.equal(snapshot.service, 'yandex-music');
  assert.equal(snapshot.completeness.confirmed, true);
  assert.deepEqual(Array.from(snapshot.tracks, (track) => track.id), ['liked-1']);
  assert.deepEqual(Array.from(snapshot.playlists, (playlist) => playlist.title), ['Road', 'Empty']);
  assert.deepEqual(Array.from(snapshot.playlists[0].tracks, (track) => track.position), [0, 1]);
  assert.equal(snapshot.playlists[1].complete, true);
  assert.ok(page.requests.every((request) => request.init.credentials === 'include'));
});

test('Yandex source reader rejects playlist kind mismatches instead of claiming a complete library', async () => {
  const page = makePage(async ({ url }) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/account/status') return { result: { account: { uid: 42 } } };
    if (parsed.pathname === '/users/42/likes/tracks') return { result: { library: { revision: 1, tracks: [] } } };
    if (parsed.pathname === '/users/42/playlists/list') return { result: { playlists: [{ uid: 42, kind: 10, title: 'Road', trackCount: 0 }] } };
    if (parsed.pathname === '/users/42/playlists/list/kinds') return { result: [10, 20] };
    throw new Error(`Unexpected Yandex request: ${parsed.pathname}`);
  });

  await page.dispatch('start-library-scan');
  assert.ok(page.messages.some((message) => message.type === 'scan-error' && /kinds не совпали/i.test(message.error)));
  assert.ok(!page.messages.some((message) => message.type === 'library-snapshot'));
});

test('Yandex catalog search normalizes candidate IDs, album, ISRC, and URL', async () => {
  const page = makePage(async ({ url }) => {
    const parsed = new URL(url);
    if (parsed.pathname !== '/search') throw new Error(`Unexpected Yandex request: ${parsed.pathname}`);
    return { result: { tracks: { results: [song('target-1', 'Target song')] } } };
  });

  await page.dispatch('search-tracks', { query: 'Target song Artist' });
  const response = page.messages.find((message) => message.type === 'command-response');
  assert.equal(response.ok, true);
  assert.deepEqual(Array.from(response.results, (track) => [track.trackId, track.albumId, track.isrc]), [
    ['target-1', 'album-target-1', 'USABC1234567'],
  ]);
  assert.equal(response.results[0].trackViewUrl, 'https://music.yandex.ru/album/album-target-1/track/target-1');
});

test('Yandex album batch lookup reads tracks from found album releases', async () => {
  const page = makePage(async ({ url }) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/search') {
      assert.equal(parsed.searchParams.get('type'), 'album');
      return { result: { albums: { results: [{ id: 55, title: 'Discovery' }] } } };
    }
    if (parsed.pathname === '/albums/55/with-tracks') {
      return { result: { id: 55, title: 'Discovery', volumes: [[
        { id: 1, title: 'One More Time', artists: [{ id: 1, name: 'Daft Punk' }], durationMs: 320357 },
        { id: 2, title: 'Aerodynamic', artists: [{ id: 1, name: 'Daft Punk' }], durationMs: 212546 },
      ]] } };
    }
    throw new Error(`Unexpected Yandex request: ${parsed.pathname}`);
  });
  await page.dispatch('search-album-tracks', { album: 'Discovery', artist: 'Daft Punk' });
  const response = page.messages.find((message) => message.type === 'command-response');

  assert.equal(response.ok, true, response.error);
  assert.deepEqual(Array.from(response.results, (track) => [track.trackId, track.collectionName]), [
    ['1', 'Discovery'], ['2', 'Discovery'],
  ]);
});

test('Yandex catalog search forwards HTTP 429 and Retry-After to the shared search engine', async () => {
  const page = makePage(async () => ({ status: 429, headers: { 'retry-after': '9' }, payload: {} }));
  await page.dispatch('search-tracks', { query: 'Limited Song Artist' });
  const response = page.messages.find((message) => message.type === 'command-response');

  assert.equal(response.ok, false);
  assert.equal(response.status, 429);
  assert.equal(response.retryAfter, '9');
});

test('Yandex target writer adds and verifies favorites and ordered playlist tracks', async () => {
  const favoriteIds = [];
  const playlistItems = [];
  let playlistRevision = 1;
  let playlistCreated = false;
  const page = makePage(async ({ url, init }) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (path === '/account/status') return { result: { account: { uid: 42 } } };
    if (path === '/users/42/likes/tracks') {
      return { result: { library: { revision: favoriteIds.length + 1, tracks: favoriteIds.map((id) => ({ id })) } } };
    }
    if (path === '/users/42/likes/tracks/add-multiple') {
      favoriteIds.push(...new URLSearchParams(init.body).get('track-ids').split(','));
      return { result: { revision: favoriteIds.length + 1 } };
    }
    if (path === '/users/42/playlists/create') {
      playlistCreated = true;
      return { result: { playlist: { kind: 99, title: 'Road' } } };
    }
    if (path === '/users/42/playlists/99') {
      return { result: { playlist: { kind: 99, title: 'Road', revision: playlistRevision, trackCount: playlistItems.length, tracks: playlistItems.map((id) => ({ id })) } } };
    }
    if (path === '/users/42/playlists/99/change-relative') {
      const body = new URLSearchParams(init.body);
      assert.equal(body.get('revision'), String(playlistRevision));
      const diff = JSON.parse(body.get('diff'));
      assert.equal(diff.op, 'insert');
      assert.equal(diff.at, playlistItems.length);
      playlistItems.push(...diff.tracks.map((track) => track.id));
      playlistRevision += 1;
      return { result: { revision: playlistRevision } };
    }
    throw new Error(`Unexpected Yandex request: ${init.method || 'GET'} ${path}`);
  });

  await page.dispatch('execute-transfer', { plan: {
    type: 'music-transfer-plan',
    target: { provider: 'yandex-music', collectionType: 'library' },
    completeness: { source: [{ confirmed: true }] },
    collectionMappings: [{ sourceId: 'source-road', sourceName: 'Road', targetName: 'Road' }],
    operations: [
      { operation: 'add_to_favorites', target: { providerId: 'liked-target' } },
      { operation: 'add_to_playlist', source: { collectionId: 'source-road', position: 0 }, target: { providerId: 'playlist-target', albumId: 'album-target' } },
    ],
  } });

  const response = page.messages.find((message) => message.type === 'command-response');
  assert.equal(response.ok, true, response.error);
  assert.equal(response.report.status, 'complete');
  assert.deepEqual(favoriteIds, ['liked-target']);
  assert.deepEqual(playlistItems, ['playlist-target']);
  assert.equal(playlistCreated, true);
  assert.ok(page.requests.every((request) => request.init.credentials === 'include'));
});

test('Yandex resume checks the existing playlist prefix and appends only missing tracks', async () => {
  const playlistItems = ['target-first'];
  let revision = 7;
  let created = false;
  const page = makePage(async ({ url, init }) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/account/status') return { result: { account: { uid: 42 } } };
    if (parsed.pathname === '/users/42/playlists/99') {
      return { result: { playlist: { kind: 99, title: 'Road', revision, trackCount: playlistItems.length, tracks: playlistItems.map((id) => ({ id })) } } };
    }
    if (parsed.pathname === '/users/42/playlists/99/change-relative') {
      const body = new URLSearchParams(init.body);
      const diff = JSON.parse(body.get('diff'));
      assert.equal(diff.at, playlistItems.length);
      playlistItems.push(...diff.tracks.map((track) => track.id));
      revision += 1;
      return { result: { revision } };
    }
    if (parsed.pathname === '/users/42/playlists/create') { created = true; throw new Error('Resume must reuse the saved target ID.'); }
    throw new Error(`Unexpected Yandex request: ${parsed.pathname}`);
  });
  await page.dispatch('execute-transfer', { plan: {
    type: 'music-transfer-plan',
    target: { provider: 'yandex-music', collectionType: 'playlists' },
    completeness: { source: [{ confirmed: true }] },
    collectionMappings: [{ sourceId: 'source-road', sourceName: 'Road', targetName: 'Road' }],
    operations: ['target-first', 'target-second'].map((providerId, position) => ({
      operation: 'add_to_playlist', source: { collectionId: 'source-road', position },
      target: { providerId, albumId: `album-${providerId}` },
    })),
    recovery: {
      playlistTargets: { 'source-road': '99' },
      progress: { phase: 'playlist-items', sourceKey: 'source-road', targetPlaylistId: '99', playlistIndex: 0 },
    },
  } });

  const response = page.messages.find((message) => message.type === 'command-response');
  assert.equal(response.ok, true, response.error);
  assert.deepEqual(playlistItems, ['target-first', 'target-second']);
  assert.equal(created, false);
});
