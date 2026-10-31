const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const origin = 'https://open.spotify.com';
const endpoint = 'https://api-partner.spotify.com/pathfinder/v2/query';

function makePage(respond, timerScale = 1, scriptUrls = [], options = {}) {
  const listeners = new Map();
  const messages = [];
  const requests = [];
  const location = { origin, href: `${origin}/collection/tracks` };
  const document = { querySelectorAll: () => scriptUrls.map((src) => ({ src })) };
  const dispatchMessage = (data) => {
    return Promise.all((listeners.get('message') || []).map((listener) => listener({ source: window, origin, data })));
  };
  const window = {
    location,
    addEventListener(name, callback) { listeners.set(name, [...(listeners.get(name) || []), callback]); },
    postMessage(message) {
      messages.push(message);
      if (message.type === 'scan-progress' && message.progressAckId) setImmediate(() => {
        dispatchMessage({
          source: 'music-importer-spotify',
          type: 'scan-progress-ack',
          progressAckId: message.progressAckId,
          ok: options.rejectScanProgressAck !== true,
        });
      });
      if (['library-snapshot', 'scan-error'].includes(message.type) && message.terminalAckId) setImmediate(() => {
        const acknowledge = () => dispatchMessage({
          source: 'music-importer-spotify',
          type: 'scan-terminal-ack',
          terminalAckId: message.terminalAckId,
          ok: options.rejectTerminalAckType !== message.type,
        });
        if (message.type === 'library-snapshot' && options.delaySnapshotAckMs) {
          setTimeout(acknowledge, options.delaySnapshotAckMs * timerScale);
        } else acknowledge();
      });
    },
    async fetch(url, init = {}) {
      const request = { url: String(url), init, payload: typeof init.body === 'string' ? JSON.parse(init.body) : null, startedAt: Date.now() };
      requests.push(request);
      const result = await respond(request);
      return {
        ok: result.status === undefined || (result.status >= 200 && result.status < 300),
        status: result.status || 200,
        headers: { get: () => null },
        clone: () => ({ arrayBuffer: async () => {
          if (!result.pendingBody) return new ArrayBuffer(0);
          await new Promise((resolve, reject) => {
            if (request.init.signal.aborted) reject(new Error('aborted'));
            else request.init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
          return new ArrayBuffer(0);
        } }),
        json: async () => result.payload ?? result,
        text: async () => result.text || '',
      };
    },
  };
  const context = {
    window, location, document, URL, URLSearchParams, Headers, Request, Promise, Map, Set,
    String, Number, Array, Object, Error, JSON, Date, RegExp, Math,
    setTimeout: (callback, delay, ...args) => setTimeout(callback, delay * timerScale, ...args), clearTimeout, setImmediate,
    AbortController,
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../chrome-extension/spotify-main-world.js'), 'utf8'), context);
  return {
    messages,
    requests,
    async startScan() {
      await window.fetch(endpoint, {
        method: 'POST',
        headers: { authorization: 'Bearer fixture-secret', 'client-token': 'fixture-client-secret' },
        body: JSON.stringify({ operationName: 'initialPageRequest', extensions: { persistedQuery: { sha256Hash: 'a'.repeat(64) } } }),
      });
      await dispatchMessage({ source: 'music-importer-spotify', type: 'start-library-scan' });
    },
    refreshSession(headers) {
      return window.fetch(endpoint, {
        method: 'POST', headers,
        body: JSON.stringify({ operationName: 'initialPageRequest', extensions: { persistedQuery: { sha256Hash: 'b'.repeat(64) } } }),
      });
    },
  };
}

function trackData(uri, name) {
  return { uri, name, artists: [{ name: 'Artist' }], album: { name: 'Album' }, externalIds: { isrc: 'USABC1234567' }, duration: { totalMilliseconds: 180000 } };
}

test('Spotify source reader imports liked tracks and every playlist with item order and empty lists', async () => {
  const page = makePage(({ payload }) => {
    const { operationName } = payload || {};
    if (operationName === 'initialPageRequest') return { payload: { data: {} } };
    if (operationName === 'fetchLibraryTracks') return { payload: { data: { me: { library: { tracks: {
      totalCount: 1,
      items: [{ track: { _uri: 'spotify:track:like1', data: trackData('spotify:track:like1', 'Liked') } }],
    } } } } } };
    if (operationName === 'libraryV3') return { payload: { data: { me: { libraryV3: {
      totalCount: 2,
      items: [
        { item: { _uri: 'spotify:playlist:road', data: { name: 'Road', totalLength: 2 } } },
        { item: { _uri: 'spotify:playlist:empty', data: { name: 'Empty', totalLength: 0 } } },
      ],
    } } } } };
    if (operationName === 'fetchPlaylistContents') {
      const playlist = payload.variables.uri;
      const rows = playlist.endsWith(':road')
        ? ['spotify:track:one', 'spotify:track:two'].map((uri, index) => ({ itemV2: { data: trackData(uri, `Track ${index + 1}`) } }))
        : [];
      return { payload: { data: { playlistV2: { content: { items: rows, totalCount: rows.length, pagingInfo: { offset: 0 } } } } } };
    }
    throw new Error(`Unexpected Spotify operation: ${operationName}`);
  });

  await page.startScan();
  const snapshot = page.messages.find((message) => message.type === 'library-snapshot')?.payload;
  assert.ok(snapshot, JSON.stringify(page.messages));
  assert.equal(snapshot.service, 'spotify');
  assert.equal(snapshot.completeness.confirmed, true);
  assert.deepEqual(Array.from(snapshot.tracks, (track) => [track.id, track.collectionType]), [['spotify:track:like1', 'favorites']]);
  assert.deepEqual(Array.from(snapshot.playlists, (playlist) => playlist.title), ['Road', 'Empty']);
  assert.deepEqual(Array.from(snapshot.playlists[0].tracks, (track) => [track.id, track.position]), [
    ['spotify:track:one', 0], ['spotify:track:two', 1],
  ]);
  assert.equal(snapshot.playlists[1].complete, true);
  const emitted = JSON.stringify(page.messages);
  assert.ok(!emitted.includes('fixture-secret'));
  assert.ok(!emitted.includes('fixture-client-secret'));
  assert.ok(page.requests.filter((request) => request.url === endpoint).every((request) => request.init.headers.authorization === 'Bearer fixture-secret'));
  assert.ok(page.requests.filter((request) => request.url === endpoint && request.payload?.operationName !== 'initialPageRequest')
    .every((request) => request.init.credentials === 'include'));
  const diagnostics = page.messages.filter((message) => message.diagnostic).map((message) => message.diagnostic);
  assert.ok(diagnostics.some((diagnostic) => diagnostic.operation === 'fetchLibraryTracks'
    && diagnostic.offset === 0 && diagnostic.limit === 50
    && Number.isInteger(diagnostic.elapsedMs) && diagnostic.elapsedMs >= 0
    && diagnostic.result.status === 200));
  assert.ok(diagnostics.some((diagnostic) => diagnostic.operation === 'libraryV3'
    && diagnostic.offset === 0 && diagnostic.limit === 50 && diagnostic.result.status === 200));
  const diagnosticText = JSON.stringify(diagnostics);
  for (const privateValue of ['fixture-secret', 'fixture-client-secret', 'spotify:track:like1', 'spotify:playlist:road', 'Liked', 'Road']) {
    assert.ok(!diagnosticText.includes(privateValue), `diagnostics must not include ${privateValue}`);
  }
});

test('Spotify source reader advances by the returned page length when likes and playlists are capped', async () => {
  const trackUris = Array.from({ length: 5 }, (_, index) => `spotify:track:page-${index + 1}`);
  const page = makePage(({ payload }) => {
    const { operationName, variables = {} } = payload || {};
    if (operationName === 'initialPageRequest') return { payload: { data: {} } };
    if (operationName === 'fetchLibraryTracks') {
      return { payload: { data: { me: { library: { tracks: {
        totalCount: trackUris.length,
        pagingInfo: { offset: variables.offset },
        items: trackUris.slice(variables.offset, variables.offset + 2).map((uri) => ({ track: { _uri: uri, data: trackData(uri, uri) } })),
      } } } } } };
    }
    if (operationName === 'libraryV3') {
      const rows = variables.offset === 0 ? [{ item: { _uri: 'spotify:playlist:capped', data: { name: 'Capped', totalLength: trackUris.length } } }] : [];
      return { payload: { data: { me: { libraryV3: { totalCount: 1, items: rows } } } } };
    }
    if (operationName === 'fetchPlaylistContents') {
      return { payload: { data: { playlistV2: { content: {
        totalCount: trackUris.length,
        pagingInfo: { offset: variables.offset },
        items: trackUris.slice(variables.offset, variables.offset + 2).map((uri) => ({ itemV2: { data: trackData(uri, uri) } })),
      } } } } };
    }
    throw new Error(`Unexpected Spotify operation: ${operationName}`);
  });

  await page.startScan();

  const snapshot = page.messages.find((message) => message.type === 'library-snapshot')?.payload;
  assert.ok(snapshot, JSON.stringify(page.messages));
  assert.equal(snapshot.completeness.confirmed, true);
  assert.deepEqual(Array.from(snapshot.tracks, (track) => track.id), trackUris);
  assert.deepEqual(Array.from(snapshot.playlists[0].tracks, (track) => track.id), trackUris);
  const likesOffsets = page.requests.filter((request) => request.payload?.operationName === 'fetchLibraryTracks').map((request) => request.payload.variables.offset);
  const playlistOffsets = page.requests.filter((request) => request.payload?.operationName === 'fetchPlaylistContents').map((request) => request.payload.variables.offset);
  assert.deepEqual(likesOffsets, [0, 2, 4]);
  assert.deepEqual(playlistOffsets, [0, 2, 4]);
  assert.ok(page.requests.filter((request) => ['fetchLibraryTracks', 'fetchPlaylistContents'].includes(request.payload?.operationName))
    .every((request) => request.payload.variables.limit === 50));
});

test('Spotify scan diagnostics sanitize provider errors and include page coordinates and elapsed time', async () => {
  const privateProviderMessage = 'private provider detail with spotify:track:private-id and a session value';
  const page = makePage(({ payload }) => {
    if (payload?.operationName === 'initialPageRequest') return { payload: { data: {} } };
    if (payload?.operationName === 'fetchLibraryTracks') return { payload: { errors: [{ message: privateProviderMessage }] } };
    throw new Error(`Unexpected Spotify operation: ${payload?.operationName}`);
  });

  await page.startScan();

  const error = page.messages.find((message) => message.type === 'scan-error');
  assert.ok(error);
  assert.equal(error.diagnostic.operation, 'fetchLibraryTracks');
  assert.equal(error.diagnostic.offset, 0);
  assert.equal(error.diagnostic.limit, 50);
  assert.ok(Number.isInteger(error.diagnostic.elapsedMs) && error.diagnostic.elapsedMs >= 0);
  assert.deepEqual({ ...error.diagnostic.result }, { code: 'provider_error' });
  assert.match(error.error, /Диагностика: fetchLibraryTracks 0\/50 · \d+ мс · provider_error\./);
  const diagnosticText = JSON.stringify(page.messages.filter((message) => message.diagnostic));
  assert.ok(!diagnosticText.includes(privateProviderMessage));
  assert.ok(!diagnosticText.includes('spotify:track:private-id'));
  assert.ok(!diagnosticText.includes('fixture-secret'));
  assert.ok(!diagnosticText.includes('fixture-client-secret'));
  assert.ok(!error.error.includes(privateProviderMessage));
  assert.ok(!error.error.includes('spotify:track:private-id'));
  assert.ok(!error.error.includes('session value'));
});

test('Spotify retries one 401 only after the page captures a newer session snapshot', async () => {
  let page;
  let favoritesRequests = 0;
  page = makePage(async ({ payload }) => {
    if (payload?.operationName === 'initialPageRequest') return { payload: { data: {} } };
    if (payload?.operationName === 'fetchLibraryTracks') {
      favoritesRequests += 1;
      if (favoritesRequests === 1) {
        void page.refreshSession({ authorization: 'Bearer refreshed-fixture-secret', 'client-token': 'refreshed-fixture-client' });
        return { status: 401, payload: {} };
      }
      return { payload: { data: { me: { library: { tracks: { totalCount: 0, items: [] } } } } } };
    }
    if (payload?.operationName === 'libraryV3') return { payload: { data: { me: { libraryV3: { totalCount: 0, items: [] } } } } };
    throw new Error(`Unexpected Spotify operation: ${payload?.operationName}`);
  }, 0.001);

  await page.startScan();

  const favoriteRequests = page.requests.filter((request) => request.payload?.operationName === 'fetchLibraryTracks');
  assert.equal(favoritesRequests, 2);
  assert.equal(favoriteRequests[1].init.headers.authorization, 'Bearer refreshed-fixture-secret');
  assert.ok(page.messages.some((message) => message.type === 'library-snapshot'));
  const emitted = JSON.stringify(page.messages);
  assert.ok(!emitted.includes('refreshed-fixture-secret'));
  assert.ok(!emitted.includes('refreshed-fixture-client'));
});

test('Spotify does not blindly replay a 401 when the page session was not refreshed', async () => {
  let favoritesRequests = 0;
  const page = makePage(({ payload }) => {
    if (payload?.operationName === 'initialPageRequest') return { payload: { data: {} } };
    if (payload?.operationName === 'fetchLibraryTracks') {
      favoritesRequests += 1;
      return { status: 401, payload: {} };
    }
    if (payload?.operationName === 'libraryV3') return { payload: { data: { me: { libraryV3: { totalCount: 0, items: [] } } } } };
    throw new Error(`Unexpected Spotify operation: ${payload?.operationName}`);
  }, 0.001);

  await page.startScan();

  const error = page.messages.find((message) => message.type === 'scan-error');
  assert.equal(favoritesRequests, 1);
  assert.equal(error?.diagnostic?.result?.status, 401);
  assert.ok(!JSON.stringify(page.messages).includes('fixture-secret'));
  assert.ok(!JSON.stringify(page.messages).includes('fixture-client-secret'));
});

test('Spotify source reader skips downloading the web-player bundle when seeded query hashes are available', async () => {
  const page = makePage(({ payload }) => {
    if (payload?.operationName === 'initialPageRequest') return { payload: { data: {} } };
    if (payload?.operationName === 'fetchLibraryTracks') return { payload: { data: { me: { library: { tracks: { totalCount: 0, items: [] } } } } } };
    if (payload?.operationName === 'libraryV3') return { payload: { data: { me: { libraryV3: { totalCount: 0, items: [] } } } } };
    throw new Error(`Unexpected Spotify operation: ${payload?.operationName}`);
  }, 1, ['https://open.spotifycdn.com/cdn/build/web-player.fixture.js']);

  await page.startScan();

  assert.equal(page.requests.some((request) => request.url.includes('spotifycdn.com')), false);
  assert.ok(page.messages.some((message) => message.type === 'library-snapshot'));
});

test('Spotify source reader refreshes a persisted query hash after PersistedQueryNotFound', async () => {
  const refreshedHash = 'f'.repeat(64);
  let favoritesRequests = 0;
  const page = makePage(({ url, payload }) => {
    if (url.includes('spotifycdn.com')) return { text: ` fetchLibraryTracks ${refreshedHash}`, payload: {} };
    if (payload?.operationName === 'initialPageRequest') return { payload: { data: {} } };
    if (payload?.operationName === 'fetchLibraryTracks' && favoritesRequests++ === 0) {
      return { payload: { errors: [{ message: 'PersistedQueryNotFound' }] } };
    }
    if (payload?.operationName === 'fetchLibraryTracks') return { payload: { data: { me: { library: { tracks: { totalCount: 0, items: [] } } } } } };
    if (payload?.operationName === 'libraryV3') return { payload: { data: { me: { libraryV3: { totalCount: 0, items: [] } } } } };
    throw new Error(`Unexpected Spotify operation: ${payload?.operationName}`);
  }, 0.01, ['https://open.spotifycdn.com/cdn/build/web-player.fixture.js']);

  await page.startScan();

  const favoriteRequests = page.requests.filter((request) => request.payload?.operationName === 'fetchLibraryTracks');
  assert.equal(favoriteRequests.length, 2);
  assert.equal(favoriteRequests[1].payload.extensions.persistedQuery.sha256Hash, refreshedHash);
  assert.ok(page.messages.some((message) => message.type === 'library-snapshot'));
});

test('Spotify source reader times out when an HTTP response body stalls after headers', async () => {
  const page = makePage(({ payload }) => {
    if (payload.operationName === 'initialPageRequest') return { payload: { data: {} } };
    return { pendingBody: true };
  }, 0.001);
  await page.startScan();
  assert.match(page.messages.find((message) => message.type === 'scan-error')?.error || '', /Spotify не ответил за 45 с/);
});

test('Spotify source reader completes liked tracks before it starts reading playlists', async () => {
  const page = makePage(({ payload }) => {
    if (payload.operationName === 'initialPageRequest') return { payload: { data: {} } };
    if (payload.operationName === 'fetchLibraryTracks') return { payload: { data: { me: { library: { tracks: { totalCount: 0, items: [] } } } } } };
    if (payload.operationName === 'libraryV3') return { payload: { data: { me: { libraryV3: { totalCount: 0, items: [] } } } } };
    throw new Error(`Unexpected Spotify operation: ${payload.operationName}`);
  });

  await page.startScan();
  const starts = page.requests.filter((request) => request.url === endpoint && request.payload?.operationName !== 'initialPageRequest')
    .map((request) => request.payload.operationName);
  assert.deepEqual(starts, ['fetchLibraryTracks', 'libraryV3']);
  assert.ok(page.messages.some((message) => message.type === 'scan-progress'
    && /Лайки Spotify сверены: 0\. Читаем каталог плейлистов/.test(message.message)));
});

test('Spotify source reader refuses a truncated liked-track page', async () => {
  const page = makePage(({ payload }) => {
    const operation = payload?.operationName;
    if (operation === 'initialPageRequest') return { payload: { data: {} } };
    if (operation === 'fetchLibraryTracks') return { payload: { data: { me: { library: { tracks: { totalCount: 2, items: [] } } } } } };
    throw new Error(`Incomplete favorites should stop before ${operation}`);
  });

  await page.startScan();
  assert.ok(page.messages.some((message) => message.type === 'scan-error' && /пустую страницу/i.test(message.error)));
  const error = page.messages.find((message) => message.type === 'scan-error');
  assert.equal(error.diagnostic.operation, 'fetchLibraryTracks');
  assert.equal(error.diagnostic.offset, 0);
  assert.equal(error.diagnostic.limit, 50);
  assert.equal(error.diagnostic.result.code, 'empty_page');
  assert.match(error.error, /empty_page/);
  assert.ok(!page.messages.some((message) => message.type === 'library-snapshot'));
});

test('Spotify source reader reports the playlist phase and fails a stalled API request', async () => {
  const page = makePage(({ payload, init }) => {
    const operation = payload?.operationName;
    if (operation === 'initialPageRequest') return { payload: { data: {} } };
    if (operation === 'fetchLibraryTracks') return { payload: { data: { me: { library: { tracks: { totalCount: 0, items: [] } } } } } };
    if (operation === 'libraryV3') return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    throw new Error(`Unexpected Spotify operation: ${operation}`);
  }, 0.001);

  await page.startScan();
  assert.ok(page.messages.some((message) => message.type === 'scan-progress' && /каталог плейлистов/i.test(message.message)));
  assert.ok(page.messages.some((message) => message.type === 'scan-error' && /не ответил за 45 с/i.test(message.error)));
  assert.ok(!page.messages.some((message) => message.type === 'library-snapshot'));
});

test('Spotify source reader stops with a clear error when the extension does not confirm progress delivery', async () => {
  const page = makePage(({ payload }) => {
    if (payload?.operationName === 'initialPageRequest') return { payload: { data: {} } };
    throw new Error(`Unexpected Spotify operation: ${payload?.operationName}`);
  }, 1, [], { rejectScanProgressAck: true });

  await page.startScan();
  assert.ok(page.messages.some((message) => message.type === 'scan-error'
    && /не смог передать статус сканирования расширению/i.test(message.error)));
  assert.ok(!page.messages.some((message) => message.type === 'library-snapshot'));
});

test('Spotify source reader does not replace a completed snapshot after a rejected terminal acknowledgment', async () => {
  const page = makePage(({ payload }) => {
    if (payload?.operationName === 'initialPageRequest') return { payload: { data: {} } };
    if (payload?.operationName === 'fetchLibraryTracks') return { payload: { data: { me: { library: { tracks: { totalCount: 0, items: [] } } } } } };
    if (payload?.operationName === 'libraryV3') return { payload: { data: { me: { libraryV3: { totalCount: 0, items: [] } } } } };
    if (payload?.operationName === 'savedAlbums') return { status: 200, payload: { items: [], total: 0 } };
    throw new Error(`Unexpected Spotify operation: ${payload?.operationName}`);
  }, 0.001, [], { rejectTerminalAckType: 'library-snapshot' });

  await page.startScan();
  assert.ok(page.messages.some((message) => message.type === 'library-snapshot' && message.terminalAckId));
  assert.ok(!page.messages.some((message) => message.type === 'scan-error'));
});

test('Spotify source reader does not overwrite a snapshot when its acknowledgment arrives late', async () => {
  const page = makePage(({ payload }) => {
    if (payload?.operationName === 'initialPageRequest') return { payload: { data: {} } };
    if (payload?.operationName === 'fetchLibraryTracks') return { payload: { data: { me: { library: { tracks: { totalCount: 0, items: [] } } } } } };
    if (payload?.operationName === 'libraryV3') return { payload: { data: { me: { libraryV3: { totalCount: 0, items: [] } } } } };
    if (payload?.operationName === 'savedAlbums') return { status: 200, payload: { items: [], total: 0 } };
    throw new Error(`Unexpected Spotify operation: ${payload?.operationName}`);
  }, 0.001, [], { delaySnapshotAckMs: 30000 });

  await page.startScan();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(page.messages.some((message) => message.type === 'library-snapshot'));
  assert.ok(!page.messages.some((message) => message.type === 'scan-error'));
});
