const assert = require('node:assert/strict');
const test = require('node:test');
const { createAppHarness } = require('./helpers/app-fixture');

test('app offers only confirmed Yandex likes when playlist discovery failed', async () => {
  const partial = {
    service: 'yandex-music',
    partialScope: 'favorites',
    snapshotCachedAt: new Date().toISOString(),
    collection: { type: 'library', name: 'Только лайки' },
    completeness: {
      confirmed: false, favoritesConfirmed: true, favoritesCount: 2, favoritesRevision: 7,
      catalogConfirmed: false, playlistCatalogKindsConfirmed: false,
      playlistItemsConfirmed: false, playlistItemsTotal: null,
    },
    tracks: [
      { id: 'liked-1', title: 'First', artists: ['Artist'], collectionType: 'favorites', position: 0 },
      { id: 'liked-2', title: 'Second', artists: ['Artist'], collectionType: 'favorites', position: 1 },
    ],
    playlists: [],
  };
  const harness = createAppHarness({
    libraries: {},
    partialLibraries: { 'yandex-music': partial },
    statuses: { 'yandex-music': { status: 'failed', message: 'Не удалось прочитать один плейлист.' } },
  });
  await harness.waitFor(() => harness.$('#matchCount').textContent === '2 треков', 'partial Yandex likes loaded');

  const sourceCard = harness.cards.find((card) => card.dataset.provider === 'yandex-music');
  assert.match(sourceCard.querySelector('.source-status').textContent, /Подтверждены только лайки/);
  assert.equal(sourceCard.querySelector('.source-status').classList.contains('partial'), true);
  assert.equal(sourceCard.querySelector('.source-status').classList.contains('connected'), false);
  assert.match(sourceCard.querySelector('.source-collections').textContent, /Плейлисты: не подтверждены/);
  assert.equal(harness.$('#sourceCollectionSelect').value, 'favorites');
  assert.equal(harness.$('#sourceCollectionSelect').disabled, true);
  assert.deepEqual(harness.$('#sourceCollectionSelect').options.map((option) => option.value), ['favorites']);
  assert.match(harness.$('#reviewSub').textContent, /только лайки, плейлисты не подтверждены/);
});

test('each provider card exposes its own numeric scan progress when the service reports counts', async () => {
  const harness = createAppHarness({
    libraries: {},
    statuses: {
      spotify: { status: 'scanning', phase: 'favorites', message: 'Собираем Spotify Liked Songs: 1000 из 1430.' },
      'yandex-music': { status: 'scanning', phase: 'favorites', message: 'Лайки: загружено 1275 из 4979.' },
    },
    handler: async () => ({ ok: true }),
  });
  const spotify = harness.cards.find((card) => card.dataset.provider === 'spotify').progress;
  const yandex = harness.cards.find((card) => card.dataset.provider === 'yandex-music').progress;
  await harness.waitFor(() => spotify.getAttribute('value') !== null && yandex.getAttribute('value') !== null, 'numeric per-provider progress');

  assert.equal(spotify.getAttribute('max'), '1430');
  assert.equal(spotify.getAttribute('value'), '1000');
  assert.equal(spotify.getAttribute('aria-valuetext'), '1000 из 1430');
  assert.equal(yandex.getAttribute('max'), '4979');
  assert.equal(yandex.getAttribute('value'), '1275');
  assert.equal(yandex.getAttribute('aria-valuetext'), '1275 из 4979');
});
