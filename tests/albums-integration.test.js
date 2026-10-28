const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { bootWorker } = require('./helpers/worker-fixture');

const APP_URL = 'chrome-extension://fixture-extension/app/index.html';
const PROVIDER_KEY = 'providerLibraryBridge';
const ZVUK_KEY = 'zvukFavoriteCapture';
const plain = (value) => JSON.parse(JSON.stringify(value));

function loadDemo() {
  const context = { window: {}, Date, Map, Set, String, Number, Array, Object, Error, JSON, Math, structuredClone, DOMException, Promise, setTimeout, clearTimeout };
  for (const file of ['matcher.js', 'album-matcher.js', 'account-catalog.js', 'transfer-core.js', 'transfer-engine.js']) {
    vm.runInNewContext(fs.readFileSync(require.resolve(`../demo/${file}`), 'utf8'), context, { filename: file });
  }
  return context.window;
}

const demo = loadDemo();
const albums = demo.MusicAlbumMatcher;

const source = (overrides = {}) => ({ title: 'Discovery', artists: ['Daft Punk'], upc: '', trackCount: 14, ...overrides });
const candidate = (overrides = {}) => ({ providerId: 'c1', title: 'Discovery', artists: ['Daft Punk'], upc: '', trackCount: 14, ...overrides });

// --- matching ---------------------------------------------------------------------------------

test('exact UPC wins even when the titles differ, and leading zeros are ignored', () => {
  const suggestion = albums.suggestAlbumMatch(source({ upc: '0724384960650', title: 'Discovery (Remastered)' }), [
    candidate({ providerId: 'near', upc: '', title: 'Discovery (Remastered)' }),
    candidate({ providerId: 'exact', upc: '724384960650', title: 'Discovery - Edition' }),
  ]);
  assert.equal(suggestion.automatic, true);
  assert.equal(suggestion.reason, 'upc_exact');
  assert.equal(suggestion.best.providerId, 'exact');
  assert.equal(albums.normalizeUpc('00 7243-84960650'), '724384960650');
});

test('title and artist at 0.96 with an equal track count is accepted automatically', () => {
  const suggestion = albums.suggestAlbumMatch(source({ artists: ['Daft Punk'] }), [candidate({ title: 'discovery', artists: ['DAFT PUNK'] })]);
  assert.equal(suggestion.automatic, true);
  assert.equal(suggestion.reason, 'title_artist_trackcount');
});

test('a track count mismatch, a missing track count or a different edition goes to the review queue', () => {
  const wrongCount = albums.suggestAlbumMatch(source(), [candidate({ trackCount: 20 })]);
  assert.equal(wrongCount.automatic, false);
  assert.equal(wrongCount.best.providerId, 'c1');
  assert.equal(albums.suggestAlbumMatch(source({ trackCount: null }), [candidate()]).automatic, false);
  assert.equal(albums.suggestAlbumMatch(source(), [candidate({ trackCount: 0 })]).automatic, false);
  const deluxe = albums.suggestAlbumMatch(source(), [candidate({ title: 'Discovery (Deluxe Edition)' })]);
  assert.equal(deluxe.automatic, false);
});

test('two distinct qualifying editions are ambiguous and never auto-accepted', () => {
  const suggestion = albums.suggestAlbumMatch(source(), [candidate({ providerId: 'a' }), candidate({ providerId: 'b' })]);
  assert.equal(suggestion.automatic, false);
  assert.equal(suggestion.reason, 'ambiguous');
  assert.equal(albums.suggestAlbumMatch(source(), []).reason, 'no_candidates');
  assert.equal(albums.suggestAlbumMatch(source(), [candidate({ title: 'Totally different', artists: ['Someone Else'], trackCount: 3 })]).automatic, false);
});

test('Cyrillic titles match their transliteration but only a high-confidence match is automatic', () => {
  const suggestion = albums.suggestAlbumMatch(
    { title: 'Группа крови', artists: ['Кино'], trackCount: 9 },
    [{ providerId: 'k', title: 'Gruppa krovi', artists: ['Kino'], trackCount: 9 }],
  );
  assert.equal(suggestion.automatic, true);
});

// --- snapshot extraction ----------------------------------------------------------------------

const spotifyAlbum = { providerId: 'spotify:album:1', title: 'Discovery', artists: ['Daft Punk'], upc: '0724384960650', trackCount: 14 };

function libraryPayload(extra = {}) {
  return {
    schemaVersion: 1, service: 'spotify', collection: { type: 'library', name: 'Вся библиотека' },
    completeness: { confirmed: true, favoritesConfirmed: true, favoritesCount: 1, catalogConfirmed: true, playlistItemsConfirmed: true, playlistItemsTotal: 0, ...extra.completeness },
    tracks: [{ id: 't1', title: 'Song', artist: 'Artist' }],
    playlists: [],
    ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'completeness')),
  };
}

test('album collections are read from every provider snapshot shape', () => {
  const spotify = albums.extractSourceAlbums(libraryPayload({
    completeness: { albumsConfirmed: true, albumsCount: 1 },
    collections: [{ type: 'albums', completeness: { confirmed: true }, items: [spotifyAlbum] }],
  }));
  assert.equal(spotify.confirmed, true);
  assert.equal(spotify.rows[0].sourceId, 'spotify:album:1');
  assert.equal(spotify.rows[0].upc, '0724384960650');

  const apple = albums.extractSourceAlbums(libraryPayload({
    completeness: { albumsConfirmed: true, albumsCount: 1 },
    albumsCollection: { type: 'albums', completeness: { confirmed: true, totalCount: 1 }, items: [{ ...spotifyAlbum, providerId: '1440' }] },
  }));
  assert.deepEqual(plain(apple.rows.map((row) => row.sourceId)), ['1440']);

  const yandex = albums.extractSourceAlbums(libraryPayload({
    completeness: { albumsConfirmed: true, albumsCount: 1 },
    collections: [{ type: 'albums', complete: true, count: 1, items: [{ ...spotifyAlbum, providerId: '77' }] }],
  }));
  assert.equal(yandex.confirmed, true);
});

test('unconfirmed, inconsistent or legacy album data never counts as a confirmed collection', () => {
  const failedYandex = albums.extractSourceAlbums(libraryPayload({
    completeness: { albumsConfirmed: false, albumsCount: 0 },
    collections: [{ type: 'albums', complete: false, count: 0, items: [], error: 'boom' }],
  }));
  assert.deepEqual(plain(failedYandex), { rows: [], confirmed: false });
  const wrongCount = albums.extractSourceAlbums(libraryPayload({
    completeness: { albumsConfirmed: true, albumsCount: 5 },
    collections: [{ type: 'albums', completeness: { confirmed: true }, items: [spotifyAlbum] }],
  }));
  assert.equal(wrongCount.confirmed, false);
  const duplicate = albums.extractSourceAlbums(libraryPayload({
    completeness: { albumsConfirmed: true, albumsCount: 2 },
    collections: [{ type: 'albums', completeness: { confirmed: true }, items: [spotifyAlbum, spotifyAlbum] }],
  }));
  assert.equal(duplicate.confirmed, false);
  assert.equal(albums.extractSourceAlbums(libraryPayload()), null);
});

test('picker scopes: all carries confirmed albums only, albums-only keeps the gate, likes and playlists carry none', () => {
  const confirmed = libraryPayload({ completeness: { albumsConfirmed: true, albumsCount: 1 }, collections: [{ type: 'albums', completeness: { confirmed: true }, items: [spotifyAlbum] }] });
  const unconfirmed = libraryPayload({ completeness: { albumsConfirmed: false }, collections: [] });
  assert.equal(albums.albumsForScope(confirmed, 'all').albums.rows.length, 1);
  assert.equal(albums.albumsForScope(confirmed, 'favorites').albums, null);
  assert.equal(albums.albumsForScope(confirmed, 'playlist:x').albums, null);
  assert.equal(albums.albumsForScope(confirmed, 'albums').albums.confirmed, true);
  assert.deepEqual(plain(albums.albumsForScope(unconfirmed, 'all')), { albums: null, skipped: true });
  assert.equal(albums.albumsForScope(unconfirmed, 'albums').albums.confirmed, false);
  assert.deepEqual(plain(albums.albumsForScope(libraryPayload(), 'all')), { albums: null, skipped: false });
});

// --- snapshot, plan and engine ----------------------------------------------------------------

function snapshotFor(rows, confirmed = true) {
  const payload = libraryPayload({ completeness: { albumsConfirmed: confirmed, albumsCount: rows.length }, collections: [{ type: 'albums', completeness: { confirmed }, items: rows }] });
  const info = albums.extractSourceAlbums(payload);
  return demo.MusicTransferCore.createImportedSnapshot({
    provider: 'spotify', collectionType: 'library', collectionName: 'Вся библиотека',
    tracks: [{ title: 'Song', artist: 'Artist', sourceId: 't1', sourceCollectionType: 'favorites' }],
    albums: { items: info.rows, completeness: { confirmed: info.confirmed, totalCount: info.rows.length } },
    completeness: payload.completeness,
  });
}

test('an imported snapshot keeps albums as a separate confirmed collection of album refs', () => {
  const snapshot = snapshotFor(albums.extractSourceAlbums(libraryPayload({
    completeness: { albumsConfirmed: true, albumsCount: 1 }, collections: [{ type: 'albums', completeness: { confirmed: true }, items: [spotifyAlbum] }],
  })).rows);
  const collection = snapshot.collections.find((entry) => entry.type === 'albums');
  assert.equal(collection.itemCount, 1);
  assert.equal(collection.items[0].album.upc, '0724384960650');
  assert.equal(collection.items[0].track, undefined);
  assert.equal(snapshot.completeness.confirmed, true);
});

test('an unconfirmed albums collection makes the whole snapshot unconfirmed so the plan fails closed', () => {
  const snapshot = demo.MusicTransferCore.createImportedSnapshot({
    provider: 'spotify', collectionType: 'library', tracks: [],
    albums: { items: [], completeness: { confirmed: false, totalCount: 0 } },
    completeness: { confirmed: true, favoritesConfirmed: true, favoritesCount: 0 },
  });
  assert.equal(snapshot.completeness.confirmed, false);
  const plan = demo.MusicTransferCore.createTransferPlan({ sourceSnapshot: snapshot, targetProvider: 'apple-music', targetCollectionType: 'albums', tracks: [], albums: [] });
  assert.ok(plan.completeness.source.some((status) => status.confirmed !== true));
});

test('the plan carries albums as add_album operations only, separate from likes and playlists', () => {
  const rows = albums.extractSourceAlbums(libraryPayload({
    completeness: { albumsConfirmed: true, albumsCount: 1 }, collections: [{ type: 'albums', completeness: { confirmed: true }, items: [spotifyAlbum] }],
  })).rows;
  const snapshot = snapshotFor(rows);
  const album = { ...rows[0], selected: true, matchReason: 'upc_exact', matchConfidence: 1, autoMatched: true,
    match: { providerId: '1440', albumId: '1440', title: 'Discovery', artists: ['Daft Punk'], upc: '724384960650', trackCount: 14 } };
  const track = { title: 'Song', artist: 'Artist', sourceId: 't1', sourceCollectionType: 'favorites', selected: true, searched: true, matches: [], match: { trackId: 'T9', trackName: 'Song', artistName: 'Artist' } };
  const plan = demo.MusicTransferCore.createTransferPlan({ sourceSnapshot: snapshot, targetProvider: 'apple-music', targetCollectionType: 'library', tracks: [track], albums: [album] });
  assert.deepEqual(plain(plan.operations.map((operation) => operation.operation)), ['add_to_favorites', 'add_album']);
  const operation = plan.operations.find((entry) => entry.operation === 'add_album');
  assert.equal(operation.target.providerId, '1440');
  assert.equal(operation.source.upc, '0724384960650');
  assert.deepEqual(plain(albums.albumPlanSummary(plan)), { likes: 1, albums: 1, playlistItems: 0, playlists: 0 });
  const onlyAlbums = demo.MusicTransferCore.createTransferPlan({ sourceSnapshot: snapshot, targetProvider: 'apple-music', targetCollectionType: 'albums', tracks: [], albums: [album] });
  assert.deepEqual(plain(albums.albumPlanSummary(onlyAlbums)), { likes: 0, albums: 1, playlistItems: 0, playlists: 0 });
});

function fakeRequest(handlers, log = []) {
  const request = async (action, details, provider, onProgress) => {
    log.push({ action, details, provider, onProgress });
    const handler = handlers[action];
    if (!handler) throw new Error(`unexpected ${action}`);
    return handler(details, provider, onProgress);
  };
  request.log = log;
  return request;
}

test('album target maps search to each provider command and forwards UPC only where it is searchable', async () => {
  const album = { title: 'Discovery', artists: ['Daft Punk', 'Guest'], artist: 'Daft Punk, Guest', upc: '0724384960650' };
  const seen = {};
  for (const provider of ['spotify', 'apple-music', 'yandex-music', 'zvuk']) {
    const request = fakeRequest({ 'search-albums': async () => ({ ok: true, results: [candidate({ providerId: `${provider}-1` })] }) });
    const results = await albums.createAlbumTarget(provider, request).searchAlbums(album, { storefront: 'AE' });
    assert.equal(results[0].providerId, `${provider}-1`);
    seen[provider] = request.log[0];
  }
  assert.deepEqual(plain(seen.spotify.details), { album: 'Discovery', artist: 'Daft Punk', upc: '0724384960650' });
  assert.equal(seen.spotify.provider, 'spotify');
  assert.deepEqual(plain(seen['apple-music'].details), { album: 'Discovery', artist: 'Daft Punk', upc: '0724384960650', storefront: 'AE' });
  assert.equal(seen['apple-music'].provider, 'apple');
  assert.deepEqual(plain(seen['yandex-music'].details), { album: 'Discovery', artist: 'Daft Punk' });
  assert.deepEqual(plain(seen.zvuk.details), { query: 'Discovery Daft Punk' });
  await assert.rejects(albums.createAlbumTarget('spotify', fakeRequest({ 'search-albums': async () => ({ ok: false, error: 'HTTP 429', status: 429 }) })).searchAlbums(album), /429/);
});

test('the engine writes albums through the Spotify album target, skips saved ones and verifies by read-back', async () => {
  const saved = new Set(['spotify:album:old']);
  const request = fakeRequest({
    'read-albums': async (details) => ({ ok: true, report: details.ids
      ? { complete: true, items: details.ids.filter((id) => saved.has(id)).map((providerId) => ({ providerId })) }
      : { complete: true, total: saved.size, items: [...saved].map((providerId) => ({ providerId })) } }),
    'write-albums': async (details) => { details.targets.forEach((target) => saved.add(target.providerId)); return { ok: true, report: { writtenCount: details.targets.length, verified: details.targets.length } }; },
  });
  const target = albums.createAlbumTarget('spotify', request);
  const adapter = { id: 'spotify', ...target };
  const rows = [spotifyAlbum, { ...spotifyAlbum, providerId: 'spotify:album:2', title: 'Homework' }];
  const snapshot = snapshotFor(rows.map(albums.normalizeSourceAlbum));
  const picked = rows.map(albums.normalizeSourceAlbum).map((row, index) => ({ ...row, selected: true, match: { providerId: index === 0 ? 'spotify:album:old' : 'spotify:album:new', title: row.title, artists: row.artists } }));
  const plan = demo.MusicTransferCore.createTransferPlan({ sourceSnapshot: { ...snapshot, provider: 'apple-music' }, targetProvider: 'spotify', targetCollectionType: 'albums', tracks: [], albums: picked });
  const report = await demo.MusicTransferEngine.executeTransferPlan(adapter, plan, { confirmed: true });
  assert.equal(report.status, 'complete');
  assert.equal(report.alreadyPresent, 1);
  assert.equal(report.writesPerformed, 1);
  assert.equal(report.verified, 2);
  const written = request.log.find((entry) => entry.action === 'write-albums');
  assert.deepEqual(plain(written.details.targets.map((entry) => entry.providerId)), ['spotify:album:new']);
});

test('Spotify transfers write tracks via execute-transfer and albums via write-albums with checkpoints; others keep add_album in the plan', async () => {
  const plan = {
    type: 'music-transfer-plan', target: { provider: 'spotify', collectionType: 'library' }, collectionMappings: [],
    operations: [
      { operation: 'add_to_favorites', target: { provider: 'spotify', providerId: 'spotify:track:1' } },
      { operation: 'add_album', target: { provider: 'spotify', providerId: 'spotify:album:1' } },
    ],
    completeness: { source: [{ confirmed: true }] },
  };
  const progress = [];
  const request = fakeRequest({
    'execute-transfer': async ({ plan: sent }) => ({ ok: true, report: { status: 'complete', favorites: { verified: sent.operations.length } } }),
    'write-albums': async (_details, _provider, onProgress) => { await onProgress({ phase: 'albums', checkpointId: 'x:1' }); return { ok: true, report: { requested: 1, written: 1, writtenCount: 1, alreadyPresent: 0, verified: 1 } }; },
  });
  const result = await albums.executePlanOnTarget('spotify', plan, request, async (value) => { progress.push(value); return true; });
  assert.equal(result.ok, true);
  assert.equal(result.report.favorites.verified, 1);
  assert.equal(result.report.albums.verified, 1);
  assert.deepEqual(plain(request.log.find((entry) => entry.action === 'execute-transfer').details.plan.operations.map((operation) => operation.operation)), ['add_to_favorites']);
  assert.equal(progress[0].phase, 'albums');

  const albumsOnly = fakeRequest({ 'write-albums': async () => ({ ok: true, report: { verified: 1 } }) });
  await albums.executePlanOnTarget('spotify', { ...plan, operations: [plan.operations[1]] }, albumsOnly);
  assert.deepEqual(plain(albumsOnly.log.map((entry) => entry.action)), ['write-albums']);

  const apple = fakeRequest({ 'execute-transfer': async ({ plan: sent }) => ({ ok: true, report: { albums: { verified: sent.operations.length } } }) });
  const appleResult = await albums.executePlanOnTarget('apple-music', { ...plan, target: { provider: 'apple-music', collectionType: 'library' } }, apple);
  assert.equal(appleResult.report.albums.verified, 2);
  assert.equal(apple.log.length, 1);
  assert.equal(apple.log[0].provider, 'apple');

  const failing = fakeRequest({
    'execute-transfer': async () => ({ ok: true, report: { status: 'complete' } }),
    'write-albums': async () => { throw Object.assign(new Error('Spotify не подтвердил'), { report: { status: 'partial_failure', albums: { verified: 0 } } }); },
  });
  const failed = await albums.executePlanOnTarget('spotify', plan, failing);
  assert.equal(failed.ok, false);
  assert.equal(failed.report.status, 'partial_failure');
});

// --- service worker ---------------------------------------------------------------------------

const commandFrom = (worker, tabId, type) => worker.messages.find(({ tabId: id, message }) => id === tabId && message.type === type)?.message;

test('the service worker relays album commands with UPC, ids and targets to Spotify', async () => {
  const worker = bootWorker({}, [{ id: 7, url: 'https://open.spotify.com/collection/albums', status: 'complete' }]);
  const search = await worker.callFrom({ type: 'music-importer:spotify-command', requestId: 'fixture-request-0001', action: 'search-albums', album: 'Discovery', artist: 'Daft Punk', upc: '00724-384960650' }, APP_URL);
  assert.equal(search.ok, true);
  const sent = commandFrom(worker, 7, 'spotify:command');
  assert.equal(sent.action, 'search-albums');
  assert.equal(sent.upc, '00724384960650');
  assert.equal(sent.album, 'Discovery');
  await worker.callFrom({ type: 'music-importer:spotify-command', requestId: 'fixture-request-0002', action: 'read-albums', ids: ['spotify:album:1'] }, APP_URL);
  assert.deepEqual(plain(worker.messages.filter(({ message }) => message.type === 'spotify:command').at(-1).message.ids), ['spotify:album:1']);
  await worker.callFrom({ type: 'music-importer:spotify-command', requestId: 'fixture-request-0003', action: 'write-albums', targets: [{ provider: 'spotify', providerId: 'spotify:album:1' }] }, APP_URL);
  assert.deepEqual(plain(worker.messages.filter(({ message }) => message.type === 'spotify:command').at(-1).message.targets), [{ provider: 'spotify', providerId: 'spotify:album:1' }]);
  const foreign = await worker.callFrom({ type: 'music-importer:spotify-command', requestId: 'fixture-request-0004', action: 'write-albums', targets: [{ provider: 'apple-music', providerId: '1' }] }, APP_URL);
  assert.equal(foreign.ok, false);
  const empty = await worker.callFrom({ type: 'music-importer:spotify-command', requestId: 'fixture-request-0005', action: 'write-albums', targets: [] }, APP_URL);
  assert.equal(empty.ok, false);
});

test('the service worker relays album search and read commands for Apple Music, Yandex Music and Zvuk', async () => {
  const worker = bootWorker({}, [
    { id: 4, url: 'https://music.apple.com/us/library', status: 'complete' },
    { id: 5, url: 'https://music.yandex.ru/home', status: 'complete' },
    { id: 6, url: 'https://zvuk.com/collection', status: 'complete' },
  ]);
  await worker.callFrom({ type: 'music-importer:apple-command', requestId: 'fixture-request-0001', action: 'search-albums', album: 'Discovery', artist: 'Daft Punk', upc: '0724-38', storefront: 'AE' }, APP_URL);
  const apple = commandFrom(worker, 4, 'apple:command');
  assert.equal(apple.upc, '072438');
  assert.equal(apple.storefront, 'AE');
  assert.equal((await worker.callFrom({ type: 'music-importer:apple-command', requestId: 'fixture-request-0002', action: 'read-library-albums' }, APP_URL)).ok, true);
  await worker.callFrom({ type: 'music-importer:yandex-command', requestId: 'fixture-request-0003', action: 'search-albums', album: 'Discovery', artist: 'Daft Punk' }, APP_URL);
  assert.equal(commandFrom(worker, 5, 'yandex:command').action, 'search-albums');
  assert.equal(commandFrom(worker, 5, 'yandex:command').album, 'Discovery');
  assert.equal((await worker.callFrom({ type: 'music-importer:yandex-command', requestId: 'fixture-request-0004', action: 'read-albums' }, APP_URL)).ok, true);
  await worker.callFrom({ type: 'music-importer:zvuk-command', requestId: 'fixture-request-0005', action: 'search-albums', query: 'Discovery Daft Punk' }, APP_URL);
  assert.equal(commandFrom(worker, 6, 'zvuk:command').query, 'Discovery Daft Punk');
  assert.equal((await worker.callFrom({ type: 'music-importer:zvuk-command', requestId: 'fixture-request-0006', action: 'write-albums' }, APP_URL)).ok, false);
});

test('Spotify album and Zvuk albums-writing checkpoints are held until the app stores them', async () => {
  for (const [type, url, phase] of [['spotify:transfer-progress', 'https://open.spotify.com/collection/albums', 'albums'], ['zvuk:transfer-progress', 'https://zvuk.com/collection', 'albums-writing']]) {
    const worker = bootWorker({}, [{ id: 4, url }], { autoAckCheckpoints: false });
    const port = worker.connectApp();
    let settled = false;
    const reply = worker.pageMessage({ type, requestId: 'fixture-request-0001', progress: { phase, checkpointId: 'fixture-request-0001:1' } }, 4).then((value) => { settled = true; return value; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(worker.portMessages[0].progress.phase, phase);
    port.acknowledge({ type: 'transfer-progress-ack', checkpointAckId: 'fixture-request-0001:1', ok: true });
    assert.equal((await reply).ok, true);
  }
});

function providerSnapshot(service, completenessExtra, extra) {
  return {
    service, collection: { type: 'library', name: 'Вся библиотека' },
    completeness: { confirmed: true, favoritesConfirmed: true, favoritesCount: 1, catalogConfirmed: true, playlistItemsConfirmed: true, playlistItemsTotal: 0,
      ...(service === 'apple-music' ? { librarySongsConfirmed: true } : {}), ...(service === 'yandex-music' ? { playlistCatalogKindsConfirmed: true } : {}), ...completenessExtra },
    tracks: [{ id: 't1', title: 'Song', artist: 'Artist' }], playlists: [], ...extra,
  };
}

test('provider snapshots keep their albums and expose a confirmed album count to the app', async () => {
  const storage = {};
  const worker = bootWorker(storage, [
    { id: 1, url: 'https://open.spotify.com/collection/tracks' },
    { id: 2, url: 'https://music.apple.com/us/library' },
    { id: 3, url: 'https://music.yandex.ru/home' },
  ]);
  await worker.pageMessage({ type: 'spotify:library-snapshot', payload: providerSnapshot('spotify', { albumsConfirmed: true, albumsCount: 1 }, { collections: [{ type: 'albums', completeness: { confirmed: true }, items: [spotifyAlbum] }] }) }, 1);
  await worker.pageMessage({ type: 'apple:library-snapshot', payload: providerSnapshot('apple-music', { albumsConfirmed: true, albumsCount: 1 }, { albumsCollection: { type: 'albums', completeness: { confirmed: true, totalCount: 1 }, items: [{ ...spotifyAlbum, providerId: '1440' }] } }) }, 2);
  await worker.pageMessage({ type: 'yandex:library-snapshot', payload: providerSnapshot('yandex-music', { albumsConfirmed: false, albumsCount: 0 }, { collections: [{ type: 'albums', complete: false, count: 0, items: [], error: 'boom' }] }) }, 3);
  const response = await worker.call({ type: 'music-importer:get-all-libraries', refresh: false });
  assert.equal(response.statuses.spotify.albumCount, 1);
  assert.equal(response.statuses['apple-music'].albumCount, 1);
  assert.equal(response.statuses['yandex-music'].albumCount, null);
  assert.equal(response.libraries.spotify.collections[0].items.length, 1);
  assert.equal(response.libraries['apple-music'].albumsCollection.items[0].providerId, '1440');
  assert.equal(response.libraries['yandex-music'].completeness.albumsConfirmed, false);
  assert.equal(response.libraries['yandex-music'].tracks.length, 1);
});

test('a provider claim of confirmed albums without a matching duplicate-free list is withdrawn before storage', async () => {
  const storage = {};
  const worker = bootWorker(storage, [{ id: 1, url: 'https://open.spotify.com/collection/tracks' }]);
  await worker.pageMessage({ type: 'spotify:library-snapshot', payload: providerSnapshot('spotify', { albumsConfirmed: true, albumsCount: 3 }, { collections: [{ type: 'albums', completeness: { confirmed: true }, items: [spotifyAlbum] }] }) }, 1);
  const stored = storage[PROVIDER_KEY].snapshots.spotify;
  assert.equal(stored.completeness.albumsConfirmed, false);
  assert.equal(stored.completeness.albumsError, 'album_count_mismatch');
  assert.equal(stored.completeness.confirmed, true);

  await worker.pageMessage({ type: 'spotify:library-snapshot', payload: providerSnapshot('spotify', { albumsConfirmed: true, albumsCount: 2 }, { collections: [{ type: 'albums', completeness: { confirmed: true }, items: [spotifyAlbum, spotifyAlbum] }] }) }, 1);
  assert.equal(storage[PROVIDER_KEY].snapshots.spotify.completeness.albumsConfirmed, false);
});

function zvukScanState() {
  return { scan: { active: false, phase: 'idle', tabId: 1 }, tracks: [], playlists: [], captureEnabled: false };
}

async function crawlZvuk(worker, storage, releaseMessages, count) {
  const started = await worker.call({ type: 'music-importer:get-all-libraries', refresh: true, refreshProviders: ['zvuk'] });
  assert.equal(started.pending, true);
  await worker.pageMessage({ type: 'zvuk:collection-count', uniqueTrackCount: 1, uniquePlaylistCount: 0 }, 1);
  await worker.pageMessage({ type: 'zvuk:favorite-page', tracks: [{ id: 'like-1', title: 'Liked', artists: [{ title: 'Artist' }] }], hasMore: false }, 1);
  await worker.pageMessage({ type: 'zvuk:favorites-scroll-end' }, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(storage[ZVUK_KEY].scan.phase, 'playlists');
  await worker.pageMessage({ type: 'zvuk:collection-count', uniqueTrackCount: 1, uniquePlaylistCount: 0, uniqueReleaseCount: count }, 1);
  await worker.pageMessage({ type: 'zvuk:playlist-list-page', hasMore: false, playlists: [] }, 1);
  for (const message of releaseMessages) await worker.pageMessage(message, 1);
  await worker.pageMessage({ type: 'zvuk:collection-scroll-end' }, 1);
  await new Promise((resolve) => setImmediate(resolve));
  return worker.call({ type: 'music-importer:get-library', provider: 'zvuk' });
}

test('Zvuk releases become an albums collection only when the unique IDs equal the independent release count', async () => {
  const releases = [
    { id: 'r1', title: 'Discovery', artists: [{ id: 'a', title: 'Daft Punk' }], trackCount: 14, releaseDate: '2001-03-12', artworkUrl: 'https://img/1.jpg' },
    { id: 'r2', title: 'Homework', artists: [{ id: 'a', title: 'Daft Punk' }], trackCount: 16 },
  ];
  const storage = { [ZVUK_KEY]: zvukScanState() };
  const worker = bootWorker(storage, [{ id: 1, url: 'https://zvuk.com/favorites', status: 'complete' }]);
  const library = await crawlZvuk(worker, storage, [
    { type: 'zvuk:release-list-page', releases: [releases[0]], hasMore: true },
    { type: 'zvuk:release-list-page', releases: [releases[0], releases[1]], hasMore: false },
    { type: 'zvuk:release-metadata', releases: [{ id: 'r2', title: 'Homework', artists: [{ title: 'Daft Punk' }], trackCount: 16, releaseDate: '1997-01-20' }] },
  ], 2);
  const payload = library.payload;
  assert.equal(payload.completeness.confirmed, true);
  assert.equal(payload.completeness.albumsConfirmed, true);
  assert.equal(payload.completeness.albumsCount, 2);
  const collection = payload.collections.find((entry) => entry.type === 'albums');
  assert.deepEqual(plain(collection.items.map((item) => [item.providerId, item.title, item.artists, item.trackCount])), [
    ['r1', 'Discovery', ['Daft Punk'], 14], ['r2', 'Homework', ['Daft Punk'], 16],
  ]);
  assert.equal(collection.items[1].releaseDate, '1997-01-20');
  const extracted = albums.extractSourceAlbums(plain(payload));
  assert.equal(extracted.confirmed, true);
});

test('Zvuk fails closed on a release count mismatch, an unfinished cursor or a missing independent count', async () => {
  const releases = [{ id: 'r1', title: 'Discovery', artists: [{ title: 'Daft Punk' }], trackCount: 14 }];
  for (const [messages, count, error] of [
    [[{ type: 'zvuk:release-list-page', releases, hasMore: false }], 2, 'release_count_mismatch'],
    [[{ type: 'zvuk:release-list-page', releases, hasMore: true }], 1, 'release_list_incomplete'],
    [[{ type: 'zvuk:release-list-page', releases, hasMore: false }], null, 'release_count_unavailable'],
    [[], 1, 'release_list_incomplete'],
  ]) {
    const storage = { [ZVUK_KEY]: zvukScanState() };
    const worker = bootWorker(storage, [{ id: 1, url: 'https://zvuk.com/favorites', status: 'complete' }]);
    const library = await crawlZvuk(worker, storage, messages, count);
    assert.equal(library.payload.completeness.confirmed, true, 'likes and playlists stay transferable');
    assert.equal(library.payload.completeness.albumsConfirmed, false);
    assert.equal(library.payload.completeness.albumsError, error);
    assert.equal(library.payload.collections.length, 0);
    assert.deepEqual(plain(albums.albumsForScope(plain(library.payload), 'all')), { albums: null, skipped: true });
  }
});

test('Zvuk release captures are accepted only from the collection page', async () => {
  const storage = { [ZVUK_KEY]: { ...zvukScanState(), captureEnabled: true } };
  const worker = bootWorker(storage, [{ id: 1, url: 'https://zvuk.com/favorites', status: 'complete' }, { id: 2, url: 'https://zvuk.com/collection', status: 'complete' }]);
  const release = [{ id: 'r1', title: 'Discovery', artists: [{ title: 'Daft Punk' }] }];
  assert.equal((await worker.pageMessage({ type: 'zvuk:release-list-page', releases: release, hasMore: false }, 1)).ok, false);
  assert.equal((await worker.pageMessage({ type: 'zvuk:release-list-page', releases: release, hasMore: false }, 2)).ok, true);
  assert.equal(storage[ZVUK_KEY].albums.length, 1);
  assert.equal((await worker.pageMessage({ type: 'zvuk:release-list-page', releases: [{ id: '', title: '' }, { id: 'r2' }], hasMore: false }, 2)).ok, true);
  assert.equal(storage[ZVUK_KEY].albums.length, 1, 'releases without ID or title are dropped');
});
