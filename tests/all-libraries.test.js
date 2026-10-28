const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const PROVIDER_KEY = 'providerLibraryBridge';
const ZVUK_KEY = 'zvukFavoriteCapture';

function makeProviderPayload(service, count = 1) {
  const tracks = Array.from({ length: count }, (_, index) => ({ id: `${service}-${index}`, title: `Track ${index}`, artist: 'Artist' }));
  return {
    service,
    collection: { type: 'library', name: 'Library' },
    completeness: {
      confirmed: true, favoritesConfirmed: true, favoritesCount: count,
      catalogConfirmed: true, playlistItemsConfirmed: true, playlistItemsTotal: 0,
      ...(service === 'apple-music' ? { librarySongsConfirmed: true } : {}),
      ...(service === 'yandex-music' ? { playlistCatalogKindsConfirmed: true } : {}),
    },
    tracks,
    playlists: [],
  };
}

function bootWorker(storageState, tabs = []) {
  const messages = [];
  const updates = [];
  const portMessages = [];
  const createdTabs = [];
  let runtimeListener;
  let connectListener;
  let actionListener;
  const chrome = {
    runtime: {
      id: 'fixture-extension',
      getURL(path) { return `chrome-extension://fixture-extension/${path}`; },
      onMessage: { addListener(listener) { runtimeListener = listener; } },
      onConnect: { addListener(listener) { connectListener = listener; } },
    },
    action: { onClicked: { addListener(listener) { actionListener = listener; } } },
    storage: { local: {
      setAccessLevel: async () => {},
      async get(key) { return { [key]: storageState[key] }; },
      async set(value) { Object.assign(storageState, value); },
    } },
    tabs: {
      async query(query) {
        if (!query.url) return tabs;
        const patterns = Array.isArray(query.url) ? query.url : [query.url];
        return tabs.filter((tab) => patterns.some((pattern) => {
          const expression = new RegExp(`^${String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`);
          return expression.test(tab.url);
        }));
      },
      async get(tabId) { return tabs.find((tab) => tab.id === tabId) || null; },
      async update(tabId, update) {
        updates.push({ tabId, update });
        const tab = tabs.find((candidate) => candidate.id === tabId);
        if (tab && update.url) tab.url = update.url;
      },
      async create(createProperties) { createdTabs.push(createProperties); return { id: 99, ...createProperties }; },
      async sendMessage(tabId, message) { messages.push({ tabId, message }); return { ok: true }; },
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../chrome-extension/service-worker.js'), 'utf8'), {
    chrome, URL, Date, Number, String, Array, Promise, Set, Map, Object, Error, JSON, RegExp, Math,
  });
  return {
    messages,
    updates,
    createdTabs,
    clickAction() { return actionListener(); },
    call(message) {
      return this.callFrom(message, 'http://127.0.0.1:8001/');
    },
    callFrom(message, url) {
      return new Promise((resolve) => {
        const keptOpen = runtimeListener(message, { id: 'fixture-extension', url }, resolve);
        assert.equal(keptOpen, true);
      });
    },
    pageMessage(message, tabId) {
      const tab = tabs.find((candidate) => candidate.id === tabId);
      assert.ok(tab, `Expected fixture tab ${tabId}`);
      return new Promise((resolve) => {
        runtimeListener(message, { id: 'fixture-extension', tab, url: tab.url }, resolve);
      });
    },
    connectApp(url = 'chrome-extension://fixture-extension/app/index.html') {
      const port = {
        name: 'music-importer-app',
        sender: { id: 'fixture-extension', url },
        onDisconnect: { addListener(listener) { port.onDisconnectListener = listener; } },
        postMessage(message) { portMessages.push(message); },
        disconnect() { port.disconnected = true; },
      };
      connectListener(port);
      return port;
    },
    portMessages,
  };
}

function makeZvukState(complete = false) {
  return {
    scan: { active: complete, phase: complete ? 'complete' : 'idle', tabId: 1 },
    tracks: complete ? [{ id: 'zvuk-1', title: 'Track', artist: 'Artist' }] : [],
    expectedCount: complete ? 1 : null,
    hasMore: complete ? false : null,
    favoritesScanFinished: complete,
    playlistListHasMore: complete ? false : null,
    expectedPlaylistCount: complete ? 0 : null,
    playlists: [],
    captureEnabled: false,
  };
}

test('one-click library scan starts readers in every open provider tab', async () => {
  const tabs = [
    { id: 1, url: 'https://zvuk.com/favorites' },
    { id: 2, url: 'https://open.spotify.com/collection/tracks' },
    { id: 3, url: 'https://music.yandex.ru/users/me/playlists' },
    { id: 4, url: 'https://music.apple.com/us/library' },
  ];
  const app = bootWorker({ [ZVUK_KEY]: makeZvukState() }, tabs);
  const response = await app.call({ type: 'music-importer:get-all-libraries', refresh: true });
  assert.equal(response.pending, true);
  assert.deepEqual(Object.keys(response.statuses).sort(), ['apple-music', 'spotify', 'yandex-music', 'zvuk']);
  assert.ok(Object.values(response.statuses).every((status) => status.status === 'scanning'));
  assert.deepEqual(app.messages.map((entry) => entry.message.type).sort(), [
    'apple:start-library-scan', 'spotify:start-library-scan', 'yandex:start-library-scan',
  ]);
  assert.ok(app.updates.some((entry) => entry.tabId === 1 && entry.update.url.includes('/favorites?music_importer_capture=1')));
});

test('extension-hosted app can start a library scan without localhost origin permission', async () => {
  const tabs = [{ id: 4, url: 'https://music.apple.com/us/library' }];
  const app = bootWorker({ [ZVUK_KEY]: makeZvukState() }, tabs);
  const response = await app.callFrom({ type: 'music-importer:get-all-libraries', refresh: true }, 'chrome-extension://fixture-extension/app/index.html');
  assert.equal(response.pending, true);
  assert.equal(response.statuses['apple-music'].status, 'scanning');
  assert.ok(app.messages.some(({ tabId, message }) => tabId === 4 && message.type === 'apple:start-library-scan'));
});

test('extension-hosted app can send a catalog command to a signed-in service tab', async () => {
  const tabs = [{ id: 4, url: 'https://music.apple.com/us/library' }];
  const app = bootWorker({ [ZVUK_KEY]: makeZvukState() }, tabs);
  const response = await app.callFrom({
    type: 'music-importer:apple-command',
    requestId: 'fixture-request-0001',
    action: 'search-tracks',
    query: 'isrc:USABC1234567',
    storefront: 'AE',
  }, 'chrome-extension://fixture-extension/app/index.html');
  assert.equal(response.ok, true);
  assert.ok(app.messages.some(({ tabId, message }) => tabId === 4 && message.type === 'apple:command'));
});

test('extension app receives transfer progress through its private runtime port', async () => {
  const tabs = [{ id: 4, url: 'https://music.apple.com/us/library' }];
  const app = bootWorker({ [ZVUK_KEY]: makeZvukState() }, tabs);
  app.connectApp();
  await app.pageMessage({ type: 'apple:transfer-progress', requestId: 'fixture-request-0001', progress: { message: 'Проверяем запись' } }, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(app.portMessages)), [{
    type: 'transfer-progress',
    provider: 'apple',
    requestId: 'fixture-request-0001',
    progress: { message: 'Проверяем запись' },
  }]);
});

test('extension worker rejects app commands from unrelated extension pages', async () => {
  const app = bootWorker({ [ZVUK_KEY]: makeZvukState() });
  const response = await app.callFrom({ type: 'music-importer:get-all-libraries', refresh: true }, 'chrome-extension://fixture-extension/popup.html');
  assert.match(response.error, /только локальному приложению/i);
});

test('extension worker only accepts the project GitHub Pages app paths', async () => {
  const app = bootWorker({ [ZVUK_KEY]: makeZvukState() });
  const response = await app.callFrom({ type: 'music-importer:get-all-libraries', refresh: true }, 'https://basil-as.github.io/another-project/');
  assert.match(response.error, /только локальному приложению/i);
});

test('clicking the extension icon opens its full app page', async () => {
  const app = bootWorker({ [ZVUK_KEY]: makeZvukState() });
  await app.clickAction();
  assert.deepEqual(JSON.parse(JSON.stringify(app.createdTabs)), [{ url: 'chrome-extension://fixture-extension/app/index.html' }]);
});

test('one-click library scan returns all complete snapshots and marks missing sessions', async () => {
  const storage = {
    [ZVUK_KEY]: makeZvukState(true),
    [PROVIDER_KEY]: {
      snapshots: {
        spotify: makeProviderPayload('spotify', 3),
        'apple-music': makeProviderPayload('apple-music', 2),
      },
      scans: { spotify: { status: 'complete' }, 'apple-music': { status: 'complete' } },
    },
  };
  const app = bootWorker(storage);
  const response = await app.call({ type: 'music-importer:get-all-libraries', refresh: false });
  assert.equal(response.pending, false);
  assert.deepEqual(Object.keys(response.libraries).sort(), ['apple-music', 'spotify', 'zvuk']);
  assert.equal(response.statuses.spotify.status, 'ready');
  assert.equal(response.statuses.zvuk.status, 'ready');
  assert.equal(response.statuses['yandex-music'].status, 'unavailable');
  assert.equal(response.libraries.spotify.tracks.length, 3);
});

test('Zvuk account scan crawls favorites, playlist catalog, and playlist pages into one confirmed snapshot', async () => {
  const tabs = [{ id: 1, url: 'https://zvuk.com/favorites' }];
  const storage = { [ZVUK_KEY]: makeZvukState() };
  const app = bootWorker(storage, tabs);
  const started = await app.call({ type: 'music-importer:get-all-libraries', refresh: true });
  assert.equal(started.pending, true);
  assert.ok(app.updates.some((entry) => entry.tabId === 1 && entry.update.url === 'https://zvuk.com/favorites?music_importer_capture=1'));

  assert.equal((await app.pageMessage({ type: 'zvuk:collection-count', uniqueTrackCount: 1, uniquePlaylistCount: 2 }, 1)).ok, true);
  await app.pageMessage({ type: 'zvuk:favorite-page', tracks: [{ id: 'like-1', title: 'Liked', artists: [{ title: 'Artist' }] }], hasMore: false }, 1);
  await app.pageMessage({ type: 'zvuk:favorites-scroll-end' }, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(storage[ZVUK_KEY].scan.phase, 'playlists', JSON.stringify(storage[ZVUK_KEY]));
  assert.ok(app.updates.some((entry) => entry.tabId === 1 && entry.update.url === 'https://zvuk.com/collection?music_importer_capture=1'), JSON.stringify(app.updates));

  await app.pageMessage({
    type: 'zvuk:playlist-list-page', hasMore: false,
    playlists: [{ id: 'road', title: 'Road', trackCount: 2 }, { id: 'empty', title: 'Empty', trackCount: 0 }],
  }, 1);
  await app.pageMessage({ type: 'zvuk:collection-scroll-end' }, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(app.updates.some((entry) => entry.tabId === 1 && entry.update.url === 'https://zvuk.com/playlist/road?music_importer_capture=1'));

  await app.pageMessage({
    type: 'zvuk:playlist-track-page', playlistId: 'road', offset: 0, limit: 100,
    tracks: [
      { id: 'road-1', title: 'First', artists: [{ title: 'Artist' }] },
      { id: 'road-2', title: 'Second', artists: [{ title: 'Artist' }] },
    ],
  }, 1);
  await new Promise((resolve) => setImmediate(resolve));

  const completed = await app.call({ type: 'music-importer:get-library', provider: 'zvuk' });
  assert.equal(completed.payload.completeness.confirmed, true);
  assert.deepEqual(Array.from(completed.payload.tracks, (track) => track.id), ['like-1']);
  assert.deepEqual(Array.from(completed.payload.playlists, (playlist) => [playlist.id, playlist.title, playlist.complete]), [
    ['road', 'Road', true], ['empty', 'Empty', true],
  ]);
  assert.deepEqual(Array.from(completed.payload.playlists[0].tracks, (track) => [track.id, track.position]), [
    ['road-1', 0], ['road-2', 1],
  ]);
  assert.deepEqual(Array.from(completed.payload.playlists[1].tracks), []);
});

test('Zvuk account scan refuses a favorites total mismatch', async () => {
  const tabs = [{ id: 1, url: 'https://zvuk.com/favorites' }];
  const storage = { [ZVUK_KEY]: makeZvukState() };
  const app = bootWorker(storage, tabs);
  await app.call({ type: 'music-importer:get-all-libraries', refresh: true });
  await app.pageMessage({ type: 'zvuk:collection-count', uniqueTrackCount: 2, uniquePlaylistCount: 0 }, 1);
  await app.pageMessage({ type: 'zvuk:favorite-page', tracks: [{ id: 'like-1', title: 'Liked' }], hasMore: false }, 1);
  await app.pageMessage({ type: 'zvuk:favorites-scroll-end' }, 1);

  assert.equal(storage[ZVUK_KEY].scan.phase, 'needs_review');
  assert.match(storage[ZVUK_KEY].scan.error, /число избранных не совпало/i);
  assert.equal(storage[ZVUK_KEY].captureEnabled, false);
  assert.ok(!app.updates.some((entry) => entry.update.url === 'https://zvuk.com/collection?music_importer_capture=1'));
});
