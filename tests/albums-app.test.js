const assert = require('node:assert/strict');
const test = require('node:test');
const { createAppHarness } = require('./helpers/app-fixture');

const plain = (value) => JSON.parse(JSON.stringify(value));

function appleLibrary(albumsConfirmed = true) {
  return {
    schemaVersion: 1, service: 'apple-music', collection: { type: 'library', name: 'Вся библиотека' },
    completeness: { confirmed: true, favoritesConfirmed: true, favoritesCount: 1, catalogConfirmed: true, librarySongsConfirmed: true, playlistItemsConfirmed: true, playlistItemsTotal: 0, albumsConfirmed, albumsCount: albumsConfirmed ? 2 : 0 },
    albumsCollection: {
      type: 'albums', name: 'Альбомы', itemCount: albumsConfirmed ? 2 : 0,
      completeness: albumsConfirmed ? { confirmed: true, totalCount: 2 } : { confirmed: false, error: 'read failed' },
      items: albumsConfirmed ? [
        { providerId: '1440', title: 'Discovery', artists: ['Daft Punk'], upc: '0724384960650', trackCount: 14 },
        { providerId: '1441', title: 'Homework', artists: ['Daft Punk'], upc: '', trackCount: 16 },
      ] : [],
    },
    tracks: [{ id: 'l.1', catalogId: '900', title: 'Song', artist: 'Artist', artists: ['Artist'], isrc: 'USABC1234567' }],
    playlists: [],
  };
}

function scriptedExtension(calls) {
  return async (message) => {
    calls.push(message);
    if (message.action === 'search-tracks') {
      return { ok: true, results: [{ trackId: 'T1', providerId: 'T1', trackName: 'Song', artistName: 'Artist', collectionName: '', trackViewUrl: 'https://music.example/T1', isrc: 'USABC1234567', trackTimeMillis: 0 }] };
    }
    if (message.action === 'search-albums') {
      const prefix = String(message.type).replace('music-importer:', '').replace('-command', '');
      return { ok: true, results: [
        { providerId: `${prefix}-D`, albumId: `${prefix}-D`, title: 'Discovery', artists: ['Daft Punk'], upc: '724384960650', trackCount: 14 },
        { providerId: `${prefix}-H`, albumId: `${prefix}-H`, title: 'Homework (Deluxe Edition)', artists: ['Daft Punk'], upc: '', trackCount: 20 },
      ] };
    }
    if (message.action === 'execute-transfer') {
      const albumsInPlan = message.plan.operations.filter((operation) => operation.operation === 'add_album').length;
      const likes = message.plan.operations.filter((operation) => operation.operation === 'add_to_favorites').length;
      return { ok: true, report: { status: 'complete', favorites: { verified: likes }, albums: albumsInPlan ? { verified: albumsInPlan } : null, playlists: [] } };
    }
    if (message.action === 'write-albums') {
      return { ok: true, report: { requested: message.targets.length, written: message.targets.length, writtenCount: message.targets.length, alreadyPresent: 0, verified: message.targets.length } };
    }
    return { ok: false, error: `unexpected ${message.action}` };
  };
}

async function openSource(harness, provider) {
  await harness.waitFor(() => /альбомов/.test(harness.$('#reviewSub').textContent), 'source snapshot loaded');
  assert.equal(harness.$('#reviewSub').textContent.includes(provider), true);
}

async function searchTarget(harness, targetProvider) {
  const target = harness.$('#targetProvider');
  target.value = targetProvider;
  await target.emit('change');
  harness.$('#searchBtn').disabled = false;
  await harness.$('#searchBtn').emit('click');
  await harness.waitFor(() => /Найдено:/.test(harness.$('#searchStatus').textContent), 'catalog search');
}

test('albums are a selectable scope with counts next to likes', async () => {
  const calls = [];
  const harness = createAppHarness({ libraries: { 'apple-music': appleLibrary() }, handler: scriptedExtension(calls) });
  await openSource(harness, 'Apple Music');
  const labels = harness.$('#sourceCollectionSelect').options.map((option) => [option.value, option.text]);
  assert.deepEqual(plain(labels), [
    ['all', 'Лайки, альбомы и все плейлисты'],
    ['favorites', 'Только лайки (1)'],
    ['albums', 'Только альбомы (2)'],
  ]);
  assert.match(harness.$('#reviewSub').textContent, /1 треков · 2 альбомов/);
  assert.equal(harness.$('#albumSection').hidden, false);
  assert.equal(harness.$('#albumCount').textContent, '2 альбомов');
});

test('likes, albums and playlists transfer separately: UPC match is automatic, an uncertain edition waits for review', async () => {
  const calls = [];
  const harness = createAppHarness({ libraries: { 'apple-music': appleLibrary() }, handler: scriptedExtension(calls) });
  await openSource(harness, 'Apple Music');
  await searchTarget(harness, 'spotify');

  const albumSearches = calls.filter((call) => call.action === 'search-albums');
  assert.equal(albumSearches.length, 2);
  assert.equal(albumSearches.every((call) => call.type === 'music-importer:spotify-command'), true);
  const withUpc = albumSearches.find((call) => call.album === 'Discovery');
  assert.equal(withUpc.upc, '0724384960650');
  assert.equal(withUpc.artist, 'Daft Punk');

  assert.equal(String(harness.$('#albumReadyStat').textContent), '1');
  assert.equal(String(harness.$('#albumReviewStat').textContent), '1');
  assert.match(harness.$('#albumList').innerHTML, /UPC · 100%/);
  assert.match(harness.$('#albumList').innerHTML, /Нужно проверить/);

  await harness.$('#importBtn').emit('click');
  await harness.waitFor(() => harness.$('#report').classList.contains('show'), 'report');

  const confirmation = harness.window.confirmations.at(-1);
  assert.match(confirmation, /лайки — 1, альбомы — 1 \(целыми альбомами, без разворачивания в треки\)/);
  const trackTransfer = calls.find((call) => call.action === 'execute-transfer');
  assert.deepEqual(plain(trackTransfer.plan.operations.map((operation) => operation.operation)), ['add_to_favorites']);
  const albumWrite = calls.find((call) => call.action === 'write-albums');
  assert.deepEqual(plain(albumWrite.targets.map((target) => target.providerId)), ['spotify-D']);
  assert.equal(calls.findIndex((call) => call.action === 'execute-transfer') < calls.findIndex((call) => call.action === 'write-albums'), true);
  assert.equal(harness.$('#reportBreakdown').textContent, 'Лайки: 1 · Альбомы: 1 · Плейлисты (треков): 0');
  assert.equal(String(harness.$('#addedMetric').textContent), '2');
  assert.equal(harness.window.MusicTransferJobStore.jobs[0].albumCount, 1);
});

test('a manual album choice joins the plan and is sent to Apple Music inside the one execute-transfer plan', async () => {
  const calls = [];
  const spotifyLibrary = { ...appleLibrary(), service: 'spotify', completeness: { ...appleLibrary().completeness, librarySongsConfirmed: undefined }, albumsCollection: undefined,
    collections: [{ type: 'albums', completeness: { confirmed: true }, items: appleLibrary().albumsCollection.items.map((item) => ({ ...item, providerId: `spotify:album:${item.providerId}` })) }] };
  const harness = createAppHarness({ libraries: { spotify: spotifyLibrary }, handler: scriptedExtension(calls) });
  await openSource(harness, 'Spotify');
  await searchTarget(harness, 'apple-music');
  const select = harness.$('#albumList').innerHTML.match(/data-album-index="(\d+)"/);
  assert.ok(select);
  assert.equal(String(harness.$('#albumReviewStat').textContent), '1');

  await harness.$('#albumList').emit('change', {
    target: { dataset: { albumIndex: '1' }, value: 'apple-H', classList: { contains: (name) => name === 'album-match' } },
  });
  assert.equal(String(harness.$('#albumReadyStat').textContent), '2');

  await harness.$('#importBtn').emit('click');
  await harness.waitFor(() => harness.$('#report').classList.contains('show'), 'report');
  const execute = calls.find((call) => call.action === 'execute-transfer');
  assert.equal(execute.type, 'music-importer:apple-command');
  const albumOperations = execute.plan.operations.filter((operation) => operation.operation === 'add_album');
  assert.deepEqual(plain(albumOperations.map((operation) => operation.target.providerId)), ['apple-D', 'apple-H']);
  assert.equal(albumOperations[1].match.method, 'manual_review');
  assert.equal(execute.plan.operations.some((operation) => operation.operation === 'add_to_favorites'), true);
  assert.equal(calls.some((call) => call.action === 'write-albums'), false);
  assert.equal(harness.$('#reportBreakdown').textContent, 'Лайки: 1 · Альбомы: 2 · Плейлисты (треков): 0');
});

test('the albums-only scope sends an albums plan without any track or playlist', async () => {
  const calls = [];
  const harness = createAppHarness({ libraries: { 'apple-music': appleLibrary() }, handler: scriptedExtension(calls) });
  await openSource(harness, 'Apple Music');
  const picker = harness.$('#sourceCollectionSelect');
  picker.value = 'albums';
  await picker.emit('change');
  assert.match(harness.$('#reviewSub').textContent, /0 треков · 2 альбомов/);
  await searchTarget(harness, 'zvuk');
  const search = calls.find((call) => call.action === 'search-albums');
  assert.equal(search.type, 'music-importer:zvuk-command');
  assert.equal(search.query, 'Discovery Daft Punk');
  assert.equal(calls.some((call) => call.action === 'search-tracks'), false);

  await harness.$('#importBtn').emit('click');
  await harness.waitFor(() => harness.$('#report').classList.contains('show'), 'report');
  const execute = calls.find((call) => call.action === 'execute-transfer');
  assert.equal(execute.plan.target.collectionType, 'albums');
  assert.deepEqual(plain(execute.plan.operations.map((operation) => operation.operation)), ['add_album']);
  assert.equal(harness.$('#reportBreakdown').textContent, 'Лайки: 0 · Альбомы: 1 · Плейлисты (треков): 0');
});

test('unconfirmed albums are left out of the all scope with a notice and block the albums-only scope', async () => {
  const calls = [];
  const harness = createAppHarness({ libraries: { 'apple-music': appleLibrary(false) }, handler: scriptedExtension(calls) });
  await harness.waitFor(() => /не подтверждены и не переносятся/.test(harness.$('#reviewSub').textContent), 'notice');
  assert.equal(harness.$('#albumSection').hidden, false);
  assert.equal(harness.$('#albumNotice').hidden, false);
  assert.deepEqual(plain(harness.$('#sourceCollectionSelect').options.map((option) => option.text)), ['Лайки и все плейлисты', 'Только лайки (1)', 'Только альбомы (не подтверждены)']);
  await searchTarget(harness, 'spotify');
  await harness.$('#importBtn').emit('click');
  await harness.waitFor(() => harness.$('#report').classList.contains('show'), 'report');
  assert.equal(calls.some((call) => call.action === 'search-albums'), false);
  assert.equal(calls.find((call) => call.action === 'execute-transfer').plan.operations.some((operation) => operation.operation === 'add_album'), false);

  const picker = harness.$('#sourceCollectionSelect');
  picker.value = 'albums';
  await picker.emit('change');
  const before = calls.length;
  harness.$('#importBtn').disabled = false;
  await harness.$('#importBtn').emit('click');
  assert.equal(calls.length, before, 'no write is sent for an unconfirmed albums collection');
  assert.match(harness.$('#toast').textContent, /полный snapshot/);
});
