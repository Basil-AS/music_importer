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

function bootWorker(storageState, tabs = [], options = {}) {
  const messages = [];
  const updates = [];
  const reloads = [];
  const reloadedTabs = new Set();
  const tabUpdatedListeners = new Set();
  const portMessages = [];
  const createdTabs = [];
  let runtimeListener;
  let installedListener;
  let startupListener;
  let connectListener;
  let actionListener;
  const chrome = {
    runtime: {
      id: 'fixture-extension',
      getURL(path) { return `chrome-extension://fixture-extension/${path}`; },
      onMessage: { addListener(listener) { runtimeListener = listener; } },
      onInstalled: { addListener(listener) { installedListener = listener; } },
      onStartup: { addListener(listener) { startupListener = listener; } },
      onConnect: { addListener(listener) { connectListener = listener; } },
    },
    action: { onClicked: { addListener(listener) { actionListener = listener; } } },
    storage: { local: {
      setAccessLevel: async () => {},
      async get(key) {
        const value = storageState[key];
        return { [key]: options.cloneStorageReads ? structuredClone(value) : value };
      },
      async set(value) { Object.assign(storageState, value); },
      async remove(keys) { for (const key of keys) delete storageState[key]; },
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
      onUpdated: {
        addListener(listener) { tabUpdatedListeners.add(listener); },
        removeListener(listener) { tabUpdatedListeners.delete(listener); },
      },
      async reload(tabId) {
        reloads.push(tabId);
        const tab = tabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error('No such tab');
        tab.status = 'loading';
        for (const listener of tabUpdatedListeners) listener(tabId, { status: 'loading' }, tab);
        tab.status = 'complete';
        for (const listener of tabUpdatedListeners) listener(tabId, { status: 'complete' }, tab);
        reloadedTabs.add(tabId);
      },
      async create(createProperties) {
        createdTabs.push(createProperties);
        const tab = { id: 99 + createdTabs.length, ...createProperties };
        tabs.push(tab);
        return tab;
      },
      async sendMessage(tabId, message) {
        messages.push({ tabId, message });
        if (message.type === 'music-importer:bridge-health-check'
          && options.healthFailureTabIds?.includes(tabId) && !reloadedTabs.has(tabId)) {
          throw new Error('Receiving end does not exist');
        }
        if (options.missingReceiverOnce?.includes(tabId) && !reloadedTabs.has(tabId)) throw new Error('Receiving end does not exist');
        if (message.type === 'music-importer:bridge-health-check') {
          return { ok: true, bridgeProtocol: options.oldBridgeTabIds?.includes(tabId) && !reloadedTabs.has(tabId) ? 2 : 3 };
        }
        return { ok: true };
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../chrome-extension/service-worker.js'), 'utf8'), {
    chrome, URL, Date, Number, String, Array, Promise, Set, Map, Object, Error, JSON, RegExp, Math, setTimeout, clearTimeout,
  });
  return {
    messages,
    updates,
    reloads,
    createdTabs,
    storageState,
    tabs,
    clickAction(tab) { return actionListener(tab); },
    install(reason = 'install') { return installedListener({ reason }); },
    startup() { return startupListener(); },
    completeTab(tabId) {
      const tab = tabs.find((candidate) => candidate.id === tabId);
      assert.ok(tab, `Expected fixture tab ${tabId}`);
      tab.status = 'complete';
      for (const listener of tabUpdatedListeners) listener(tabId, { status: 'complete' }, tab);
    },
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
        onMessage: { addListener(listener) { port.onMessageListener = listener; } },
        postMessage(message) {
          portMessages.push(message);
          if (message.checkpointAckId && options.autoAckCheckpoints !== false) {
            queueMicrotask(() => port.onMessageListener?.({
              type: 'transfer-progress-ack', checkpointAckId: message.checkpointAckId, ok: true,
            }));
          }
        },
        acknowledge(message) { port.onMessageListener?.(message); },
        disconnect() { port.disconnected = true; },
      };
      connectListener(port);
      return port;
    },
    portMessages,
  };
}

test('first install opens the extension-hosted importer automatically', async () => {
  const worker = bootWorker({});
  await worker.install('install');
  assert.equal(worker.createdTabs.length, 1);
  assert.equal(worker.createdTabs[0].url, 'chrome-extension://fixture-extension/app/index.html');
});

test('first install repairs already-open provider tabs without a current bridge', async () => {
  const worker = bootWorker({}, [
    { id: 40, url: 'https://music.apple.com/us/home', status: 'complete' },
  ], { healthFailureTabIds: [40] });
  await worker.install('install');
  assert.deepEqual(worker.reloads, [40]);
  assert.ok(worker.messages.some(({ tabId, message }) => tabId === 40 && message.type === 'music-importer:bridge-health-check'));
});

test('extension update opens the importer app when it is not already open', async () => {
  const worker = bootWorker({});
  await worker.install('update');
  assert.deepEqual(JSON.parse(JSON.stringify(worker.createdTabs)), [{ url: 'chrome-extension://fixture-extension/app/index.html' }]);
});

test('extension update reloads provider tabs with an old bridge protocol', async () => {
  const worker = bootWorker({}, [
    { id: 41, url: 'https://music.apple.com/us/home', status: 'complete' },
    { id: 42, url: 'https://open.spotify.com/collection/tracks', status: 'complete' },
  ], { oldBridgeTabIds: [41] });
  await worker.install('update');
  assert.deepEqual(worker.reloads, [41]);
  assert.ok(worker.messages.some(({ tabId, message }) => tabId === 41 && message.type === 'music-importer:bridge-health-check'));
  assert.ok(worker.messages.some(({ tabId, message }) => tabId === 42 && message.type === 'music-importer:bridge-health-check'));
});

test('browser startup reloads only provider tabs with a stale bridge protocol', async () => {
  const worker = bootWorker({}, [
    { id: 51, url: 'https://music.apple.com/us/home', status: 'complete' },
    { id: 52, url: 'https://open.spotify.com/collection/tracks', status: 'complete' },
  ], { oldBridgeTabIds: [51] });
  await worker.startup();
  assert.deepEqual(worker.reloads, [51]);
  assert.ok(worker.messages.some(({ tabId, message }) => tabId === 51 && message.type === 'music-importer:bridge-health-check'));
  assert.ok(worker.messages.some(({ tabId, message }) => tabId === 52 && message.type === 'music-importer:bridge-health-check'));
});

test('opening the importer app repairs stale provider bridges before scanning', async () => {
  const worker = bootWorker({}, [
    { id: 53, url: 'https://music.apple.com/us/home', status: 'complete' },
    { id: 54, url: 'https://open.spotify.com/collection/tracks', status: 'complete' },
  ], { oldBridgeTabIds: [53] });
  const response = await worker.callFrom(
    { type: 'music-importer:repair-provider-bridges' },
    'chrome-extension://fixture-extension/app/index.html',
  );
  assert.deepEqual(JSON.parse(JSON.stringify(response)), { ok: true, checked: 2, repaired: 1, failed: 0 });
  assert.deepEqual(worker.reloads, [53]);
});

test('library scan waits for a newly opened provider tab to finish loading before bridge health checks', async () => {
  const worker = bootWorker({}, [
    { id: 55, url: 'https://music.apple.com/us/home', status: 'loading' },
  ]);
  const pending = worker.callFrom(
    { type: 'music-importer:get-all-libraries', requestId: 'loading-tab-scan-123456', refresh: true, refreshProviders: ['apple-music'] },
    'chrome-extension://fixture-extension/app/index.html',
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.messages.some(({ tabId, message }) => tabId === 55 && message.type === 'music-importer:bridge-health-check'), false);
  worker.completeTab(55);
  await pending;
  assert.equal(worker.messages.some(({ tabId, message }) => tabId === 55 && message.type === 'music-importer:bridge-health-check'), true);
  assert.deepEqual(worker.reloads, []);
});

test('extension update focuses the existing importer app without creating another tab', async () => {
  const existingApp = { id: 18, url: 'chrome-extension://fixture-extension/app/index.html' };
  const worker = bootWorker({}, [existingApp]);
  await worker.install('update');
  assert.deepEqual(worker.createdTabs, []);
  assert.deepEqual(JSON.parse(JSON.stringify(worker.updates)), [{ tabId: 18, update: { active: true } }]);
});

test('extension icon opens the importer app when the localhost app is active', async () => {
  const worker = bootWorker({}, [{ id: 7, url: 'http://127.0.0.1:8001/', active: true }]);
  await worker.clickAction({ id: 7, url: 'http://127.0.0.1:8001/' });
  assert.deepEqual(JSON.parse(JSON.stringify(worker.createdTabs)), [
    { url: 'chrome-extension://fixture-extension/app/index.html' },
  ]);
});

test('extension icon opens the importer app when a provider page is active', async () => {
  const worker = bootWorker({}, [{ id: 7, url: 'https://music.apple.com/us/library' }]);
  await worker.clickAction({ id: 7, url: 'https://music.apple.com/us/library' });
  assert.deepEqual(JSON.parse(JSON.stringify(worker.createdTabs)), [
    { url: 'chrome-extension://fixture-extension/app/index.html' },
  ]);
});

test('onboarding opens only missing provider tabs from the extension app', async () => {
  const tabs = [{ id: 7, url: 'https://music.apple.com/library' }];
  const app = bootWorker({}, tabs);
  const response = await app.callFrom(
    { type: 'music-importer:open-provider-tabs' },
    'chrome-extension://fixture-extension/app/index.html',
  );

  assert.deepEqual(JSON.parse(JSON.stringify(response.opened)), ['zvuk', 'spotify', 'yandex-music']);
  assert.deepEqual(JSON.parse(JSON.stringify(response.alreadyOpen)), ['apple-music']);
  assert.deepEqual(JSON.parse(JSON.stringify(app.createdTabs)), [
    { url: 'https://zvuk.com/favorites', active: true },
    { url: 'https://open.spotify.com/collection/tracks', active: false },
    { url: 'https://music.yandex.ru/home', active: false },
  ]);
});

test('onboarding opens only the selected source and target service tabs', async () => {
  const tabs = [{ id: 7, url: 'https://music.apple.com/library' }];
  const app = bootWorker({}, tabs);
  const response = await app.callFrom(
    { type: 'music-importer:open-provider-tabs', providerIds: ['apple-music', 'spotify'] },
    'chrome-extension://fixture-extension/app/index.html',
  );

  assert.deepEqual(JSON.parse(JSON.stringify(response.opened)), ['spotify']);
  assert.deepEqual(JSON.parse(JSON.stringify(response.alreadyOpen)), ['apple-music']);
  assert.deepEqual(JSON.parse(JSON.stringify(app.createdTabs)), [
    { url: 'https://open.spotify.com/collection/tracks', active: true },
  ]);
});

test('automatic library scan opens missing provider pages in the background', async () => {
  const app = bootWorker({ [ZVUK_KEY]: makeZvukState() });
  const response = await app.call({ type: 'music-importer:get-all-libraries', refresh: true });
  assert.equal(response.pending, true);
  assert.deepEqual(JSON.parse(JSON.stringify(app.createdTabs)), [
    { url: 'https://zvuk.com/favorites', active: false },
    { url: 'https://open.spotify.com/collection/tracks', active: false },
    { url: 'https://music.yandex.ru/home', active: false },
    { url: 'https://music.apple.com/library', active: false },
  ]);
  assert.equal(app.tabs.length, 4);
});

test('login action focuses the existing background service tab', async () => {
  const app = bootWorker({}, [{ id: 72, url: 'https://music.apple.com/us/home', active: false }]);
  const response = await app.callFrom({
    type: 'music-importer:open-provider-tabs',
    providerIds: ['apple-music'],
    focusProviderId: 'apple-music',
  }, 'chrome-extension://fixture-extension/app/index.html');
  assert.equal(response.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(app.updates)), [{ tabId: 72, update: { active: true } }]);
  assert.deepEqual(JSON.parse(JSON.stringify(response.alreadyOpen)), ['apple-music']);
});

test('login action rejects a focus target outside the requested providers', async () => {
  const app = bootWorker({});
  const response = await app.callFrom({
    type: 'music-importer:open-provider-tabs',
    providerIds: ['apple-music'],
    focusProviderId: 'spotify',
  }, 'chrome-extension://fixture-extension/app/index.html');
  assert.equal(response.ok, false);
  assert.deepEqual(app.createdTabs, []);
});

test('onboarding rejects unknown provider IDs instead of opening every service', async () => {
  const app = bootWorker({});
  const response = await app.callFrom(
    { type: 'music-importer:open-provider-tabs', providerIds: ['unknown'] },
    'chrome-extension://fixture-extension/app/index.html',
  );

  assert.equal(response.ok, false);
  assert.match(response.error, /поддерживаемых сервисов/i);
  assert.deepEqual(JSON.parse(JSON.stringify(app.createdTabs)), []);
});

test('onboarding rejects provider-tab requests from unrelated extension pages', async () => {
  const app = bootWorker({});
  const response = await app.callFrom(
    { type: 'music-importer:open-provider-tabs' },
    'chrome-extension://fixture-extension/popup.html',
  );
  assert.equal(response.ok, false);
  assert.match(response.error, /только приложению Music Importer/i);
  assert.deepEqual(JSON.parse(JSON.stringify(app.createdTabs)), []);
});

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

test('Zvuk reader error is shown with safe operation and HTTP status metadata', async () => {
  const storage = { [ZVUK_KEY]: { ...makeZvukState(), captureEnabled: true, scan: { active: true, phase: 'catalog', tabId: 1 } } };
  const worker = bootWorker(storage, [{ id: 1, url: 'https://zvuk.com/collection', status: 'complete' }]);
  await worker.pageMessage({
    type: 'zvuk:read-error', operation: 'getPaginatedCollectionAll', httpStatus: 401, graphqlError: true,
    authorization: 'must-not-be-displayed',
  }, 1);
  assert.match(storage[ZVUK_KEY].error, /getPaginatedCollectionAll.*HTTP 401/);
  assert.ok(!storage[ZVUK_KEY].error.includes('must-not-be-displayed'));
  assert.equal(storage[ZVUK_KEY].captureEnabled, false);
});

test('Zvuk pagination stall is not mislabeled as a rejected HTTP response', async () => {
  const storage = { [ZVUK_KEY]: { ...makeZvukState(), captureEnabled: true, scan: { active: true, phase: 'catalog', tabId: 1 } } };
  const worker = bootWorker(storage, [{ id: 1, url: 'https://zvuk.com/collection', status: 'complete' }]);
  await worker.pageMessage({ type: 'zvuk:collection-scroll-stall', reason: 'pagination-stalled' }, 1);
  assert.match(storage[ZVUK_KEY].error, /остановилась до следующей страницы/);
  assert.ok(!storage[ZVUK_KEY].error.includes('HTTP 200'));
});

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
  assert.deepEqual(app.messages.map((entry) => entry.message.type).filter((type) => type !== 'music-importer:bridge-health-check').sort(), [
    'apple:start-library-scan', 'spotify:start-library-scan', 'yandex:start-library-scan',
  ]);
  assert.ok(app.updates.some((entry) => entry.tabId === 1 && entry.update.url.includes('/favorites?music_importer_capture=1')));
});

test('extension app can clear saved account snapshots without touching music accounts', async () => {
  const storageState = {
    [PROVIDER_KEY]: { snapshots: { spotify: makeProviderPayload('spotify') }, scans: { spotify: { status: 'complete' } }, previousSnapshots: {} },
    [ZVUK_KEY]: makeZvukState(),
  };
  const app = bootWorker(storageState);
  const response = await app.callFrom({ type: 'music-importer:clear-library-snapshots' }, 'chrome-extension://fixture-extension/app/index.html');
  assert.equal(response.ok, true);
  assert.equal(app.storageState[PROVIDER_KEY], undefined);
  assert.equal(app.storageState[ZVUK_KEY], undefined);
});

test('snapshot clear is restricted to the app and refused during active scans', async () => {
  const unauthorized = bootWorker({ [PROVIDER_KEY]: { snapshots: {}, scans: {}, previousSnapshots: {} } });
  const rejected = await unauthorized.callFrom({ type: 'music-importer:clear-library-snapshots' }, 'https://example.com/');
  assert.equal(rejected.ok, false);
  assert.ok(unauthorized.storageState[PROVIDER_KEY]);

  const scanning = bootWorker({ [PROVIDER_KEY]: { snapshots: {}, scans: { spotify: { status: 'reading' } }, previousSnapshots: {} } });
  const blocked = await scanning.callFrom({ type: 'music-importer:clear-library-snapshots' }, 'chrome-extension://fixture-extension/app/index.html');
  assert.match(blocked.error, /сбор/i);
  assert.ok(scanning.storageState[PROVIDER_KEY]);
});

test('selective library refresh rescans only the requested provider', async () => {
  const tabs = [
    { id: 1, url: 'https://zvuk.com/favorites' },
    { id: 2, url: 'https://open.spotify.com/collection/tracks' },
    { id: 3, url: 'https://music.yandex.ru/users/me/playlists' },
    { id: 4, url: 'https://music.apple.com/us/library' },
  ];
  const app = bootWorker({ [ZVUK_KEY]: makeZvukState() }, tabs);
  const response = await app.callFrom({
    type: 'music-importer:get-all-libraries',
    refresh: true,
    refreshProviders: ['apple-music'],
  }, 'chrome-extension://fixture-extension/app/index.html');

  assert.equal(response.pending, true);
  assert.equal(response.statuses['apple-music'].status, 'scanning');
  assert.deepEqual(app.messages.map((entry) => entry.message.type).filter((type) => type !== 'music-importer:bridge-health-check'), ['apple:start-library-scan']);
  assert.ok(!app.updates.some((entry) => entry.update.url?.includes('/favorites?music_importer_capture=1')));
});

test('concurrent provider snapshots merge instead of overwriting each other', async () => {
  const tabs = [
    { id: 1, url: 'https://open.spotify.com/collection/tracks' },
    { id: 2, url: 'https://music.yandex.ru/users/me/playlists' },
    { id: 3, url: 'https://music.apple.com/us/library' },
  ];
  const app = bootWorker({}, tabs, { cloneStorageReads: true });

  await Promise.all([
    app.pageMessage({ type: 'spotify:library-snapshot', payload: makeProviderPayload('spotify') }, 1),
    app.pageMessage({ type: 'yandex:library-snapshot', payload: makeProviderPayload('yandex-music') }, 2),
    app.pageMessage({ type: 'apple:library-snapshot', payload: makeProviderPayload('apple-music') }, 3),
  ]);

  assert.deepEqual(Object.keys(app.storageState[PROVIDER_KEY].snapshots).sort(), ['apple-music', 'spotify', 'yandex-music']);
  assert.deepEqual(Object.keys(app.storageState[PROVIDER_KEY].scans).sort(), ['apple-music', 'spotify', 'yandex-music']);
  assert.ok(Object.values(app.storageState[PROVIDER_KEY].scans).every((scan) => scan.status === 'complete'));
});

test('concurrent Zvuk favorite page and independent count preserve both updates', async () => {
  const tabs = [{ id: 1, url: 'https://zvuk.com/favorites?music_importer_capture=1' }];
  const app = bootWorker({
    [ZVUK_KEY]: {
      ...makeZvukState(),
      scan: { active: true, phase: 'favorites', tabId: 1 },
      captureEnabled: true,
    },
  }, tabs, { cloneStorageReads: true });

  await Promise.all([
    app.pageMessage({ type: 'zvuk:favorite-page', tracks: [{ id: 'zvuk-live-1', title: 'Track', artist: 'Artist' }], hasMore: false }, 1),
    app.pageMessage({ type: 'zvuk:collection-count', uniqueTrackCount: 1, uniquePlaylistCount: 0 }, 1),
  ]);

  assert.deepEqual(app.storageState[ZVUK_KEY].tracks.map((track) => track.id), ['zvuk-live-1']);
  assert.equal(app.storageState[ZVUK_KEY].expectedCount, 1);
});

test('selective library refresh rejects unknown provider IDs', async () => {
  const app = bootWorker({});
  const response = await app.callFrom({
    type: 'music-importer:get-all-libraries',
    refresh: true,
    refreshProviders: ['unknown-provider'],
  }, 'chrome-extension://fixture-extension/app/index.html');
  assert.match(response.error, /некорректный список сервисов/i);
  assert.deepEqual(app.messages, []);
  assert.deepEqual(app.updates, []);
});

test('a provider scan with no progress for two minutes stops blocking the other libraries', async () => {
  const tabs = [{ id: 2, url: 'https://open.spotify.com/collection/tracks' }];
  const startedAt = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const app = bootWorker({
    [PROVIDER_KEY]: {
      snapshots: {},
      scans: { spotify: { status: 'reading', message: 'Old progress', updatedAt: startedAt } },
      previousSnapshots: {},
    },
    [ZVUK_KEY]: makeZvukState(),
  }, tabs);

  const response = await app.call({
    type: 'music-importer:get-all-libraries', refresh: true, refreshProviders: ['spotify'],
  });

  assert.equal(response.pending, false);
  assert.equal(response.statuses.spotify.status, 'failed');
  assert.match(response.statuses.spotify.message, /не сообщал о прогрессе 2 минуты/i);
  assert.equal(response.statuses['apple-music'].status, 'unavailable');
  assert.deepEqual(app.messages, []);
});

test('a provider read error is reported as failed so its card can retry the scan', async () => {
  const app = bootWorker({
    [PROVIDER_KEY]: {
      snapshots: {},
      scans: { spotify: { status: 'failed', message: 'Reader timeout' } },
      previousSnapshots: {},
    },
    [ZVUK_KEY]: makeZvukState(),
  }, [{ id: 2, url: 'https://open.spotify.com/collection/tracks' }]);

  const response = await app.call({ type: 'music-importer:get-all-libraries', refresh: false });

  assert.equal(response.pending, false);
  assert.equal(response.statuses.spotify.status, 'failed');
  assert.match(response.statuses.spotify.message, /Reader timeout/);
});

test('a Zvuk read error stays distinct from a missing signed-in tab', async () => {
  const zvukState = { ...makeZvukState(), error: 'Favorites scan stopped before the last page.' };
  const app = bootWorker({ [ZVUK_KEY]: zvukState });

  const response = await app.call({ type: 'music-importer:get-all-libraries', refresh: false });

  assert.equal(response.statuses.zvuk.status, 'failed');
  assert.match(response.statuses.zvuk.message, /last page/);
  assert.equal(response.statuses.spotify.status, 'unavailable');
});

test('one-click provider scan uses the most recently accessed matching service tab', async () => {
  const tabs = [
    { id: 1, url: 'https://music.apple.com/us/library', lastAccessed: 10 },
    { id: 2, url: 'https://music.apple.com/us/library/playlist/favorites', lastAccessed: 20 },
  ];
  const app = bootWorker({ [ZVUK_KEY]: makeZvukState() }, tabs);
  const response = await app.call({ type: 'music-importer:get-all-libraries', refresh: true });

  assert.equal(response.pending, true);
  assert.ok(app.messages.some((entry) => entry.tabId === 2 && entry.message.type === 'apple:start-library-scan'));
  assert.ok(!app.messages.some((entry) => entry.tabId === 1 && entry.message.type === 'apple:start-library-scan'));
});

test('one-click Zvuk scan reuses an open migrations tab and navigates it to favorites', async () => {
  const tabs = [{ id: 1, url: 'https://zvuk.com/migrations' }];
  const app = bootWorker({ [ZVUK_KEY]: makeZvukState() }, tabs);
  const response = await app.call({ type: 'music-importer:get-all-libraries', refresh: true });

  assert.equal(response.pending, true);
  assert.equal(response.statuses.zvuk.status, 'scanning');
  assert.ok(app.updates.some((entry) => entry.tabId === 1
    && entry.update.url === 'https://zvuk.com/favorites?music_importer_capture=1'));
});

test('extension-hosted app can start a library scan without localhost origin permission', async () => {
  const tabs = [{ id: 4, url: 'https://music.apple.com/us/library' }];
  const app = bootWorker({ [ZVUK_KEY]: makeZvukState() }, tabs);
  const response = await app.callFrom({ type: 'music-importer:get-all-libraries', refresh: true }, 'chrome-extension://fixture-extension/app/index.html');
  assert.equal(response.pending, true);
  assert.equal(response.statuses['apple-music'].status, 'scanning');
  assert.ok(app.messages.some(({ tabId, message }) => tabId === 4 && message.type === 'apple:start-library-scan'));
});

test('library scan reloads an old provider tab once when its extension content script is missing', async () => {
  const tabs = [{ id: 4, url: 'https://music.apple.com/us/library', status: 'complete' }];
  const app = bootWorker({ [ZVUK_KEY]: makeZvukState() }, tabs, { missingReceiverOnce: [4] });
  const response = await app.callFrom({ type: 'music-importer:get-all-libraries', refresh: true }, 'chrome-extension://fixture-extension/app/index.html');
  assert.equal(response.pending, true);
  assert.deepEqual(app.reloads, [4]);
  assert.equal(app.messages.filter(({ tabId, message }) => tabId === 4 && message.type === 'apple:start-library-scan').length, 1);
  assert.equal(response.statuses['apple-music'].status, 'scanning');
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

test('service command repairs a stale provider bridge before sending the command', async () => {
  const tabs = [{ id: 4, url: 'https://music.apple.com/us/library', status: 'complete' }];
  const app = bootWorker({ [ZVUK_KEY]: makeZvukState() }, tabs, { oldBridgeTabIds: [4] });
  const response = await app.callFrom({
    type: 'music-importer:apple-command', requestId: 'fixture-request-0009', action: 'search-tracks', query: 'fixture',
  }, 'chrome-extension://fixture-extension/app/index.html');
  assert.equal(response.ok, true);
  assert.deepEqual(app.reloads, [4]);
  assert.ok(app.messages.some(({ tabId, message }) => tabId === 4 && message.type === 'music-importer:bridge-health-check'));
  assert.ok(app.messages.some(({ tabId, message }) => tabId === 4 && message.type === 'apple:command'));
});

test('extension-hosted app can send album batch search to the signed-in Apple Music tab', async () => {
  const tabs = [{ id: 4, url: 'https://music.apple.com/us/library' }];
  const app = bootWorker({ [ZVUK_KEY]: makeZvukState() }, tabs);
  const response = await app.callFrom({
    type: 'music-importer:apple-command',
    requestId: 'fixture-request-0001',
    action: 'search-album-tracks',
    album: 'Discovery',
    artist: 'Daft Punk',
    storefront: 'AE',
  }, 'chrome-extension://fixture-extension/app/index.html');

  assert.equal(response.ok, true);
  const command = app.messages.find(({ tabId, message }) => tabId === 4 && message.type === 'apple:command')?.message;
  assert.equal(command?.action, 'search-album-tracks');
  assert.equal(command?.album, 'Discovery');
  assert.equal(command?.artist, 'Daft Punk');
  assert.equal(command?.storefront, 'AE');
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

test('provider checkpoint is not acknowledged until the app confirms its local IndexedDB write', async () => {
  const tabs = [{ id: 4, url: 'https://music.apple.com/us/library' }];
  const app = bootWorker({ [ZVUK_KEY]: makeZvukState() }, tabs, { autoAckCheckpoints: false });
  const port = app.connectApp();
  let settled = false;
  const responsePromise = app.pageMessage({
    type: 'apple:transfer-progress', requestId: 'fixture-request-0001',
    progress: { phase: 'playlist-creating', checkpointId: 'fixture-request-0001:1' },
  }, 4).then((response) => { settled = true; return response; });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(settled, false);
  assert.equal(app.portMessages[0].checkpointAckId, 'fixture-request-0001:1');
  port.acknowledge({ type: 'transfer-progress-ack', checkpointAckId: 'fixture-request-0001:1', ok: true });
  const response = await responsePromise;
  assert.equal(response.ok, true);
  assert.equal(response.error, null);
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

test('Zvuk account scan preserves a sanitized cursor failure reason', async () => {
  const tabs = [{ id: 1, url: 'https://zvuk.com/favorites' }];
  const storage = { [ZVUK_KEY]: makeZvukState() };
  const app = bootWorker(storage, tabs);
  await app.call({ type: 'music-importer:get-all-libraries', refresh: true });
  await app.pageMessage({ type: 'zvuk:favorites-scroll-stall', reason: 'GraphQL ответил HTTP 503.' }, 1);

  assert.equal(storage[ZVUK_KEY].scan.phase, 'needs_review');
  assert.match(storage[ZVUK_KEY].scan.error, /Причина: GraphQL ответил HTTP 503/);
  assert.equal(storage[ZVUK_KEY].captureEnabled, false);
});

test('Zvuk waits for the independent favorites count if cursor scan finishes first', async () => {
  const tabs = [{ id: 1, url: 'https://zvuk.com/favorites' }];
  const storage = { [ZVUK_KEY]: makeZvukState() };
  const app = bootWorker(storage, tabs);
  await app.call({ type: 'music-importer:get-all-libraries', refresh: true });
  await app.pageMessage({ type: 'zvuk:favorite-page', tracks: [{ id: 'like-1', title: 'Liked' }], hasMore: false }, 1);
  await app.pageMessage({ type: 'zvuk:favorites-scroll-end' }, 1);

  assert.equal(storage[ZVUK_KEY].scan.active, true);
  assert.equal(storage[ZVUK_KEY].scan.phase, 'favorites');
  assert.equal(storage[ZVUK_KEY].scan.error, undefined);

  await app.pageMessage({ type: 'zvuk:collection-count', uniqueTrackCount: 1, uniquePlaylistCount: 0 }, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(storage[ZVUK_KEY].scan.phase, 'playlists');
  assert.ok(app.updates.some((entry) => entry.update.url === 'https://zvuk.com/collection?music_importer_capture=1'), JSON.stringify(storage[ZVUK_KEY]));
});

test('Zvuk stops a scan with no progress after two minutes', async () => {
  const storage = { [ZVUK_KEY]: { ...makeZvukState(), scan: { active: true, phase: 'favorites', startedAt: new Date(0).toISOString() }, updatedAt: new Date(0).toISOString() } };
  const app = bootWorker(storage);
  const result = await app.call({ type: 'music-importer:get-all-libraries', refresh: false });

  assert.match(result.statuses.zvuk.message, /не сообщал о прогрессе 2 минуты/i);
  assert.equal(storage[ZVUK_KEY].scan.active, false);
  assert.equal(storage[ZVUK_KEY].captureEnabled, false);
});
