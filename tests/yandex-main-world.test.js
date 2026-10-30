const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const origin = 'https://music.yandex.ru';

function makePage(fetchHandler, timerScale = 1) {
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
        json: async () => {
          if (!response.pendingBody) return response.payload ?? response;
          await new Promise((resolve, reject) => {
            if (init.signal.aborted) reject(new Error('aborted'));
            else init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
          return response.payload ?? response;
        },
      };
    },
  };
  const context = {
    window, location, URL, URLSearchParams, Promise, Map, Set, String, Number, Array, Object, Error, JSON, Date,
    setTimeout: (callback, delay, ...args) => setTimeout(callback, delay * timerScale, ...args),
    clearTimeout, console, AbortController,
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

test('Yandex trusts a complete virtual playlist detail when its list catalog count is stale', async () => {
  const page = makePage(async ({ url }) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/account/status') return { result: { account: { uid: 42 } } };
    if (parsed.pathname === '/users/42/likes/tracks') return { result: { library: { revision: 7, tracks: [] } } };
    if (parsed.pathname === '/users/42/playlists/list') {
      return { result: { playlists: [{ uid: 42, kind: 99, title: 'Virtual', trackCount: 9 }] } };
    }
    if (parsed.pathname === '/users/42/playlists/list/kinds') return { result: [99] };
    if (parsed.pathname === '/users/42/playlists/99') {
      const requestedPage = Number(parsed.searchParams.get('page'));
      if (requestedPage === 1) return { result: { playlist: {
        title: 'Virtual', revision: 4, trackCount: 3, pager: { total: 3, page: 1, perPage: 2 }, tracks: [
          { id: 'virtual-1', track: song('virtual-1', 'First') },
          { id: 'virtual-2', track: song('virtual-2', 'Second') },
        ],
      } } };
      if (requestedPage === 2) return { result: { playlist: {
        title: 'Virtual', revision: 4, trackCount: 3, pager: { total: 3, page: 2, perPage: 2 }, tracks: [
          { id: 'virtual-3', track: song('virtual-3', 'Third') },
        ],
      } } };
    }
    if (parsed.pathname === '/users/42/likes/albums') return { result: [] };
    throw new Error(`Unexpected Yandex request: ${parsed.pathname}`);
  });

  await page.dispatch('start-library-scan');
  const snapshot = page.messages.find((message) => message.type === 'library-snapshot')?.payload;
  assert.ok(snapshot, JSON.stringify(page.messages));
  assert.equal(snapshot.completeness.confirmed, true);
  assert.equal(snapshot.playlists[0].trackCount, 3);
  assert.deepEqual(Array.from(snapshot.playlists[0].tracks, (track) => track.id), [
    'virtual-1', 'virtual-2', 'virtual-3',
  ]);
});

test('Yandex source reader refuses an unsafe favorites revision before saving a partial snapshot', async () => {
  const page = makePage(async ({ url }) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/account/status') return { result: { account: { uid: 42 } } };
    if (parsed.pathname === '/users/42/likes/tracks') {
      return { result: { library: { revision: Number.MAX_SAFE_INTEGER + 1, tracks: [] } } };
    }
    throw new Error(`Unexpected Yandex request: ${parsed.pathname}`);
  });

  await page.dispatch('start-library-scan');
  assert.ok(page.messages.some((message) => message.type === 'scan-error' && /список лайков/i.test(message.error)));
  assert.equal(page.messages.some((message) => message.type === 'favorites-snapshot'), false);
  assert.equal(page.messages.some((message) => message.type === 'library-snapshot'), false);
});

test('Yandex emits a separately confirmed favorites snapshot before a playlist scan can fail', async () => {
  const page = makePage(async ({ url, init }) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/account/status') return { result: { account: { uid: 42 } } };
    if (parsed.pathname === '/users/42/likes/tracks') return { result: { library: { revision: 7, tracks: [{ id: 'liked-1' }] } } };
    if (parsed.pathname === '/tracks' && init.method === 'POST') return { result: [song('liked-1', 'Favorite')] };
    if (parsed.pathname === '/users/42/playlists/list') return { status: 400, payload: { error: 'fixture playlist failure' } };
    throw new Error(`Unexpected Yandex request: ${init.method || 'GET'} ${parsed.pathname}`);
  });

  await page.dispatch('start-library-scan');
  const partial = page.messages.find((message) => message.type === 'favorites-snapshot')?.payload;
  assert.ok(partial, JSON.stringify(page.messages));
  assert.equal(partial.partialScope, 'favorites');
  assert.equal(partial.completeness.confirmed, false);
  assert.equal(partial.completeness.favoritesConfirmed, true);
  assert.equal(partial.completeness.favoritesCount, 1);
  assert.deepEqual(Array.from(partial.tracks, (track) => [track.id, track.position, track.collectionType]), [['liked-1', 0, 'favorites']]);
  assert.deepEqual(Array.from(partial.playlists), []);
  assert.ok(page.messages.some((message) => message.type === 'scan-error'));
  assert.equal(page.messages.some((message) => message.type === 'library-snapshot'), false);
});

test('Yandex source reader follows playlist pages and preserves item order', async () => {
  const page = makePage(async ({ url, init }) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/account/status') return { result: { account: { uid: 42 } } };
    if (parsed.pathname === '/users/42/likes/tracks') return { result: { library: { revision: 7, tracks: [] } } };
    if (parsed.pathname === '/users/42/playlists/list') {
      return { result: { playlists: [{ uid: 42, kind: 30, title: 'Paged', trackCount: 3 }] } };
    }
    if (parsed.pathname === '/users/42/playlists/list/kinds') return { result: [30] };
    if (parsed.pathname === '/users/42/playlists/30' && init.method !== 'POST') {
      const requestedPage = Number(parsed.searchParams.get('page'));
      assert.equal(parsed.searchParams.get('pageSize'), '100');
      assert.equal(parsed.searchParams.get('trackPlayCounts'), 'false');
      assert.equal(parsed.searchParams.get('richTracks'), 'true');
      if (requestedPage === 1) return { result: { playlist: {
        title: 'Paged', revision: 3, trackCount: 3, pager: { total: 3, page: 1, per_page: 2 }, tracks: [
          { id: 'paged-1', track: song('paged-1', 'First') },
          { id: 'paged-2', track: song('paged-2', 'Second') },
        ],
      } } };
      if (requestedPage === 2) return { result: { playlist: {
        title: 'Paged', revision: 3, trackCount: 3, pager: { total: 3, page: 2, per_page: 2 }, tracks: [
          { id: 'paged-3', track: song('paged-3', 'Third') },
        ],
      } } };
    }
    throw new Error(`Unexpected Yandex request: ${init.method || 'GET'} ${parsed.pathname}`);
  });

  await page.dispatch('start-library-scan');
  const snapshot = page.messages.find((message) => message.type === 'library-snapshot')?.payload;
  assert.ok(snapshot, JSON.stringify(page.messages));
  assert.deepEqual(Array.from(snapshot.playlists[0].tracks, (track) => track.id), ['paged-1', 'paged-2', 'paged-3']);
  assert.deepEqual(Array.from(snapshot.playlists[0].tracks, (track) => track.position), [0, 1, 2]);
  assert.equal(page.requests.filter((request) => new URL(request.url).pathname === '/users/42/playlists/30').length, 2);
});

test('Yandex source reader rejects a playlist revision change between pages even when trackCount is stable', async () => {
  const page = makePage(async ({ url }) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/account/status') return { result: { account: { uid: 42 } } };
    if (parsed.pathname === '/users/42/likes/tracks') return { result: { library: { revision: 7, tracks: [] } } };
    if (parsed.pathname === '/users/42/playlists/list') {
      return { result: { playlists: [{ uid: 42, kind: 32, title: 'Changing', trackCount: 3 }] } };
    }
    if (parsed.pathname === '/users/42/playlists/list/kinds') return { result: [32] };
    if (parsed.pathname === '/users/42/playlists/32') {
      const requestedPage = Number(parsed.searchParams.get('page'));
      if (requestedPage === 1) return { result: { playlist: {
        title: 'Changing', revision: 10, trackCount: 3, pager: { total: 3, page: 1, perPage: 2 }, tracks: [
          { id: 'changing-1', track: song('changing-1', 'First') },
          { id: 'changing-2', track: song('changing-2', 'Second') },
        ],
      } } };
      if (requestedPage === 2) return { result: { playlist: {
        title: 'Changing', revision: 11, trackCount: 3, pager: { total: 3, page: 2, perPage: 2 }, tracks: [
          { id: 'changing-3', track: song('changing-3', 'Third') },
        ],
      } } };
    }
    throw new Error(`Unexpected Yandex request: ${parsed.pathname}`);
  });

  await page.dispatch('start-library-scan');
  assert.ok(page.messages.some((message) => message.type === 'scan-error' && /изменился во время чтения \(revision\)/i.test(message.error)));
  assert.ok(!page.messages.some((message) => message.type === 'library-snapshot'));
});

test('Yandex reports which completeness evidence is missing from a virtual playlist response', async () => {
  const page = makePage(async ({ url, init }) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/account/status') return { result: { account: { uid: 42 } } };
    if (parsed.pathname === '/users/42/likes/tracks') return { result: { library: { revision: 7, tracks: [] } } };
    if (parsed.pathname === '/users/42/playlists/list') {
      return { result: { playlists: [{ uid: 42, kind: 99, title: 'Virtual', trackCount: 3 }] } };
    }
    if (parsed.pathname === '/users/42/playlists/list/kinds') return { result: [99] };
    if (parsed.pathname === '/users/42/playlists/99' && init.method !== 'POST') {
      return { result: { playlist: { title: 'Virtual', trackCount: 3, tracks: [{ id: 'track-1' }] } } };
    }
    throw new Error(`Unexpected Yandex request: ${init.method || 'GET'} ${parsed.pathname}`);
  });

  await page.dispatch('start-library-scan');

  const error = page.messages.find((message) => message.type === 'scan-error');
  assert.match(error?.error || '', /не подтверждены поля: revision/i);
  assert.ok(!JSON.stringify(error).includes('token'));
});

test('Yandex source reader refuses a truncated playlist when paging metadata is missing', async () => {
  const page = makePage(async ({ url }) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/account/status') return { result: { account: { uid: 42 } } };
    if (parsed.pathname === '/users/42/likes/tracks') return { result: { library: { revision: 7, tracks: [] } } };
    if (parsed.pathname === '/users/42/playlists/list') {
      return { result: { playlists: [{ uid: 42, kind: 31, title: 'Truncated', trackCount: 3 }] } };
    }
    if (parsed.pathname === '/users/42/playlists/list/kinds') return { result: [31] };
    if (parsed.pathname === '/users/42/playlists/31') return { result: { playlist: {
      title: 'Truncated', revision: 3, trackCount: 3, tracks: [{ id: 'one', track: song('one', 'One') }],
    } } };
    throw new Error(`Unexpected Yandex request: ${parsed.pathname}`);
  });

  await page.dispatch('start-library-scan');
  assert.ok(page.messages.some((message) => message.type === 'scan-error' && /обрезан.*пагинации/i.test(message.error)));
  assert.ok(!page.messages.some((message) => message.type === 'library-snapshot'));
});

test('Yandex source reader times out a response body that stalls after headers', async () => {
  const page = makePage(async () => ({ pendingBody: true }), 0.001);
  await page.dispatch('start-library-scan');
  assert.match(page.messages.find((message) => message.type === 'scan-error')?.error || '', /не ответила за 45 с/);
  assert.ok(!page.messages.some((message) => message.type === 'library-snapshot'));
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
  assert.ok(page.messages.some((message) => message.type === 'scan-error' && /kinds не совпали: количество записей различается/i.test(message.error)));
  assert.ok(!page.messages.some((message) => message.type === 'library-snapshot'));
});

test('Yandex reports same-count playlist kind membership mismatches separately', async () => {
  const page = makePage(async ({ url }) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/account/status') return { result: { account: { uid: 42 } } };
    if (parsed.pathname === '/users/42/likes/tracks') return { result: { library: { revision: 1, tracks: [] } } };
    if (parsed.pathname === '/users/42/playlists/list') return { result: { playlists: [{ uid: 42, kind: 10, title: 'Road', trackCount: 0 }] } };
    if (parsed.pathname === '/users/42/playlists/list/kinds') return { result: [20] };
    throw new Error(`Unexpected Yandex request: ${parsed.pathname}`);
  });

  await page.dispatch('start-library-scan');
  assert.ok(page.messages.some((message) => message.type === 'scan-error' && /состав значений различается/i.test(message.error)));
  assert.ok(!page.messages.some((message) => message.type === 'library-snapshot'));
});

test('Yandex source reader preserves liked IDs when a track card has no usable metadata', async () => {
  const page = makePage(async ({ url, init }) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/account/status') return { result: { account: { uid: 42 } } };
    if (parsed.pathname === '/users/42/likes/tracks') {
      return { result: { library: { revision: 8, tracks: [{ id: 'known-1' }, { id: 'known-2' }] } } };
    }
    if (parsed.pathname === '/tracks' && init.method === 'POST') {
      return { result: [song('known-1', 'Known track'), { id: 'known-2' }] };
    }
    if (parsed.pathname === '/users/42/playlists/list') return { result: { playlists: [] } };
    if (parsed.pathname === '/users/42/playlists/list/kinds') return { result: [] };
    throw new Error(`Unexpected Yandex request: ${parsed.pathname}`);
  });

  await page.dispatch('start-library-scan');
  const snapshot = page.messages.find((message) => message.type === 'library-snapshot')?.payload;
  assert.ok(snapshot, JSON.stringify(page.messages));
  assert.equal(snapshot.completeness.confirmed, true);
  assert.equal(snapshot.completeness.metadataComplete, false);
  assert.equal(snapshot.completeness.metadataIncompleteCount, 1);
  assert.deepEqual(Array.from(snapshot.tracks, (track) => track.id), ['known-1', 'known-2']);
  assert.equal(snapshot.tracks[1].metadataComplete, false);
  assert.equal(snapshot.tracks[1].title, '');
});

test('Yandex source reader preserves collection IDs omitted from track hydration', async () => {
  const page = makePage(async ({ url, init }) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/account/status') return { result: { account: { uid: 42 } } };
    if (parsed.pathname === '/users/42/likes/tracks') {
      return { result: { library: { revision: 9, tracks: [{ id: 'known-1' }, { id: 'known-2' }] } } };
    }
    if (parsed.pathname === '/tracks' && init.method === 'POST') return { result: [song('known-1', 'Known track')] };
    if (parsed.pathname === '/users/42/playlists/list') return { result: { playlists: [] } };
    if (parsed.pathname === '/users/42/playlists/list/kinds') return { result: [] };
    throw new Error(`Unexpected Yandex request: ${parsed.pathname}`);
  });

  await page.dispatch('start-library-scan');
  const snapshot = page.messages.find((message) => message.type === 'library-snapshot')?.payload;
  assert.ok(snapshot, JSON.stringify(page.messages));
  assert.equal(snapshot.completeness.confirmed, true);
  assert.equal(snapshot.completeness.favoritesCount, 2);
  assert.equal(snapshot.completeness.metadataComplete, false);
  assert.equal(snapshot.completeness.metadataIncompleteCount, 1);
  assert.deepEqual(Array.from(snapshot.tracks, (track) => track.id), ['known-1', 'known-2']);
  assert.equal(snapshot.tracks[1].metadataComplete, false);
  assert.equal(snapshot.tracks[1].title, '');
});

test('Yandex source reader retries only track cards omitted by a successful batch', async () => {
  const page = makePage(async ({ url, init }) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/account/status') return { result: { account: { uid: 42 } } };
    if (parsed.pathname === '/users/42/likes/tracks') {
      return { result: { library: { revision: 12, tracks: [{ id: 'known-1' }, { id: 'recovered-2' }] } } };
    }
    if (parsed.pathname === '/tracks' && init.method === 'POST') {
      const ids = new URLSearchParams(init.body).get('track-ids').split(',');
      if (ids.length > 1) return { result: [song('known-1', 'Known track')] };
      if (ids[0] === 'recovered-2') return { result: [song('recovered-2', 'Recovered track')] };
    }
    if (parsed.pathname === '/users/42/playlists/list') return { result: { playlists: [] } };
    if (parsed.pathname === '/users/42/playlists/list/kinds') return { result: [] };
    throw new Error(`Unexpected Yandex request: ${init.method || 'GET'} ${parsed.pathname}`);
  });

  await page.dispatch('start-library-scan');
  const snapshot = page.messages.find((message) => message.type === 'library-snapshot')?.payload;
  assert.ok(snapshot, JSON.stringify(page.messages));
  assert.equal(snapshot.completeness.confirmed, true);
  assert.equal(snapshot.completeness.metadataComplete, true);
  assert.deepEqual(Array.from(snapshot.tracks, (track) => track.title), ['Known track', 'Recovered track']);
  assert.equal(page.requests.filter((request) => new URL(request.url).pathname === '/tracks').length, 2);
});

test('Yandex library reads retry HTTP 429 using Retry-After before confirming the snapshot', async () => {
  let hydrationAttempts = 0;
  const page = makePage(async ({ url, init }) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/account/status') return { result: { account: { uid: 42 } } };
    if (parsed.pathname === '/users/42/likes/tracks') {
      return { result: { library: { revision: 10, tracks: [{ id: 'liked-1' }] } } };
    }
    if (parsed.pathname === '/tracks' && init.method === 'POST') {
      hydrationAttempts += 1;
      if (hydrationAttempts === 1) return { status: 429, headers: { 'retry-after': '0' }, payload: {} };
      return { result: [song('liked-1', 'Favorite')] };
    }
    if (parsed.pathname === '/users/42/playlists/list') return { result: { playlists: [] } };
    if (parsed.pathname === '/users/42/playlists/list/kinds') return { result: [] };
    throw new Error(`Unexpected Yandex request: ${parsed.pathname}`);
  });

  await page.dispatch('start-library-scan');
  const snapshot = page.messages.find((message) => message.type === 'library-snapshot')?.payload;
  assert.ok(snapshot, JSON.stringify(page.messages));
  assert.equal(hydrationAttempts, 2);
  assert.equal(snapshot.completeness.confirmed, true);
});

test('Yandex library reads retry temporary network failures', async () => {
  let hydrationAttempts = 0;
  const page = makePage(async ({ url, init }) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/account/status') return { result: { account: { uid: 42 } } };
    if (parsed.pathname === '/users/42/likes/tracks') {
      return { result: { library: { revision: 11, tracks: [{ id: 'liked-1' }] } } };
    }
    if (parsed.pathname === '/tracks' && init.method === 'POST') {
      hydrationAttempts += 1;
      if (hydrationAttempts === 1) throw Object.assign(new Error('temporary network failure'), { name: 'TypeError' });
      return { result: [song('liked-1', 'Favorite')] };
    }
    if (parsed.pathname === '/users/42/playlists/list') return { result: { playlists: [] } };
    if (parsed.pathname === '/users/42/playlists/list/kinds') return { result: [] };
    throw new Error(`Unexpected Yandex request: ${parsed.pathname}`);
  });

  await page.dispatch('start-library-scan');
  const snapshot = page.messages.find((message) => message.type === 'library-snapshot')?.payload;
  assert.ok(snapshot, JSON.stringify(page.messages));
  assert.equal(hydrationAttempts, 2);
  assert.equal(snapshot.completeness.confirmed, true);
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

test('Yandex stops before playlist writes when favorite read-back is incomplete', async () => {
  let playlistWrites = 0;
  const page = makePage(async ({ url, init }) => {
    const path = new URL(url).pathname;
    if (path === '/account/status') return { result: { account: { uid: 42 } } };
    if (path === '/users/42/likes/tracks') return { result: { library: { revision: 1, tracks: [] } } };
    if (path === '/users/42/likes/tracks/add-multiple') return { result: { revision: 2 } };
    if (path === '/users/42/playlists/create' || path.endsWith('/change-relative')) playlistWrites += 1;
    throw new Error(`Unexpected request after failed favorite verification: ${init.method || 'GET'} ${path}`);
  });

  await page.dispatch('execute-transfer', { plan: {
    type: 'music-transfer-plan',
    target: { provider: 'yandex-music', collectionType: 'library' },
    completeness: { source: [{ confirmed: true }] },
    collectionMappings: [{ sourceId: 'source-road', sourceName: 'Road', targetName: 'Road' }],
    operations: [
      { operation: 'add_to_favorites', target: { providerId: 'liked-target' } },
      { operation: 'add_to_playlist', source: { collectionId: 'source-road', position: 0 }, target: { providerId: 'playlist-target' } },
    ],
  } });
  const response = page.messages.find((message) => message.type === 'command-response');

  assert.equal(response.ok, false);
  assert.match(response.error, /Обратная сверка лайков неполная/);
  assert.equal(response.report.status, 'partial_failure');
  assert.deepEqual(JSON.parse(JSON.stringify(response.report.playlists)), []);
  assert.equal(playlistWrites, 0);
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
