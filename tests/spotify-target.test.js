const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function makePage(respond) {
  const listeners = new Map();
  const messages = [];
  const requests = [];
  const location = { origin: 'https://open.spotify.com', href: 'https://open.spotify.com/collection/tracks' };
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
          source: 'music-importer-spotify', type: 'transfer-progress-ack', checkpointId: data.progress.checkpointId, ok: true,
        } });
      });
    },
    fetch: async (url, init = {}) => {
      const request = { url: String(url), init, payload: typeof init.body === 'string' ? JSON.parse(init.body) : null };
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
    window, location, URL, URLSearchParams, Headers, Request, Promise, Map, Set,
    String, Number, Array, Object, Error, JSON, Date, RegExp, Math,
    setTimeout, clearTimeout, AbortController,
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../chrome-extension/spotify-main-world.js'), 'utf8'), context);
  return {
    requests,
    captureSession() {
      return window.fetch('https://api-partner.spotify.com/pathfinder/v2/query', {
        method: 'POST',
        headers: { authorization: 'Bearer fixture', 'client-token': 'fixture-client-token' },
        body: JSON.stringify({ operationName: 'fetchLibraryTracks', extensions: { persistedQuery: { sha256Hash: 'a'.repeat(64) } } }),
      });
    },
    async command(action, detail = {}) {
      await dispatch({ source: window, origin: location.origin, data: { source: 'music-importer-spotify', type: 'command', requestId: 'fixture-command-0001', action, ...detail } });
      while (!messages.some((message) => message.type === 'command-result' && message.requestId === 'fixture-command-0001')) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      return messages.findLast((message) => message.type === 'command-result');
    },
  };
}

function libraryTracks(uris) {
  return {
    payload: { data: { me: { library: { tracks: {
      totalCount: uris.length,
      items: uris.map((uri, index) => ({ track: { _uri: uri, data: { uri, name: `Track ${index}`, artists: [{ name: 'Artist' }], album: { name: 'Album' }, duration: { totalMilliseconds: 180000 } } } })),
    } } } } },
  };
}

test('Spotify catalog search uses session-bound Web Player request and normalizes candidates', async () => {
  const page = makePage((request) => {
    if (request.url.startsWith('https://api-partner.spotify.com/')) return { payload: { data: {} } };
    if (request.url.startsWith('https://api.spotify.com/v1/search?')) {
      assert.match(request.url, /q=Track\+Artist/);
      assert.equal(request.init.credentials, 'include');
      return { payload: { tracks: { items: [{
        id: 'target1', uri: 'spotify:track:target1', name: 'Track', artists: [{ id: 'artist1', name: 'Artist' }],
        album: { name: 'Album' }, external_ids: { isrc: 'USABC1234567' }, duration_ms: 180000,
      }] } } };
    }
    throw new Error(`Unexpected URL: ${request.url}`);
  });
  await page.captureSession();
  const response = await page.command('search-tracks', { query: 'Track Artist' });
  assert.equal(response.ok, true);
  assert.equal(response.result[0].uri, 'spotify:track:target1');
  assert.equal(response.result[0].artistName, 'Artist');
  assert.equal(response.result[0].isrc, 'USABC1234567');
});

test('Spotify album batch lookup searches albums and reads their tracklists with the active session', async () => {
  const page = makePage((request) => {
    if (request.url.startsWith('https://api-partner.spotify.com/')) return { payload: { data: {} } };
    if (request.url.startsWith('https://api.spotify.com/v1/search?')) {
      const url = new URL(request.url);
      assert.equal(url.searchParams.get('type'), 'album');
      assert.equal(url.searchParams.get('limit'), '5');
      return { payload: { albums: { items: [{ id: 'album-1', name: 'Discovery' }] } } };
    }
    if (request.url.startsWith('https://api.spotify.com/v1/albums/album-1/tracks?')) {
      const url = new URL(request.url);
      assert.equal(url.searchParams.get('limit'), '50');
      assert.equal(request.init.credentials, 'include');
      return { payload: { total: 2, items: [
        { id: 'one', uri: 'spotify:track:one', name: 'One More Time', artists: [{ name: 'Daft Punk' }], duration_ms: 320357 },
        { id: 'two', uri: 'spotify:track:two', name: 'Aerodynamic', artists: [{ name: 'Daft Punk' }], duration_ms: 212546 },
      ] } };
    }
    throw new Error(`Unexpected URL: ${request.url}`);
  });
  await page.captureSession();
  const response = await page.command('search-album-tracks', { album: 'Discovery', artist: 'Daft Punk' });

  assert.equal(response.ok, true, response.error);
  assert.deepEqual(Array.from(response.result, (track) => [track.trackId, track.collectionName]), [
    ['spotify:track:one', 'Discovery'], ['spotify:track:two', 'Discovery'],
  ]);
  assert.ok(page.requests.slice(1).every((request) => request.init.headers.authorization === 'Bearer fixture'));
});

test('Spotify catalog search forwards HTTP 429 and Retry-After to the shared search engine', async () => {
  const page = makePage((request) => {
    if (request.url.startsWith('https://api-partner.spotify.com/')) return { payload: { data: {} } };
    if (request.url.startsWith('https://api.spotify.com/v1/search?')) {
      return { status: 429, headers: { 'retry-after': '8' }, payload: {} };
    }
    throw new Error(`Unexpected URL: ${request.url}`);
  });
  await page.captureSession();
  const response = await page.command('search-tracks', { query: 'Limited Song Artist' });

  assert.equal(response.ok, false);
  assert.equal(response.status, 429);
  assert.equal(response.retryAfter, '8');
});

test('Spotify writer skips existing likes, batches new likes and verifies read-back', async () => {
  const existing = ['spotify:track:existing'];
  let readCount = 0;
  let writeBatchSizes = [];
  const page = makePage((request) => {
    const operation = request.payload?.operationName;
    const variables = request.payload?.variables || {};
    if (request.url.startsWith('https://api-partner.spotify.com/') && operation === 'fetchLibraryTracks') { readCount += 1; return libraryTracks(existing); }
    if (operation === 'addToLibrary') {
      writeBatchSizes.push(variables.libraryItemUris.length);
      existing.push(...variables.libraryItemUris);
      return { payload: { data: { addToLibrary: true } } };
    }
    throw new Error(`Unexpected operation: ${operation}`);
  });
  await page.captureSession();
  readCount = 0;
  const requested = ['spotify:track:existing', ...Array.from({ length: 81 }, (_, i) => `spotify:track:new${i}`)];
  const response = await page.command('execute-transfer', { plan: {
    type: 'music-transfer-plan', target: { provider: 'spotify' },
    completeness: { source: [{ confirmed: true }] }, collectionMappings: [],
    operations: requested.map((providerId) => ({ operation: 'add_to_favorites', target: { provider: 'spotify', providerId } })),
  } });
  assert.equal(response.ok, true, response.error);
  assert.deepEqual(writeBatchSizes, [40, 40, 1]);
  assert.equal(readCount, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(response.result.favorites)), { requested: 82, added: 81, alreadyPresent: 1, verified: 82 });
});

test('Spotify writer creates playlists, appends batches, and checks repeated items and order', async () => {
  let favoriteUris = [];
  let playlistUris = [];
  let playlistCreated = false;
  let batches = [];
  const sourceUris = Array.from({ length: 102 }, (_, index) => `spotify:track:${index < 101 ? index : 0}`);
  const page = makePage((request) => {
    if (request.url.startsWith('https://api-partner.spotify.com/')) {
      const { operationName, variables } = request.payload;
      if (operationName === 'fetchLibraryTracks') return libraryTracks(favoriteUris);
      if (operationName === 'addToLibrary') { favoriteUris.push(...variables.libraryItemUris); return { payload: { data: { addToLibrary: true } } }; }
      if (operationName === 'addToPlaylist') {
        assert.equal(variables.playlistUri, 'spotify:playlist:created1234567890123456');
        assert.equal(variables.newPosition.moveType, 'BOTTOM_OF_PLAYLIST');
        batches.push(variables.playlistItemUris.length);
        playlistUris.push(...variables.playlistItemUris);
        return { payload: { data: { addToPlaylist: true } } };
      }
      if (operationName === 'fetchPlaylistContents') {
        const offset = variables.offset;
        const rows = playlistUris.slice(offset, offset + variables.limit).map((uri) => ({ itemV2: { data: { uri, name: uri, artists: [{ name: 'Artist' }], duration: { totalMilliseconds: 180000 } } } }));
        return { payload: { data: { playlistV2: { content: { items: rows, totalCount: playlistUris.length, pagingInfo: { offset } } } } } };
      }
      throw new Error(`Unexpected operation: ${operationName}`);
    }
    if (request.url === 'https://spclient.wg.spotify.com/playlist/v2/playlist') {
      assert.equal(request.payload.ops[0].kind, 'UPDATE_LIST_ATTRIBUTES');
      assert.equal(request.payload.ops[0].updateListAttributes.newAttributes.values.name, 'From Zvuk');
      playlistCreated = true;
      return { payload: { uri: 'spotify:playlist:created1234567890123456' } };
    }
    if (request.url === 'https://api.spotify.com/v1/me') return { payload: { id: 'testuser123' } };
    if (request.url === 'https://spclient.wg.spotify.com/playlist/v2/user/testuser123/rootlist/changes') {
      assert.equal(request.payload.deltas[0].ops[0].kind, 'ADD');
      assert.equal(request.payload.deltas[0].ops[0].add.items[0].uri, 'spotify:playlist:created1234567890123456');
      return { payload: { revision: 'fixture-revision' } };
    }
    throw new Error(`Unexpected URL: ${request.url}`);
  });
  await page.captureSession();
  const response = await page.command('execute-transfer', { plan: {
    type: 'music-transfer-plan', target: { provider: 'spotify' },
    completeness: { source: [{ confirmed: true }] },
    collectionMappings: [{ sourceId: 'source-list-1', sourceName: 'From Zvuk', targetName: 'From Zvuk' }],
    operations: sourceUris.map((providerId, position) => ({
      operation: 'add_to_playlist', source: { collectionId: 'source-list-1', collectionName: 'From Zvuk', position },
      target: { provider: 'spotify', providerId },
    })),
  } });
  assert.equal(response.ok, true);
  assert.equal(playlistCreated, true);
  assert.deepEqual(batches, [100, 2]);
  assert.deepEqual(playlistUris, sourceUris);
  assert.equal(response.result.playlists[0].verified, 102);
  assert.equal(response.result.playlists[0].exactOrder, true);
});

test('Spotify resume validates playlist order and adds only its missing suffix', async () => {
  const playlistUris = ['spotify:track:first'];
  const page = makePage((request) => {
    if (request.url.startsWith('https://api-partner.spotify.com/')) {
      const { operationName, variables } = request.payload;
      if (operationName === 'fetchLibraryTracks') return libraryTracks([]);
      if (operationName === 'fetchPlaylistContents') {
        const rows = playlistUris.slice(variables.offset, variables.offset + variables.limit)
          .map((uri) => ({ itemV2: { data: { uri, name: uri, artists: [{ name: 'Artist' }], duration: { totalMilliseconds: 180000 } } } }));
        return { payload: { data: { playlistV2: { content: { items: rows, totalCount: playlistUris.length, pagingInfo: { offset: variables.offset } } } } } };
      }
      if (operationName === 'addToPlaylist') {
        playlistUris.push(...variables.playlistItemUris);
        return { payload: { data: { addToPlaylist: true } } };
      }
    }
    throw new Error(`Resume must not create another playlist: ${request.url}`);
  });
  await page.captureSession();
  const plan = {
    type: 'music-transfer-plan', target: { provider: 'spotify', collectionType: 'playlists' },
    completeness: { source: [{ confirmed: true }] },
    collectionMappings: [{ sourceId: 'source-list', sourceName: 'Road', targetName: 'Road' }],
    operations: ['spotify:track:first', 'spotify:track:second'].map((providerId, position) => ({
      operation: 'add_to_playlist', source: { collectionId: 'source-list', collectionName: 'Road', position },
      target: { provider: 'spotify', providerId },
    })),
    recovery: {
      playlistTargets: { 'source-list': 'spotify:playlist:resume1234567890123456' },
      progress: { phase: 'playlist-items', sourceKey: 'source-list', targetPlaylistId: 'spotify:playlist:resume1234567890123456', playlistIndex: 0 },
    },
  };
  const response = await page.command('execute-transfer', { plan });

  assert.equal(response.ok, true, response.error);
  assert.deepEqual(playlistUris, ['spotify:track:first', 'spotify:track:second']);
  const append = page.requests.find((request) => request.payload?.operationName === 'addToPlaylist');
  assert.deepEqual(append.payload.variables.playlistItemUris, ['spotify:track:second']);
  assert.equal(page.requests.some((request) => request.url === 'https://spclient.wg.spotify.com/playlist/v2/playlist'), false);
});

test('Spotify writer refuses an incomplete source plan before writing', async () => {
  const page = makePage((request) => {
    if (request.url.startsWith('https://api-partner.spotify.com/')) return { payload: { data: {} } };
    throw new Error('An account write must not occur.');
  });
  await page.captureSession();
  const response = await page.command('execute-transfer', { plan: {
    type: 'music-transfer-plan', target: { provider: 'spotify' },
    completeness: { source: [{ confirmed: false }] }, collectionMappings: [],
    operations: [{ operation: 'add_to_favorites', target: { provider: 'spotify', providerId: 'spotify:track:1' } }],
  } });
  assert.equal(response.ok, false);
  assert.match(response.error, /полнота библиотеки источника/i);
  assert.equal(page.requests.length, 1);
});

test('Spotify writer preserves an explicitly confirmed empty source playlist', async () => {
  let created = false;
  const page = makePage((request) => {
    if (request.url.startsWith('https://api-partner.spotify.com/')) {
      const { operationName } = request.payload;
      if (operationName === 'fetchLibraryTracks') return libraryTracks([]);
      if (operationName === 'addToLibrary') return { payload: { data: { addToLibrary: true } } };
      if (operationName === 'fetchPlaylistContents') return { payload: { data: { playlistV2: { content: { items: [], totalCount: 0, pagingInfo: { offset: 0 } } } } } };
      throw new Error(`Unexpected operation: ${operationName}`);
    }
    if (request.url === 'https://spclient.wg.spotify.com/playlist/v2/playlist') {
      created = true;
      return { payload: { uri: 'spotify:playlist:created1234567890123456' } };
    }
    if (request.url === 'https://api.spotify.com/v1/me') return { payload: { id: 'testuser123' } };
    if (request.url === 'https://spclient.wg.spotify.com/playlist/v2/user/testuser123/rootlist/changes') return { payload: { revision: 'fixture-revision' } };
    throw new Error(`Unexpected URL: ${request.url}`);
  });
  await page.captureSession();
  const response = await page.command('execute-transfer', { plan: {
    type: 'music-transfer-plan', target: { provider: 'spotify' },
    completeness: { source: [{ confirmed: true }] },
    collectionMappings: [{ sourceId: 'empty-1', sourceName: 'Empty', targetName: 'Empty', sourceItemCount: 0, completeness: { confirmed: true } }],
    operations: [],
  } });
  assert.equal(response.ok, true, response.error);
  assert.equal(created, true);
  assert.equal(response.result.playlists[0].verified, 0);
  assert.equal(response.result.playlists[0].exactOrder, true);
});

test('Spotify writer reports a partial playlist failure after playlist creation', async () => {
  const page = makePage((request) => {
    if (request.url.startsWith('https://api-partner.spotify.com/')) {
      const operation = request.payload?.operationName;
      if (operation === 'fetchLibraryTracks') return libraryTracks([]);
      if (operation === 'addToPlaylist') return { status: 503, payload: { errors: [{ message: 'temporary failure' }] } };
      throw new Error(`Unexpected operation: ${operation}`);
    }
    if (request.url === 'https://spclient.wg.spotify.com/playlist/v2/playlist') return { payload: { uri: 'spotify:playlist:created1234567890123456' } };
    if (request.url === 'https://api.spotify.com/v1/me') return { payload: { id: 'testuser123' } };
    if (request.url === 'https://spclient.wg.spotify.com/playlist/v2/user/testuser123/rootlist/changes') return { payload: { revision: 'fixture-revision' } };
    throw new Error(`Unexpected URL: ${request.url}`);
  });
  await page.captureSession();
  const response = await page.command('execute-transfer', { plan: {
    type: 'music-transfer-plan', target: { provider: 'spotify' },
    completeness: { source: [{ confirmed: true }] },
    collectionMappings: [{ sourceId: 'source-1', sourceName: 'Retry me', targetName: 'Retry me', sourceItemCount: 1, completeness: { confirmed: true } }],
    operations: [{ operation: 'add_to_playlist', source: { collectionId: 'source-1', collectionName: 'Retry me', position: 0 }, target: { provider: 'spotify', providerId: 'spotify:track:target1' } }],
  } });
  assert.equal(response.ok, false);
  assert.equal(response.report.status, 'partial_failure');
  assert.equal(response.report.playlists[0].uri, 'spotify:playlist:created1234567890123456');
  assert.equal(response.report.playlists[0].requested, 1);
  assert.equal(response.report.playlists[0].verified, 0);
});
