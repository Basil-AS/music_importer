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
