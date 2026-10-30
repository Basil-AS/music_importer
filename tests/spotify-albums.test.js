const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const origin = 'https://open.spotify.com';
const pathfinder = 'https://api-partner.spotify.com/pathfinder/v2/query';
const idOf = (n) => String(n).padStart(22, 'A');
const uriOf = (n) => `spotify:album:${idOf(n)}`;

function makePage(respond) {
  const listeners = new Map();
  const messages = [];
  const requests = [];
  const location = { origin, href: `${origin}/collection/albums` };
  const document = { querySelectorAll: () => [] };
  async function dispatch(event) {
    return Promise.all((listeners.get('message') || []).map((listener) => listener(event)));
  }
  const window = {
    location,
    addEventListener(name, callback) { listeners.set(name, [...(listeners.get(name) || []), callback]); },
    postMessage(data) {
      messages.push(data);
      if (data.type === 'transfer-progress' && data.progress?.checkpointId) queueMicrotask(() => {
        void dispatch({ source: window, origin, data: {
          source: 'music-importer-spotify', type: 'transfer-progress-ack', checkpointId: data.progress.checkpointId, ok: page.rejectCheckpoints !== true,
        } });
      });
      if (data.type === 'scan-progress' && data.progressAckId) queueMicrotask(() => {
        void dispatch({ source: window, origin, data: {
          source: 'music-importer-spotify', type: 'scan-progress-ack', progressAckId: data.progressAckId, ok: true,
        } });
      });
      if (['library-snapshot', 'scan-error'].includes(data.type) && data.terminalAckId) queueMicrotask(() => {
        void dispatch({ source: window, origin, data: {
          source: 'music-importer-spotify', type: 'scan-terminal-ack', terminalAckId: data.terminalAckId, ok: true,
        } });
      });
    },
    fetch: async (url, init = {}) => {
      const request = { url: String(url), method: init.method || 'GET', init, payload: typeof init.body === 'string' ? JSON.parse(init.body) : null };
      requests.push(request);
      const result = await respond(request);
      return {
        ok: result.status === undefined || (result.status >= 200 && result.status < 300),
        status: result.status || 200,
        headers: { get: (name) => result.headers?.[String(name).toLowerCase()] || null },
        clone: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
        json: async () => result.payload ?? result,
        text: async () => JSON.stringify(result.payload ?? result),
      };
    },
  };
  const context = {
    window, location, document, URL, URLSearchParams, Headers, Request, Promise, Map, Set,
    String, Number, Array, Object, Error, JSON, Date, RegExp, Math,
    setTimeout, clearTimeout, setImmediate, AbortController,
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../chrome-extension/spotify-main-world.js'), 'utf8'), context);
  let commandSequence = 0;
  const page = {
    messages, requests, rejectCheckpoints: false,
    captureSession() {
      return window.fetch(pathfinder, {
        method: 'POST',
        headers: { authorization: 'Bearer fixture', 'client-token': 'fixture-client-token' },
        body: JSON.stringify({ operationName: 'fetchLibraryTracks', extensions: { persistedQuery: { sha256Hash: 'a'.repeat(64) } } }),
      });
    },
    async command(action, detail = {}) {
      const requestId = `fixture-albums-${String(++commandSequence).padStart(4, '0')}`;
      await dispatch({ source: window, origin, data: { source: 'music-importer-spotify', type: 'command', requestId, action, ...detail } });
      while (!messages.some((message) => message.type === 'command-result' && message.requestId === requestId)) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      return messages.findLast((message) => message.type === 'command-result' && message.requestId === requestId);
    },
    async scan() {
      await dispatch({ source: window, origin, data: { source: 'music-importer-spotify', type: 'start-library-scan' } });
      return messages.findLast((message) => message.type === 'library-snapshot')?.payload;
    },
  };
  return page;
}

function albumData(n, extra = {}) {
  return {
    id: idOf(n), uri: uriOf(n), name: `Album ${n}`, artists: [{ name: 'Artist' }], total_tracks: 10,
    release_date: '2020-01-01', images: [{ url: 'small', width: 64 }, { url: 'large', width: 640 }],
    external_ids: { upc: `00${n}` }, ...extra,
  };
}

const likedEndpoints = /\/v1\/me\/tracks|addToLibrary|fetchLibraryTracks/;

test('Spotify saved albums are read page by page, advancing by returned rows', async () => {
  const saved = [1, 2, 3, 4, 5];
  const page = makePage((request) => {
    if (request.url.startsWith(pathfinder)) return { payload: { data: {} } };
    const url = new URL(request.url);
    assert.equal(url.pathname, '/v1/me/albums');
    assert.equal(request.init.credentials, 'include');
    const offset = Number(url.searchParams.get('offset'));
    return { payload: { total: saved.length, offset, items: saved.slice(offset, offset + 2).map((n) => ({ added_at: 'x', album: albumData(n) })) } };
  });
  await page.captureSession();
  const response = await page.command('read-albums');
  assert.equal(response.ok, true);
  assert.equal(response.result.complete, true);
  assert.equal(response.result.total, 5);
  assert.deepEqual(Array.from(response.result.items, (item) => item.providerId), saved.map(uriOf));
  assert.deepEqual(page.requests.filter((r) => r.url.includes('/v1/me/albums')).map((r) => new URL(r.url).searchParams.get('offset')), ['0', '2', '4']);
  assert.equal(response.result.items[0].artworkUrl, 'large');
  assert.equal(response.result.items[0].trackCount, 10);
  assert.ok(!page.requests.some((r) => likedEndpoints.test(r.url)));
});

test('Spotify saved albums reject duplicates, shifted offsets and empty pages', async () => {
  for (const broken of ['duplicate', 'offset', 'empty']) {
    const page = makePage((request) => {
      if (request.url.startsWith(pathfinder)) return { payload: { data: {} } };
      const offset = Number(new URL(request.url).searchParams.get('offset'));
      if (broken === 'duplicate') return { payload: { total: 2, offset, items: [{ album: albumData(1) }, { album: albumData(1) }] } };
      if (broken === 'offset') return { payload: { total: 2, offset: offset + 1, items: [{ album: albumData(1) }] } };
      return { payload: { total: 2, offset, items: [] } };
    });
    await page.captureSession();
    const response = await page.command('read-albums');
    assert.equal(response.ok, false, broken);
  }
});

test('Spotify library scan includes a complete albums collection and keeps likes separate', async () => {
  const page = makePage((request) => {
    if (request.url.startsWith(pathfinder)) {
      const { operationName } = request.payload || {};
      if (operationName === 'fetchLibraryTracks') return { payload: { data: { me: { library: { tracks: { totalCount: 0, items: [] } } } } } };
      if (operationName === 'libraryV3') return { payload: { data: { me: { libraryV3: { totalCount: 0, items: [] } } } } };
      return { payload: { data: {} } };
    }
    return { payload: { total: 1, offset: 0, items: [{ album: albumData(7) }] } };
  });
  const snapshot = await (async () => { await page.captureSession(); return page.scan(); })();
  assert.ok(snapshot, JSON.stringify(page.messages));
  const albums = snapshot.collections.find((collection) => collection.type === 'albums');
  assert.deepEqual(Array.from(albums.items, (item) => item.providerId), [uriOf(7)]);
  assert.deepEqual({ ...albums.completeness }, { confirmed: true, total: 1, count: 1 });
  assert.equal(snapshot.completeness.albumsConfirmed, true);
  assert.equal(snapshot.tracks.length, 0);
});

test('Spotify library scan marks albums unconfirmed instead of failing when the album route is unavailable', async () => {
  const page = makePage((request) => {
    if (request.url.startsWith(pathfinder)) {
      const { operationName } = request.payload || {};
      if (operationName === 'fetchLibraryTracks') return { payload: { data: { me: { library: { tracks: { totalCount: 0, items: [] } } } } } };
      if (operationName === 'libraryV3') return { payload: { data: { me: { libraryV3: { totalCount: 0, items: [] } } } } };
      return { payload: { data: {} } };
    }
    return { status: 403, payload: {} };
  });
  await page.captureSession();
  const snapshot = await page.scan();
  assert.equal(snapshot.completeness.albumsConfirmed, false);
  assert.equal(snapshot.completeness.albumsError, '403');
  assert.equal(snapshot.collections.length, 0);
});

test('Spotify album search tries UPC first, requires an exact UPC, then falls back to title and artist', async () => {
  const page = makePage((request) => {
    if (request.url.startsWith(pathfinder)) return { payload: { data: {} } };
    const url = new URL(request.url);
    if (url.pathname === '/v1/search') {
      const q = url.searchParams.get('q');
      assert.equal(url.searchParams.get('type'), 'album');
      if (q === 'upc:602537') return { payload: { albums: { items: [{ id: idOf(1), uri: uriOf(1) }] } } };
      if (q === 'upc:999') return { payload: { albums: { items: [] } } };
      assert.equal(q, 'album:Title artist:Band');
      return { payload: { albums: { items: [{ id: idOf(2), uri: uriOf(2) }] } } };
    }
    assert.equal(url.pathname, '/v1/albums');
    const ids = url.searchParams.get('ids').split(',');
    return { payload: { albums: ids.map((id) => id === idOf(1) ? albumData(1, { external_ids: { upc: '0602537' } }) : albumData(2)) } };
  });
  await page.captureSession();
  const byUpc = await page.command('search-albums', { album: 'Title', artist: 'Band', upc: '602537' });
  assert.equal(byUpc.ok, true);
  assert.deepEqual(Array.from(byUpc.result, (c) => [c.providerId, c.matchedBy, c.upc, c.trackCount]), [[uriOf(1), 'upc', '0602537', 10]]);
  const fallback = await page.command('search-albums', { album: 'Title', artist: 'Band', upc: '999' });
  assert.deepEqual(Array.from(fallback.result, (c) => [c.providerId, c.matchedBy, c.title, c.artists[0]]), [[uriOf(2), 'title_artist', 'Album 2', 'Artist']]);
  assert.ok(page.requests.every((r) => r.method === 'GET' || r.url.startsWith(pathfinder)));
});

test('Spotify album writer skips saved albums, batches by 20, checkpoints and verifies read-back', async () => {
  const wanted = Array.from({ length: 25 }, (_, index) => index + 1);
  const saved = new Set([uriOf(3)]);
  const page = makePage((request) => {
    if (request.url.startsWith(pathfinder)) return { payload: { data: {} } };
    const url = new URL(request.url);
    if (url.pathname === '/v1/me/albums/contains') return { payload: url.searchParams.get('ids').split(',').map((id) => saved.has(`spotify:album:${id}`)) };
    assert.equal(request.method, 'PUT');
    assert.equal(url.pathname, '/v1/me/albums');
    for (const id of request.payload.ids) saved.add(`spotify:album:${id}`);
    return { status: 200, payload: {} };
  });
  await page.captureSession();
  const targets = wanted.map((n) => ({ provider: 'spotify', providerId: uriOf(n), title: `Album ${n}`, artists: ['Artist'], upc: null, trackCount: 10 }));
  const response = await page.command('write-albums', { targets });
  assert.equal(response.ok, true, response.error);
  assert.deepEqual({ ...response.result }, { requested: 25, written: 24, writtenCount: 24, alreadyPresent: 1, verified: 25 });
  const puts = page.requests.filter((r) => r.method === 'PUT');
  assert.deepEqual(puts.map((r) => r.payload.ids.length), [20, 4]);
  assert.ok(!puts.some((r) => r.payload.ids.includes(idOf(3))));
  assert.equal(page.messages.filter((m) => m.progress?.checkpointId && m.progress.phase === 'albums').length, 2);
  assert.ok(!page.requests.some((r) => likedEndpoints.test(r.url)));

  const second = await page.command('write-albums', { targets });
  assert.equal(second.result.written, 0);
  assert.equal(page.requests.filter((r) => r.method === 'PUT').length, 2);

  const back = await page.command('read-albums', { ids: [...wanted.map(uriOf), uriOf(99)] });
  assert.equal(back.result.complete, true);
  assert.equal(back.result.items.length, 25);
  assert.ok(!back.result.items.some((item) => item.providerId === uriOf(99)));
});

test('Spotify album writer does not write when the checkpoint is rejected and reports unverified albums', async () => {
  const page = makePage((request) => {
    if (request.url.startsWith(pathfinder)) return { payload: { data: {} } };
    const url = new URL(request.url);
    if (url.pathname === '/v1/me/albums/contains') return { payload: url.searchParams.get('ids').split(',').map(() => false) };
    return { status: 200, payload: {} };
  });
  await page.captureSession();
  const targets = [{ provider: 'spotify', providerId: uriOf(1) }];
  page.rejectCheckpoints = true;
  const rejected = await page.command('write-albums', { targets });
  assert.equal(rejected.ok, false);
  assert.equal(page.requests.filter((r) => r.method === 'PUT').length, 0);

  page.rejectCheckpoints = false;
  const unverified = await page.command('write-albums', { targets });
  assert.equal(unverified.ok, false);
  assert.equal(unverified.report.albums.verified, 0);
});

test('Spotify album writer rejects foreign providers and malformed IDs before any request', async () => {
  const page = makePage((request) => ({ payload: request.url.startsWith(pathfinder) ? { data: {} } : {} }));
  await page.captureSession();
  const before = page.requests.length;
  assert.equal((await page.command('write-albums', { targets: [{ provider: 'zvuk', providerId: uriOf(1) }] })).ok, false);
  assert.equal((await page.command('write-albums', { targets: [{ provider: 'spotify', providerId: 'spotify:track:abc' }] })).ok, false);
  assert.equal(page.requests.length, before);
});
