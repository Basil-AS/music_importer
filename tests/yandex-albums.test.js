const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const origin = 'https://music.yandex.ru';

function makePage(fetchHandler) {
  const listeners = new Map();
  const messages = [];
  const requests = [];
  const window = {
    location: { origin },
    addEventListener(name, callback) { listeners.set(name, [...(listeners.get(name) || []), callback]); },
    postMessage(message) { messages.push(message); },
    async fetch(url, init = {}) {
      requests.push({ url: String(url), init });
      const response = await fetchHandler({ url: String(url), init });
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => response };
    },
  };
  const context = {
    window, location: window.location, URL, URLSearchParams, Promise, Map, Set, String, Number, Array, Object, Error, JSON, Date,
    setTimeout: (callback, delay, ...args) => setTimeout(callback, 0, ...args),
    clearTimeout, console, AbortController,
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../chrome-extension/yandex-main-world.js'), 'utf8'), context);
  return {
    messages, requests,
    async dispatch(type, detail = {}) {
      await Promise.all((listeners.get('message') || []).map((listener) => listener({
        source: window, origin, data: { source: 'music-importer-yandex', type, requestId: 'fixture-request-0001', ...detail },
      })));
    },
    response: () => messages.find((message) => message.type === 'command-response'),
  };
}

const card = (id, extra = {}) => ({
  id, title: `Album ${id}`, artists: [{ id: 1, name: 'Artist' }], trackCount: 10, year: 2020, coverUri: 'cover/%%', ...extra,
});

function libraryFixture({ liked, cards }) {
  const state = { liked: [...liked], postBodies: [], addBodies: [] };
  const handler = async ({ url, init }) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/account/status') return { result: { account: { uid: 42 } } };
    if (parsed.pathname === '/users/42/likes/albums' && !init.method) return { result: state.liked.map((id) => ({ id, timestamp: 't' })) };
    if (parsed.pathname === '/albums' && init.method === 'POST') {
      const ids = new URLSearchParams(init.body).get('album-ids').split(',');
      state.postBodies.push(ids);
      return { result: ids.filter((id) => cards[id]).map((id) => cards[id]) };
    }
    if (parsed.pathname === '/users/42/likes/albums/add-multiple') {
      const ids = new URLSearchParams(init.body).get('album-ids').split(',');
      state.addBodies.push(ids);
      state.liked.push(...ids);
      return { result: 'ok' };
    }
    if (parsed.pathname === '/search') return { result: { albums: { results: [card('a1'), { id: 'x' }, card('a2', { trackCount: 12 })] } } };
    throw new Error(`Unexpected Yandex request: ${init.method || 'GET'} ${parsed.pathname}`);
  };
  return { state, handler };
}

test('read-albums hydrates cards in batches and marks missing cards incomplete', async () => {
  const ids = Array.from({ length: 30 }, (_, index) => `al${index}`);
  const cards = Object.fromEntries(ids.filter((id) => id !== 'al7').map((id) => [id, card(id)]));
  const { state, handler } = libraryFixture({ liked: ids, cards });
  const page = makePage(handler);
  await page.dispatch('read-albums');
  const response = page.response();
  assert.equal(response.ok, true, response.error);
  assert.equal(response.collection.type, 'albums');
  assert.equal(response.collection.count, 30);
  assert.equal(response.items.length, 30);
  assert.equal(response.collection.metadataIncompleteCount, 1);
  const missing = response.items.find((item) => item.providerId === 'al7');
  assert.equal(missing.metadataComplete, false);
  assert.deepEqual(Array.from(state.postBodies[0]), ids.slice(0, 25));
  assert.deepEqual(Array.from(state.postBodies[1]), ['al7']);
  assert.deepEqual(Array.from(state.postBodies[2]), ids.slice(25));
  const item = response.items[0];
  assert.deepEqual(Array.from(item.artists), ['Artist']);
  assert.equal(item.trackCount, 10);
  assert.equal(item.upc, '');
  assert.ok(page.requests.every((request) => !/likes\/tracks/.test(request.url)));
});

test('library scan includes an albums collection with completeness', async () => {
  const { handler } = libraryFixture({ liked: ['a1'], cards: { a1: card('a1') } });
  const page = makePage(async (request) => {
    const parsed = new URL(request.url);
    if (parsed.pathname === '/users/42/likes/tracks') return { result: { library: { revision: 1, tracks: [] } } };
    if (parsed.pathname === '/users/42/playlists/list') return { result: { playlists: [] } };
    if (parsed.pathname === '/users/42/playlists/list/kinds') return { result: [] };
    return handler(request);
  });
  await page.dispatch('start-library-scan');
  const snapshot = page.messages.find((message) => message.type === 'library-snapshot')?.payload;
  assert.ok(snapshot, JSON.stringify(page.messages));
  const albums = snapshot.collections.find((collection) => collection.type === 'albums');
  assert.equal(albums.items.length, 1);
  assert.equal(snapshot.completeness.albumsConfirmed, true);
  assert.equal(snapshot.completeness.albumsCount, 1);
  assert.equal(snapshot.tracks.length, 0);
});

test('search-albums returns album candidates without tracks calls', async () => {
  const { handler } = libraryFixture({ liked: [], cards: {} });
  const page = makePage(handler);
  await page.dispatch('search-albums', { album: 'Album', artist: 'Artist' });
  const response = page.response();
  assert.equal(response.ok, true, response.error);
  assert.deepEqual(Array.from(response.results, (row) => row.providerId), ['a1', 'a2']);
  assert.equal(response.results[1].trackCount, 12);
  assert.equal(response.results[0].year, 2020);
  assert.equal(new URL(page.requests[0].url).searchParams.get('type'), 'album');
});

const plan = (ids) => ({
  type: 'music-transfer-plan',
  target: { provider: 'yandex-music', collectionType: 'albums' },
  completeness: { source: [{ confirmed: true }] },
  operations: ids.map((providerId) => ({ operation: 'add_album', target: { provider: 'yandex-music', providerId, title: 'T', artists: ['A'] } })),
});

test('album writer is idempotent, batches likes, verifies read-back and never touches track likes', async () => {
  const ids = Array.from({ length: 27 }, (_, index) => `n${index}`);
  const { state, handler } = libraryFixture({ liked: ['n0', 'old'], cards: {} });
  const page = makePage(handler);
  await page.dispatch('execute-transfer', { plan: plan(ids) });
  const response = page.response();
  assert.equal(response.ok, true, response.error);
  assert.equal(response.report.status, 'complete');
  assert.equal(response.report.albums.existing, 1);
  assert.equal(response.report.albums.added, 26);
  assert.equal(response.report.albums.verified, 27);
  assert.deepEqual(state.addBodies.map((batch) => batch.length), [25, 1]);
  assert.ok(!state.addBodies.flat().includes('n0'));
  assert.ok(page.requests.every((request) => !/likes\/tracks|playlists/.test(request.url)));
  await page.dispatch('execute-transfer', { plan: plan(ids) });
  assert.equal(state.addBodies.length, 2);
});

test('album writer fails when read-back does not confirm the likes', async () => {
  const { handler } = libraryFixture({ liked: [], cards: {} });
  const page = makePage(async (request) => {
    if (new URL(request.url).pathname.endsWith('/add-multiple')) return { result: 'ok' };
    return handler(request);
  });
  await page.dispatch('execute-transfer', { plan: plan(['z1']) });
  const response = page.response();
  assert.equal(response.ok, false);
  assert.match(response.error, /Обратная сверка/);
  assert.equal(response.report.status, 'partial_failure');
});
