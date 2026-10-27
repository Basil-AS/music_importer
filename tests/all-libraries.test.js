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
  let runtimeListener;
  const chrome = {
    runtime: { id: 'fixture-extension', onMessage: { addListener(listener) { runtimeListener = listener; } } },
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
      async update(tabId, update) { updates.push({ tabId, update }); },
      async sendMessage(tabId, message) { messages.push({ tabId, message }); return { ok: true }; },
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../chrome-extension/service-worker.js'), 'utf8'), {
    chrome, URL, Date, Number, String, Array, Promise, Set, Map, Object, Error, JSON, RegExp, Math,
  });
  return {
    messages,
    updates,
    call(message) {
      return new Promise((resolve) => {
        const keptOpen = runtimeListener(message, { id: 'fixture-extension', url: 'http://127.0.0.1:8001/' }, resolve);
        assert.equal(keptOpen, true);
      });
    },
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
