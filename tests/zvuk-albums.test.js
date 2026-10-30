const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function makeSource(path, respond) {
  const listeners = new Map();
  const messages = [];
  const location = { origin: 'https://zvuk.com', pathname: path, href: `https://zvuk.com${path}` };
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
    fetch: async (_input, init = {}) => {
      const payload = respond(JSON.parse(init.body || '{}'));
      return { ok: true, status: 200, json: async () => payload, clone: () => ({ json: async () => payload }) };
    },
  };
  const context = {
    window, location, history: { state: {}, replaceState() {} },
    document: { documentElement: { scrollHeight: 1, clientHeight: 1, scrollTop: 0 }, querySelectorAll: () => [] },
    XMLHttpRequest: class { open() {} send() {} }, URL, Request: class {}, Headers, Promise, Map, Set, String, Number, Array, Object,
    Error, JSON, Date, RegExp, Math, AbortController, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    getComputedStyle: () => ({ overflowY: 'visible' }),
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../chrome-extension/main-world.js'), 'utf8'), context);
  listeners.get('message')({ source: window, origin: location.origin, data: { source: 'music-importer-zvuk', type: 'start' } });
  return {
    messages,
    async request(operationName, variables = {}) {
      const response = await window.fetch('https://zvuk.com/api/v1/graphql', {
        method: 'POST', body: JSON.stringify({ operationName, variables }),
      });
      await response.clone().json();
      await new Promise((resolve) => setImmediate(resolve));
    },
    async waitForMessage(type, attempts = 100) {
      for (let attempt = 0; attempt < attempts && !messages.some((message) => message.type === type); attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      return messages.find((message) => message.type === type) || null;
    },
  };
}

const releaseCard = (id, extra = {}) => ({
  id, title: `Album ${id}`, artists: [{ id: 'a1', title: 'Artist', secret: 'x' }], date: '2020-01-02',
  tracks: [{ id: 't1' }, { id: 't2' }], privateField: 'must-not-leak', ...extra,
});

test('Zvuk source reader reports saved releases separately from playlists and favorite tracks', async () => {
  const page = makeSource('/collection', () => ({ data: { paginatedCollectionAll: {
    playlists: { items: [{ id: 'p1', title: 'Road', trackCount: 1 }], page: { endCursor: 'next' } },
    releases: { items: [releaseCard('r1'), releaseCard('r2', { tracks: undefined, trackCount: 9 })], page: { endCursor: 'next' } },
  } } }));
  await page.request('getPaginatedCollectionAll', { limit: 15, withReleases: true, after: null });
  const releasePage = page.messages.find((message) => message.type === 'release-list-page');
  assert.equal(releasePage.hasMore, true);
  assert.deepEqual(Array.from(releasePage.releases, (r) => [r.id, r.title, r.trackCount, r.releaseDate]), [
    ['r1', 'Album r1', 2, '2020-01-02'], ['r2', 'Album r2', 9, '2020-01-02'],
  ]);
  assert.equal(releasePage.releases[0].artists[0].id, 'a1');
  assert.ok(!('secret' in releasePage.releases[0].artists[0]));
  assert.ok(!JSON.stringify(page.messages).includes('must-not-leak'));
  assert.ok(!page.messages.some((message) => message.type === 'favorite-page'));
});

test('Zvuk source reader paginates release-only pages and fails closed on a missing cursor', async () => {
  const pages = {
    first: { items: [releaseCard('r1')], page: { hasNextPage: true, endCursor: 'c2' } },
    c2: { items: [releaseCard('r2')], page: { hasNextPage: false, endCursor: null } },
  };
  const page = makeSource('/collection', ({ variables }) => ({ data: { paginatedCollectionAll: { releases: pages[variables.after || 'first'] } } }));
  await page.request('getPaginatedCollectionAll', { after: '', withReleases: true });
  await page.waitForMessage('collection-scroll-end');
  const releasePages = page.messages.filter((message) => message.type === 'release-list-page');
  assert.deepEqual(releasePages.map((message) => message.hasMore), [true, false]);

  const broken = makeSource('/collection', () => ({ data: { paginatedCollectionAll: {
    releases: { items: [releaseCard('r1')], page: { hasNextPage: true, endCursor: '' } },
  } } }));
  broken.messages.length = 0;
  await broken.request('getPaginatedCollectionAll', {});
  assert.ok(!broken.messages.some((message) => message.type === 'release-list-page'));
});

test('Zvuk source reader exposes an independent release count and hydration cards', async () => {
  const page = makeSource('/collection', ({ operationName }) => operationName === 'getCollectionIds'
    ? { data: { collection: { releases: [{ id: 'r1' }, { id: 'r1' }, { id: 'r2' }], tracks: [{ id: 't1' }] } } }
    : { data: { getReleases: [releaseCard('r1')] } });
  await page.request('getCollectionIds');
  await page.request('getReleases', { ids: ['r1'] });
  const count = page.messages.find((message) => message.type === 'collection-count');
  assert.equal(count.uniqueReleaseCount, 2);
  assert.equal(count.uniqueTrackCount, 1);
  const hydrated = page.messages.find((message) => message.type === 'release-metadata');
  assert.equal(hydrated.releases[0].id, 'r1');
});

function makeTarget(respond, checkpointAck = true) {
  const listeners = [];
  const messages = [];
  const requests = [];
  const location = { origin: 'https://zvuk.com', href: 'https://zvuk.com/collection' };
  const window = {
    location,
    addEventListener(_name, callback) { listeners.push(callback); },
    postMessage(data) {
      messages.push(data);
      if (data.type === 'transfer-progress' && data.progress?.checkpointId) queueMicrotask(() => {
        void Promise.all(listeners.map((listener) => listener({ source: window, origin: location.origin, data: {
          source: 'music-importer-zvuk-target', type: 'transfer-progress-ack', checkpointId: data.progress.checkpointId, ok: checkpointAck,
        } })));
      });
    },
    fetch: async (url, init = {}) => {
      const request = { payload: JSON.parse(init.body || '{}') };
      requests.push(request);
      const payload = respond(request.payload);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload };
    },
  };
  const context = { window, location, URL, Promise, Map, Set, String, Number, Array, Object, Error, JSON, Date, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(require.resolve('../chrome-extension/zvuk-target-main-world.js'), 'utf8'), context);
  return {
    requests, messages,
    async command(type, detail = {}) {
      await Promise.all(listeners.map((listener) => listener({
        source: window, origin: location.origin,
        data: { source: 'music-importer-zvuk-target', type, requestId: 'fixture-command-0001', ...detail },
      })));
      return messages.filter((message) => message.type === 'command-response').at(-1);
    },
  };
}

function albumPlan(ids, extra = {}) {
  return {
    type: 'music-transfer-plan',
    target: { provider: 'zvuk', collectionType: 'albums' },
    completeness: { source: [{ confirmed: true }] },
    operations: ids.map((id) => ({
      operation: 'add_album', source: { providerId: `src-${id}` },
      target: { provider: 'zvuk', providerId: id, title: `Album ${id}`, artists: ['Artist'], upc: '', trackCount: 2 },
    })),
    ...extra,
  };
}

test('Zvuk album search returns release candidates without UPC and without touching tracks', async () => {
  const page = makeTarget(() => ({ data: { search: { releases: { items: [
    { id: 11, title: 'Album', date: '2019-05-01', artists: [{ id: 1, title: 'Artist' }], tracks: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    { id: 12, title: 'No artist', artists: [] },
  ] } } } }));
  const response = await page.command('search-albums', { query: 'Artist Album' });
  assert.equal(response.ok, true);
  assert.equal(response.results.length, 1);
  assert.deepEqual([response.results[0].providerId, response.results[0].title, response.results[0].trackCount, response.results[0].releaseDate, response.results[0].upc],
    ['11', 'Album', 3, '2019-05-01', '']);
  assert.deepEqual(Array.from(response.results[0].artists), ['Artist']);
  assert.match(page.requests[0].payload.query, /releases\(limit/);
});

function collectionServer(initial) {
  const releases = new Set(initial);
  const server = {
    releases, added: [], mutations: [], dropWrites: false,
    respond(payload) {
      if (payload.operationName === 'getCollectionIds') return { data: { collection: { releases: [...releases].map((id) => ({ id })) } } };
      if (payload.operationName === 'AddItemsToCollection') {
        server.mutations.push(payload.variables.items);
        for (const item of payload.variables.items) {
          server.added.push(item);
          if (!server.dropWrites) releases.add(item.id);
        }
        return { data: { collection: { addItems: true } } };
      }
      throw new Error(`Unexpected ${payload.operationName}`);
    },
  };
  return server;
}

test('Zvuk album writer adds only missing releases, batches, is idempotent and verifies by read-back', async () => {
  const ids = Array.from({ length: 250 }, (_, index) => `rel-${index}`);
  const server = collectionServer(['rel-3', 'unrelated']);
  const page = makeTarget((payload) => server.respond(payload));
  const response = await page.command('execute-transfer', { plan: albumPlan(ids) });
  assert.equal(response.ok, true, response.error);
  assert.deepEqual({ ...response.report.albums }, { requested: 250, added: 249, alreadyPresent: 1, verified: 250 });
  assert.deepEqual(server.mutations.map((batch) => batch.length), [100, 100, 49]);
  assert.ok(server.added.every((item) => item.type === 'release'));
  assert.ok(!server.added.some((item) => item.id === 'rel-3'));
  assert.equal(response.report.favorites.requested, 0);
  assert.ok(page.messages.some((m) => m.progress?.phase === 'albums-writing' && m.progress.checkpointId));

  const second = makeTarget((payload) => server.respond(payload));
  const mutationsBefore = server.mutations.length;
  const again = await second.command('execute-transfer', { plan: albumPlan(ids) });
  assert.equal(again.ok, true);
  assert.equal(again.report.albums.added, 0);
  assert.equal(server.mutations.length, mutationsBefore);
});

test('Zvuk album writer never uses the track type and ignores favorite-track operations in an albums plan', async () => {
  const server = collectionServer([]);
  const page = makeTarget((payload) => server.respond(payload));
  const plan = albumPlan(['rel-1']);
  plan.operations.push({ operation: 'add_to_favorites', target: { provider: 'zvuk', providerId: 'track-1' } });
  const response = await page.command('execute-transfer', { plan });
  assert.equal(response.ok, true, response.error);
  assert.deepEqual(server.added, [{ id: 'rel-1', type: 'release' }]);
  assert.ok(!page.requests.some((request) => request.payload.operationName === 'getPaginatedCollection'));
});

test('Zvuk album writer fails closed on missing read-back, unsaved checkpoint and unconfirmed completeness', async () => {
  const lossy = collectionServer([]);
  lossy.dropWrites = true;
  const failed = await makeTarget((payload) => lossy.respond(payload)).command('execute-transfer', { plan: albumPlan(['rel-1']) });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /Обратная сверка альбомов/);
  assert.equal(failed.report.status, 'partial_failure');

  const noCheckpoint = collectionServer([]);
  const stopped = await makeTarget((payload) => noCheckpoint.respond(payload), false).command('execute-transfer', { plan: albumPlan(['rel-1']) });
  assert.equal(stopped.ok, false);
  assert.equal(noCheckpoint.mutations.length, 0);

  const guarded = collectionServer([]);
  const unconfirmed = await makeTarget((payload) => guarded.respond(payload)).command('execute-transfer', {
    plan: albumPlan(['rel-1'], { completeness: { source: [{ confirmed: false }] } }),
  });
  assert.equal(unconfirmed.ok, false);
  assert.equal(guarded.mutations.length, 0);
});
