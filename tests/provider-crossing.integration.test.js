const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function loadTransferModules() {
  const context = { window: {}, Date, Map, Set, String, Number, Array, Object, Error, structuredClone, DOMException };
  for (const file of ['matcher.js', 'account-catalog.js', 'transfer-core.js', 'transfer-engine.js']) {
    vm.runInNewContext(fs.readFileSync(require.resolve(`../chrome-extension/app/${file}`), 'utf8'), context, { filename: file });
  }
  return { core: context.window.MusicTransferCore, engine: context.window.MusicTransferEngine };
}

function makePage({ origin, script, fetch, requestHeaders = {}, href = `${origin}/library` }) {
  const listeners = new Map();
  const messages = [];
  const location = { origin, href, pathname: new URL(href).pathname };
  const window = {
    location,
    addEventListener(name, callback) { listeners.set(name, [...(listeners.get(name) || []), callback]); },
    postMessage(data) {
      messages.push(data);
      if (data.captureAckId) queueMicrotask(() => {
        for (const listener of listeners.get('message') || []) void listener({ source: window, origin,
          data: { source: data.source, type: 'capture-ack', captureAckId: data.captureAckId, ok: true } });
      });
      if (data.type === 'transfer-progress' && data.progress?.checkpointId) queueMicrotask(() => {
        for (const listener of listeners.get('message') || []) void listener({
          source: window, origin, data: { source: data.source, type: 'transfer-progress-ack', checkpointId: data.progress.checkpointId, ok: true },
        });
      });
    },
    fetch: async (url, init = {}) => {
      const headers = new Headers({ ...requestHeaders, ...(init.headers || {}) });
      const response = await fetch(String(url), { ...init, headers });
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        headers: new Headers(response.headers || {}),
        clone: () => ({ arrayBuffer: async () => new ArrayBuffer(0), json: async () => response.payload }),
        json: async () => response.payload,
        text: async () => JSON.stringify(response.payload),
      };
    },
  };
  const context = {
    window, location: window.location, URL, URLSearchParams, Headers, Request, Promise, Map, Set,
    String, Number, Array, Object, Error, JSON, Date, RegExp, Math,
    setTimeout, clearTimeout, AbortController, console,
    history: { state: {}, replaceState(_state, _title, url) { location.href = String(url); location.pathname = new URL(location.href).pathname; } },
    document: { documentElement: { scrollHeight: 100, clientHeight: 100, scrollTop: 0 }, scrollingElement: { scrollHeight: 100 }, querySelectorAll: () => [] },
    XMLHttpRequest: class { open() {} send() {} addEventListener() {} },
    setInterval: () => 1, clearInterval() {}, getComputedStyle: () => ({ overflowY: 'visible' }),
  };
  vm.runInNewContext(fs.readFileSync(require.resolve(script), 'utf8'), context, { filename: script });
  return {
    window, messages,
    async dispatch(data) {
      await Promise.all((listeners.get('message') || []).map((listener) => listener({ source: window, origin, data })));
    },
    async waitForMessage(type, predicate = () => true, minimumCount = 1) {
      for (let attempts = 0; attempts < 10000; attempts += 1) {
        const found = messages.filter((message) => message.type === type && predicate(message));
        if (found.length >= minimumCount) return found.at(-1);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error(`Timed out waiting for ${type}; observed ${messages.map((message) => `${message.type}${message.error ? `: ${message.error}` : ''}`).join(', ')}`);
    },
  };
}

function appleRow() {
  return { id: 'apple-library-1', attributes: {
    name: 'Fixture Song', artistName: 'Fixture Artist', albumName: 'Fixture Album',
    inFavorites: true, playParams: { id: 'apple-catalog-1' }, isrc: 'USABC1234567', durationInMillis: 180000,
  } };
}

function spotifyLibrary(uris) {
  return { data: { me: { library: { tracks: {
    totalCount: uris.length,
    items: uris.map((uri) => ({ track: { _uri: uri, data: {
      uri, name: 'Fixture Song', artists: [{ name: 'Fixture Artist' }], album: { name: 'Fixture Album' },
      externalIds: { isrc: 'USABC1234567' }, duration: { totalMilliseconds: 180000 },
    } } })),
  } } } } };
}

const providers = ['apple-music', 'spotify', 'yandex-music', 'zvuk'];
const providerScript = {
  'apple-music': '../chrome-extension/apple-main-world.js',
  spotify: '../chrome-extension/spotify-main-world.js',
  'yandex-music': '../chrome-extension/yandex-main-world.js',
  zvuk: '../chrome-extension/zvuk-target-main-world.js',
};
const fixtureTrack = { title: 'Fixture Song', artists: ['Fixture Artist'], album: 'Fixture Album', isrc: 'USABC1234567', durationMs: 180000 };
const fixtureIds = {
  'apple-music': { source: 'apple-source', target: 'apple-target' },
  spotify: { source: 'spotify:track:source', target: 'spotify:track:target' },
  'yandex-music': { source: 'yandex-source', target: 'yandex-target' },
  zvuk: { source: 'zvuk-source', target: 'zvuk-target' },
};

function providerTrack(provider, id, liked = true) {
  if (provider === 'apple-music') return { id: `library-${id}`, attributes: {
    name: fixtureTrack.title, artistName: fixtureTrack.artists[0], albumName: fixtureTrack.album,
    inFavorites: liked, playParams: { id }, isrc: fixtureTrack.isrc, durationInMillis: fixtureTrack.durationMs,
  } };
  if (provider === 'spotify') return { track: { _uri: id, data: {
    uri: id, name: fixtureTrack.title, artists: [{ name: fixtureTrack.artists[0] }], album: { name: fixtureTrack.album },
    externalIds: { isrc: fixtureTrack.isrc }, duration: { totalMilliseconds: fixtureTrack.durationMs },
  } } };
  if (provider === 'yandex-music') return {
    id, title: fixtureTrack.title, artists: [{ name: fixtureTrack.artists[0] }], albums: [{ title: fixtureTrack.album }],
    isrc: fixtureTrack.isrc, durationMs: fixtureTrack.durationMs,
  };
  return { id, title: fixtureTrack.title, artists: [{ title: fixtureTrack.artists[0] }],
    release: { title: fixtureTrack.album }, isrc: fixtureTrack.isrc, duration: fixtureTrack.durationMs };
}

function makeProviderState(provider, ids = [], withSourcePlaylist = false) {
  const sourceId = `source-playlist-${provider}`;
  return {
    provider, ids: [...ids], playlists: withSourcePlaylist
      ? [{ id: sourceId, uri: provider === 'spotify' ? `spotify:playlist:${sourceId}` : undefined,
        title: 'Ordered Fixture', trackIds: [fixtureIds[provider].source, fixtureIds[provider].source], revision: 1 }]
      : [],
  };
}

function appleResponse(path, method, body, state) {
  if (path.startsWith('/v1/me/storefront')) return { meta: {}, data: [{ id: 'us' }] };
  if (path.startsWith('/v1/me/library/songs')) {
    const rows = state.ids.map((id) => providerTrack('apple-music', id));
    return { meta: { total: rows.length }, next: null, data: rows };
  }
  if (path === '/v1/me/library/playlists?limit=100') return {
    meta: { total: state.playlists.length }, next: null,
    data: state.playlists.map((playlist) => ({ id: playlist.id, attributes: { name: playlist.title } })),
  };
  const applePlaylistTracks = /^\/v1\/me\/library\/playlists\/([^/]+)\/tracks/.exec(path);
  if (applePlaylistTracks && method === 'GET') {
    const playlist = state.playlists.find((item) => item.id === decodeURIComponent(applePlaylistTracks[1]));
    const rows = (playlist?.trackIds || []).map((id) => providerTrack('apple-music', id));
    return { meta: { total: rows.length }, next: null, data: rows };
  }
  if (path === '/v1/me/library/playlists' && method === 'POST') {
    const id = 'apple-created-playlist';
    const title = JSON.parse(body).attributes.name;
    state.playlists.push({ id, title, trackIds: [] });
    return { data: [{ id, type: 'library-playlists' }] };
  }
  if (applePlaylistTracks && method === 'POST') {
    const playlist = state.playlists.find((item) => item.id === decodeURIComponent(applePlaylistTracks[1]));
    playlist.trackIds.push(...JSON.parse(body).data.map((item) => item.id));
    return { data: [] };
  }
  if (path.startsWith('/v1/me/favorites?') && method === 'POST') {
    const ids = new URLSearchParams(path.split('?')[1]).get('ids[songs]')?.split(',').filter(Boolean) || [];
    state.ids.push(...ids.filter((id) => !state.ids.includes(id)));
    return { data: [] };
  }
  throw new Error(`Unexpected Apple fixture request: ${method} ${path}`);
}

function spotifyResponse(payload, state) {
  const operation = payload.operationName;
  const variables = payload.variables || {};
  if (operation === 'fetchLibraryTracks') return { data: { me: { library: { tracks: {
    totalCount: state.ids.length, items: state.ids.map((id) => providerTrack('spotify', id)),
  } } } } };
  if (operation === 'libraryV3') return { data: { me: { libraryV3: {
    totalCount: state.playlists.length,
    items: state.playlists.map((playlist) => ({ item: { _uri: playlist.uri || playlist.id, data: { uri: playlist.uri || playlist.id, name: playlist.title, totalLength: playlist.trackIds.length } } })),
  } } } };
  if (operation === 'fetchPlaylistContents') {
    const playlist = state.playlists.find((item) => (item.uri || item.id) === variables.uri);
    const items = (playlist?.trackIds || []).map((id) => ({ itemV2: { data: {
      uri: id, name: fixtureTrack.title, artists: [{ name: fixtureTrack.artists[0] }], albumOfTrack: { name: fixtureTrack.album },
      externalIds: { isrc: fixtureTrack.isrc }, duration: { totalMilliseconds: fixtureTrack.durationMs },
    } } }));
    return { data: { playlistV2: { content: { totalCount: items.length, pagingInfo: { offset: variables.offset }, items } } } };
  }
  if (operation === 'addToPlaylist') {
    const playlist = state.playlists.find((item) => (item.uri || item.id) === variables.playlistUri);
    playlist.trackIds.push(...variables.playlistItemUris);
    return { data: { addToPlaylist: true } };
  }
  if (operation === 'addToLibrary') {
    state.ids.push(...variables.libraryItemUris.filter((id) => !state.ids.includes(id)));
    return { data: { addToLibrary: true } };
  }
  throw new Error(`Unexpected Spotify fixture operation: ${operation}`);
}

function yandexResponse(path, method, body, state) {
  if (path === '/account/status') return { result: { account: { uid: 42 } } };
  if (path === '/users/42/likes/tracks/add-multiple' && method === 'POST') {
    const ids = new URLSearchParams(body || '').get('track-ids')?.split(',').filter(Boolean) || [];
    state.ids.push(...ids.filter((id) => !state.ids.includes(id)));
    return { result: true };
  }
  if (path.startsWith('/users/42/likes/tracks')) return { result: { library: { revision: 1, tracks: state.ids.map((id) => ({ id })) } } };
  if (path === '/tracks' && method === 'POST') {
    const ids = new URLSearchParams(body || '').get('track-ids')?.split(',').filter(Boolean) || [];
    return { result: ids.map((id) => providerTrack('yandex-music', id)) };
  }
  if (path === '/users/42/playlists/list') return { result: { playlists: state.playlists.map((playlist) => ({ uid: 42, kind: playlist.id, title: playlist.title, trackCount: playlist.trackIds.length })) } };
  if (path === '/users/42/playlists/list/kinds') return { result: state.playlists.map((playlist) => playlist.id) };
  if (path === '/users/42/playlists/create' && method === 'POST') {
    const form = new URLSearchParams(body || '');
    const playlist = { id: 'yandex-created-playlist', title: form.get('title'), trackIds: [], revision: 1 };
    state.playlists.push(playlist);
    return { result: { playlist: { kind: playlist.id, title: playlist.title } } };
  }
  if (path.startsWith('/users/42/playlists/') && path.endsWith('/change-relative') && method === 'POST') {
    const playlist = state.playlists[0];
    const diff = JSON.parse(new URLSearchParams(body || '').get('diff'));
    playlist.trackIds.splice(diff.at, 0, ...diff.tracks.map((item) => item.id));
    playlist.revision += 1;
    return { result: true };
  }
  const yandexPlaylist = /^\/users\/42\/playlists\/([^/]+)$/.exec(path);
  if (yandexPlaylist) {
    const playlist = state.playlists.find((item) => item.id === decodeURIComponent(yandexPlaylist[1]));
    return { result: { playlist: { title: playlist.title, revision: playlist.revision || 1, trackCount: playlist.trackIds.length, tracks: playlist.trackIds.map((id) => ({ id })) } } };
  }
  throw new Error(`Unexpected Yandex fixture request: ${method} ${path}`);
}

function zvukResponse(payload, state) {
  const operation = payload.operationName;
  const variables = payload.variables || {};
  if (operation === 'getPaginatedCollection') return { data: { paginatedCollection: { tracks: {
    items: state.ids.map((id) => ({ id })), page: { endCursor: null },
  } } } };
  if (operation === 'AddItemsToCollection') {
    const ids = variables.items.map((item) => item.id);
    state.ids.push(...ids.filter((id) => !state.ids.includes(id)));
    return { data: { collection: { addItems: true } } };
  }
  if (operation === 'getPaginatedCollectionAll') return { data: { paginatedCollectionAll: { playlists: {
    items: state.playlists.map((playlist) => ({ id: playlist.id, title: playlist.title, trackCount: playlist.trackIds.length })), page: { endCursor: null },
  } } } };
  if (operation === 'createPlaylist') {
    const playlist = { id: 'zvuk-created-playlist', title: variables.name, trackIds: variables.items.map((item) => item.item_id) };
    state.playlists.push(playlist);
    return { data: { playlist: { createV1: { id: playlist.id } } } };
  }
  if (operation === 'addItems') {
    const playlist = state.playlists.find((item) => item.id === variables.id);
    playlist.trackIds.push(...variables.items.map((item) => item.item_id));
    return { data: { playlist: { addItemsV1: { id: playlist.id } } } };
  }
  if (operation === 'getPlaylistTracks') {
    const playlist = state.playlists.find((item) => item.id === variables.id);
    return { data: { playlistTracks: (playlist?.trackIds || []).slice(variables.offset, variables.offset + variables.limit).map((id) => ({ id })) } };
  }
  throw new Error(`Unexpected Zvuk fixture operation: ${operation}`);
}

async function readProviderLibrary(provider, state) {
  if (provider === 'zvuk') {
    // Zvuk's injected MAIN-world script is a page connector, so source pages are captured
    // from the actual GraphQL response hook rather than a synthetic aggregate reader.
    const connector = makePage({
      origin: 'https://zvuk.com', script: '../chrome-extension/main-world.js',
      href: 'https://zvuk.com/favorites?music_importer_capture=1',
      fetch: async (_url, init = {}) => {
        const payload = JSON.parse(init.body || '{}');
        if (payload.operationName === 'getPaginatedCollection') return { status: 200, payload: { data: { paginatedCollection: { tracks: {
          items: state.ids.map((id) => ({ id, title: fixtureTrack.title, artists: [{ title: fixtureTrack.artists[0] }], release: { title: fixtureTrack.album }, isrc: fixtureTrack.isrc, duration: fixtureTrack.durationMs })),
          page: { endCursor: null },
        } } } } };
        if (payload.operationName === 'getPaginatedCollectionAll') return { status: 200, payload: { data: { paginatedCollectionAll: { playlists: {
          items: state.playlists.map((playlist) => ({ id: playlist.id, title: playlist.title, trackCount: playlist.trackIds.length })), page: { endCursor: null },
        } } } } };
        if (payload.operationName === 'getPlaylistTracks') {
          const playlist = state.playlists.find((item) => item.id === payload.variables.id);
          return { status: 200, payload: { data: { playlistTracks: (playlist?.trackIds || []).map((id) => ({
            id, title: fixtureTrack.title, artists: [{ title: fixtureTrack.artists[0] }], release: { title: fixtureTrack.album }, isrc: fixtureTrack.isrc, duration: fixtureTrack.durationMs,
          })) } } };
        }
        throw new Error(`Unexpected Zvuk reader query: ${payload.operationName}`);
      },
    });
    // The page connector captures the favorites response, then the real pagination and
    // playlist normalization paths report both collection types to the harness.
    await connector.window.fetch('/api/v1/graphql', { method: 'POST', body: JSON.stringify({
      operationName: 'getPaginatedCollection', variables: { limit: 100, after: null },
    }) });
    await connector.waitForMessage('favorites-scroll-end');
    connector.window.location.pathname = '/collection';
    await connector.window.fetch('/api/v1/graphql', { method: 'POST', body: JSON.stringify({ operationName: 'getPaginatedCollectionAll', variables: { first: 100, after: null } }) });
    const listed = await connector.waitForMessage('playlist-list-page');
    const playlists = [];
    for (const playlist of listed.playlists) {
      connector.window.location.pathname = `/playlist/${playlist.id}`;
      await connector.window.fetch('/api/v1/graphql', { method: 'POST', body: JSON.stringify({ operationName: 'getPlaylistTracks', variables: { id: playlist.id, offset: 0, limit: 100 } }) });
      const page = await connector.waitForMessage('playlist-track-page');
      playlists.push({ ...playlist, complete: true, tracks: page.tracks.map((track, position) => ({ ...track, position })) });
    }
    const favoritePage = connector.messages.filter((message) => message.type === 'favorite-page').flatMap((message) => message.tracks || []);
    return {
      service: provider,
      completeness: { confirmed: true, favoritesConfirmed: true, favoritesCount: favoritePage.length },
      tracks: favoritePage.map((track) => ({ ...track, collectionType: 'favorites' })),
      playlists,
    };
  }

  const page = await makeProviderPage(provider, state);
  const marker = provider === 'apple-music' ? 'music-importer-apple'
    : provider === 'yandex-music' ? 'music-importer-yandex' : `music-importer-${provider}`;
  await page.dispatch({ source: marker, type: 'start-library-scan' });
  return (await page.waitForMessage('library-snapshot')).payload;
}

async function makeProviderPage(provider, state) {
  const credentials = provider === 'apple-music' ? { authorization: 'Bearer fixture', 'music-user-token': 'fixture-token' }
    : provider === 'spotify' ? { authorization: 'Bearer fixture', 'client-token': 'fixture-client-token' } : {};
  const origin = provider === 'apple-music' ? 'https://music.apple.com'
    : provider === 'spotify' ? 'https://open.spotify.com'
      : provider === 'yandex-music' ? 'https://music.yandex.ru' : 'https://zvuk.com';
  const page = makePage({
    origin, script: providerScript[provider], requestHeaders: credentials,
    fetch: async (url, init = {}) => {
      const parsed = new URL(url, origin);
      const method = init.method || 'GET';
      if (provider === 'apple-music') return { status: 200, payload: appleResponse(parsed.pathname + parsed.search, method, init.body, state) };
      if (provider === 'spotify') {
        if (parsed.hostname === 'spclient.wg.spotify.com' && parsed.pathname === '/playlist/v2/playlist') {
          const request = JSON.parse(init.body || '{}');
          const title = request.ops[0].updateListAttributes.newAttributes.values.name;
          const playlist = { id: 'spotify:playlist:created', uri: 'spotify:playlist:created', title, trackIds: [] };
          state.playlists.push(playlist);
          return { status: 200, payload: { uri: playlist.uri } };
        }
        if (parsed.pathname === '/v1/me') return { status: 200, payload: { id: 'fixtureuser' } };
        if (parsed.pathname.endsWith('/rootlist/changes')) return { status: 200, payload: {} };
        return { status: 200, payload: spotifyResponse(JSON.parse(init.body || '{}'), state) };
      }
      if (provider === 'zvuk') return { status: 200, payload: zvukResponse(JSON.parse(init.body || '{}'), state) };
      return { status: 200, payload: yandexResponse(parsed.pathname + parsed.search, method, init.body, state) };
    },
  });
  if (provider === 'apple-music') await page.window.fetch('https://amp-api.music.apple.com/v1/me/storefront', { headers: credentials });
  if (provider === 'spotify') await page.window.fetch('https://api-partner.spotify.com/pathfinder/v2/query', {
    method: 'POST', headers: credentials, body: JSON.stringify({ operationName: 'fetchLibraryTracks', extensions: { persistedQuery: { sha256Hash: 'a'.repeat(64) } } }),
  });
  return page;
}

async function sendProviderTransfer(provider, page, plan) {
  const marker = provider === 'apple-music' ? 'music-importer-apple'
    : provider === 'yandex-music' ? 'music-importer-yandex'
      : provider === 'zvuk' ? 'music-importer-zvuk-target' : 'music-importer-spotify';
  const requestId = `fixture-${provider.replace(/[^a-z]/g, '')}-transfer-0001`;
  const responseType = provider === 'yandex-music' || provider === 'zvuk' ? 'command-response' : 'command-result';
  const commandType = provider === 'yandex-music' || provider === 'zvuk' ? 'execute-transfer' : 'command';
  await page.dispatch({ source: marker, type: commandType, requestId, action: 'execute-transfer', plan });
  const response = await page.waitForMessage(responseType, (message) => message.requestId === requestId);
  assert.equal(response.ok, true, response.error);
  return response;
}

function targetTrackIds(provider, snapshot) {
  return Array.from(snapshot.tracks || [], (track) => String(provider === 'apple-music' ? track.catalogId || track.id : track.id));
}

test('Apple Music source → shared transfer engine → Spotify writer verifies the imported like by read-back', async () => {
  const apple = makePage({
    origin: 'https://music.apple.com', script: '../chrome-extension/apple-main-world.js',
    requestHeaders: { authorization: 'Bearer fixture', 'music-user-token': 'fixture-token' },
    fetch: async (url) => {
      const path = new URL(url).pathname + new URL(url).search;
      const payload = path === '/v1/me/library/songs?limit=100'
        ? { meta: { total: 1 }, next: null, data: [appleRow()] }
        : path === '/v1/me/library/playlists?limit=100'
          ? { meta: { total: 0 }, next: null, data: [] }
          : {};
      return { status: 200, payload };
    },
  });
  await apple.window.fetch('https://amp-api.music.apple.com/v1/me/storefront', {
    headers: { authorization: 'Bearer fixture', 'music-user-token': 'fixture-token' },
  });
  await apple.dispatch({ source: 'music-importer-apple', type: 'start-library-scan' });
  const sourcePayload = (await apple.waitForMessage('library-snapshot')).payload;
  assert.ok(sourcePayload, 'the real Apple reader should produce a source snapshot');

  const targetUris = [];
  let writeCalls = 0;
  const spotify = makePage({
    origin: 'https://open.spotify.com', script: '../chrome-extension/spotify-main-world.js',
    requestHeaders: { authorization: 'Bearer fixture', 'client-token': 'fixture-client-token' },
    fetch: async (_url, init = {}) => {
      const payload = typeof init.body === 'string' ? JSON.parse(init.body) : {};
      const operation = payload.operationName;
      const variables = payload.variables || {};
      if (operation === 'fetchLibraryTracks') return { status: 200, payload: spotifyLibrary(targetUris) };
      if (operation === 'libraryV3') return { status: 200, payload: { data: { me: { libraryV3: { totalCount: 0, items: [] } } } } };
      if (operation === 'addToLibrary') {
        writeCalls += 1;
        targetUris.push(...variables.libraryItemUris);
        return { status: 200, payload: { data: { addToLibrary: true } } };
      }
      throw new Error(`Unexpected Spotify fixture operation: ${operation}`);
    },
  });
  await spotify.window.fetch('https://api-partner.spotify.com/pathfinder/v2/query', {
    method: 'POST', headers: { authorization: 'Bearer fixture', 'client-token': 'fixture-client-token' },
    body: JSON.stringify({ operationName: 'fetchLibraryTracks', extensions: { persistedQuery: { sha256Hash: 'a'.repeat(64) } } }),
  });

  const { core, engine } = loadTransferModules();
  const sourceSnapshot = core.createImportedSnapshot({
    provider: 'apple-music', tracks: sourcePayload.tracks,
    completeness: { confirmed: true, favoritesConfirmed: true, favoritesCount: sourcePayload.tracks.length },
  });
  const track = sourceSnapshot.collections[0].items[0].track;
  const plan = core.createTransferPlan({
    sourceSnapshot, targetProvider: 'spotify', targetCollectionType: 'library',
    tracks: [{
      ...track, selected: true, sourceCollectionType: 'favorites',
      match: { trackId: 'spotify:track:fixture1', trackName: track.title, artistName: track.artists[0], collectionName: track.album, isrc: track.isrc, trackTimeMillis: track.durationMs },
      matchReason: 'isrc', matchConfidence: 1, autoMatched: true,
    }],
  });

  async function readTargetSnapshot() {
    const priorSnapshots = spotify.messages.filter((message) => message.type === 'library-snapshot').length;
    await spotify.dispatch({ source: 'music-importer-spotify', type: 'start-library-scan' });
    return (await spotify.waitForMessage('library-snapshot', () => true, priorSnapshots + 1)).payload;
  }
  const adapter = {
    id: 'spotify',
    async readDestination() {
      const snapshot = await readTargetSnapshot();
      assert.equal(snapshot.completeness.confirmed, true);
      return { complete: true, items: snapshot.tracks.map((item) => ({ providerId: item.id })) };
    },
    async writeFavorites(items) {
      const operations = plan.operations.filter((operation) => items.some((item) => item.providerId === operation.target.providerId));
      const response = await sendWriterCommand({ ...plan, operations, collectionMappings: [] });
      assert.equal(response.ok, true, response.error);
      return { writtenCount: response.result.favorites.added };
    },
    async readBack() {
      const snapshot = await readTargetSnapshot();
      return { complete: snapshot.completeness.confirmed, items: snapshot.tracks.map((item) => ({ providerId: item.id })) };
    },
  };
  async function sendWriterCommand(writerPlan) {
    const requestId = 'fixture-transfer-0001';
    await spotify.dispatch({ source: 'music-importer-spotify', type: 'command', requestId, action: 'execute-transfer', plan: writerPlan });
    return spotify.waitForMessage('command-result', (message) => message.requestId === requestId);
  }

  const report = await engine.executeTransferPlan(adapter, plan, { confirmed: true });
  const finalTarget = await readTargetSnapshot();
  assert.equal(report.status, 'complete');
  assert.equal(report.writesPerformed, 1);
  assert.equal(report.verified, 1);
  assert.equal(writeCalls, 1, 'the real Spotify writer should make one addToLibrary mutation');
  assert.deepEqual(Array.from(finalTarget.tracks, (item) => item.id), ['spotify:track:fixture1']);
  assert.equal(finalTarget.completeness.confirmed, true, 'read-back comes from the real Spotify source reader');
});

for (const sourceProvider of providers) {
  for (const targetProvider of providers) {
    if (sourceProvider === targetProvider) continue;
    test(`synthetic fixture ${sourceProvider} → ${targetProvider} transfers favorites and an ordered repeated-track playlist in one mixed plan`, async () => {
      const sourceState = makeProviderState(sourceProvider, [fixtureIds[sourceProvider].source], true);
      const targetState = makeProviderState(targetProvider);
      const sourcePayload = await readProviderLibrary(sourceProvider, sourceState);
      assert.ok(Array.isArray(sourcePayload.playlists) && sourcePayload.playlists.length === 1, 'source reader returns one complete playlist');
      assert.equal(sourcePayload.tracks.length, 1, 'source reader returns a favorite through its provider reader');
      assert.equal(sourcePayload.completeness.favoritesConfirmed, true, 'source reader confirms favorite completeness');
      assert.deepEqual(Array.from(sourcePayload.playlists[0].tracks, (track) => track.position), [0, 1]);
      const { core, engine } = loadTransferModules();
      const sourcePlaylist = sourcePayload.playlists[0];
      const favoriteTracks = sourcePayload.tracks.map((track) => ({
        ...track, sourceCollectionType: 'favorites',
      }));
      const playlistTracks = sourcePlaylist.tracks.map((track, position) => ({
        ...track,
        sourceCollectionType: 'playlists', sourceCollectionId: sourcePlaylist.id,
        sourceCollectionName: sourcePlaylist.title || sourcePlaylist.name, sourcePosition: position,
      }));
      const sourceSnapshot = core.createImportedSnapshot({
        provider: sourceProvider,
        collectionType: 'library', playlists: sourcePayload.playlists, tracks: [...favoriteTracks, ...playlistTracks],
        completeness: { confirmed: true, favoritesConfirmed: true, favoritesCount: favoriteTracks.length },
      });
      assert.equal(sourceSnapshot.collections.find((collection) => collection.type === 'favorites')?.completeness.confirmed, true,
        `${sourceProvider} reader must confirm the favorites collection`);
      assert.equal(sourceSnapshot.collections.find((collection) => collection.type === 'playlists')?.completeness.confirmed, true,
        `${sourceProvider} reader must confirm the playlist collection`);
      const targetId = fixtureIds[targetProvider].target;
      const plan = core.createTransferPlan({
        sourceSnapshot, targetProvider, targetCollectionType: 'library',
        tracks: sourceSnapshot.collections.flatMap((collection) => collection.items.map(({ track, position }) => ({
          ...track, selected: true,
          sourceCollectionType: collection.type,
          sourceCollectionId: collection.type === 'playlists' ? collection.id || undefined : undefined,
          sourceCollectionName: collection.type === 'playlists' ? collection.name : undefined,
          sourcePosition: position,
          match: { trackId: targetId, albumId: 'target-album', trackName: fixtureTrack.title, artistName: fixtureTrack.artists[0], collectionName: fixtureTrack.album, isrc: fixtureTrack.isrc, trackTimeMillis: fixtureTrack.durationMs },
          matchReason: 'isrc', matchConfidence: 1, autoMatched: true,
        }))),
      });
      assert.equal(plan.target.collectionType, 'library', 'the single plan must include both collection types');
      assert.equal(plan.operations.filter((operation) => operation.operation === 'add_to_favorites').length, 1);
      assert.equal(plan.operations.filter((operation) => operation.operation === 'add_to_playlist').length, 2);
      assert.equal(plan.collectionMappings.length, 1, 'favorites must not be treated as a playlist mapping');
      const targetWriter = await makeProviderPage(targetProvider, targetState);

      async function readTarget() {
        return readProviderLibrary(targetProvider, targetState);
      }
      let realWriterInvoked = false;
      const adapter = {
        id: targetProvider,
        async readDestination({ collectionType }) {
          const snapshot = await readTarget();
          assert.equal(snapshot.completeness.confirmed, true, `${targetProvider} target reader confirms the initial destination`);
          return { complete: true, items: collectionType === 'favorites'
              ? targetTrackIds(targetProvider, snapshot).map((providerId) => ({ providerId }))
              : (snapshot.playlists || []).map((playlist) => ({ providerId: playlist.id, name: playlist.title, trackCount: playlist.trackCount })) };
        },
        async writeFavorites(items) {
          assert.equal(realWriterInvoked, false, 'the mixed fixture plan is sent once to the actual provider writer');
          realWriterInvoked = true;
          assert.equal(items.length, 1);
          const response = await sendProviderTransfer(targetProvider, targetWriter, plan);
          const writerReport = response.result || response.report;
          assert.equal(writerReport.status, 'complete', `${targetProvider} writer completes favorites and playlist writes`);
          assert.equal(writerReport.favorites.verified, 1, `${targetProvider} writer verifies the favorite`);
          assert.equal(writerReport.playlists[0].verified, 2, `${targetProvider} writer verifies repeated playlist items`);
          return { writtenCount: items.length };
        },
        async createPlaylist() {
          // The shared engine needs a destination handle; the provider MAIN-world writer
          // creates the real fixture playlist when it receives the full plan below.
          return { id: 'engine-writer-dispatch' };
        },
        async writePlaylistItems(_playlistId, items) {
          assert.equal(realWriterInvoked, true, 'actual target writer already received the complete mixed plan');
          return { writtenCount: items.length };
        },
        async readBack({ type, playlistId, operations }) {
          const snapshot = await readTarget();
          if (type === 'favorites') {
            const ids = targetTrackIds(targetProvider, snapshot);
            return { complete: snapshot.completeness.confirmed, items: ids.map((providerId) => ({ providerId })) };
          }
          const playlist = (snapshot.playlists || []).find((item) => item.title === 'Ordered Fixture');
          const ids = playlist ? targetTrackIds(targetProvider, { tracks: playlist.tracks }) : [];
          return {
            complete: snapshot.completeness.confirmed, collectionPresent: Boolean(playlist),
            verifiedCount: ids.length, expectedCount: operations.length,
            items: ids.map((providerId) => ({ providerId })),
          };
        },
      };

      const report = await engine.executeTransferPlan(adapter, plan, { confirmed: true });
      const finalTarget = await readTarget();
      const playlist = finalTarget.playlists.find((item) => item.title === 'Ordered Fixture');
      assert.equal(report.status, 'complete');
      assert.equal(report.writesPerformed, 3);
      assert.equal(report.verified, 3);
      assert.equal(report.collectionsVerified, 1);
      assert.equal(realWriterInvoked, true);
      assert.deepEqual(targetTrackIds(targetProvider, finalTarget), [targetId], `${targetProvider} reader confirms the imported like`);
      assert.deepEqual(targetTrackIds(targetProvider, { tracks: playlist.tracks }), [targetId, targetId]);
      assert.equal(finalTarget.completeness.confirmed, true, 'final evidence comes from the target provider reader fixture');
    });
  }
}
