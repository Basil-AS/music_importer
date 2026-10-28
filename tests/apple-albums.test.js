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


const albumRow = (id, name, extra = {}) => ({ id, attributes: { name, artistName: 'Artist', trackCount: 10, ...extra.attributes }, relationships: extra.relationships });
const catalogRel = (id, upc) => ({ catalog: { data: [{ id, type: 'albums', attributes: { upc, trackCount: 10 } }] } });

function libraryFixtures() {
  return {
    '/v1/me/library/songs?limit=100': { meta: { total: 1 }, next: null, data: [{ id: 'l1', attributes: { name: 'Song', artistName: 'Artist', inFavorites: true } }] },
    '/v1/me/library/playlists?limit=100': { meta: { total: 0 }, next: null, data: [] },
    '/v1/me/library/albums?limit=100&include=catalog': {
      meta: { total: 2 }, next: '/v1/me/library/albums?limit=100&include=catalog&offset=1',
      data: [albumRow('l.aaa', 'First', { relationships: catalogRel('1001', '0602445000001') })],
    },
    '/v1/me/library/albums?limit=100&include=catalog&offset=1': {
      meta: { total: 2 }, next: null, data: [albumRow('l.bbb', 'Second')],
    },
  };
}

test('Apple scan pages library albums and resolves catalog id and UPC', async () => {
  const page = makePage(libraryFixtures());
  const payload = await page.scan();
  const albums = payload.albumsCollection;
  assert.equal(albums.type, 'albums');
  assert.equal(albums.completeness.confirmed, true);
  assert.equal(albums.items.length, 2);
  assert.equal(albums.items[0].providerId, '1001');
  assert.equal(albums.items[0].libraryId, 'l.aaa');
  assert.equal(albums.items[0].upc, '0602445000001');
  assert.equal(albums.items[1].providerId, 'l.bbb');
  assert.equal(albums.items[1].upc, null);
  assert.equal(payload.completeness.albumsConfirmed, true);
  assert.deepEqual(Array.from(payload.tracks, (track) => track.id), ['l1']);
  assert.ok(!page.requests.some((request) => request.method !== 'GET'));
});

test('Apple scan keeps songs but marks albums unconfirmed on a repeated id or missing endpoint', async () => {
  const fixtures = libraryFixtures();
  fixtures['/v1/me/library/albums?limit=100&include=catalog&offset=1'] = { meta: { total: 2 }, next: null, data: [albumRow('l.aaa', 'Dup')] };
  const dup = await makePage(fixtures).scan();
  assert.equal(dup.albumsCollection.completeness.confirmed, false);
  assert.equal(dup.completeness.confirmed, true);
  delete fixtures['/v1/me/library/albums?limit=100&include=catalog'];
  const missing = await makePage(fixtures).scan();
  assert.equal(missing.albumsCollection.completeness.confirmed, false);
  assert.equal(missing.albumsCollection.items.length, 0);
});

test('Apple album search tries UPC first and falls back to title and artist', async () => {
  const hit = makePage({
    '/v1/catalog/us/albums?filter%5Bupc%5D=0602445000001': { data: [{ id: '1001', attributes: { name: 'First', artistName: 'Artist', upc: '0602445000001', trackCount: 10 } }] },
  });
  const byUpc = (await hit.command('search-albums', { album: 'First', artist: 'Artist', upc: '0602445000001', storefront: 'us' })).result;
  assert.equal(byUpc[0].providerId, '1001');
  assert.equal(byUpc[0].matchReason, 'upc');
  assert.equal(byUpc[0].trackCount, 10);
  assert.equal(hit.requests.length, 2);

  const fallback = makePage({
    '/v1/catalog/us/albums?filter%5Bupc%5D=999': { data: [] },
    '/v1/catalog/us/search?term=First+Artist&types=albums&limit=10': { results: { albums: { data: [
      { id: '1001', attributes: { name: 'First', artistName: 'Artist', upc: '0602445000001', trackCount: 10 } },
    ] } } },
  });
  const found = (await fallback.command('search-albums', { album: 'First', artist: 'Artist', upc: '999', storefront: 'us' })).result;
  assert.equal(found[0].matchReason, 'search');
  assert.deepEqual(Array.from(found[0].artists), ['Artist']);
  assert.ok(fallback.requests.every((request) => request.url.includes('/v1/catalog/us/') || request.url.endsWith('/v1/me/storefront')));
});

function transferPlan(ids, collectionType = 'albums', extra = []) {
  return {
    type: 'music-transfer-plan', target: { provider: 'apple-music', collectionType },
    completeness: { source: [{ confirmed: true }] },
    operations: [...ids.map((id) => ({ operation: 'add_album', source: {}, target: { provider: 'apple-music', providerId: id } })), ...extra],
  };
}

test('Apple album writer adds only missing catalog albums in library batches and verifies read-back', async () => {
  let added = false;
  const fixtures = {
    'GET /v1/me/library/albums?limit=100&include=catalog': () => ({
      meta: { total: added ? 3 : 2 }, next: null,
      data: [albumRow('l.a', 'A', { relationships: catalogRel('1001') }), albumRow('l.b', 'B', { relationships: catalogRel('1002') }),
        ...(added ? [albumRow('l.c', 'C', { relationships: catalogRel('1003') })] : [])],
    }),
    'POST /v1/me/library?ids%5Balbums%5D=1003': () => { added = true; return { status: 202 }; },
  };
  const page = makePage(fixtures);
  const result = await page.command('execute-transfer', { plan: transferPlan(['1001', '1003']) });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.result.status, 'complete');
  assert.deepEqual(JSON.parse(JSON.stringify(result.result.albums)), { written: 1, alreadyPresent: 1, verified: 2, expected: 2 });
  const writes = page.requests.filter((request) => request.method !== 'GET');
  assert.equal(writes.length, 1);
  assert.equal(new URL(writes[0].url).pathname, '/v1/me/library');
  assert.ok(page.requests.every((request) => !/favorites|\/library\/songs|\/library\/playlists/.test(request.url)));
});

test('Apple album writer is idempotent and batches 25 ids per write', async () => {
  const ids = Array.from({ length: 30 }, (_, index) => String(2000 + index));
  const present = new Set();
  const fixtures = {
    'GET /v1/me/library/albums?limit=100&include=catalog': () => ({
      meta: { total: present.size }, next: null,
      data: [...present].map((id) => albumRow(`l.${id}`, id, { relationships: catalogRel(id) })),
    }),
    '/v1/me/library?ids%5Balbums%5D=*': ({ url }) => { new URL(url).searchParams.get('ids[albums]').split(',').forEach((id) => present.add(id)); return { status: 202 }; },
  };
  const first = makePage(fixtures);
  assert.equal((await first.command('execute-transfer', { plan: transferPlan(ids) })).result.albums.written, 30);
  assert.deepEqual(first.requests.filter((request) => request.method === 'POST').map((request) => new URL(request.url).searchParams.get('ids[albums]').split(',').length), [25, 5]);
  assert.ok(first.messages.some((message) => message.type === 'transfer-progress' && message.progress.phase === 'albums'));
  const second = makePage(fixtures);
  const rerun = await second.command('execute-transfer', { plan: transferPlan(ids) });
  assert.equal(rerun.result.albums.written, 0);
  assert.equal(rerun.result.albums.alreadyPresent, 30);
  assert.equal(second.requests.filter((request) => request.method !== 'GET').length, 0);
});

test('Apple album writer fails closed on unverified read-back and rejects library ids', async () => {
  const page = makePage({
    'GET /v1/me/library/albums?limit=100&include=catalog': { meta: { total: 0 }, next: null, data: [] },
    '/v1/me/library?ids%5Balbums%5D=*': { status: 202 },
  }, 'music-user-token', true, 0.001);
  const failed = await page.command('execute-transfer', { plan: transferPlan(['1001']) });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /0 из 1 альбомов/);
  assert.equal(failed.report.status, 'partial_failure');
  const bad = await makePage({}).command('execute-transfer', { plan: transferPlan(['l.abc']) });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /ID каталога/);
});

test('Apple album operations never reach favorites even in a mixed plan', async () => {
  const fixtures = {
    'GET /v1/me/library/albums?limit=100&include=catalog': { meta: { total: 1 }, next: null, data: [albumRow('l.a', 'A', { relationships: catalogRel('1001') })] },
  };
  const page = makePage(fixtures);
  const result = await page.command('execute-transfer', { plan: transferPlan(['1001'], 'favorites') });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.result.favorites, null);
  assert.ok(page.requests.every((request) => !/favorites|\/library\/songs/.test(request.url)));
});

test('Apple read-library-albums command returns the complete normalized list', async () => {
  const page = makePage(libraryFixtures());
  const result = (await page.command('read-library-albums')).result;
  assert.equal(result.complete, true);
  assert.equal(result.total, 2);
  assert.equal(result.items[0].catalogId, '1001');
});
