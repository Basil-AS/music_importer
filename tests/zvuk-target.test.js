const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function makePage(respond) {
  const listeners = new Map();
  const messages = [];
  const requests = [];
  const location = { origin: 'https://zvuk.com', href: 'https://zvuk.com/favorites' };
  const window = {
    location,
    addEventListener(name, callback) { listeners.set(name, callback); },
    postMessage(data) { messages.push(data); },
    fetch: async (url, init = {}) => {
      const request = { url: String(url), init, payload: JSON.parse(init.body || '{}') };
      requests.push(request);
      const result = await respond(request);
      return {
        ok: result.status === undefined || (result.status >= 200 && result.status < 300),
        status: result.status || 200,
        headers: { get: (name) => result.headers?.[String(name).toLowerCase()] || null },
        json: async () => result.payload ?? result,
      };
    },
  };
  const context = {
    window, location, URL, Promise, Map, Set, String, Number, Array, Object, Error, JSON, Date,
    setTimeout, clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../chrome-extension/zvuk-target-main-world.js'), 'utf8'), context);
  return {
    requests,
    async command(type, detail = {}) {
      await listeners.get('message')({
        source: window,
        origin: location.origin,
        data: { source: 'music-importer-zvuk-target', type, requestId: 'fixture-command-0001', ...detail },
      });
      return messages.filter((message) => message.type === 'command-response').at(-1);
    },
  };
}

function graphRequest(request) {
  assert.equal(request.url, '/api/v1/graphql');
  assert.equal(request.init.credentials, 'include');
  return { operationName: request.payload.operationName, variables: request.payload.variables };
}

test('Zvuk search returns provider IDs and normalized candidate metadata', async () => {
  const page = makePage((request) => {
    const { operationName } = graphRequest(request);
    assert.equal(operationName, 'search');
    return { payload: { data: { search: { tracks: { items: [
      { id: 'zvuk-1', title: 'Track', duration: 180000, artists: [{ id: 'artist-1', title: 'Artist' }], release: { id: 'release-1', title: 'Album' } },
    ] } } } } };
  });
  const response = await page.command('search-tracks', { query: 'Track Artist' });
  assert.equal(response.ok, true);
  assert.equal(response.results[0].providerId, 'zvuk-1');
  assert.equal(response.results[0].collectionId, 'release-1');
  assert.equal(response.results[0].artistName, 'Artist');
});

test('Zvuk catalog search forwards HTTP 429 and Retry-After to the shared search engine', async () => {
  const page = makePage(() => ({ status: 429, headers: { 'retry-after': '11' }, payload: {} }));
  const response = await page.command('search-tracks', { query: 'Limited Song Artist' });

  assert.equal(response.ok, false);
  assert.equal(response.status, 429);
  assert.equal(response.retryAfter, '11');
});

test('Zvuk favorites write is idempotent and confirmed by cursor read-back', async () => {
  let readCount = 0;
  let storedIds = ['already-liked'];
  const page = makePage((request) => {
    const { operationName, variables } = graphRequest(request);
    if (operationName === 'getPaginatedCollection') {
      readCount += 1;
      return { payload: { data: { paginatedCollection: { tracks: {
        items: storedIds.map((id) => ({ id })), page: { endCursor: null },
      } } } } };
    }
    if (operationName === 'AddItemsToCollection') {
      const ids = variables.items.map((item) => item.id);
      assert.ok(variables.items.every((item) => item.type === 'track'));
      storedIds.push(...ids);
      return { payload: { data: { collection: { addItems: true } } } };
    }
    throw new Error(`Unexpected operation: ${operationName}`);
  });
  const response = await page.command('execute-transfer', { plan: {
    type: 'music-transfer-plan', target: { provider: 'zvuk', collectionType: 'favorites' },
    completeness: { source: [{ confirmed: true }] }, collectionMappings: [],
    operations: [
      { operation: 'add_to_favorites', target: { provider: 'zvuk', providerId: 'already-liked' } },
      { operation: 'add_to_favorites', target: { provider: 'zvuk', providerId: 'new-like' } },
    ],
  } });
  assert.equal(response.ok, true);
  assert.equal(readCount, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(response.report.favorites)), {
    requested: 2, added: 1, alreadyPresent: 1, verified: 2,
  });
});

test('Zvuk playlist write chunks items and verifies exact order, including repeats', async () => {
  const tracks = Array.from({ length: 102 }, (_, index) => `target-${index < 101 ? index : 0}`);
  let playlistTracks = [];
  let addBatches = 0;
  const page = makePage((request) => {
    const { operationName, variables } = graphRequest(request);
    if (operationName === 'createPlaylist') {
      assert.equal(variables.name, 'From Spotify');
      playlistTracks = variables.items.map((item) => item.item_id);
      return { payload: { data: { playlist: { createV1: { id: 'created-1' } } } } };
    }
    if (operationName === 'addItems') {
      addBatches += 1;
      playlistTracks.push(...variables.items.map((item) => item.item_id));
      return { payload: { data: { playlist: { addItemsV1: { id: 'created-1' } } } } };
    }
    if (operationName === 'getPlaylistTracks') {
      const rows = playlistTracks.slice(variables.offset, variables.offset + variables.limit).map((id) => ({ id }));
      return { payload: { data: { playlistTracks: rows } } };
    }
    throw new Error(`Unexpected operation: ${operationName}`);
  });
  const operations = tracks.map((id, position) => ({
    operation: 'add_to_playlist', source: { collectionId: 'source-1', collectionName: 'From Spotify', position },
    target: { provider: 'zvuk', providerId: id },
  }));
  const response = await page.command('execute-transfer', { plan: {
    type: 'music-transfer-plan', target: { provider: 'zvuk', collectionType: 'playlists' },
    completeness: { source: [{ confirmed: true }] },
    collectionMappings: [{ sourceId: 'source-1', sourceName: 'From Spotify', targetName: 'From Spotify' }],
    operations,
  } });
  assert.equal(response.ok, true);
  assert.equal(addBatches, 1);
  assert.equal(response.report.playlists[0].written, 102);
  assert.equal(response.report.playlists[0].verified, 102);
  assert.deepEqual(playlistTracks, tracks);
});

test('Zvuk resume verifies the stored playlist ID and writes only the missing suffix', async () => {
  const playlistTracks = ['track-first'];
  let created = false;
  const page = makePage((request) => {
    const { operationName, variables } = graphRequest(request);
    if (operationName === 'getPlaylistTracks') {
      return { payload: { data: { playlistTracks: playlistTracks.slice(variables.offset, variables.offset + variables.limit).map((id) => ({ id })) } } };
    }
    if (operationName === 'addItems') {
      playlistTracks.push(...variables.items.map((item) => item.item_id));
      return { payload: { data: { playlist: { addItemsV1: { id: 'stored-playlist' } } } } };
    }
    if (operationName === 'createPlaylist') { created = true; throw new Error('Resume must use the stored playlist ID.'); }
    throw new Error(`Unexpected operation: ${operationName}`);
  });
  const response = await page.command('execute-transfer', { plan: {
    type: 'music-transfer-plan', target: { provider: 'zvuk', collectionType: 'playlists' },
    completeness: { source: [{ confirmed: true }] },
    collectionMappings: [{ sourceId: 'source-list', sourceName: 'Road', targetName: 'Road' }],
    operations: ['track-first', 'track-second'].map((providerId, position) => ({
      operation: 'add_to_playlist', source: { collectionId: 'source-list', position }, target: { provider: 'zvuk', providerId },
    })),
    recovery: {
      playlistTargets: { 'source-list': 'stored-playlist' },
      progress: { phase: 'playlist-items', sourceKey: 'source-list', targetPlaylistId: 'stored-playlist', playlistIndex: 0 },
    },
  } });

  assert.equal(response.ok, true, response.error);
  assert.deepEqual(playlistTracks, ['track-first', 'track-second']);
  assert.equal(created, false);
});

test('Zvuk writer rejects incomplete source snapshots before making a request', async () => {
  const page = makePage(() => { throw new Error('A request must not be made.'); });
  const response = await page.command('execute-transfer', { plan: {
    type: 'music-transfer-plan', target: { provider: 'zvuk', collectionType: 'favorites' },
    completeness: { source: [{ confirmed: false }] }, collectionMappings: [],
    operations: [{ operation: 'add_to_favorites', target: { provider: 'zvuk', providerId: 'target-1' } }],
  } });
  assert.equal(response.ok, false);
  assert.match(response.error, /полнота исходной библиотеки не подтверждена/i);
  assert.equal(page.requests.length, 0);
});
